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
from datetime import datetime, timedelta
from typing import Any, AsyncIterator, Awaitable, Callable

from bleak import BleakClient, BleakScanner
from .core_bridge import CORE_SERVICE, CORE_IDENTITY, CORE_OBSERVATION, CORE_COMMAND, CORE_RECEIPT
from .model import (ObservationHead, button_presses_regressed, iso_time, observation_button_presses,
                    utc_now, valid_battery_alert)

LOG = logging.getLogger(__name__)
SERVICE = "8b8f0001-8e7a-4f36-a8c2-1c9b5d620001"
IDENTITY = "8b8f0002-8e7a-4f36-a8c2-1c9b5d620001"
OBSERVATION = "8b8f0003-8e7a-4f36-a8c2-1c9b5d620001"
COMMAND = "8b8f0004-8e7a-4f36-a8c2-1c9b5d620001"
RECEIPT = "8b8f0005-8e7a-4f36-a8c2-1c9b5d620001"
MAX_FRAME = 4096
FRAME_TIMEOUT = 5.0
GATT_SETUP_TIMEOUT = 30.0
BLE_DISCONNECT_TIMEOUT = 15.0
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\Z")
MAX_UPTIME_MS = 9007199254740991
RECEIPT_ANCHOR_MAX_AGE = 60.0
RECEIPT_CLOCK_STEP_TOLERANCE = 2.0
ACK_CODES = frozenset({
    "APPLIED", "DUPLICATE", "REJECTED_EPOCH", "REJECTED_GRANT", "EXPIRED",
    "CONFLICT", "INVALID", "JOURNAL_FULL", "STORAGE_ERROR", "INDETERMINATE",
    "READBACK_MISMATCH",
})


class BleProtocolError(RuntimeError):
    """Peer data does not satisfy the agreed wire format."""


class BleUnavailable(ConnectionError):
    """An enrolled keyring currently has no authenticated GATT session."""


class BleHandshakeTimeout(BleUnavailable):
    """The connected keyring did not finish GATT setup in time."""

def _r18_bringup(identity: dict[str, Any]) -> bool:
    return identity["boardRevision"] == "r18-hand-solder" and identity["firmwareRevision"].endswith("-bringup")


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
    command_writable: bool = False
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    seen: asyncio.Event = field(default_factory=asyncio.Event)
    disconnected: asyncio.Event = field(default_factory=asyncio.Event)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    identity: dict[str, Any] = field(default_factory=dict)
    observation_frames: _Frames = field(default_factory=_Frames)
    observation_timeout: asyncio.Timeout | None = None
    receipt_frames: _Frames = field(default_factory=_Frames)
    observations: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=128))
    pending: asyncio.Future | None = None
    pending_command: str | None = None
    pending_hash: str | None = None
    pending_final_write_at: float | None = None
    pending_receipt_deadline: float | None = None
    pending_on_receipt: Callable[[dict[str, Any]], None] | None = None
    anchor: tuple[str, int, datetime, float] | None = None
    # The latest queued boot, sequence and uptime survive a BLE reconnect.
    observation_watermark: tuple[str, int, int | None] | None = None
    button_presses: tuple[int, int] | None = None
    rssi: int | None = None
    rssi_monotonic: float | None = None
    last_error: str | None = None
    dropped_observations: int = 0


