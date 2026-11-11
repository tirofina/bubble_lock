"""Capture and compare one observation from a scoped r18 bring-up session."""

import argparse
import asyncio
from contextlib import closing
from datetime import timedelta
import hashlib
import json
import os
from pathlib import Path
import re

from bubble_gateway.assembly_evidence import assembly_reference
from bubble_gateway.ble_characterize import read_firmware_image, read_usb_boot
from bubble_gateway.config import ID
from bubble_gateway.integration_evidence import inspect_integration_observation
from bubble_gateway.model import canonical, central_observation_id, iso_time, parse_time, payload_hash, utc_now, validate_observation
from bubble_gateway.state_identity import metadata, readonly
from bubble_gateway.store import Store
from pi_led_cycle import content_name, verify_observation_resource, write_new_json
from scoped_command_io import hash_observation, scoped_api, scoped_clients
from scoped_feather_evidence import read_json
from scoped_feather_pi import CSE_DEPLOYMENT, R18_BOARD, R18_BRINGUP_FIRMWARES, R18_DEVICE
from scoped_r18_pulse import GATEWAY, PATHS, TELEMETRY_EVENT_FIELDS

NATIVE_CONFIRMATION_LINE = re.compile(
    rb"Native observation confirmed rqi=(kr-[0-9a-f]{48}) payloadSha256=([0-9a-f]{64}) "
    rb"route=(mqtt|https|https-fallback|https-readback) created=(true|false)"
    rb"(?: gatewayBootId=([A-Za-z0-9][A-Za-z0-9._:-]{0,63}))?$"
)


def bound_observation(native, health, *, usb, firmware, observation_pin, health_pin, started_at, captured_at):
    observation = validate_observation(native["con"], GATEWAY, {R18_DEVICE: ""})
    newest = captured_at + timedelta(seconds=2)
    if (observation["bootId"] != usb["bootId"] or observation["firmwareRevision"] != firmware
            or not started_at <= parse_time(observation["receivedAt"]) <= newest):
        return None
    values = observation["sensorValues"]
    if observation["state"] is not False or values.get("fault") is not False or values.get("journal") != "disabled":
        raise ValueError("r18 observation does not show safe output and a disabled journal")
    if (type(health.get("ty")) is not int or health["ty"] != 4 or health["pi"] != health_pin
            or not isinstance(health.get("ri"), str) or not ID.fullmatch(health["ri"])):
        raise ValueError("r18 health does not belong to the pinned container")
    heartbeat = health["con"]
    if ("credentialTransition" in heartbeat or heartbeat.get("gatewayId") != GATEWAY
            or not started_at <= parse_time(heartbeat["observedAt"]) <= newest or heartbeat.get("credentialStatus") != "ACTIVE"):
        return None
    devices = [device for device in heartbeat["devices"] if device.get("deviceId") == R18_DEVICE]
    if (len(devices) != 1 or devices[0].get("bootId") != usb["bootId"]
            or devices[0].get("boardRevision") != R18_BOARD or devices[0].get("firmwareRevision") != firmware
            or devices[0].get("connected") is not True):
        return None
    if devices[0].get("commandReady") is not False or type(heartbeat.get("commandCount")) is not int or heartbeat["commandCount"] != 0:
        raise ValueError("r18 health reports a command-capable or nonempty session")
    if not isinstance(heartbeat.get("bootId"), str) or not ID.fullmatch(heartbeat["bootId"]):
        raise ValueError("Invalid Gateway heartbeat boot ID")
    health_request = Store.request_id("health", f"{heartbeat['bootId']}:{heartbeat['observedAt']}")
    if health["rn"] != content_name(health_request):
        raise ValueError("Invalid r18 heartbeat resource name")
    request = verify_observation_resource({**observation, "cseResource": native}, R18_DEVICE, observation_pin)
    return observation, request, health_request


async def read_observation_candidate(cse, *, usb, firmware, observation_pin, health_pin, started_at, require_rssi=False):
    resources = []
    for role in ("observation", "health"):
        status, rsc, body = await cse("GET", f"{PATHS[role]}/la")
        if (status, rsc) == (404, 4004):
            return None
        if (status, rsc) != (200, 2000):
            raise RuntimeError(f"Scoped r18 {role} lookup failed")
        resources.append(body["m2m:cin"])
    captured_at = utc_now()
    bound = bound_observation(*resources, usb=usb, firmware=firmware, observation_pin=observation_pin,
                              health_pin=health_pin, started_at=started_at, captured_at=captured_at)
    if bound is None or (require_rssi and bound[0]["rssi"] is None):
        return None
    return {"startedAt": iso_time(started_at), "capturedAt": iso_time(captured_at),
            "firmwareRevision": firmware, "usbLogSha256": usb["logSha256"],
            "observationContainerRi": observation_pin, "healthContainerRi": health_pin,
            "native": resources[0], "health": resources[1]}


