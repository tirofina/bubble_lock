"""Issue and verify one explicitly triggered Feather LED cycle on a disposable bench."""
import argparse
import asyncio
from contextlib import closing
from datetime import timedelta
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import uuid

from bubble_gateway.config import ID
from bubble_gateway.model import canonical, iso_time, parse_time, payload_hash, utc_now, validate_command
from bubble_gateway.state_identity import metadata
from bubble_gateway.store import Store
from scoped_feather_pi import COMMAND_FIRMWARES

GATEWAY = "gw-feather-bench"
DEVICE = "keyring-feather-lab"
FIRMWARE = COMMAND_FIRMWARES[0]
SUBJECT = "keyring-test-household"
GUARDIAN = "guardian-feather-bench"
STEPS = (("ON", True), ("OFF", False))


def content_name(rqi):
    return "gw-" + hashlib.sha256(rqi.encode()).hexdigest()


def receipt_name(command_id):
    return content_name(Store.request_id("receipt", command_id))


def verify_observation_resource(snapshot, device_id, pin=None):
    resource = snapshot.get("cseResource")
    boot, sequence = snapshot["bootId"], snapshot["sequence"]
    if (not isinstance(boot, str) or ID.fullmatch(boot) is None
            or type(sequence) is not int or not 0 <= sequence <= 4294967295):
        raise RuntimeError("Invalid native observation boot or sequence")
    rqi = Store.request_id("observation", f"{device_id}:{boot}:{sequence}")
    if (not isinstance(resource, dict) or type(resource.get("ty")) is not int or resource["ty"] != 4
            or resource.get("rn") != content_name(rqi)
            or any(not isinstance(resource.get(key), str) or ID.fullmatch(resource[key]) is None for key in ("ri", "pi"))):
        raise RuntimeError("Invalid native observation resource identity")
    if pin is not None and resource["pi"] != pin:
        raise RuntimeError("Native observation parent differs from the Pi container binding")
    return rqi


def write_new_json(path, data):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def verify_receipt(command, receipt, boot_id, state, *, firmware=FIRMWARE):
    expected = {key: command[key] for key in ("gatewayId", "deviceId", "commandId", "grantRevision", "ownershipEpoch")}
    expected.update(payloadHash=payload_hash(command), status="APPLIED", ackCode="APPLIED",
                    firmwareRevision=firmware, bootId=boot_id)
    if (canonical({key: receipt.get(key) for key in expected}) != canonical(expected)
            or canonical(receipt.get("readback")) != canonical({"state": state})):
        raise RuntimeError("CSE receipt does not match the applied bench command")
    parse_time(receipt["receivedAt"])


def ready_heartbeat(health, gateway_id, device_boot, not_before, *, firmware=FIRMWARE):
    gateway_boot = health.get("bootId")
    if ("credentialTransition" in health or health.get("gatewayId") != gateway_id or health.get("credentialStatus") != "ACTIVE"
            or not isinstance(gateway_boot, str) or ID.fullmatch(gateway_boot) is None):
        return None
    observed = parse_time(health["observedAt"])
    if observed < not_before or not -2 <= (utc_now() - observed).total_seconds() <= 15:
        return None
    devices = [device for device in health["devices"] if device.get("deviceId") == DEVICE]
    if len(devices) != 1:
        return None
    device = devices[0]
    if (device.get("connected") is not True or device.get("commandReady") is not True
            or device.get("bootId") != device_boot or device.get("firmwareRevision") != firmware):
        return None
    return {"gatewayBootId": gateway_boot, "observedAt": health["observedAt"]}


