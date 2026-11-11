"""Authenticated PC control and oneM2M delivery, with durable IDs supplied by the caller."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import math
import re
import sqlite3
import uuid
from datetime import timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING, Any, AsyncIterator, NamedTuple
from urllib.parse import quote, urlsplit

import httpx
import paho.mqtt.client as mqtt
from .config import ID, configured_container_pins, tls_context
from .core_bridge import command as core_command
from .model import authorization_deadline, central_observation_id, parse_time, payload_hash, utc_now

if TYPE_CHECKING:
    from .store import Store

LOG = logging.getLogger(__name__)
MAX_BODY = 256 * 1024
COMMAND_BATCH = 16
MAX_RETRY_AFTER_SECONDS = 2**31
CORE_RECEIPT_FIELDS = {"version", "gatewayId", "deviceId", "ownershipEpoch", "sequence",
                       "payloadHash", "cseRequestId", "responseStatus"}


class RemoteResponseError(RuntimeError):
    def __init__(self, message: str, rsc: int | None = None, status_code: int | None = None):
        super().__init__(message)
        self.rsc = rsc
        self.status_code = status_code


class ReceiptParentMismatch(RemoteResponseError):
    """The authenticated CSE did not confirm the configured receipt resource."""


class HttpRetryDeferred(RemoteResponseError):
    def __init__(self, status_code: int, retry_after: float):
        super().__init__("HTTPS peer requested a retry delay", status_code=status_code)
        self.retry_after = retry_after


class NativeDeliveryHold(NamedTuple):
    all_native: bool = False
    receipt_container: str | None = None
    credential_receipts: bool = False
    observation_container: str | None = None
    health_container: str | None = None


class NativeConfirmation(NamedTuple):
    route: str
    created: bool


def _retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    value = value.strip()
    if re.fullmatch(r"[0-9]+", value):
        digits = value.lstrip("0")
        if len(digits) > 10:
            return MAX_RETRY_AFTER_SECONDS
        return min(int(digits or "0"), MAX_RETRY_AFTER_SECONDS)
    try:
        deadline = parsedate_to_datetime(value)
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        return min(MAX_RETRY_AFTER_SECONDS, max(0.0, (deadline - utc_now()).total_seconds()))
    except (ValueError, OverflowError):
        return None


def _pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _bad_constant(_: str) -> Any:
    raise ValueError("non-finite JSON number")


def _finite_float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("non-finite JSON number")
    return result


def _object(raw: bytes) -> dict[str, Any]:
    if len(raw) > MAX_BODY:
        raise RemoteResponseError("remote payload exceeds size limit")
    try:
        result = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                            parse_constant=_bad_constant, parse_float=_finite_float)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise RemoteResponseError("invalid remote JSON") from exc
    if not isinstance(result, dict):
        raise RemoteResponseError("remote payload must be an object")
    return result


def _json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                      separators=(",", ":")).encode("utf-8")


def _https_base(value: str, *, origin_only: bool = False) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or (origin_only and parsed.path not in ("", "/"))):
        raise ValueError("endpoint must be an HTTPS origin without credentials/query/fragment")
    return value.rstrip("/")


def _https_origin(url: str) -> tuple[str, int]:
    endpoint = urlsplit(url)
    if endpoint.hostname is None:
        raise ValueError("HTTPS origin requires a host")
    return endpoint.hostname, endpoint.port or 443


def _system_boot_id() -> str | None:
    try:
        return str(uuid.UUID(Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()))
    except (OSError, ValueError):
        return None


def _resource_path(path: str) -> str:
    if (not isinstance(path, str) or not path.startswith("/") or path.startswith("//")
            or any(part in {".", "..", ""} for part in path.strip("/").split("/"))
            or any(char in path for char in "?#%\\") or any(ord(char) < 32 for char in path)):
        raise ValueError("invalid CSE resource path")
    return quote(path.rstrip("/"), safe="/:-._~")


def _mqtt_to(http_path: str) -> str:
    """Reverse TS-0009 HTTP path encoding for the oneM2M request's To field."""
    _resource_path(http_path)
    if http_path.startswith("/~/"):
        target = http_path[2:]  # SP-relative: /~/CSE/base -> /CSE/base
    elif http_path.startswith("/_/"):
        target = "/" + http_path[2:]  # Absolute: /_/SP/CSE/base -> //SP/CSE/base
    else:
        target = http_path[1:]  # CSE-relative: /base/cnt -> base/cnt
    target = target.rstrip("/")
    if not target.strip("/"):
        raise ValueError("empty oneM2M To resource identifier")
    return target


