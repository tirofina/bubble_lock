"""Bind the scoped Feather bench artifacts without changing any device or service state."""
import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sqlite3

from bubble_gateway.config import ID
from bubble_gateway.integration_evidence import (COMMAND_BINDING, inspect_integration_command,
                                                 match_integration_issuance, require_integration_event)
from bubble_gateway.model import canonical, central_observation_id, iso_time, parse_time, payload_hash, validate_command
from bubble_gateway.state_identity import metadata, readonly
from pi_led_cycle import DEVICE, FIRMWARE, STEPS, receipt_name, verify_database, verify_step
from scoped_feather_pi import DISPLAY_FIRMWARE

GATEWAY = "gw-a"
ROUTE = "/Mobius/privacy-bubble-test-ae/command-receipts-a"
SOURCES = {"CSE_CALLBACK", "RECOVERY_SWEEP"}


def read_json(path):
    with path.open(encoding="utf-8-sig") as stream:
        return json.load(stream)


def matches_approval(event, command, payload_hash, native_stored_at):
    expected = {key: command[key] for key in COMMAND_BINDING}
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


def display_observations(cycle, observations):
    if observations is None:
        return None
    if cycle.get("firmwareRevision") != DISPLAY_FIRMWARE:
        raise ValueError("Command display evidence requires the Feather display firmware")
    steps = cycle["steps"]
    if not isinstance(observations, list) or len(observations) != len(steps):
        raise ValueError("Record one screen observation for each command")
    report = []
    for index, (step, observation) in enumerate(zip(steps, observations)):
        if not isinstance(observation, dict) or observation.keys() != {"commandId", "screenText", "observedAt"}:
            raise ValueError("Invalid command display observation fields")
        command = step["command"]
        text = observation["screenText"]
        if text not in ("CMD ON", "CMD OFF", "CMD GPIO ERROR", None):
            raise ValueError("Invalid command display text")
        when = parse_time(observation["observedAt"])
        if (observation["commandId"] != command["commandId"]
                or when < parse_time(step["observation"]["receivedAt"])
                or (index + 1 < len(steps) and when >= parse_time(steps[index + 1]["command"]["issuedAt"]))):
            raise ValueError("Command display observation is outside the recorded command interval")
        expected = "CMD ON" if command["desiredState"]["state"] else "CMD OFF"
        report.append({**observation, "matched": text == expected})
    return report


def operator_evidence(cycle, observed_led, observed_display):
    led = physical_observations(cycle["steps"], observed_led)
    display = display_observations(cycle, observed_display)
    return {"physicalLedObserved": led, "physicalLedMatched": None if led is None else all(row["matched"] for row in led),
            "commandDisplayObserved": display,
            "commandDisplayMatched": None if display is None else all(row["matched"] for row in display)}


def verify_scoped_evidence(cycle, database, inspections, team_state, observed_led=None, *, observed_display=None,
                           prior_expired_commands=()):
    steps = cycle["steps"]
    if len(set(prior_expired_commands)) != len(prior_expired_commands):
        raise ValueError("Specify each prior expired command once")
    proof = verify_database(cycle, database, gateway_id=GATEWAY, prior_expired_commands=prior_expired_commands)
    if len(inspections) != len(steps):
        raise ValueError("Provide one PostgreSQL inspection for each command")
    commands = [inspect_command(step, pi_proof, inspection, team_state)
                for step, pi_proof, inspection in zip(steps, proof["commands"], inspections)]
    return {"piCseBindingVerified": True,
            "observationContainerVerified": proof["observationContainerVerified"],
            "priorExpiredCommandCount": len(prior_expired_commands),
            "centralSettlementVerified": all(row["settlementVerified"] for row in commands),
            "cseCallbackRecorded": all("CSE_CALLBACK" in row["deliverySources"] for row in commands),
            **operator_evidence(cycle, observed_led, observed_display),
            "commands": commands}


