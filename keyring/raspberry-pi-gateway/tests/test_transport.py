import asyncio
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, call, patch

import httpx

from bubble_gateway.config import GatewayConfig
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
                hub._mqtt = None
                cfg.receipt_container_ri = None

                clock.return_value = 145.0
                self.assertEqual(hub.native_delivery_hold(), NativeDeliveryHold())
                await hub.publish("request-test", "/test/receipts", {"synthetic": True})

        self.assertEqual([request.url.host for request in requests], ["cse.invalid", "api.invalid", "cse.invalid"])
        self.assertEqual(requests[0].headers["X-M2M-RI"], requests[-1].headers["X-M2M-RI"])
        self.assertEqual(requests[0].content, requests[-1].content)


class ProtocolSelectionTests(unittest.IsolatedAsyncioTestCase):
    """Native oneM2M binding chosen from broker state, frame size and CSE answers."""

    def setUp(self):
        cfg = config()
        cfg.api_url, cfg.cse_url = "https://api.invalid", "https://cse.invalid"
        cfg.request_timeout, cfg.mqtt_wrapped_primitive = 0.02, False
        cfg.mqtt_max_payload_bytes, cfg.mqtt_probe_interval_seconds = 700, 5.0
        self.hub = TransportHub(cfg)
        self.posts = []

        async def http(method, url, *, headers, body=None):
            self.posts.append((method, body["m2m:cin"]["rn"] if body else None))
            return 201, httpx.Headers({"X-M2M-RI": headers["X-M2M-RI"], "X-M2M-RSC": "2001"}), {}

        self.hub._http_json = AsyncMock(side_effect=http)
        self.answer_create, self.answer_probe = True, True
        self.wire = []

        def publish(topic, payload, qos, retain):
            primitive = json.loads(payload)
            self.wire.append((topic, primitive["op"], len(payload), qos))
            if (self.answer_create if primitive["op"] == 1 else self.answer_probe):
                self.hub._receive(dict(rqi=primitive["rqi"], rsc=2001 if primitive["op"] == 1 else 2000))
            return SimpleNamespace(rc=0)

        self.hub._mqtt = SimpleNamespace(publish=Mock(side_effect=publish), disconnect=Mock(), loop_stop=Mock())
        self.hub._ready.set()
        self.addAsyncCleanup(self.hub.close)

    async def send(self, name, size=8):
        await self.hub.publish(name, "/test/observations", {"blob": "x" * size})

    def ops(self):
        return [entry[1] for entry in self.wire]

    async def test_small_frames_use_mqtt_and_large_bundles_use_https(self):
        await self.send("small")
        await self.send("large", size=800)
        self.assertEqual(self.ops(), [1])
        topic, _, size, qos = self.wire[0]
        self.assertEqual((topic, qos), ("/oneM2M/req/Ctest/test-cse/json", 1))
        self.assertLessEqual(size, 700)
        self.assertEqual([method for method, _ in self.posts], ["POST"])
        self.assertEqual(self.hub.route_counters, {"native_mqtt": 1, "native_https_large": 1})

    async def test_size_rule_can_be_disabled(self):
        self.hub._mqtt_budget = 0
        await self.send("large", size=800)
        self.assertEqual(self.ops(), [1])
        self.hub._http_json.assert_not_awaited()

    async def test_broker_session_down_uses_https_without_waiting(self):
        self.hub._ready.clear()
        await self.send("offline")
        self.assertEqual(self.wire, [])
        self.assertEqual(self.hub.route_counters, {"native_https_mqtt_down": 1})
        self.assertIsNone(self.hub._unconfirmed_until)

    async def test_queue_failure_falls_back_once_without_probing(self):
        self.hub._mqtt.publish = Mock(return_value=SimpleNamespace(rc=4))
        await self.send("disconnected")
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.hub.route_counters, {"native_mqtt": 1, "native_mqtt_disconnect": 1,
                                                   "native_https_fallback_disconnect": 1})
        self.assertIsNone(self.hub._unconfirmed_until)

    async def test_new_session_uses_https_until_the_cse_answers_a_probe(self):
        self.answer_probe = False
        with patch("bubble_gateway.transport.monotonic", return_value=100.0) as clock:
            self.hub._session_ready()  # Broker back; the CSE has not resubscribed yet.
            self.assertEqual(self.hub._native_route(), "https_mqtt_unconfirmed")
            await self.hub._probe
            self.assertEqual(self.hub._unconfirmed_until, 105.0)
            await self.send("while-cse-resubscribes")
            self.assertEqual(self.ops(), [2])  # Data never waited on MQTT.
            self.answer_probe = True
            clock.return_value = 106.0
            await self.send("probe-due")
            await self.hub._probe
            self.assertIsNone(self.hub._unconfirmed_until)
            await self.send("confirmed")
        self.assertEqual(self.ops(), [2, 2, 1])
        self.assertEqual(len(self.posts), 2)
        self.assertEqual(self.hub.route_counters, {
            "mqtt_probe": 2, "mqtt_probe_timeout": 1, "mqtt_probe_ok": 1,
            "native_https_mqtt_unconfirmed": 2, "native_mqtt": 1})

    async def test_response_timeout_routes_https_until_probe_confirms_mqtt(self):
        self.answer_create = False
        with patch("bubble_gateway.transport.monotonic", return_value=100.0) as clock:
            await self.send("timed-out")
            self.assertEqual(self.ops(), [1])
            self.assertEqual(self.hub._unconfirmed_until, 105.0)
            clock.return_value = 101.0
            await self.send("unconfirmed")  # No MQTT wait while unconfirmed.
            self.assertEqual(self.ops(), [1])
            self.answer_create = True
            clock.return_value = 106.0
            await self.send("probe-due")  # HTTPS while the probe runs.
            await self.hub._probe
            self.assertIsNone(self.hub._unconfirmed_until)
            self.assertIsNone(self.hub._probe_timer)
            await self.send("recovered")
        self.assertEqual(self.ops(), [1, 2, 1])
        self.assertEqual(len(self.posts), 3)
        self.assertEqual(self.hub.route_counters, {
            "native_mqtt": 2, "native_mqtt_timeout": 1, "native_https_fallback_timeout": 1,
            "native_https_mqtt_unconfirmed": 2, "mqtt_probe": 1, "mqtt_probe_ok": 1})

    async def test_failed_probes_double_the_interval_and_a_new_session_resets_it(self):
        self.answer_create = self.answer_probe = False
        with patch("bubble_gateway.transport.monotonic", return_value=100.0) as clock:
            await self.send("timed-out")
            clock.return_value = 106.0
            await self.send("probe-due")
            await self.hub._probe
            self.assertEqual((self.hub._unconfirmed_until, self.hub._probe_failures), (116.0, 2))
            self.assertIsNotNone(self.hub._probe_timer)
            self.answer_probe = True
            self.hub._session_ready()
            self.assertEqual(self.hub._probe_failures, 0)
            await self.hub._probe
        self.assertIsNone(self.hub._unconfirmed_until)
        self.assertEqual(self.ops(), [1, 2, 2])

    async def test_scheduled_probe_restores_mqtt_without_new_traffic(self):
        self.hub._probe_interval = 0.01
        self.answer_create = False
        await self.send("timed-out")
        self.assertIsNotNone(self.hub._unconfirmed_until)
        async with asyncio.timeout(2):
            while self.hub._unconfirmed_until is not None:
                await asyncio.sleep(0.01)
        self.assertEqual(self.ops(), [1, 2])
        self.assertEqual(self.hub.route_counters["mqtt_probe_ok"], 1)

    async def test_zero_interval_keeps_per_request_mqtt_attempts(self):
        self.hub._probe_interval = 0
        self.answer_create = False
        self.hub._session_ready()
        await self.send("first")
        await self.send("second")
        self.assertEqual(self.ops(), [1, 1])
        self.assertIsNone(self.hub._unconfirmed_until)
        self.assertIsNone(self.hub._probe)

    async def test_close_cancels_an_unanswered_probe(self):
        self.answer_probe = False
        self.hub.config.request_timeout = 5
        self.hub._session_ready()
        await asyncio.sleep(0)
        await self.hub.close()
        self.assertIsNone(self.hub._probe)
        self.assertIsNone(self.hub._probe_timer)
        self.assertEqual(self.hub._pending, {})


