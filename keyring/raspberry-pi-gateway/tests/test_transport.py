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
from bubble_gateway.transport import (MAX_RETRY_AFTER_SECONDS, HttpRetryDeferred, NativeDeliveryHold, ReceiptParentMismatch,
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
                self.assertEqual(hub.native_delivery_hold(), NativeDeliveryHold(all_native=True))

                clock.return_value = 120.0
                with self.assertRaises(HttpRetryDeferred) as gated:
                    await hub.read_content("different-request", "/test/observations")
                self.assertEqual(gated.exception.retry_after, 25)
                self.assertEqual(await hub.credential_status(), {"status": "ACTIVE"})

                hub._mqtt = SimpleNamespace()
                hub._ready.set()
                self.assertEqual(hub.native_delivery_hold(), NativeDeliveryHold(credential_receipts=True))
                with self.assertRaises(HttpRetryDeferred):
                    await hub.publish("transition-request", cfg.health_container, {"credentialTransition": {"sequence": 1}})
                cfg.receipt_container_ri = "cnt-pinned"
                self.assertEqual(hub.native_delivery_hold(), NativeDeliveryHold(
                    receipt_container=cfg.receipt_container, credential_receipts=True))
                cfg.observation_container_ri = "cnt-observation"
                self.assertEqual(hub.native_delivery_hold(), NativeDeliveryHold(
                    receipt_container=cfg.receipt_container, credential_receipts=True,
                    observation_container=cfg.observation_container))
                hub._mqtt = None
                cfg.receipt_container_ri = None
                cfg.observation_container_ri = None

                clock.return_value = 145.0
                self.assertEqual(hub.native_delivery_hold(), NativeDeliveryHold())
                await hub.publish("request-test", "/test/receipts", {"synthetic": True})

        self.assertEqual([request.url.host for request in requests], ["cse.invalid", "api.invalid", "cse.invalid"])
        self.assertEqual(requests[0].headers["X-M2M-RI"], requests[-1].headers["X-M2M-RI"])
        self.assertEqual(requests[0].content, requests[-1].content)

    async def test_team_api_delay_leaves_the_distinct_cse_origin_available(self):
        cfg = config()
        cfg.api_url, cfg.cse_url = "https://api.invalid", "https://cse.invalid"
        hub = TransportHub(cfg)
        hosts = []

        def respond(request):
            hosts.append(request.url.host)
            if request.url.host == "cse.invalid":
                return httpx.Response(201, headers={"X-M2M-RI": request.headers["X-M2M-RI"], "X-M2M-RSC": "2001"})
            if len(hosts) == 1:
                return httpx.Response(429, headers={"Retry-After": "30"})
            return httpx.Response(200, json={"status": "ACTIVE"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            hub._http = client
            with patch("bubble_gateway.transport.monotonic", return_value=100.0) as clock:
                with self.assertRaises(HttpRetryDeferred):
                    await hub.credential_status()
                self.assertTrue(hub.central_delivery_held())
                self.assertEqual(hub.native_delivery_hold(), NativeDeliveryHold())
                await hub.publish("native-request", "/test/observations", {"synthetic": True})
                clock.return_value = 130.0
                self.assertFalse(hub.central_delivery_held())
                self.assertEqual(await hub.credential_status(), {"status": "ACTIVE"})
        self.assertEqual(hosts, ["api.invalid", "cse.invalid", "api.invalid"])


class TransportMockTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        cfg = config()
        cfg.api_url, cfg.cse_url = "https://api.invalid", "https://cse.invalid"
        cfg.request_timeout, cfg.mqtt_wrapped_primitive = 0.02, True
        self.hub = TransportHub(cfg)  # Never start real sockets or load certificates.
        self.payload, self.rqi, self.container = {"synthetic": True}, "request-test", "/test/receipts"
        self.rn = "gw-" + hashlib.sha256(self.rqi.encode()).hexdigest()
        self.hub._http_json = AsyncMock(return_value=(201, httpx.Headers(
            {"X-M2M-RI": self.rqi, "X-M2M-RSC": "2001"}), {}))

    def pinned_cin(self, parent="cnt-original"):
        return {"ty": 4, "ri": "cin-original", "pi": parent, "rn": self.rn, "con": self.payload}

    def mqtt(self, response=None, *, target="test/receipts", confirmation_parent=None):
        def publish(topic, payload, qos, retain):
            wire = json.loads(payload)["m2m:rqp"]
            self.assertEqual(wire["rqi"], self.rqi)
            self.assertEqual(wire["to"], target)
            if response is not None:
                received = dict(rqi=self.rqi, rsc=response)
                if confirmation_parent is not None:
                    received["pc"] = {"m2m:cin": self.pinned_cin(confirmation_parent)}
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

    def pin_container(self, observed_ri, *, readback_changes=None, readback_error=None, observation=False):
        if observation:
            self.container = self.hub.config.observation_container
            self.hub.config.observation_container_ri = "cnt-original"
        else:
            self.hub.config.receipt_container_ri = "cnt-original"

        async def exchange(method, url, *, headers, body=None):
            response = httpx.Headers({"X-M2M-RI": headers["X-M2M-RI"]})
            if method == "GET":
                response["X-M2M-RSC"] = "2000"
                if url.endswith(self.container):
                    return 200, response, {"m2m:cnt": {"ty": 3, "ri": observed_ri}}
                self.assertTrue(url.endswith(self.container + "/" + self.rn))
                if readback_error is not None:
                    raise readback_error
                return 200, response, {"m2m:cin": self.pinned_cin() | (readback_changes or {})}
            response["X-M2M-RSC"] = "2001"
            return 201, response, {"m2m:cin": self.pinned_cin()}

        self.hub._http_json.side_effect = exchange

    def pin_receipt_container(self, observed_ri, **options):
        self.pin_container(observed_ri, **options)

    async def test_observation_pin_blocks_create_on_recreated_container(self):
        self.pin_container("cnt-recreated", observation=True)
        self.mqtt(2001)
        with self.assertRaises(ReceiptParentMismatch):
            await self.hub.publish(self.rqi, self.container, self.payload)
        self.hub._mqtt.publish.assert_not_called()
        self.assertEqual([entry.args for entry in self.hub._http_json.await_args_list],
                         [("GET", "https://cse.invalid/test/observations")])

    async def test_observation_pin_uses_pinned_target_and_confirms_readback(self):
        self.pin_container("cnt-original", observation=True)
        self.mqtt(target="cnt-original")
        await self.hub.publish(self.rqi, self.container, self.payload)
        self.assertEqual([entry.args for entry in self.hub._http_json.await_args_list],
                         [("GET", "https://cse.invalid/test/observations"), ("POST", "https://cse.invalid/cnt-original"),
                          ("GET", "https://cse.invalid/test/observations/" + self.rn)])

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
                         [("GET", "https://cse.invalid/test/receipts"), ("POST", "https://cse.invalid/cnt-original"),
                          ("GET", "https://cse.invalid/test/receipts/" + self.rn)])

    async def test_pin_requires_mqtt_confirmation_from_the_expected_parent(self):
        self.pin_receipt_container("cnt-original")
        self.mqtt(2001, target="cnt-original", confirmation_parent="cnt-recreated")
        with self.assertRaises(ReceiptParentMismatch):
            await self.hub.publish(self.rqi, self.container, self.payload)
        self.hub._http_json.assert_awaited_once()

    async def test_pinned_create_requires_matching_stored_identity_and_body(self):
        for changes, error in (({"ri": "cin-replaced"}, "resource ID differs"),
                               ({"con": {"synthetic": False}}, "different content")):
            with self.subTest(changes=changes):
                self.pin_receipt_container("cnt-original", readback_changes=changes)
                with self.assertRaisesRegex(RemoteResponseError, error):
                    await self.hub.publish(self.rqi, self.container, self.payload)

    async def test_pinned_mqtt_create_with_readback_timeout_does_not_post_again(self):
        self.pin_receipt_container("cnt-original", readback_error=TimeoutError())
        self.mqtt(2001, target="cnt-original", confirmation_parent="cnt-original")
        with self.assertRaises(TimeoutError):
            await self.hub.publish(self.rqi, self.container, self.payload)
        self.assertEqual([entry.args for entry in self.hub._http_json.await_args_list],
                         [("GET", "https://cse.invalid/test/receipts"),
                          ("GET", "https://cse.invalid/test/receipts/" + self.rn)])
        self.assertEqual(self.hub._pending, {})

    async def test_pinned_retry_confirms_existing_instance_without_create(self):
        self.pin_receipt_container("cnt-original")
        self.mqtt(target="cnt-original")
        await self.hub.publish(self.rqi, self.container, self.payload, confirm_existing=True)
        self.assertEqual([entry.args for entry in self.hub._http_json.await_args_list],
                         [("GET", "https://cse.invalid/test/receipts"),
                          ("GET", "https://cse.invalid/test/receipts/" + self.rn)])
        self.hub._mqtt.publish.assert_not_called()

    async def test_pinned_retry_creates_only_after_authenticated_not_found(self):
        self.pin_receipt_container("cnt-original")
        exchange = self.hub._http_json.side_effect
        missing = True

        async def missing_once(method, url, *, headers, body=None):
            nonlocal missing
            if missing and method == "GET" and url.endswith("/" + self.rn):
                missing = False
                return 404, httpx.Headers({"X-M2M-RI": headers["X-M2M-RI"], "X-M2M-RSC": "4004"}), {}
            return await exchange(method, url, headers=headers, body=body)

        self.hub._http_json.side_effect = missing_once
        await self.hub.publish(self.rqi, self.container, self.payload, confirm_existing=True)
        self.assertEqual([entry.args for entry in self.hub._http_json.await_args_list],
                         [("GET", "https://cse.invalid/test/receipts"),
                          ("GET", "https://cse.invalid/test/receipts/" + self.rn),
                          ("POST", "https://cse.invalid/cnt-original"),
                          ("GET", "https://cse.invalid/test/receipts/" + self.rn)])
        create = self.hub._http_json.await_args_list[2].kwargs
        self.assertEqual(create["headers"]["X-M2M-RI"], self.rqi)
        self.assertEqual(create["body"]["m2m:cin"]["rn"], self.rn)

    async def test_pinned_retry_keeps_receipt_queued_if_lookup_cannot_establish_absence(self):
        for changes, lookup_error in (
            ({"con": {"synthetic": False}}, None),
            ({"pi": "cnt-recreated"}, None),
            (None, RemoteResponseError("permission denied", 4103, 403)),
            (None, RemoteResponseError("wrong oneM2M code", 4103, 404)),
        ):
            with self.subTest(changes=changes, lookup_error=lookup_error):
                self.hub._http_json.reset_mock()
                self.pin_receipt_container("cnt-original", readback_changes=changes, readback_error=lookup_error)
                with self.assertRaises(RemoteResponseError):
                    await self.hub.publish(self.rqi, self.container, self.payload, confirm_existing=True)
                self.assertEqual([entry.args[0] for entry in self.hub._http_json.await_args_list], ["GET", "GET"])

    def credential_exchange(self, *, readback_changes=None, readback_error=None):
        self.container = self.hub.config.health_container
        self.payload = {"credentialTransition": {"sequence": 1, "previous": None,
                                                "current": {"status": "LOST", "credentialRevision": "rev-2"}}}

        async def exchange(method, url, *, headers, body=None):
            rsc = "2000" if method == "GET" else "2001"
            response = httpx.Headers({"X-M2M-RI": headers["X-M2M-RI"], "X-M2M-RSC": rsc})
            if method == "POST":
                return 201, response, {}  # Some CREATE responses do not include an instance.
            self.assertEqual(url, "https://cse.invalid" + self.container + "/" + self.rn)
            if readback_error is not None:
                raise readback_error
            return 200, response, {"m2m:cin": self.pinned_cin() | (readback_changes or {})}

        self.hub._http_json.side_effect = exchange

    async def test_credential_https_create_without_representation_requires_readback(self):
        self.credential_exchange()
        await self.hub.publish(self.rqi, self.container, self.payload)
        self.assertEqual([entry.args[0] for entry in self.hub._http_json.await_args_list], ["POST", "GET"])

    async def test_credential_mqtt_create_and_duplicate_confirm_existing_instance(self):
        self.credential_exchange()
        for code in (2001, 4105):
            self.mqtt(code, target="test/health", confirmation_parent="cnt-original" if code == 2001 else None)
            await self.hub.publish(self.rqi, self.container, self.payload)
        self.assertEqual([entry.args[0] for entry in self.hub._http_json.await_args_list], ["GET", "GET"])

    async def test_credential_mqtt_create_rejects_changed_identity_or_body(self):
        for changes, error in (({"ri": "cin-replaced"}, "resource ID differs"),
                               ({"pi": "cnt-replaced"}, "parent differs"),
                               ({"ty": 3}, "identity mismatch"),
                               ({"con": {"synthetic": False}}, "different content")):
            with self.subTest(changes=changes):
                self.credential_exchange(readback_changes=changes)
                self.mqtt(2001, target="test/health", confirmation_parent="cnt-original")
                with self.assertRaisesRegex(RemoteResponseError, error):
                    await self.hub.publish(self.rqi, self.container, self.payload)

    async def test_credential_mqtt_create_does_not_repost_after_readback_failure(self):
        self.credential_exchange(readback_error=TimeoutError())
        self.mqtt(2001, target="test/health", confirmation_parent="cnt-original")
        with self.assertRaises(TimeoutError):
            await self.hub.publish(self.rqi, self.container, self.payload)
        self.hub._http_json.assert_awaited_once()
        self.assertEqual(self.hub._http_json.await_args.args[0], "GET")
        self.assertEqual(self.hub._pending, {})

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

    async def test_dispatch_start_posts_same_command_binding_as_authorize(self):
        cmd = command()
        digest = payload_hash(cmd)
        self.hub._api = AsyncMock(return_value={"allowed": True})
        await self.hub.authorize(cmd, digest)
        await self.hub.dispatch_start(cmd, digest)
        body = {key: cmd[key] for key in ("commandId", "deviceId", "claimId", "grantRevision", "ownershipEpoch")}
        body["payloadHash"] = digest
        self.assertEqual(self.hub._api.await_args_list,
                         [call("POST", "/authorize", body, cmd["commandId"]),
                          call("POST", "/dispatch-start", body, cmd["commandId"])])

    async def test_central_receipt_retries_with_stable_key_and_exact_binding(self):
        self.hub.config.central_receipts_enabled = True
        cmd = command()
        receipt = {"commandId": cmd["commandId"], "status": "APPLIED"}
        confirmation = {"status": "ACCEPTED", "commandId": cmd["commandId"],
                        "claimId": cmd["claimId"], "receiptHash": payload_hash(receipt)}
        for status in ("ACCEPTED", "DUPLICATE"):
            with self.subTest(status=status):
                self.hub._http_json.return_value = (200, httpx.Headers(), dict(confirmation, status=status))
                result = await self.hub.publish(self.rqi, "@central/receipt", receipt, expected_claim_id=cmd["claimId"])
                self.assertEqual(result["status"], status)
                exchange = self.hub._http_json.await_args
                self.assertEqual(exchange.args, ("POST", "https://api.invalid/api/v1/gateways/gw-test/receipts"))
                self.assertEqual(exchange.kwargs["headers"]["Idempotency-Key"], self.rqi)
                self.assertEqual(exchange.kwargs["headers"]["X-Correlation-ID"], self.rqi)
                self.assertEqual(exchange.kwargs["body"], receipt)
        for key in ("status", "commandId", "claimId", "receiptHash"):
            with self.subTest(mismatch=key):
                self.hub._http_json.return_value = (200, httpx.Headers(), dict(confirmation, **{key: "wrong"}))
                with self.assertRaises(RemoteResponseError):
                    await self.hub.publish(self.rqi, "@central/receipt", receipt, expected_claim_id=cmd["claimId"])

    async def test_central_telemetry_requires_the_bound_observation_id(self):
        self.hub.config.central_telemetry_enabled = True
        payload = observation(bootId="boot-test-2", sequence=0)
        identity = {"gatewayId": "gw-test", "deviceId": "kr-test", "bootId": "boot-test-2", "sequence": 0}
        response = {"status": "ACCEPTED", "deviceId": "kr-test", "observationId": payload_hash(identity)}
        for status in ("ACCEPTED", "DUPLICATE", "STALE"):
            with self.subTest(status=status):
                self.hub._http_json.return_value = (200, httpx.Headers(), dict(response, status=status))
                result = await self.hub.publish(self.rqi, "@central/telemetry", payload)
                self.assertEqual(result["status"], status)
                exchange = self.hub._http_json.await_args
                self.assertEqual(exchange.args, ("POST", "https://api.invalid/api/v1/gateways/gw-test/telemetry"))
                self.assertEqual(exchange.kwargs["headers"]["Idempotency-Key"], self.rqi)
                self.assertEqual(exchange.kwargs["body"], payload)
        for key in ("status", "deviceId", "observationId"):
            with self.subTest(mismatch=key):
                self.hub._http_json.return_value = (200, httpx.Headers(), dict(response, **{key: "wrong"}))
                with self.assertRaises(RemoteResponseError):
                    await self.hub.publish(self.rqi, "@central/telemetry", payload)

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
