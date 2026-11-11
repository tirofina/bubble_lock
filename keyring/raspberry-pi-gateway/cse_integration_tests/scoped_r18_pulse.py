"""Issue one operator-triggered r18 pulse on the isolated loopback bench."""

import argparse
import asyncio
from datetime import timedelta
from functools import partial
import hashlib
import json
from pathlib import Path
import re
import uuid

from bubble_gateway.ble_characterize import WAKE_CASES, boot_id_sha256
from bubble_gateway.config import ID
from bubble_gateway.integration_evidence import inspect_integration_command, inspect_integration_observation
from bubble_gateway.model import iso_time, parse_time, utc_now, validate_command
from pi_led_cycle import ready_heartbeat, receipt_name, verify_observation_resource, verify_receipt, write_new_json
from scoped_command_io import PROFILE, hash_observation, scoped_api, scoped_clients, tls_context
from scoped_feather_evidence import read_json
from scoped_feather_pi import (PARENT, R18_BOARD, R18_COMMAND_FIRMWARE, R18_COMMAND_FIRMWARES, R18_DEVICE,
                               R18_SLEEP_COMMAND_FIRMWARE, verify_integration_api)

GATEWAY = "gw-b"
SUBJECT = "scoped-r18-bench"
PATHS = {"observation": f"{PARENT}/command-observations-b", "receipt": f"{PARENT}/command-receipts-b",
         "health": f"{PARENT}/command-health-b"}
TELEMETRY_EVENT_FIELDS = ("eventId", "observationId", "payloadHash", "sequence", "observedAt", "timestamp")


def validate_container_pins(pins):
    if (not isinstance(pins, dict) or pins.keys() != PATHS.keys()
            or any(not isinstance(value, str) or not ID.fullmatch(value) for value in pins.values())
            or len(set(pins.values())) != len(PATHS)):
        raise ValueError("Expected three distinct scoped r18 container IDs")
    return dict(pins)


def pulse_journal_readiness(values):
    status = values.get("journal")
    if status in ("error", "disabled"):
        raise ValueError("The r18 command journal is unavailable")
    fields = ("journalUsed", "journalPrepared", "journalCapacity")
    if values.get("detail") != "health" or status != "ready" or any(key not in values for key in fields):
        return None
    used, prepared, capacity = (values[key] for key in fields)
    if (any(type(count) is not int for count in (used, prepared, capacity))
            or not 0 <= prepared <= used <= capacity or capacity < 1):
        raise ValueError("Invalid r18 command journal counts")
    if used == capacity:
        raise ValueError("The r18 command journal is full")
    return {key: values[key] for key in ("detail", "journal", *fields)}


def read_pulse_wake_report(path, firmware):
    raw = path.read_bytes()
    capture = json.loads(raw)
    expected = {"mode": "wake", "hardware": "r18-pcb", "status": "RECORDED", "gatewayId": GATEWAY,
                "deviceId": R18_DEVICE, "boardRevision": R18_BOARD, "firmwareRevision": firmware, "gattProfile": "core-v1"}
    if (firmware != R18_SLEEP_COMMAND_FIRMWARE or not isinstance(capture, dict)
            or type(capture.get("version")) is not int or capture["version"] != 1
            or any(capture.get(key) != value for key, value in expected.items())):
        raise ValueError("Wake report does not match the scoped r18 sleep firmware and device")
    wake = capture.get("wake")
    if not isinstance(wake, dict):
        raise ValueError("Wake report lacks a matched cause, new boot hash or observation sequence")
    case, digest, sequence = wake.get("expected"), wake.get("bootIdSha256"), wake.get("sequence")
    if (wake.get("matched") is not True or wake.get("newBoot") is not True
            or not isinstance(case, str) or case not in WAKE_CASES or type(wake.get("pins")) is not int
            or (wake.get("cause"), wake["pins"]) != WAKE_CASES[case]
            or not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None
            or type(sequence) is not int or not 0 <= sequence <= 4294967295):
        raise ValueError("Wake report lacks a matched cause, new boot hash or observation sequence")
    return {"reportSha256": hashlib.sha256(raw).hexdigest(), "case": case, "bootIdSha256": digest,
            "sequence": sequence}