async def run_led_cycle(operator_post, cse, paths, output, *, gateway_id=GATEWAY, subject_id=SUBJECT,
                        central_settlement=None, observation_hasher=None, firmware=FIRMWARE):
    async def wait_for(check):
        while not (output / "STOP").exists():
            result = await check()
            if result is not None:
                return result
            await asyncio.sleep(0.25)
        raise RuntimeError("Stopped before the LED cycle completed")

    async def read_cin(role, name):
        status, rsc, body = await cse("GET", paths[role] + "/" + name)
        if (status, rsc) == (404, 4004):
            return None
        if (status, rsc) != (200, 2000):
            raise RuntimeError("Bench CSE readback failed")
        return body["m2m:cin"]

    async def observation(state, *, boot_id=None, after=None):
        native = await read_cin("observation", "la")
        if native is None:
            return None
        current = native["con"]
        observed = parse_time(current["receivedAt"])
        if (current["gatewayId"] == gateway_id and current["deviceId"] == DEVICE
                and current["firmwareRevision"] == firmware and current["state"] is state
                and abs((utc_now() - observed).total_seconds()) <= 15
                and (boot_id is None or current["bootId"] == boot_id)
                and (after is None or observed >= after)):
            snapshot = {key: current[key] for key in ("bootId", "sequence", "receivedAt", "state")}
            snapshot["cseResource"] = {key: native.get(key) for key in ("ty", "rn", "ri", "pi")}
            verify_observation_resource(snapshot, current["deviceId"])
            if central_settlement is not None:
                snapshot["observedAt"] = current["observedAt"]
            if observation_hasher is not None and after is not None:
                snapshot["payloadHash"] = await asyncio.to_thread(observation_hasher, current)
            return snapshot
        return None

    async def ready_baseline(state, boot_id, not_before):
        baseline = await observation(state, boot_id=boot_id)
        if baseline is None:
            return None
        health = await read_cin("health", "la")
        if health is not None:
            readiness = ready_heartbeat(health["con"], gateway_id, baseline["bootId"], not_before, firmware=firmware)
            if readiness is not None:
                return baseline, readiness
        return None

    async def post(path, body, expected_status=201):
        status, result = await operator_post(path, body)
        if status != expected_status:
            raise RuntimeError(f"Bench Guardian request failed with HTTP {status} at {path}")
        return result

    scope = ["bubble:command"]
    consent = None
    results = []
    boot_id = None
    print("Waiting for fresh Pi command readiness and matching Feather observations.", flush=True)
    for label, state in STEPS:
        prior_state = not state
        waiting_since = utc_now()
        baseline, _ = await wait_for(lambda: ready_baseline(prior_state, boot_id, waiting_since))
        boot_id = baseline["bootId"]
        trigger = output / f"LED_{label}"
        if trigger.exists():
            raise RuntimeError(f"Create {trigger.name} only after its readiness message")
        print(f"LED_{label}_READY", flush=True)

        async def current_trigger():
            return utc_now() if trigger.is_file() else None

        triggered_at = await wait_for(current_trigger)
        _, readiness = await wait_for(lambda: ready_baseline(prior_state, boot_id, triggered_at))
        if (output / "STOP").exists():
            raise RuntimeError("Stopped before issuing the next LED command")
        if consent is None:
            consent = await post("/v1/consents", {"subjectId": subject_id, "purpose": "keyring-led-bench",
                                                  "scopes": scope, "ttlSec": 1830})
        grant = await post("/v1/grants", {"consentId": consent["consentId"], "scopes": scope, "ttlSec": 60})
        grant_id = grant["grantId"]
        try:
            checked = await ready_baseline(prior_state, boot_id, triggered_at)
            if checked is None or checked[1]["gatewayBootId"] != readiness["gatewayBootId"]:
                raise RuntimeError("Pi command readiness or Feather baseline changed before the LED command")
            baseline, readiness = checked
            if (output / "STOP").exists():
                raise RuntimeError("Stopped before issuing the next LED command")
            command_id = f"feather-led-{label.lower()}-{uuid.uuid4().hex}"
            intent = {"deviceId": DEVICE, "commandId": command_id, "grantId": grant_id,
                      "desiredState": {"state": state}, "deadline": iso_time(utc_now() + timedelta(seconds=25))}
            rn = receipt_name(command_id)
            write_new_json(output / f"led-{label.lower()}-intent.json",
                           {"gatewayId": gateway_id, "request": intent, "cseReceiptName": rn})
            issued = await post(f"/api/v1/gateways/{gateway_id}/commands", intent)
            command = validate_command(issued, gateway_id, {DEVICE: ""})
            if command["commandId"] != command_id or command["desiredState"]["state"] is not state:
                raise RuntimeError("Bench central issued a different command")
            write_new_json(output / f"led-{label.lower()}-issued.json", {"command": command, "cseReceiptName": rn})
            async with asyncio.timeout(35):
                native_receipt = await wait_for(lambda: read_cin("receipt", rn))
                receipt = native_receipt["con"]
                verify_receipt(command, receipt, boot_id, state, firmware=firmware)
                observed = await wait_for(lambda: observation(state, boot_id=boot_id,
                                                               after=parse_time(receipt["receivedAt"])))
            if observed["sequence"] == baseline["sequence"]:
                raise RuntimeError("Post-command observation must use a new device sequence")
            step = {"command": command, "cseReceiptName": rn, "cseReceipt": receipt, "firmwareRevision": firmware,
                    "cseResource": {key: native_receipt[key] for key in ("ri", "ct")},
                    "baseline": baseline, "commandReadiness": readiness, "observation": observed}
            if central_settlement is not None:
                step["cseResource"]["pi"] = native_receipt["pi"]
            write_new_json(output / f"led-{label.lower()}-readback.json", step)
            if central_settlement is not None:
                async with asyncio.timeout(35):
                    await wait_for(lambda: central_settlement(command, receipt))
        finally:
            revoked = await post("/v1/grants/revoke", {"grantId": grant_id, "reason": "keyring-led-bench-step-ended"}, 200)
            if revoked.get("grantId") != grant_id or revoked.get("status") != "REVOKED":
                raise RuntimeError("Bench API did not confirm revocation of the step grant")
            write_new_json(output / f"led-{label.lower()}-grant-revoked.json", revoked)
        results.append(step)
        print(f"LED_{label}_RECORDED", flush=True)
    write_new_json(output / "led-cycle.json", {"steps": results, "firmwareRevision": firmware, "physicalLedObserved": None})


