"""Opt-in: team mTLS API, real MQTT, Gateway workers, fake GATT and disposable Mobius4."""
import asyncio
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import httpx
import paho.mqtt.client as mqtt

from bubble_gateway.config import GatewayConfig, tls_context
from bubble_gateway.core_bridge import acknowledgement
from bubble_gateway.model import payload_hash
from bubble_gateway.service import Gateway
from bubble_gateway.store import Store
from bubble_gateway.transport import RemoteResponseError, TransportHub
from helpers import DEVICES, device_receipt
from mobius_fixture import DisposableMobius
from tls_fixture import TestPki


class CoreCommandPeer:
    def __init__(self, config):
        self.loop = asyncio.get_running_loop()
        self.subscribed = self.loop.create_future()
        self.acks = asyncio.Queue()
        self.command_topic = f"privacy-bubble/gateway/{config.gateway_id}/command"
        self.ack_topic = f"privacy-bubble/gateway/{config.gateway_id}/ack"
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="core-test-" + uuid.uuid4().hex,
                                  clean_session=True, protocol=mqtt.MQTTv311)
        self.client.tls_set_context(tls_context(config))
        self.client.connect_timeout = 3
        self.client.on_connect = self.on_connect
        self.client.on_subscribe = self.on_subscribe
        self.client.on_message = self.on_message

    def on_connect(self, client, _userdata, _flags, reason, _properties):
        if reason == 0:
            client.subscribe(self.ack_topic, qos=1)

    def on_subscribe(self, _client, _userdata, _mid, reasons, _properties):
        def complete():
            if not self.subscribed.done():
                self.subscribed.set_result(len(reasons) == 1 and reasons[0] == 1)
        self.loop.call_soon_threadsafe(complete)

    def on_message(self, _client, _userdata, message):
        self.loop.call_soon_threadsafe(self.acks.put_nowait, message)

    async def start(self, port):
        await asyncio.to_thread(self.client.connect, "127.0.0.1", port, 10)
        self.client.loop_start()
        if not await asyncio.wait_for(self.subscribed, 5):
            raise RuntimeError("CORE test peer did not receive a QoS 1 subscription")

    async def publish(self, command):
        packet = self.client.publish(self.command_topic, json.dumps(command), qos=1, retain=False)
        await asyncio.to_thread(packet.wait_for_publish, timeout=3)
        if not packet.is_published():
            raise TimeoutError("CORE test command did not receive PUBACK")

    async def close(self):
        await asyncio.to_thread(self.client.disconnect)
        await asyncio.to_thread(self.client.loop_stop)


class CentralDispatchTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.pki = TestPki()
        cls.addClassCleanup(cls.pki.close)
        cls.pki.leaf("core", "trusted", 7, "clientAuth", subject="core-test")
        server = cls.pki.root / "server-only"
        server.mkdir()
        for name in ("trusted.pem", "server.pem", "server.key"):
            shutil.copyfile(cls.pki.root / name, server / name)
        cls.stack = DisposableMobius(SimpleNamespace(root=server), core_gateway_id="gw-test")
        cls.addClassCleanup(cls.stack.close)

    async def asyncSetUp(self):
        fixture = Path(os.environ["KEYRING_TEST_CENTRAL_TREE"]) / "tests/integration/gateway-server.mjs"
        self.process = await asyncio.create_subprocess_exec(
            "node", str(fixture), str(self.pki.root), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.addAsyncCleanup(self.stop_central)
        hello = await self.central_output()
        self.assertRegex(hello["origin"], r"\Ahttps://127\.0\.0\.1:[0-9]+\Z")
        self.command = hello["command"]
        self.digest = payload_hash(self.command)
        temp = tempfile.TemporaryDirectory(prefix="keyring-central-dispatch-")
        self.addCleanup(temp.cleanup)
        prefix = "/Mobius/dispatch-" + uuid.uuid4().hex[:12]
        env = {
            "GATEWAY_ID": "gw-test", "M2M_ORIGINATOR": self.stack.admin,
            "M2M_CSE_ID": self.stack.cse_id, "M2M_CSE_URL": self.stack.origin,
            "M2M_RVI": "4", "PC_API_URL": hello["origin"],
            "M2M_OBSERVATION_CONTAINER": prefix + "-obs",
            "M2M_RECEIPT_CONTAINER": prefix + "-receipt",
            "M2M_HEALTH_CONTAINER": prefix + "-health",
            "TLS_CA_FILE": str(self.pki.path("trusted")), "TLS_CERT_FILE": str(self.pki.path("client")),
            "TLS_KEY_FILE": str(self.pki.path("client", "key")), "MQTT_ENABLED": "false",
            "BLE_DEVICES": json.dumps(DEVICES), "GATEWAY_DATABASE": str(Path(temp.name) / "gateway.sqlite3"),
            "BLE_SCAN_SECONDS": "10", "POLL_INTERVAL": "0.5", "REQUEST_TIMEOUT": "3",
        }
        with patch.dict(os.environ, env, clear=True):
            self.config = GatewayConfig.from_env()
        self.reader = TransportHub(self.config)
        self.addAsyncCleanup(self.reader.close)
        await self.reader.start()
        async with asyncio.timeout(20):
            while True:
                try:
                    if (await self.cse("GET", "/Mobius"))[:2] == (200, 2000):
                        break
                except (RemoteResponseError, httpx.TransportError):
                    pass
                await asyncio.sleep(0.2)
        for parent in (self.config.observation_container, self.config.receipt_container, self.config.health_container):
            result = await self.cse("POST", "/Mobius", {"m2m:cnt": {"rn": parent.rsplit("/", 1)[-1], "mni": 100}})
            self.assertEqual(result[:2], (201, 2001))

    async def central_output(self):
        data = await asyncio.wait_for(self.process.stdout.readline(), 10)
        if not data:
            stderr = await asyncio.wait_for(self.process.stderr.read(), 3)
            self.fail("Node central fixture exited before its reply:\n" + stderr.decode(errors="replace"))
        return json.loads(data)

    async def stop_central(self):
        if self.process.returncode is None:
            try:
                await asyncio.wait_for(self.process.communicate(b"close\n"), 5)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.assertEqual(self.process.returncode, 0)

    async def cse(self, method, path, body=None):
        rqi = "dispatch-test-" + uuid.uuid4().hex
        headers = self.reader._m2m_headers(rqi, create=body is not None)
        if body is not None:
            headers["Content-Type"] = "application/json;ty=3"
        status, response, document = await self.reader._http_json(
            method, self.stack.origin + path, headers=headers, body=body)
        return status, self.reader._response_rsc(status, response, rqi), document

    async def exercise(self, *, revoke_before_connect, core_peer=None):
        gateway = Gateway(self.config)
        connect = asyncio.Event()
        writes = []
        frames = []
        approvals = []
        test = self
        fleet = gateway.ble
        authorize = gateway.transport.authorize
        api = gateway.transport._api
        poll_available = core_peer is None

        async def control_poll(method, suffix, *args):
            if not poll_available and (method, suffix) == ("GET", "/commands?limit=16"):
                raise RemoteResponseError("synthetic poll outage", status_code=503)
            return await api(method, suffix, *args)

        async def capture_authorization(command, digest):
            result = await authorize(command, digest)
            approvals.append(result)
            return result
        identity = dict(version=1, deviceId="kr-test", bootId="boot-test",
                        boardRevision="r18", firmwareRevision="keyring-0.7.0")

        class Scanner:
            def __init__(self, detection_callback):
                self.detect = detection_callback

            async def __aenter__(self):
                await connect.wait()
                self.detect(SimpleNamespace(address=DEVICES["kr-test"]), SimpleNamespace(rssi=-60))
                return self

            async def __aexit__(self, *_args):
                pass

        class Client:
            is_connected = True
            services = SimpleNamespace(get_service=lambda _: SimpleNamespace(
                get_characteristic=lambda uuid: SimpleNamespace(properties=["write"])
                if uuid == fleet.command_uuid else None))

            def __init__(self, _device, *, pair, **_kwargs):
                test.assertTrue(pair)
                self.callbacks = {}
                self.buffer = bytearray()

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                self.is_connected = False

            async def start_notify(self, uuid, callback):
                self.callbacks[uuid] = callback

            async def read_gatt_char(self, uuid):
                value = identity if uuid == fleet.identity_uuid else dict(
                    version=1, deviceId="kr-test", bootId="boot-test", sequence=1, uptimeMs=99,
                    battery=None, buttonState="released", sensorValues={}, state=False)
                return json.dumps(value).encode()

            async def write_gatt_char(self, uuid, chunk, *, response):
                test.assertEqual(uuid, fleet.command_uuid)
                test.assertTrue(response)
                test.assertLessEqual(len(chunk), 20)
                writes.append(chunk)
                self.buffer.extend(chunk)
                if self.buffer.endswith(b"\n"):
                    frames.append(json.loads(self.buffer))
                    self.buffer.clear()
                    ack = json.dumps(device_receipt(test.command, test.digest)).encode() + b"\n"
                    for offset in range(0, len(ack), 20):
                        self.callbacks[fleet.receipt_uuid](None, bytearray(ack[offset:offset + 20]))

        async def wait_for(predicate, runner):
            async with asyncio.timeout(12):
                while not predicate():
                    if runner.done():
                        runner.result()
                        test.fail("Gateway stopped before its expected state")
                    await asyncio.sleep(0.05)

        def command_row():
            return gateway.store.db.execute(
                "SELECT status, receipt, receipt_delivered FROM commands WHERE command_id=?",
                (self.command["commandId"],)).fetchone()

        with (patch("bubble_gateway.ble.BleakScanner", Scanner), patch("bubble_gateway.ble.BleakClient", Client),
              patch.object(gateway.transport, "_api", control_poll),
              patch.object(gateway.transport, "authorize", capture_authorization)):
            runner = asyncio.create_task(gateway.run())
            try:
                if core_peer is not None:
                    await asyncio.wait_for(gateway.transport._ready.wait(), 5)
                    self.assertEqual(gateway.transport._mqtt.socket().version(), "TLSv1.3")
                    denied = gateway.transport._mqtt.publish(core_peer.command_topic, json.dumps(self.command), qos=1)
                    await asyncio.to_thread(denied.wait_for_publish, timeout=3)
                    self.assertTrue(denied.is_published())
                    desired = self.command["desiredState"]["state"]
                    altered = dict(self.command, desiredState={"state": not desired})
                    await core_peer.publish(altered)
                    await wait_for(lambda: approvals, runner)
                    self.assertFalse(approvals[0]["allowed"])
                    self.assertEqual(approvals[0]["payloadHash"], payload_hash(altered))
                    self.assertIsNone(command_row())
                    alias = {key: self.command[key] for key in
                             ("deviceId", "commandId", "claimId", "grantRevision", "issuedAt", "deadline")}
                    alias.update(desiredState=desired, epoch=self.command["ownershipEpoch"])
                    await core_peer.publish(alias)
                await wait_for(lambda: gateway.counters["dispatch_deferred_ble"] > 0, runner)
                self.assertEqual(tuple(command_row()), ("RECEIVED", None, 0))
                self.assertEqual(gateway.store.interrupted(), [])
                self.assertEqual(writes, [])
                if core_peer is not None:
                    self.assertEqual([approval["allowed"] for approval in approvals], [False, True])
                    self.assertEqual(approvals[1]["payloadHash"], self.digest)
                    poll_available = True
                if revoke_before_connect:
                    self.process.stdin.write(b"revoke\n")
                    await self.process.stdin.drain()
                    self.assertTrue((await self.central_output())["revoked"])
                connect.set()
                await wait_for(lambda: command_row()["receipt_delivered"] == 1, runner)
                local = json.loads(command_row()["receipt"])
                expected = ("REJECTED", "NOT_AUTHORIZED") if revoke_before_connect else ("APPLIED", "APPLIED")
                self.assertEqual((local["status"], local["ackCode"]), expected)
                self.assertEqual(local["payloadHash"], self.digest)
                if revoke_before_connect:
                    self.assertEqual(writes, [])
                    self.assertIsNone(local["readback"])
                else:
                    await wait_for(lambda: gateway.counters["ingress_duplicate"] >= 2, runner)
                    self.assertEqual(len(frames), 1)
                    for key in ("commandId", "deviceId", "desiredState", "grantRevision", "ownershipEpoch"):
                        self.assertEqual(frames[0][key], self.command[key])
                    self.assertEqual(frames[0]["payloadHash"], self.digest)
                    self.assertEqual(local["readback"], {"state": True})
                rqi = Store.request_id("receipt", self.command["commandId"])
                parent = self.config.receipt_container
                rn = "gw-" + hashlib.sha256(rqi.encode()).hexdigest()
                status, rsc, cin = await self.cse("GET", parent + "/" + rn)
                self.assertEqual((status, rsc, cin["m2m:cin"]["con"]), (200, 2000, local))
                self.assertEqual((await self.cse("GET", parent))[2]["m2m:cnt"]["cni"], 1)
                facts = {"status": local["status"], "ackCode": local["ackCode"],
                         "gattWrites": len(writes), "commandFrames": len(frames),
                         "cinCount": 1, "readbackMatchesJournal": True}
                if core_peer is not None:
                    self.assertEqual([approval["allowed"] for approval in approvals], [False, True, True])
                    message = await asyncio.wait_for(core_peer.acks.get(), 5)
                    self.assertEqual((message.topic, message.qos, message.retain), (core_peer.ack_topic, 1, False))
                    self.assertEqual(json.loads(message.payload), acknowledgement(cin["m2m:cin"]["con"]))
                    self.assertEqual(gateway.counters["ingress_conflict"], 0)
                    broker_log = await asyncio.to_thread(self.stack.broker.logs)
                    self.assertIn("Denied PUBLISH from pb-gateway-gw-test", broker_log)
                    self.assertRegex(broker_log, rf"Sending PUBLISH to pb-gateway-gw-test \(d0, q1, r0, [^\n]+"
                                                 rf"'{re.escape(core_peer.command_topic)}'")
                    self.assertRegex(broker_log, rf"Sending PUBLISH to core-test-[0-9a-f]+ \(d0, q1, r0, [^\n]+"
                                                 rf"'{re.escape(core_peer.ack_topic)}'")
                    facts.update(mqttVersion="3.1.1", mqttTls="1.3", coreAckQos=1,
                                 forgedPayloadDenied=True, gatewayCommandPublishDenied=True,
                                 exactMqttCopyReceived=True, coreAckMatchesCin=True)
                elif not revoke_before_connect:
                    approval, = approvals
                    facts["coreAckBinding"] = await self.check_core_binding(cin["m2m:cin"]["con"], approval)
            finally:
                gateway.stop.set()
                await asyncio.wait_for(runner, 10)
        print(json.dumps(facts | {"gracefulStop": True}), flush=True)

    async def check_core_binding(self, receipt, approval):
        process = await asyncio.create_subprocess_exec(
            "node", str(Path(__file__).with_name("check_core_ack.mjs")), os.environ["KEYRING_TEST_CENTRAL_TREE"],
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        data = json.dumps(dict(command=self.command, authorization=approval,
                               receipt=receipt, ack=acknowledgement(receipt))).encode()
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(data), 8)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise
        self.assertEqual(process.returncode, 0, stderr.decode())
        return json.loads(stdout)

    async def test_central_command_waits_for_gatt_and_stores_one_receipt(self):
        await self.exercise(revoke_before_connect=False)

    async def test_grant_revoked_after_poll_is_rejected_without_gatt_write(self):
        await self.exercise(revoke_before_connect=True)

    async def test_core_fallback_requires_the_real_central_command_hash(self):
        api = self.reader._api
        wrong = dict(self.command, desiredState={"state": not self.command["desiredState"]["state"]})

        async def poll_unavailable(method, suffix, *args):
            if (method, suffix) == ("GET", "/commands?limit=16"):
                raise RemoteResponseError("synthetic poll outage", status_code=503)
            return await api(method, suffix, *args)

        with patch.object(self.reader, "_api", poll_unavailable):
            self.reader._queue_command(wrong)
            with self.assertRaises(RemoteResponseError) as raised:
                await self.reader.poll_commands()
            self.assertEqual(raised.exception.status_code, 503)
            self.reader._queue_command(wrong)
            self.reader._queue_command(self.command)
            self.assertEqual(await self.reader.poll_commands(), [self.command])

    async def test_real_mqtt_command_and_core_ack_match_the_cse_receipt(self):
        self.config = replace(self.config, mqtt_enabled=True, core_bridge_enabled=True,
                              mqtt_host="127.0.0.1", mqtt_port=self.stack.broker.port)
        peer = CoreCommandPeer(replace(self.config, cert_file=self.pki.path("core"),
                                       key_file=self.pki.path("core", "key")))
        self.addAsyncCleanup(peer.close)
        await peer.start(self.config.mqtt_port)
        await self.exercise(revoke_before_connect=False, core_peer=peer)


if __name__ == "__main__":
    unittest.main()
