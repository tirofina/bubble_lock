import asyncio
import hashlib
import json
import unittest
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, call

import httpx

from bubble_gateway.model import iso_time, payload_hash, utc_now
from bubble_gateway.transport import RemoteResponseError, TransportHub, _mqtt_to
from helpers import command, config


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
            self.assertEqual(wire["to"], "test/receipts")
            if response is not None:
                self.hub._receive(dict(rqi=self.rqi, rsc=response))
            return SimpleNamespace(rc=0)  # Queued / PUBACK alone cannot settle content.
        self.hub._mqtt = SimpleNamespace(publish=Mock(side_effect=publish))
        self.hub._ready.set()

    def test_mqtt_to_reverses_http_identifier_scope_encoding(self):
        for path, expected in (("/Mobius/receipts", "Mobius/receipts"),
                               ("/~/Mobius4/Mobius/receipts", "/Mobius4/Mobius/receipts"),
                               ("/_/example.org/Mobius4/Mobius/receipts", "//example.org/Mobius4/Mobius/receipts")):
            with self.subTest(path=path):
                self.assertEqual(_mqtt_to(path), expected)
        for invalid in ("/", "/~/", "/_/", "//Mobius/receipts", "/Mobius/../receipts", "/Mobius/%2e%2e"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                _mqtt_to(invalid)

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

    async def test_full_core_queue_does_not_skip_central_poll(self):
        issued = [command(commandId=f"issued-{index}") for index in range(16)]
        for index in range(16):
            self.hub._queue_command(command(commandId=f"mqtt-{index}"))
        self.hub._api = AsyncMock(return_value={"commands": issued})

        self.assertEqual(await self.hub.poll_commands(), issued)
        self.hub._api.assert_awaited_once_with("GET", "/commands?limit=16")
        self.assertTrue(self.hub._commands.empty())

    async def test_http_issued_command_supersedes_earlier_core_copy(self):
        issued = command()
        self.hub._queue_command(dict(issued, desiredState={"state": False}))
        self.hub._queue_command(issued)
        self.hub._api = AsyncMock(return_value={"commands": [issued]})

        self.assertEqual(await self.hub.poll_commands(), [issued])
        self.hub._api.assert_awaited_once_with("GET", "/commands?limit=16")

    async def test_core_fallback_requires_exact_unexpired_central_approval(self):
        issued = command()
        altered = dict(issued, desiredState={"state": False})
        revoked = command(commandId="revoked")
        expired_approval = command(commandId="expired-approval")
        now = utc_now()
        expired = command(commandId="expired-command", issuedAt=iso_time(now - timedelta(seconds=2)),
                          deadline=iso_time(now - timedelta(seconds=1)))
        for candidate in (altered, revoked, expired, issued, issued, expired_approval):
            self.hub._queue_command(candidate)
        digest = payload_hash(issued)

        async def api(method, suffix, body=None, correlation_id=None):
            if method == "GET":
                raise RemoteResponseError("synthetic poll failure", status_code=503)
            response = dict(body, allowed=True, expiresAt=issued["deadline"])
            if body["commandId"] == issued["commandId"]:
                response["payloadHash"] = digest
            elif body["commandId"] == revoked["commandId"]:
                response["allowed"] = False
            elif body["commandId"] == expired_approval["commandId"]:
                response["expiresAt"] = expired["deadline"]
            return response

        self.hub._api = AsyncMock(side_effect=api)
        self.assertEqual(await self.hub.poll_commands(), [issued])
        self.assertEqual(self.hub._api.await_args_list[0], call("GET", "/commands?limit=16"))
        self.assertEqual([args.args[2]["payloadHash"] for args in self.hub._api.await_args_list[1:]],
                         [payload_hash(candidate) for candidate in (altered, revoked, issued, expired_approval)])

    async def test_unavailable_central_does_not_admit_core_copy(self):
        self.hub._queue_command(command())
        self.hub._api = AsyncMock(side_effect=TimeoutError)

        with self.assertRaises(TimeoutError):
            await self.hub.poll_commands()
        self.assertEqual(self.hub._api.await_count, 2)
