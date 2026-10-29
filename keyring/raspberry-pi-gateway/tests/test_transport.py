import asyncio
import hashlib
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx

from bubble_gateway.transport import RemoteResponseError, TransportHub
from helpers import config


class TransportMockTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        cfg = config()
        cfg.api_url, cfg.cse_url = "https://api.invalid", "https://cse.invalid"
        cfg.request_timeout, cfg.mqtt_wrapped_primitive = 0.02, True
        self.hub = TransportHub(cfg)  # Never start real sockets or load certificates.
        self.payload, self.rqi, self.container = {"synthetic": True}, "request-test", "/test/receipts"
        self.hub._http_json = AsyncMock(return_value=(201, httpx.Headers(
            {"X-M2M-RI": self.rqi, "X-M2M-RSC": "2001"}), {}))

    def mqtt(self, response=None):
        def publish(topic, payload, qos, retain):
            wire = json.loads(payload)["m2m:rqp"]
            self.assertEqual(wire["rqi"], self.rqi)
            if response is not None:
                self.hub._receive(dict(rqi=self.rqi, rsc=response))
            return SimpleNamespace(rc=0)  # Queued / PUBACK alone cannot settle content.
        self.hub._mqtt = SimpleNamespace(publish=Mock(side_effect=publish))
        self.hub._ready.set()

    async def test_mqtt_application_receipt_avoids_http(self):
        self.mqtt(2001)
        await self.hub.publish(self.rqi, self.container, self.payload)
        self.hub._http_json.assert_not_awaited()
        self.assertEqual(self.hub._pending, {})

    async def test_broker_acceptance_without_application_receipt_uses_same_cin_http(self):
        self.mqtt()
        await self.hub.publish(self.rqi, self.container, self.payload)
        self.hub._http_json.assert_awaited_once()
        _, kwargs = self.hub._http_json.call_args
        mqtt_cin = json.loads(self.hub._mqtt.publish.call_args.kwargs["payload"])["m2m:rqp"]["pc"]
        self.assertEqual(kwargs["body"], mqtt_cin)
        self.assertEqual(self.hub._pending, {})

    async def test_mqtt_application_denial_does_not_try_http(self):
        self.mqtt(4103)
        with self.assertRaises(RemoteResponseError):
            await self.hub.publish(self.rqi, self.container, self.payload)
        self.hub._http_json.assert_not_awaited()

    async def test_http_response_must_match_request_id(self):
        self.hub._http_json.return_value = (201, httpx.Headers(
            {"X-M2M-RI": "different", "X-M2M-RSC": "2001"}), {})
        with self.assertRaises(RemoteResponseError):
            await self.hub.publish(self.rqi, self.container, self.payload)

    async def test_conflict_requires_exact_existing_content(self):
        rn = "gw-" + hashlib.sha256(self.rqi.encode()).hexdigest()
        read_rqi = "read-" + hashlib.sha256(self.rqi.encode()).hexdigest()
        for existing, should_pass in ((self.payload, True), ({"synthetic": False}, False)):
            with self.subTest(existing=existing):
                self.hub._http_json.side_effect = [
                    (409, httpx.Headers({"X-M2M-RI": self.rqi, "X-M2M-RSC": "4105"}), {}),
                    (200, httpx.Headers({"X-M2M-RI": read_rqi, "X-M2M-RSC": "2000"}),
                     {"m2m:cin": {"rn": rn, "con": existing}}),
                ]
                if should_pass:
                    await self.hub.publish(self.rqi, self.container, self.payload)
                else:
                    with self.assertRaises(RemoteResponseError):
                        await self.hub.publish(self.rqi, self.container, self.payload)