def verify_step(step, state, boot_id, *, gateway_id=GATEWAY, firmware=FIRMWARE):
    command = validate_command(step["command"], gateway_id, {DEVICE: ""})
    baseline, observation = step["baseline"], step["observation"]
    if (firmware not in COMMAND_FIRMWARES or step.get("firmwareRevision", FIRMWARE) != firmware
            or command["desiredState"]["state"] is not state or observation["state"] is not state
            or baseline["state"] is not (not state)
            or baseline["bootId"] != boot_id or observation["bootId"] != boot_id
            or baseline["sequence"] == observation["sequence"]
            or step["cseReceiptName"] != receipt_name(command["commandId"])
            or parse_time(observation["receivedAt"]) < parse_time(baseline["receivedAt"])
            or parse_time(observation["receivedAt"]) < parse_time(step["cseReceipt"]["receivedAt"])):
        raise RuntimeError("Bench command, observation, or CSE identity mismatch")
    verify_receipt(command, step["cseReceipt"], boot_id, state, firmware=firmware)
    return command


def verify_database(evidence, database, *, gateway_id=GATEWAY, prior_expired_commands=(), require_central_receipts=False):
    steps = evidence["steps"]
    firmware = evidence.get("firmwareRevision", FIRMWARE)
    if firmware not in COMMAND_FIRMWARES:
        raise RuntimeError("Unknown Feather command firmware in bench evidence")
    if len(steps) != len(STEPS):
        raise RuntimeError("LED evidence must contain one ON and one OFF command")
    boot_id = steps[0]["observation"]["bootId"]
    confirmed = []
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("BEGIN")
        db.row_factory = sqlite3.Row
        identity = metadata(db)
        db.row_factory = None
        binding = identity["binding"] if identity else {}
        observation_pin = binding.get("observationContainerRi")
        if observation_pin is not None and binding.get("gatewayId") != gateway_id:
            raise RuntimeError("Pi database observation binding belongs to a different Gateway")
        if require_central_receipts:
            pin = binding.get("receiptContainerRi")
            if (binding.get("gatewayId") != gateway_id or binding.get("cseDeploymentId") != "scoped-mobius4"
                    or not pin or any(step["cseResource"]["pi"] != pin for step in steps)):
                raise RuntimeError("Pi database and CSE receipt do not share the scoped container binding")
        if db.execute("SELECT COUNT(*) FROM commands").fetchone()[0] != len(STEPS) + len(prior_expired_commands):
            raise RuntimeError("Pi database has commands outside the declared bench evidence")
        first_issued_at = parse_time(steps[0]["command"]["issuedAt"])
        for command_id in prior_expired_commands:
            row = db.execute("SELECT payload_hash,payload,status,receipt,receipt_delivered FROM commands "
                             "WHERE command_id=?", (command_id,)).fetchone()
            if row is None or row[2] != "REJECTED" or row[4] != 1:
                raise RuntimeError("Declared prior attempt is not a delivered rejection")
            previous = validate_command(json.loads(row[1]), gateway_id, {DEVICE: ""})
            receipt = json.loads(row[3])
            expected = {key: previous[key] for key in ("commandId", "gatewayId", "deviceId", "grantRevision", "ownershipEpoch")}
            expected.update(payloadHash=payload_hash(previous), status="REJECTED", ackCode="EXPIRED",
                            firmwareRevision=None, bootId=None, readback=None, acceptedAt=None, appliedAt=None,
                            timestampSource="unavailable")
            if (previous["commandId"] != command_id or row[0] != expected["payloadHash"] or row[1] != canonical(previous)
                    or not isinstance(receipt, dict)
                    or canonical({key: receipt[key] for key in expected if key in receipt}) != canonical(expected)
                    or not parse_time(previous["deadline"]) <= parse_time(receipt["receivedAt"]) < first_issued_at
                    or db.execute("SELECT 1 FROM outbox WHERE rqi=?", (Store.request_id("receipt", command_id),)).fetchone()):
                raise RuntimeError("Declared prior attempt does not establish expiration before the LED cycle")
        for step, (_, state) in zip(steps, STEPS):
            command = verify_step(step, state, boot_id, gateway_id=gateway_id, firmware=firmware)
            receipt = step["cseReceipt"]
            command_id = command["commandId"]
            row = db.execute("SELECT payload_hash,payload,status,receipt,receipt_delivered FROM commands "
                             "WHERE command_id=?", (command_id,)).fetchone()
            expected = (payload_hash(command), canonical(command), "APPLIED", canonical(receipt), 1)
            if row != expected or db.execute("SELECT 1 FROM outbox WHERE rqi=?",
                                             (Store.request_id("receipt", command_id),)).fetchone():
                raise RuntimeError("Pi SQLite journal does not match the delivered CSE receipt")
            if observation_pin is not None:
                for snapshot in (step["baseline"], step["observation"]):
                    rqi = verify_observation_resource(snapshot, command["deviceId"], observation_pin)
                    if db.execute("SELECT 1 FROM outbox WHERE rqi=?", (rqi,)).fetchone():
                        raise RuntimeError("Native observation is still pending in the Pi outbox")
            if require_central_receipts:
                staged = db.execute("SELECT central_receipt_staged FROM commands WHERE command_id=?",
                                    (command_id,)).fetchone()
                pending = db.execute("SELECT 1 FROM outbox WHERE rqi=?",
                                     (Store.request_id("central-receipt", command_id),)).fetchone()
                if staged != (1,) or pending:
                    raise RuntimeError("Central receipt delivery is not complete in the Pi journal")
            confirmed.append({"commandId": command_id, "payloadHash": row[0], "receiptHash": payload_hash(receipt),
                              "state": state})
    return {"dataBindingsVerified": True, "observationContainerVerified": True if observation_pin is not None else None,
            "commands": confirmed, "physicalLedObserved": None}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compare a dedicated Pi SQLite snapshot to LED cycle evidence.")
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--gateway", choices=(GATEWAY, "gw-a"), default=GATEWAY)
    args = parser.parse_args()
    print(json.dumps(verify_database(json.loads(args.evidence.read_text(encoding="utf-8")), args.database,
                                    gateway_id=args.gateway), indent=2))
