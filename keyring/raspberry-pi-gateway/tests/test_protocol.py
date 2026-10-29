import asyncio
import json
import time
import unittest
from copy import deepcopy
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from bubble_gateway.ble import BleFleet, BleProtocolError, BleUnavailable, _Frames, _object, _power_reading
from bubble_gateway.core_bridge import command as core_command
from bubble_gateway.model import authorization_deadline, parse_time, payload_hash, validate_command
from helpers import DEVICES, command, config, device_receipt


class ContractTests(unittest.TestCase):
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

    async def test_partial_write_failure_invalidates_session(self):
        self.peer.client = type("FakeClient", (), {"is_connected": True})()
        self.peer.client.write_gatt_char = AsyncMock(side_effect=OSError("synthetic failure"))
        cmd = command()
        with self.assertRaises(OSError):
            await self.fleet.execute(cmd, 1000, payload_hash(cmd))
        self.assertFalse(self.peer.ready.is_set())
        self.assertTrue(self.peer.disconnected.is_set())
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