async def capture_observation(cse, *, usb, firmware, observation_pin, health_pin, seconds, require_rssi=False):
    started_at = utc_now()
    async with asyncio.timeout(seconds):
        while True:
            candidate = await read_observation_candidate(cse, usb=usb, firmware=firmware, observation_pin=observation_pin,
                                                         health_pin=health_pin, started_at=started_at, require_rssi=require_rssi)
            if candidate is not None:
                return candidate
            await asyncio.sleep(0.5)


def inspect_location_response(response, observation, event, *, web=False):
    path = "/api/portal/locations" if web else "/v1/portal/locations"
    if response.get("path") != path or type(response.get("status")) is not int:
        raise ValueError("Location response does not identify the expected route")
    status = response["status"]
    if status in (401, 403):
        return {"status": "access-denied", "httpStatus": status}
    if status != 200:
        return {"status": "http-error", "httpStatus": status}
    if event is None:
        return {"status": "central-acceptance-unconfirmed"}
    if "observationId" in response and response["observationId"] != event["observationId"]:
        return {"status": "observation-missing"}
    if observation["rssi"] is None:
        return {"status": "observation-has-no-rssi"}

    body = response["body"]
    captured = parse_time(response["capturedAt"])
    expires = parse_time(body["readExpiresAt"])
    if captured >= expires:
        return {"status": "expired-at-capture"}
    if expires > captured + timedelta(seconds=10):
        raise ValueError("Location response has an invalid read expiry")
    if captured + timedelta(seconds=2) < parse_time(event["timestamp"]):
        return {"status": "captured-before-central-acceptance"}
    if web:
        if body.get("mode") != "live" or body.get("source") != "portal-api":
            return {"status": "source-unconfirmed"}
        rows = [device["ble"] for device in body["devices"]
                if device["deviceId"] == observation["deviceId"] and isinstance(device.get("ble"), dict)]
    else:
        if observation["deviceId"] not in body["deviceIds"]:
            return {"status": "device-outside-response-scope"}
        rows = [row for row in body["observations"] if row["deviceId"] == observation["deviceId"]]
    if type(event.get("simulation")) is not bool:
        raise ValueError("Central acceptance is missing its simulation marker")
    matches = [row for row in rows if row.get("gatewayId") == observation["gatewayId"]
               and row.get("observedAt") == observation["observedAt"] and type(row.get("rssiDbm")) is int
               and row["rssiDbm"] == observation["rssi"] and row.get("simulation") is event["simulation"]]
    if len(matches) > 1:
        raise ValueError("Location response contains the same BLE projection more than once")
    return {"status": "matched" if matches else "observation-missing", "capturedAt": response["capturedAt"],
            "simulation": event["simulation"]}


def bind_bringup_report(path, firmware_image, usb, observation):
    raw = path.read_bytes()
    capture = json.loads(raw)
    expected = {"version": 1, "mode": "bringup", "hardware": "r18-pcb", "status": "RECORDED",
                "gatewayId": GATEWAY, "deviceId": R18_DEVICE, "boardRevision": R18_BOARD,
                "firmwareRevision": observation["firmwareRevision"], "gattProfile": "core-v1"}
    if canonical({key: capture.get(key) for key in expected}) != canonical(expected):
        raise ValueError("First bring-up report differs from the scoped device, firmware or session profile")
    bringup = capture["bringup"]
    recorded_boot = bringup["usbBoot"]
    if (recorded_boot.get("sameBoot") is not True or recorded_boot.get("pinsSafe") is not True
            or recorded_boot.get("logSha256") != usb["logSha256"]
            or recorded_boot.get("appSha256") != usb.get("appSha256")):
        raise ValueError("First bring-up report does not match the scoped USB boot")
    image = read_firmware_image(firmware_image, usb)
    if canonical(recorded_boot.get("firmwareImage")) != canonical(image):
        raise ValueError("First bring-up report does not match the firmware image file")

    sessions = [session for session in capture["sessions"] if session["notificationCount"] > 0]
    selected = [session for session in sessions if session["session"] == bringup["session"]]
    if len(selected) != 1 or selected[0].get("commandReady") is not False:
        raise ValueError("First bring-up report lacks the selected observation-only BLE session")
    sequences = [session.get("lastSequence") for session in sessions]
    if any(type(sequence) is not int or not 0 <= sequence < observation["sequence"] for sequence in sequences):
        raise ValueError("Scoped observation does not follow the first bring-up BLE observations")
    return {"reportSha256": hashlib.sha256(raw).hexdigest(), "appSha256": usb["appSha256"],
            "firmwareImage": image, "lastBleSequence": max(sequences)}