class BleFleet:
    def __init__(self, config: Any):
        self.config = config
        self._observation_timeout = getattr(config, "ble_observation_timeout", 30.0)
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
        self._trace: Callable[[dict[str, Any]], None] | None = None
        self._trace_observation = False
        self._closed = asyncio.Event()

    async def start(self, observation_callback: Callable[[dict[str, Any]], Awaitable[None]], *,
                    trace: Callable[[dict[str, Any]], None] | None = None,
                    trace_observation: bool = False,
                    observation_heads: dict[str, ObservationHead] | None = None) -> None:
        if self._tasks:
            raise RuntimeError("BLE fleet already started")
        self._closed.clear()
        self._callback = observation_callback
        self._trace = trace
        self._trace_observation = trace_observation
        committed = observation_heads or {}
        self._tasks.append(asyncio.create_task(self._scan(), name="ble-scan"))
        for peer in self._peers.values():
            head = committed.get(peer.device_id)
            peer.observation_watermark = (head[0], head[1], None) if head is not None else None
            peer.button_presses = head[2] if head is not None and len(head) == 3 else None
            self._tasks.append(asyncio.create_task(self._watch(peer), name=f"ble-{peer.device_id}"))
            self._tasks.append(asyncio.create_task(self._deliver(peer), name=f"ble-data-{peer.device_id}"))

    def _trace_event(self, peer: _Peer, event: str, **fields: Any) -> None:
        if self._trace is None:
            return
        try:
            self._trace({"event": event, "atNs": time.monotonic_ns(), "generation": peer.generation,
                         "bootId": peer.identity["bootId"], "boardRevision": peer.identity["boardRevision"],
                         **fields})
        except Exception:
            LOG.error("BLE diagnostic trace sink failed")

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
        if peer.ready.is_set():
            self._trace_event(peer, "lost")
        # Invalidate callbacks immediately, including while handshake/write awaits
        # are still unwinding. A replacement connection gets another generation.
        peer.generation += 1
        peer.ready.clear()
        peer.command_writable = False
        peer.anchor = None
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
                or (ready and not peer.ready.is_set())
                or (peer.observation_timeout is not None and peer.observation_timeout.expired())):
            raise BleUnavailable("authenticated BLE session changed")

    @contextlib.asynccontextmanager
    async def _connection(self, peer: _Peer, client: Any, generation: int) -> AsyncIterator[None]:
        try:
            await client.connect()
            peer.client = client
            yield
        finally:
            # Fence the old callbacks even if BlueZ does not complete disconnect.
            self._lost(peer, generation)
            try:
                async with asyncio.timeout(BLE_DISCONNECT_TIMEOUT):
                    await client.disconnect()
            except Exception as exc:
                LOG.warning("BLE disconnect incomplete for %s (%s)", peer.device_id, type(exc).__name__)

    async def _prepare_gatt(self, peer: _Peer, client: Any, generation: int) -> tuple[bool, str | None]:
        self._require_session(peer, client, generation, ready=False)
        service = client.services.get_service(self.service)
        if service is None:
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
        board = getattr(self.config, "ble_board_revision", None)
        if board is not None and identity["boardRevision"] != board:
            raise BleProtocolError("board revision does not match enrollment")
        peer.identity = identity
        command_ready = False
        handshake_error = None
        # BlueZ may still list writable handles from the full image.
        if getattr(self.config, "commands_enabled", True) and not _r18_bringup(identity):
            command = service.get_characteristic(self.command_uuid)
            if command is not None and "write" in command.properties:
                receipt = service.get_characteristic(self.receipt_uuid)
                if receipt is not None and not {"notify", "indicate"}.isdisjoint(receipt.properties):
                    await client.start_notify(self.receipt_uuid,
                        lambda _, data: self._receipt_fragment(peer, data, generation))
                    self._require_session(peer, client, generation, ready=False)
                    command_ready = True
                else:
                    handshake_error = "receipt_characteristic_unavailable"
        # BlueZ emits READ values through PropertiesChanged as well. Read before
        # subscribing so full JSON cannot enter the LF-framed notification buffer.
        current = _object(await client.read_gatt_char(self.observation_uuid), 512)
        self._require_session(peer, client, generation, ready=False)
        self._queue_observation(peer, current)
        self._require_session(peer, client, generation, ready=False)
        await client.start_notify(self.observation_uuid,
            lambda _, data: self._observation_fragment(peer, data, generation))
        self._require_session(peer, client, generation, ready=False)
        return command_ready, handshake_error

    async def _watch(self, peer: _Peer) -> None:
        delay = 1.0
        while not self._closed.is_set():
            peer.generation += 1
            generation = peer.generation
            peer.ready.clear()
            try:
                # Keep discovery in this task so cancellation reaches the watcher
                # even when an advertisement completes at the same time.
                async with asyncio.timeout(self.config.ble_scan_seconds):
                    await peer.seen.wait()
                peer.disconnected.clear()
                peer.identity = {}
                peer.observation_frames = _Frames()
                peer.receipt_frames = _Frames()
                client = BleakClient(peer.discovered, pair=self.config.ble_pair,
                                     timeout=max(30.0, self.config.request_timeout),
                                     disconnected_callback=lambda _, session=generation: self._lost(peer, session))
                async with self._connection(peer, client, generation):
                    try:
                        async with asyncio.timeout(GATT_SETUP_TIMEOUT):
                            command_ready, handshake_error = await self._prepare_gatt(peer, client, generation)
                    except TimeoutError as exc:
                        raise BleHandshakeTimeout("GATT setup did not complete before its deadline") from exc
                    peer.command_writable = command_ready
                    peer.ready.set()
                    peer.last_error = handshake_error
                    if self._trace is not None:
                        age = None if peer.rssi_monotonic is None else time.monotonic() - peer.rssi_monotonic
                        fresh = peer.rssi is not None and age is not None and 0 <= age <= 30
                        self._trace_event(peer, "ready", commandReady=peer.command_writable,
                                          advertisingRssiDbm=peer.rssi if fresh else None,
                                          advertisingAgeMs=round(age * 1000) if fresh else None)
                    delay = 1.0
                    try:
                        async with asyncio.timeout(self._observation_timeout) as timeout:
                            peer.observation_timeout = timeout
                            await peer.disconnected.wait()
                    except TimeoutError:
                        self._protocol_failure(peer, "observation_notification_timeout")
                        LOG.warning("BLE observation notifications timed out for %s", peer.device_id)
                    finally:
                        peer.observation_timeout = None
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
                self._queue_observation(peer, frame, notification=True)
        except (BleProtocolError, ValueError, TypeError):
            self._protocol_failure(peer, "invalid_observation")

    def _queue_observation(self, peer: _Peer, frame: dict[str, Any], *, notification: bool = False) -> None:
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
        if not valid_battery_alert(battery, frame["sensorValues"]):
            raise BleProtocolError("invalid battery alert for the reported charge")
        if "ina219" in frame["sensorValues"]:
            _power_reading(frame["sensorValues"]["ina219"], frame["uptimeMs"])
        boot_id, sequence, device_uptime = frame["bootId"], frame["sequence"], frame["uptimeMs"]
        presses = observation_button_presses(frame["sensorValues"])
        previous = peer.observation_watermark
        previous_presses = None
        if previous is not None and previous[0] == boot_id:
            if sequence <= previous[1]:
                return
            if previous[2] is not None and device_uptime < previous[2]:
                raise BleProtocolError("observation uptime regressed within the same boot")
            previous_presses = peer.button_presses
            if button_presses_regressed(previous_presses, presses):
                raise BleProtocolError("button press counts regressed within the same boot")
        received = utc_now()
        received_monotonic = time.monotonic()
        rssi_fresh = (peer.rssi_monotonic is not None
                      and received_monotonic - peer.rssi_monotonic <= 30.0)
        normalized = {
            "version": 1, "gatewayId": self.config.gateway_id, "deviceId": peer.device_id,
            "bootId": frame["bootId"], "sequence": frame["sequence"],
            "observedAt": iso_time(received), "receivedAt": iso_time(received),
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
        else:
            peer.observation_watermark = (boot_id, sequence, device_uptime)
            peer.button_presses = presses if presses is not None else previous_presses
            peer.anchor = (boot_id, device_uptime, received, received_monotonic)
            timeout = peer.observation_timeout
            if notification and timeout is not None and not timeout.expired():
                timeout.reschedule(asyncio.get_running_loop().time() + self._observation_timeout)
            if notification and peer.ready.is_set() and self._trace is not None:
                fields = {"sequence": frame["sequence"]}
                sensor = frame["sensorValues"]
                if "batteryAlert" in sensor:
                    fields.update(batteryPercent=battery, batteryAlert=sensor["batteryAlert"])
                wake, pins = sensor.get("wake"), sensor.get("wakePins")
                if (sensor.get("detail") == "health" and wake in ("cold", "motion", "button", "timer", "other")
                        and _integer(pins, maximum=2**64 - 1)):
                    fields.update(wakeCause=wake, wakePins=pins, deviceUptimeMs=frame["uptimeMs"])
                if sensor.get("detail") == "energy" or "ina219" in sensor:
                    fields.update(ina219=sensor.get("ina219"), deviceUptimeMs=frame["uptimeMs"])
                if self._trace_observation:
                    fields["observation"] = frame
                self._trace_event(peer, "notification", **fields)

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
        received_at = time.monotonic()
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
                    if (peer.pending_final_write_at is None or peer.pending_receipt_deadline is None
                            or received_at >= peer.pending_receipt_deadline):
                        continue
                    if frame["ackCode"] == "APPLIED" and frame["bootId"] != peer.identity.get("bootId"):
                        # Fresh applies use the current boot. Journal replays use their original boot and result code.
                        self._protocol_failure(peer, "receipt_boot_mismatch")
                        return
                    result = self._receipt_times(peer, frame, received_monotonic=received_at)
                    # BlueZ can deliver the receipt before completing the final WRITE.
                    if peer.pending_on_receipt is not None:
                        peer.pending_on_receipt(result)
                    peer.pending.set_result(result)
        except (BleProtocolError, ValueError, TypeError):
            self._protocol_failure(peer, "invalid_receipt")

    def _receipt_times(self, peer: _Peer, receipt: dict[str, Any], *,
                       received_monotonic: float | None = None) -> dict[str, Any]:
        if received_monotonic is None:
            received_monotonic = time.monotonic()
        received = utc_now()
        result = dict(receipt)
        result.update(receivedAt=iso_time(received), acceptedAt=None, appliedAt=None, timestampSource="unavailable")
        anchor = peer.anchor
        accepted, applied = receipt["acceptedUptimeMs"], receipt["appliedUptimeMs"]
        if anchor is None or anchor[0] != receipt["bootId"] or accepted is None:
            return result
        _, anchor_uptime, anchor_wall, anchor_monotonic = anchor
        age = received_monotonic - anchor_monotonic
        if (not 0 <= age <= RECEIPT_ANCHOR_MAX_AGE
                or abs((received - anchor_wall).total_seconds() - age) > RECEIPT_CLOCK_STEP_TOLERANCE):
            return result
        offsets = [(accepted - anchor_uptime) / 1000]
        if applied is not None:
            if applied < accepted:
                return result
            offsets.append((applied - anchor_uptime) / 1000)
        if any(abs(offset) > RECEIPT_ANCHOR_MAX_AGE for offset in offsets):
            return result
        elapsed = [offset - age for offset in offsets]
        if elapsed[-1] > 0:
            return result
        # A fresh apply can only be accepted after the last command fragment starts.
        # Journal replays can report earlier device times.
        if receipt["ackCode"] == "APPLIED" and (peer.pending_final_write_at is None
                or elapsed[0] < peer.pending_final_write_at - received_monotonic):
            return result
        result.update(acceptedAt=iso_time(received + timedelta(seconds=elapsed[0])),
                      appliedAt=iso_time(received + timedelta(seconds=elapsed[1])) if applied is not None else None,
                      timestampSource="gateway-estimated")
        return result

    def command_session(self, device_id: str) -> int | None:
        peer = self._peers.get(device_id)
        if peer is None or not peer.command_writable:
            return None
        try:
            self._require_session(peer, peer.client, peer.generation)
        except BleUnavailable:
            return None
        return peer.generation

    async def execute(self, command_dict: dict[str, Any], remaining_ms: int, payload_hash: str,
                      *, expected_generation: int | None = None, deadline_monotonic: float | None = None,
                      before_write: Callable[[], None] | None = None,
                      on_receipt: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        peer = self._peers.get(command_dict["deviceId"])
        if peer is None:
            raise BleUnavailable("device is not enrolled")
        if not _integer(remaining_ms, 1, 30_000):
            raise ValueError("remaining_ms must be between 1 and 30000")
        now = time.monotonic()
        expires = now + remaining_ms / 1000
        if deadline_monotonic is not None:
            expires = min(expires, deadline_monotonic)
        if expires <= now:
            raise asyncio.TimeoutError("dispatch deadline elapsed before BLE")
        timeout = min(self.config.ble_command_timeout, expires - now)
        pending = asyncio.get_running_loop().create_future()
        try:
            async with asyncio.timeout(timeout), peer.lock:
                client = peer.client
                generation = peer.generation if expected_generation is None else expected_generation
                self._require_session(peer, client, generation)
                if not peer.command_writable:
                    raise BleUnavailable("authenticated BLE session does not support command writes")
                wire_remaining = int((expires - time.monotonic()) * 1000)
                if wire_remaining <= 0:
                    raise asyncio.TimeoutError("dispatch deadline elapsed while waiting for BLE")
                wire = {
                    "version": 1, "type": "command", "deviceId": peer.device_id,
                    "commandId": command_dict["commandId"], "desiredState": command_dict["desiredState"],
                    "grantRevision": command_dict["grantRevision"], "ownershipEpoch": command_dict["ownershipEpoch"],
                    "payloadHash": payload_hash, "remainingMs": wire_remaining,
                }
                raw = json.dumps(wire, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n"
                if len(raw) > MAX_FRAME:
                    raise ValueError("command exceeds BLE frame size")
                peer.pending = pending
                peer.pending_command, peer.pending_hash = command_dict["commandId"], payload_hash
                peer.pending_final_write_at = None
                peer.pending_receipt_deadline = now + timeout
                peer.pending_on_receipt = on_receipt
                try:
                    for offset in range(0, len(raw), 20):
                        self._require_session(peer, client, generation)
                        if before_write is not None:
                            before_write()
                        write_at = time.monotonic()
                        if write_at >= expires:
                            raise asyncio.TimeoutError("dispatch deadline elapsed during BLE")
                        final = offset + 20 >= len(raw)
                        if final:
                            peer.pending_final_write_at = write_at
                        await client.write_gatt_char(self.command_uuid, raw[offset:offset + 20], response=True)
                        if not final or not pending.done():
                            self._require_session(peer, client, generation)
                    return await pending
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
                        peer.pending_final_write_at = None
                        peer.pending_receipt_deadline = None
                        peer.pending_on_receipt = None
        except Exception as exc:
            # The notification confirms the result even if the last GATT response is lost.
            if pending.done() and not pending.cancelled() and pending.exception() is None:
                LOG.info("BLE transport ended after a matching receipt (%s)", type(exc).__name__)
                return pending.result()
            raise

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
                 "commandReady": self.command_session(peer.device_id) is not None,
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
