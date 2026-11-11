"""Capture BLE range, reconnect, wake, battery alerts and r18 bring-up on Linux/BlueZ."""
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

from .ble import BleFleet, _r18_bringup
from .config import ID
from .model import canonical, iso_time, valid_button_presses

MAX_EVENTS = 8192
BOARD_REVISIONS = {"feather-bench": "feather-esp32-v2", "r18-pcb": "r18-hand-solder"}
# Confirm/Panic are GPIO6/7 in firmware/include/board_r18.h.
WAKE_CASES = {"confirm": ("button", 1 << 6), "panic": ("button", 1 << 7),
              "motion": ("motion", 0), "timer": ("timer", 0)}
BATTERY_THRESHOLDS = (20, 25)
BATTERY_STAGES = ("initialClear", "clearInBand", "lowAlert", "alertInBand", "recovered")
BRINGUP_BUTTON_STATES = ("released", "confirm", "released", "panic", "released")
USB_LOG_LIMIT = 1 << 20
R18_APP_IMAGE_LIMIT = 0x600000  # Factory app partition in keyring/firmware/partitions.csv.
USB_BOOT_LINE = re.compile(
    r"KEYRING bringup: board=(?P<board>\S+) firmware=(?P<firmware>\S+) boot=(?P<boot>[0-9a-f]{32}) "
    r"motor=(?P<motor>[01]) aux=(?P<aux>[01]) fault=(?P<fault>[01]) "
    r"fuel=(?P<batteryStatus>ok|unavailable) accel=(?P<accelStatus>ok|unavailable) "
    r"motion=(?P<motion>ready|unavailable)(?: panel=(?P<panel>st7789|jd9853))?"
    r"(?: appSha256=(?P<app>[0-9a-f]{64}|unavailable))?"
)
BRINGUP_SENSOR_STATUS = ("batteryStatus", "accelStatus", "motion")
DISPLAY_TEST_PROFILES = {f"keyring-{revision}-{panel}-bringup": panel
                         for revision in ("0.7.16", "0.7.17", "0.7.18", "0.7.21", "0.7.22", "0.7.23", "0.7.24")
                         for panel in ("st7789", "jd9853")}
BRINGUP_DISPLAY_PROFILES = {
    "keyring-0.7.15-st7789-bringup": "st7789", "keyring-0.7.15-jd9853-bringup": "jd9853",
    **DISPLAY_TEST_PROFILES,
}
APP_DIGEST_PROFILES = {
    "keyring-0.7.18-bringup", "keyring-0.7.18-st7789-bringup", "keyring-0.7.18-jd9853-bringup",
    "keyring-0.7.21-bringup", "keyring-0.7.21-st7789-bringup", "keyring-0.7.21-jd9853-bringup",
    "keyring-0.7.22-bringup", "keyring-0.7.22-st7789-bringup", "keyring-0.7.22-jd9853-bringup",
    "keyring-0.7.23-bringup", "keyring-0.7.23-st7789-bringup", "keyring-0.7.23-jd9853-bringup",
    "keyring-0.7.24-st7789-bringup", "keyring-0.7.24-jd9853-bringup",
}


def read_usb_boot(path: Path, board: str, firmware: str) -> dict:
    with path.open("rb") as stream:
        raw = stream.read(USB_LOG_LIMIT + 1)
    if len(raw) > USB_LOG_LIMIT:
        raise ValueError("USB log exceeds the bring-up log limit")
    lines = {line for line in raw.decode("utf-8-sig", errors="replace").splitlines()
             if line.startswith("KEYRING bringup:")}
    record = USB_BOOT_LINE.fullmatch(lines.pop()) if len(lines) == 1 else None
    if (record is None or record["board"] != board or record["firmware"] != firmware
            or record["panel"] != BRINGUP_DISPLAY_PROFILES.get(firmware)
            or (record["app"] is not None) != (firmware in APP_DIGEST_PROFILES)):
        raise ValueError("USB log must contain one matching r18 bring-up record")
    evidence = {"bootId": record["boot"], "logSha256": hashlib.sha256(raw).hexdigest(),
                "motorActive": record["motor"] == "1", "auxEnabled": record["aux"] == "1",
                "mainFault": record["fault"] == "1", "sensorStatus": {key: record[key] for key in BRINGUP_SENSOR_STATUS}}
    if record["panel"] is not None:
        evidence["displayProfile"] = record["panel"]
    if record["app"] is not None:
        evidence["appSha256"] = record["app"]
    return evidence


