"""Synthetic dual-route receipts: retries must not regenerate delivered CORE ACKs."""
import asyncio
import json
import tempfile
import unittest
from collections import Counter
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from bubble_gateway.model import iso_time, payload_hash, utc_now
from bubble_gateway.service import Gateway
from bubble_gateway.store import Store
from bubble_gateway.transport import NativeDeliveryHold, RemoteResponseError
from helpers import BINDING, command, config, observation


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

    async def test_pinned_receipt_send_attempt_survives_restart_before_local_confirmation(self):
        gateway = Gateway.__new__(Gateway)
        gateway.config, gateway.store = config(), self.store
        gateway.config.receipt_container_ri = "cnt-test"
        gateway.config.core_bridge_enabled = False
        gateway.stop, gateway.counters = asyncio.Event(), Counter()

        async def interrupted_publish(*_args):
            self.assertEqual(self.store.due()["attempts"], 1)
            raise asyncio.CancelledError

        gateway.transport = SimpleNamespace(publish=AsyncMock(side_effect=interrupted_publish),
                                             native_delivery_hold=NativeDeliveryHold)
        with self.assertRaises(asyncio.CancelledError):
            async with asyncio.timeout(1):
                await gateway._outbox_loop()
        args = (self.native_rqi, BINDING["receiptContainer"], self.receipt)
        gateway.transport.publish.assert_awaited_once_with(*args)
        self.assertEqual(self.native_delivered(), 0)

        self.store.close()
        gateway.store = self.store = self.open_store()
        gateway.transport.publish = AsyncMock()

        async def idle(_seconds):
            gateway.stop.set()

        gateway._pause = idle
        async with asyncio.timeout(1):
            await gateway._outbox_loop()
        gateway.transport.publish.assert_awaited_once_with(*args, confirm_existing=True)
        self.assertEqual(self.native_delivered(), 1)
        self.assertEqual(self.store.counts()[0], 0)

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

    async def test_central_receipt_staging_is_atomic_and_confirmation_survives_restart(self):
        central_rqi = self.store.request_id("central-receipt", self.cmd["commandId"])
        self.store.max_rows = 2
        self.store.stage_receipts(BINDING["receiptContainer"], True, central_enabled=True)
        self.assertEqual(self.store.counts()[0], 0)
        self.assertEqual(self.store.db.execute("SELECT central_receipt_staged FROM commands").fetchone()[0], 0)

        self.store.max_rows = 3
        self.store.stage_receipts(BINDING["receiptContainer"], True, central_enabled=True)
        self.assertEqual(self.store.counts()[0], 3)
        self.store.delivered(central_rqi)
        self.store.close()
        self.store = self.open_store()
        self.store.stage_receipts(BINDING["receiptContainer"], True, central_enabled=True)
        self.assertEqual(self.native_delivered(), 0)
        self.assertEqual(self.queued("@central/receipt"), 0)
        self.assertEqual(self.queued("@core/ack"), 1)
        self.assertEqual(self.queued(BINDING["receiptContainer"]), 1)

    async def test_central_route_can_stage_receipt_already_confirmed_by_native_cse(self):
        self.stage()
        self.store.delivered(self.native_rqi)
        self.store.delivered(self.ack_rqi)
        with self.store.db:
            self.store.db.execute("DROP INDEX commands_pending_central_receipt")
            self.store.db.execute("ALTER TABLE commands DROP COLUMN central_receipt_staged")
        self.store.close()
        self.store = self.open_store()
        self.store.stage_receipts(BINDING["receiptContainer"], True, central_enabled=True)
        self.assertEqual(self.native_delivered(), 1)
        self.assertEqual(self.queued("@central/receipt"), 1)
        self.assertIsNone(self.store.due())
        item = self.store.due(central_receipts_enabled=True)
        self.assertEqual(item["payload"], self.receipt)
        self.assertEqual(self.store.central_receipt_claim(item["payload"]), self.cmd["claimId"])

    async def test_central_worker_retries_same_receipt_while_native_cse_is_held(self):
        gateway = Gateway.__new__(Gateway)
        gateway.config, gateway.store = config(), self.store
        gateway.config.central_receipts_enabled = True
        gateway.config.core_bridge_enabled = False
        gateway.stop, gateway.counters = asyncio.Event(), Counter()
        gateway.transport = SimpleNamespace(publish=AsyncMock(side_effect=RemoteResponseError("unmatched")),
                                             native_delivery_hold=Mock(return_value=NativeDeliveryHold(all_native=True)))

        async def idle(_seconds):
            gateway.stop.set()

        gateway._pause = idle
        with patch("bubble_gateway.store.time.time", return_value=1000):
            async with asyncio.timeout(1):
                await gateway._outbox_loop()
        rqi = self.store.request_id("central-receipt", self.cmd["commandId"])
        args = (rqi, "@central/receipt", self.receipt)
        gateway.transport.publish.assert_awaited_once_with(*args, expected_claim_id=self.cmd["claimId"])
        self.assertEqual(self.queued("@central/receipt"), 1)

        self.store.close()
        gateway.store = self.store = self.open_store()
        gateway.stop.clear()
        gateway.transport.publish = AsyncMock()
        with patch("bubble_gateway.store.time.time", return_value=2000):
            async with asyncio.timeout(1):
                await gateway._outbox_loop()
        gateway.transport.publish.assert_awaited_once_with(*args, expected_claim_id=self.cmd["claimId"])
        self.assertEqual(self.queued("@central/receipt"), 0)
        self.assertEqual(self.queued(BINDING["receiptContainer"]), 1)
        self.assertEqual(self.native_delivered(), 0)

    async def test_central_worker_expires_old_projection_and_finishes_bound_stale_observation(self):
        gateway = Gateway.__new__(Gateway)
        gateway.config, gateway.store = config(), self.store
        gateway.config.central_telemetry_enabled = True
        gateway.config.core_bridge_enabled = False
        gateway.stop, gateway.counters = asyncio.Event(), Counter()
        gateway._clock_ok = Mock(return_value=True)
        gateway.transport = SimpleNamespace(publish=AsyncMock(return_value={"status": "STALE"}),
                                             native_delivery_hold=Mock(return_value=NativeDeliveryHold(all_native=True)))
        expired_at = iso_time(utc_now() - timedelta(hours=25))
        old = observation(observedAt=expired_at, receivedAt=expired_at)
        fresh = observation(sequence=2)
        await gateway.observation(old)
        await gateway.observation(fresh)

        async def idle(_seconds):
            gateway.stop.set()

        gateway._pause = idle
        async with asyncio.timeout(1):
            await gateway._outbox_loop(central_telemetry=True)
        gateway.transport.publish.assert_awaited_once()
        self.assertEqual(gateway.transport.publish.await_args.args[1:], ("@central/telemetry", fresh))
        self.assertEqual(gateway.counters["central_telemetry_expired"], 1)
        self.assertEqual(gateway.counters["central_telemetry_stale"], 1)
        self.assertEqual(self.queued("@central/telemetry"), 0)
        self.assertEqual(self.queued(BINDING["observationContainer"]), 2)

    async def test_native_delivery_continues_while_central_observation_awaits_confirmation(self):
        gateway = Gateway.__new__(Gateway)
        gateway.config, gateway.store = config(), self.store
        gateway.config.central_telemetry_enabled = True
        gateway.config.core_bridge_enabled = False
        gateway.stop, gateway.counters = asyncio.Event(), Counter()
        gateway._clock_ok = Mock(return_value=True)
        awaiting_central, release_central = asyncio.Event(), asyncio.Event()
        native_observation_sent = asyncio.Event()

        async def publish(_rqi, container, _payload, **_options):
            if container == "@central/telemetry":
                awaiting_central.set()
                await release_central.wait()
                return {"status": "ACCEPTED"}
            if container == gateway.config.observation_container:
                native_observation_sent.set()

        gateway.transport = SimpleNamespace(publish=AsyncMock(side_effect=publish),
                                             native_delivery_hold=Mock(return_value=NativeDeliveryHold()))
        await gateway.observation(observation())
        async with asyncio.timeout(1), asyncio.TaskGroup() as workers:
            workers.create_task(gateway._outbox_loop(central_telemetry=True))
            await awaiting_central.wait()
            workers.create_task(gateway._outbox_loop())
            await native_observation_sent.wait()
            self.assertEqual(self.native_delivered(), 1)
            self.assertEqual(self.queued(gateway.config.observation_container), 0)
            self.assertEqual(self.queued("@central/telemetry"), 1)
            gateway.stop.set()
            release_central.set()

        self.assertEqual(self.queued("@central/telemetry"), 0)
        self.assertEqual(gateway.counters["central_telemetry_confirmed"], 1)
        self.assertEqual(gateway.transport.publish.await_count, 3)

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
