"""Bind the scoped Feather bench artifacts without changing any device or service state."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3

from bubble_gateway.config import ID
from bubble_gateway.model import canonical, iso_time, parse_time, payload_hash, validate_command
from bubble_gateway.state_identity import metadata, readonly
from pi_led_cycle import DEVICE, STEPS, receipt_name, verify_database, verify_step

GATEWAY = "gw-a"
ROUTE = "/Mobius/privacy-bubble-test-ae/command-receipts-a"
BINDING = ("gatewayId", "deviceId", "commandId", "claimId", "grantRevision", "ownershipEpoch")
SOURCES = {"CSE_CALLBACK", "RECOVERY_SWEEP"}


def read_json(path):
    with path.open(encoding="utf-8-sig") as stream:
        return json.load(stream)


def matches_approval(event, command, payload_hash, native_stored_at):
    expected = {key: command[key] for key in BINDING}
    expected.update(contractId="privacy-bubble.integration.v1", docRevision="2.0.0", owner="PC-MOBIUS-INTEGRATION",
                    type="GATEWAY_COMMAND_AUTHORIZED", allowed=True, payloadHash=payload_hash)
    actual = {key: event.get(key) for key in expected}
    if canonical(actual) != canonical(expected):
        return False
    issued, authorized, expiry = map(parse_time, (command["issuedAt"], event["timestamp"], event["expiresAt"]))
    return (issued <= authorized <= parse_time(native_stored_at)
            and authorized < expiry <= parse_time(command["deadline"]))


def inspect_command(step, pi_proof, inspection, team_state):
    command = step["command"]
    command_id = command["commandId"]
    issued = team_state["gatewayCommands"].get(command_id)
    if (not issued or canonical(issued["command"]) != canonical(command)
            or issued["payloadHash"] != pi_proof["payloadHash"]):
        raise ValueError("Central issuance does not match the Pi journal")
    if (inspection.get("gatewayId") != GATEWAY or inspection.get("commandId") != command_id
            or inspection.get("cseKey") != "scoped-mobius4"
            or inspection.get("nativeRef") != f"{ROUTE}/{step['cseReceiptName']}"):
        raise ValueError("PostgreSQL inspection does not match the command and CSE route")

    inbox, settlement = inspection["inbox"], inspection["settlement"]
    deliveries = inspection["deliveries"]
    sources = set()
    creators = []
    for delivery in deliveries:
        source = delivery["source"]
        if not inbox or source not in SOURCES or source in sources or type(delivery["queuedNew"]) is not bool:
            raise ValueError("Invalid receipt delivery evidence")
        sources.add(source)
        seen_at = parse_time(delivery["firstSeenAt"])
        if delivery["queuedNew"]:
            creators.append(seen_at)
    if len(creators) > 1:
        raise ValueError("More than one path claims the first inbox insertion")

    state = inbox["state"] if inbox else "MISSING"
    if state not in {"MISSING", "PENDING", "REVIEW", "SETTLED"} or (state == "SETTLED" and not settlement):
        raise ValueError("Inconsistent PostgreSQL inbox and settlement status")
    if settlement:
        expected = {key: command[key] for key in ("gatewayId", "deviceId", "commandId")}
        expected.update(version=1, payloadHash=pi_proof["payloadHash"], receiptSha256=pi_proof["receiptHash"],
                        readbackState=pi_proof["state"])
        if canonical({key: settlement.get(key) for key in expected}) != canonical(expected):
            raise ValueError("Settlement does not match the Pi and native receipt hashes or readback")
        if (settlement.get("nativeCseKey") != inspection["cseKey"]
                or settlement.get("nativeRef") != inspection["nativeRef"]):
            raise ValueError("Settlement does not bind the inspected CSE route")
        stored = parse_time(settlement["nativeStoredAt"])
        recorded = parse_time(settlement["recordedAt"])
        resource = step["cseResource"]
        cse_time = datetime.strptime(resource["ct"], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
        if (cse_time.strftime("%Y%m%dT%H%M%S") != resource["ct"] or stored != cse_time
                or not resource["ri"] or settlement["nativeResourceId"] != resource["ri"]
                or stored > recorded or any(creator > recorded for creator in creators)):
            raise ValueError("Settlement does not match native receipt identity and chronology")
        matches = [event for event in team_state["receipts"] if event.get("eventId") == settlement["authorizationEventId"]]
        if len(matches) != 1 or not matches_approval(matches[0], command, pi_proof["payloadHash"], settlement["nativeStoredAt"]):
            raise ValueError("Settlement authorization event does not match the command")

    return {**pi_proof, "inboxState": state, "inboxResult": inbox.get("lastResult") if inbox else None,
            "settlementVerified": state == "SETTLED" and bool(settlement), "deliverySources": sorted(sources)}


def physical_observations(steps, observations):
    if observations is None:
        return None
    if not isinstance(observations, list) or len(observations) != len(steps):
        raise ValueError("Record one operator observation for each LED command")
    report = []
    for index, (step, observation) in enumerate(zip(steps, observations)):
        command = step["command"]
        when = parse_time(observation["observedAt"])
        if (observation["commandId"] != command["commandId"] or type(observation["ledOn"]) is not bool
                or when < parse_time(command["issuedAt"])
                or (index + 1 < len(steps) and when >= parse_time(steps[index + 1]["command"]["issuedAt"]))):
            raise ValueError("Operator observation is not bound to the command interval")
        report.append({"commandId": command["commandId"], "ledOn": observation["ledOn"],
                       "observedAt": observation["observedAt"], "matched": observation["ledOn"] is command["desiredState"]["state"]})
    return report


def verify_scoped_evidence(cycle, database, inspections, team_state, observed_led=None):
    steps = cycle["steps"]
    proof = verify_database(cycle, database, gateway_id=GATEWAY)
    if len(inspections) != len(steps):
        raise ValueError("Provide one PostgreSQL inspection for each command")
    commands = [inspect_command(step, pi_proof, inspection, team_state)
                for step, pi_proof, inspection in zip(steps, proof["commands"], inspections)]
    observations = physical_observations(steps, observed_led)
    return {"piCseBindingVerified": True,
            "centralSettlementVerified": all(row["settlementVerified"] for row in commands),
            "cseCallbackRecorded": all("CSE_CALLBACK" in row["deliverySources"] for row in commands),
            "physicalLedObserved": observations,
            "physicalLedMatched": None if observations is None else all(row["matched"] for row in observations),
            "commands": commands}


def read_optional(path):
    try:
        value = read_json(path)
    except FileNotFoundError:
        return None
    if not isinstance(value, dict):
        raise ValueError("Bench artifact must contain a JSON object")
    return value


def read_pi_commands(database):
    with closing(readonly(database)) as db:
        db.execute("BEGIN")
        record = metadata(db)
        binding = record["binding"] if record else {}
        if (binding.get("gatewayId") != GATEWAY or binding.get("cseId") != "Mobius4"
                or binding.get("originator") != "Sscoped-feather-gateway-a" or binding.get("receiptContainer") != ROUTE
                or binding.get("cseDeploymentId") not in (None, "scoped-mobius4")):
            raise ValueError("Pi database does not belong to the scoped Feather session")
        rows = db.execute("""
            SELECT command_id,payload_hash,payload,status,receipt,receipt_delivered,
                   EXISTS (SELECT 1 FROM outbox WHERE outbox.command_id=commands.command_id) AS native_queued
            FROM commands LIMIT 3
        """).fetchall()
        if len(rows) > len(STEPS):
            raise ValueError("Pi database contains extra commands")
        return {row["command_id"]: dict(row) for row in rows}


def interrupted_pi_result(row, command):
    digest = payload_hash(command)
    if (row["payload_hash"] != digest or row["payload"] != canonical(command)
            or row["receipt_delivered"] not in (0, 1) or (row["receipt_delivered"] and row["native_queued"])):
        raise ValueError("Pi journal command or delivery marker mismatch")
    status = row["status"]
    if row["receipt"] is None:
        if status not in {"RECEIVED", "DISPATCHING"} or row["receipt_delivered"] or row["native_queued"]:
            raise ValueError("Pi command has an inconsistent pending state")
        return {"piCommandState": status}, None
    receipt = json.loads(row["receipt"])
    fields = ("gatewayId", "deviceId", "commandId", "grantRevision", "ownershipEpoch")
    expected = {key: command[key] for key in fields}
    expected.update(version=1, payloadHash=digest, status=status)
    if (status not in {"APPLIED", "REJECTED", "TIMEOUT", "INDETERMINATE"}
            or canonical({key: receipt.get(key) for key in expected}) != canonical(expected)
            or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", receipt["ackCode"])):
        raise ValueError("Pi receipt does not bind the issued command")
    successful_ack = receipt["ackCode"] in {"APPLIED", "DUPLICATE"}
    if (successful_ack != (status == "APPLIED")
            or (successful_ack and canonical(receipt["readback"]) != canonical(command["desiredState"]))):
        raise ValueError("Pi receipt has a contradictory application result")
    parse_time(receipt["receivedAt"])
    return {"piCommandState": status, "piAckCode": receipt["ackCode"], "piReceiptSha256": payload_hash(receipt),
            "piReceiptDelivered": bool(row["receipt_delivered"]), "piReceiptQueued": bool(row["native_queued"])}, receipt


def inspect_interrupted_bench(directory, team_state, database=None):
    issued = team_state.get("gatewayCommands", {})
    if not directory.is_dir() or not isinstance(issued, dict) or not isinstance(team_state.get("receipts"), list):
        raise ValueError("Expected a bench output directory and a team state snapshot")
    rows = read_pi_commands(database) if database is not None else {}
    seen = set()
    steps = []
    for label, state in STEPS:
        prefix = f"led-{label.lower()}"
        intent, issued_file, readback, revocation = (
            read_optional(directory / f"{prefix}-{suffix}.json")
            for suffix in ("intent", "issued", "readback", "grant-revoked")
        )
        if intent is None:
            if issued_file is not None or readback is not None:
                raise ValueError("Bench artifacts have no matching local intent")
            steps.append({"step": label, "intentCaptured": False})
            continue
        request = intent["request"]
        command_id, grant_id = request["commandId"], request["grantId"]
        if (intent["gatewayId"] != GATEWAY or set(request) != {"deviceId", "commandId", "grantId", "desiredState", "deadline"}
                or request["deviceId"] != DEVICE or not ID.fullmatch(command_id) or not ID.fullmatch(grant_id)
                or command_id in seen or canonical(request["desiredState"]) != canonical({"state": state})
                or intent["cseReceiptName"] != receipt_name(command_id)):
            raise ValueError("Bench intent identity or route mismatch")
        seen.add(command_id)
        deadline = iso_time(parse_time(request["deadline"]))
        result = {"step": label, "intentCaptured": True, "commandId": command_id,
                  "nativeRef": f"{ROUTE}/{intent['cseReceiptName']}", "deadline": deadline,
                  "issuanceInTeamSnapshot": command_id in issued,
                  "issuedResponseCaptured": issued_file is not None, "cseReadbackCaptured": readback is not None,
                  "grantRevocationCaptured": revocation is not None,
                  "piCommandState": "MISSING" if database is not None else None}
        steps.append(result)
        if revocation is not None and (revocation.get("grantId") != grant_id or revocation.get("status") != "REVOKED"):
            raise ValueError("Bench grant revocation does not match the intent")

        if command_id not in issued:
            if issued_file is not None or readback is not None or command_id in rows:
                raise ValueError("Team snapshot is missing an issuance referenced by bench or Pi evidence")
            continue
        issued_record = issued[command_id]
        command = validate_command(issued_record["command"], GATEWAY, {DEVICE: ""})
        expected_intent = {**request, "gatewayId": GATEWAY, "deadline": deadline}
        if (command["commandId"] != command_id or command["desiredState"]["state"] is not state
                or command["deadline"] != deadline or issued_record["grantId"] != grant_id
                or issued_record["payloadHash"] != payload_hash(command)
                or issued_record["intentHash"] != payload_hash(expected_intent)):
            raise ValueError("Team issuance does not match the bench intent")
        if issued_file is not None and (canonical(issued_file["command"]) != canonical(command)
                                        or issued_file["cseReceiptName"] != intent["cseReceiptName"]):
            raise ValueError("Captured issuance differs from the team snapshot")
        result["payloadHash"] = issued_record["payloadHash"]
        receipt = None
        if command_id in rows:
            pi_result, receipt = interrupted_pi_result(rows[command_id], command)
            result.update(pi_result)
        if readback is not None:
            observed_boot = readback["observation"]["bootId"]
            matched = verify_step(readback, state, observed_boot, gateway_id=GATEWAY)
            if (canonical(matched) != canonical(command)
                    or (database is not None and canonical(receipt) != canonical(readback["cseReceipt"]))):
                raise ValueError("Captured CSE readback differs from the issued command or Pi receipt")
            resource = readback["cseResource"]
            if not ID.fullmatch(resource["ri"]) or not re.fullmatch(r"[0-9]{8}T[0-9]{6}", resource["ct"]):
                raise ValueError("Invalid captured CSE receipt identity")
            datetime.strptime(resource["ct"], "%Y%m%dT%H%M%S")
            result["cseResourceId"] = resource["ri"]
            result["cseResourceCreated"] = resource["ct"]
            result["cseReceiptSha256"] = payload_hash(readback["cseReceipt"])
    if rows.keys() - seen:
        raise ValueError("Pi database contains commands outside the bench intents")
    return {"steps": steps, "physicalLedObserved": None, "centralSettlementVerified": None}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--cycle", type=Path)
    mode.add_argument("--interrupted-output", type=Path, help="Compare artifacts from an interrupted command bench")
    parser.add_argument("--database", type=Path)
    parser.add_argument("--on-inspection", type=Path)
    parser.add_argument("--off-inspection", type=Path)
    parser.add_argument("--team-state", required=True, type=Path)
    parser.add_argument("--operator-observations", type=Path)
    args = parser.parse_args()
    if args.cycle and not (args.database and args.on_inspection and args.off_inspection):
        parser.error("--cycle requires --database, --on-inspection and --off-inspection")
    if args.interrupted_output and (args.on_inspection or args.off_inspection or args.operator_observations):
        parser.error("Settlement and operator inputs require a completed --cycle")
    try:
        team_state = read_json(args.team_state)
        if args.interrupted_output:
            result = inspect_interrupted_bench(args.interrupted_output, team_state, args.database)
        else:
            result = verify_scoped_evidence(read_json(args.cycle), args.database,
                                            [read_json(args.on_inspection), read_json(args.off_inspection)],
                                            team_state,
                                            read_json(args.operator_observations) if args.operator_observations else None)
    except (AttributeError, KeyError, TypeError, OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        parser.exit(1, f"Evidence could not be bound ({type(error).__name__}).\n")
    print(json.dumps(result, indent=2))