def bind_native_confirmation(path, rqi, observation, gateway_boot):
    expected_rqi = rqi.encode("ascii")
    expected_digest = payload_hash(observation).encode("ascii")
    expected_boot = gateway_boot.encode("ascii")
    log_hash = hashlib.sha256()
    outcomes = set()
    with path.open("rb") as stream:
        for line in stream:
            log_hash.update(line)
            match = NATIVE_CONFIRMATION_LINE.search(line.rstrip(b"\r\n"))
            if match is None or match[1] != expected_rqi:
                continue
            if match[2] != expected_digest or (match[3], match[4]) == (b"https-readback", b"true"):
                raise ValueError("Pi native confirmation conflicts with the scoped observation")
            if match[5] is not None and match[5] != expected_boot:
                raise ValueError("Pi native confirmation belongs to another Gateway boot")
            outcomes.add((match[3], match[4], match[5]))
    if len(outcomes) != 1:
        raise ValueError("Pi log must contain one unambiguous native confirmation for the scoped observation")
    route, created, logged_boot = outcomes.pop()
    evidence = {"requestId": rqi, "route": route.decode("ascii"), "created": created == b"true",
                "logSha256": log_hash.hexdigest()}
    if logged_boot is not None:
        evidence["gatewayBootMatched"] = True
    return evidence


def compare_observation(capture, usb, database, team_state, hasher, *, portal_response=None, web_response=None,
                        bringup_report=None, firmware_image=None, pi_log=None):
    if (bringup_report is None) != (firmware_image is None):
        raise ValueError("First bring-up report and firmware image must be supplied together")
    if capture["usbLogSha256"] != usb["logSha256"]:
        raise ValueError("USB log differs from the observation capture")
    bound = bound_observation(capture["native"], capture["health"], usb=usb, firmware=capture["firmwareRevision"],
                              observation_pin=capture["observationContainerRi"], health_pin=capture["healthContainerRi"],
                              started_at=parse_time(capture["startedAt"]), captured_at=parse_time(capture["capturedAt"]))
    if bound is None:
        raise ValueError("CSE observation and health differ from the captured USB boot")
    observation, native_request, health_request = bound
    bringup_evidence = (bind_bringup_report(bringup_report, firmware_image, usb, observation)
                        if bringup_report is not None else None)
    observation_id = central_observation_id(observation)
    expected = {"gatewayId": GATEWAY, "originator": "Sscoped-r18-gateway-b", "cseId": "Mobius4",
                "cseDeploymentId": CSE_DEPLOYMENT, "pcApiDeploymentId": "scoped-command-api-r18",
                "observationContainer": PATHS["observation"], "observationContainerRi": capture["observationContainerRi"],
                "healthContainer": PATHS["health"]}
    central_request = Store.request_id("central-telemetry", observation_id)
    with closing(readonly(database)) as db:
        db.execute("BEGIN")
        identity = metadata(db)
        if identity is None or any(identity["binding"].get(key) != value for key, value in expected.items()):
            raise ValueError("Pi database does not belong to the scoped observation route")
        health_pin = identity["binding"].get("healthContainerRi")
        if health_pin is not None and health_pin != capture["healthContainerRi"]:
            raise ValueError("CSE health container differs from the Pi database binding")
        head = db.execute("SELECT boot_id,sequence FROM observations WHERE device_id=?", (R18_DEVICE,)).fetchone()
        if (head is None or head["boot_id"] != observation["bootId"]
                or head["sequence"] < observation["sequence"] or db.execute("SELECT 1 FROM commands LIMIT 1").fetchone()):
            raise ValueError("Pi observation watermark or command journal differs from the bring-up capture")
        pending = {}
        for request, route, payload in (
                (native_request, PATHS["observation"], observation),
                (central_request, "@central/telemetry", observation),
                (health_request, PATHS["health"], capture["health"]["con"])):
            row = db.execute("SELECT container,payload FROM outbox WHERE rqi=?", (request,)).fetchone()
            if row is not None and (row["container"] != route or row["payload"] != canonical(payload)):
                raise ValueError(f"Pending Pi payload for {route} differs from the CSE record")
            pending[request] = row is not None
    digest = hasher(observation)
    event = inspect_integration_observation(dict(observation, payloadHash=digest), team_state, allow_pending=True)
    simulation = event.get("simulation") if event is not None else None
    report = {"deviceId": R18_DEVICE, "firmwareRevision": observation["firmwareRevision"],
              "usbLogSha256": usb["logSha256"], "firmwareSequence": observation["sequence"],
              "observationId": observation_id, "payloadHash": digest,
              "piWatermarkSequence": head["sequence"], "commandReady": False,
              "nativeResourceId": capture["native"]["ri"], "healthResourceId": capture["health"]["ri"],
              "nativePendingOnPi": pending[native_request], "centralPendingOnPi": pending[central_request],
              "healthPendingOnPi": pending[health_request], "healthContainerVerified": True if health_pin is not None else None,
              "centralTelemetryAccepted": event is not None,
              "physicalRelayEvidenceMatched": health_pin is not None and simulation is False,
              "centralEvent": None if event is None else {
                  **{key: event[key] for key in TELEMETRY_EVENT_FIELDS}, "simulation": simulation}}
    if portal_response is not None:
        report["portalLocationResponse"] = inspect_location_response(portal_response, observation, event)
    if web_response is not None:
        report["webLocationResponse"] = inspect_location_response(web_response, observation, event, web=True)
    if bringup_evidence is not None:
        report["firstBringupEvidence"] = bringup_evidence
    if pi_log is not None:
        if pending[native_request]:
            raise ValueError("Pi snapshot still has the scoped native observation pending")
        report["nativeDelivery"] = bind_native_confirmation(pi_log, native_request, observation,
                                                             capture["health"]["con"]["bootId"])
    return report


