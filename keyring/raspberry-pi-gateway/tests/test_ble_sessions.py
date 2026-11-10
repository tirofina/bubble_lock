"""Connection replacement races using fake GATT clients; no scanner or radio."""
import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from bubble_gateway.ble import BleFleet, BleUnavailable
from bubble_gateway.ble_characterize import summarize
from bubble_gateway.model import payload_hash
from helpers import command, config, device_receipt


class WakeCaptureTests(unittest.TestCase):
    def test_requires_a_new_boot_and_the_expected_button_mask(self):
        board = "r18-hand-solder"

        def frame(kind, at, phase, boot, **fields):
            return dict(event=kind, atNs=at * 1_000_000, phase=phase, generation=1,
                        bootId=boot, boardRevision=board, **fields)

        ready = {"advertisingRssiDbm": None, "advertisingAgeMs": None}
        for boot, pins, status in (("boot-after", 64, "RECORDED"), ("boot-before", 64, "INSUFFICIENT"),
                                   ("boot-after", 128, "INSUFFICIENT"), ("boot-after", 192, "INSUFFICIENT")):
            with self.subTest(boot=boot, pins=pins):
                events = [
                    frame("ready", 1, "baseline", "boot-before", **ready),
                    frame("notification", 2, "baseline", "boot-before", sequence=1),
                    frame("ready", 20, "after-wake", boot, **ready),
                    frame("notification", 21, "after-wake", boot, sequence=2,
                          wakeCause="button", wakePins=pins, deviceUptimeMs=700),
                ]
                report = summarize(events, 0, 30_000_000, board=board, mode="wake", truncated=False,
                                   dropped=0, expected_wake="confirm", release_ms=5)
                self.assertEqual(report["status"], status)
                self.assertEqual(len(report["sessions"]), 2)
                self.assertEqual(report["wake"]["releaseToFirstNotificationMs"], 16)

    def test_power_capture_deduplicates_same_boot_and_requires_first_wake_boot(self):
        board = "r18-hand-solder"

        def frame(kind, at, phase, boot, generation, **fields):
            return dict(event=kind, atNs=at * 1_000_000, phase=phase, generation=generation,
                        bootId=boot, boardRevision=board, **fields)

        ready = {"advertisingRssiDbm": None, "advertisingAgeMs": None}
        sample = dict(status="ok", busVoltageMv=3300, currentUa=-100, loadPowerUw=-330,
                      shuntVoltageUv=-10, readUptimeMs=700)
        stale = dict.fromkeys(sample)
        stale["status"] = "stale"
        events = [
            frame("ready", 1, "baseline", "before", 1, **ready),
            frame("notification", 2, "baseline", "before", 1, sequence=1, ina219=sample, deviceUptimeMs=750),
            frame("lost", 3, "baseline", "before", 1),
            frame("ready", 4, "baseline", "before", 2, **ready),
            frame("notification", 5, "baseline", "before", 2, sequence=2, ina219=sample, deviceUptimeMs=800),
            frame("ready", 10, "after-wake", "first-after", 1, **ready),
            frame("notification", 11, "after-wake", "first-after", 1, sequence=1,
                  wakeCause="button", wakePins=64, deviceUptimeMs=600),
            frame("notification", 12, "after-wake", "first-after", 1, sequence=2, ina219=None, deviceUptimeMs=650),
            frame("notification", 13, "after-wake", "first-after", 1, sequence=3, ina219=stale, deviceUptimeMs=690),
            frame("ready", 20, "after-wake", "later-after", 2, **ready),
            frame("notification", 21, "after-wake", "later-after", 2, sequence=1, ina219=sample, deviceUptimeMs=750),
        ]
        options = dict(board=board, mode="wake", truncated=False, dropped=0, expected_wake="confirm", release_ms=6)
        baseline = summarize(events, 0, 30_000_000, **options)
        self.assertEqual(baseline["status"], "RECORDED")
        self.assertNotIn("power", baseline)
        self.assertTrue(all("ina219" not in row for row in baseline["events"]))

        missing = summarize(events, 0, 30_000_000, include_power=True, **options)
        self.assertEqual(missing["status"], "INSUFFICIENT")
        self.assertEqual(missing["power"], dict(uniqueValidSamples=2, repeatedValidFrames=1,
                                               invalidFrames=1, missingEnergyFrames=1, missingPhases=["after-wake"]))

        after_power = frame("notification", 14, "after-wake", "first-after", 1,
                            sequence=4, ina219=sample, deviceUptimeMs=750)
        complete_events = sorted([*events, after_power], key=lambda event: event["atNs"])
        complete = summarize(complete_events, 0, 30_000_000, include_power=True, **options)
        self.assertEqual(complete["status"], "RECORDED")
        self.assertEqual(complete["power"]["uniqueValidSamples"], 3)
        self.assertEqual([row["newPowerSample"] for row in complete["events"] if "newPowerSample" in row],
                         [True, False, True, True])


class SessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        cfg = config()
        cfg.ble_pair, cfg.request_timeout, cfg.ble_scan_seconds = True, 1, 1
        cfg.firmware_revision_allowlist = ()
        self.fleet = BleFleet(cfg)
        self.peer = self.fleet._peers["kr-test"]
        self.clients = []
        self.watcher = None

    async def asyncTearDown(self):
        self.fleet._closed.set()
        if self.peer.pending is not None:
            self.peer.pending.cancel()
        if self.watcher is not None:
            self.watcher.cancel()
            await asyncio.gather(self.watcher, return_exceptions=True)

    def factory(self, _device, *, disconnected_callback, **_kwargs):
        fleet = self.fleet
        number = len(self.clients) + 1

        class Client:
            is_connected = True
            services = SimpleNamespace(get_service=lambda _: SimpleNamespace(
                get_characteristic=lambda uuid: SimpleNamespace(properties=["write"])
                if uuid == fleet.command_uuid else None))

            def __init__(self):
                self.callbacks = {}
                self.disconnect_callback = disconnected_callback
                self.identity = dict(version=1, deviceId="kr-test", firmwareRevision="keyring-0.7.0",
                                     boardRevision="r18", bootId=f"boot-{number}")

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                self.is_connected = False

            async def start_notify(self, uuid, callback):
                self.callbacks[uuid] = callback

            async def read_gatt_char(self, uuid):
                return json.dumps(self.identity if uuid == fleet.identity_uuid else self.frame()).encode()

            def frame(self, sequence=1):
                return dict(version=1, deviceId="kr-test", bootId=self.identity["bootId"], sequence=sequence,
                            uptimeMs=100, battery=None, buttonState="released", sensorValues={}, state=False)

        client = Client()
        self.clients.append(client)
        return client

    async def ready(self, number):
        async with asyncio.timeout(1):
            while not (len(self.clients) == number and self.peer.ready.is_set()
                       and self.peer.identity.get("bootId") == f"boot-{number}"):
                if self.watcher.done():
                    self.watcher.result()
                    self.fail("fake connection watcher stopped before readiness")
                await asyncio.sleep(0)

    async def reconnect(self):
        self.patch_client = patch("bubble_gateway.ble.BleakClient", side_effect=self.factory)
        self.patch_client.start()
        self.addCleanup(self.patch_client.stop)

        async def advertise(_seconds):
            self.peer.seen.set()
            await asyncio.sleep(0)

        self.fleet._pause = advertise
        self.peer.discovered = object()
        self.peer.seen.set()
        self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
        await self.ready(1)
        old = self.clients[0]
        old.disconnect_callback(old)
        await self.ready(2)
        return old, self.clients[1]

    async def test_old_disconnect_does_not_disconnect_replacement(self):
        old, current = await self.reconnect()
        old.disconnect_callback(old)
        self.assertTrue(self.peer.ready.is_set())
        self.assertIs(self.peer.client, current)
        self.assertFalse(self.peer.disconnected.is_set())
        # Current disconnect must still fence its pending command.
        pending = self.peer.pending = asyncio.get_running_loop().create_future()
        current.disconnect_callback(current)
        with self.assertRaises(BleUnavailable):
            await pending
        self.assertFalse(self.peer.ready.is_set())

    async def test_diagnostic_trace_excludes_reads_and_old_connection_notifications(self):
        events = []
        self.fleet._trace = events.append
        old, current = await self.reconnect()
        self.assertEqual([event["event"] for event in events], ["ready", "lost", "ready"])
        old.callbacks[self.fleet.observation_uuid](None, bytearray((json.dumps(old.frame(2)) + "\n").encode()))
        current.callbacks[self.fleet.observation_uuid](None, bytearray((json.dumps(current.frame(2)) + "\n").encode()))
        self.assertEqual([event["event"] for event in events], ["ready", "lost", "ready", "notification"])
        self.assertEqual(events[-1]["generation"], events[2]["generation"])
        self.assertEqual(events[-1]["sequence"], 2)

    async def test_observation_ready_without_command_characteristic(self):
        def observation_only(*args, **kwargs):
            client = self.factory(*args, **kwargs)
            client.services = SimpleNamespace(get_service=lambda _: SimpleNamespace(
                get_characteristic=lambda _uuid: None))
            return client

        self.peer.discovered = object()
        self.peer.seen.set()
        with patch("bubble_gateway.ble.BleakClient", side_effect=observation_only):
            self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
            await self.ready(1)
            self.assertEqual(self.peer.observations.qsize(), 1)
            self.assertIsNone(self.fleet.command_session("kr-test"))
            snapshot = self.fleet.snapshot()[0]
            self.assertTrue(snapshot["connected"])
            self.assertFalse(snapshot["commandReady"])

    async def test_authorized_generation_cannot_write_on_replacement(self):
        old, current = await self.reconnect()
        old_generation = self.peer.generation - 2
        self.assertEqual(self.fleet.command_session("kr-test"), self.peer.generation)
        self.assertTrue(self.fleet.snapshot()[0]["commandReady"])
        current.write_gatt_char = AsyncMock()
        cmd = command()
        with self.assertRaises(BleUnavailable):
            await self.fleet.execute(cmd, 1000, payload_hash(cmd), expected_generation=old_generation)
        current.write_gatt_char.assert_not_awaited()
        self.assertTrue(self.peer.ready.is_set())

    async def test_scan_completion_preserves_watcher_cancellation(self):
        started = asyncio.Event()
        discovered = asyncio.Event()

        async def scan_ready():
            started.set()
            await discovered.wait()
            asyncio.get_running_loop().call_soon(self.watcher.cancel)
            return True

        self.peer.seen.wait = scan_ready
        self.peer.discovered = object()
        with patch("bubble_gateway.ble.BleakClient", side_effect=self.factory):
            self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
            await started.wait()
            discovered.set()
            try:
                done, _ = await asyncio.wait({self.watcher}, timeout=1)
                self.assertIn(self.watcher, done, "scan completion consumed watcher cancellation")
                self.assertTrue(self.watcher.cancelled())
                self.assertFalse(self.peer.ready.is_set())
                self.assertIsNone(self.peer.client)
            finally:
                self.watcher.cancel()
                await asyncio.gather(self.watcher, return_exceptions=True)

    async def test_old_observation_cannot_poison_new_frame_buffer(self):
        old, current = await self.reconnect()
        count = self.peer.observations.qsize()
        old.callbacks[self.fleet.observation_uuid](None, bytearray(b'{"broken":'))
        self.assertEqual(self.peer.observation_frames.data, bytearray())
        self.assertTrue(self.peer.ready.is_set())
        current.callbacks[self.fleet.observation_uuid](None, bytearray(json.dumps(current.frame(2)).encode() + b"\n"))
        self.assertEqual(self.peer.observations.qsize(), count + 1)
        self.assertTrue(self.peer.ready.is_set())

    async def test_bluez_read_value_does_not_contaminate_notification_fragments(self):
        original_factory = self.factory

        def bluez_client(*args, **kwargs):
            client = original_factory(*args, **kwargs)
            original_read = client.read_gatt_char

            async def read(uuid):
                value = await original_read(uuid)
                # BlueZ also emits a Value PropertiesChanged event for READ.
                # Bleak forwards it when this characteristic is subscribed.
                callback = client.callbacks.get(uuid)
                if callback is not None:
                    callback(None, bytearray(value))
                return value

            client.read_gatt_char = read
            return client

        self.peer.discovered = object()
        self.peer.seen.set()
        with patch("bubble_gateway.ble.BleakClient", side_effect=bluez_client):
            self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
            await self.ready(1)
            client = self.clients[0]
            first = self.peer.observations.get_nowait()
            self.assertEqual(first["sequence"], 1)
            notification = json.dumps(client.frame(2)).encode() + b"\n"
            for offset in range(0, len(notification), 20):
                client.callbacks[self.fleet.observation_uuid](
                    None, bytearray(notification[offset:offset + 20]))
            self.assertTrue(self.peer.ready.is_set(), "READ polluted the LF-framed notification stream")
            self.assertFalse(self.peer.disconnected.is_set())
            self.assertIsNone(self.peer.last_error)
            self.assertEqual(self.peer.observations.get_nowait()["sequence"], 2)
            self.assertTrue(self.peer.observations.empty())
            self.assertEqual(self.peer.observation_frames.data, bytearray())

    async def test_old_receipt_cannot_settle_current_pending_command(self):
        old, current = await self.reconnect()
        cmd = command()
        digest = payload_hash(cmd)
        pending = self.peer.pending = asyncio.get_running_loop().create_future()
        self.peer.pending_command, self.peer.pending_hash = cmd["commandId"], digest
        receipt = device_receipt(cmd, digest, bootId=old.identity["bootId"])
        old.callbacks[self.fleet.receipt_uuid](None, bytearray(json.dumps(receipt).encode() + b"\n"))
        self.assertFalse(pending.done())
        receipt["bootId"] = current.identity["bootId"]
        current.callbacks[self.fleet.receipt_uuid](None, bytearray(json.dumps(receipt).encode() + b"\n"))
        self.assertEqual((await pending)["bootId"], "boot-2")

    async def test_applied_from_a_different_boot_cannot_settle_current_command(self):
        old, current = await self.reconnect()
        cmd = command()
        digest = payload_hash(cmd)
        pending = self.peer.pending = asyncio.get_running_loop().create_future()
        self.peer.pending_command, self.peer.pending_hash = cmd["commandId"], digest
        receipt = device_receipt(cmd, digest, bootId=old.identity["bootId"])
        notify = current.callbacks[self.fleet.receipt_uuid]
        unrelated = dict(receipt, commandId="unrelated")
        notify(None, bytearray(json.dumps(unrelated).encode() + b"\n"))
        self.assertFalse(pending.done())
        self.assertTrue(self.peer.ready.is_set())
        notify(None, bytearray(json.dumps(receipt).encode() + b"\n"))
        with self.assertRaises(BleUnavailable):
            await pending
        self.assertEqual(self.peer.last_error, "receipt_boot_mismatch")
        self.assertFalse(self.peer.ready.is_set())

    async def test_duplicate_from_a_different_boot_preserves_historical_readback(self):
        old, current = await self.reconnect()
        cmd = command()
        digest = payload_hash(cmd)
        pending = self.peer.pending = asyncio.get_running_loop().create_future()
        self.peer.pending_command, self.peer.pending_hash = cmd["commandId"], digest
        receipt = device_receipt(cmd, digest, bootId=old.identity["bootId"], ackCode="DUPLICATE")
        current.callbacks[self.fleet.receipt_uuid](None, bytearray(json.dumps(receipt).encode() + b"\n"))
        result = self.fleet._receipt_times(self.peer, await pending)
        self.assertEqual(result["bootId"], "boot-1")
        self.assertEqual(result["readback"], {"state": True})
        self.assertEqual(result["timestampSource"], "unavailable")
        self.assertTrue(self.peer.ready.is_set())

    async def test_partial_command_never_continues_on_replacement_client(self):
        replacement = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock())

        async def switch_connection(*_args, **_kwargs):
            self.fleet._lost(self.peer)
            self.peer.client = replacement
            self.peer.disconnected.clear()
            self.peer.ready.set()

        original = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock(side_effect=switch_connection))
        self.peer.client = original
        self.peer.ready.set()
        cmd = command()
        with self.assertRaises(BleUnavailable):
            await self.fleet.execute(cmd, 1000, payload_hash(cmd))
        original.write_gatt_char.assert_awaited_once()
        replacement.write_gatt_char.assert_not_awaited()
        self.assertTrue(self.peer.ready.is_set())  # Old operation cleanup cannot kill the replacement.
        self.assertIsNone(self.peer.pending)

    async def test_failed_handshake_never_marks_session_ready(self):
        original_factory = self.factory

        def invalid_handshake(*args, **kwargs):
            client = original_factory(*args, **kwargs)
            original_notify = client.start_notify

            async def notify(uuid, callback):
                await original_notify(uuid, callback)
                if uuid == self.fleet.observation_uuid:
                    callback(None, bytearray(b"{}\n"))

            client.start_notify = notify
            return client

        self.peer.ready.set = Mock(wraps=self.peer.ready.set)
        self.peer.seen.set()

        async def stop(_seconds):
            self.fleet._closed.set()

        self.fleet._pause = stop
        with patch("bubble_gateway.ble.BleakClient", side_effect=invalid_handshake):
            async with asyncio.timeout(1):
                await self.fleet._watch(self.peer)
        self.peer.ready.set.assert_not_called()
