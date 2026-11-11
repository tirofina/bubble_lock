"""Long-running edge orchestration. Authorization fails closed on uncertainty."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import sqlite3
import time
import uuid
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from .ble import BleFleet
from .config import GatewayConfig, ID
from .model import (authorization_deadline, canonical, iso_time, parse_time, payload_hash, utc_now,
                    validate_command, validate_credential_status, validate_observation)
from .store import CapacityError, Store
from .transport import HttpRetryDeferred, NativeDeliveryHold, TransportHub

LOG = logging.getLogger(__name__)
RECEIPT_BURST = 4
CENTRAL_TELEMETRY_CLOCK_MARGIN = 2
CENTRAL_TELEMETRY_EXPIRY_INTERVAL = 5.0
CENTRAL_TELEMETRY_EXPIRY_BATCH = 128
DEVICE_ACKS = {"APPLIED", "DUPLICATE", "REJECTED_EPOCH", "REJECTED_GRANT", "EXPIRED",
               "CONFLICT", "INVALID", "JOURNAL_FULL", "STORAGE_ERROR", "INDETERMINATE", "READBACK_MISMATCH"}


class DispatchBlocked(RuntimeError):
    """The local authority for a GATT write is no longer current."""


class Gateway:
    def __init__(self, config: GatewayConfig):
        self.config = config
        from .state_identity import configured_binding
        self.store = Store(config.database, config.max_outbox_rows, config.max_outbox_bytes,
                           config.max_commands, configured_binding(config))
        self.transport = TransportHub(config, retry_store=self.store)
        self.ble = BleFleet(config)
        self.stop = asyncio.Event()
        self.boot_id = str(uuid.uuid4())
        self.started = time.monotonic()
        self.clock_anchor = time.time() - self.started
        self.clock_trusted = True
        self.credential_status = "UNKNOWN"
        self.credential_revision: str | None = None
        self.credential_checked = float("-inf")
        self.credential_generation = 0
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
            "cseDeploymentId": self.config.cse_deployment_id,
            "receiptContainerRi": self.config.receipt_container_ri,
            "observationContainerRi": self.config.observation_container_ri,
            "apiUrl": self.config.api_url, "pcDispatchStartRequired": self.config.pc_dispatch_start_required,
            "commandsEnabled": self.config.commands_enabled,
            "pcApiDeploymentId": self.config.pc_api_deployment_id,
            "centralReceiptsEnabled": self.config.central_receipts_enabled,
            "centralTelemetryEnabled": self.config.central_telemetry_enabled,
            "centralTelemetryRetentionSeconds": self.config.central_telemetry_retention_seconds,
            "rvi": self.config.rvi,
            "mqttEnabled": self.config.mqtt_enabled, "mqttHost": self.config.mqtt_host,
            "m2mMqttEnabled": self.config.m2m_mqtt_enabled,
            "mqttWrappedPrimitive": self.config.mqtt_wrapped_primitive,
            "coreBridgeEnabled": self.config.core_bridge_enabled,
            "coreTelemetryEpochs": self.config.core_telemetry_epochs,
            "bleGattProfile": self.config.ble_gatt_profile,
            "bleBoardRevision": self.config.ble_board_revision,
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

    def _credentials_active(self, generation: int | None = None) -> bool:
        return (self.credential_status == "ACTIVE"
                and time.monotonic() - self.credential_checked <= self.config.credential_ttl
                and (generation is None or generation == self.credential_generation))

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
            if "receivedAt" in device:
                receipt["receivedAt"] = device["receivedAt"]
            if device.get("timestampSource") == "gateway-estimated" and self._clock_ok():
                accepted, applied = device.get("acceptedAt"), device.get("appliedAt")
                for timestamp in (accepted, applied):
                    if timestamp is not None:
                        parse_time(timestamp)
                if accepted is not None:
                    receipt.update(acceptedAt=accepted, appliedAt=applied, timestampSource="gateway-estimated")
        return receipt

    def _finish(self, command: dict, digest: str, status: str, code: str,
                detail: str | None = None, device: dict | None = None) -> None:
        if self.store.finish(command["commandId"], self._receipt(command, digest, status, code, detail, device)):
            self.counters[f"command_{status.lower()}"] += 1

    async def observation(self, raw: dict) -> None:
        try:
            payload = validate_observation(raw, self.config.gateway_id, self.config.ble_devices)
            if self.store.observation(self.config.observation_container, payload, self.config.core_bridge_enabled,
                                      core_epochs=self.config.core_telemetry_epochs,
                                      central_enabled=self.config.central_telemetry_enabled):
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

    async def _refresh_credentials(self) -> None:
        requested_at = time.monotonic()
        try:
            result = validate_credential_status(await self.transport.credential_status(), self.config.gateway_id)
            previous = (self.credential_status, self.credential_revision)
            current = (result["status"], result["credentialRevision"])
            changed = previous != current
            expired = self.credential_status == "ACTIVE" and not self._credentials_active()
            if changed or expired:
                self.credential_generation += 1
            self.credential_status, self.credential_revision = current
            # The server may have read the status at any point during the request.
            self.credential_checked = requested_at
            if changed:
                self.counters["credential_changes"] += 1
            state = {"status": result["status"], "credentialRevision": result["credentialRevision"]}
            self.store.record_credential_status(state, self._health_payload)
            if changed:
                self._enqueue_health()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self.credential_status != "UNKNOWN":
                self.credential_generation += 1
            self.credential_status = "UNKNOWN"
            self.credential_checked = float("-inf")
            self.counters["credential_errors"] += 1
            if isinstance(exc, CapacityError):
                self.counters["credential_receipt_capacity"] += 1
            LOG.warning("Credential status unavailable (%s); new execution fenced", type(exc).__name__)

    async def _credentials_loop(self) -> None:
        while not self.stop.is_set():
            await self._refresh_credentials()
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
        if "receivedAt" in raw:
            parse_time(raw["receivedAt"])

    def _finish_device_result(self, command: dict, digest: str, raw: dict) -> None:
        try:
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
        except (ValueError, TypeError, KeyError, OverflowError):
            self._finish(command, digest, "INDETERMINATE", "INVALID_RECEIPT", "Device receipt could not establish a valid result")

    async def _dispatch_start_deadline(self, command: dict, digest: str, expires: float) -> datetime:
        remaining = expires - time.monotonic()
        if remaining <= 0:
            raise DispatchBlocked("EXPIRED")
        try:
            async with asyncio.timeout(remaining):
                response = await self.transport.dispatch_start(command, digest)
        except Exception as exc:
            self.counters["dispatch_start_unconfirmed"] += 1
            LOG.warning("Central dispatch start unconfirmed (%s)", type(exc).__name__)
            raise DispatchBlocked("DISPATCH_NOT_SENT") from exc
        try:
            return authorization_deadline(command, digest, response)
        except (ValueError, PermissionError, TypeError, OverflowError) as exc:
            raise DispatchBlocked("NOT_AUTHORIZED") from exc

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
        credential_generation = self.credential_generation
        device_id = command["deviceId"]
        generation = self.ble.command_session(device_id)
        if generation is None:
            self.counters["dispatch_deferred_ble"] += 1
            return
        try:
            response = await self.transport.authorize(command, digest)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.counters["authorization_unavailable"] += 1
            LOG.warning("Authorization unavailable (%s); execution deferred", type(exc).__name__)
            return
        if not self._credentials_active(credential_generation) or not self._clock_ok():
            return
        try:
            deadline = authorization_deadline(command, digest, response)
        except (ValueError, PermissionError, TypeError, OverflowError):
            self._finish(command, digest, "REJECTED", "NOT_AUTHORIZED", "Current authorization denied or binding invalid")
            return
        if self.ble.command_session(device_id) != generation:
            self.counters["dispatch_deferred_ble"] += 1
            return  # Authorize again on the next ready session.
        # Conservative margin for scheduling/first-fragment latency. Firmware also counts
        # elapsed time from its first fragment through journal persistence before apply.
        margin = timedelta(milliseconds=250)
        started = time.monotonic()
        expires = started + min(30.0, (deadline - utc_now() - margin).total_seconds())
        if expires <= started:
            self._finish(command, digest, "REJECTED", "EXPIRED")
            return

        def require_write_authority() -> None:
            if not self._clock_ok():
                raise DispatchBlocked("CLOCK_UNTRUSTED")
            if not self._credentials_active(credential_generation):
                raise DispatchBlocked("CREDENTIAL_CHANGED")
            if deadline - utc_now() <= margin:
                raise DispatchBlocked("EXPIRED")

        fence_error = self.store.begin_dispatch(command)
        if fence_error:
            self._finish(command, digest, "REJECTED", fence_error)
            return
        try:
            require_write_authority()
            if self.config.pc_dispatch_start_required:
                if self.ble.command_session(device_id) != generation:
                    raise DispatchBlocked("DISPATCH_NOT_SENT")
                dispatch_deadline = await self._dispatch_start_deadline(command, digest, expires)
                deadline = min(deadline, dispatch_deadline)
                require_write_authority()
                if self.ble.command_session(device_id) != generation:
                    raise DispatchBlocked("DISPATCH_NOT_SENT")
                expires = min(expires, time.monotonic() + (deadline - utc_now() - margin).total_seconds())
        except asyncio.CancelledError:
            self._finish(command, digest, "REJECTED", "DISPATCH_NOT_SENT", "Shutdown before BLE transmission")
            raise
        except DispatchBlocked as exc:
            code = str(exc)
            if self.config.pc_dispatch_start_required and code == "CREDENTIAL_CHANGED":
                code = "DISPATCH_NOT_SENT"
            self._finish(command, digest, "REJECTED", code, "Dispatch blocked before BLE transmission")
            return
        budget_ms = int((expires - time.monotonic()) * 1000)
        if budget_ms <= 0:
            self._finish(command, digest, "REJECTED", "EXPIRED", "Deadline elapsed during durable intent recording; BLE not sent")
            return

        observed_result = None
        receipt_saved = False

        def record_receipt(raw: dict) -> None:
            nonlocal observed_result, receipt_saved
            observed_result = raw
            try:
                self._finish_device_result(command, digest, raw)
            except sqlite3.Error as exc:
                LOG.warning("SQLite receipt write failed (%s); keeping result for retry", type(exc).__name__)
            else:
                receipt_saved = True

        try:
            raw = await self.ble.execute(command, budget_ms, digest, expected_generation=generation,
                                         deadline_monotonic=expires, before_write=require_write_authority,
                                         on_receipt=record_receipt)
        except DispatchBlocked as exc:
            self._finish(command, digest, "INDETERMINATE", str(exc), "BLE transmission stopped after an authorization change; no automatic replay")
        except asyncio.TimeoutError:
            self._finish(command, digest, "TIMEOUT", "TIMEOUT", "No matching device receipt before timeout; execution may have occurred; no automatic replay")
        except asyncio.CancelledError:
            if observed_result is None:
                self._finish(command, digest, "INDETERMINATE", "CANCELLED", "Shutdown interrupted dispatch; no automatic replay")
            elif not receipt_saved:
                record_receipt(observed_result)
            raise
        except (ValueError, TypeError, KeyError, OverflowError):
            self._finish(command, digest, "INDETERMINATE", "INVALID_RECEIPT", "Device receipt could not establish a valid result")
        except Exception as exc:
            self._finish(command, digest, "INDETERMINATE", "DEVICE_UNAVAILABLE", f"Dispatch interrupted ({type(exc).__name__}); execution may have occurred")
        else:
            if not receipt_saved:
                self._finish_device_result(command, digest, raw)

    async def _dispatch_loop(self) -> None:
        cursor = through = 0
        batch_size = 16
        while not self.stop.is_set():
            if cursor == 0:
                through = self.store.command_high_water()
            batch = self.store.pending(batch_size, after_rowid=cursor, through_rowid=through)
            for item in batch:
                if self.stop.is_set():
                    return
                await self._dispatch_one(item["command"], item["digest"])
            # Finish each bounded pass before picking up newer arrivals.
            cursor = batch[-1]["rowid"] if len(batch) == batch_size and batch[-1]["rowid"] < through else 0
            await self._pause(1)

    async def _outbox_loop(self, *, scoped: bool = False,
                           central_route: Literal["telemetry", "receipt"] | None = None) -> None:
        epochs = self.config.core_telemetry_epochs
        commands_enabled = getattr(self.config, "commands_enabled", True)
        receipt_attempts = 0
        next_expiry_check = 0.0
        if central_route == "telemetry":
            max_age = timedelta(seconds=self.config.central_telemetry_retention_seconds + CENTRAL_TELEMETRY_CLOCK_MARGIN)
        if not scoped and epochs is not None:
            # The scoped worker owns this lane, so awaiting its receipt never
            # holds the native observation or command-receipt worker.
            epochs = {}
        while not self.stop.is_set():
            if central_route == "receipt":
                item = None
                if not self.transport.central_delivery_held():
                    self.store.stage_central_receipts()
                    item = self.store.due_central_receipt()
            elif central_route == "telemetry":
                now = time.monotonic()
                if now >= next_expiry_check:
                    expired = (self.store.expire_central_telemetry(utc_now() - max_age, CENTRAL_TELEMETRY_EXPIRY_BATCH)
                               if self._clock_ok() else 0)
                    self.counters["central_telemetry_expired"] += expired
                    next_expiry_check = now if expired == CENTRAL_TELEMETRY_EXPIRY_BATCH else now + CENTRAL_TELEMETRY_EXPIRY_INTERVAL
                item = None if self.transport.central_delivery_held() else self.store.due_central_telemetry()
            else:
                if not scoped:
                    if commands_enabled:
                        self.store.stage_receipts(self.config.receipt_container, self.config.core_bridge_enabled)
                    self.store.stage_credential_receipt()
                prefer_receipts = None if scoped else receipt_attempts < RECEIPT_BURST
                hold = NativeDeliveryHold() if scoped else self.transport.native_delivery_hold()
                item = self.store.due(core_epochs=epochs, scoped_only=scoped, prefer_receipts=prefer_receipts,
                                      skip_native=hold.all_native, skip_core=not self.config.core_bridge_enabled,
                                      held_receipt_container=hold.receipt_container,
                                      hold_credential_receipts=hold.credential_receipts,
                                      held_observation_container=hold.observation_container,
                                      disabled_command_receipt_container=None if commands_enabled else self.config.receipt_container)
            if item is None:
                await self._pause(0.5)
                continue
            if central_route is None:
                receipt_attempts = min(receipt_attempts + 1, RECEIPT_BURST) if item["is_receipt"] else 0
            delivery_options = {}
            if (item["command_id"] is not None and item["container"] == self.config.receipt_container
                    and (self.config.receipt_container_ri is not None
                         or (self.config.observation_container_ri is not None
                             and self.config.observation_container == self.config.receipt_container))):
                if item["attempts"]:
                    delivery_options["confirm_existing"] = True
                else:
                    self.store.mark_receipt_attempt(item["rqi"])
            try:
                if (central_route == "telemetry" and self._clock_ok()
                        and utc_now() - parse_time(item["payload"]["observedAt"]) > max_age):
                    self.store.delivered(item["rqi"])
                    self.counters["central_telemetry_expired"] += 1
                    continue
                if item["container"] == "@central/receipt":
                    delivery_options["expected_claim_id"] = self.store.central_receipt_claim(item["payload"])
                confirmation = await self.transport.publish(item["rqi"], item["container"], item["payload"], **delivery_options)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.counters["publish_retries"] += 1
                minimum_delay = exc.retry_after if isinstance(exc, HttpRetryDeferred) else 0.0
                self.store.retry(item["rqi"], item["attempts"], minimum_delay=minimum_delay)
                LOG.warning("Gateway delivery deferred (%s)", type(exc).__name__)
            else:
                self.store.delivered(item["rqi"])
                self.counters["published"] += 1
                if item["container"] == "@central/receipt":
                    self.counters["central_receipts_confirmed"] += 1
                if item["container"] == "@central/telemetry":
                    outcome = "stale" if confirmation["status"] == "STALE" else "confirmed"
                    self.counters[f"central_telemetry_{outcome}"] += 1
                if scoped:
                    self.counters["core_applied_confirmed"] += 1

    def _health_payload(self) -> dict:
        outbox, commands = self.store.counts()
        return {
            "version": 1, "gatewayId": self.config.gateway_id, "bootId": self.boot_id,
            "observedAt": iso_time(), "uptimeSeconds": int(time.monotonic() - self.started),
            "runtimeDigest": self.runtime_digest,
            "credentialStatus": self.credential_status if self._credentials_active() or self.credential_status in {"LOST", "REVOKED"} else "UNKNOWN",
            "credentialRevision": self.credential_revision, "outboxDepth": outbox,
            "commandCount": commands, "devices": self.ble.snapshot(), "counters": dict(self.counters),
        }

    def _enqueue_health(self) -> None:
        payload = self._health_payload()
        try:
            if not self.store.enqueue_heartbeat(payload):
                self.counters["health_deferred_pending"] += 1
        except CapacityError:
            self.counters["health_dropped_capacity"] += 1

    async def _health_loop(self) -> None:
        while not self.stop.is_set():
            self._enqueue_health()
            await self._pause(self.config.heartbeat_interval)

    async def run(self) -> None:
        tasks: list[asyncio.Task] = []
        try:
            commands_enabled = self.config.commands_enabled
            workers = [self._credentials_loop]
            if commands_enabled:
                for item in self.store.interrupted():
                    self._finish(item["command"], item["digest"], "INDETERMINATE", "RESTART_INTERRUPTED",
                                 "Previous process ended during dispatch; journal preserved and command not replayed")
                workers.extend((self._poll_loop, self._dispatch_loop))
            workers.extend((self._outbox_loop, self._health_loop))
            await self.transport.start()
            await self.ble.start(self.observation, observation_heads=self.store.observation_heads())
            tasks = [asyncio.create_task(worker(), name=worker.__name__) for worker in workers]
            if self.config.core_telemetry_epochs is not None:
                tasks.append(asyncio.create_task(self._outbox_loop(scoped=True), name="scoped_outbox"))
            if self.config.central_telemetry_enabled:
                tasks.append(asyncio.create_task(self._outbox_loop(central_route="telemetry"), name="central_telemetry_outbox"))
            if commands_enabled and self.config.central_receipts_enabled:
                tasks.append(asyncio.create_task(self._outbox_loop(central_route="receipt"), name="central_receipt_outbox"))
            stop_task = asyncio.create_task(self.stop.wait(), name="stop")
            tasks.append(stop_task)
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if task is not stop_task:
                    task.result()
                    # A stop request can wake a worker and the stop waiter together.
                    if not self.stop.is_set():
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
