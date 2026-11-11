"""Opt-in Pi bench: real Feather observations, MQTT/HTTPS delivery, CSE readback."""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from contextlib import closing, contextmanager
from contextvars import ContextVar
from dataclasses import replace
import hashlib
import json
import logging
import os
from pathlib import Path
import stat
from urllib.parse import quote
import uuid

from bubble_gateway.ble import BleFleet
from bubble_gateway.config import GatewayConfig, ID, read_env_file
from bubble_gateway.core_bridge import telemetry
from bubble_gateway.model import canonical, payload_hash, validate_observation
from bubble_gateway.service import Gateway
from bubble_gateway.state_identity import configured_binding
from bubble_gateway.store import Store
from bubble_gateway.transport import TransportHub

DEVICE_ID = "keyring-feather-lab"
FIRMWARE = "feather-probe-0.1.1"
BENCH_ROOT = "/Mobius/privacy-bubble-test-ae"
FEATHER_SDT = BENCH_ROOT + "/featherState"
BUTTON_STATES = {"released", "confirm", "panic"}
MAX_RECOVERY_ROWS = 200


class RelayFailure(RuntimeError):
    pass


class RelayTransport(TransportHub):
    """Count the transport that settled a publish, without changing delivery logic."""
    def __init__(self, config):
        super().__init__(config)
        self.delivery_channels = {"mqtt": 0, "https": 0}
        self.scoped_receipts = {}
        self._publish_used_https = ContextVar("relay_publish_used_https", default=False)

    async def _http_json(self, method, url, *, headers, body=None):
        if method == "POST":
            self._publish_used_https.set(True)
        return await super()._http_json(method, url, headers=headers, body=body)

    async def publish(self, rqi, container, payload):
        token = self._publish_used_https.set(False)
        try:
            result = await super().publish(rqi, container, payload)
            if container == "@core/telemetry":
                if result is None:
                    raise RelayFailure("SCOPED_RECEIPT_MISSING")
                self.scoped_receipts[rqi] = result
                return result
            channel = "https" if self._publish_used_https.get() else "mqtt"
            self.delivery_channels[channel] += 1
        finally:
            self._publish_used_https.reset(token)


def summary_template() -> dict:
    return {
        "status": "failed", "error": None,
        "capturedCount": 0, "publishedCount": 0, "readbackCount": 0,
        "deliveryChannels": {"mqtt": 0, "https": 0},
        "sequences": [], "buttonStates": [], "payloadSha256": [], "readbackSha256": [],
        "tlsPolicy": {"minimumVersion": "TLSv1.3", "verifyServerCertificate": True,
                      "verifyServerHostname": True, "clientCertificateRequired": True,
                      "handshakeVersionMeasured": False},
    }


def validate_config(config: GatewayConfig, *, scoped: bool = False) -> None:
    if scoped:
        if (config.gateway_id != "gw-a" or not config.core_bridge_enabled or not config.mqtt_enabled
                or config.m2m_mqtt_enabled or config.core_telemetry_epochs != {DEVICE_ID: 1}
                or config.mqtt_host not in {"localhost", "127.0.0.1"} or config.mqtt_port != 8884
                or config.cse_url not in {"https://localhost:8760", "https://127.0.0.1:8760"}
                or config.observation_container != BENCH_ROOT + "/observations"
                or config.receipt_container != BENCH_ROOT + "/receipts"
                or config.health_container != BENCH_ROOT + "/health"):
            raise RelayFailure("SCOPED_FEATHER_PROFILE_REQUIRED")
    elif config.core_bridge_enabled:
        raise RelayFailure("CORE_BRIDGE_MUST_BE_DISABLED")
    if (set(config.ble_devices) != {DEVICE_ID} or not config.ble_pair
            or config.ble_gatt_profile != "core-v1"
            or config.firmware_revision_allowlist != (FIRMWARE,)):
        raise RelayFailure("FEATHER_ENROLLMENT_REQUIRED")
    if config.database.exists() or config.database.is_symlink():
        raise RelayFailure("EXISTING_DATABASE_REFUSED")


