"""Long-running edge orchestration. Authorization fails closed on uncertainty."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import uuid
from collections import Counter
from pathlib import Path

from .ble import BleFleet
from .config import GatewayConfig, ID
from .model import (authorization_deadline, canonical, iso_time, parse_time,
                    payload_hash, utc_now, validate_command, validate_observation)
from .store import CapacityError, Store
from .transport import TransportHub

LOG = logging.getLogger(__name__)
DEVICE_ACKS = {"APPLIED", "DUPLICATE", "REJECTED_EPOCH", "REJECTED_GRANT", "EXPIRED",
               "CONFLICT", "INVALID", "JOURNAL_FULL", "STORAGE_ERROR", "INDETERMINATE", "READBACK_MISMATCH"}


class Gateway:
    def __init__(self, config: GatewayConfig):
        self.config = config
        from .state_identity import configured_binding
        self.store = Store(config.database, config.max_outbox_rows, config.max_outbox_bytes,
                           config.max_commands, configured_binding(config))
        self.transport = TransportHub(config)
        self.ble = BleFleet(config)
        self.stop = asyncio.Event()
        self.boot_id = str(uuid.uuid4())
        self.started = time.monotonic()
        self.clock_anchor = time.time() - self.started
        self.clock_trusted = True
        self.credential_status = "UNKNOWN"
        self.credential_revision: str | None = None
        self.credential_checked = float("-inf")
        self.counters: Counter = Counter()
        self.runtime_digest = self._runtime_digest()

    def _runtime_digest(self) -> str:
        digest = hashlib.sha256()
        for path in sorted(Path(__file__).parent.glob("*.py")):
            digest.update(path.name.encode("utf-8"))
            digest.update(path.read_bytes())
        public_configuration = {
            "gatewayId": self.config.gateway_id, "originator": self.config.originator,
            "cseId": self.config.cse_id, "cseUrl": self.config.cse_url,
            "apiUrl": self.config.api_url, "rvi": self.config.rvi,
            "mqttEnabled": self.config.mqtt_enabled, "mqttHost": self.config.mqtt_host,
            "mqttWrappedPrimitive": self.config.mqtt_wrapped_primitive,
            "coreBridgeEnabled": self.config.core_bridge_enabled,
            "bleGattProfile": self.config.ble_gatt_profile,
            "devices": self.config.ble_devices,
            "firmwareAllowlist": self.config.firmware_revision_allowlist,
        }
        digest.update(canonical(public_configuration).encode("utf-8"))
        # Public certificate digest helps distinguish rotations; never read the private key here.
        digest.update(self.config.cert_file.read_bytes())
        return digest.hexdigest()

    async def _pause(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self.stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    def _clock_ok(self) -> bool:
        if abs((time.time() - time.monotonic()) - self.clock_anchor) > 2:
            self.clock_trusted = False
        return self.clock_trusted

    def _credentials_active(self) -> bool:
        return (self.credential_status == "ACTIVE"
                and time.monotonic() - self.credential_checked <= self.config.credential_ttl)

    def _receipt(self, command: dict, digest: str, status: str, code: str,
                 detail: str | None = None, device: dict | None = None) -> dict:
        receipt = {
            "version": 1, "gatewayId": self.config.gateway_id,
            "deviceId": command["deviceId"], "commandId": command["commandId"],
            "payloadHash": digest, "status": status, "ackCode": code,
            "acceptedAt": None, "appliedAt": None, "receivedAt": iso_time(),
            "readback": None, "firmwareRevision": None,
            "ownershipEpoch": command["ownershipEpoch"], "grantRevision": command["grantRevision"],
            "timestampSource": "unavailable", "detail": detail, "bootId": None,
        }
        if device:
            receipt.update(readback=device["readback"], firmwareRevision=device["firmwareRevision"], bootId=device["bootId"])
            if device.get("timestampSource") == "gateway-estimated":
                accepted, applied = device.get("acceptedAt"), device.get("appliedAt")
                for timestamp in (accepted, applied):
                    if timestamp is not None:
                        parse_time(timestamp)
                if accepted is not None:
                    receipt.update(acceptedAt=accepted, appliedAt=applied, timestampSource="gateway-estimated")
        return receipt

    def _finish(self, command: dict, digest: str, status: str, code: str,
                detail: str | None = None, device: dict | None = None) -> None:
        self.store.finish(command["commandId"], self._receipt(command, digest, status, code, detail, device))
        self.counters[f"command_{status.lower()}"] += 1

    async def observation(self, raw: dict) -> None:
        try:
            payload = validate_observation(raw, self.config.gateway_id, self.config.ble_devices)
            if self.store.observation(self.config.observation_container, payload, self.config.core_bridge_enabled):
                self.counters["observations_queued"] += 1
            else:
                self.counters["observations_duplicate"] += 1
        except CapacityError:
            self.counters["observations_deferred_capacity"] += 1
            LOG.warning("Observation queue full; existing durable entries retained")
            raise
        except (ValueError, TypeError, OverflowError):
            self.counters["observations_invalid"] += 1
            LOG.warning("Rejected invalid observation")

    async def _credentials_loop(self) -> None:
        while not self.stop.is_set():
            try:
                result = await self.transport.credential_status()
                if (not isinstance(result, dict) or set(result) != {"gatewayId", "credentialRevision", "status"}
                        or result["gatewayId"] != self.config.gateway_id
                        or result["status"] not in {"ACTIVE", "LOST", "REVOKED"}
                        or not isinstance(result["credentialRevision"], str)
                        or not 1 <= len(result["credentialRevision"]) <= 64):
                    raise ValueError("Credential status contract mismatch")
                previous = (self.credential_status, self.credential_revision)
                self.credential_status = result["status"]
                self.credential_revision = result["credentialRevision"]
                self.credential_checked = time.monotonic()
                if previous != (self.credential_status, self.credential_revision):
                    self.counters["credential_changes"] += 1
                    self._enqueue_health()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.credential_status = "UNKNOWN"
                self.counters["credential_errors"] += 1
                LOG.warning("Credential status unavailable (%s); new execution fenced", type(exc).__name__)
            await self._pause(self.config.credential_check_interval)

    async def _poll_loop(self) -> None:
        while not self.stop.is_set():
            try:
                commands = await self.transport.poll_commands()
                if not isinstance(commands, list) or len(commands) > 16:
                    raise ValueError("Command poll contract mismatch")
                for raw in commands:
                    try:
                        command = validate_command(raw, self.config.gateway_id, self.config.ble_devices)
                        digest = payload_hash(command)
                        result = self.store.accept(command, digest)
                        self.counters[f"ingress_{result.lower()}"] += 1
                        if result == "CONFLICT":
                            conflict = self._receipt(command, digest, "REJECTED", "CONFLICT", "Existing commandId has another payload; original journal preserved")
                            self.store.enqueue("conflict", f"{command['commandId']}:{digest}", self.config.receipt_container, conflict, True)
                    except (ValueError, TypeError, OverflowError):
                        self.counters["commands_invalid"] += 1
                        LOG.warning("Rejected command with invalid schema or local binding")
                    except CapacityError:
                        self.counters["ingress_capacity_errors"] += 1
                        LOG.error("Command journal/outbox capacity reached; command not executed")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.counters["poll_errors"] += 1
                LOG.warning("Command polling unavailable (%s)", type(exc).__name__)
            await self._pause(self.config.poll_interval)

    def _validate_device_result(self, raw: dict, command: dict, digest: str) -> None:
        if (not isinstance(raw, dict) or type(raw.get("version")) is not int or raw["version"] != 1
                or raw.get("deviceId") != command["deviceId"]
                or raw.get("commandId") != command["commandId"] or raw.get("payloadHash") != digest
                or raw.get("ackCode") not in DEVICE_ACKS):
            raise ValueError("Device receipt identity mismatch")
        if not isinstance(raw.get("bootId"), str) or not ID.fullmatch(raw["bootId"]):
            raise ValueError("Device receipt boot identity missing")
        if not isinstance(raw.get("firmwareRevision"), str) or not 1 <= len(raw["firmwareRevision"]) <= 64:
            raise ValueError("Device firmware identity missing")
        readback = raw.get("readback")
        if not isinstance(readback, dict) or set(readback) != {"state"} or type(readback["state"]) is not bool:
            raise ValueError("Device readback missing")
        for key in ("acceptedUptimeMs", "appliedUptimeMs"):
            value = raw.get(key)
            if value is not None and (type(value) is not int or not 0 <= value <= 9007199254740991):
                raise ValueError("Invalid device uptime")
        if raw.get("appliedUptimeMs") is not None and raw.get("acceptedUptimeMs") is None:
            raise ValueError("Applied receipt has no acceptance time")
        if raw.get("appliedUptimeMs") is not None and raw["appliedUptimeMs"] < raw["acceptedUptimeMs"]:
            raise ValueError("Device receipt times are reversed")

    async def _dispatch_one(self, command: dict, digest: str) -> None:
        if not self._clock_ok():
            self._finish(command, digest, "REJECTED", "CLOCK_UNTRUSTED", "Wall clock jumped; synchronize clock and restart gateway")
            return
        now = utc_now()
        if parse_time(command["deadline"]) <= now:
            self._finish(command, digest, "REJECTED", "EXPIRED")
            return
        if (parse_time(command["issuedAt"]) - now).total_seconds() > 2:
            self._finish(command, digest, "REJECTED", "CLOCK_UNTRUSTED", "issuedAt is in the future")
            return
        if self.credential_status in {"LOST", "REVOKED"}:
            self._finish(command, digest, "REJECTED", f"CREDENTIAL_{self.credential_status}")
            return
        if not self._credentials_active():
            return  # Persisted pending; retry until credential recovery or command expiry.
        try:
            response = await self.transport.authorize(command, digest)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.counters["authorization_unavailable"] += 1
            LOG.warning("Authorization unavailable (%s); execution deferred", type(exc).__name__)
            return
        try:
            deadline = authorization_deadline(command, digest, response)
        except (ValueError, PermissionError, TypeError, OverflowError):
            self._finish(command, digest, "REJECTED", "NOT_AUTHORIZED", "Current authorization denied or binding invalid")
            return
        if not self._credentials_active() or not self._clock_ok():
            return
        # Conservative margin for scheduling/first-fragment latency. Firmware also counts
        # elapsed time from its first fragment through journal persistence before apply.
        remaining_ms = min(30000, int((deadline - utc_now()).total_seconds() * 1000) - 250)
        if remaining_ms <= 0:
            self._finish(command, digest, "REJECTED", "EXPIRED")
            return
        started = time.monotonic()
        fence_error = self.store.begin_dispatch(command)
        if fence_error:
            self._finish(command, digest, "REJECTED", fence_error)
            return
        try:
            budget_ms = remaining_ms - int((time.monotonic() - started) * 1000)
            if budget_ms <= 0:
                self._finish(command, digest, "REJECTED", "EXPIRED", "Deadline elapsed during durable intent recording; BLE not sent")
                return
            raw = await asyncio.wait_for(self.ble.execute(command, budget_ms, digest),
                                         timeout=min(budget_ms / 1000, self.config.ble_command_timeout))
            self._validate_device_result(raw, command, digest)
            code = raw["ackCode"]
            if code in {"APPLIED", "DUPLICATE"}:
                if raw["readback"]["state"] != command["desiredState"]["state"] or raw.get("appliedUptimeMs") is None:
                    self._finish(command, digest, "INDETERMINATE", "READBACK_MISMATCH", "Device did not confirm requested output at application time", raw)
                else:
                    self._finish(command, digest, "APPLIED", code, device=raw)
            elif code in {"INDETERMINATE", "STORAGE_ERROR", "READBACK_MISMATCH"}:
                self._finish(command, digest, "INDETERMINATE", code, device=raw)
            else:
                self._finish(command, digest, "REJECTED", code, device=raw)
        except asyncio.TimeoutError:
            self._finish(command, digest, "TIMEOUT", "TIMEOUT", "No matching device receipt before timeout; execution may have occurred; no automatic replay")
        except asyncio.CancelledError:
            self._finish(command, digest, "INDETERMINATE", "CANCELLED", "Shutdown interrupted dispatch; no automatic replay")
            raise
        except (ValueError, TypeError, KeyError, OverflowError):
            self._finish(command, digest, "INDETERMINATE", "INVALID_RECEIPT", "Device receipt could not establish a valid result")
        except Exception as exc:
            self._finish(command, digest, "INDETERMINATE", "DEVICE_UNAVAILABLE", f"Dispatch interrupted ({type(exc).__name__}); execution may have occurred")

    async def _dispatch_loop(self) -> None:
        while not self.stop.is_set():
            for item in self.store.pending():
                if self.stop.is_set():
                    return
                await self._dispatch_one(item["command"], item["digest"])
            await self._pause(1)

    async def _outbox_loop(self) -> None:
        while not self.stop.is_set():
            self.store.stage_receipts(self.config.receipt_container, self.config.core_bridge_enabled)
            item = self.store.due()
            if item is None:
                await self._pause(0.5)
                continue
            try:
                await self.transport.publish(item["rqi"], item["container"], item["payload"])
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.counters["publish_retries"] += 1
                self.store.retry(item["rqi"], item["attempts"])
                LOG.warning("oneM2M delivery deferred (%s)", type(exc).__name__)
            else:
                self.store.delivered(item["rqi"])
                self.counters["published"] += 1

    def _enqueue_health(self) -> None:
        outbox, commands = self.store.counts()
        now = iso_time()
        payload = {
            "version": 1, "gatewayId": self.config.gateway_id, "bootId": self.boot_id,
            "observedAt": now, "uptimeSeconds": int(time.monotonic() - self.started),
            "runtimeDigest": self.runtime_digest,
            "credentialStatus": self.credential_status if self._credentials_active() or self.credential_status in {"LOST", "REVOKED"} else "UNKNOWN",
            "credentialRevision": self.credential_revision, "outboxDepth": outbox,
            "commandCount": commands, "devices": self.ble.snapshot(), "counters": dict(self.counters),
        }
        try:
            self.store.enqueue("health", f"{self.boot_id}:{now}", self.config.health_container, payload)
        except CapacityError:
            self.counters["health_dropped_capacity"] += 1

    async def _health_loop(self) -> None:
        while not self.stop.is_set():
            self._enqueue_health()
            await self._pause(self.config.heartbeat_interval)

    async def run(self) -> None:
        tasks: list[asyncio.Task] = []
        try:
            for item in self.store.interrupted():
                self._finish(item["command"], item["digest"], "INDETERMINATE", "RESTART_INTERRUPTED",
                             "Previous process ended during dispatch; journal preserved and command not replayed")
            await self.transport.start()
            await self.ble.start(self.observation)
            tasks = [asyncio.create_task(worker(), name=worker.__name__) for worker in (
                self._credentials_loop, self._poll_loop, self._dispatch_loop, self._outbox_loop, self._health_loop)]
            stop_task = asyncio.create_task(self.stop.wait(), name="stop")
            tasks.append(stop_task)
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if task is not stop_task:
                    task.result()
                    raise RuntimeError(f"Worker {task.get_name()} stopped unexpectedly")
        finally:
            self.stop.set()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            try:
                await self.ble.close()
            finally:
                try:
                    await self.transport.close()
                finally:
                    self.store.close()
