"""Capture BLE range/reconnect observations with the Gateway receiver on Linux/BlueZ."""
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


def summarize(events: list[dict], start_ns: int, stop_ns: int, *, board: str, mode: str,
              truncated: bool, dropped: int) -> dict:
    sessions = {}
    boots = {}
    rows = []
    unexpected_boards = 0
    for event in events:
        at = event["atNs"]
        if not start_ns <= at < stop_ns:
            continue
        generation = event["generation"]
        elapsed = (at - start_ns) // 1_000_000
        kind = event["event"]
        row = {"event": kind, "atMs": elapsed, "session": generation}
        if kind == "ready":
            revision = event["boardRevision"]
            if revision != board:
                unexpected_boards += 1
                continue
            boot = boots.setdefault(event["bootId"], len(boots) + 1)
            rssi = event["advertisingRssiDbm"]
            age = event["advertisingAgeMs"]
            row.update(boot=boot, advertisingRssiDbm=rssi, advertisingAgeMs=age)
            sessions[generation] = {
                "session": generation, "boot": boot, "readyAtMs": elapsed, "lostAtMs": None,
                "advertisingRssiDbm": rssi, "advertisingAgeMs": age,
                "notificationCount": 0, "firstNotificationAtMs": None, "lastSequence": None,
                "sequenceGaps": 0,
            }
        elif generation in sessions:
            session = sessions[generation]
            if kind == "lost":
                session["lostAtMs"] = elapsed
            else:
                sequence = event["sequence"]
                row["sequence"] = sequence
                if session["notificationCount"] == 0:
                    session["firstNotificationAtMs"] = elapsed
                else:
                    session["sequenceGaps"] += max(0, sequence - session["lastSequence"] - 1)
                session["lastSequence"] = sequence
                session["notificationCount"] += 1
        else:
            continue
        rows.append(row)

    measured = list(sessions.values())
    reconnects = []
    for previous, current in zip(measured, measured[1:]):
        lost = previous["lostAtMs"]
        first = current["firstNotificationAtMs"]
        if previous["notificationCount"] and lost is not None and first is not None:
            reconnects.append({"fromSession": previous["session"], "toSession": current["session"],
                               "lossToNotificationMs": first - lost, "sameBoot": previous["boot"] == current["boot"]})
    notifications = sum(session["notificationCount"] for session in measured)
    status = "RECORDED"
    if truncated:
        status = "TRUNCATED"
    elif not notifications or unexpected_boards or dropped or (mode == "reconnect" and not reconnects):
        status = "INSUFFICIENT"
    return {"status": status, "durationMs": (stop_ns - start_ns) // 1_000_000,
            "notificationCount": notifications, "droppedByReceiver": dropped,
            "unexpectedBoardSessions": unexpected_boards, "sessions": measured,
            "reconnects": reconnects, "events": rows}


async def characterize(args: argparse.Namespace) -> dict:
    board = BOARD_REVISIONS[args.hardware]
    fleet = BleFleet(SimpleNamespace(
        gateway_id=args.gateway_id, ble_devices={args.device_id: args.address},
        ble_gatt_profile=args.gatt_profile, ble_pair=True, ble_scan_seconds=10,
        request_timeout=5, firmware_revision_allowlist=(args.firmware_revision,),
    ))
    events: list[dict] = []
    truncated = False
    capturing = True
    receiving = set()

    def trace(event: dict) -> None:
        nonlocal truncated
        if not capturing:
            return
        if len(events) < MAX_EVENTS:
            events.append(event)
        else:
            truncated = True
        if (event["event"] == "notification" and event["boardRevision"] == board
                and event["generation"] not in receiving):
            receiving.add(event["generation"])
            print("First notification received for this BLE session.", flush=True)

    async def discard_observation(_frame: dict) -> None:
        pass

    started_at = iso_time()
    start_ns = time.monotonic_ns()
    await fleet.start(discard_observation, trace=trace)
    try:
        await asyncio.sleep(args.seconds)
        stop_ns = time.monotonic_ns()
        dropped = fleet.snapshot()[0]["droppedObservations"]
    finally:
        capturing = False
        await fleet.close()
    return {"version": 1, "startedAt": started_at, "mode": args.mode, "gatewayId": args.gateway_id,
            "deviceId": args.device_id, "hardware": args.hardware, "boardRevision": board,
            "firmwareRevision": args.firmware_revision, "gattProfile": args.gatt_profile,
            "distanceCm": args.distance_cm, "distanceSource": "operator-measured",
            **summarize(events, start_ns, stop_ns, board=board, mode=args.mode,
                        truncated=truncated, dropped=dropped)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("range", "reconnect"), required=True)
    parser.add_argument("--hardware", choices=tuple(BOARD_REVISIONS), required=True)
    parser.add_argument("--gateway-id", required=True)
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--address", required=True, help="previously bonded BlueZ Bluetooth address")
    parser.add_argument("--firmware-revision", required=True)
    parser.add_argument("--gatt-profile", choices=("core-v1", "keyring-v01"), default="core-v1")
    parser.add_argument("--distance-cm", type=int, required=True, help="operator-measured separation")
    parser.add_argument("--seconds", type=int, default=90)
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
