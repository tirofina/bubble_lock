import asyncio
import json
import sqlite3
import tempfile
import time
import unittest
from collections import Counter
from contextlib import closing
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from bubble_gateway.ble import BleFleet
from bubble_gateway.model import iso_time, parse_time, payload_hash, utc_now
from bubble_gateway.service import Gateway
from bubble_gateway.store import Store
from bubble_gateway.transport import NativeDeliveryHold, RemoteResponseError
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

    async def test_authorization_wait_is_cancelled_at_command_deadline(self):
        request = asyncio.get_running_loop().create_future()

        async def authorize(_command, _digest):
            return await request

        self.gateway.transport.authorize.side_effect = authorize
        near_deadline = parse_time(self.cmd["deadline"]) - timedelta(milliseconds=20)
        with patch("bubble_gateway.service.utc_now", return_value=near_deadline):
            async with asyncio.timeout(1):
                status, receipt = await self.dispatch()
        self.assertTrue(request.cancelled())
        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "EXPIRED"))
        self.assertEqual(self.store.interrupted(), [])
        self.gateway.ble.execute.assert_not_awaited()

    async def test_short_authorization_request_timeout_leaves_command_pending(self):
        request = asyncio.get_running_loop().create_future()

        async def authorize(_command, _digest):
            return await request

        self.gateway.config.request_timeout = 0.02
        self.gateway.transport.authorize.side_effect = authorize
        async with asyncio.timeout(1):
            self.assertEqual(await self.dispatch(), ("RECEIVED", None))
        self.assertTrue(request.cancelled())
        self.assertEqual(self.gateway.counters["authorization_unavailable"], 1)
        self.gateway.ble.execute.assert_not_awaited()

    async def test_late_authorization_response_does_not_record_dispatch_intent(self):
        deadline = parse_time(self.cmd["deadline"])
        current = deadline - timedelta(seconds=1)

        async def authorize(_command, _digest):
            nonlocal current
            current = deadline + timedelta(milliseconds=1)
            return self.authorization

        self.gateway.transport.authorize.side_effect = authorize
        with patch("bubble_gateway.service.utc_now", side_effect=lambda: current):
            status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "EXPIRED"))
        self.assertEqual(self.store.interrupted(), [])
        self.gateway.ble.execute.assert_not_awaited()

    async def test_dispatch_start_requires_durable_intent_and_shortens_ble_budget(self):
        self.gateway.config.pc_dispatch_start_required = True

        async def start(_command, _digest):
            self.gateway.transport.authorize.assert_awaited_once_with(self.cmd, self.digest)
            self.gateway.ble.execute.assert_not_awaited()
            self.assertEqual(len(self.store.interrupted()), 1)
            return dict(self.authorization, expiresAt=iso_time(utc_now() + timedelta(seconds=3)))

        self.gateway.transport.dispatch_start = AsyncMock(side_effect=start)
        status, _ = await self.dispatch()
        self.assertEqual(status, "APPLIED")
        self.gateway.transport.dispatch_start.assert_awaited_once_with(self.cmd, self.digest)
        self.assertLessEqual(self.gateway.ble.execute.await_args.args[1], 2750)

    async def test_dispatch_start_with_wrong_claim_blocks_ble(self):
        self.gateway.config.pc_dispatch_start_required = True
        self.gateway.transport.dispatch_start = AsyncMock(return_value=dict(self.authorization, claimId="wrong"))
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "NOT_AUTHORIZED"))
        self.gateway.ble.execute.assert_not_awaited()

    async def test_dispatch_start_with_expired_deadline_blocks_ble(self):
        self.gateway.config.pc_dispatch_start_required = True
        expired = iso_time(utc_now() - timedelta(seconds=1))
        self.gateway.transport.dispatch_start = AsyncMock(return_value=dict(self.authorization, expiresAt=expired))
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "EXPIRED"))
        self.gateway.ble.execute.assert_not_awaited()

    async def test_missing_dispatch_start_route_has_no_legacy_fallback(self):
        self.gateway.config.pc_dispatch_start_required = True
        self.gateway.transport.dispatch_start = AsyncMock(side_effect=RemoteResponseError("missing", status_code=404))
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "DISPATCH_NOT_SENT"))
        self.gateway.ble.execute.assert_not_awaited()
        self.assertEqual(self.store.pending(), [])

    async def test_session_change_during_dispatch_start_blocks_ble(self):
        self.gateway.config.pc_dispatch_start_required = True

        async def start(_command, _digest):
            self.gateway.ble.command_session.return_value = 2
            return self.authorization

        self.gateway.transport.dispatch_start = AsyncMock(side_effect=start)
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "DISPATCH_NOT_SENT"))
        self.gateway.ble.execute.assert_not_awaited()

    async def test_cancellation_during_dispatch_start_records_unsent_command(self):
        self.gateway.config.pc_dispatch_start_required = True
        self.gateway.transport.dispatch_start = AsyncMock(side_effect=asyncio.CancelledError)
        with self.assertRaises(asyncio.CancelledError):
            await self.dispatch()
        self.gateway.ble.execute.assert_not_awaited()
        status, encoded = self.store.db.execute("SELECT status,receipt FROM commands").fetchone()
        self.assertEqual((status, json.loads(encoded)["ackCode"]), ("REJECTED", "DISPATCH_NOT_SENT"))

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

    async def test_slow_authorization_does_not_block_another_device_or_reorder_its_own_commands(self):
        self.gateway.config.ble_devices = {**self.gateway.config.ble_devices, "kr-other": "00:00:00:00:00:02"}
        next_cmd = command(commandId="next-on-first-device")
        other = command(commandId="other-device", deviceId="kr-other")
        self.store.accept(next_cmd, payload_hash(next_cmd))
        self.store.accept(other, payload_hash(other))
        first_waiting, release_first = asyncio.Event(), asyncio.Event()
        other_executed, second_executed = asyncio.Event(), asyncio.Event()
        started = []

        async def authorize(cmd, digest):
            started.append(cmd["commandId"])
            if cmd["commandId"] == self.cmd["commandId"]:
                first_waiting.set()
                await release_first.wait()
            return {**{key: cmd[key] for key in ("commandId", "deviceId", "claimId", "grantRevision", "ownershipEpoch")},
                    "allowed": True, "payloadHash": digest, "expiresAt": cmd["deadline"]}

        async def execute(cmd, _budget, digest, **_options):
            if cmd["commandId"] == other["commandId"]:
                other_executed.set()
            if cmd["commandId"] == next_cmd["commandId"]:
                second_executed.set()
            return device_receipt(cmd, digest)

        self.gateway.transport.authorize.side_effect = authorize
        self.gateway.ble.execute.side_effect = execute
        task = asyncio.create_task(self.gateway._dispatch_loop())
        try:
            async with asyncio.timeout(1):
                await first_waiting.wait()
                await other_executed.wait()
                self.assertEqual(started, [self.cmd["commandId"], other["commandId"]])
                self.assertEqual(self.store.interrupted(), [])
                release_first.set()
                await second_executed.wait()
                self.gateway.stop.set()
                await task
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(started, [self.cmd["commandId"], other["commandId"], next_cmd["commandId"]])
        self.assertEqual(self.store.pending(), [])

    async def test_intent_is_durable_before_ble_and_repeat_does_not_replay(self):
        async def execute(*args, **kwargs):
            self.assertEqual(len(self.store.interrupted()), 1)
            return device_receipt(self.cmd, self.digest)
        self.gateway.ble.execute.side_effect = execute
        self.assertEqual((await self.dispatch())[0], "APPLIED")
        await self.dispatch()
        self.assertEqual(self.gateway.ble.execute.await_count, 1)

    async def test_dispatch_preserves_ble_receipt_arrival_time(self):
        received = utc_now() - timedelta(milliseconds=30)
        arrived = iso_time(received)
        applied = iso_time(received - timedelta(milliseconds=10))
        accepted = iso_time(received - timedelta(milliseconds=20))
        self.gateway.ble.execute.return_value = device_receipt(
            self.cmd, self.digest, receivedAt=arrived, acceptedAt=accepted, appliedAt=applied,
            timestampSource="gateway-estimated")
        status, receipt = await self.dispatch()
        self.assertEqual(status, "APPLIED")
        self.assertEqual((receipt["receivedAt"], receipt["acceptedAt"], receipt["appliedAt"]),
                         (arrived, accepted, applied))

    def use_ble_notification(self, after_notification):
        fleet = self.gateway.ble = BleFleet(self.gateway.config)
        peer = fleet._peers[self.cmd["deviceId"]]
        result = device_receipt(self.cmd, self.digest)
        peer.identity = {"bootId": result["bootId"], "firmwareRevision": result["firmwareRevision"]}
        peer.ready.set()
        peer.command_writable = True

        async def write(_uuid, data, *, response):
            if data.endswith(b"\n"):
                self.assertEqual(self.store.interrupted()[0]["ble_final_write_started"], 1)
                fleet._receipt_fragment(peer, bytearray((json.dumps(result) + "\n").encode()), peer.generation)
                await after_notification()

        peer.client = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock(side_effect=write))

    async def test_interrupted_ble_before_terminator_settles_dispatch_not_sent(self):
        self.use_ble_notification(AsyncMock())
        peer = self.gateway.ble._peers[self.cmd["deviceId"]]
        write = peer.client.write_gatt_char
        write.side_effect = [None, TimeoutError("synthetic partial write timeout")]

        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "DISPATCH_NOT_SENT"))
        self.assertIsNone(receipt["readback"])
        self.assertEqual(write.await_count, 2)
        self.assertTrue(all(not call.args[1].endswith(b"\n") for call in write.await_args_list))
        self.assertFalse(peer.ready.is_set())
        self.assertEqual(self.store.pending(), [])

    async def test_failed_final_write_marker_prevents_the_terminating_fragment(self):
        self.use_ble_notification(AsyncMock())
        peer = self.gateway.ble._peers[self.cmd["deviceId"]]
        with patch.object(self.store, "mark_ble_final_write", side_effect=sqlite3.OperationalError("synthetic WAL failure")):
            status, receipt = await self.dispatch()

        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "DISPATCH_NOT_SENT"))
        self.assertGreater(peer.client.write_gatt_char.await_count, 0)
        self.assertTrue(all(not call.args[1].endswith(b"\n") for call in peer.client.write_gatt_char.await_args_list))

    async def test_clock_jump_during_final_write_marker_prevents_the_terminating_fragment(self):
        self.use_ble_notification(AsyncMock())
        peer = self.gateway.ble._peers[self.cmd["deviceId"]]
        mark = self.store.mark_ble_final_write

        def write_marker(command_id, digest):
            result = mark(command_id, digest)
            self.gateway.clock_anchor += 10
            return result

        with patch.object(self.store, "mark_ble_final_write", side_effect=write_marker):
            status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("REJECTED", "DISPATCH_NOT_SENT"))
        self.assertTrue(all(not call.args[1].endswith(b"\n") for call in peer.client.write_gatt_char.await_args_list))

    async def test_terminator_write_timeout_remains_uncertain_without_device_receipt(self):
        self.use_ble_notification(AsyncMock())
        peer = self.gateway.ble._peers[self.cmd["deviceId"]]

        async def write(_uuid, data, *, response):
            if data.endswith(b"\n"):
                raise TimeoutError("synthetic lost final write response")

        peer.client.write_gatt_char.side_effect = write
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"]), ("TIMEOUT", "TIMEOUT"))
        self.assertTrue(peer.client.write_gatt_char.await_args.args[1].endswith(b"\n"))
        self.assertEqual(self.store.pending(), [])

    async def test_dispatch_keeps_confirmed_receipt_when_final_gatt_response_is_lost(self):
        async def lose_response():
            fleet = self.gateway.ble
            fleet._lost(fleet._peers[self.cmd["deviceId"]])
            raise OSError("synthetic lost GATT response")

        self.use_ble_notification(lose_response)
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"], receipt["readback"]), ("APPLIED", "APPLIED", {"state": True}))
        self.assertEqual(self.store.pending(), [])

    async def test_notification_commits_receipt_before_gatt_response_and_survives_shutdown(self):
        received = asyncio.Event()

        async def hold_response():
            received.set()
            await asyncio.Future()

        self.use_ble_notification(hold_response)
        task = asyncio.create_task(self.dispatch())
        try:
            await asyncio.wait_for(received.wait(), timeout=1)
            self.assertFalse(task.done())
            with closing(sqlite3.connect(Path(self.temp.name) / "synthetic.sqlite3")) as reader:
                status, encoded = reader.execute("SELECT status,receipt FROM commands").fetchone()
            self.assertEqual((status, json.loads(encoded)["readback"]), ("APPLIED", {"state": True}))
            self.assertEqual(self.store.interrupted(), [])
        finally:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        status, final_receipt = self.store.db.execute("SELECT status,receipt FROM commands").fetchone()
        self.assertEqual((status, final_receipt), ("APPLIED", encoded))
        self.assertEqual(self.gateway.counters, {"command_applied": 1})

    async def test_dispatch_retries_receipt_after_transient_sqlite_failure(self):
        async def complete_response():
            self.assertEqual(len(self.store.interrupted()), 1)

        self.use_ble_notification(complete_response)
        finish = self.store.finish
        fail_once = Mock(side_effect=sqlite3.OperationalError("synthetic storage error"))

        def finish_after_error(command_id, receipt):
            if not fail_once.called:
                fail_once()
            return finish(command_id, receipt)

        with patch.object(self.store, "finish", side_effect=finish_after_error) as finish_calls:
            with self.assertLogs("bubble_gateway.service", level="WARNING"):
                status, receipt = await self.dispatch()
        self.assertEqual(finish_calls.call_count, 2)
        self.assertEqual((status, receipt["ackCode"]), ("APPLIED", "APPLIED"))
        self.assertEqual(self.store.interrupted(), [])

    async def test_repeated_receipt_write_errors_keep_first_result_after_ble_timeout(self):
        arrived = iso_time()
        raw = device_receipt(self.cmd, self.digest, receivedAt=arrived, acceptedAt=arrived, appliedAt=arrived,
                             timestampSource="gateway-estimated")

        async def execute(*args, on_receipt, **kwargs):
            on_receipt(raw)
            self.gateway.clock_anchor += 10
            raise asyncio.TimeoutError

        self.gateway.ble.execute.side_effect = execute
        finish = self.store.finish
        storage_error = sqlite3.OperationalError("synthetic storage error")
        storage_check = Mock(side_effect=[storage_error, storage_error, None])

        def save_when_ready(command_id, receipt):
            storage_check()
            return finish(command_id, receipt)

        with patch.object(self.store, "finish", side_effect=save_when_ready) as writes, \
                patch("bubble_gateway.service.DEVICE_RECEIPT_RETRY_INTERVAL", 0), \
                self.assertLogs("bubble_gateway.service", level="WARNING"):
            status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["ackCode"], receipt["receivedAt"]), ("APPLIED", "APPLIED", arrived))
        self.assertEqual((receipt["acceptedAt"], receipt["appliedAt"], receipt["timestampSource"]),
                         (arrived, arrived, "gateway-estimated"))
        self.assertEqual([call.args for call in writes.call_args_list], [(self.cmd["commandId"], receipt)] * 3)
        self.gateway.ble.execute.assert_awaited_once()
        self.assertEqual(self.gateway.counters, {"command_applied": 1})

    async def test_shutdown_retries_observed_receipt_before_cancelling_worker(self):
        waiting = asyncio.Event()
        finish = self.store.finish
        attempts = 0

        def finish_after_cancel(command_id, receipt):
            nonlocal attempts
            attempts += 1
            if attempts == 2:
                waiting.set()
            if attempts <= 2:
                raise sqlite3.OperationalError("synthetic storage error")
            return finish(command_id, receipt)

        with patch.object(self.store, "finish", side_effect=finish_after_cancel), \
                self.assertLogs("bubble_gateway.service", level="WARNING"):
            task = asyncio.create_task(self.dispatch())
            try:
                await asyncio.wait_for(waiting.wait(), timeout=1)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
        status, encoded = self.store.db.execute("SELECT status,receipt FROM commands").fetchone()
        self.assertEqual((status, json.loads(encoded)["ackCode"]), ("APPLIED", "APPLIED"))
        self.assertEqual(attempts, 3)
        self.gateway.ble.execute.assert_awaited_once()

    async def test_clock_step_after_write_keeps_device_result_without_estimates(self):
        arrived = iso_time()

        async def execute(*args, **kwargs):
            self.gateway.clock_anchor += 10
            return device_receipt(self.cmd, self.digest, receivedAt=arrived, acceptedAt=arrived, appliedAt=arrived,
                                  timestampSource="gateway-estimated")

        self.gateway.ble.execute.side_effect = execute
        status, receipt = await self.dispatch()
        self.assertEqual((status, receipt["readback"], receipt["receivedAt"]), ("APPLIED", {"state": True}, arrived))
        self.assertEqual((receipt["acceptedAt"], receipt["appliedAt"], receipt["timestampSource"]),
                         (None, None, "unavailable"))

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

    async def test_restart_distinguishes_unsent_possible_and_legacy_dispatches(self):
        self.assertIsNone(self.store.begin_dispatch(self.cmd))
        marked = command(commandId="marked")
        legacy = command(commandId="legacy")
        for item in (marked, legacy):
            self.store.accept(item, payload_hash(item))
            self.assertIsNone(self.store.begin_dispatch(item))
        self.assertTrue(self.store.mark_ble_final_write(marked["commandId"], payload_hash(marked)))
        with self.store.db:
            self.store.db.execute("UPDATE commands SET ble_final_write_started=NULL WHERE command_id=?", (legacy["commandId"],))
        self.store.close()

        with closing(Store(Path(self.temp.name) / "synthetic.sqlite3", 100, 100000, 20, BINDING)) as restarted:
            self.gateway.store = restarted
            self.gateway._recover_interrupted_commands()
            results = {row["command_id"]: (row["status"], json.loads(row["receipt"])["ackCode"])
                       for row in restarted.db.execute("SELECT command_id,status,receipt FROM commands")}
            self.assertEqual(results, {
                self.cmd["commandId"]: ("REJECTED", "DISPATCH_NOT_SENT"),
                marked["commandId"]: ("INDETERMINATE", "RESTART_INTERRUPTED"),
                legacy["commandId"]: ("INDETERMINATE", "RESTART_INTERRUPTED"),
            })
            self.assertEqual(restarted.pending(), [])
            self.assertEqual(restarted.interrupted(), [])
        self.gateway.ble.execute.assert_not_awaited()

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