def check_pulse_wake_baseline(wake, baseline):
    if (boot_id_sha256(baseline["bootId"]) != wake["bootIdSha256"]
            or baseline["sequence"] <= wake["sequence"]):
        raise ValueError("Pulse baseline must be a later observation from the recorded wake boot")


async def run_pulse(operator_post, cse, central_proof, output, *, pins, observation_hasher, telemetry_proof,
                    firmware=R18_COMMAND_FIRMWARE, wake=None):
    pins = validate_container_pins(pins)
    if firmware not in R18_COMMAND_FIRMWARES:
        raise ValueError("Unknown r18 command firmware")
    if wake is not None and firmware != R18_SLEEP_COMMAND_FIRMWARE:
        raise ValueError("Wake evidence requires the r18 sleep firmware")
    scope_record = {"gatewayId": GATEWAY, "containerPins": pins, "firmwareRevision": firmware, "journalReadinessRequired": True}
    if wake is not None:
        scope_record["wakeReportSha256"] = wake["reportSha256"]
    write_new_json(output / "pulse-scope.json", scope_record)
    stop, trigger = output / "STOP", output / "PULSE"

    async def wait_for(check):
        while not stop.exists():
            result = await check()
            if result is not None:
                return result
            await asyncio.sleep(0.25)
        raise RuntimeError("Stopped during the r18 pulse bench")

    async def read_cin(role, name="la"):
        status, rsc, body = await cse("GET", f"{PATHS[role]}/{name}")
        if (status, rsc) == (404, 4004):
            return None
        if (status, rsc) != (200, 2000):
            raise RuntimeError("Scoped CSE readback failed")
        native = body["m2m:cin"]
        if native.get("pi") != pins[role]:
            raise RuntimeError(f"Scoped r18 {role} parent differs from the pinned container")
        if not isinstance(native.get("ri"), str) or not ID.fullmatch(native["ri"]):
            raise RuntimeError(f"Invalid scoped r18 {role} resource ID")
        return native

    async def verify_receipt_route():
        status, rsc, body = await cse("GET", PATHS["receipt"])
        if (status, rsc) != (200, 2000) or body["m2m:cnt"].get("ri") != pins["receipt"]:
            raise RuntimeError("Scoped r18 receipt route differs from the pinned container")

    async def off_observation(*, boot_id=None, after=None, after_sequence=None):
        native = await read_cin("observation")
        if native is None:
            return None
        current = native["con"]
        if (current.get("gatewayId") != GATEWAY or current.get("deviceId") != R18_DEVICE
                or current.get("firmwareRevision") != firmware or current.get("state") is not False
                or current.get("sensorValues", {}).get("fault") is not False
                or (boot_id is not None and current.get("bootId") != boot_id)):
            return None
        received_at = parse_time(current["receivedAt"])
        if not -2 <= (utc_now() - received_at).total_seconds() <= 15 or (after is not None and received_at < after):
            return None
        snapshot = {key: current[key] for key in ("bootId", "sequence", "observedAt", "receivedAt", "state")}
        snapshot["cseResource"] = {key: native.get(key) for key in ("ty", "rn", "ri", "pi")}
        verify_observation_resource(snapshot, R18_DEVICE)
        if after_sequence is not None and snapshot["sequence"] <= after_sequence:
            return None
        return snapshot, current

    async def ready(not_before, *, boot_id=None):
        candidate = await off_observation(boot_id=boot_id, after=not_before)
        if candidate is None:
            return None
        observation, current = candidate
        journal = pulse_journal_readiness(current.get("sensorValues", {}))
        if journal is None:
            return None
        observation["journal"] = journal
        native = await read_cin("health")
        if native is None:
            return None
        heartbeat = ready_heartbeat(native["con"], GATEWAY, observation["bootId"], not_before,
                                    firmware=firmware, device_id=R18_DEVICE, board_revision=R18_BOARD)
        if heartbeat is None:
            return None
        heartbeat["cseResource"] = {key: native[key] for key in ("ri", "pi")}
        return observation, heartbeat

    async def post(path, body, expected=201):
        status, result = await operator_post(path, body)
        if status != expected or not isinstance(result, dict):
            raise RuntimeError(f"Scoped r18 operator request failed with HTTP {status} at {path}")
        return result

    async def pulse_trigger():
        return utc_now() if trigger.is_file() else None

    waiting_since = utc_now()
    baseline, armed = await wait_for(lambda: ready(waiting_since))
    if wake is not None:
        check_pulse_wake_baseline(wake, baseline)
    boot_id = baseline["bootId"]
    await verify_receipt_route()
    if trigger.exists():
        raise RuntimeError("Create PULSE only after R18_PULSE_READY")
    print("R18_PULSE_READY", flush=True)
    triggered_at = await wait_for(pulse_trigger)
    _, fresh = await wait_for(lambda: ready(triggered_at, boot_id=boot_id))
    await verify_receipt_route()
    if fresh["gatewayBootId"] != armed["gatewayBootId"] or stop.exists():
        raise RuntimeError("The Pi session changed or stopped before r18 command issuance")

    scope = ["bubble:command"]
    consent = await post("/v1/consents", {"subjectId": SUBJECT, "purpose": "keyring-r18-pulse-bench",
                                         "scopes": scope, "ttlSec": 120})
    grant = await post("/v1/grants", {"consentId": consent["consentId"], "scopes": scope, "ttlSec": 60})
    grant_id = grant["grantId"]
    if not isinstance(grant_id, str) or ID.fullmatch(grant_id) is None:
        raise RuntimeError("Invalid scoped grant ID")
    try:
        write_new_json(output / "pulse-grant.json", grant)
        granted_at = utc_now()
        async with asyncio.timeout(15):
            checked = await wait_for(lambda: ready(granted_at, boot_id=boot_id))
        await verify_receipt_route()
        if (checked[1]["gatewayBootId"] != armed["gatewayBootId"]
                or checked[0]["cseResource"]["pi"] != baseline["cseResource"]["pi"] or stop.exists()):
            raise RuntimeError("The r18 or Pi session changed or stopped before command issuance")
        baseline, readiness = checked
        if wake is not None:
            check_pulse_wake_baseline(wake, baseline)
        command_id = f"r18-pulse-{uuid.uuid4().hex}"
        intent = {"deviceId": R18_DEVICE, "commandId": command_id, "grantId": grant_id,
                  "desiredState": {"state": True}, "deadline": iso_time(utc_now() + timedelta(seconds=25))}
        rn = receipt_name(command_id)
        write_new_json(output / "pulse-intent.json", {"gatewayId": GATEWAY, "request": intent, "cseReceiptName": rn,
                                                     "baseline": baseline, "commandReadiness": readiness})
        issued = await post(f"/api/v1/gateways/{GATEWAY}/commands", intent)
        command = validate_command(issued, GATEWAY, {R18_DEVICE: ""})
        if (command["commandId"] != command_id or command["desiredState"]["state"] is not True
                or parse_time(command["deadline"]) != parse_time(intent["deadline"])):
            raise RuntimeError("Scoped API returned a different r18 command")
        write_new_json(output / "pulse-issued.json", {"command": command, "cseReceiptName": rn})

        async with asyncio.timeout(35):
            native = await wait_for(lambda: read_cin("receipt", rn))
            receipt = native["con"]
            resource = {key: native.get(key) for key in ("ty", "rn", "ri", "pi", "ct")}
            if not isinstance(resource["ct"], str) or not re.fullmatch(r"[0-9]{8}T[0-9]{6}", resource["ct"]):
                raise RuntimeError("Invalid native r18 receipt identity")
            write_new_json(output / "pulse-receipt.json", {"cseReceipt": receipt, "cseResource": resource})
            verify_receipt(command, receipt, boot_id, True, firmware=firmware)
            settled = await wait_for(lambda: central_proof(command, receipt))
            final_off, native_observation = await wait_for(
                lambda: off_observation(boot_id=boot_id, after=parse_time(receipt["receivedAt"]),
                                        after_sequence=baseline["sequence"]))
            verify_observation_resource(final_off, R18_DEVICE, baseline["cseResource"]["pi"])
    finally:
        revoked = await post("/v1/grants/revoke", {"grantId": grant_id, "reason": "keyring-r18-pulse-bench-ended"}, 200)
        if revoked.get("grantId") != grant_id or revoked.get("status") != "REVOKED":
            raise RuntimeError("Scoped API did not confirm grant revocation")
        write_new_json(output / "pulse-grant-revoked.json", revoked)

    write_new_json(output / "pulse-result.json", {"commandId": command_id, **settled, "postPulseObservation": final_off,
                                                 "physicalPulseMeasured": None})
    print("R18_PULSE_RECORDED", flush=True)

    observation = dict(final_off, gatewayId=GATEWAY, deviceId=R18_DEVICE,
                       payloadHash=await asyncio.to_thread(observation_hasher, native_observation))
    write_new_json(output / "pulse-observation.json", {"commandId": command_id, "observation": observation})
    try:
        async with asyncio.timeout(35):
            event = await wait_for(lambda: telemetry_proof(observation))
    except TimeoutError:
        raise RuntimeError("Central OFF observation did not arrive; local pulse evidence was retained") from None
    write_new_json(output / "pulse-central-telemetry.json",
                   {"commandId": command_id, **{key: event[key] for key in TELEMETRY_EVENT_FIELDS}})
    print("R18_PULSE_CENTRAL_TELEMETRY_VERIFIED", flush=True)


