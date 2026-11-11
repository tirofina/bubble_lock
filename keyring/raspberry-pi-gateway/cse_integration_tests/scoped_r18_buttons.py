"""Read scoped r18 button observations and reconcile them with the central panic incident."""

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path

from bubble_gateway.ble_characterize import BRINGUP_BUTTON_STATES, bringup_buttons, read_usb_boot
from bubble_gateway.config import ID
from bubble_gateway.integration_evidence import require_integration_event
from bubble_gateway.model import iso_time, observation_button_presses, parse_time, payload_hash, utc_now, validate_observation
from pi_led_cycle import content_name, verify_observation_resource, write_new_json
from scoped_command_io import hash_observation, scoped_api, scoped_cse
from scoped_feather_evidence import read_json
from scoped_feather_pi import R18_BOARD, R18_BRINGUP_FIRMWARES, R18_DEVICE
from scoped_r18_observation import NATIVE_CONFIRMATION_LINE, bound_observation, compare_observation
from scoped_r18_pulse import GATEWAY, PATHS, SUBJECT

LOG_LIMIT = 1 << 20
OBSERVATION_LIMIT = 64
BUTTON_FIRMWARES = tuple(revision for revision in R18_BRINGUP_FIRMWARES
                         if revision.startswith(("keyring-0.7.21-", "keyring-0.7.22-", "keyring-0.7.23-")))


def button_sample(native, baseline):
    original = baseline["native"]["con"]
    observation = validate_observation(native["con"], GATEWAY, {R18_DEVICE: ""})
    if (observation["bootId"] != original["bootId"] or observation["firmwareRevision"] != baseline["firmwareRevision"]
            or observation["sequence"] < original["sequence"]):
        raise ValueError("Button observation differs from the scoped r18 boot")
    rqi = verify_observation_resource({**observation, "cseResource": native}, R18_DEVICE,
                                      baseline["observationContainerRi"])
    presses = observation_button_presses(observation["sensorValues"])
    if presses is None:
        raise ValueError("Button observation has no boot-local press counts")
    return observation, rqi, {"sequence": observation["sequence"], "buttonState": observation["buttonState"],
                              "buttonPresses": presses}


def read_pi_log(path):
    with path.open("rb") as stream:
        raw = stream.read(LOG_LIMIT + 1)
    if len(raw) > LOG_LIMIT:
        raise ValueError("Use a Pi log from a single scoped test session")
    return raw, hashlib.sha256(raw).hexdigest()


async def capture_buttons(cse, baseline, pi_log):
    raw_log, log_hash = read_pi_log(pi_log)
    initial = baseline["native"]
    observation, baseline_rqi, sample = button_sample(initial, baseline)
    if sample["buttonState"] != BRINGUP_BUTTON_STATES[0]:
        raise ValueError("Capture the baseline with both buttons released")
    gateway_boot = baseline["health"]["con"]["bootId"]
    records = {}
    for line in raw_log.splitlines():
        match = NATIVE_CONFIRMATION_LINE.search(line)
        if match is None or match[5] != gateway_boot.encode("ascii"):
            continue
        rqi, digest = (match[index].decode("ascii") for index in (1, 2))
        if rqi in records and records[rqi] != digest:
            raise ValueError("Pi log contains conflicting observation hashes")
        records[rqi] = digest
    if records.get(baseline_rqi) != payload_hash(observation):
        raise ValueError("Pi log does not confirm the scoped button baseline")
    requests = list(records)
    start = requests.index(baseline_rqi) + 1
    rows, resources = [sample], {sample["sequence"]: initial}
    for rqi in requests[start:start + OBSERVATION_LIMIT]:
        status, rsc, body = await cse("GET", f"{PATHS['observation']}/{content_name(rqi)}")
        if (status, rsc) != (200, 2000):
            raise ValueError("A Pi-confirmed observation is unavailable in scoped Mobius4")
        native = body["m2m:cin"]
        observation, actual_rqi, sample = button_sample(native, baseline)
        sequence = sample["sequence"]
        if actual_rqi != rqi or payload_hash(observation) != records[rqi] or sequence <= rows[-1]["sequence"]:
            raise ValueError("Pi and Mobius4 button observation hashes or order differ")
        rows.append(sample)
        resources[sequence] = native
        markers, regressed = bringup_buttons(rows)
        if regressed:
            raise ValueError("Button press counts regressed within the scoped boot")
        if len(markers) == len(BRINGUP_BUTTON_STATES):
            return {"version": 1, "teamRevision": baseline["teamRevision"], "baselineRequestId": baseline_rqi,
                    "piLogSha256": log_hash, "capturedAt": iso_time(), "native": [resources[seq] for seq in markers]}
    raise ValueError("The Pi log has no complete confirm and panic press/release sequence after the baseline")