def read_firmware_image(path: Path, usb_boot: dict) -> dict:
    running_digest = usb_boot.get("appSha256")
    if running_digest in (None, "unavailable"):
        raise ValueError("USB record has no running app image digest")
    with path.open("rb") as stream:
        image = stream.read(R18_APP_IMAGE_LIMIT + 1)
    # ESP32-S3 application image, with the app descriptor in its first segment.
    if (not 80 <= len(image) <= R18_APP_IMAGE_LIMIT or image[0] != 0xe9 or not 1 <= image[1] <= 16
            or image[12:14] != b"\x09\x00" or image[23] != 1 or image[32:36] != b"\x32\x54\xcd\xab"):
        raise ValueError("Expected an ESP32-S3 app image with a SHA-256 footer")
    offset = 24
    payload_end = len(image) - 32
    for _ in range(image[1]):
        if offset + 8 > payload_end:
            raise ValueError("Invalid ESP32-S3 image segment layout")
        offset += 8 + int.from_bytes(image[offset + 4:offset + 8], "little")
    # One checksum byte ends the padded 16-byte block, immediately before the hash.
    checksum_end = (offset + 16) & ~15
    if checksum_end != payload_end:
        raise ValueError("Expected an unsigned app image with no trailing data")
    digest = hashlib.sha256(memoryview(image)[:payload_end]).digest()
    if digest != image[payload_end:]:
        raise ValueError("Firmware image SHA-256 footer does not match its contents")
    if digest.hex() != running_digest:
        raise ValueError("Firmware image differs from the running app in the USB log")
    return {"fileSha256": hashlib.sha256(image).hexdigest(), "sizeBytes": len(image)}


def boot_id_sha256(boot_id: str) -> str:
    return hashlib.sha256(boot_id.encode("ascii")).hexdigest()


def wake_result(sessions: list[dict], rows: list[dict], expected: str, release_ms: int | None,
                boot_ids: dict[int, str]) -> dict:
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
        if report["matched"]:
            report.update(bootIdSha256=boot_id_sha256(boot_ids[after["boot"]]), sequence=health["sequence"])
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


def battery_result(rows: list[dict], warn: int, recover: int) -> dict:
    cycle = []
    matched = None
    missing = unknown = mismatched = 0
    for row in rows:
        if row["event"] != "notification":
            cycle.clear()
            continue
        if "batteryAlert" not in row:
            missing += 1
            cycle.clear()
            continue
        percent, alert = row["batteryPercent"], row["batteryAlert"]
        if percent is None:
            unknown += 1
            continue
        if percent >= recover:
            expected = False
            step = 4 if len(cycle) == 4 else 0
        elif percent <= warn:
            expected = True
            step = 2
        else:
            expected = alert
            step = 3 if alert else 1
        if alert is not expected:
            mismatched += 1
            cycle.clear()
            continue
        marker = {"stage": BATTERY_STAGES[step], "session": row["session"],
                  "atMs": row["atMs"], "sequence": row["sequence"],
                  "batteryPercent": percent, "batteryAlert": alert}
        if step == 4:
            if matched is None:
                matched = [*cycle, marker]
            cycle = [{**marker, "stage": BATTERY_STAGES[0]}]
        elif step == len(cycle):
            cycle.append(marker)
        elif step == 0 or (step == 2 and len(cycle) == 4):
            # Re-entering an outer band starts that part of the sweep again.
            cycle[step:] = [marker]
        elif step != len(cycle) - 1:
            cycle.clear()
    return {"warnPercent": warn, "recoverPercent": recover, "matchedCycle": matched,
            "missingAlertFrames": missing, "unknownFrames": unknown, "mismatchedFrames": mismatched}


