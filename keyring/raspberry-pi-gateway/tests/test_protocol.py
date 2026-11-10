import asyncio
import json
import time
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from bubble_gateway.ble import BleFleet, BleProtocolError, BleUnavailable, _Frames, _object, _power_reading
from bubble_gateway.core_bridge import command as core_command
from bubble_gateway.model import authorization_deadline, parse_time, payload_hash, validate_command, validate_observation
from helpers import DEVICES, command, config, device_receipt, observation


class ContractTests(unittest.TestCase):
    def test_optional_battery_alert_requires_known_charge_for_a_boolean(self):
        for battery, alert in ((None, None), (20, True), (80, False)):
            frame = observation(battery=battery, sensorValues={"batteryAlert": alert})
            self.assertEqual(validate_observation(frame, "gw-test", DEVICES), frame)
        for battery, alert in ((None, True), (None, False), (20, None), (20, 1), (20, "low")):
            with self.subTest(battery=battery, alert=alert), self.assertRaises(ValueError):
                validate_observation(observation(battery=battery, sensorValues={"batteryAlert": alert}),
                                     "gw-test", DEVICES)

    def test_optional_button_counts_require_two_uint32_values(self):
        legacy = observation()
        self.assertEqual(validate_observation(legacy, "gw-test", DEVICES), legacy)
        valid = observation(sensorValues={"buttonPresses": [1, 4294967295]})
        self.assertEqual(validate_observation(valid, "gw-test", DEVICES), valid)
        for value in (None, [1], [1, 2, 3], [True, 0], [0, 1.0], [-1, 0], [0, 4294967296]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_observation(observation(sensorValues={"buttonPresses": value}), "gw-test", DEVICES)

    def test_closed_command_requires_claim_and_real_boolean(self):
        original = command()
        self.assertEqual(validate_command(original, "gw-test", DEVICES), original)
        for invalid in ({k: v for k, v in original.items() if k != "claimId"},
                        dict(original, desiredState={"state": 1}), dict(original, grantRevision=True),
                        dict(original, gatewayId="another-gateway"), dict(original, extra="ignored")):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_command(invalid, "gw-test", DEVICES)

    def test_core_missing_grant_is_not_fabricated(self):
        with self.assertRaises(ValueError):
            core_command(dict(deviceId="kr-test", commandId="cmd-test", desiredState=True,
                              deadline=command()["deadline"], epoch=2, issuedAt=command()["issuedAt"]),
                         "gw-test", DEVICES)

    def test_authorization_cannot_extend_deadline_or_change_binding(self):
        cmd = command()
        digest = payload_hash(cmd)
        response = {k: cmd[k] for k in ("commandId", "deviceId", "claimId", "grantRevision", "ownershipEpoch")}
        response.update(allowed=True, payloadHash=digest,
                        expiresAt=(parse_time(cmd["deadline"]) + timedelta(hours=1)).isoformat())
        self.assertEqual(authorization_deadline(cmd, digest, response), parse_time(cmd["deadline"]))
        for key, value in (("allowed", False), ("claimId", "another-claim"),
                           ("payloadHash", "0" * 64), ("grantRevision", True)):
            with self.subTest(key=key), self.assertRaises(PermissionError):
                authorization_deadline(cmd, digest, dict(response, **{key: value}))


class FrameTests(unittest.TestCase):
    def test_fragmented_multibyte_and_multiple_frames(self):
        raw = '{"label":"키링"}\n{"sequence":2}\n'.encode()
        parser = _Frames()
        frames = []
        for byte in raw:
            frames.extend(parser.feed(bytearray([byte])))
        self.assertEqual(frames, [{"label": "키링"}, {"sequence": 2}])

    def test_duplicate_keys_nonfinite_and_excessive_size_rejected(self):
        for raw in (b'{"state":true,"state":false}', b'{"x":NaN}', b'{"x":1e999}', b'[]', b'x' * 4097):
            with self.subTest(raw=raw[:40]), self.assertRaises(BleProtocolError):
                _object(raw)

    def test_expired_fragment_is_not_joined_to_later_command(self):
        parser = _Frames()
        with patch("bubble_gateway.ble.time.monotonic", side_effect=[0, 6]):
            parser.feed(bytearray(b'{"a":'))
            with self.assertRaises(BleProtocolError):
                parser.feed(bytearray(b'1}\n'))
        self.assertEqual(parser.data, bytearray())

    def test_power_units_negative_rounding_and_invalid_state_nulls(self):
        value = dict(status="ok", busVoltageMv=3300, currentUa=-5, loadPowerUw=-17,
                     shuntVoltageUv=-10, readUptimeMs=100)
        _power_reading(value, 100)
        for key, invalid in (("loadPowerUw", -16), ("busVoltageMv", 3301),
                             ("readUptimeMs", 101), ("currentUa", True), ("shuntVoltageUv", 80000)):
            with self.subTest(key=key), self.assertRaises(BleProtocolError):
                _power_reading(dict(value, **{key: invalid}), 100)
        stale = {key: None for key in value}
        stale["status"] = "stale"
        _power_reading(stale, 100)
        with self.assertRaises(BleProtocolError):
            _power_reading(dict(stale, currentUa=0), 100)


class BleMockTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.fleet = BleFleet(config())  # Does not start scanner or connect.
        self.peer = self.fleet._peers["kr-test"]
        self.peer.identity = dict(bootId="boot-test", firmwareRevision="keyring-0.7.0")
        self.peer.ready.set()
        self.peer.command_writable = True

    async def test_execute_20_byte_chunks_ignores_unrelated_receipt(self):
        cmd = command()
        digest = payload_hash(cmd)
        writes = []

        async def write(uuid, data, response):
            self.assertEqual(uuid, self.fleet.command_uuid)
            self.assertTrue(response)
            writes.append(data)
            if data.endswith(b"\n"):
                self.fleet._receipt_fragment(self.peer, bytearray(json.dumps(
                    device_receipt(cmd, "0" * 64)).encode() + b"\n"))
                self.assertFalse(self.peer.pending.done())
                self.fleet._receipt_fragment(self.peer, bytearray(json.dumps(
                    device_receipt(cmd, digest)).encode() + b"\n"))

        self.peer.client = type("FakeClient", (), {"is_connected": True})()
        self.peer.client.write_gatt_char = AsyncMock(side_effect=write)
        result = await self.fleet.execute(cmd, 1000, digest)
        wire = json.loads(b"".join(writes))
        self.assertTrue(all(1 <= len(chunk) <= 20 for chunk in writes))
        self.assertEqual(wire["payloadHash"], digest)
        self.assertTrue(0 < wire["remainingMs"] <= 1000)
        self.assertEqual(result["ackCode"], "APPLIED")
        self.assertIsNone(self.peer.pending)

    async def execute_with_final_write(self, on_final):
        cmd = command()
        digest = payload_hash(cmd)
        wire_receipt = bytearray((json.dumps(device_receipt(cmd, digest)) + "\n").encode())

        async def write(_uuid, data, *, response):
            self.assertTrue(response)
            if data.endswith(b"\n"):
                await on_final(wire_receipt)

        self.peer.client = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock(side_effect=write))
        return await self.fleet.execute(cmd, 1000, digest)

    async def test_matching_receipt_survives_disconnect_before_final_write_returns(self):
        async def disconnect(receipt):
            self.fleet._receipt_fragment(self.peer, receipt)
            self.fleet._lost(self.peer)

        result = await self.execute_with_final_write(disconnect)
        self.assertEqual((result["ackCode"], result["readback"]), ("APPLIED", {"state": True}))
        self.assertFalse(self.peer.ready.is_set())

    async def test_matching_receipt_survives_final_write_transport_error(self):
        async def fail(receipt):
            self.fleet._receipt_fragment(self.peer, receipt)
            raise OSError("synthetic lost GATT response")

        result = await self.execute_with_final_write(fail)
        self.assertEqual(result["ackCode"], "APPLIED")
        self.assertFalse(self.peer.ready.is_set())
        self.assertIsNone(self.peer.pending_receipt_deadline)

    async def test_matching_receipt_survives_internal_timeout_of_final_write(self):
        self.fleet.config.ble_command_timeout = 0.1

        async def stall(receipt):
            self.fleet._receipt_fragment(self.peer, receipt)
            await asyncio.Future()

        with patch("bubble_gateway.ble.time", SimpleNamespace(monotonic=lambda: 100.0)):
            result = await self.execute_with_final_write(stall)
        self.assertEqual(result["ackCode"], "APPLIED")
        self.assertFalse(self.peer.ready.is_set())

    async def test_receipt_at_deadline_cannot_settle_even_if_timeout_has_not_run(self):
        async def late(receipt):
            deadline = self.peer.pending_receipt_deadline
            with patch("bubble_gateway.ble.time", SimpleNamespace(monotonic=lambda: deadline)):
                self.fleet._receipt_fragment(self.peer, receipt)
            self.assertFalse(self.peer.pending.done())
            self.fleet._lost(self.peer)

        with self.assertRaises(BleUnavailable):
            await self.execute_with_final_write(late)

    async def test_matching_receipt_cannot_settle_before_final_write(self):
        cmd = command()
        digest = payload_hash(cmd)
        receipt = bytearray((json.dumps(device_receipt(cmd, digest)) + "\n").encode())

        async def write(_uuid, data, *, response):
            self.assertFalse(data.endswith(b"\n"))
            self.fleet._receipt_fragment(self.peer, receipt)
            self.assertFalse(self.peer.pending.done())
            self.fleet._lost(self.peer)

        self.peer.client = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock(side_effect=write))
        with self.assertRaises(BleUnavailable):
            await self.fleet.execute(cmd, 1000, digest)
        self.peer.client.write_gatt_char.assert_awaited_once()

    async def test_external_cancellation_still_propagates(self):
        received = asyncio.Event()

        async def stall(receipt):
            self.fleet._receipt_fragment(self.peer, receipt)
            received.set()
            await asyncio.Future()

        task = asyncio.create_task(self.execute_with_final_write(stall))
        try:
            async with asyncio.timeout(1):
                await received.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_receipt_timing_is_frozen_before_final_write_ack_returns(self):
        cmd = command()
        digest = payload_hash(cmd)
        wall = datetime(2026, 11, 11, tzinfo=timezone.utc)
        now = 100.0
        self.peer.anchor = ("boot-test", 1000, wall, now)

        async def write(_uuid, data, *, response):
            nonlocal now
            self.assertTrue(response)
            if data.endswith(b"\n"):
                now = 100.5
                receipt = device_receipt(cmd, digest, acceptedUptimeMs=1100, appliedUptimeMs=1200)
                self.fleet._receipt_fragment(self.peer, bytearray((json.dumps(receipt) + "\n").encode()))
                # A later BLE observation must not move the matched receipt's times.
                now = 101.25
                self.peer.anchor = ("boot-test", 1300, wall + timedelta(seconds=1.25), now)

        self.peer.client = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock(side_effect=write))
        with (patch("bubble_gateway.ble.time", SimpleNamespace(monotonic=lambda: now)),
              patch("bubble_gateway.ble.utc_now", side_effect=lambda: wall + timedelta(seconds=now - 100))):
            result = await self.fleet.execute(cmd, 2000, digest)
        self.assertEqual((result["acceptedAt"], result["appliedAt"], result["receivedAt"]), (
            "2026-11-11T00:00:00.100Z", "2026-11-11T00:00:00.200Z", "2026-11-11T00:00:00.500Z"))
        self.assertEqual(result["timestampSource"], "gateway-estimated")
        self.assertIsNone(self.peer.pending_final_write_at)

    async def test_receipt_timing_omits_impossible_estimates_but_preserves_readback(self):
        cmd = command()
        digest = payload_hash(cmd)
        wall = datetime(2026, 11, 11, tzinfo=timezone.utc)
        self.peer.anchor = ("boot-test", 1000, wall, 100.0)
        cases = (
            (100.0, 1100, 1600, 0.5),  # Applied estimate is after notification receipt.
            (100.3, 1100, 1200, 0.5),  # Fresh acceptance would precede final write.
            (None, 1100, 1200, 0.5),   # No final write recorded for a fresh apply.
            (100.0, 1100, 1200, 5.5),  # Wall clock stepped during the interval.
        )
        for final_write, accepted, applied, wall_delta in cases:
            with self.subTest(final_write=final_write, accepted=accepted, applied=applied, wall_delta=wall_delta):
                self.peer.pending_final_write_at = final_write
                receipt = device_receipt(cmd, digest, acceptedUptimeMs=accepted, appliedUptimeMs=applied)
                with (patch("bubble_gateway.ble.time", SimpleNamespace(monotonic=lambda: 100.5)),
                      patch("bubble_gateway.ble.utc_now", return_value=wall + timedelta(seconds=wall_delta))):
                    result = self.fleet._receipt_times(self.peer, receipt)
                self.assertEqual((result["acceptedAt"], result["appliedAt"], result["timestampSource"]),
                                 (None, None, "unavailable"))
                self.assertEqual((result["ackCode"], result["readback"]), ("APPLIED", {"state": True}))

    async def test_same_boot_duplicate_can_predate_the_current_write(self):
        cmd = command()
        wall = datetime(2026, 11, 11, tzinfo=timezone.utc)
        self.peer.anchor = ("boot-test", 1000, wall, 100.0)
        self.peer.pending_final_write_at = 100.3
        receipt = device_receipt(cmd, payload_hash(cmd), ackCode="DUPLICATE", acceptedUptimeMs=900, appliedUptimeMs=950)
        with (patch("bubble_gateway.ble.time", SimpleNamespace(monotonic=lambda: 100.5)),
              patch("bubble_gateway.ble.utc_now", return_value=wall + timedelta(seconds=0.5))):
            result = self.fleet._receipt_times(self.peer, receipt)
        self.assertEqual((result["acceptedAt"], result["appliedAt"], result["timestampSource"]),
                         ("2026-11-10T23:59:59.900Z", "2026-11-10T23:59:59.950Z", "gateway-estimated"))

    async def test_partial_write_failure_invalidates_session(self):
        self.peer.client = type("FakeClient", (), {"is_connected": True})()
        self.peer.client.write_gatt_char = AsyncMock(side_effect=OSError("synthetic failure"))
        cmd = command()
        with self.assertRaises(OSError):
            await self.fleet.execute(cmd, 1000, payload_hash(cmd))
        self.assertFalse(self.peer.ready.is_set())
        self.assertTrue(self.peer.disconnected.is_set())
        self.assertIsNone(self.peer.pending)

    async def test_deadline_is_not_rebased_on_late_execute(self):
        self.peer.client = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock())
        cmd = command()
        with self.assertRaises(TimeoutError):
            await self.fleet.execute(cmd, 1000, payload_hash(cmd), deadline_monotonic=time.monotonic() - 0.1)
        self.peer.client.write_gatt_char.assert_not_awaited()
        self.assertTrue(self.peer.ready.is_set())

    async def test_expired_budget_stops_partial_frame_before_next_write(self):
        now = 100.0

        async def write(_uuid, _data, *, response):
            nonlocal now
            self.assertTrue(response)
            now = 101.0

        client = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock(side_effect=write))
        self.peer.client = client
        cmd = command()
        clock = SimpleNamespace(monotonic=lambda: now)
        with patch("bubble_gateway.ble.time", clock), self.assertRaises(TimeoutError):
            await self.fleet.execute(cmd, 1000, payload_hash(cmd), deadline_monotonic=100.5)
        client.write_gatt_char.assert_awaited_once()
        self.assertFalse(self.peer.ready.is_set())
        self.assertIsNone(self.peer.pending)

    async def test_observation_duplicates_and_stale_rssi(self):
        frame = dict(version=1, deviceId="kr-test", bootId="boot-test", sequence=1, uptimeMs=100,
                     battery=None, buttonState="released", sensorValues={}, state=False)
        self.peer.rssi, self.peer.rssi_monotonic = -60, time.monotonic() - 31
        self.fleet._queue_observation(self.peer, frame)
        self.fleet._queue_observation(self.peer, deepcopy(frame))
        self.assertEqual(self.peer.observations.qsize(), 1)
        result = self.peer.observations.get_nowait()
        self.assertIsNone(result["battery"])
        self.assertIsNone(result["rssi"])

    async def test_full_queue_does_not_advance_observation_watermark(self):
        self.peer.observations = asyncio.Queue(maxsize=1)
        frame = dict(version=1, deviceId="kr-test", bootId="boot-test", sequence=1, uptimeMs=100,
                     battery=None, buttonState="released", sensorValues={}, state=False)
        self.fleet._queue_observation(self.peer, frame)
        next_frame = dict(frame, sequence=2, uptimeMs=200)
        self.fleet._queue_observation(self.peer, next_frame)
        self.assertEqual(self.peer.observation_watermark, ("boot-test", 1, 100))
        self.assertIsNone(self.peer.anchor)
        self.assertEqual(self.peer.observations.get_nowait()["sequence"], 1)
        self.fleet._queue_observation(self.peer, next_frame)
        self.assertEqual(self.peer.observations.get_nowait()["sequence"], 2)

    async def test_ble_rejects_alert_claim_when_battery_is_unavailable(self):
        frame = dict(version=1, deviceId="kr-test", bootId="boot-test", sequence=1, uptimeMs=100,
                     battery=None, buttonState="released", sensorValues={"batteryAlert": True}, state=False)
        with self.assertRaises(BleProtocolError):
            self.fleet._queue_observation(self.peer, frame)
        self.assertTrue(self.peer.observations.empty())