class TransportHub:
    def __init__(self, config: Any, *, retry_store: Store | None = None):
        self.config = config
        self._api_url = _https_base(config.api_url)
        self._cse_url = _https_base(config.cse_url, origin_only=True)
        self._api_origin = _https_origin(self._api_url)
        self._cse_origin = _https_origin(self._cse_url)
        for segment in (config.originator, config.cse_id):
            if not isinstance(segment, str) or not segment or any(char in segment for char in "/+#\x00"):
                raise ValueError("MQTT originator and CSE ID must be single topic segments")
        self._request_topic = f"/oneM2M/req/{config.originator}/{config.cse_id}/json"
        self._response_topic = f"/oneM2M/resp/{config.originator}/{config.cse_id}/json"
        self._gateway_path = "/api/v1/gateways/" + quote(config.gateway_id, safe="")
        self._core_root = f"privacy-bubble/gateway/{config.gateway_id}"
        self._commands: asyncio.Queue = asyncio.Queue(maxsize=128)
        self._http: httpx.AsyncClient | None = None
        self._http_retry_until: dict[tuple[str, int], tuple[float, int]] = {}
        self._retry_store = retry_store
        self._retry_boot_id = _system_boot_id() if retry_store is not None else None
        if retry_store is not None and self._retry_boot_id is not None:
            saved = retry_store.restore_http_retry_windows(self._retry_boot_id, monotonic())
            self._http_retry_until = {origin: saved[origin] for origin in {self._api_origin, self._cse_origin}
                                      if origin in saved}
        self._mqtt: mqtt.Client | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ready = asyncio.Event()
        self._pending: dict[str, asyncio.Future] = {}
        self._core_pending: dict[tuple[str, int, int, str], asyncio.Future[dict[str, Any]]] = {}
        self._subscribe_mid: int | None = None
        self._closing = False

    async def start(self) -> None:
        if self._http is not None:
            raise RuntimeError("transport already started")
        self._closing = False
        self._loop = asyncio.get_running_loop()
        context = tls_context(self.config)
        self._http = httpx.AsyncClient(verify=context, follow_redirects=False, trust_env=False,
                                      timeout=httpx.Timeout(self.config.request_timeout),
                                      limits=httpx.Limits(max_connections=8, max_keepalive_connections=4))
        if not self.config.mqtt_enabled:
            return
        client_id = (f"pb-gateway-{self.config.gateway_id}" if self.config.core_bridge_enabled
                     else "gw-" + hashlib.sha256(self.config.gateway_id.encode("utf-8")).hexdigest()[:20])
        client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                             client_id=client_id, clean_session=False, protocol=mqtt.MQTTv311,
                             reconnect_on_failure=True)
        self._mqtt = client
        client.tls_set_context(context)
        client.connect_timeout = self.config.request_timeout
        client.reconnect_delay_set(min_delay=1, max_delay=60)
        client.max_inflight_messages_set(8)
        client.max_queued_messages_set(32)
        client.on_connect = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_subscribe = self._on_subscribe
        client.on_message = self._on_message
        # connect_async plus Paho's network loop provides bounded backoff even if
        # the broker is unavailable at startup. HTTPS remains immediately usable.
        await asyncio.to_thread(client.connect_async, self.config.mqtt_host,
                                self.config.mqtt_port, self.config.mqtt_keepalive)
        await asyncio.to_thread(client.loop_start)

    def _schedule(self, callback: Any, *args: Any) -> None:
        loop = self._loop
        if loop is not None and not loop.is_closed() and not self._closing:
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(callback, *args)

    def _on_connect(self, client: Any, _userdata: Any, _flags: Any,
                    reason_code: Any, _properties: Any) -> None:
        self._schedule(self._ready.clear)
        if reason_code != 0:
            LOG.warning("MQTT connection rejected")
            return
        subscriptions = [(self._response_topic, 1)] if self.config.m2m_mqtt_enabled else []
        if self.config.core_bridge_enabled:
            if getattr(self.config, "commands_enabled", True):
                subscriptions.append((self._core_root + "/command", 1))
            subscriptions.extend((self._core_receipt_topic(device, epoch), 1)
                                 for device, epoch in (self.config.core_telemetry_epochs or {}).items())
        if not subscriptions:
            self._schedule(self._ready.set)
            return
        result, mid = client.subscribe(subscriptions)
        if result == mqtt.MQTT_ERR_SUCCESS:
            self._subscribe_mid = mid
        else:
            LOG.warning("MQTT response subscription failed")

    def _on_subscribe(self, _client: Any, _userdata: Any, mid: int,
                      reasons: list[Any], _properties: Any) -> None:
        if mid != self._subscribe_mid:
            return
        if not reasons or any(reason.is_failure for reason in reasons):
            LOG.warning("MQTT response subscription denied")
            self._schedule(self._ready.clear)
            return
        self._schedule(self._ready.set)

    def _on_disconnect(self, _client: Any, _userdata: Any, _flags: Any,
                       _reason_code: Any, _properties: Any) -> None:
        self._schedule(self._disconnected)

    def _disconnected(self) -> None:
        self._ready.clear()
        for future in (*self._pending.values(), *self._core_pending.values()):
            if not future.done():
                future.set_exception(ConnectionError("MQTT disconnected before application response"))

    def _on_message(self, _client: Any, _userdata: Any, message: Any) -> None:
        if message.retain or len(message.payload) > MAX_BODY:
            return
        if self.config.core_telemetry_epochs and message.topic.startswith(self._core_root + "/telemetry-result/"):
            self._handle_core_receipt(message.topic, message.payload)
            return
        if self.config.core_bridge_enabled and message.topic == self._core_root + "/command":
            if not getattr(self.config, "commands_enabled", True):
                return
            try:
                command = core_command(_object(message.payload), self.config.gateway_id, self.config.ble_devices)
                self._schedule(self._queue_command, command)
            except (ValueError, TypeError, KeyError, RemoteResponseError):
                LOG.warning("CORE command rejected: canonical grant/claim fields required")
            return
        if message.topic != self._response_topic:
            return
        try:
            envelope = _object(message.payload)
            response = envelope.get("m2m:rsp", envelope)
            if (not isinstance(response, dict) or not isinstance(response.get("rqi"), str)
                    or type(response.get("rsc")) is not int):
                return
            if response.get("to", self.config.originator) != self.config.originator:
                return
            if response.get("fr", self.config.cse_id) not in {self.config.cse_id, "/" + self.config.cse_id}:
                return
            self._schedule(self._receive, response)
        except RemoteResponseError:
            LOG.warning("Invalid MQTT oneM2M response ignored")

    def _receive(self, response: dict[str, Any]) -> None:
        future = self._pending.get(response["rqi"])
        if future is not None and not future.done():
            future.set_result(response)

    def _core_receipt_topic(self, device: str, epoch: int) -> str:
        return f"{self._core_root}/telemetry-result/{device}/{epoch}"

    def _handle_core_receipt(self, topic: str, raw: bytes) -> None:
        if len(raw) > 2048:
            return
        try:
            result = _object(raw)
        except RemoteResponseError:
            return
        if set(result) != CORE_RECEIPT_FIELDS:
            return
        device, epoch, sequence = (result[key] for key in ("deviceId", "ownershipEpoch", "sequence"))
        digest, request_id = result["payloadHash"], result["cseRequestId"]
        if (type(result["version"]) is not int or result["version"] != 1
                or result["gatewayId"] != self.config.gateway_id or not isinstance(device, str)
                or type(epoch) is not int or self.config.core_telemetry_epochs.get(device) != epoch
                or topic != self._core_receipt_topic(device, epoch)
                or type(sequence) is not int or not 0 <= sequence <= 4294967295
                or type(result["responseStatus"]) is not int or result["responseStatus"] != 2004
                or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
                or not isinstance(request_id, str) or not re.fullmatch(r"kr-[a-f0-9]{48}", request_id)):
            return
        self._schedule(self._receive_core_receipt, (device, epoch, sequence, digest), result)

    def _receive_core_receipt(self, key: tuple[str, int, int, str], result: dict[str, Any]) -> None:
        future = self._core_pending.get(key)
        if future is not None and not future.done():
            future.set_result(result)

    def _queue_command(self, command: dict[str, Any]) -> None:
        try:
            self._commands.put_nowait(command)
        except asyncio.QueueFull:
            LOG.error("CORE command ingress full; command was not durably accepted or executed")

    def _http_deferral(self, origin: tuple[str, int]) -> HttpRetryDeferred | None:
        hold = self._http_retry_until.get(origin)
        if hold is not None:
            remaining = hold[0] - monotonic()
            if remaining > 0:
                return HttpRetryDeferred(hold[1], remaining)
        return None

    async def _http_json(self, method: str, url: str, *, headers: dict[str, str],
                         body: dict[str, Any] | None = None) -> tuple[int, httpx.Headers, dict[str, Any]]:
        if self._http is None:
            raise RuntimeError("transport is not started")
        origin = _https_origin(url)
        deferred = self._http_deferral(origin)
        if deferred is not None:
            raise deferred
        encoded = _json(body) if body is not None else None
        if encoded is not None and len(encoded) > MAX_BODY:
            raise ValueError("outgoing payload exceeds size limit")
        async with asyncio.timeout(self.config.request_timeout), self._http.stream(
                method, url, headers=headers, content=encoded) as response:
            if response.status_code in {429, 503}:
                retry_after = _retry_after(response.headers.get("Retry-After"))
                if retry_after is not None:
                    now = monotonic()
                    retry_until, retry_status = self._http_retry_until.get(origin, (now, response.status_code))
                    if now + retry_after >= retry_until:
                        retry_until, retry_status = now + retry_after, response.status_code
                        self._http_retry_until[origin] = (retry_until, retry_status)
                        if retry_after > 0 and self._retry_store is not None and self._retry_boot_id is not None:
                            try:
                                self._retry_store.save_http_retry_window(origin, self._retry_boot_id, retry_until, retry_status)
                            except sqlite3.Error:
                                LOG.warning("HTTPS retry window could not be saved; current process still honors it")
                    raise HttpRetryDeferred(retry_status, retry_until - now)
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                raw.extend(chunk)
                if len(raw) > MAX_BODY:
                    raise RemoteResponseError("remote body exceeds size limit")
            document = _object(bytes(raw)) if raw else {}
            return response.status_code, response.headers, document

    def _m2m_headers(self, rqi: str, *, create: bool = False) -> dict[str, str]:
        return {"X-M2M-Origin": self.config.originator, "X-M2M-RI": rqi,
                "X-M2M-RVI": self.config.rvi,
                "Accept": "application/json", "Cache-Control": "no-cache",
                "Content-Type": "application/json;ty=4" if create else "application/json"}

    def _response_rsc(self, status: int, headers: httpx.Headers, rqi: str) -> int:
        if headers.get("X-M2M-RI") != rqi:
            raise RemoteResponseError("oneM2M HTTP response request ID mismatch", status_code=status)
        try:
            rsc = int(headers["X-M2M-RSC"])
        except (KeyError, ValueError) as exc:
            raise RemoteResponseError("oneM2M HTTP response has no valid result code", status_code=status) from exc
        return rsc

    def _native_mqtt_ready(self) -> bool:
        return self.config.m2m_mqtt_enabled and self._mqtt is not None and self._ready.is_set()

    def central_delivery_held(self) -> bool:
        return self._http_deferral(self._api_origin) is not None

    def native_delivery_hold(self) -> NativeDeliveryHold:
        if self._http_deferral(self._cse_origin) is None:
            return NativeDeliveryHold()
        if not self._native_mqtt_ready():
            return NativeDeliveryHold(all_native=True)
        # These routes require HTTPS verification even when MQTT can create the CIN.
        pins = configured_container_pins(self.config)
        return NativeDeliveryHold(
            receipt_container=self.config.receipt_container if self.config.receipt_container in pins else None,
            credential_receipts=True,
            observation_container=self.config.observation_container if self.config.observation_container in pins else None,
            health_container=self.config.health_container if self.config.health_container in pins else None,
        )

    async def _verify_container(self, path: str, pin: str) -> None:
        rqi = "receipt-parent-" + uuid.uuid4().hex
        status, headers, document = await self._http_json("GET", self._cse_url + path, headers=self._m2m_headers(rqi))
        rsc = self._response_rsc(status, headers, rqi)
        parent = document.get("m2m:cnt")
        if (status != 200 or rsc != 2000 or not isinstance(parent, dict)
                or type(parent.get("ty")) is not int or parent["ty"] != 3 or parent.get("ri") != pin):
            raise ReceiptParentMismatch("oneM2M container identity mismatch", rsc, status)

    async def verify_receipt_route(self) -> str:
        pin = self.config.receipt_container_ri
        if pin is None:
            raise ValueError("A receipt container ID is required")
        await self._verify_container(_resource_path(self.config.receipt_container), pin)
        return pin

    async def verify_observation_route(self) -> str:
        pin = self.config.observation_container_ri
        if pin is None:
            raise ValueError("An observation container ID is required")
        await self._verify_container(_resource_path(self.config.observation_container), pin)
        return pin

    async def verify_health_route(self) -> str:
        pin = self.config.health_container_ri
        if pin is None:
            raise ValueError("A health container ID is required")
        await self._verify_container(_resource_path(self.config.health_container), pin)
        return pin

    @staticmethod
    def _receipt_content_identity(cin: Any, rn: str, rsc: int, status: int | None = None, *,
                                  pin: str | None = None) -> tuple[str, str]:
        if pin is not None and (not isinstance(cin, dict) or cin.get("pi") != pin):
            raise ReceiptParentMismatch("oneM2M content instance parent mismatch", rsc, status)
        if not isinstance(cin, dict):
            raise RemoteResponseError("oneM2M content instance identity mismatch", rsc, status)
        ri, parent = cin.get("ri"), cin.get("pi")
        if (cin.get("rn") != rn or type(cin.get("ty")) is not int or cin["ty"] != 4
                or not isinstance(ri, str) or ID.fullmatch(ri) is None
                or not isinstance(parent, str) or ID.fullmatch(parent) is None):
            raise RemoteResponseError("oneM2M content instance identity mismatch", rsc, status)
        return ri, parent

    async def read_content(self, rqi: str, container: str) -> Any:
        """Read the native content instance named by its original request ID."""
        return (await self.read_content_instance(rqi, container))["con"]

    async def read_content_instance(self, rqi: str, container: str) -> dict[str, Any]:
        """Return the native instance envelope for callers that need CSE metadata."""
        digest = hashlib.sha256(rqi.encode("utf-8")).hexdigest()
        rn = "gw-" + digest
        read_rqi = "read-" + digest
        url = self._cse_url + _resource_path(container) + "/" + rn
        status, headers, document = await self._http_json("GET", url, headers=self._m2m_headers(read_rqi))
        rsc = self._response_rsc(status, headers, read_rqi)
        existing = document.get("m2m:cin")
        if (status != 200 or rsc != 2000 or not isinstance(existing, dict)
                or existing.get("rn") != rn or "con" not in existing):
            raise RemoteResponseError("unable to establish existing content identity", rsc, status)
        pin = configured_container_pins(self.config).get(container)
        if pin is not None:
            self._receipt_content_identity(existing, rn, rsc, status, pin=pin)
        return existing

    async def _confirm_stored(self, rqi: str, container: str, payload: dict[str, Any], *,
                              created_identity: tuple[str, str] | None = None,
                              credential_receipt: bool = False, conflict: bool = False) -> None:
        existing = await self.read_content_instance(rqi, container)
        if credential_receipt:
            self._receipt_content_identity(existing, existing["rn"], 2000, 200)
        if created_identity is not None:
            if existing.get("ri") != created_identity[0]:
                raise RemoteResponseError("stored content resource ID differs from CREATE response", 2000, 200)
            if existing.get("pi") != created_identity[1]:
                raise ReceiptParentMismatch("stored content parent differs from CREATE response", 2000, 200)
        if _json(existing["con"]) != _json(payload):
            rsc = 4105 if conflict else 2000
            raise RemoteResponseError("existing oneM2M resource has different content", rsc, 200)

    async def _confirm_create(self, rqi: str, container: str, payload: dict[str, Any], rn: str,
                              content: Any, *, pin: str | None, credential_receipt: bool,
                              status: int | None = None) -> None:
        if pin is None and not credential_receipt:
            return
        cin = content.get("m2m:cin") if isinstance(content, dict) else None
        identity = (self._receipt_content_identity(cin, rn, 2001, status, pin=pin)
                    if pin is not None or cin is not None else None)
        await self._confirm_stored(rqi, container, payload, created_identity=identity,
                                   credential_receipt=credential_receipt)

    async def publish(self, rqi: str, container: str, payload: dict[str, Any], *,
                      confirm_existing: bool = False,
                      expected_claim_id: str | None = None) -> NativeConfirmation | dict[str, Any] | None:
        if container.startswith("@core/"):
            return await self._publish_core(container, payload)
        if not isinstance(rqi, str) or not 1 <= len(rqi) <= 128:
            raise ValueError("invalid request ID")
        if container == "@central/receipt":
            return await self._publish_central_receipt(rqi, payload, expected_claim_id)
        if container == "@central/telemetry":
            return await self._publish_central_telemetry(rqi, payload)
        path = _resource_path(container)
        rn = "gw-" + hashlib.sha256(rqi.encode("utf-8")).hexdigest()
        cin = {"rn": rn, "cnf": "application/json:0", "con": payload}
        if len(_json(cin)) > MAX_BODY:
            raise ValueError("outgoing content exceeds size limit")
        pin = configured_container_pins(self.config).get(container)
        credential_receipt = "credentialTransition" in payload and container == self.config.health_container
        if credential_receipt:
            deferred = self._http_deferral(self._cse_origin)
            if deferred is not None:
                raise deferred
        target = container
        if pin is not None:
            await self._verify_container(path, pin)
            if confirm_existing:
                try:
                    await self._confirm_stored(rqi, container, payload, conflict=True)
                except RemoteResponseError as exc:
                    if (exc.status_code, exc.rsc) != (404, 4004):
                        raise
                else:
                    return NativeConfirmation("https-readback", False)
            # Write to the verified resource itself even if its name is later rebound.
            target = f"/{pin}"
            path = _resource_path(target)
        if self._native_mqtt_ready():
            if rqi in self._pending:
                raise RuntimeError("request ID already in flight")
            future = asyncio.get_running_loop().create_future()
            self._pending[rqi] = future
            primitive = {"op": 1, "to": _mqtt_to(target), "fr": self.config.originator,
                         "rqi": rqi, "ty": 4, "rvi": self.config.rvi, "pc": {"m2m:cin": cin}}
            try:
                wire = {"m2m:rqp": primitive} if self.config.mqtt_wrapped_primitive else primitive
                info = self._mqtt.publish(self._request_topic, payload=_json(wire), qos=1, retain=False)
                if info.rc != mqtt.MQTT_ERR_SUCCESS:
                    raise ConnectionError("MQTT publish was not queued")
                response = await asyncio.wait_for(future, self.config.request_timeout)
            except (ConnectionError, OSError, asyncio.TimeoutError):
                LOG.info("MQTT response unavailable; attempting HTTPS with the same resource name")
            else:
                rsc = response["rsc"]
                if rsc == 2001:
                    await self._confirm_create(rqi, container, payload, rn, response.get("pc"), pin=pin,
                                               credential_receipt=credential_receipt)
                    return NativeConfirmation("mqtt", True)
                if rsc == 4105:
                    await self._confirm_stored(rqi, container, payload, credential_receipt=credential_receipt,
                                               conflict=True)
                    return NativeConfirmation("mqtt", False)
                # A real CSE rejection is terminal for this attempt. HTTPS is a
                # network fallback, not a second route around permission denial.
                raise RemoteResponseError("oneM2M MQTT request rejected", rsc)
            finally:
                self._pending.pop(rqi, None)
                if not future.done():
                    future.cancel()
                elif not future.cancelled():
                    future.exception()
        status, headers, document = await self._http_json(
            "POST", self._cse_url + path, headers=self._m2m_headers(rqi, create=True), body={"m2m:cin": cin})
        rsc = self._response_rsc(status, headers, rqi)
        route = "https-fallback" if self.config.m2m_mqtt_enabled else "https"
        if 200 <= status < 300 and rsc == 2001:
            await self._confirm_create(rqi, container, payload, rn, document, pin=pin,
                                       credential_receipt=credential_receipt, status=status)
            return NativeConfirmation(route, True)
        if rsc == 4105:
            await self._confirm_stored(rqi, container, payload, credential_receipt=credential_receipt, conflict=True)
            return NativeConfirmation(route, False)
        raise RemoteResponseError("oneM2M HTTPS request rejected", rsc, status)

    async def _publish_central_receipt(self, rqi: str, receipt: dict[str, Any],
                                       claim_id: str | None) -> dict[str, Any]:
        if not self.config.central_receipts_enabled or not isinstance(claim_id, str) or not ID.fullmatch(claim_id):
            raise ValueError("Central receipt route requires an enabled route and a bound claim")
        result = await self._api("POST", "/receipts", receipt, rqi, idempotency_key=rqi)
        if (result.get("status") not in ("ACCEPTED", "DUPLICATE")
                or result.get("commandId") != receipt["commandId"]
                or result.get("claimId") != claim_id
                or result.get("receiptHash") != payload_hash(receipt)):
            raise RemoteResponseError("Central receipt confirmation does not match the queued receipt")
        return result

    async def _publish_central_telemetry(self, rqi: str, observation: dict[str, Any]) -> dict[str, Any]:
        if not self.config.central_telemetry_enabled or observation["gatewayId"] != self.config.gateway_id:
            raise ValueError("Central telemetry route requires an enabled route and the configured gateway")
        observation_id = central_observation_id(observation)
        result = await self._api("POST", "/telemetry", observation, rqi, idempotency_key=rqi)
        if (result.get("status") not in ("ACCEPTED", "DUPLICATE", "STALE")
                or result.get("deviceId") != observation["deviceId"]
                or result.get("observationId") != observation_id):
            raise RemoteResponseError("Central telemetry confirmation does not match the queued observation")
        return result

    async def _publish_core(self, target: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        if target not in {"@core/telemetry", "@core/ack"} or not self.config.core_bridge_enabled:
            raise ValueError("Unsupported CORE outbox target")
        if self._mqtt is None or not self._ready.is_set():
            raise ConnectionError("CORE MQTT session is not ready")
        topic = self._core_root + "/" + target.split("/", 1)[1]
        if target == "@core/telemetry":
            epochs = self.config.core_telemetry_epochs
            if epochs is None:
                if "ownershipEpoch" in payload:
                    raise ValueError("Scoped CORE telemetry cannot use the legacy topic")
            else:
                device_id, epoch = payload.get("deviceId"), payload.get("ownershipEpoch")
                if (payload.get("gatewayId") != self.config.gateway_id or not isinstance(device_id, str)
                        or type(epoch) is not int or epochs.get(device_id) != epoch):
                    raise ValueError("CORE telemetry ownership assignment does not match the queued route")
                topic = f"{self._core_root}/telemetry-epoch/{device_id}/{epoch}"
                payload = {key: value for key, value in payload.items() if key != "ownershipEpoch"}
                return await self._publish_scoped_telemetry(topic, device_id, epoch, payload)
        info = self._mqtt.publish(topic, payload=_json(payload), qos=1, retain=False)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise ConnectionError("CORE publish was not accepted")
        await asyncio.to_thread(info.wait_for_publish, timeout=self.config.request_timeout)
        if not info.is_published():
            raise TimeoutError("CORE MQTT PUBACK timeout")
        # PUBACK proves broker ingress only. It does not assert CORE processing,
        # a oneM2M UPDATE or a physical device actuation.

    async def _publish_scoped_telemetry(self, topic: str, device: str, epoch: int,
                                        payload: dict[str, Any]) -> dict[str, Any]:
        sequence = payload.get("sequence")
        if type(sequence) is not int or not 0 <= sequence <= 4294967295:
            raise ValueError("Invalid scoped CORE telemetry sequence")
        encoded = _json(payload)
        key = (device, epoch, sequence, hashlib.sha256(encoded).hexdigest())
        if key in self._core_pending:
            raise RuntimeError("Scoped CORE telemetry is already in flight")
        future = asyncio.get_running_loop().create_future()
        self._core_pending[key] = future
        try:
            info = self._mqtt.publish(topic, payload=encoded, qos=1, retain=False)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                raise ConnectionError("Scoped CORE publish was not queued")
            return await asyncio.wait_for(future, self.config.request_timeout)
        finally:
            self._core_pending.pop(key, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()

    async def _api(self, method: str, suffix: str, body: dict[str, Any] | None = None,
                   correlation_id: str | None = None, *, idempotency_key: str | None = None) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        headers = {"Accept": "application/json", "Content-Type": "application/json",
                   "X-Request-ID": request_id, "X-Correlation-ID": correlation_id or request_id,
                   "Cache-Control": "no-store"}
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        status, _, document = await self._http_json(
            method, self._api_url + self._gateway_path + suffix, headers=headers, body=body)
        if status != 200:
            raise RemoteResponseError("PC API request rejected", status_code=status)
        return document

    async def poll_commands(self) -> list[dict[str, Any]]:
        """Collect a complete poll for callers that need a single result."""
        commands = []
        async for batch in self.command_batches():
            commands.extend(batch)
        return commands

    async def command_batches(self) -> AsyncIterator[list[dict[str, Any]]]:
        """Yield the authoritative HTTPS list before checking CORE copies."""
        poll_error = None
        try:
            async with asyncio.timeout(self.config.request_timeout):
                document = await self._api("GET", f"/commands?limit={COMMAND_BATCH}")
            commands = document.get("commands")
            if (not isinstance(commands, list) or len(commands) > COMMAND_BATCH
                    or any(not isinstance(item, dict) for item in commands)):
                raise RemoteResponseError("invalid PC command list")
        except (RemoteResponseError, httpx.HTTPError, OSError) as exc:
            poll_error = exc
            commands = []

        issued_ids = {item["commandId"] for item in commands if isinstance(item.get("commandId"), str)}
        available = COMMAND_BATCH - len(commands)
        if commands:
            yield commands
        candidates = {}
        for _ in range(min(self._commands.qsize(), COMMAND_BATCH)):
            command = self._commands.get_nowait()
            self._commands.task_done()
            if available and command["commandId"] not in issued_ids:
                candidates[payload_hash(command)] = command

        if candidates:
            # Only centrally bound MQTT copies may claim a durable commandId.
            # Parallel, bounded checks keep one unavailable request from blocking the rest.
            approvals = await asyncio.gather(*(self._approve_core_command(command, digest)
                                               for digest, command in candidates.items()))
            approved = [command for command, allowed in zip(candidates.values(), approvals) if allowed]
            if len(approved) != len(candidates):
                LOG.warning("Ignored %d CORE commands without a current central binding",
                            len(candidates) - len(approved))
            if approved:
                yield approved[:available]
                return
        if poll_error is not None:
            raise poll_error

    async def _approve_core_command(self, command: dict[str, Any], digest: str) -> bool:
        try:
            remaining = (parse_time(command["deadline"]) - utc_now()).total_seconds()
            if remaining <= 0:
                return False
            async with asyncio.timeout(min(remaining, self.config.request_timeout)):
                response = await self.authorize(command, digest)
            return authorization_deadline(command, digest, response) > utc_now()
        except (RemoteResponseError, httpx.HTTPError, OSError, ValueError, OverflowError):
            return False

    async def authorize(self, command_dict: dict[str, Any], payload_hash: str) -> dict[str, Any]:
        return await self._command_authority("/authorize", command_dict, payload_hash)

    async def dispatch_start(self, command_dict: dict[str, Any], payload_hash: str) -> dict[str, Any]:
        return await self._command_authority("/dispatch-start", command_dict, payload_hash)

    async def _command_authority(self, route: str, command_dict: dict[str, Any], payload_hash: str) -> dict[str, Any]:
        body = {key: command_dict[key] for key in
                ("commandId", "deviceId", "claimId", "grantRevision", "ownershipEpoch")}
        body["payloadHash"] = payload_hash
        return await self._api("POST", route, body, command_dict["commandId"])

    async def credential_status(self) -> dict[str, Any]:
        return await self._api("GET", "/credentials/status")

    async def close(self) -> None:
        self._disconnected()
        self._closing = True
        if self._mqtt is not None:
            await asyncio.to_thread(self._mqtt.disconnect)
            await asyncio.to_thread(self._mqtt.loop_stop)
            self._mqtt = None
        if self._http is not None:
            await self._http.aclose()
            self._http = None