def button_fields(frame: dict) -> dict:
    presses = frame["sensorValues"].get("buttonPresses")
    return {"deviceUptimeMs": frame["uptimeMs"], "buttonState": frame["buttonState"],
            "buttonPresses": presses if valid_button_presses(presses) else None}


def bringup_fields(frame: dict) -> dict:
    sensors = frame["sensorValues"]
    detail = sensors.get("detail")
    axes = sensors.get("accelerationG")
    axes_valid = (isinstance(axes, list) and len(axes) == 3
                  and all(type(value) in (int, float) and -float("inf") < value < float("inf") for value in axes))
    fault = sensors.get("fault")
    battery_status, accel_status, motion = (sensors.get(key) for key in BRINGUP_SENSOR_STATUS)
    journal = sensors.get("journal")
    result = {
        **button_fields(frame),
        "detail": detail if detail in ("sensors", "energy", "health") else None,
        "state": frame["state"], "mainFault": fault if type(fault) is bool else None,
        "batteryPercent": frame["battery"], "accelerationG": axes if axes_valid else None,
        "batteryStatus": battery_status if battery_status in ("ok", "unavailable") else None,
        "accelStatus": accel_status if accel_status in ("ok", "unavailable") else None,
        "motion": motion if motion in ("ready", "unavailable") else None,
        "sensorsReady": (detail == "sensors" and battery_status == "ok"
                         and accel_status == "ok" and motion == "ready"
                         and frame["battery"] is not None and axes_valid),
        "journal": journal if journal in ("disabled", "ready", "error") else None,
        "sleepDisabled": detail == "health" and sensors.get("power") == "disabled",
    }
    if detail == "health":
        status = sensors.get("display")
        if status in ("starting", "disabled", "bus_error", "worker_error", "st7789_unverified", "jd9853_unverified"):
            result["displayStatus"] = status
        drawn = sensors.get("displayDrawnPresses")
        if valid_button_presses(drawn):
            result["displayDrawnPresses"] = drawn
    return result


def bringup_buttons(rows: list[dict]) -> tuple[list[int], bool]:
    markers = []
    previous = None
    regressed = False
    for row in rows:
        presses = row.get("buttonPresses")
        if presses is None:
            continue
        if previous is not None and any(current < earlier for current, earlier in zip(presses, previous)):
            regressed = True
        previous = presses
        step = len(markers)
        if step == len(BRINGUP_BUTTON_STATES) or row["buttonState"] != BRINGUP_BUTTON_STATES[step]:
            continue
        if markers:
            confirm, panic = (current - earlier for current, earlier in zip(presses, markers[-1]["buttonPresses"]))
            expected = (1, 0) if step == 1 else (0, 1) if step == 3 else (0, 0)
            if (confirm, panic) != expected:
                continue
        markers.append(row)
    return [row["sequence"] for row in markers], regressed


