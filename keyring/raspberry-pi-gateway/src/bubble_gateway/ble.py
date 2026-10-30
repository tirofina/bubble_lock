"""BLE GATT transport for enrolled Privacy Bubble keyrings.

No connection is made until ``start``. The BlueZ bond/agent must be provisioned
by the operator; this module never installs an unattended accepting agent.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import random
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from bleak import BleakClient, BleakScanner
from .core_bridge import CORE_SERVICE, CORE_IDENTITY, CORE_OBSERVATION, CORE_COMMAND, CORE_RECEIPT

LOG = logging.getLogger(__name__)
SERVICE = "8b8f0001-8e7a-4f36-a8c2-1c9b5d620001"
IDENTITY = "8b8f0002-8e7a-4f36-a8c2-1c9b5d620001"
OBSERVATION = "8b8f0003-8e7a-4f36-a8c2-1c9b5d620001"
COMMAND = "8b8f0004-8e7a-4f36-a8c2-1c9b5d620001"
RECEIPT = "8b8f0005-8e7a-4f36-a8c2-1c9b5d620001"
MAX_FRAME = 4096
FRAME_TIMEOUT = 5.0
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\Z")
MAX_UPTIME_MS = 9007199254740991
ACK_CODES = frozenset({
    "APPLIED", "DUPLICATE", "REJECTED_EPOCH", "REJECTED_GRANT", "EXPIRED",
    "CONFLICT", "INVALID", "JOURNAL_FULL", "STORAGE_ERROR", "INDETERMINATE",
    "READBACK_MISMATCH",
})


class BleProtocolError(RuntimeError):
    """Peer data does not satisfy the agreed wire format."""


class BleUnavailable(ConnectionError):
    """An enrolled keyring currently has no authenticated GATT session."""


def _utc(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise BleProtocolError("duplicate JSON key")
        result[key] = value
    return result


def _bad_constant(_: str) -> Any:
    raise BleProtocolError("non-finite JSON number")


def _finite_float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise BleProtocolError("non-finite JSON number")
    return result


def _object(raw: bytes | bytearray, limit: int = MAX_FRAME) -> dict[str, Any]:
    if len(raw) > limit:
        raise BleProtocolError("frame exceeds size limit")
    try:
        result = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_pairs,
                            parse_constant=_bad_constant, parse_float=_finite_float)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise BleProtocolError("invalid JSON frame") from exc
    if not isinstance(result, dict):
        raise BleProtocolError("frame must be an object")
    return result


def _integer(value: Any, minimum: int = 0, maximum: int = 2**63 - 1) -> bool:
    return type(value) is int and minimum <= value <= maximum


def _power_reading(value: Any, uptime_ms: int) -> None:
    fields = {"status", "busVoltageMv", "currentUa", "loadPowerUw", "shuntVoltageUv", "readUptimeMs"}
    states = {"disabled", "waiting", "sampling", "ok", "stale", "configuration_error", "configuration_changed",
              "i2c_error", "conversion_timeout", "overflow", "overrange", "inconsistent", "shutdown_error"}
    if (not isinstance(value, dict) or set(value) != fields or not isinstance(value.get("status"), str)
            or value["status"] not in states):
        raise BleProtocolError("invalid INA219 detail shape")
    if value["status"] != "ok":
        if any(value[key] is not None for key in fields - {"status"}):
            raise BleProtocolError("invalid INA219 state must not carry numeric readings")
        return
    if (not _integer(value["busVoltageMv"], maximum=15996) or value["busVoltageMv"] % 4
            or not _integer(value["shuntVoltageUv"], -79990, 79990) or value["shuntVoltageUv"] % 10
            or not _integer(value["currentUa"], -8000000, 8000000)
            or not _integer(value["loadPowerUw"], -128000000, 128000000)
            or not _integer(value["readUptimeMs"], maximum=uptime_ms)):
        raise BleProtocolError("invalid INA219 units/time/range")
    product = value["busVoltageMv"] * value["currentUa"]
    expected = (abs(product) + 500) // 1000 * (-1 if product < 0 else 1)
    if value["loadPowerUw"] != expected:
        raise BleProtocolError("INA219 derived load power disagrees with voltage/current")


@dataclass
class _Frames:
    data: bytearray = field(default_factory=bytearray)
    last_fragment: float = 0.0

    def feed(self, chunk: bytearray) -> list[dict[str, Any]]:
        now = time.monotonic()
        if self.data and now - self.last_fragment > FRAME_TIMEOUT:
            self.data.clear()
            raise BleProtocolError("incomplete frame timed out")
        self.last_fragment = now
        self.data.extend(chunk)
        result = []
        while b"\n" in self.data:
            line, _, rest = self.data.partition(b"\n")
            self.data = bytearray(rest)
            if not line:
                raise BleProtocolError("empty frame")
            result.append(_object(line))
        if len(self.data) > MAX_FRAME:
            self.data.clear()
            raise BleProtocolError("incomplete frame exceeds size limit")
        return result


@dataclass
class _Peer:
    device_id: str
    address: str
    client: Any = None
    generation: int = 0
    discovered: Any = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    seen: asyncio.Event = field(default_factory=asyncio.Event)
    disconnected: asyncio.Event = field(default_factory=asyncio.Event)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    identity: dict[str, Any] = field(default_factory=dict)
    observation_frames: _Frames = field(default_factory=_Frames)
    receipt_frames: _Frames = field(default_factory=_Frames)
    observations: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=128))
    pending: asyncio.Future | None = None
    pending_command: str | None = None
    pending_hash: str | None = None
    anchor: tuple[str, int, datetime, float] | None = None
    rssi: int | None = None
    rssi_monotonic: float | None = None
    last_sequence: int = -1
    last_error: str | None = None
    dropped_observations: int = 0


class BleFleet:
    def __init__(self, config: Any):
        self.config = config
        if config.ble_gatt_profile == "core-v1":
            self.service, self.identity_uuid, self.observation_uuid, self.command_uuid, self.receipt_uuid = (
                CORE_SERVICE, CORE_IDENTITY, CORE_OBSERVATION, CORE_COMMAND, CORE_RECEIPT)
        else:
            self.service, self.identity_uuid, self.observation_uuid, self.command_uuid, self.receipt_uuid = (
                SERVICE, IDENTITY, OBSERVATION, COMMAND, RECEIPT)
        self._peers = {device_id: _Peer(device_id, address)
                       for device_id, address in config.ble_devices.items()}
        self._by_address = {peer.address.casefold(): peer for peer in self._peers.values()}
        self._scanner: Any = None
        self._tasks: list[asyncio.Task] = []
        self._callback: Callable[[dict[str, Any]], Awaitable[None]] | None = None
        self._closed = asyncio.Event()

    async def start(self, observation_callback: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        if self._tasks:
            raise RuntimeError("BLE fleet already started")
        self._closed.clear()
        self._callback = observation_callback
        self._tasks.append(asyncio.create_task(self._scan(), name="ble-scan"))
        for peer in self._peers.values():
            self._tasks.append(asyncio.create_task(self._watch(peer), name=f"ble-{peer.device_id}"))
            self._tasks.append(asyncio.create_task(self._deliver(peer), name=f"ble-data-{peer.device_id}"))

    def _detected(self, device: Any, advertisement: Any) -> None:
        peer = self._by_address.get(device.address.casefold())
        if peer is None:
            return
        # An address is a discovery hint only. The authenticated identity is read
        # after connection and must match the operator's device enrollment.
        peer.discovered = device
        rssi = advertisement.rssi
        peer.rssi = rssi if _integer(rssi, -127, 20) else None
        peer.rssi_monotonic = time.monotonic()
        peer.seen.set()

    async def _scan(self) -> None:
        delay = 1.0
        while not self._closed.is_set():
            try:
                async with BleakScanner(detection_callback=self._detected) as scanner:
                    self._scanner = scanner
                    delay = 1.0
                    await self._closed.wait()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOG.warning("BLE scanner unavailable (%s)", type(exc).__name__)
                await self._pause(delay)
                delay = min(delay * 2, 60.0)
            finally:
                self._scanner = None

    async def _pause(self, seconds: float) -> None:
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._closed.wait(), seconds + random.uniform(0, seconds / 4))

    def _lost(self, peer: _Peer, generation: int | None = None) -> None:
        if generation is not None and generation != peer.generation:
            return
        # Invalidate callbacks immediately, including while handshake/write awaits
        # are still unwinding. A replacement connection gets another generation.
        peer.generation += 1
        peer.ready.clear()
        peer.disconnected.set()
        if peer.pending is not None and not peer.pending.done():
            peer.pending.set_exception(BleUnavailable("BLE disconnected before a matching receipt"))

    def _protocol_failure(self, peer: _Peer, reason: str) -> None:
        peer.last_error = reason
        self._lost(peer)

    @staticmethod
    def _require_session(peer: _Peer, client: Any, generation: int, *, ready: bool = True) -> None:
        if (peer.generation != generation or peer.client is not client or client is None
                or peer.disconnected.is_set() or not client.is_connected
                or (ready and not peer.ready.is_set())):
            raise BleUnavailable("authenticated BLE session changed")

    async def _watch(self, peer: _Peer) -> None:
        delay = 1.0
        while not self._closed.is_set():
            peer.generation += 1
            generation = peer.generation
            peer.ready.clear()
            try:
                await asyncio.wait_for(peer.seen.wait(), self.config.ble_scan_seconds)
                peer.disconnected.clear()
                peer.identity = {}
                peer.anchor = None
                peer.last_sequence = -1
                peer.observation_frames = _Frames()
                peer.receipt_frames = _Frames()
                client = BleakClient(peer.discovered, pair=self.config.ble_pair,
                                     timeout=max(30.0, self.config.request_timeout),
                                     disconnected_callback=lambda _, session=generation: self._lost(peer, session))
                async with client:
                    peer.client = client
                    self._require_session(peer, client, generation, ready=False)
                    if client.services.get_service(self.service) is None:
                        raise BleProtocolError("required service missing")
                    identity = _object(await client.read_gatt_char(self.identity_uuid), 512)
                    self._require_session(peer, client, generation, ready=False)
                    required = {"version", "deviceId", "firmwareRevision", "boardRevision", "bootId"}
                    if set(identity) != required or type(identity.get("version")) is not int or identity["version"] != 1:
                        raise BleProtocolError("invalid identity shape")
                    if identity.get("deviceId") != peer.device_id:
                        raise BleProtocolError("identity does not match enrollment")
                    if any(not isinstance(identity.get(key), str) or not 1 <= len(identity[key]) <= 64
                           for key in ("firmwareRevision", "boardRevision", "bootId")):
                        raise BleProtocolError("invalid identity revision")
                    if IDENTIFIER.fullmatch(identity["bootId"]) is None:
                        raise BleProtocolError("invalid identity boot ID")
                    allowed = self.config.firmware_revision_allowlist
                    if allowed and identity["firmwareRevision"] not in allowed:
                        raise BleProtocolError("firmware revision not allowed")
                    peer.identity = identity
                    await client.start_notify(self.receipt_uuid,
                        lambda _, data, session=generation: self._receipt_fragment(peer, data, session))
                    self._require_session(peer, client, generation, ready=False)
                    await client.start_notify(self.observation_uuid,
                        lambda _, data, session=generation: self._observation_fragment(peer, data, session))
                    self._require_session(peer, client, generation, ready=False)
                    # READ supplies the complete current value; NOTIFY supplies LF
                    # framed fragments. These paths intentionally do not mix buffers.
                    current = _object(await client.read_gatt_char(self.observation_uuid), 512)
                    self._require_session(peer, client, generation, ready=False)
                    self._queue_observation(peer, current)
                    self._require_session(peer, client, generation, ready=False)
                    peer.ready.set()
                    peer.last_error = None
                    delay = 1.0
                    await peer.disconnected.wait()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                peer.last_error = type(exc).__name__
                LOG.warning("BLE reconnect scheduled for %s (%s)", peer.device_id, type(exc).__name__)
            finally:
                self._lost(peer, generation)
                peer.client = None
                peer.seen.clear()
            if not self._closed.is_set():
                await self._pause(delay)
                delay = min(delay * 2, 60.0)

    def _observation_fragment(self, peer: _Peer, data: bytearray, generation: int | None = None) -> None:
        if generation is not None and generation != peer.generation:
            return
        try:
            for frame in peer.observation_frames.feed(data):
                self._queue_observation(peer, frame)
        except (BleProtocolError, ValueError, TypeError):
            self._protocol_failure(peer, "invalid_observation")

    def _queue_observation(self, peer: _Peer, frame: dict[str, Any]) -> None:
        required = {"version", "deviceId", "bootId", "sequence", "uptimeMs", "battery",
                    "buttonState", "sensorValues", "state"}
        if (set(frame) != required or type(frame.get("version")) is not int or frame["version"] != 1
                or frame.get("deviceId") != peer.device_id
                or frame.get("bootId") != peer.identity.get("bootId")
                or not _integer(frame.get("sequence"), maximum=4294967295)
                or not _integer(frame.get("uptimeMs"), maximum=MAX_UPTIME_MS)
                or frame.get("buttonState") not in {"released", "confirm", "panic"}
                or type(frame.get("state")) is not bool
                or not isinstance(frame.get("sensorValues"), dict)):
            raise BleProtocolError("invalid observation fields")
        battery = frame["battery"]
        if battery is not None and (type(battery) not in (int, float)
                                    or not 0 <= battery <= 100 or not math.isfinite(battery)):
            raise BleProtocolError("invalid battery reading")
        if "ina219" in frame["sensorValues"]:
            _power_reading(frame["sensorValues"]["ina219"], frame["uptimeMs"])
        if frame["sequence"] <= peer.last_sequence:
            return
        received = datetime.now(timezone.utc)
        peer.last_sequence = frame["sequence"]
        peer.anchor = (frame["bootId"], frame["uptimeMs"], received, time.monotonic())
        rssi_fresh = (peer.rssi_monotonic is not None
                      and time.monotonic() - peer.rssi_monotonic <= 30.0)
        normalized = {
            "version": 1, "gatewayId": self.config.gateway_id, "deviceId": peer.device_id,
            "bootId": frame["bootId"], "sequence": frame["sequence"],
            "observedAt": _utc(received), "receivedAt": _utc(received),
            "rssi": peer.rssi if rssi_fresh else None, "battery": battery,
            "buttonState": frame["buttonState"], "sensorValues": frame["sensorValues"],
            "state": frame["state"], "firmwareRevision": peer.identity["firmwareRevision"],
            "timestampSource": "gateway-received",
        }
        try:
            peer.observations.put_nowait(normalized)
        except asyncio.QueueFull:
            peer.dropped_observations += 1
            self._protocol_failure(peer, "observation_backpressure")
            LOG.error("BLE observation queue full for %s; session interrupted", peer.device_id)

    async def _deliver(self, peer: _Peer) -> None:
        # Keep the current observation in memory until the durable queue accepts
        # it. A full queue disconnects the peer instead of growing unboundedly.
        while not self._closed.is_set():
            observation = await peer.observations.get()
            while not self._closed.is_set():
                try:
                    assert self._callback is not None
                    await self._callback(observation)
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    peer.last_error = "observation_storage_unavailable"
                    LOG.error("Observation persistence failed (%s)", type(exc).__name__)
                    await self._pause(2.0)
            peer.observations.task_done()

    def _receipt_fragment(self, peer: _Peer, data: bytearray, generation: int | None = None) -> None:
        if generation is not None and generation != peer.generation:
            return
        try:
            for frame in peer.receipt_frames.feed(data):
                required = {"version", "deviceId", "bootId", "commandId", "payloadHash", "ackCode",
                            "acceptedUptimeMs", "appliedUptimeMs", "readback", "firmwareRevision"}
                if (set(frame) != required or type(frame.get("version")) is not int or frame["version"] != 1
                        or frame.get("deviceId") != peer.device_id
                        or not isinstance(frame.get("bootId"), str)
                        or IDENTIFIER.fullmatch(frame["bootId"]) is None
                        or not isinstance(frame.get("commandId"), str)
                        or not isinstance(frame.get("payloadHash"), str)
                        or frame.get("ackCode") not in ACK_CODES
                        or (frame.get("acceptedUptimeMs") is not None
                            and not _integer(frame["acceptedUptimeMs"], maximum=MAX_UPTIME_MS))
                        or (frame.get("appliedUptimeMs") is not None
                            and not _integer(frame["appliedUptimeMs"], maximum=MAX_UPTIME_MS))
                        or not isinstance(frame.get("readback"), dict)
                        or set(frame["readback"]) != {"state"}
                        or type(frame["readback"]["state"]) is not bool
                        or frame.get("firmwareRevision") != peer.identity.get("firmwareRevision")):
                    raise BleProtocolError("invalid receipt fields")
                if (frame["commandId"] != peer.pending_command or frame["payloadHash"] != peer.pending_hash):
                    # An old notification cannot settle the current command.
                    continue
                if peer.pending is not None and not peer.pending.done():
                    peer.pending.set_result(frame)
        except (BleProtocolError, ValueError, TypeError):
            self._protocol_failure(peer, "invalid_receipt")

    def _receipt_times(self, peer: _Peer, receipt: dict[str, Any]) -> dict[str, Any]:
        result = dict(receipt)
        result.update(acceptedAt=None, appliedAt=None, timestampSource="unavailable")
        anchor = peer.anchor
        if anchor is None or anchor[0] != receipt["bootId"] or time.monotonic() - anchor[3] > 60:
            return result
        for source, target in (("acceptedUptimeMs", "acceptedAt"), ("appliedUptimeMs", "appliedAt")):
            value = receipt[source]
            if value is not None and abs(value - anchor[1]) <= 60_000:
                result[target] = _utc(anchor[2] + timedelta(milliseconds=value - anchor[1]))
        if result["acceptedAt"] is not None or result["appliedAt"] is not None:
            result["timestampSource"] = "gateway-estimated"
        return result

    async def execute(self, command_dict: dict[str, Any], remaining_ms: int, payload_hash: str) -> dict[str, Any]:
        peer = self._peers.get(command_dict["deviceId"])
        if peer is None:
            raise BleUnavailable("device is not enrolled")
        if not _integer(remaining_ms, 1, 30_000):
            raise ValueError("remaining_ms must be between 1 and 30000")
        expires = time.monotonic() + remaining_ms / 1000
        async with asyncio.timeout(min(self.config.ble_command_timeout, remaining_ms / 1000)):
            async with peer.lock:
                client, generation = peer.client, peer.generation
                self._require_session(peer, client, generation)
                wire = {
                    "version": 1, "type": "command", "deviceId": peer.device_id,
                    "commandId": command_dict["commandId"], "desiredState": command_dict["desiredState"],
                    "grantRevision": command_dict["grantRevision"], "ownershipEpoch": command_dict["ownershipEpoch"],
                    "payloadHash": payload_hash, "remainingMs": max(1, int((expires - time.monotonic()) * 1000)),
                }
                raw = json.dumps(wire, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n"
                if len(raw) > MAX_FRAME:
                    raise ValueError("command exceeds BLE frame size")
                pending = asyncio.get_running_loop().create_future()
                peer.pending = pending
                peer.pending_command, peer.pending_hash = command_dict["commandId"], payload_hash
                try:
                    async with asyncio.timeout(min(self.config.ble_command_timeout,
                                                   max(0.001, expires - time.monotonic()))):
                        for offset in range(0, len(raw), 20):
                            self._require_session(peer, client, generation)
                            await client.write_gatt_char(self.command_uuid, raw[offset:offset + 20], response=True)
                            self._require_session(peer, client, generation)
                        receipt = await pending
                    self._require_session(peer, client, generation)
                    return self._receipt_times(peer, receipt)
                except BaseException:
                    # An interrupted partial frame must never be joined to a later
                    # command. Reconnect clears the firmware RX frame state.
                    self._lost(peer, generation)
                    raise
                finally:
                    if not pending.done():
                        pending.cancel()
                    elif not pending.cancelled():
                        pending.exception()  # Consume disconnect errors on cancelled writes.
                    if peer.pending is pending:
                        peer.pending = None
                        peer.pending_command = peer.pending_hash = None

    async def capture_journal(self, device_id: str) -> dict[str, Any]:
        """Explicit read-only maintenance capture, serialized with device commands."""
        from .journal_export import capture
        peer = self._peers.get(device_id)
        if peer is None:
            raise BleUnavailable("device is not enrolled")
        async with peer.lock:
            client, generation = peer.client, peer.generation
            identity = dict(peer.identity)
            self._require_session(peer, client, generation)
            result = await capture(client, identity, self.config.ble_gatt_profile)
            current = _object(await client.read_gatt_char(self.identity_uuid), 512)
            self._require_session(peer, client, generation)
            if current != identity:
                raise BleUnavailable("device session changed during journal capture")
            return result

    def snapshot(self) -> list[dict[str, Any]]:
        return [{"deviceId": peer.device_id, "connected": peer.ready.is_set(),
                 "firmwareRevision": peer.identity.get("firmwareRevision"),
                 "boardRevision": peer.identity.get("boardRevision"),
                 "bootId": peer.identity.get("bootId"), "lastError": peer.last_error,
                 "droppedObservations": peer.dropped_observations,
                 "pendingObservations": peer.observations.qsize()}
                for peer in self._peers.values()]

    async def close(self) -> None:
        self._closed.set()
        for peer in self._peers.values():
            self._lost(peer)
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