def inspect_panic(observation, report, team_state):
    observation_id = report["observationId"]
    incident = team_state.get("deviceIncidentEvents", {}).get(observation_id)
    if not isinstance(incident, dict):
        raise ValueError("Central telemetry was accepted without a matching panic incident")
    incident_id, status, latency = (incident.get(key) for key in ("incidentId", "status", "latencyMs"))
    expected = {"observationId": observation_id, "deviceId": R18_DEVICE, "householdId": SUBJECT,
                "observedAt": observation["observedAt"], "simulation": False}
    if (any(incident.get(key) != value for key, value in expected.items()) or incident.get("simulation") is not False
            or not isinstance(incident_id, str) or not ID.fullmatch(incident_id)
            or status not in {"INCIDENT_OPENED", "OPEN_INCIDENT_REUSED"}
            or type(latency) is not int or not -2000 <= latency <= 30000):
        raise ValueError("Panic incident does not match the physical scoped observation")
    portal = team_state.get("portalIncidents", {}).get(incident_id)
    if (not isinstance(portal, dict) or portal.get("incidentId") != incident_id or portal.get("kind") != "SAFETY"
            or portal.get("deviceId") != R18_DEVICE or portal.get("householdId") != SUBJECT):
        raise ValueError("Central safety incident is missing or belongs to another scope")
    accepted_at = parse_time(incident["acceptedAt"])
    event = require_integration_event(
        team_state, "DEVICE_PANIC_RECONCILED", {"observationId": observation_id},
        dict(expected, incidentId=incident_id, status=status, acceptedAt=incident["acceptedAt"], latencyMs=latency))
    if (event.get("simulation") is not False
            or not accepted_at <= parse_time(event["timestamp"]) <= parse_time(report["centralEvent"]["timestamp"])):
        raise ValueError("Panic reconciliation falls outside its central acceptance")
    return {"incidentId": incident_id, "eventId": event["eventId"], "status": status, "latencyMs": latency}


def compare_buttons(bundle, baseline, usb, pi_log, database, team_state, hasher):
    _, log_hash = read_pi_log(pi_log)
    _, baseline_rqi, _ = button_sample(baseline["native"], baseline)
    if (type(bundle.get("version")) is not int or bundle["version"] != 1
            or bundle.get("teamRevision") != baseline["teamRevision"] or bundle.get("baselineRequestId") != baseline_rqi
            or bundle.get("piLogSha256") != log_hash or parse_time(bundle["capturedAt"]) < parse_time(baseline["capturedAt"])):
        raise ValueError("Button capture does not belong to the scoped baseline and Pi log")
    resources = bundle["native"]
    if (not isinstance(resources, list) or len(resources) != len(BRINGUP_BUTTON_STATES)
            or resources[0] != baseline["native"]):
        raise ValueError("Expected five scoped observations starting at the released baseline")
    samples = [button_sample(native, baseline)[2] for native in resources]
    sequences = [sample["sequence"] for sample in samples]
    if bringup_buttons(samples) != (sequences, False) or sequences != sorted(set(sequences)):
        raise ValueError("Button states, sequence or press counts differ from the scoped gesture")

    reports = [compare_observation(dict(baseline, native=native, capturedAt=bundle["capturedAt"]), usb,
                                   database, team_state, hasher, pi_log=pi_log) for native in resources]
    if any(not row["physicalRelayEvidenceMatched"] or row["nativePendingOnPi"] or row["centralPendingOnPi"]
           or row["nativeDelivery"].get("gatewayBootMatched") is not True
           or row["nativeDelivery"]["logSha256"] != log_hash for row in reports):
        raise ValueError("Physical button observations lack matched Pi, Mobius4 and central delivery")
    central_sequences = [row["centralEvent"]["sequence"] for row in reports]
    if central_sequences != sorted(set(central_sequences)):
        raise ValueError("Central acceptance did not preserve button order")
    panic = BRINGUP_BUTTON_STATES.index("panic")
    incident = inspect_panic(resources[panic]["con"], reports[panic], team_state)
    return {"deviceId": R18_DEVICE, "firmwareRevision": baseline["firmwareRevision"], "piLogSha256": log_hash,
            "buttonSequences": dict(zip(("initial", "confirm", "confirmRelease", "panic", "panicRelease"), sequences)),
            "centralSequences": central_sequences, "panicObservationId": reports[panic]["observationId"],
            "panicIncident": incident}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--usb-boot-log", type=Path, required=True)
    parser.add_argument("--pi-log", type=Path, required=True)
    modes = parser.add_subparsers(dest="mode", required=True)
    capture = modes.add_parser("capture")
    capture.add_argument("--output", type=Path, required=True)
    compare = modes.add_parser("compare")
    compare.add_argument("--button-capture", type=Path, required=True)
    compare.add_argument("--database", type=Path, required=True)
    compare.add_argument("--team-state", type=Path, required=True)
    args = parser.parse_args()
    api, operator_dir = scoped_api("r18")
    baseline = read_json(args.baseline)
    firmware = baseline["firmwareRevision"]
    if baseline["teamRevision"] != api["revision"] or firmware not in BUTTON_FIRMWARES:
        parser.error("Expected a baseline from the pinned r18 button firmware and team revision")
    usb = read_usb_boot(args.usb_boot_log, R18_BOARD, firmware)
    if (baseline["usbLogSha256"] != usb["logSha256"] or any(usb[key] for key in ("motorActive", "auxEnabled", "mainFault"))
            or bound_observation(baseline["native"], baseline["health"], usb=usb, firmware=firmware,
                                 observation_pin=baseline["observationContainerRi"], health_pin=baseline["healthContainerRi"],
                                 started_at=parse_time(baseline["startedAt"]),
                                 captured_at=parse_time(baseline["capturedAt"])) is None):
        parser.error("Button baseline differs from the scoped r18 USB boot")
    if args.mode == "capture":
        async def capture_live():
            async with scoped_cse() as cse:
                return await capture_buttons(cse, baseline, args.pi_log)

        bundle = asyncio.run(capture_live())
        os.umask(0o077)
        write_new_json(args.output, bundle)
    else:
        team_utils = operator_dir / "team-source/pc-mobius/integration/src/integration-utils.mjs"
        report = compare_buttons(read_json(args.button_capture), baseline, usb, args.pi_log, args.database,
                                 read_json(args.team_state), lambda observation: hash_observation(team_utils, observation))
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