def bringup_result(sessions: list[dict], rows: list[dict], *, expected_display: str | None = None) -> dict:
    first = next((session for session in sessions if session["notificationCount"]), None)
    session_id = first["session"] if first else None
    notifications = [row for row in rows if row["event"] == "notification"]
    selected = [row for row in notifications if row["session"] == session_id]
    buttons, regressed = bringup_buttons(selected)
    sensors = next((row["sequence"] for row in selected if row.get("sensorsReady")), None)
    power = next((row["sequence"] for row in selected if (row.get("ina219") or {}).get("status") == "ok"), None)
    health = next((row["sequence"] for row in selected if row.get("journal") == "disabled" and row.get("sleepDisabled")), None)
    last_sensor_row = next((row for row in reversed(selected) if row.get("detail") == "sensors"), None)
    last_power_row = next((row for row in reversed(selected) if "ina219" in row or row.get("detail") == "energy"), None)
    latest_sensor = None
    if last_sensor_row is not None:
        latest_sensor = {"sequence": last_sensor_row["sequence"], "ready": last_sensor_row["sensorsReady"],
                         **{key: last_sensor_row[key] for key in BRINGUP_SENSOR_STATUS}}
    latest_power = None
    if last_power_row is not None:
        latest_power = {"sequence": last_power_row["sequence"], "status": (last_power_row.get("ina219") or {}).get("status")}
    sensor_regressed = (sensors is not None and latest_sensor is not None
                        and any(latest_sensor[key] == "unavailable" for key in BRINGUP_SENSOR_STATUS))
    power_regressed = power is not None and latest_power is not None and latest_power["status"] not in (None, "ok")
    missing = [name for name, present in (
        ("commandDisabled", first is not None and first["commandReady"] is False),
        ("safeOutputs", selected and all(row.get("state") is False and row.get("mainFault") is False for row in selected)),
        ("buttons", len(buttons) == len(BRINGUP_BUTTON_STATES)),
        ("sensors", latest_sensor is not None and latest_sensor["ready"]),
        ("power", latest_power is not None and latest_power["status"] == "ok"),
        ("health", health is not None),
    ) if not present]
    mismatches = [name for name, observed in (
        ("commandReady", any(session["commandReady"] is True for session in sessions)),
        ("outputActive", any(row.get("state") is True for row in notifications)),
        ("mainFault", any(row.get("mainFault") is True for row in notifications)),
        ("journalEnabled", any(row.get("journal") in ("ready", "error") for row in notifications)),
        ("buttonCounterRegressed", regressed),
        ("sensorUnavailableAfterReady", sensor_regressed),
        ("powerUnavailableAfterReady", power_regressed),
    ) if observed]
    report = {"session": session_id, "buttonSequences": buttons, "sensorSequence": sensors,
              "powerSequence": power, "healthSequence": health, "latestSensor": latest_sensor, "latestPower": latest_power,
              "missing": missing, "mismatches": mismatches}
    if expected_display is not None:
        health_rows = [row for row in selected if row.get("detail") == "health"]
        latest = health_rows[-1] if health_rows else {}
        expected_status = f"{expected_display}_unverified"
        expected_presses = None
        if len(buttons) == len(BRINGUP_BUTTON_STATES):
            press_counts = {row["sequence"]: row["buttonPresses"] for row in selected if row["sequence"] in buttons}
            expected_presses = [press_counts[buttons[1]][0], press_counts[buttons[3]][1]]
        matched = (expected_presses is not None and latest.get("displayDrawnPresses") == expected_presses
                   and latest["sequence"] >= buttons[3] and latest.get("displayStatus") == expected_status)
        if latest.get("displayStatus") != expected_status:
            missing.append("displayHealth")
        if not matched:
            missing.append("displayButtonFrames")
        if any(row.get("displayStatus") not in (None, "starting", expected_status) for row in health_rows):
            mismatches.append("displayHealth")
        report["displayTest"] = {"profile": expected_display, "healthSequence": latest.get("sequence"),
                                 "softwareStatus": latest.get("displayStatus"), "expectedPresses": expected_presses,
                                 "drawnPresses": latest.get("displayDrawnPresses"), "buttonFramesMatched": matched}
    return report


def reconnect_results(sessions: list[dict]) -> list[dict]:
    results = []
    previous = None
    for current in sessions:
        first = current["firstNotificationAtMs"]
        if first is None:
            continue
        if previous is not None and previous["lostAtMs"] is not None:
            results.append({"fromSession": previous["session"], "toSession": current["session"],
                            "lossToNotificationMs": first - previous["lostAtMs"],
                            "sameBoot": previous["boot"] == current["boot"]})
        previous = current
    return results