def integration_observation_event(step, team_state, *, allow_pending=False):
    command, observation = step["command"], step["observation"]
    telemetry_fields = {"gatewayId": command["gatewayId"], "deviceId": command["deviceId"],
                        "observedAt": observation["observedAt"]}
    observation_id = central_observation_id({**observation, **telemetry_fields})
    if "payloadHash" in observation:
        native_hash = observation["payloadHash"]
        if not isinstance(native_hash, str) or re.fullmatch(r"[0-9a-f]{64}", native_hash) is None:
            raise ValueError("Invalid native observation payload hash")
        telemetry_fields["payloadHash"] = native_hash
    telemetry = require_integration_event(team_state, "GATEWAY_TELEMETRY_ACCEPTED", {"observationId": observation_id},
                                          telemetry_fields, allow_pending=allow_pending)
    if telemetry is not None:
        sequence = telemetry.get("sequence")
        if (type(sequence) is not int or sequence < 0
                or parse_time(telemetry["timestamp"]) < parse_time(observation["observedAt"]) - timedelta(seconds=2)):
            raise ValueError("Invalid central telemetry sequence or timestamp")
    return telemetry


def inspect_integration_step(step, pi_proof, team_state):
    command, receipt, observation = step["command"], step["cseReceipt"], step["observation"]
    resource = step["cseResource"]
    if not ID.fullmatch(resource["ri"]) or re.fullmatch(r"[0-9]{8}T[0-9]{6}", resource["ct"]) is None:
        raise ValueError("Invalid native receipt resource identity")
    if pi_proof["payloadHash"] != payload_hash(command) or pi_proof["receiptHash"] != payload_hash(receipt):
        raise ValueError("Pi evidence differs from the command or native receipt")
    settlement = inspect_integration_command(command, receipt, team_state)
    if settlement is None:
        raise ValueError("Central command receipt is not settled")
    telemetry = integration_observation_event(step, team_state)
    return {**pi_proof, **settlement,
            "telemetryEventId": telemetry["eventId"], "observationId": telemetry["observationId"],
            "centralTelemetrySequence": telemetry["sequence"], "nativeResourceId": resource["ri"],
            "centralTelemetryPayloadVerified": True if "payloadHash" in observation else None}


def verify_integration_evidence(cycle, database, team_state, observed_led=None, *, observed_display=None,
                                prior_expired_commands=()):
    if len(set(prior_expired_commands)) != len(prior_expired_commands):
        raise ValueError("Specify each prior expired command once")
    proof = verify_database(cycle, database, gateway_id=GATEWAY, prior_expired_commands=prior_expired_commands,
                            require_central_receipts=True)
    steps = cycle["steps"]
    commands = [inspect_integration_step(step, pi_proof, team_state) for step, pi_proof in zip(steps, proof["commands"])]
    if commands[0]["centralTelemetrySequence"] >= commands[1]["centralTelemetrySequence"]:
        raise ValueError("Central telemetry order does not match the LED cycle")
    payload_verified = commands[0]["centralTelemetryPayloadVerified"]
    if payload_verified is not commands[1]["centralTelemetryPayloadVerified"]:
        raise ValueError("Native observation payload hashes are incomplete for the LED cycle")
    return {"piCseBindingVerified": True, "centralDispatchVerified": True, "centralSettlementVerified": True,
            "observationContainerVerified": proof["observationContainerVerified"],
            "centralTelemetryVerified": True, "centralTelemetryPayloadVerified": payload_verified,
            "priorExpiredCommandCount": len(prior_expired_commands),
            **operator_evidence(cycle, observed_led, observed_display),
            "commands": commands}


def read_optional(path):
    try:
        value = read_json(path)
    except FileNotFoundError:
        return None
    if not isinstance(value, dict):
        raise ValueError("Bench artifact must contain a JSON object")
    return value


def read_pi_commands(database, *, gateway_id=GATEWAY, originator="Sscoped-feather-gateway-a", receipt_container=ROUTE,
                     deployment_ids=(None, "scoped-mobius4"), command_id=None, receipt_parent=None,
                     container_pins=None):
    with closing(readonly(database)) as db:
        db.execute("BEGIN")
        record = metadata(db)
        binding = record["binding"] if record else {}
        if (binding.get("gatewayId") != gateway_id or binding.get("cseId") != "Mobius4"
                or binding.get("originator") != originator or binding.get("receiptContainer") != receipt_container
                or binding.get("cseDeploymentId") not in deployment_ids
                or (receipt_parent is not None and binding.get("receiptContainerRi") not in (None, receipt_parent))
                or (container_pins is not None and
                    (binding.get("receiptContainerRi"), binding.get("observationContainerRi")) != container_pins)):
            raise ValueError("Pi database does not belong to the scoped session")
        rows = db.execute("""
            SELECT command_id,payload_hash,payload,status,receipt,receipt_delivered,
                   EXISTS (SELECT 1 FROM outbox WHERE outbox.command_id=commands.command_id) AS native_queued
            FROM commands WHERE (? IS NULL OR command_id=?) LIMIT 3
        """, (command_id, command_id)).fetchall()
        if len(rows) > len(STEPS):
            raise ValueError("Pi database contains extra commands")
        return {row["command_id"]: dict(row) for row in rows}


