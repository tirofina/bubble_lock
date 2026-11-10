import asyncio
import hashlib
import json
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, call, patch

import httpx

from bubble_gateway.core_bridge import telemetry
from bubble_gateway.model import iso_time, payload_hash, utc_now
from bubble_gateway.transport import (MAX_RETRY_AFTER_SECONDS, HttpRetryDeferred, ReceiptParentMismatch,
                                      RemoteResponseError, TransportHub, _mqtt_to, _retry_after)
from helpers import command, config, observation


class HttpRetryAfterTests(unittest.IsolatedAsyncioTestCase):
    def test_retry_after_parses_seconds_and_http_date(self):
        now = datetime(2026, 11, 11, tzinfo=timezone.utc)
        with patch("bubble_gateway.transport.utc_now", return_value=now):
            self.assertEqual(_retry_after("00030"), 30)
            self.assertEqual(_retry_after(format_datetime(now + timedelta(seconds=45), usegmt=True)), 45)
            self.assertEqual(_retry_after(format_datetime(now - timedelta(seconds=1), usegmt=True)), 0)
            self.assertEqual(_retry_after("9" * 40), MAX_RETRY_AFTER_SECONDS)
            self.assertIsNone(_retry_after("unavailable"))
            self.assertIsNone(_retry_after(None))

    async def test_cse_delay_applies_to_other_paths_without_blocking_the_team_api(self):
        cfg = config()
        cfg.api_url, cfg.cse_url = "https://api.invalid", "https://cse.invalid"
        cfg.request_timeout = 1
        hub = TransportHub(cfg)
        requests = []

        def respond(request):
            requests.append(request)
            if request.url.host == "api.invalid":
                return httpx.Response(200, json={"status": "ACTIVE"})
            if len(requests) == 1:
                return httpx.Response(503, headers={"Retry-After": "45"}, text="proxy unavailable")
            return httpx.Response(201, headers={"X-M2M-RI": request.headers["X-M2M-RI"], "X-M2M-RSC": "2001"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            hub._http = client
            with patch("bubble_gateway.transport.monotonic", return_value=100.0) as clock:
                with self.assertRaises(HttpRetryDeferred) as initial:
                    await hub.publish("request-test", "/test/receipts", {"synthetic": True})
                self.assertEqual((initial.exception.status_code, initial.exception.retry_after), (503, 45))

                clock.return_value = 120.0
                with self.assertRaises(HttpRetryDeferred) as gated:
                    await hub.read_content("different-request", "/test/observations")
                self.assertEqual(gated.exception.retry_after, 25)
                self.assertEqual(await hub.credential_status(), {"status": "ACTIVE"})

                clock.return_value = 145.0
                await hub.publish("request-test", "/test/receipts", {"synthetic": True})

        self.assertEqual([request.url.host for request in requests], ["cse.invalid", "api.invalid", "cse.invalid"])
        self.assertEqual(requests[0].headers["X-M2M-RI"], requests[-1].headers["X-M2M-RI"])
        self.assertEqual(requests[0].content, requests[-1].content)


class TransportMockTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        cfg = config()
        cfg.api_url, cfg.cse_url = "https://api.invalid", "https://cse.invalid"
        cfg.request_timeout, cfg.mqtt_wrapped_primitive = 0.02, True
        self.hub = TransportHub(cfg)  # Never start real sockets or load certificates.
        self.payload, self.rqi, self.container = {"synthetic": True}, "request-test", "/test/receipts"
        self.hub._http_json = AsyncMock(return_value=(201, httpx.Headers(
            {"X-M2M-RI": self.rqi, "X-M2M-RSC": "2001"}), {}))

    def mqtt(self, response=None, *, target="test/receipts", confirmation_parent=None):
        def publish(topic, payload, qos, retain):
            wire = json.loads(payload)["m2m:rqp"]
            self.assertEqual(wire["rqi"], self.rqi)
            self.assertEqual(wire["to"], target)
            if response is not None:
                received = dict(rqi=self.rqi, rsc=response)
                if confirmation_parent is not None:
                    received["pc"] = {"m2m:cin": {"pi": confirmation_parent}}
                self.hub._receive(received)
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

    def pin_receipt_container(self, observed_ri):
        self.hub.config.receipt_container_ri = "cnt-original"

        async def exchange(method, _url, *, headers, body=None):
            response = httpx.Headers({"X-M2M-RI": headers["X-M2M-RI"]})
            if method == "GET":
                response["X-M2M-RSC"] = "2000"
                return 200, response, {"m2m:cnt": {"ty": 3, "ri": observed_ri}}
            response["X-M2M-RSC"] = "2001"
            return 201, response, {"m2m:cin": {"pi": "cnt-original"}}

        self.hub._http_json.side_effect = exchange

    async def test_pin_blocks_create_when_named_container_is_recreated(self):
        self.pin_receipt_container("cnt-recreated")
        self.mqtt(2001)
        with self.assertRaises(ReceiptParentMismatch):
            await self.hub.publish(self.rqi, self.container, self.payload)
        self.hub._mqtt.publish.assert_not_called()
        self.assertEqual([entry.args for entry in self.hub._http_json.await_args_list],
                         [("GET", "https://cse.invalid/test/receipts")])

    async def test_pin_uses_same_native_target_on_mqtt_timeout_and_https_fallback(self):
        self.pin_receipt_container("cnt-original")
        self.mqtt(target="cnt-original")
        await self.hub.publish(self.rqi, self.container, self.payload)
        self.assertEqual([entry.args for entry in self.hub._http_json.await_args_list],
                         [("GET", "https://cse.invalid/test/receipts"), ("POST", "https://cse.invalid/cnt-original")])

    async def test_pin_requires_mqtt_confirmation_from_the_expected_parent(self):
        self.pin_receipt_container("cnt-original")
        self.mqtt(2001, target="cnt-original", confirmation_parent="cnt-recreated")
        with self.assertRaises(ReceiptParentMismatch):
            await self.hub.publish(self.rqi, self.container, self.payload)
        self.hub._http_json.assert_awaited_once()

    async def test_scoped_core_requires_the_matching_application_receipt(self):
        self.hub.config.core_telemetry_epochs = {"kr-test": 7}
        self.hub.config.request_timeout = 1
        self.hub._loop = asyncio.get_running_loop()
        self.hub._mqtt = SimpleNamespace(publish=Mock(return_value=SimpleNamespace(rc=0)))
        self.hub._ready.set()
        projection = {**telemetry(observation(), 12), "ownershipEpoch": 7}
        send = asyncio.create_task(self.hub.publish("scoped", "@core/telemetry", projection))
        await asyncio.sleep(0)
        args, kwargs = self.hub._mqtt.publish.call_args
        self.assertEqual(args[0], "privacy-bubble/gateway/gw-test/telemetry-epoch/kr-test/7")
        self.assertNotIn("ownershipEpoch", json.loads(kwargs["payload"]))
        digest = hashlib.sha256(kwargs["payload"]).hexdigest()
        receipt = dict(version=1, gatewayId="gw-test", deviceId="kr-test", ownershipEpoch=7,
                       sequence=12, payloadHash=digest, cseRequestId="kr-" + "a" * 48, responseStatus=2004)
        topic = "privacy-bubble/gateway/gw-test/telemetry-result/kr-test/7"

        def receive(data, *, from_topic=topic, retain=False):
            self.hub._on_message(None, None, SimpleNamespace(
                topic=from_topic, payload=json.dumps(data).encode(), retain=retain))

        receive({**receipt, "payloadHash": "0" * 64})
        receive(receipt, from_topic=topic[:-1] + "8")
        receive(receipt, retain=True)
        await asyncio.sleep(0)
        self.assertFalse(send.done())
        receive(receipt)
        await send
        self.assertEqual(self.hub._core_pending, {})

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