def button_continuity_result(sessions: list[dict], reconnects: list[dict], rows: list[dict]) -> dict:
    report = {"before": None, "after": None, "buttonDelta": None, "sequenceGap": None,
              "missing": [], "mismatches": []}
    missing, mismatches = report["missing"], report["mismatches"]
    if not reconnects:
        missing.append("recovery")
        return report
    boundary = reconnects[0]
    from_session, to_session = boundary["fromSession"], boundary["toSession"]
    notifications = [row for row in rows if row["event"] == "notification"]
    before = next(row for row in reversed(notifications) if row["session"] == from_session)
    after = next(row for row in notifications if row["session"] == to_session)
    fields = ("session", "atMs", "sequence", "deviceUptimeMs", "buttonState", "buttonPresses")
    report.update(before={key: before.get(key) for key in fields}, after={key: after.get(key) for key in fields})
    boots = {session["boot"] for session in sessions if from_session <= session["session"] <= to_session}
    if len(boots) != 1:
        mismatches.append("bootChanged")
        return report

    sequence_delta = after["sequence"] - before["sequence"]
    if sequence_delta <= 0:
        mismatches.append("sequenceDidNotAdvance")
    else:
        report["sequenceGap"] = sequence_delta - 1
    before_uptime, after_uptime = before.get("deviceUptimeMs"), after.get("deviceUptimeMs")
    if before_uptime is None or after_uptime is None:
        missing.append("uptime")
    elif after_uptime < before_uptime:
        mismatches.append("uptimeRegressed")
    before_presses, after_presses = before.get("buttonPresses"), after.get("buttonPresses")
    if before_presses is None or not all(before_presses) or before.get("buttonState") != "released":
        missing.append("buttonBaseline")
    if after_presses is None:
        missing.append("recoveredButtons")
    if before_presses is not None and after_presses is not None:
        deltas = [current - earlier for current, earlier in zip(after_presses, before_presses)]
        report["buttonDelta"] = deltas
        if any(delta < 0 for delta in deltas):
            mismatches.append("buttonCounterRegressed")
    return report


def summarize(events: list[dict], start_ns: int, stop_ns: int, *, board: str, mode: str,
              truncated: bool, dropped: int, expected_wake: str | None = None,
              release_ms: int | None = None, include_power: bool = False,
              battery_thresholds: tuple[int, int] = BATTERY_THRESHOLDS,
              verify_button_continuity: bool = False, usb_boot: dict | None = None,
              firmware_revision: str | None = None) -> dict:
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
            if mode == "bringup":
                sessions[key]["commandReady"] = event.get("commandReady")
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
                if (include_power or mode == "bringup") and "ina219" in event:
                    row.update(ina219=event["ina219"], deviceUptimeMs=event["deviceUptimeMs"])
                if mode == "battery" and "batteryAlert" in event:
                    row.update(batteryPercent=event["batteryPercent"], batteryAlert=event["batteryAlert"])
                if mode == "bringup" and "observation" in event:
                    row.update(bringup_fields(event["observation"]))
                elif verify_button_continuity and "observation" in event:
                    row.update(button_fields(event["observation"]))
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
    reconnects = reconnect_results(measured)
    notifications = sum(session["notificationCount"] for session in measured)
    wake = (wake_result(measured, rows, expected_wake, release_ms, {ordinal: boot_id for boot_id, ordinal in boots.items()})
            if expected_wake is not None else None)
    power = power_result(measured, rows, mode) if include_power else None
    battery = battery_result(rows, *battery_thresholds) if mode == "battery" else None
    bringup = (bringup_result(measured, rows, expected_display=DISPLAY_TEST_PROFILES.get(firmware_revision))
               if mode == "bringup" else None)
    if bringup is not None and usb_boot is not None:
        observed_boots = {session["boot"] for session in measured if session["notificationCount"]}
        same_boot = observed_boots == {boots.get(usb_boot["bootId"])} if observed_boots else None
        pins_safe = not (usb_boot["motorActive"] or usb_boot["auxEnabled"] or usb_boot["mainFault"])
        bringup["usbBoot"] = {key: usb_boot[key] for key in ("logSha256", "motorActive", "auxEnabled", "mainFault", "sensorStatus")}
        if "displayProfile" in usb_boot:
            bringup["usbBoot"]["displayProfile"] = usb_boot["displayProfile"]
        if "appSha256" in usb_boot:
            bringup["usbBoot"]["appSha256"] = usb_boot["appSha256"]
        if "firmwareImage" in usb_boot:
            bringup["usbBoot"]["firmwareImage"] = usb_boot["firmwareImage"]
        bringup["usbBoot"].update(sameBoot=same_boot, pinsSafe=pins_safe)
        if same_boot is None:
            bringup["missing"].append("usbBootMatch")
        elif not same_boot:
            bringup["mismatches"].append("usbBootMismatch")
        if not pins_safe:
            bringup["mismatches"].append("usbPinsUnsafe")
    continuity = button_continuity_result(measured, reconnects, rows) if verify_button_continuity else None
    status = "RECORDED"
    if truncated:
        status = "TRUNCATED"
    elif ((battery is not None and battery["mismatchedFrames"]) or (bringup is not None and bringup["mismatches"])
          or (continuity is not None and continuity["mismatches"])):
        status = "MISMATCH"
    elif (not notifications or unexpected_boards or dropped or (mode == "reconnect" and not reconnects)
          or (mode == "wake" and (wake is None or not wake["matched"]))
          or (power is not None and power["missingPhases"])
          or (battery is not None and (battery["matchedCycle"] is None or battery["missingAlertFrames"]))
          or (bringup is not None and bringup["missing"])
          or (continuity is not None and continuity["missing"])):
        status = "INSUFFICIENT"
    report = {"status": status, "durationMs": (stop_ns - start_ns) // 1_000_000,
              "notificationCount": notifications, "droppedByReceiver": dropped,
              "unexpectedBoardSessions": unexpected_boards, "sessions": measured,
              "reconnects": reconnects, "events": rows}
    if wake is not None:
        report["wake"] = wake
    if power is not None:
        report["power"] = power
    if battery is not None:
        report["battery"] = battery
    if bringup is not None:
        report["bringup"] = bringup
    if continuity is not None:
        report["buttonContinuity"] = continuity
    return report


