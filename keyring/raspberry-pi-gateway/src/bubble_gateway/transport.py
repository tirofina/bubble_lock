"""Authenticated PC control and oneM2M delivery, with durable IDs supplied by the caller."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import math
import ssl
import uuid
from typing import Any
from urllib.parse import quote, urlsplit

import httpx
import paho.mqtt.client as mqtt
from .core_bridge import command as core_command

LOG = logging.getLogger(__name__)
MAX_BODY = 256 * 1024


class RemoteResponseError(RuntimeError):
    def __init__(self, message: str, rsc: int | None = None, status_code: int | None = None):
        super().__init__(message)
        self.rsc = rsc
        self.status_code = status_code


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


def _resource_path(path: str) -> str:
    if (not isinstance(path, str) or not path.startswith("/") or path.startswith("//")
            or any(part in {".", "..", ""} for part in path.strip("/").split("/"))
            or any(char in path for char in "?#%\\") or any(ord(char) < 32 for char in path)):
        raise ValueError("invalid CSE resource path")
    return quote(path.rstrip("/"), safe="/:-._~")


class TransportHub:
    def __init__(self, config: Any):
        self.config = config
        self._api_url = _https_base(config.api_url)
        self._cse_url = _https_base(config.cse_url, origin_only=True)
        for segment in (config.originator, config.cse_id):
            if not isinstance(segment, str) or not segment or any(char in segment for char in "/+#\x00"):
                raise ValueError("MQTT originator and CSE ID must be single topic segments")
        self._request_topic = f"/oneM2M/req/{config.originator}/{config.cse_id}/json"
        self._response_topic = f"/oneM2M/resp/{config.originator}/{config.cse_id}/json"
        self._gateway_path = "/api/v1/gateways/" + quote(config.gateway_id, safe="")
        self._core_root = f"privacy-bubble/gateway/{config.gateway_id}"
        self._commands: asyncio.Queue = asyncio.Queue(maxsize=128)
        self._http: httpx.AsyncClient | None = None
        self._mqtt: mqtt.Client | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ready = asyncio.Event()
        self._pending: dict[str, asyncio.Future] = {}
        self._subscribe_mid: int | None = None
        self._closing = False

    async def start(self) -> None:
        if self._http is not None:
            raise RuntimeError("transport already started")
        self._closing = False
        self._loop = asyncio.get_running_loop()
        context = ssl.create_default_context(cafile=str(self.config.ca_file))
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.load_cert_chain(str(self.config.cert_file), str(self.config.key_file))
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
        subscriptions = [(self._response_topic, 1)]
        if self.config.core_bridge_enabled:
            subscriptions.append((self._core_root + "/command", 1))
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
        for future in self._pending.values():
            if not future.done():
                future.set_exception(ConnectionError("MQTT disconnected before oneM2M response"))

    def _on_message(self, _client: Any, _userdata: Any, message: Any) -> None:
        if message.retain or len(message.payload) > MAX_BODY:
            return
        if self.config.core_bridge_enabled and message.topic == self._core_root + "/command":
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

    def _queue_command(self, command: dict[str, Any]) -> None:
        try:
            self._commands.put_nowait(command)
        except asyncio.QueueFull:
            LOG.error("CORE command ingress full; command was not durably accepted or executed")

    async def _http_json(self, method: str, url: str, *, headers: dict[str, str],
                         body: dict[str, Any] | None = None) -> tuple[int, httpx.Headers, dict[str, Any]]:
        if self._http is None:
            raise RuntimeError("transport is not started")
        encoded = _json(body) if body is not None else None
        if encoded is not None and len(encoded) > MAX_BODY:
            raise ValueError("outgoing payload exceeds size limit")
        async with asyncio.timeout(self.config.request_timeout), self._http.stream(
                method, url, headers=headers, content=encoded) as response:
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

    async def _existing(self, rqi: str, container: str, rn: str, payload: dict[str, Any]) -> None:
        read_rqi = "read-" + hashlib.sha256(rqi.encode("utf-8")).hexdigest()
        url = self._cse_url + _resource_path(container) + "/" + rn
        status, headers, document = await self._http_json("GET", url, headers=self._m2m_headers(read_rqi))
        rsc = self._response_rsc(status, headers, read_rqi)
        existing = document.get("m2m:cin")
        if (status != 200 or rsc != 2000 or not isinstance(existing, dict)
                or existing.get("rn") != rn or "con" not in existing):
            raise RemoteResponseError("unable to establish existing content identity", rsc, status)
        if _json(existing["con"]) != _json(payload):
            raise RemoteResponseError("existing oneM2M resource has different content", 4105, status)

    async def publish(self, rqi: str, container: str, payload: dict[str, Any]) -> None:
        if container.startswith("@core/"):
            await self._publish_core(container, payload)
            return
        if not isinstance(rqi, str) or not 1 <= len(rqi) <= 128:
            raise ValueError("invalid request ID")
        path = _resource_path(container)
        rn = "gw-" + hashlib.sha256(rqi.encode("utf-8")).hexdigest()
        cin = {"rn": rn, "cnf": "application/json:0", "con": payload}
        if len(_json(cin)) > MAX_BODY:
            raise ValueError("outgoing content exceeds size limit")
        if self._mqtt is not None and self._ready.is_set():
            if rqi in self._pending:
                raise RuntimeError("request ID already in flight")
            future = asyncio.get_running_loop().create_future()
            self._pending[rqi] = future
            primitive = {"op": 1, "to": container, "fr": self.config.originator,
                         "rqi": rqi, "ty": 4, "rvi": self.config.rvi, "pc": {"m2m:cin": cin}}
            try:
                wire = {"m2m:rqp": primitive} if self.config.mqtt_wrapped_primitive else primitive
                info = self._mqtt.publish(self._request_topic, payload=_json(wire), qos=1, retain=False)
                if info.rc != mqtt.MQTT_ERR_SUCCESS:
                    raise ConnectionError("MQTT publish was not queued")
                response = await asyncio.wait_for(future, self.config.request_timeout)
                rsc = response["rsc"]
                if rsc == 2001:
                    return
                if rsc == 4105:
                    await self._existing(rqi, container, rn, payload)
                    return
                # A real CSE rejection is terminal for this attempt. HTTPS is a
                # network fallback, not a second route around permission denial.
                raise RemoteResponseError("oneM2M MQTT request rejected", rsc)
            except (ConnectionError, OSError, asyncio.TimeoutError):
                LOG.info("MQTT response unavailable; attempting HTTPS with the same resource name")
            finally:
                self._pending.pop(rqi, None)
                if not future.done():
                    future.cancel()
                elif not future.cancelled():
                    future.exception()
        status, headers, _ = await self._http_json(
            "POST", self._cse_url + path, headers=self._m2m_headers(rqi, create=True), body={"m2m:cin": cin})
        rsc = self._response_rsc(status, headers, rqi)
        if 200 <= status < 300 and rsc == 2001:
            return
        if rsc == 4105:
            await self._existing(rqi, container, rn, payload)
            return
        raise RemoteResponseError("oneM2M HTTPS request rejected", rsc, status)

    async def _publish_core(self, target: str, payload: dict[str, Any]) -> None:
        if target not in {"@core/telemetry", "@core/ack"} or not self.config.core_bridge_enabled:
            raise ValueError("Unsupported CORE outbox target")
        if self._mqtt is None or not self._ready.is_set():
            raise ConnectionError("CORE MQTT session is not ready")
        topic = self._core_root + "/" + target.split("/", 1)[1]
        info = self._mqtt.publish(topic, payload=_json(payload), qos=1, retain=False)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise ConnectionError("CORE publish was not accepted")
        await asyncio.to_thread(info.wait_for_publish, timeout=self.config.request_timeout)
        if not info.is_published():
            raise TimeoutError("CORE MQTT PUBACK timeout")
        # PUBACK proves broker ingress only. It does not assert CORE processing,
        # a oneM2M UPDATE or a physical device actuation.

    async def _api(self, method: str, suffix: str, body: dict[str, Any] | None = None,
                    correlation_id: str | None = None) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        headers = {"Accept": "application/json", "Content-Type": "application/json",
                   "X-Request-ID": request_id, "X-Correlation-ID": correlation_id or request_id,
                   "Cache-Control": "no-store"}
        status, _, document = await self._http_json(
            method, self._api_url + self._gateway_path + suffix, headers=headers, body=body)
        if status != 200:
            raise RemoteResponseError("PC API request rejected", status_code=status)
        return document

    async def poll_commands(self) -> list[dict[str, Any]]:
        queued = []
        while len(queued) < 16 and not self._commands.empty():
            queued.append(self._commands.get_nowait())
            self._commands.task_done()
        if len(queued) == 16:
            return queued
        try:
            document = await self._api("GET", "/commands?limit=16")
        except Exception:
            if queued:
                return queued
            raise
        commands = document.get("commands")
        if not isinstance(commands, list) or len(commands) > 16 or any(not isinstance(item, dict) for item in commands):
            raise RemoteResponseError("invalid PC command list")
        return queued + commands[:16 - len(queued)]

    async def authorize(self, command_dict: dict[str, Any], payload_hash: str) -> dict[str, Any]:
        body = {key: command_dict[key] for key in
                ("commandId", "deviceId", "claimId", "grantRevision", "ownershipEpoch")}
        body["payloadHash"] = payload_hash
        return await self._api("POST", "/authorize", body, command_dict["commandId"])

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
