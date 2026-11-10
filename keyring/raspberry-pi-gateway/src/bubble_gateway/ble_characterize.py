"""Capture BLE range, reconnect, wake and optional r18 power observations on Linux/BlueZ."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import logging
import os
import re
import sys
import time
from pathlib import Path
from types import SimpleNamespace

from .ble import BleFleet
from .config import ID
from .model import canonical, iso_time

MAX_EVENTS = 8192
BOARD_REVISIONS = {"feather-bench": "feather-esp32-v2", "r18-pcb": "r18-hand-solder"}
# Confirm/Panic are GPIO6/7 in firmware/include/board_r18.h.
WAKE_CASES = {"confirm": ("button", 1 << 6), "panic": ("button", 1 << 7),
              "motion": ("motion", 0), "timer": ("timer", 0)}


def wake_result(sessions: list[dict], rows: list[dict], expected: str, release_ms: int | None) -> dict:
    baseline = next((s for s in sessions if s["phase"] == "baseline" and s["notificationCount"]), None)
    after = next((s for s in sessions if s["phase"] == "after-wake" and s["notificationCount"]), None)
    new_boot = None if baseline is None or after is None else baseline["boot"] != after["boot"]
    report = {"expected": expected, "newBoot": new_boot, "cause": None, "pins": None,
              "deviceUptimeMs": None, "releaseToFirstNotificationMs": None, "matched": False}
    if after is None:
        return report
    if release_ms is not None:
        report["releaseToFirstNotificationMs"] = after["firstNotificationAtMs"] - release_ms
    first_boot_sessions = set()
    for session in sessions:
        if session["phase"] != "after-wake" or session["session"] < after["session"]:
            continue
        if session["boot"] != after["boot"]:
            break
        first_boot_sessions.add(session["session"])
    health = next((row for row in rows if row["session"] in first_boot_sessions and "wakeCause" in row), None)
    if health is not None:
        report.update(cause=health["wakeCause"], pins=health["wakePins"], deviceUptimeMs=health["deviceUptimeMs"],
                      matched=new_boot is True and (health["wakeCause"], health["wakePins"]) == WAKE_CASES[expected])
    return report


def power_result(sessions: list[dict], rows: list[dict], mode: str) -> dict:
    by_session = {session["session"]: session for session in sessions}
    first_boots = {}
    for session in sessions:
        if session["notificationCount"]:
            first_boots.setdefault(session["phase"], session["boot"])

    samples = set()
    valid_boots = set()
    valid = invalid = missing = 0
    for row in rows:
        if "ina219" not in row:
            continue
        reading = row["ina219"]
        if reading is None:
            missing += 1
        elif reading["status"] != "ok":
            invalid += 1
        else:
            session = by_session[row["session"]]
            boot = session["boot"]
            sample = (boot, reading["readUptimeMs"])
            row["newPowerSample"] = sample not in samples
            valid += 1
            samples.add(sample)
            valid_boots.add((session["phase"], boot))

    if mode == "wake":
        missing_phases = [phase for phase in ("baseline", "after-wake")
                          if (phase, first_boots.get(phase)) not in valid_boots]
    else:
        missing_phases = [] if samples else ["capture"]
    return {"uniqueValidSamples": len(samples), "repeatedValidFrames": valid - len(samples),
            "invalidFrames": invalid, "missingEnergyFrames": missing, "missingPhases": missing_phases}


def summarize(events: list[dict], start_ns: int, stop_ns: int, *, board: str, mode: str,
              truncated: bool, dropped: int, expected_wake: str | None = None,
              release_ms: int | None = None, include_power: bool = False) -> dict:
    sessions = {}
    boots = {}
    rows = []
    unexpected_boards = 0
    for event in events:
        at = event["atNs"]
        if not start_ns <= at < stop_ns:
            continue
        phase = event.get("phase", "capture")
        key = (phase, event["generation"])
        elapsed = (at - start_ns) // 1_000_000
        kind = event["event"]
        row = {"event": kind, "atMs": elapsed}
        if kind == "ready":
            revision = event["boardRevision"]
            if revision != board:
                unexpected_boards += 1
                continue
            boot = boots.setdefault(event["bootId"], len(boots) + 1)
            rssi = event["advertisingRssiDbm"]
            age = event["advertisingAgeMs"]
            row.update(boot=boot, advertisingRssiDbm=rssi, advertisingAgeMs=age)
            sessions[key] = {
                "session": len(sessions) + 1, "phase": phase, "boot": boot, "readyAtMs": elapsed, "lostAtMs": None,
                "advertisingRssiDbm": rssi, "advertisingAgeMs": age,
                "notificationCount": 0, "firstNotificationAtMs": None, "lastSequence": None,
                "sequenceGaps": 0,
            }
        elif key in sessions:
            session = sessions[key]
            if kind == "lost":
                session["lostAtMs"] = elapsed
            else:
                sequence = event["sequence"]
                row["sequence"] = sequence
                if mode == "wake" and "wakeCause" in event:
                    row.update(wakeCause=event["wakeCause"], wakePins=event["wakePins"],
                               deviceUptimeMs=event["deviceUptimeMs"])
                if include_power and "ina219" in event:
                    row.update(ina219=event["ina219"], deviceUptimeMs=event["deviceUptimeMs"])
                if session["notificationCount"] == 0:
                    session["firstNotificationAtMs"] = elapsed
                else:
                    session["sequenceGaps"] += max(0, sequence - session["lastSequence"] - 1)
                session["lastSequence"] = sequence
                session["notificationCount"] += 1
        else:
            continue
        rows.append({**row, "session": sessions[key]["session"]})

    measured = list(sessions.values())
    reconnects = []
    for previous, current in zip(measured, measured[1:]):
        lost = previous["lostAtMs"]
        first = current["firstNotificationAtMs"]
        if previous["notificationCount"] and lost is not None and first is not None:
            reconnects.append({"fromSession": previous["session"], "toSession": current["session"],
                               "lossToNotificationMs": first - lost, "sameBoot": previous["boot"] == current["boot"]})
    notifications = sum(session["notificationCount"] for session in measured)
    wake = wake_result(measured, rows, expected_wake, release_ms) if expected_wake is not None else None
    power = power_result(measured, rows, mode) if include_power else None
    status = "RECORDED"
    if truncated:
        status = "TRUNCATED"
    elif (not notifications or unexpected_boards or dropped or (mode == "reconnect" and not reconnects)
          or (mode == "wake" and (wake is None or not wake["matched"]))
          or (power is not None and power["missingPhases"])):
        status = "INSUFFICIENT"
    report = {"status": status, "durationMs": (stop_ns - start_ns) // 1_000_000,
              "notificationCount": notifications, "droppedByReceiver": dropped,
              "unexpectedBoardSessions": unexpected_boards, "sessions": measured,
              "reconnects": reconnects, "events": rows}
    if wake is not None:
        report["wake"] = wake
    if power is not None:
        report["power"] = power
    return report


async def characterize(args: argparse.Namespace) -> dict:
    board = BOARD_REVISIONS[args.hardware]
    config = SimpleNamespace(
        gateway_id=args.gateway_id, ble_devices={args.device_id: args.address},
        ble_gatt_profile=args.gatt_profile, ble_pair=True, ble_scan_seconds=10,
        request_timeout=5, firmware_revision_allowlist=(args.firmware_revision,),
    )
    events: list[dict] = []
    truncated = False

    async def discard_observation(_frame: dict) -> None:
        pass

    async def window(phase: str, *, stop_on_first: bool = False) -> tuple[bool, int]:
        fleet = BleFleet(config)
        first = asyncio.Event()
        first_power = asyncio.Event()
        receiving = set()
        capturing = True

        def trace(event: dict) -> None:
            nonlocal truncated
            if not capturing:
                return
            if len(events) < MAX_EVENTS:
                events.append({**event, "phase": phase})
            else:
                truncated = True
            if event["event"] == "notification" and event["boardRevision"] == board:
                if event["generation"] not in receiving:
                    receiving.add(event["generation"])
                    first.set()
                    print("First notification received for this BLE session.", flush=True)
                reading = event.get("ina219")
                if reading is not None and reading["status"] == "ok":
                    first_power.set()

        await fleet.start(discard_observation, trace=trace)
        try:
            if stop_on_first:
                try:
                    baseline_ready = first_power if args.include_power else first
                    await asyncio.wait_for(baseline_ready.wait(), args.seconds)
                except TimeoutError:
                    pass
            else:
                await asyncio.sleep(args.seconds)
            return first.is_set(), fleet.snapshot()[0]["droppedObservations"]
        finally:
            capturing = False
            await fleet.close()

    started_at = iso_time()
    start_ns = time.monotonic_ns()
    release_ms = None
    if args.mode == "wake":
        baseline, dropped = await window("baseline", stop_on_first=True)
        if baseline:
            release_ms = (time.monotonic_ns() - start_ns) // 1_000_000
            print("BLE released. Leave the device idle until prompted.", flush=True)
            await asyncio.sleep(args.idle_seconds)
            print(f"Begin the {args.expect_wake} wake step now.", flush=True)
            _, after_dropped = await window("after-wake")
            dropped += after_dropped
    else:
        _, dropped = await window("capture")
    stop_ns = time.monotonic_ns()
    report = {"version": 1, "startedAt": started_at, "mode": args.mode, "gatewayId": args.gateway_id,
              "deviceId": args.device_id, "hardware": args.hardware, "boardRevision": board,
              "firmwareRevision": args.firmware_revision, "gattProfile": args.gatt_profile,
              "distanceCm": args.distance_cm, "distanceSource": "operator-measured",
              **summarize(events, start_ns, stop_ns, board=board, mode=args.mode,
                          truncated=truncated, dropped=dropped, expected_wake=args.expect_wake,
                          release_ms=release_ms, include_power=args.include_power)}
    if args.mode == "wake":
        report["wake"].update(operatorIdleSeconds=args.idle_seconds, releaseAtMs=release_ms)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("range", "reconnect", "wake"), required=True)
    parser.add_argument("--hardware", choices=tuple(BOARD_REVISIONS), required=True)
    parser.add_argument("--gateway-id", required=True)
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--address", required=True, help="previously bonded BlueZ Bluetooth address")
    parser.add_argument("--firmware-revision", required=True)
    parser.add_argument("--gatt-profile", choices=("core-v1", "keyring-v01"), default="core-v1")
    parser.add_argument("--distance-cm", type=int, required=True, help="operator-measured separation")
    parser.add_argument("--seconds", type=int, default=90)
    parser.add_argument("--idle-seconds", type=int, help="wake mode only; BLE-free idle window")
    parser.add_argument("--expect-wake", choices=tuple(WAKE_CASES), help="wake mode only")
    parser.add_argument("--include-power", action="store_true", help="include INA219 readings (r18-pcb only)")
    parser.add_argument("--database", type=Path, required=True, help="Gateway state path; used only to find its lock")
    parser.add_argument("--output", type=Path, required=True, help="new private JSON file under an existing directory")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("this operator command requires Linux/BlueZ")
    if (any(ID.fullmatch(value) is None for value in (args.gateway_id, args.device_id, args.firmware_revision))
            or re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", args.address) is None):
        parser.error("invalid BLE enrollment or revision")
    if not 1 <= args.distance_cm <= 100_000 or not 10 <= args.seconds <= 600:
        parser.error("distance must be 1..100000 cm and duration 10..600 seconds")
    if args.include_power and args.hardware != "r18-pcb":
        parser.error("--include-power requires r18-pcb")
    if args.mode == "wake":
        if (args.hardware != "r18-pcb" or args.expect_wake is None or args.idle_seconds is None
                or not 10 <= args.idle_seconds <= 3600):
            parser.error("wake mode requires r18-pcb, --expect-wake and --idle-seconds 10..3600")
    elif args.expect_wake is not None or args.idle_seconds is not None:
        parser.error("idle seconds and expected wake require wake mode")
    lock_path = args.database.with_suffix(".lock")
    if (args.output.exists() or args.output.is_symlink() or not args.output.parent.is_dir()
            or args.output.resolve() in {args.database.resolve(), lock_path.resolve()}):
        parser.error("output must be a new evidence file, separate from Gateway state")
    os.umask(0o077)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")
    logging.getLogger("bleak").setLevel(logging.WARNING)
    try:
        import fcntl
        with lock_path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print("BLE capture started. For reconnect mode, wait for observations, interrupt the link and restore it.",
                  flush=True)
            report = asyncio.run(characterize(args))
        content = (canonical(report) + "\n").encode("utf-8")
        with args.output.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        print(f"{report['status']} {args.output} SHA-256 {hashlib.sha256(content).hexdigest()}")
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except Exception as exc:
        logging.getLogger(__name__).error("BLE characterization stopped (%s)", type(exc).__name__)
        raise SystemExit(1) from None
    raise SystemExit(0 if report["status"] == "RECORDED" else 1)


if __name__ == "__main__":
    main()
