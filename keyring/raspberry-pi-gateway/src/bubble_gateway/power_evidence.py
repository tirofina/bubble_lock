"""Pair operator meter readings with recorded r18 bring-up samples offline."""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re

from .ble import BleProtocolError, _object, _power_reading, _r18_bringup
from .model import canonical

POINTS = ("load-3v3", "usb-input", "battery-terminal")
READING_FIELDS = {"sequence", "readUptimeMs", "point", "voltageMv", "currentUa"}
SHA256 = re.compile(r"[0-9a-f]{64}")
CAPTURE_LIMIT = 8 * 1024 * 1024
METER_LIMIT = 128 * 1024


def captured_assembly_sha(bringup: dict) -> str | None:
    if "assemblyEvidence" not in bringup:
        return None
    assembly = bringup["assemblyEvidence"]
    digest = assembly.get("recordSha256") if isinstance(assembly, dict) else None
    if not isinstance(digest, str) or not SHA256.fullmatch(digest):
        raise ValueError("Invalid assembly reference in the bring-up capture")
    return digest


def pair_measurements(capture: dict, capture_sha: str, meter: dict) -> dict:
    if (type(capture.get("version")) is not int or capture["version"] != 1
            or capture.get("mode") != "bringup" or capture.get("hardware") != "r18-pcb"
            or not _r18_bringup(capture)):
        raise ValueError("Expected an r18 bring-up capture")
    bringup = capture["bringup"]
    usb = bringup.get("usbBoot", {})
    usb_sha = usb.get("logSha256")
    session = bringup.get("session")
    if (usb.get("sameBoot") is not True or not isinstance(usb_sha, str) or not SHA256.fullmatch(usb_sha)
            or type(session) is not int or session < 1):
        raise ValueError("Capture requires a matching USB and BLE boot")
    assembly_sha = captured_assembly_sha(bringup)
    readings = meter.get("readings")
    if (set(meter) != {"version", "captureSha256", "readings"} or type(meter.get("version")) is not int
            or meter["version"] != 1 or meter["captureSha256"] != capture_sha
            or not isinstance(readings, list) or not 1 <= len(readings) <= 256):
        raise ValueError("Meter readings must identify this exact capture")

    notifications, samples, conflicting_samples = {}, {}, set()
    for row in capture["events"]:
        if row["event"] != "notification" or row["session"] != session:
            continue
        sequence = row["sequence"]
        if type(sequence) is not int or not 0 <= sequence <= 0xFFFFFFFF or sequence in notifications:
            raise ValueError("Invalid or ambiguous BLE notification sequence")
        notifications[sequence] = row
        ina219 = row.get("ina219")
        if isinstance(ina219, dict) and ina219.get("status") == "ok" and type(ina219.get("readUptimeMs")) is int:
            sampled_at = ina219["readUptimeMs"]
            previous = samples.setdefault(sampled_at, ina219)
            if previous is not ina219 and canonical(previous) != canonical(ina219):
                conflicting_samples.add(sampled_at)

    paired, seen = [], set()
    for reading in readings:
        if not isinstance(reading, dict) or set(reading) != READING_FIELDS:
            raise ValueError("Invalid meter reading fields")
        sequence, read_at, point = (reading[key] for key in ("sequence", "readUptimeMs", "point"))
        voltage, current = reading["voltageMv"], reading["currentUa"]
        if (type(sequence) is not int or type(read_at) is not int or read_at < 0 or point not in POINTS
                or (voltage is None and current is None)
                or any(value is not None and (type(value) is not int or not -(2 ** 31) <= value < 2 ** 31)
                       for value in (voltage, current))):
            raise ValueError("Invalid meter reading values or measurement point")
        event = notifications.get(sequence, {})
        ina219 = event.get("ina219")
        notification_at = event.get("atMs")
        if (not isinstance(ina219, dict) or ina219.get("status") != "ok" or ina219.get("readUptimeMs") != read_at
                or type(event.get("deviceUptimeMs")) is not int
                or type(notification_at) is not int or not 0 <= notification_at <= capture["durationMs"]):
            raise ValueError("Meter reading has no matching INA219 sample in the first BLE session")
        _power_reading(ina219, event["deviceUptimeMs"])
        if read_at in conflicting_samples:
            raise ValueError("Conflicting INA219 readings for the same sample")
        key = (read_at, point)
        if key in seen:
            raise ValueError("Duplicate meter reading for the same sample and point")
        seen.add(key)
        result = {**reading, "notificationAtMs": notification_at}
        if point == "load-3v3":
            result["ina219"] = {key: ina219[key] for key in ("busVoltageMv", "currentUa")}
            result["meterMinusIna219"] = {
                "voltageMv": None if voltage is None else voltage - ina219["busVoltageMv"],
                "currentUa": None if current is None else current - ina219["currentUa"],
            }
        paired.append(result)

    return {"version": 1, "pairingSource": "operator", "captureSha256": capture_sha, "usbLogSha256": usb_sha,
            "boardRevision": capture["boardRevision"], "firmwareRevision": capture["firmwareRevision"],
            "captureStatus": capture["status"], "session": session, "readings": paired,
            **({"assemblyRecordSha256": assembly_sha} if assembly_sha is not None else {})}


def read_json(path: Path, limit: int) -> tuple[dict, str]:
    with path.open("rb") as stream:
        content = stream.read(limit + 1)
    return _object(content, limit), hashlib.sha256(content).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--meter", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="new private evidence file")
    args = parser.parse_args()
    try:
        capture, capture_sha = read_json(args.capture, CAPTURE_LIMIT)
        meter, meter_sha = read_json(args.meter, METER_LIMIT)
        report = pair_measurements(capture, capture_sha, meter)
        report["meterFileSha256"] = meter_sha
        content = (canonical(report) + "\n").encode("utf-8")
        os.umask(0o077)
        with args.output.open("xb") as stream:
            stream.write(content)
        print(f"Paired {len(report['readings'])} meter readings. SHA-256 {hashlib.sha256(content).hexdigest()}")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, BleProtocolError) as error:
        parser.exit(1, f"Power evidence comparison stopped ({type(error).__name__}).\n")


if __name__ == "__main__":
    main()
