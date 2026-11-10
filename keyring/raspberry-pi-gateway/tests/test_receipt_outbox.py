"""Synthetic dual-route receipts: retries must not regenerate delivered CORE ACKs."""
import asyncio
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from bubble_gateway.model import iso_time, payload_hash
from bubble_gateway.service import Gateway
from bubble_gateway.store import Store
from bubble_gateway.transport import NativeDeliveryHold
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

    async def test_backed_off_receipts_do_not_hide_later_unstaged_receipts_after_restart(self):
        self.store.max_rows = 300
        self.store.max_commands = 140
        for index in range(127):
            cmd = command(commandId=f"backlog-{index}")
            digest = payload_hash(cmd)
            self.store.accept(cmd, digest)
            self.store.finish(cmd["commandId"], dict(self.receipt, commandId=cmd["commandId"],
                                                      payloadHash=digest, status="TIMEOUT", ackCode="TIMEOUT",
                                                      readback=None))
        self.stage()
        self.assertEqual(self.queued(BINDING["receiptContainer"]), 128)
        self.store.delivered(self.ack_rqi)
        with self.store.db:
            self.store.db.execute("UPDATE outbox SET next_attempt=2000 WHERE command_id IS NOT NULL")

        newer = command(commandId="later")
        digest = payload_hash(newer)
        self.store.accept(newer, digest)
        self.store.finish(newer["commandId"], dict(self.receipt, commandId=newer["commandId"], payloadHash=digest))
        self.store.close()
        self.store = Store(self.path, 300, 100000, 140, BINDING)

        self.stage()
        self.assertEqual(self.queued(BINDING["receiptContainer"]), 129)
        self.assertEqual(self.queued("@core/ack"), 1)
        with patch("bubble_gateway.store.time.time", return_value=1000):
            for _ in range(2):
                item = self.store.due()
                self.assertEqual(item["payload"]["commandId"], newer["commandId"])
                self.store.delivered(item["rqi"])
            self.assertIsNone(self.store.due())
        self.assertEqual(self.queued(BINDING["receiptContainer"]), 128)

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

        gateway.transport = SimpleNamespace(publish=AsyncMock(side_effect=publish), native_delivery_hold=NativeDeliveryHold)
        gateway._pause = idle
        with patch("bubble_gateway.store.time.time", return_value=1000):
            async with asyncio.timeout(1):
                await gateway._outbox_loop()
        self.assertEqual(published_acks, [self.ack_rqi])
        self.assertEqual(self.native_delivered(), 0)
        self.assertEqual(self.queued(BINDING["receiptContainer"]), 1)

    async def test_due_receipts_jump_older_observations_without_starving_them(self):
        with patch("bubble_gateway.store.iso_time", return_value="2020-01-01T00:00:00Z"):
            self.store.enqueue("observation", "older", BINDING["observationContainer"], {"sequence": 1})
        observation_rqi = self.store.request_id("observation", "older")
        for index in range(3):
            cmd = command(commandId=f"queued-{index}")
            digest = payload_hash(cmd)
            self.store.accept(cmd, digest)
            self.store.finish(cmd["commandId"], dict(self.receipt, commandId=cmd["commandId"], payloadHash=digest))
        self.stage()
        gateway = Gateway.__new__(Gateway)
        gateway.config, gateway.store = config(), self.store
        gateway.stop, gateway.counters = asyncio.Event(), Counter()

        async def idle(_seconds):
            gateway.stop.set()

        gateway._pause = idle
        gateway.transport = SimpleNamespace(publish=AsyncMock(), native_delivery_hold=NativeDeliveryHold)
        with patch("bubble_gateway.store.time.time", return_value=1000):
            self.store.retry(self.native_rqi, 0, minimum_delay=60)
            self.assertEqual(self.store.due()["rqi"], observation_rqi)
            async with asyncio.timeout(1):
                await gateway._outbox_loop()

        attempts = [call.args[0] for call in gateway.transport.publish.await_args_list]
        self.assertEqual(len(attempts), 8)  # Seven due receipts and one observation.
        self.assertEqual(attempts[4], observation_rqi)
        self.assertIn(self.ack_rqi, attempts)
        self.assertNotIn(self.native_rqi, attempts)
        self.assertEqual(self.queued(BINDING["receiptContainer"]), 1)

    async def test_cse_hold_skips_unsent_rows_and_keeps_core_ack_independent(self):
        self.store.enqueue("observation", "queued", BINDING["observationContainer"], {"sequence": 1})
        observation_rqi = self.store.request_id("observation", "queued")
        self.stage()
        gateway = Gateway.__new__(Gateway)
        gateway.config, gateway.store = config(), self.store
        gateway.stop, gateway.counters = asyncio.Event(), Counter()
        gateway.transport = SimpleNamespace(publish=AsyncMock(), native_delivery_hold=Mock(
            return_value=NativeDeliveryHold(all_native=True)))

        async def idle(_seconds):
            gateway.stop.set()

        gateway._pause = idle
        async with asyncio.timeout(1):
            await gateway._outbox_loop()
            self.assertEqual([call.args[0] for call in gateway.transport.publish.await_args_list], [self.ack_rqi])
            queued = self.store.db.execute("SELECT rqi,attempts,next_attempt FROM outbox").fetchall()
            self.assertEqual({tuple(row) for row in queued}, {(self.native_rqi, 0, 0), (observation_rqi, 0, 0)})

            gateway.stop.clear()
            gateway.transport.native_delivery_hold.return_value = NativeDeliveryHold(
                receipt_container=BINDING["receiptContainer"])
            await gateway._outbox_loop()
            self.assertEqual(self.store.counts()[0], 1)

            gateway.stop.clear()
            gateway.transport.native_delivery_hold.return_value = NativeDeliveryHold()
            await gateway._outbox_loop()

        self.assertEqual([call.args[0] for call in gateway.transport.publish.await_args_list],
                         [self.ack_rqi, observation_rqi, self.native_rqi])
        self.assertEqual(self.native_delivered(), 1)

    async def test_http_hold_defers_credential_receipts_but_allows_plain_health(self):
        health = BINDING["healthContainer"]
        self.store.enqueue("health", "ordinary", health, {"bootId": "first-boot"})
        self.store.record_credential_status({"status": "LOST", "credentialRevision": "rev-2"},
                                            lambda: {"bootId": "first-boot"})
        credential_rqi = self.store.request_id("credential-transition", "first-boot:1")
        gateway = Gateway.__new__(Gateway)
        gateway.config, gateway.store = config(), self.store
        gateway.stop, gateway.counters = asyncio.Event(), Counter()
        gateway.transport = SimpleNamespace(publish=AsyncMock(), native_delivery_hold=Mock(
            return_value=NativeDeliveryHold(receipt_container=BINDING["receiptContainer"], credential_receipts=True)))

        async def idle(_seconds):
            gateway.stop.set()

        gateway._pause = idle
        async with asyncio.timeout(1):
            await gateway._outbox_loop()
            attempted = [entry.args[0] for entry in gateway.transport.publish.await_args_list]
            self.assertEqual(attempted, [self.ack_rqi, self.store.request_id("health", "ordinary")])
            credential = self.store.db.execute("SELECT attempts,next_attempt FROM outbox WHERE rqi=?",
                                               (credential_rqi,)).fetchone()
            self.assertEqual(tuple(credential), (0, 0))
            self.assertIsNone(self.store.db.execute("SELECT delivered_at FROM credential_receipts").fetchone()[0])

            gateway.stop.clear()
            gateway.transport.native_delivery_hold.return_value = NativeDeliveryHold()
            await gateway._outbox_loop()

        self.assertEqual(gateway.transport.publish.await_args.args[0], credential_rqi)
        self.assertIsNotNone(self.store.db.execute("SELECT delivered_at FROM credential_receipts").fetchone()[0])
