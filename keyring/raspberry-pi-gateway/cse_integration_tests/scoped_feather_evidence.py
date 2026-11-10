"""Bind the scoped Feather bench artifacts without changing any device or service state."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path

from bubble_gateway.model import canonical, parse_time
from pi_led_cycle import verify_database

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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cycle", required=True, type=Path)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--on-inspection", required=True, type=Path)
    parser.add_argument("--off-inspection", required=True, type=Path)
    parser.add_argument("--team-state", required=True, type=Path)
    parser.add_argument("--operator-observations", type=Path)
    args = parser.parse_args()
    try:
        result = verify_scoped_evidence(read_json(args.cycle), args.database,
                                        [read_json(args.on_inspection), read_json(args.off_inspection)],
                                        read_json(args.team_state),
                                        read_json(args.operator_observations) if args.operator_observations else None)
    except (KeyError, TypeError, OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f"Evidence could not be bound ({type(error).__name__}).\n")
    print(json.dumps(result, indent=2))