class ProtocolConfigTests(unittest.TestCase):
    def env(self, root, **changes):
        files = {name: root / f"{name}.pem" for name in ("ca", "cert", "key")}
        for path in files.values():
            path.write_text("placeholder", encoding="ascii")
        values = {
            "GATEWAY_ID": "gw-test", "M2M_ORIGINATOR": "Ctest", "M2M_CSE_ID": "Mobius4",
            "PC_API_URL": "https://example.invalid", "M2M_CSE_URL": "https://example.invalid",
            "M2M_OBSERVATION_CONTAINER": "/test/obs", "M2M_RECEIPT_CONTAINER": "/test/receipts",
            "M2M_HEALTH_CONTAINER": "/test/health", "M2M_RVI": "4", "MQTT_HOST": "127.0.0.1",
            "BLE_DEVICES": json.dumps({"kr-test": "00:00:00:00:00:01"}),
            "GATEWAY_DATABASE": str(root / "gateway.sqlite3"),
            "TLS_CA_FILE": str(files["ca"]), "TLS_CERT_FILE": str(files["cert"]), "TLS_KEY_FILE": str(files["key"]),
        }
        values.update(changes)
        return values

    def load(self, **changes):
        with tempfile.TemporaryDirectory(prefix="keyring-protocol-config-") as tmp:
            with patch.dict(os.environ, self.env(Path(tmp), **changes), clear=True):
                return GatewayConfig.from_env()

    def test_defaults_and_bounds(self):
        loaded = self.load()
        self.assertEqual((loaded.mqtt_max_payload_bytes, loaded.mqtt_probe_interval_seconds), (4096, 5.0))
        loaded = self.load(MQTT_MAX_PAYLOAD_BYTES="0", MQTT_PROBE_INTERVAL_SECONDS="0")
        self.assertEqual((loaded.mqtt_max_payload_bytes, loaded.mqtt_probe_interval_seconds), (0, 0.0))
        for name, value in (("MQTT_MAX_PAYLOAD_BYTES", "100"), ("MQTT_MAX_PAYLOAD_BYTES", "262145"),
                            ("MQTT_MAX_PAYLOAD_BYTES", "1024.5"), ("MQTT_PROBE_INTERVAL_SECONDS", "301")):
            with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                self.load(**{name: value})


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

    def pin_receipt_container(self, observed_ri, *, readback_changes=None, readback_error=None):
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
