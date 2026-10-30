"""Opt-in: real cached Mosquitto, TLS/mTLS, topic ACL and synthetic oneM2M peer."""
import asyncio
import json
from pathlib import Path
import unittest

from bubble_gateway.transport import RemoteResponseError, TransportHub
from helpers import config
from tls_fixture import TestPki, LoopbackTlsServer
from mqtt_fixture import DockerBroker, ProtocolResponder, REQUEST


class MqttWireTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.pki = TestPki()
        try:
            cls.pki.leaf("cse", "trusted", 6, "clientAuth", subject="cse-test")
        except BaseException:
            cls.pki.close()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.pki.close()

    async def asyncSetUp(self):
        self.broker = await asyncio.to_thread(DockerBroker, self.pki)
        self.addCleanup(self.broker.close)
        self.http = LoopbackTlsServer(self.pki)
        self.addCleanup(self.http.close)
        self.responder = ProtocolResponder(self.pki, asyncio.get_running_loop())
        self.addAsyncCleanup(self.responder.close)
        await self.responder.start(self.broker.port)
        cfg = config()
        cfg.api_url = cfg.cse_url = self.http.origin
        cfg.ca_file, cfg.cert_file, cfg.key_file = self.pki.path("trusted"), self.pki.path("client"), self.pki.path("client", "key")
        cfg.mqtt_enabled, cfg.core_bridge_enabled, cfg.mqtt_wrapped_primitive = True, False, False
        cfg.mqtt_host, cfg.mqtt_port, cfg.mqtt_keepalive, cfg.request_timeout = "127.0.0.1", self.broker.port, 10, 1
        self.hub = TransportHub(cfg)
        self.addAsyncCleanup(self.hub.close)
        await self.hub.start()
        await asyncio.wait_for(self.hub._ready.wait(), 5)
        self.assertEqual(self.hub._mqtt.socket().version(), "TLSv1.3")
        self.addCleanup(self.save_broker_log)

    def save_broker_log(self):
        # Optional log output lives outside Git; never archive mounted private PKI.
        import os
        output = os.environ.get("KEYRING_TEST_MQTT_LOG_DIR")
        if output:
            path = Path(output)
            path.mkdir(parents=True, exist_ok=True)
            (path / (self._testMethodName + ".log")).write_text(self.broker.logs(), encoding="utf-8")

    async def test_mqtt_tls_application_receipt_completes_without_https(self):
        await self.hub.publish("mqtt-success", "/test/receipts", {"synthetic": True})
        self.assertEqual(len(self.responder.requests), 1)
        row = self.responder.requests[0]
        self.assertEqual(row["topic"], REQUEST)
        self.assertEqual((row["request"]["op"], row["request"]["ty"], row["request"]["fr"]), (1, 4, "Ctest"))
        self.assertEqual(row["request"]["pc"]["m2m:cin"]["con"], {"synthetic": True})
        self.assertEqual(self.http.records, [])
        self.assertEqual(self.hub._pending, {})
        print("MQTT wire evidence: real Mosquitto, MQTTv3.1.1/TLSv1.3, mTLS identity ACL, matching rqi/rsc2001", flush=True)

    async def test_puback_without_application_response_falls_back_with_same_cin(self):
        self.responder.rsc = None
        puback = asyncio.Event()
        loop = asyncio.get_running_loop()
        self.hub._mqtt.on_publish = lambda *_: loop.call_soon_threadsafe(puback.set)
        await self.hub.publish("mqtt-puback-only", "/test/receipts", {"synthetic": True})
        await asyncio.wait_for(puback.wait(), 2)
        self.assertEqual(len(self.responder.requests), 1)
        self.assertEqual(len(self.http.records), 1)
        self.assertEqual(self.http.records[0]["body"], self.responder.requests[0]["request"]["pc"])
        self.assertEqual(self.hub._pending, {})

    async def test_wrong_response_rqi_cannot_settle_mqtt_request(self):
        self.responder.wrong_rqi = True
        await self.hub.publish("mqtt-wrong-rqi", "/test/receipts", {})
        self.assertEqual(len(self.responder.requests), 1)
        self.assertEqual(len(self.http.records), 1)
        self.assertEqual(self.http.records[0]["body"], self.responder.requests[0]["request"]["pc"])

    async def test_application_denial_does_not_bypass_through_https(self):
        self.responder.rsc = 4103
        with self.assertRaises(RemoteResponseError) as caught:
            await self.hub.publish("mqtt-denied", "/test/receipts", {})
        self.assertEqual(caught.exception.rsc, 4103)
        self.assertEqual(self.http.records, [])
        self.assertEqual(self.hub._pending, {})

    async def test_certificate_identity_acl_denies_other_originator_topic(self):
        forbidden = "/oneM2M/req/Other/test-cse/json"
        info = self.hub._mqtt.publish(forbidden, json.dumps({"rqi": "forbidden-test"}), qos=1)
        await asyncio.to_thread(info.wait_for_publish, timeout=2)
        self.assertTrue(info.is_published())  # PUBACK can exist even when application data is denied.
        logs = await asyncio.to_thread(self.broker.logs)
        self.assertIn("Denied PUBLISH", logs)
        self.assertIn(forbidden, logs)
        self.assertEqual(self.responder.requests, [])

    async def test_broker_disconnect_fails_pending_and_uses_https(self):
        self.responder.rsc = None
        self.hub.config.request_timeout = 10  # Broker loss, rather than the ordinary response timeout, must end MQTT.
        pending = asyncio.create_task(self.hub.publish("mqtt-disconnected", "/test/receipts", {}))
        self.addAsyncCleanup(self.cancel_publish, pending)
        await asyncio.wait_for(self.responder.seen.wait(), 2)
        mqtt_response = self.hub._pending["mqtt-disconnected"]
        await asyncio.to_thread(self.broker.stop)
        await asyncio.wait_for(pending, 3)
        self.assertFalse(mqtt_response.cancelled())
        self.assertIsInstance(mqtt_response.exception(), ConnectionError)
        self.assertEqual(len(self.http.records), 1)
        self.assertEqual(self.hub._pending, {})

    @staticmethod
    async def cancel_publish(task):
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
