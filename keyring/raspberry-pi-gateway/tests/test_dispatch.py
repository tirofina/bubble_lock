import asyncio
import json
import tempfile
import time
import unittest
from collections import Counter
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from bubble_gateway.model import iso_time, payload_hash, utc_now
from bubble_gateway.service import Gateway
from bubble_gateway.store import Store
from bubble_gateway.transport import NativeDeliveryHold
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
        self.gateway.credential_revision = "rev-1"
        self.gateway.credential_checked = time.monotonic()
        self.gateway.credential_generation = 0
        self.gateway._enqueue_health = Mock()
        self.gateway._health_payload = Mock(return_value={"bootId": "dispatch-test"})
        self.gateway.counters = Counter()
        self.gateway.stop = asyncio.Event()
        self.cmd = command()
        self.digest = payload_hash(self.cmd)
        self.store.accept(self.cmd, self.digest)
        self.authorization = {key: self.cmd[key] for key in
                              ("commandId", "deviceId", "claimId", "grantRevision", "ownershipEpoch")}
        self.authorization.update(allowed=True, payloadHash=self.digest, expiresAt=self.cmd["deadline"])
        self.gateway.transport = SimpleNamespace(authorize=AsyncMock(return_value=self.authorization),
                                                 credential_status=AsyncMock(return_value=dict(
                                                     gatewayId=self.gateway.config.gateway_id,
                                                     status="ACTIVE", credentialRevision="rev-1")),
                                                 publish=AsyncMock(), native_delivery_hold=NativeDeliveryHold)
        self.gateway.ble = SimpleNamespace(command_session=Mock(return_value=1),
                                           execute=AsyncMock(return_value=device_receipt(self.cmd, self.digest)))

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

    async def test_waits_for_command_session_before_authorizing_or_recording_intent(self):
        self.gateway.ble.command_session.return_value = None
        self.assertEqual(await self.dispatch(), ("RECEIVED", None))
        self.gateway.transport.authorize.assert_not_awaited()
        self.gateway.ble.execute.assert_not_awaited()
        self.assertEqual(self.store.interrupted(), [])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM fences").fetchone()[0], 0)
        self.gateway.ble.command_session.return_value = 2
        self.assertEqual((await self.dispatch())[0], "APPLIED")
        self.gateway.transport.authorize.assert_awaited_once_with(self.cmd, self.digest)
        self.assertEqual(self.gateway.ble.execute.await_args.kwargs["expected_generation"], 2)

    async def test_session_change_during_authorization_defers_for_fresh_decision(self):
        self.gateway.ble.command_session.side_effect = [1, 2]
        self.assertEqual(await self.dispatch(), ("RECEIVED", None))
        self.gateway.transport.authorize.assert_awaited_once()
        self.gateway.ble.execute.assert_not_awaited()
        self.assertEqual(self.store.interrupted(), [])

    async def test_credential_rotation_during_authorization_defers_for_fresh_decision(self):
        async def authorize(_command, _digest):
            status_api = self.gateway.transport.credential_status
            status_api.return_value["credentialRevision"] = "rev-2"
            await self.gateway._refresh_credentials()
            return self.authorization

        self.gateway.transport.authorize.side_effect = authorize
        self.assertEqual(await self.dispatch(), ("RECEIVED", None))
        self.gateway.ble.execute.assert_not_awaited()
        self.assertEqual(self.store.interrupted(), [])

    async def recover_after_credential_failure(self):
        status_api = self.gateway.transport.credential_status
        status_api.side_effect = ConnectionError("synthetic status outage")
        await self.gateway._refresh_credentials()
        self.assertEqual(self.gateway.credential_status, "UNKNOWN")
        status_api.side_effect = None
        await self.gateway._refresh_credentials()
        self.assertTrue(self.gateway._credentials_active())
        self.assertEqual(self.gateway.credential_revision, "rev-1")

    async def test_same_revision_recovery_during_authorize_requires_a_new_decision(self):
        async def authorize(_command, _digest):
            await self.recover_after_credential_failure()
            return self.authorization

        self.gateway.transport.authorize.side_effect = authorize
        self.assertEqual(await self.dispatch(), ("RECEIVED", None))
        self.gateway.ble.execute.assert_not_awaited()
        self.assertEqual(self.store.interrupted(), [])

        self.gateway.transport.authorize.side_effect = None
        self.assertEqual((await self.dispatch())[0], "APPLIED")
        self.assertEqual(self.gateway.transport.authorize.await_count, 2)

    async def test_ttl_gap_during_authorize_requires_a_new_decision(self):
        async def authorize(_command, _digest):
            self.gateway.credential_checked -= self.gateway.config.credential_ttl + 1
            await self.gateway._refresh_credentials()
            self.assertTrue(self.gateway._credentials_active())
            return self.authorization

        self.gateway.transport.authorize.side_effect = authorize
        self.assertEqual(await self.dispatch(), ("RECEIVED", None))
        self.gateway.ble.execute.assert_not_awaited()

    async def test_continuous_same_revision_refresh_preserves_authority(self):
        async def authorize(_command, _digest):
            await self.gateway._refresh_credentials()
            return self.authorization

        self.gateway.transport.authorize.side_effect = authorize
        self.assertEqual((await self.dispatch())[0], "APPLIED")
        self.assertEqual(self.gateway.credential_generation, 0)

    async def test_credential_ttl_is_measured_from_request_start(self):
        self.gateway.credential_status = "UNKNOWN"
        clock = SimpleNamespace(monotonic=Mock(side_effect=[100, 100 + self.gateway.config.credential_ttl + 1]))
        with patch("bubble_gateway.service.time", clock):
            await self.gateway._refresh_credentials()
            self.assertFalse(self.gateway._credentials_active())
        self.assertEqual(self.gateway.credential_checked, 100)

    async def test_unsaved_credential_transition_fences_dispatch(self):
        self.gateway.transport.credential_status.return_value["credentialRevision"] = "rev-2"
        with patch("bubble_gateway.store.MAX_PENDING_CREDENTIAL_RECEIPTS", 0):
            await self.gateway._refresh_credentials()
        self.assertEqual(self.gateway.credential_status, "UNKNOWN")
        self.assertEqual(self.gateway.counters["credential_receipt_capacity"], 1)
        self.assertEqual(await self.dispatch(), ("RECEIVED", None))
        self.gateway.transport.authorize.assert_not_awaited()
        self.gateway.ble.execute.assert_not_awaited()

    async def test_clock_jump_during_intent_recording_blocks_ble(self):
        begin_dispatch = self.store.begin_dispatch

        def record_intent(command):
            result = begin_dispatch(command)
            self.gateway.clock_anchor += 10
            return result

        self.store.begin_dispatch = record_intent
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "CLOCK_UNTRUSTED"))
        self.gateway.ble.execute.assert_not_awaited()

    async def test_credential_change_after_ble_starts_is_terminal_and_uncertain(self):
        async def execute(_command, _budget, _digest, *, before_write, **_session):
            before_write()
            self.gateway.transport.credential_status.return_value["status"] = "REVOKED"
            await self.gateway._refresh_credentials()
            before_write()

        self.gateway.ble.execute.side_effect = execute
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("INDETERMINATE", "CREDENTIAL_CHANGED"))
        self.assertEqual(self.store.pending(), [])

    async def test_same_revision_recovery_cannot_resume_partial_ble_write(self):
        async def execute(_command, _budget, _digest, *, before_write, **_session):
            before_write()
            await self.recover_after_credential_failure()
            before_write()

        self.gateway.ble.execute.side_effect = execute
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("INDETERMINATE", "CREDENTIAL_CHANGED"))
        self.assertEqual(self.store.pending(), [])

    async def test_unavailable_batch_does_not_starve_next_device(self):
        self.store.db.execute("DELETE FROM commands")
        self.store.db.commit()
        for index in range(16):
            pending = command(commandId=f"waiting-{index}", deviceId="offline")
            self.store.accept(pending, payload_hash(pending))
        self.store.accept(self.cmd, self.digest)
        self.gateway.ble.command_session.side_effect = lambda device_id: 1 if device_id == "kr-test" else None

        pauses = 0

        async def pause(_seconds):
            nonlocal pauses
            pauses += 1
            if pauses == 2:
                self.gateway.stop.set()

        self.gateway._pause = pause
        await self.gateway._dispatch_loop()
        self.gateway.transport.authorize.assert_awaited_once_with(self.cmd, self.digest)
        self.gateway.ble.execute.assert_awaited_once()
        self.assertEqual(len(self.store.pending()), 16)

    async def test_intent_is_durable_before_ble_and_repeat_does_not_replay(self):
        async def execute(*args, **kwargs):
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
