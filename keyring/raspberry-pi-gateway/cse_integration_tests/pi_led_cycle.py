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

from bubble_gateway.model import canonical, iso_time, parse_time, payload_hash, utc_now, validate_command
from bubble_gateway.store import Store

GATEWAY = "gw-feather-bench"
DEVICE = "keyring-feather-lab"
FIRMWARE = "feather-probe-0.2.0"
SUBJECT = "keyring-test-household"
GUARDIAN = "guardian-feather-bench"
STEPS = (("ON", True), ("OFF", False))


def receipt_name(command_id):
    rqi = Store.request_id("receipt", command_id)
    return "gw-" + hashlib.sha256(rqi.encode()).hexdigest()


def write_new_json(path, data):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def verify_receipt(command, receipt, boot_id, state):
    expected = {key: command[key] for key in ("gatewayId", "deviceId", "commandId", "grantRevision", "ownershipEpoch")}
    expected.update(payloadHash=payload_hash(command), status="APPLIED", ackCode="APPLIED",
                    firmwareRevision=FIRMWARE, bootId=boot_id)
    if (canonical({key: receipt.get(key) for key in expected}) != canonical(expected)
            or canonical(receipt.get("readback")) != canonical({"state": state})):
        raise RuntimeError("CSE receipt does not match the applied bench command")
    parse_time(receipt["receivedAt"])


async def run_led_cycle(operator_post, cse, paths, output, *, gateway_id=GATEWAY, subject_id=SUBJECT):
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
                and current["firmwareRevision"] == FIRMWARE and current["state"] is state
                and abs((utc_now() - observed).total_seconds()) <= 15
                and (boot_id is None or current["bootId"] == boot_id)
                and (after is None or observed >= after)):
            return {key: current[key] for key in ("bootId", "sequence", "receivedAt", "state")}
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
    for label, state in STEPS:
        prior_state = not state
        baseline = await wait_for(lambda: observation(prior_state, boot_id=boot_id))
        boot_id = baseline["bootId"]
        trigger = output / f"LED_{label}"
        if trigger.exists():
            raise RuntimeError(f"Create {trigger.name} only after its readiness message")
        print(f"LED_{label}_READY", flush=True)

        async def current_trigger():
            if trigger.is_file():
                return await observation(prior_state, boot_id=boot_id)
            return None

        baseline = await wait_for(current_trigger)
        if (output / "STOP").exists():
            raise RuntimeError("Stopped before issuing the next LED command")
        if consent is None:
            consent = await post("/v1/consents", {"subjectId": subject_id, "purpose": "keyring-led-bench",
                                                  "scopes": scope, "ttlSec": 1830})
        grant = await post("/v1/grants", {"consentId": consent["consentId"], "scopes": scope, "ttlSec": 60})
        grant_id = grant["grantId"]
        try:
            baseline = await observation(prior_state, boot_id=boot_id)
            if baseline is None:
                raise RuntimeError("Feather baseline changed before the LED command")
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
                verify_receipt(command, receipt, boot_id, state)
                observed = await wait_for(lambda: observation(state, boot_id=boot_id,
                                                               after=parse_time(receipt["receivedAt"])))
            if observed["sequence"] == baseline["sequence"]:
                raise RuntimeError("Post-command observation must use a new device sequence")
            step = {"command": command, "cseReceiptName": rn, "cseReceipt": receipt,
                    "cseResource": {key: native_receipt[key] for key in ("ri", "ct")},
                    "baseline": baseline, "observation": observed}
            write_new_json(output / f"led-{label.lower()}-readback.json", step)
        finally:
            revoked = await post("/v1/grants/revoke", {"grantId": grant_id, "reason": "keyring-led-bench-step-ended"}, 200)
            if revoked.get("grantId") != grant_id or revoked.get("status") != "REVOKED":
                raise RuntimeError("Bench API did not confirm revocation of the step grant")
            write_new_json(output / f"led-{label.lower()}-grant-revoked.json", revoked)
        results.append(step)
        print(f"LED_{label}_RECORDED", flush=True)
    write_new_json(output / "led-cycle.json", {"steps": results, "physicalLedObserved": None})


def verify_database(evidence, database, *, gateway_id=GATEWAY):
    steps = evidence["steps"]
    if len(steps) != len(STEPS):
        raise RuntimeError("LED evidence must contain one ON and one OFF command")
    boot_id = steps[0]["observation"]["bootId"]
    confirmed = []
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("BEGIN")
        if db.execute("SELECT COUNT(*) FROM commands").fetchone()[0] != len(STEPS):
            raise RuntimeError("Expected a dedicated database with exactly two bench commands")
        for step, (_, state) in zip(steps, STEPS):
            command = validate_command(step["command"], gateway_id, {DEVICE: ""})
            receipt = step["cseReceipt"]
            command_id = command["commandId"]
            baseline = step["baseline"]
            observation = step["observation"]
            prior_state = not state
            if (command["desiredState"]["state"] is not state or observation["state"] is not state
                    or baseline["state"] is not prior_state
                    or baseline["bootId"] != boot_id or observation["bootId"] != boot_id
                    or baseline["sequence"] == observation["sequence"] or step["cseReceiptName"] != receipt_name(command_id)
                    or parse_time(observation["receivedAt"]) < parse_time(baseline["receivedAt"])
                    or parse_time(observation["receivedAt"]) < parse_time(receipt["receivedAt"])):
                raise RuntimeError("Bench command, observation, or CSE identity mismatch")
            verify_receipt(command, receipt, boot_id, state)
            row = db.execute("SELECT payload_hash,payload,status,receipt,receipt_delivered FROM commands "
                             "WHERE command_id=?", (command_id,)).fetchone()
            expected = (payload_hash(command), canonical(command), "APPLIED", canonical(receipt), 1)
            if row != expected or db.execute("SELECT 1 FROM outbox WHERE rqi=?",
                                             (Store.request_id("receipt", command_id),)).fetchone():
                raise RuntimeError("Pi SQLite journal does not match the delivered CSE receipt")
            confirmed.append({"commandId": command_id, "payloadHash": row[0], "receiptHash": payload_hash(receipt),
                              "state": state})
    return {"dataBindingsVerified": True, "commands": confirmed, "physicalLedObserved": None}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compare a dedicated Pi SQLite snapshot to LED cycle evidence.")
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--gateway", choices=(GATEWAY, "gw-a"), default=GATEWAY)
    args = parser.parse_args()
    print(json.dumps(verify_database(json.loads(args.evidence.read_text(encoding="utf-8")), args.database,
                                    gateway_id=args.gateway), indent=2))
