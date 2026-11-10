import asyncio
import json
import tempfile
import time
import unittest
from collections import Counter
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from bubble_gateway.model import iso_time, payload_hash, utc_now
from bubble_gateway.service import Gateway
from bubble_gateway.store import Store
from helpers import BINDING, command, config, device_receipt


class DispatchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / "synthetic.sqlite3", 100, 100000, 20, BINDING)
        self.addCleanup(self.store.close)
        # Deliberately bypass daemon startup, certificate files, network and BLE.
        self.gateway = Gateway.__new__(Gateway)
        self.gateway.config = config()
        self.gateway.store = self.store
        self.gateway.clock_anchor = time.time() - time.monotonic()
        self.gateway.clock_trusted = True
        self.gateway.credential_status = "ACTIVE"
        self.gateway.credential_checked = time.monotonic()
        self.gateway.counters = Counter()
        self.gateway.stop = asyncio.Event()
        self.cmd = command()
        self.digest = payload_hash(self.cmd)
        self.store.accept(self.cmd, self.digest)
        self.authorization = {key: self.cmd[key] for key in
                              ("commandId", "deviceId", "claimId", "grantRevision", "ownershipEpoch")}
        self.authorization.update(allowed=True, payloadHash=self.digest, expiresAt=self.cmd["deadline"])
        self.gateway.transport = SimpleNamespace(authorize=AsyncMock(return_value=self.authorization),
                                                 publish=AsyncMock())
        self.gateway.ble = SimpleNamespace(execute=AsyncMock(return_value=device_receipt(self.cmd, self.digest)))

    async def dispatch(self):
        await self.gateway._dispatch_one(self.cmd, self.digest)
        row = self.store.db.execute("SELECT status,receipt FROM commands").fetchone()
        return row["status"], json.loads(row["receipt"]) if row["receipt"] else None

    async def test_grant_denial_or_mismatched_hash_never_sends_ble(self):
        self.authorization["payloadHash"] = "0" * 64
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "NOT_AUTHORIZED"))
        self.gateway.ble.execute.assert_not_awaited()

    async def test_unknown_credentials_defer_without_remote_calls(self):
        self.gateway.credential_status = "UNKNOWN"
        self.assertEqual(await self.dispatch(), ("RECEIVED", None))
        self.gateway.transport.authorize.assert_not_awaited()
        self.gateway.ble.execute.assert_not_awaited()

    async def test_expired_authorization_never_sends_ble(self):
        self.authorization["expiresAt"] = iso_time(utc_now() - timedelta(seconds=1))
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "EXPIRED"))
        self.gateway.ble.execute.assert_not_awaited()

    async def test_intent_is_durable_before_ble_and_repeat_does_not_replay(self):
        async def execute(*args):
            self.assertEqual(len(self.store.interrupted()), 1)
            return device_receipt(self.cmd, self.digest)
        self.gateway.ble.execute.side_effect = execute
        self.assertEqual((await self.dispatch())[0], "APPLIED")
        await self.dispatch()
        self.assertEqual(self.gateway.ble.execute.await_count, 1)

    async def test_gpio_mismatch_is_uncertain_not_success(self):
        self.gateway.ble.execute.return_value = device_receipt(self.cmd, self.digest, readback={"state": False})
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("INDETERMINATE", "READBACK_MISMATCH"))

    async def test_timeout_is_terminal_and_not_replayed(self):
        self.gateway.ble.execute.side_effect = asyncio.TimeoutError
        self.assertEqual((await self.dispatch())[0], "TIMEOUT")
        self.assertEqual(self.store.pending(), [])
        await self.dispatch()
        self.assertEqual(self.gateway.ble.execute.await_count, 1)

    async def test_publish_failure_keeps_receipt_undelivered(self):
        await self.dispatch()
        self.gateway.config.core_bridge_enabled = False
        async def fail(*args):
            self.gateway.stop.set()
            raise ConnectionError("synthetic failure")
        self.gateway.transport.publish.side_effect = fail
        await self.gateway._outbox_loop()
        row = self.store.db.execute("SELECT receipt_delivered FROM commands").fetchone()
        self.assertEqual(row[0], 0)
        self.assertEqual(self.store.counts()[0], 1)

    async def test_publish_confirmation_marks_receipt_delivered(self):
        await self.dispatch()
        self.gateway.config.core_bridge_enabled = False
        async def success(*args):
            self.gateway.stop.set()
        self.gateway.transport.publish.side_effect = success
        await self.gateway._outbox_loop()
        self.assertEqual(self.store.db.execute("SELECT receipt_delivered FROM commands").fetchone()[0], 1)
        self.assertEqual(self.store.counts()[0], 0)