def load_config(path: Path) -> GatewayConfig:
    """Use only the explicit bench file, before starting any async work."""
    path = path.expanduser()
    inherited = dict(os.environ)
    try:
        os.environ.clear()
        read_env_file(path)
        return GatewayConfig.from_env()
    finally:
        os.environ.clear()
        os.environ.update(inherited)


def write_receipt(output: Path, summary: dict) -> None:
    with (output / "receipt.json").open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(summary, stream, ensure_ascii=True, indent=2)
        stream.write("\n")


@contextmanager
def open_scoped_state(config: GatewayConfig, state: Path, output: Path, *, existing_only: bool = False):
    import fcntl

    if state.is_symlink() or state.resolve().is_relative_to(output.resolve()) or output.resolve().is_relative_to(state.resolve()):
        raise RelayFailure("SCOPED_PRIVATE_STATE_REQUIRED")
    if existing_only and not state.is_dir():
        raise RelayFailure("SCOPED_STATE_BINDING_MISMATCH")
    try:
        state.mkdir(mode=0o700, parents=False, exist_ok=False)
        new = True
    except FileExistsError:
        new = False
    info = state.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RelayFailure("SCOPED_PRIVATE_STATE_REQUIRED")
    marker, database, lock_path = (state / name for name in ("scope.json", "gateway.sqlite3", "gateway.lock"))
    if database.resolve() == config.database.resolve() or any(path.is_symlink() for path in (marker, database, lock_path)):
        raise RelayFailure("SCOPED_PRIVATE_STATE_REQUIRED")
    expected = {"format": 1, "purpose": "scoped-feather-relay", "binding": configured_binding(config),
                "epochs": config.core_telemetry_epochs}
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if new:
            if database.exists():
                raise RelayFailure("EXISTING_DATABASE_REFUSED")
            with marker.open("x", encoding="utf-8") as handle:
                handle.write(canonical(expected) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        elif not marker.is_file() or not database.is_file() or json.loads(marker.read_text(encoding="utf-8")) != expected:
            raise RelayFailure("SCOPED_STATE_BINDING_MISMATCH")
        yield database


def scoped_receipts(captured: list[dict], hub: RelayTransport) -> list[dict]:
    matched = []
    for payload in captured:
        identity = f"{payload['deviceId']}:{payload['bootId']}:{payload['sequence']}"
        receipt = hub.scoped_receipts.get(Store.request_id("core-telemetry", identity))
        if receipt is None:
            raise RelayFailure("SCOPED_RECEIPT_MISSING")
        projected = telemetry(payload, receipt["sequence"], scoped=True)
        if receipt["payloadHash"] != payload_hash(projected):
            raise RelayFailure("SCOPED_RECEIPT_HASH_MISMATCH")
        matched.append(receipt)
    if len(hub.scoped_receipts) != len(matched) or any(
            left["sequence"] >= right["sequence"] for left, right in zip(matched, matched[1:])):
        raise RelayFailure("SCOPED_RECEIPT_ORDER_MISMATCH")
    return matched


async def read_scoped_state(hub: RelayTransport, expected: bool) -> bool:
    rqi = "verify-sdt-" + uuid.uuid4().hex
    status, headers, body = await hub._http_json(
        "GET", hub.config.cse_url + FEATHER_SDT, headers=hub._m2m_headers(rqi))
    rsc = hub._response_rsc(status, headers, rqi)
    switch = body.get("pb:binarySwitch")
    if (status != 200 or rsc != 2000 or not isinstance(switch, dict) or switch.get("rn") != "featherState"
            or switch.get("cnd") != "org.onem2m.common.moduleclass.binarySwitch"
            or switch.get("state") is not expected):
        raise RelayFailure("SCOPED_SDT_READBACK_MISMATCH")
    return switch["state"]


def pending_recovery_rows(store: Store, config: GatewayConfig) -> dict[str, dict]:
    rows = list(store.db.execute("SELECT * FROM outbox ORDER BY rowid LIMIT ?", (MAX_RECOVERY_ROWS + 1,)))
    if store.counts()[1] or len(rows) > MAX_RECOVERY_ROWS:
        raise RelayFailure("RECOVERY_SCOPE_INVALID")
    pending = {}
    for raw in rows:
        row = dict(raw)
        payload = json.loads(row["payload"])
        if (not isinstance(payload, dict) or row["command_id"] is not None
                or payload.get("deviceId") != DEVICE_ID or payload.get("gatewayId") != config.gateway_id
                or canonical(payload) != row["payload"] or len(row["payload"].encode()) != row["payload_bytes"]):
            raise RelayFailure("RECOVERY_SCOPE_INVALID")
        if row["container"] == config.observation_container:
            payload = validate_observation(payload, config.gateway_id, config.ble_devices)
            if payload["firmwareRevision"] != FIRMWARE:
                raise RelayFailure("RECOVERY_SCOPE_INVALID")
            kind, sequence = "observation", payload["sequence"]
        elif row["container"] == "@core/telemetry":
            kind, sequence = "core-telemetry", payload.get("firmwareSequence")
            if (type(payload.get("ownershipEpoch")) is not int or payload["ownershipEpoch"] != 1
                    or payload.get("schemaVersion") not in ("1.0.0", "1.1.0")
                    or type(payload.get("sequence")) is not int or not 0 <= payload["sequence"] <= 4294967295
                    or type(payload.get("state")) is not bool):
                raise RelayFailure("RECOVERY_SCOPE_INVALID")
        else:
            raise RelayFailure("RECOVERY_SCOPE_INVALID")
        boot = payload.get("bootId")
        if (not isinstance(boot, str) or ID.fullmatch(boot) is None
                or type(sequence) is not int or not 0 <= sequence <= 4294967295
                or row["rqi"] != Store.request_id(kind, f"{DEVICE_ID}:{boot}:{sequence}")):
            raise RelayFailure("RECOVERY_SCOPE_INVALID")
        pending[row["rqi"]] = {**row, "payload": payload}
    return pending


class RecoveryTransport(RelayTransport):
    def __init__(self, config: GatewayConfig, pending: dict[str, dict], ledger):
        super().__init__(config)
        self.pending, self.ledger = pending, ledger
        self.confirmed = {}

    async def publish(self, rqi, container, payload):
        planned = self.pending.get(rqi)
        if planned is None or planned["container"] != container or canonical(planned["payload"]) != canonical(payload):
            raise RelayFailure("RECOVERY_ROW_CHANGED")
        result = await super().publish(rqi, container, payload)
        entry = {"rqi": rqi, "container": container, "payloadSha256": payload_hash(payload)}
        if container == "@core/telemetry":
            entry["scopedReceipt"] = result
        else:
            observed = await self.read_content(rqi, container)
            if canonical(observed) != canonical(payload):
                raise RelayFailure("RECOVERY_READBACK_MISMATCH")
            entry["readbackSha256"] = payload_hash(observed)
        self.ledger.write(canonical(entry) + "\n")
        self.ledger.flush()
        os.fsync(self.ledger.fileno())
        self.confirmed[rqi] = entry
        return result


async def run_recovery(config: GatewayConfig, output: Path, database: Path, seconds: int) -> dict:
    """Replay only already-staged records from the explicitly opened Feather state."""
    summary = {"mode": "scoped-recovery", "status": "failed", "error": None,
               "pendingCount": 0, "confirmedCount": 0, "remainingCount": None}
    phase = "RECOVERY_SETUP"
    try:
        validate_config(config, scoped=True)
        if not database.is_file() or database.is_symlink():
            raise RelayFailure("SCOPED_STATE_BINDING_MISMATCH")
        config = replace(config, database=database)
        with closing(Store(database, config.max_outbox_rows, config.max_outbox_bytes,
                           config.max_commands, configured_binding(config))) as store:
            pending = pending_recovery_rows(store, config)
            summary["pendingCount"] = len(pending)
            summary["remainingCount"] = len(pending)
            if not pending:
                summary["status"] = "nothing-to-recover"
                return summary
            plan_path = output / "recovery-plan.jsonl"
            with plan_path.open("x", encoding="utf-8", newline="\n") as plan:
                for row in pending.values():
                    plan.write(canonical(row) + "\n")
                plan.flush()
                os.fsync(plan.fileno())
            summary["planSha256"] = hashlib.sha256(plan_path.read_bytes()).hexdigest()
            ledger_path = output / "recovery-receipts.jsonl"
            with ledger_path.open("x", encoding="utf-8", newline="\n") as ledger:
                # Persist both file entries before any publish can remove a row.
                for directory in (output, output.parent):
                    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                hub = RecoveryTransport(config, pending, ledger)
                gateway = Gateway.__new__(Gateway)
                gateway.config, gateway.store, gateway.transport = config, store, hub
                gateway.stop, gateway.counters = asyncio.Event(), Counter()
                workers = []
                try:
                    async with asyncio.timeout(seconds):
                        phase = "RECOVERY_CONNECT"
                        await hub.start()
                        await hub._ready.wait()
                        phase = "RECOVERY_DRAIN"
                        workers = [asyncio.create_task(gateway._outbox_loop(scoped=scoped)) for scoped in (False, True)]
                        while store.counts()[0]:
                            for worker in workers:
                                if worker.done():
                                    worker.result()
                                    raise RelayFailure("SENDER_STOPPED")
                            await asyncio.sleep(0.05)
                        if set(hub.confirmed) != set(pending):
                            raise RelayFailure("RECOVERY_RECEIPTS_INCOMPLETE")
                        summary["status"] = "passed"
                finally:
                    gateway.stop.set()
                    for worker in workers:
                        worker.cancel()
                    await asyncio.gather(*workers, return_exceptions=True)
                    summary["confirmedCount"] = len(hub.confirmed)
                    summary["remainingCount"] = store.counts()[0]
                    try:
                        await asyncio.wait_for(hub.close(), 10)
                    except (Exception, asyncio.CancelledError):
                        summary.update(status="failed", error="RECOVERY_TRANSPORT_CLOSE_FAILED")
                    summary["receiptsSha256"] = hashlib.sha256(ledger_path.read_bytes()).hexdigest()
    except RelayFailure as exc:
        summary.update(status="failed", error=str(exc))
    except TimeoutError:
        summary.update(status="failed", error=phase + "_TIMEOUT")
    except asyncio.CancelledError:
        summary.update(status="failed", error="INTERRUPTED")
    except Exception:
        summary.update(status="failed", error=phase + "_FAILED")
    return summary


async def run_capture(config: GatewayConfig, output: Path, frames: int, seconds: int, *,
                      scoped_database: Path | None = None) -> dict:
    """Caller owns the new output and holds the matching test DB lock."""
    scoped = scoped_database is not None
    summary = summary_template()
    if scoped:
        summary.update(scopedReceiptCount=0, scopedReceipts=[], sdtReadbackState=None)
    captured: list[dict] = []
    readback_hashes: list[str] = []
    store = hub = fleet = gateway = source = None
    senders = []
    phase = "SETUP"
    cleanup_errors: list[str] = []
    complete = asyncio.Event()
    callback_error = None

    try:
        validate_config(config, scoped=scoped)
        database = scoped_database if scoped else output / "gateway.sqlite3"
        if database.is_symlink() or (not scoped and database.exists()):
            raise RelayFailure("EXISTING_DATABASE_REFUSED")
        config = replace(config, database=database)
        source = (output / "observations.jsonl").open("x", encoding="utf-8", newline="\n")
        store = Store(database, config.max_outbox_rows, config.max_outbox_bytes,
                      config.max_commands, configured_binding(config))
        if scoped and store.counts()[0]:
            raise RelayFailure("SCOPED_OUTBOX_NOT_EMPTY")
        hub, fleet = RelayTransport(config), BleFleet(config)
        gateway = Gateway.__new__(Gateway)
        gateway.config, gateway.store, gateway.transport = config, store, hub
        gateway.stop, gateway.counters = asyncio.Event(), Counter()

        button_states = set()

        async def receive(raw: dict) -> None:
            nonlocal callback_error
            if complete.is_set():
                return
            before = gateway.counters["observations_queued"]
            invalid_before = gateway.counters["observations_invalid"]
            await gateway.observation(raw)
            if gateway.counters["observations_invalid"] != invalid_before:
                callback_error = "INVALID_OBSERVATION"
                complete.set()
                return
            if gateway.counters["observations_queued"] != before:
                payload = json.loads(canonical(raw))
                captured.append(payload)
                first = len(captured) == 1
                button_states.add(payload["buttonState"])
                if scoped and first:
                    print("Feather observations started. Release both buttons, then press A0 and A1.", flush=True)
                try:
                    source.write(canonical(payload) + "\n")
                    source.flush()
                    os.fsync(source.fileno())
                except OSError:
                    callback_error = "CAPTURE_WRITE_FAILED"
                    complete.set()
                    return
                if len(captured) >= frames and (not scoped or button_states == BUTTON_STATES):
                    complete.set()
                elif len(captured) >= 100:
                    callback_error = "BUTTON_STATES_NOT_OBSERVED"
                    complete.set()

        def check_senders() -> None:
            for sender in senders:
                if sender.done():
                    sender.result()
                    raise RelayFailure("SENDER_STOPPED")

        async with asyncio.timeout(seconds):
            phase = "CONNECT"
            await hub.start()
            if config.mqtt_enabled:
                phase = "MQTT_READY"
                await hub._ready.wait()
            senders.append(asyncio.create_task(gateway._outbox_loop(), name="feather-cse-outbox"))
            if scoped:
                senders.append(asyncio.create_task(gateway._outbox_loop(scoped=True), name="feather-scoped-outbox"))
            await fleet.start(receive)
            phase = "CAPTURE"
            while not complete.is_set():
                check_senders()
                await asyncio.sleep(0.05)
            if callback_error:
                raise RelayFailure(callback_error)
            await fleet.close()
            fleet = None
            phase = "DRAIN"
            while store.counts()[0]:
                check_senders()
                await asyncio.sleep(0.05)
            phase = "READBACK"
            parent = quote(config.observation_container.rstrip("/"), safe="/:-._~")
            for payload in captured:
                identity = f"{payload['deviceId']}:{payload['bootId']}:{payload['sequence']}"
                rqi = Store.request_id("observation", identity)
                rn = "gw-" + hashlib.sha256(rqi.encode("utf-8")).hexdigest()
                read_rqi = "verify-" + uuid.uuid4().hex
                status, headers, body = await hub._http_json(
                    "GET", config.cse_url + parent + "/" + rn,
                    headers=hub._m2m_headers(read_rqi))
                rsc = hub._response_rsc(status, headers, read_rqi)
                cin = body.get("m2m:cin")
                if (status != 200 or rsc != 2000 or not isinstance(cin, dict)
                        or cin.get("rn") != rn or "con" not in cin
                        or canonical(cin["con"]) != canonical(payload)):
                    raise RelayFailure("READBACK_MISMATCH")
                readback_hashes.append(payload_hash(cin["con"]))
            if scoped:
                phase = "SCOPED_READBACK"
                summary["scopedReceipts"] = scoped_receipts(captured, hub)
                summary["sdtReadbackState"] = await read_scoped_state(hub, captured[-1]["state"])
            summary["status"] = "passed"
    except RelayFailure as exc:
        summary["error"] = str(exc)
    except TimeoutError:
        summary["error"] = phase + "_TIMEOUT"
    except asyncio.CancelledError:
        summary["error"] = "INTERRUPTED"
    except Exception:
        summary["error"] = phase + "_FAILED"
    finally:
        # Every resource is attempted even if another cleanup operation fails.
        if fleet is not None:
            try:
                await asyncio.wait_for(fleet.close(), 10)
            except (Exception, asyncio.CancelledError):
                cleanup_errors.append("BLE_CLOSE")
        if gateway is not None:
            gateway.stop.set()
        if senders:
            for sender in senders:
                sender.cancel()
            try:
                await asyncio.wait_for(asyncio.gather(*senders, return_exceptions=True), 10)
            except (Exception, asyncio.CancelledError):
                cleanup_errors.append("SENDER_CLOSE")
        if hub is not None:
            try:
                await asyncio.wait_for(hub.close(), 10)
            except (Exception, asyncio.CancelledError):
                cleanup_errors.append("HTTP_CLOSE")
        if store is not None:
            try:
                store.close()
            except Exception:
                cleanup_errors.append("STORE_CLOSE")
        if source is not None:
            try:
                source.close()
            except Exception:
                cleanup_errors.append("CAPTURE_CLOSE")
        if cleanup_errors:
            summary.update(status="failed", cleanupErrors=cleanup_errors)
            summary["error"] = summary["error"] or "CLEANUP_FAILED"
        scoped_count = gateway.counters["core_applied_confirmed"] if gateway else 0
        if scoped:
            summary["scopedReceiptCount"] = scoped_count
        summary.update(capturedCount=len(captured),
                       publishedCount=gateway.counters["published"] - scoped_count if gateway else 0,
                       deliveryChannels=dict(hub.delivery_channels) if hub else {"mqtt": 0, "https": 0},
                       readbackCount=len(readback_hashes),
                       sequences=[frame["sequence"] for frame in captured],
                       buttonStates=[frame["buttonState"] for frame in captured],
                       payloadSha256=[payload_hash(frame) for frame in captured],
                       readbackSha256=readback_hashes)
        capture_path = output / "observations.jsonl"
        if capture_path.is_file():
            try:
                summary["sourceCaptureSha256"] = hashlib.sha256(capture_path.read_bytes()).hexdigest()
            except OSError:
                summary.update(status="failed", error=summary["error"] or "CAPTURE_HASH_FAILED")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, required=True, help="Private Gateway KEY=value configuration")
    parser.add_argument("--output", type=Path, required=True, help="New private output directory; parent must exist")
    parser.add_argument("--frames", type=int, default=5, help="Number of real observations to relay (1..100)")
    parser.add_argument("--seconds", type=int, default=90, help="Total connect/capture/drain/readback budget (5..600)")
    parser.add_argument("--scoped-state", type=Path, help="Private, dedicated Feather scope state directory")
    parser.add_argument("--recover-scoped", action="store_true", help="Replay an existing scoped outbox without BLE")
    args = parser.parse_args()
    if not 1 <= args.frames <= 100 or not 5 <= args.seconds <= 600:
        parser.error("frames must be 1..100 and seconds must be 5..600")
    if args.scoped_state is not None and not args.recover_scoped and args.frames < 3:
        parser.error("scoped capture requires at least three frames for the button states")
    if args.recover_scoped and args.scoped_state is None:
        parser.error("scoped recovery requires --scoped-state")
    if os.name != "posix":
        parser.error("relay execution requires POSIX private files and flock; run on the Pi")
    import fcntl

    os.umask(0o077)
    # Suppress libraries that could include addresses or HTTP headers in logs.
    logging.disable(logging.CRITICAL)
    output = args.output.expanduser().absolute()
    try:
        output.mkdir(mode=0o700, parents=False, exist_ok=False)
    except OSError:
        print(json.dumps({"status": "failed", "error": "NEW_PRIVATE_OUTPUT_REQUIRED"}), flush=True)
        return 1
    summary = summary_template()
    if args.recover_scoped:
        summary["mode"] = "scoped-recovery"
    try:
        with (output / "gateway.lock").open("x") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            config = load_config(args.env)
            if args.scoped_state is not None:
                validate_config(config, scoped=True)
                with open_scoped_state(config, args.scoped_state.expanduser().absolute(), output,
                                       existing_only=args.recover_scoped) as database:
                    if args.recover_scoped:
                        summary = asyncio.run(run_recovery(config, output, database, args.seconds))
                    else:
                        summary = asyncio.run(run_capture(config, output, args.frames, args.seconds, scoped_database=database))
            else:
                summary = asyncio.run(run_capture(config, output, args.frames, args.seconds))
            write_receipt(output, summary)
    except KeyboardInterrupt:
        summary.update(status="failed", error="INTERRUPTED")
    except RelayFailure as exc:
        summary.update(status="failed", error=str(exc))
    except Exception:
        summary.update(status="failed", error=summary["error"] or "CONFIG_OR_OUTPUT_FAILED")
    if not (output / "receipt.json").exists():
        try:
            write_receipt(output, summary)
        except OSError:
            summary.update(status="failed", error="RECEIPT_WRITE_FAILED")
    print(json.dumps(summary, ensure_ascii=True), flush=True)
    return 0 if summary["status"] in {"passed", "nothing-to-recover"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
