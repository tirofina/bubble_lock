"""Pair operator LCD observations and media with a recorded r18 button test."""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path

from .ble import BleProtocolError
from .ble_characterize import BRINGUP_BUTTON_STATES, DISPLAY_TEST_PROFILES, bringup_buttons, bringup_display_result
from .model import canonical, valid_button_presses
from .power_evidence import CAPTURE_LIMIT, SHA256, read_json

OBSERVATION_LIMIT = 8192
OBSERVATION_FIELDS = {"button", "releaseSequence", "panelLabel", "screenText", "borderVisible",
                      "colorOrder", "displaySize", "mediaOffsetMs"}


def media_fingerprint(path: Path) -> dict:
    if not path.is_file():
        raise ValueError("Expected a local media file")
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
        after = os.fstat(stream.fileno())
    if not before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("Media is empty or changed during capture")
    return {"bytes": before.st_size, "sha256": digest}


def pair_display(capture: dict, capture_sha: str, notes: dict, media: tuple[dict, dict]) -> dict:
    firmware = capture.get("firmwareRevision")
    panel = DISPLAY_TEST_PROFILES.get(firmware)
    if (type(capture.get("version")) is not int or capture["version"] != 1
            or capture.get("mode") != "bringup" or capture.get("hardware") != "r18-pcb"
            or capture.get("boardRevision") != "r18-hand-solder" or panel is None):
        raise ValueError("Expected an r18 display bring-up capture")
    bringup = capture["bringup"]
    usb = bringup.get("usbBoot", {})
    usb_sha = usb.get("logSha256")
    session = bringup.get("session")
    if (usb.get("sameBoot") is not True or usb.get("displayProfile") != panel
            or not isinstance(usb_sha, str) or not SHA256.fullmatch(usb_sha)
            or type(session) is not int or session < 1):
        raise ValueError("Capture requires the same USB boot and display profile")
    observations = notes.get("observations")
    if (set(notes) != {"version", "captureSha256", "observations"} or type(notes["version"]) is not int
            or notes["version"] != 1 or notes["captureSha256"] != capture_sha
            or not isinstance(observations, list) or len(observations) != 2):
        raise ValueError("Supply two observations for this exact capture")

    rows = [row for row in capture["events"] if row["event"] == "notification" and row["session"] == session]
    sequences = [row["sequence"] for row in rows]
    times = [row["atMs"] for row in rows]
    if (any(type(sequence) is not int or not 0 <= sequence <= 0xFFFFFFFF for sequence in sequences)
            or sequences != sorted(set(sequences))):
        raise ValueError("Invalid or ambiguous BLE notification sequence")
    if (any(type(at_ms) is not int or not 0 <= at_ms <= capture["durationMs"] for at_ms in times)
            or times != sorted(times) or any(row.get("buttonPresses") is not None
                                           and not valid_button_presses(row["buttonPresses"]) for row in rows)):
        raise ValueError("Invalid BLE notification time or button counters")
    markers, regressed = bringup_buttons(rows)
    if regressed or len(markers) != len(BRINGUP_BUTTON_STATES) or markers != bringup.get("buttonSequences"):
        raise ValueError("Capture lacks a complete button sequence in the selected session")
    display_test = bringup["displayTest"]
    if display_test.get("profile") != panel or type(display_test.get("buttonFramesMatched")) is not bool:
        raise ValueError("Capture lacks the selected firmware display test result")
    display, software_mismatch = bringup_display_result(rows, markers, panel)
    button_frames_matched = display_test["buttonFramesMatched"] and display["buttonFramesMatched"]
    capture_status = capture["status"]
    if capture_status not in ("RECORDED", "MISMATCH", "INSUFFICIENT", "TRUNCATED"):
        raise ValueError("Invalid bring-up capture status")
    events = {row["sequence"]: row for row in rows}
    paired = []
    for index, (button, seen, fingerprint) in enumerate(zip(("confirm", "panic"), observations, media)):
        if not isinstance(seen, dict) or set(seen) != OBSERVATION_FIELDS:
            raise ValueError("Invalid display observation fields")
        press, release = markers[1 + index * 2:3 + index * 2]
        if seen["button"] != button or type(seen["releaseSequence"]) is not int or seen["releaseSequence"] != release:
            raise ValueError("Observation must match the recorded button release sequence")
        offset = seen["mediaOffsetMs"]
        colors, size = seen["colorOrder"], seen["displaySize"]
        valid_colors = colors is None or (isinstance(colors, list) and len(colors) == 3
            and all(isinstance(color, str) and 1 <= len(color) <= 16 for color in colors))
        valid_size = size is None or (isinstance(size, list) and len(size) == 2
            and all(type(dimension) is int and 1 <= dimension <= 4096 for dimension in size))
        if (offset is not None and (type(offset) is not int or offset < 0)
                or seen["borderVisible"] is not None and type(seen["borderVisible"]) is not bool
                or any(value is not None and (not isinstance(value, str) or not 1 <= len(value) <= 24)
                       for value in (seen["screenText"], seen["panelLabel"]))
                or not valid_colors or not valid_size):
            raise ValueError("Invalid operator display observation values")
        checks = {"panelLabel": f"{panel.upper()} LCD", "screenText": button.upper(), "borderVisible": True,
                  "colorOrder": ["red", "green", "blue"]}
        mismatches = [key for key, expected in checks.items() if seen[key] is not None and seen[key] != expected]
        missing = [key for key in (*checks, "displaySize") if seen[key] is None]
        paired.append({**seen, "pressSequence": press, "releaseAtMs": events[release]["atMs"], "media": fingerprint,
                       "missing": missing, "mismatches": mismatches})
    if media[0]["sha256"] == media[1]["sha256"]:
        first, second = (row["mediaOffsetMs"] for row in paired)
        if first is None or second is None or first >= second:
            raise ValueError("Shared media requires distinct increasing video offsets")
    sizes = [row["displaySize"] for row in paired]
    if all(size is not None for size in sizes) and sizes[0] != sizes[1]:
        paired[1]["mismatches"].append("displaySize")
    status = "MATCHED"
    if any(row["mismatches"] for row in paired):
        status = "MISMATCH"
    elif any(row["missing"] for row in paired):
        status = "INSUFFICIENT"
    evidence_status = "INSUFFICIENT"
    if status == "MISMATCH" or capture_status == "MISMATCH" or software_mismatch:
        evidence_status = "MISMATCH"
    elif status == "MATCHED" and capture_status == "RECORDED" and button_frames_matched:
        evidence_status = "MATCHED"
    return {"version": 1, "observationSource": "operator", "operatorObservationStatus": status,
            "displayEvidenceStatus": evidence_status, "softwareStatus": display["softwareStatus"],
            "healthSequence": display["healthSequence"],
            "captureSha256": capture_sha, "usbLogSha256": usb_sha, "session": session,
            "captureStatus": capture_status, "buttonFramesMatched": button_frames_matched,
            "boardRevision": capture["boardRevision"], "firmwareRevision": firmware, "displayProfile": panel,
            "observations": paired}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--observations", type=Path, required=True)
    parser.add_argument("--confirm-media", type=Path, required=True)
    parser.add_argument("--panic-media", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="new private evidence file")
    args = parser.parse_args()
    try:
        capture, capture_sha = read_json(args.capture, CAPTURE_LIMIT)
        notes, notes_sha = read_json(args.observations, OBSERVATION_LIMIT)
        media = (media_fingerprint(args.confirm_media), media_fingerprint(args.panic_media))
        report = pair_display(capture, capture_sha, notes, media)
        report["operatorFileSha256"] = notes_sha
        content = (canonical(report) + "\n").encode("utf-8")
        os.umask(0o077)
        with args.output.open("xb") as stream:
            stream.write(content)
        print(f"LCD evidence {report['displayEvidenceStatus']}. SHA-256 {hashlib.sha256(content).hexdigest()}")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, BleProtocolError) as error:
        parser.exit(1, f"Display evidence comparison stopped ({type(error).__name__}).\n")


if __name__ == "__main__":
    main()
