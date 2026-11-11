"""Capture and compare one observation from a scoped r18 bring-up session."""

import argparse
import asyncio
from contextlib import closing
from datetime import timedelta
import json
import os
from pathlib import Path

from bubble_gateway.ble_characterize import read_usb_boot
from bubble_gateway.config import ID
from bubble_gateway.integration_evidence import inspect_integration_observation
from bubble_gateway.model import canonical, central_observation_id, iso_time, parse_time, utc_now, validate_observation
from bubble_gateway.state_identity import metadata, readonly
from bubble_gateway.store import Store
from pi_led_cycle import content_name, verify_observation_resource, write_new_json
from scoped_command_io import hash_observation, scoped_api, scoped_clients
from scoped_feather_evidence import read_json
from scoped_feather_pi import CSE_DEPLOYMENT, R18_BOARD, R18_BRINGUP_FIRMWARES, R18_DEVICE
from scoped_r18_pulse import GATEWAY, PATHS, TELEMETRY_EVENT_FIELDS


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
    return observation, request


async def capture_observation(cse, *, usb, firmware, observation_pin, health_pin, seconds):
    started_at = utc_now()
    async with asyncio.timeout(seconds):
        while True:
            resources = []
            for role in ("observation", "health"):
                status, rsc, body = await cse("GET", f"{PATHS[role]}/la")
                if (status, rsc) == (404, 4004):
                    break
                if (status, rsc) != (200, 2000):
                    raise RuntimeError(f"Scoped r18 {role} lookup failed")
                resources.append(body["m2m:cin"])
            captured_at = utc_now()
            if len(resources) == 2 and bound_observation(*resources, usb=usb, firmware=firmware,
                                                        observation_pin=observation_pin, health_pin=health_pin,
                                                        started_at=started_at, captured_at=captured_at) is not None:
                return {"startedAt": iso_time(started_at), "capturedAt": iso_time(captured_at),
                        "firmwareRevision": firmware, "usbLogSha256": usb["logSha256"],
                        "observationContainerRi": observation_pin, "healthContainerRi": health_pin,
                        "native": resources[0], "health": resources[1]}
            await asyncio.sleep(0.5)


def compare_observation(capture, usb, database, team_state, hasher):
    if capture["usbLogSha256"] != usb["logSha256"]:
        raise ValueError("USB log differs from the observation capture")
    bound = bound_observation(capture["native"], capture["health"], usb=usb, firmware=capture["firmwareRevision"],
                              observation_pin=capture["observationContainerRi"], health_pin=capture["healthContainerRi"],
                              started_at=parse_time(capture["startedAt"]), captured_at=parse_time(capture["capturedAt"]))
    if bound is None:
        raise ValueError("CSE observation and health differ from the captured USB boot")
    observation, native_request = bound
    observation_id = central_observation_id(observation)
    expected = {"gatewayId": GATEWAY, "originator": "Sscoped-r18-gateway-b", "cseId": "Mobius4",
                "cseDeploymentId": CSE_DEPLOYMENT, "pcApiDeploymentId": "scoped-command-api-r18",
                "observationContainer": PATHS["observation"], "observationContainerRi": capture["observationContainerRi"]}
    central_request = Store.request_id("central-telemetry", observation_id)
    with closing(readonly(database)) as db:
        db.execute("BEGIN")
        identity = metadata(db)
        if identity is None or any(identity["binding"].get(key) != value for key, value in expected.items()):
            raise ValueError("Pi database does not belong to the scoped observation route")
        head = db.execute("SELECT boot_id,sequence FROM observations WHERE device_id=?", (R18_DEVICE,)).fetchone()
        if (head is None or head["boot_id"] != observation["bootId"]
                or head["sequence"] < observation["sequence"] or db.execute("SELECT 1 FROM commands LIMIT 1").fetchone()):
            raise ValueError("Pi observation watermark or command journal differs from the bring-up capture")
        pending = {}
        for request, route in ((native_request, PATHS["observation"]), (central_request, "@central/telemetry")):
            row = db.execute("SELECT container,payload FROM outbox WHERE rqi=?", (request,)).fetchone()
            if row is not None and (row["container"] != route or row["payload"] != canonical(observation)):
                raise ValueError("Pending Pi observation body differs from the CSE record")
            pending[request] = row is not None
    digest = hasher(observation)
    event = inspect_integration_observation(dict(observation, payloadHash=digest), team_state, allow_pending=True)
    return {"deviceId": R18_DEVICE, "firmwareRevision": observation["firmwareRevision"],
            "usbLogSha256": usb["logSha256"], "firmwareSequence": observation["sequence"],
            "observationId": observation_id, "payloadHash": digest,
            "piWatermarkSequence": head["sequence"], "commandReady": False,
            "nativeResourceId": capture["native"]["ri"], "healthResourceId": capture["health"]["ri"],
            "nativePendingOnPi": pending[native_request], "centralPendingOnPi": pending[central_request],
            "centralTelemetryAccepted": event is not None,
            "centralEvent": None if event is None else {key: event[key] for key in TELEMETRY_EVENT_FIELDS}}


async def capture_live(args, api, operator_dir, usb):
    async with scoped_clients(api, operator_dir) as (cse, _):
        return await capture_observation(cse, usb=usb, firmware=args.firmware_revision,
                                         observation_pin=args.observation_container_ri, health_pin=args.health_container_ri,
                                         seconds=args.seconds)


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
    compare.add_argument("--capture", required=True, type=Path)
    compare.add_argument("--database", required=True, type=Path)
    compare.add_argument("--team-state", required=True, type=Path)
    args = parser.parse_args()
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
    else:
        artifact = read_json(args.capture)
        if artifact["teamRevision"] != api["revision"] or artifact["firmwareRevision"] != args.firmware_revision:
            parser.error("capture belongs to a different team or device firmware revision")
        team_utils = operator_dir / "team-source/pc-mobius/integration/src/integration-utils.mjs"
        report = compare_observation(artifact, usb, args.database, read_json(args.team_state),
                                     lambda observation: hash_observation(team_utils, observation))
        print(json.dumps(report, indent=2))
        raise SystemExit(0 if report["centralTelemetryAccepted"] else 1)


if __name__ == "__main__":
    main()