def validate_interrupted_receipt(receipt, command, status):
    fields = ("gatewayId", "deviceId", "commandId", "grantRevision", "ownershipEpoch")
    expected = {key: command[key] for key in fields}
    expected.update(version=1, payloadHash=payload_hash(command), status=status)
    if (status not in {"APPLIED", "REJECTED", "TIMEOUT", "INDETERMINATE"}
            or canonical({key: receipt.get(key) for key in expected}) != canonical(expected)
            or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", receipt["ackCode"])):
        raise ValueError("Pi receipt does not bind the issued command")
    successful_ack = receipt["ackCode"] in {"APPLIED", "DUPLICATE"}
    if (successful_ack != (status == "APPLIED")
            or (successful_ack and canonical(receipt["readback"]) != canonical(command["desiredState"]))):
        raise ValueError("Pi receipt has a contradictory application result")
    parse_time(receipt["receivedAt"])


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
    validate_interrupted_receipt(receipt, command, status)
    return {"piCommandState": status, "piAckCode": receipt["ackCode"], "piReceiptSha256": payload_hash(receipt),
            "piReceiptDelivered": bool(row["receipt_delivered"]), "piReceiptQueued": bool(row["native_queued"])}, receipt


def inspect_interrupted_bench(directory, team_state, database=None):
    issued = team_state.get("gatewayCommands", {})
    if not directory.is_dir() or not isinstance(issued, dict) or not isinstance(team_state.get("receipts"), list):
        raise ValueError("Expected a bench output directory and a team state snapshot")
    rows = read_pi_commands(database) if database is not None else {}
    seen = set()
    steps = []
    bench_identity = None
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
        command = match_integration_issuance(request, issued_record, GATEWAY, DEVICE, state)
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
            firmware = readback.get("firmwareRevision", FIRMWARE)
            identity = (observed_boot, firmware)
            if bench_identity is not None and identity != bench_identity:
                raise ValueError("Captured command steps do not share a Feather boot and firmware")
            bench_identity = identity
            matched = verify_step(readback, state, observed_boot, gateway_id=GATEWAY, firmware=firmware)
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
    parser.add_argument("--api-mode", choices=("legacy", "integration"), default="legacy")
    parser.add_argument("--operator-observations", type=Path)
    parser.add_argument("--display-observations", type=Path, help="Operator observations of the Feather command display")
    parser.add_argument("--prior-expired-command", action="append", default=[],
                        help="Exact command ID of an earlier, delivered pre-device expiration in the same Pi database")
    args = parser.parse_args()
    if args.api_mode == "integration" and (not args.cycle or not args.database or args.on_inspection or args.off_inspection):
        parser.error("Integration mode requires --cycle and --database and reads settlement from --team-state")
    if args.api_mode == "legacy" and args.cycle and not (args.database and args.on_inspection and args.off_inspection):
        parser.error("--cycle requires --database, --on-inspection and --off-inspection")
    if args.interrupted_output and (args.on_inspection or args.off_inspection or args.operator_observations or args.display_observations
                                    or args.prior_expired_command):
        parser.error("Settlement and operator inputs require a completed --cycle")
    try:
        team_state = read_json(args.team_state)
        if args.interrupted_output:
            result = inspect_interrupted_bench(args.interrupted_output, team_state, args.database)
        elif args.api_mode == "integration":
            result = verify_integration_evidence(
                read_json(args.cycle), args.database, team_state,
                read_json(args.operator_observations) if args.operator_observations else None,
                observed_display=read_json(args.display_observations) if args.display_observations else None,
                prior_expired_commands=args.prior_expired_command,
            )
        else:
            result = verify_scoped_evidence(read_json(args.cycle), args.database,
                                            [read_json(args.on_inspection), read_json(args.off_inspection)],
                                            team_state,
                                            read_json(args.operator_observations) if args.operator_observations else None,
                                            observed_display=read_json(args.display_observations) if args.display_observations else None,
                                            prior_expired_commands=args.prior_expired_command)
    except (AttributeError, KeyError, TypeError, OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        parser.exit(1, f"Evidence could not be bound ({type(error).__name__}).\n")
    print(json.dumps(result, indent=2))
