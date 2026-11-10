"""Synthetic dual-route receipts: retries must not regenerate delivered CORE ACKs."""
import asyncio
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from bubble_gateway.model import iso_time, payload_hash
from bubble_gateway.service import Gateway
from bubble_gateway.store import Store
from helpers import BINDING, command, config


class ReceiptOutboxTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "synthetic.sqlite3"
        self.store = self.open_store()
        self.addCleanup(lambda: self.store.close())
        self.cmd = command()
        self.receipt = dict(version=1, gatewayId="gw-test", deviceId="kr-test", commandId=self.cmd["commandId"],
                            payloadHash=payload_hash(self.cmd), status="APPLIED", ackCode="APPLIED",
                            readback={"state": True}, receivedAt=iso_time(), grantRevision=3, ownershipEpoch=2)
        self.store.accept(self.cmd, self.receipt["payloadHash"])
        self.store.finish(self.cmd["commandId"], self.receipt)
        self.ack_rqi = self.store.request_id("core-ack", self.cmd["commandId"])
        self.native_rqi = self.store.request_id("receipt", self.cmd["commandId"])

    def open_store(self):
        return Store(self.path, 100, 100000, 20, BINDING)

    def stage(self):
        self.store.stage_receipts(BINDING["receiptContainer"], True)

    def queued(self, route):
        return self.store.db.execute("SELECT COUNT(*) FROM outbox WHERE container=?", (route,)).fetchone()[0]

    def native_delivered(self):
        return self.store.db.execute("SELECT receipt_delivered FROM commands").fetchone()[0]

    async def test_completed_core_ack_is_not_recreated_during_native_retry(self):
        self.stage()
        self.store.delivered(self.ack_rqi)
        self.store.retry(self.native_rqi, 0)
        for _ in range(5):
            self.stage()
        self.assertEqual(self.queued("@core/ack"), 0)
        self.assertEqual(self.queued(BINDING["receiptContainer"]), 1)
        self.assertEqual(self.native_delivered(), 0)

    async def test_restart_does_not_recreate_completed_core_ack(self):
        self.stage()
        self.store.delivered(self.ack_rqi)
        self.store.close()
        self.store = self.open_store()
        self.stage()
        self.assertEqual(self.queued("@core/ack"), 0)
        self.assertEqual(self.queued(BINDING["receiptContainer"]), 1)
        self.assertEqual(self.native_delivered(), 0)

    async def test_native_confirmation_keeps_pending_core_ack_for_its_own_retry(self):
        self.stage()
        self.store.retry(self.ack_rqi, 0)
        self.store.delivered(self.native_rqi)
        self.stage()
        self.assertEqual(self.native_delivered(), 1)
        self.assertEqual(self.queued("@core/ack"), 1)
        self.assertEqual(self.queued(BINDING["receiptContainer"]), 0)
        self.store.delivered(self.ack_rqi)
        self.stage()
        self.assertEqual(self.store.counts()[0], 0)

    async def test_capacity_failure_does_not_leave_half_a_receipt_pair(self):
        self.store.max_rows = 1
        self.stage()
        self.assertEqual(self.store.counts()[0], 0)
        retained = json.loads(self.store.db.execute("SELECT receipt FROM commands").fetchone()[0])
        self.assertEqual(retained, self.receipt)
        self.assertEqual(self.native_delivered(), 0)
        self.store.max_rows = 2
        self.stage()
        self.assertEqual(self.store.counts()[0], 2)

    async def test_outbox_worker_does_not_spin_publishing_ack_while_native_is_backed_off(self):
        gateway = Gateway.__new__(Gateway)
        gateway.config, gateway.store = config(), self.store
        gateway.stop, gateway.counters = asyncio.Event(), Counter()
        published_acks = []

        async def publish(rqi, route, _payload):
            if route == "@core/ack":
                published_acks.append(rqi)
                if len(published_acks) == 4:  # Bound the broken worker; never wait for a real service.
                    gateway.stop.set()
            else:
                raise ConnectionError("synthetic native delivery outage")

        async def idle(_seconds):
            gateway.stop.set()

        gateway.transport = SimpleNamespace(publish=AsyncMock(side_effect=publish))
        gateway._pause = idle
        with patch("bubble_gateway.store.time.time", return_value=1000):
            async with asyncio.timeout(1):
                await gateway._outbox_loop()
        self.assertEqual(published_acks, [self.ack_rqi])
        self.assertEqual(self.native_delivered(), 0)
        self.assertEqual(self.queued(BINDING["receiptContainer"]), 1)