def comparison_passed(report, *, require_physical):
    return (report["centralTelemetryAccepted"]
            and (not require_physical or report["physicalRelayEvidenceMatched"])
            and all(report[key]["status"] == "matched"
                    for key in ("portalLocationResponse", "webLocationResponse") if key in report))


def compare_transport_transition(mqtt_capture, fallback_capture, usb, database, team_state, hasher, *, pi_log,
                                 bringup_report=None, firmware_image=None, portal_response=None, web_response=None):
    if pi_log is None:
        raise ValueError("Transport transition comparison requires the Pi Gateway log")
    binding = ("teamRevision", "firmwareRevision", "usbLogSha256", "observationContainerRi", "healthContainerRi")
    if (any(mqtt_capture.get(key) != fallback_capture.get(key) for key in binding)
            or mqtt_capture["health"]["con"]["bootId"] != fallback_capture["health"]["con"]["bootId"]):
        raise ValueError("Transport captures do not share the scoped device and Gateway boot")
    if parse_time(fallback_capture["startedAt"]) < parse_time(mqtt_capture["capturedAt"]):
        raise ValueError("Fallback capture must start after the MQTT capture")
    before = compare_observation(mqtt_capture, usb, database, team_state, hasher, pi_log=pi_log,
                                 bringup_report=bringup_report, firmware_image=firmware_image,
                                 portal_response=portal_response, web_response=web_response)
    after = compare_observation(fallback_capture, usb, database, team_state, hasher, pi_log=pi_log)
    first, second = before["nativeDelivery"], after["nativeDelivery"]
    if first["logSha256"] != second["logSha256"]:
        raise ValueError("Pi Gateway log changed during the comparison")
    matched = (comparison_passed(before, require_physical=True) and comparison_passed(after, require_physical=True)
               and first.get("gatewayBootMatched") is True and second.get("gatewayBootMatched") is True
               and first["route"] == "mqtt" and second["route"] == "https-fallback"
               and first["created"] and second["created"] and before["nativeResourceId"] != after["nativeResourceId"]
               and before["firmwareSequence"] < after["firmwareSequence"]
               and before["centralEvent"]["sequence"] < after["centralEvent"]["sequence"])
    return {"mqtt": before, "httpsFallback": after, "transportTransitionMatched": matched}


