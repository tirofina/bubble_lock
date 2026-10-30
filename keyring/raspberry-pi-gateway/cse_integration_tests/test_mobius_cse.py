"""Real disposable Mobius4/PostgreSQL, not the synthetic protocol responder."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import unittest
import uuid

import httpx

from bubble_gateway.transport import TransportHub, RemoteResponseError
from helpers import config
from tls_fixture import TestPki
from mobius_fixture import DisposableMobius


class MobiusCseTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.pki = TestPki()
        try:
            cls.stack = DisposableMobius(cls.pki)
        except BaseException:
            cls.pki.close()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            cls.stack.close()
        finally:
            cls.pki.close()

    async def asyncSetUp(self):
        self.hub = await self.hub_for(mqtt=False)
        self.addCleanup(self.save_logs)
        await self.ready()
        self.parent = "/Mobius/cse-test-" + uuid.uuid4().hex[:12]
        rqi = "setup-" + uuid.uuid4().hex
        status, headers, _ = await self.hub._http_json("POST", self.stack.origin + "/Mobius",
            headers=self.hub._m2m_headers(rqi, create=True) | {"Content-Type": "application/json;ty=3"},
            body={"m2m:cnt": {"rn": self.parent.rsplit("/", 1)[1], "mni": 100}})
        self.assertEqual((status, self.hub._response_rsc(status, headers, rqi)), (201, 2001))

    async def hub_for(self, *, mqtt):
        cfg = config()
        cfg.originator, cfg.cse_id, cfg.rvi = self.stack.admin, self.stack.cse_id, "4"
        cfg.api_url = cfg.cse_url = self.stack.origin
        cfg.ca_file, cfg.cert_file, cfg.key_file = self.pki.path("trusted"), self.pki.path("client"), self.pki.path("client", "key")
        cfg.mqtt_enabled, cfg.core_bridge_enabled, cfg.mqtt_wrapped_primitive = mqtt, False, False
        cfg.mqtt_host, cfg.mqtt_port, cfg.mqtt_keepalive, cfg.request_timeout = "127.0.0.1", self.stack.broker.port, 10, 3
        hub = TransportHub(cfg)
        self.addAsyncCleanup(hub.close)
        await hub.start()
        if mqtt:
            await asyncio.wait_for(hub._ready.wait(), 5)
        return hub

    async def ready(self):
        async with asyncio.timeout(30):
            while True:
                try:
                    rqi = "ready-" + uuid.uuid4().hex
                    status, headers, _ = await self.hub._http_json("GET", self.stack.origin + "/Mobius",
                                                               headers=self.hub._m2m_headers(rqi))
                    if status == 200 and self.hub._response_rsc(status, headers, rqi) == 2000:
                        return
                except (httpx.TransportError, RemoteResponseError):
                    pass
                await asyncio.sleep(0.2)

    async def stored(self, rqi):
        rn = "gw-" + hashlib.sha256(rqi.encode()).hexdigest()
        read_rqi = "check-" + uuid.uuid4().hex
        status, headers, body = await self.hub._http_json("GET", self.stack.origin + self.parent + "/" + rn,
                                                       headers=self.hub._m2m_headers(read_rqi))
        self.assertEqual((status, self.hub._response_rsc(status, headers, read_rqi)), (200, 2000))
        return body["m2m:cin"]

    async def count(self):
        rqi = "count-" + uuid.uuid4().hex
        status, headers, body = await self.hub._http_json("GET", self.stack.origin + self.parent,
                                                       headers=self.hub._m2m_headers(rqi))
        self.assertEqual((status, self.hub._response_rsc(status, headers, rqi)), (200, 2000))
        return body["m2m:cnt"]["cni"]

    def save_logs(self):
        output = os.environ.get("KEYRING_TEST_CSE_LOG_DIR")
        if output:
            root = Path(output) / self._testMethodName
            root.mkdir(parents=True, exist_ok=True)
            for name in self.stack.containers:
                (root / (name + ".log")).write_text(self.stack.logs(name), encoding="utf-8")
            (root / "broker.log").write_text(self.stack.broker.logs(), encoding="utf-8")

    async def test_https_publish_is_stored_and_read_back_from_real_cse(self):
        rqi, payload = "https-" + uuid.uuid4().hex, {"synthetic": True, "label": "키링", "sequence": 1}
        await self.hub.publish(rqi, self.parent, payload)
        self.assertEqual((await self.stored(rqi))["con"], payload)
        self.assertEqual(await self.count(), 1)

    async def test_mqtt_application_receipt_and_storage_without_https_post(self):
        hub = await self.hub_for(mqtt=True)
        paths = (self.parent, "/~/Mobius4" + self.parent, "/_/localhost/Mobius4" + self.parent)
        for index, path in enumerate(paths):
            with self.subTest(path=path):
                rqi, payload = "mqtt-" + uuid.uuid4().hex, {"synthetic": True, "sequence": index}
                await hub.publish(rqi, path, payload)
                self.assertEqual((await self.stored(rqi))["con"], payload)
                logs = await asyncio.to_thread(self.stack.logs, "proxy")
                self.assertNotIn("POST " + path + " " + rqi, logs)
        self.assertEqual(await self.count(), 3)

    async def test_duplicate_request_reuses_single_cin(self):
        rqi, payload = "duplicate-" + uuid.uuid4().hex, {"synthetic": True, "value": 3}
        await self.hub.publish(rqi, self.parent, payload)
        await self.hub.publish(rqi, self.parent, payload)
        self.assertEqual((await self.stored(rqi))["con"], payload)
        self.assertEqual(await self.count(), 1)

    async def test_same_rqi_different_payload_is_rejected_and_original_preserved(self):
        rqi, original = "conflict-" + uuid.uuid4().hex, {"synthetic": True, "value": 4}
        await self.hub.publish(rqi, self.parent, original)
        with self.assertRaises(RemoteResponseError) as caught:
            await self.hub.publish(rqi, self.parent, {"synthetic": True, "value": 5})
        self.assertEqual(caught.exception.rsc, 4105)
        self.assertEqual((await self.stored(rqi))["con"], original)
        self.assertEqual(await self.count(), 1)

    async def test_cse_process_restart_preserves_committed_cin(self):
        rqi, payload = "restart-" + uuid.uuid4().hex, {"synthetic": True, "value": 6}
        await self.hub.publish(rqi, self.parent, payload)
        await asyncio.to_thread(self.stack.restart_cse)
        await self.ready()
        self.assertEqual((await self.stored(rqi))["con"], payload)
        self.assertEqual(await self.count(), 1)