async def characterize(args: argparse.Namespace, *, usb_boot: dict | None = None) -> dict:
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
        initial_generation = None
        baseline_announced = False
        last_marked_read = -1
        capturing = True

        def trace(event: dict) -> None:
            nonlocal truncated, initial_generation, baseline_announced, last_marked_read
            if not capturing:
                return
            if len(events) < MAX_EVENTS:
                events.append({**event, "phase": phase})
            else:
                truncated = True
            if event["event"] == "notification" and event["boardRevision"] == board:
                if initial_generation is None:
                    initial_generation = event["generation"]
                if event["generation"] not in receiving:
                    receiving.add(event["generation"])
                    if args.mode == "bringup" and not first.is_set():
                        print("Baseline window: release both buttons, then hold and release Confirm and Panic in order.",
                              flush=True)
                    first.set()
                    print("First notification received for this BLE session.", flush=True)
                if args.verify_button_continuity and event["generation"] == initial_generation and not baseline_announced:
                    buttons = button_fields(event["observation"])
                    if buttons["buttonState"] == "released" and buttons["buttonPresses"] and all(buttons["buttonPresses"]):
                        baseline_announced = True
                        print("Both button counts recorded. Interrupt and restore BLE while keeping the keyring powered.",
                              flush=True)
                reading = event.get("ina219")
                if reading is not None and reading["status"] == "ok":
                    first_power.set()
                    if (args.print_power_markers and usb_boot is not None and event["bootId"] == usb_boot["bootId"]
                            and event["generation"] == initial_generation and not truncated
                            and reading["readUptimeMs"] > last_marked_read):
                        last_marked_read = reading["readUptimeMs"]
                        print(f"R18_POWER_SAMPLE sequence={event['sequence']} readUptimeMs={last_marked_read}", flush=True)

        await fleet.start(discard_observation, trace=trace,
                          trace_observation=args.mode == "bringup" or args.verify_button_continuity)
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
                          release_ms=release_ms, include_power=args.include_power,
                          battery_thresholds=tuple(args.battery_thresholds or BATTERY_THRESHOLDS),
                          verify_button_continuity=args.verify_button_continuity, usb_boot=usb_boot,
                          firmware_revision=args.firmware_revision)}
    if args.mode == "wake":
        report["wake"].update(operatorIdleSeconds=args.idle_seconds, releaseAtMs=release_ms)
    if args.mode == "battery":
        report["battery"].update(inputSource=args.battery_source, inputSourceAttestedBy="operator")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("range", "reconnect", "wake", "battery", "bringup"), required=True)
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
    parser.add_argument("--verify-button-continuity", action="store_true", help="require same-boot r18 reconnect evidence")
    parser.add_argument("--battery-source", choices=("physical-pack", "gauge-fixture"), help="battery mode only")
    parser.add_argument("--battery-thresholds", nargs=2, type=int, metavar=("WARN", "RECOVER"),
                        help="battery mode only; firmware percentages (default: 20 25)")
    parser.add_argument("--usb-boot-log", type=Path, help="private USB CDC capture from one r18 bring-up boot")
    parser.add_argument("--firmware-image", type=Path, help="local r18 firmware.bin to match against the USB app digest")
    parser.add_argument("--print-power-markers", action="store_true", help="print new INA219 samples from the USB-matched bring-up session")
    parser.add_argument("--database", type=Path, required=True, help="Gateway state path; used only to find its lock")
    parser.add_argument("--output", type=Path, required=True, help="new private JSON file under an existing directory")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("this operator command requires Linux/BlueZ")
    if (any(ID.fullmatch(value) is None for value in (args.gateway_id, args.device_id, args.firmware_revision))
            or re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", args.address) is None):
        parser.error("invalid BLE enrollment or revision")
    max_seconds = 7200 if args.mode == "battery" else 600
    if not 1 <= args.distance_cm <= 100_000 or not 10 <= args.seconds <= max_seconds:
        parser.error(f"distance must be 1..100000 cm and duration 10..{max_seconds} seconds")
    if args.include_power and args.hardware != "r18-pcb":
        parser.error("--include-power requires r18-pcb")
    if args.verify_button_continuity and (args.mode != "reconnect" or args.hardware != "r18-pcb"):
        parser.error("--verify-button-continuity requires reconnect mode and r18-pcb")
    if args.mode == "wake":
        if (args.hardware != "r18-pcb" or args.expect_wake is None or args.idle_seconds is None
                or not 10 <= args.idle_seconds <= 3600):
            parser.error("wake mode requires r18-pcb, --expect-wake and --idle-seconds 10..3600")
    elif args.expect_wake is not None or args.idle_seconds is not None:
        parser.error("idle seconds and expected wake require wake mode")
    if args.mode == "battery":
        warn, recover = args.battery_thresholds or BATTERY_THRESHOLDS
        if args.hardware != "r18-pcb" or args.battery_source is None or not 0 <= warn < recover <= 100:
            parser.error("battery mode requires r18-pcb, --battery-source and thresholds 0 <= WARN < RECOVER <= 100")
    elif args.battery_source is not None or args.battery_thresholds is not None:
        parser.error("battery source and thresholds require battery mode")
    if args.mode == "bringup" and not _r18_bringup({
            "boardRevision": BOARD_REVISIONS[args.hardware], "firmwareRevision": args.firmware_revision}):
        parser.error("bringup mode requires r18-pcb and an observation-only -bringup firmware revision")
    if args.print_power_markers and (args.mode != "bringup" or args.usb_boot_log is None):
        parser.error("--print-power-markers requires bringup mode and --usb-boot-log")
    if args.firmware_image is not None and (args.mode != "bringup" or args.usb_boot_log is None):
        parser.error("--firmware-image requires bringup mode and --usb-boot-log")
    usb_boot = None
    if args.usb_boot_log is not None:
        if args.mode != "bringup" or not args.usb_boot_log.is_file():
            parser.error("--usb-boot-log requires bringup mode and an existing capture file")
        try:
            usb_boot = read_usb_boot(args.usb_boot_log, BOARD_REVISIONS[args.hardware], args.firmware_revision)
        except ValueError as exc:
            parser.error(str(exc))
        except OSError:
            parser.error("could not read the USB capture file")
    if args.firmware_image is not None:
        try:
            usb_boot["firmwareImage"] = read_firmware_image(args.firmware_image, usb_boot)
        except ValueError as exc:
            parser.error(str(exc))
        except OSError:
            parser.error("could not read the firmware image file")
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
            if args.mode == "bringup":
                print("BLE capture started. Keep both buttons released until the first notification.", flush=True)
            elif args.verify_button_continuity:
                print("BLE capture started. If no baseline is announced after the first notification, press and release each button.",
                      flush=True)
            else:
                print("BLE capture started. For reconnect mode, wait for observations, interrupt the link and restore it.",
                      flush=True)
            report = asyncio.run(characterize(args, usb_boot=usb_boot))
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