async def capture_live(args, api, operator_dir, usb):
    async with scoped_clients(api, operator_dir) as (cse, _):
        return await capture_observation(cse, usb=usb, firmware=args.firmware_revision,
                                         observation_pin=args.observation_container_ri, health_pin=args.health_container_ri,
                                         seconds=args.seconds, require_rssi=args.require_rssi)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    capture = modes.add_parser("capture")
    compare = modes.add_parser("compare")
    for mode in (capture, compare):
        mode.add_argument("--usb-boot-log", required=True, type=Path)
        mode.add_argument("--firmware-revision", required=True, choices=R18_BRINGUP_FIRMWARES)
    capture.add_argument("--observation-container-ri", required=True)
    capture.add_argument("--health-container-ri", required=True)
    capture.add_argument("--seconds", type=int, default=60, choices=range(10, 301), metavar="10..300")
    capture.add_argument("--output", required=True, type=Path)
    capture.add_argument("--require-rssi", action="store_true", help="wait for an observation with a valid RSSI for location evidence")
    compare.add_argument("--capture", required=True, type=Path)
    compare.add_argument("--database", required=True, type=Path)
    compare.add_argument("--team-state", required=True, type=Path)
    compare.add_argument("--require-physical", action="store_true",
                         help="require the pinned Pi health container and a non-simulated central event")
    compare.add_argument("--bringup-report", type=Path, help="first bring-up BLE report from the same USB boot")
    compare.add_argument("--firmware-image", type=Path, help="firmware.bin used for the first bring-up report")
    compare.add_argument("--assembly-record", type=Path, help="r18 intake record for the board under test")
    compare.add_argument("--assembly-board-tag", help="board tag observed again at bring-up")
    compare.add_argument("--pi-log", type=Path, help="Pi Gateway log containing the scoped native confirmation")
    compare.add_argument("--fallback-capture", type=Path, help="later scoped capture to compare with the MQTT baseline")
    compare.add_argument("--portal-response", type=Path, help="saved central portal location response")
    compare.add_argument("--web-response", type=Path, help="saved live dashboard location response")
    args = parser.parse_args()
    if args.mode == "compare" and (args.assembly_record is not None or args.assembly_board_tag is not None):
        if not (args.assembly_record and args.assembly_board_tag and args.bringup_report and args.firmware_image):
            parser.error("assembly evidence requires both assembly options and the first bring-up report and image")
    api, operator_dir = scoped_api("r18")
    usb = read_usb_boot(args.usb_boot_log, R18_BOARD, args.firmware_revision)
    if any(usb[key] for key in ("motorActive", "auxEnabled", "mainFault")):
        parser.error("USB boot did not capture safe output and fault pins")
    if args.mode == "capture":
        pins = (args.observation_container_ri, args.health_container_ri)
        if pins[0] == pins[1] or any(not ID.fullmatch(pin) for pin in pins):
            parser.error("expected distinct scoped r18 observation and health IDs")
        artifact = asyncio.run(capture_live(args, api, operator_dir, usb))
        os.umask(0o077)
        write_new_json(args.output, dict(artifact, teamRevision=api["revision"]))
        if args.require_rssi:
            print(f"R18_LOCATION_SAMPLE {artifact['native']['con']['observedAt']}", flush=True)
    else:
        artifact = read_json(args.capture)
        if artifact["teamRevision"] != api["revision"] or artifact["firmwareRevision"] != args.firmware_revision:
            parser.error("capture belongs to a different team or device firmware revision")
        team_utils = operator_dir / "team-source/pc-mobius/integration/src/integration-utils.mjs"
        portal_response = read_json(args.portal_response) if args.portal_response is not None else None
        web_response = read_json(args.web_response) if args.web_response is not None else None
        team_state = read_json(args.team_state)

        def hasher(observation):
            return hash_observation(team_utils, observation)

        options = dict(portal_response=portal_response, web_response=web_response, bringup_report=args.bringup_report,
                       firmware_image=args.firmware_image, pi_log=args.pi_log)
        if args.fallback_capture is not None:
            report = compare_transport_transition(artifact, read_json(args.fallback_capture), usb, args.database,
                                                  team_state, hasher, **options)
            passed = report["transportTransitionMatched"]
        else:
            report = compare_observation(artifact, usb, args.database, team_state, hasher, **options)
            passed = comparison_passed(report, require_physical=args.require_physical)
        if args.assembly_record is not None:
            report["assemblyEvidence"] = assembly_reference(args.assembly_record, args.assembly_board_tag,
                                                            R18_BOARD, usb.get("displayProfile"))
        print(json.dumps(report, indent=2))
        raise SystemExit(0 if passed else 1)


if __name__ == "__main__":
    main()