async def run(output, seconds, pins, *, firmware_revision=None, wake_report=None):
    api, operator_dir = scoped_api("r18")
    firmware = api["firmwareRevision"] if firmware_revision is None else firmware_revision
    if ((api["gatewayId"], api["deviceId"], api["subjectId"], api["boardRevision"]) != (GATEWAY, R18_DEVICE, SUBJECT, R18_BOARD)
            or firmware not in R18_COMMAND_FIRMWARES
            or firmware not in (api["firmwareRevision"], *api.get("alternateFirmwareRevisions", ()))):
        raise RuntimeError("Configured scoped r18 profile differs from the pulse bench identity")
    wake = read_pulse_wake_report(wake_report, firmware) if wake_report is not None else None
    gateway_tls = tls_context(PROFILE / "tls/gateway-b.pem", PROFILE / "tls/gateway-b.key")
    await asyncio.to_thread(verify_integration_api, api["port"], api["revision"], gateway_tls, mode="r18", firmware=firmware)
    state_path = operator_dir / "runtime.json"
    team_utils = operator_dir / "team-source/pc-mobius/integration/src/integration-utils.mjs"
    observation_hasher = partial(hash_observation, team_utils)
    await asyncio.to_thread(observation_hasher, {})

    async def central_proof(command, receipt):
        state = await asyncio.to_thread(read_json, state_path)
        return inspect_integration_command(command, receipt, state)

    async def telemetry_proof(observation):
        state = await asyncio.to_thread(read_json, state_path)
        return inspect_integration_observation(observation, state, allow_pending=True)

    async with (scoped_clients(api, operator_dir, container_paths=(PATHS["receipt"],)) as (cse, operator_post),
                asyncio.timeout(seconds)):
        output.mkdir(mode=0o700)
        await run_pulse(operator_post, cse, central_proof, output, pins=pins,
                        observation_hasher=observation_hasher, telemetry_proof=telemetry_proof, firmware=firmware, wake=wake)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New private directory for the trigger and evidence")
    parser.add_argument("--seconds", type=int, default=600, choices=range(30, 1801), metavar="30..1800")
    parser.add_argument("--firmware-revision", choices=R18_COMMAND_FIRMWARES, help="Command firmware selected on the scoped API and Pi")
    parser.add_argument("--wake-report", type=Path, help="Require the command baseline to follow this Pi wake report")
    for role in PATHS:
        parser.add_argument(f"--{role}-container-ri", required=True, help=f"Provisioned gw-b {role} container ID")
    args = parser.parse_args()
    try:
        pins = validate_container_pins({role: getattr(args, f"{role}_container_ri") for role in PATHS})
    except ValueError as error:
        parser.error(str(error))
    asyncio.run(run(args.output.resolve(), args.seconds, pins, firmware_revision=args.firmware_revision, wake_report=args.wake_report))
