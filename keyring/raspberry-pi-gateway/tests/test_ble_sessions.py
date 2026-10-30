"""Connection replacement races using fake GATT clients; no scanner or radio."""
import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from bubble_gateway.ble import BleFleet, BleUnavailable
from bubble_gateway.model import payload_hash
from helpers import command, config, device_receipt


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
            services = SimpleNamespace(get_service=lambda _: object())

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

    async def test_old_observation_cannot_poison_new_frame_buffer(self):
        old, current = await self.reconnect()
        count = self.peer.observations.qsize()
        old.callbacks[self.fleet.observation_uuid](None, bytearray(b'{"broken":'))
        self.assertEqual(self.peer.observation_frames.data, bytearray())
        self.assertTrue(self.peer.ready.is_set())
        current.callbacks[self.fleet.observation_uuid](None, bytearray(json.dumps(current.frame(2)).encode() + b"\n"))
        self.assertEqual(self.peer.observations.qsize(), count + 1)
        self.assertTrue(self.peer.ready.is_set())

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
