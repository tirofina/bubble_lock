"""Read-only comparison with the DOC-REV 2.0.0 integration command history."""

from datetime import timedelta

from .config import ID
from .model import canonical, iso_time, parse_time, payload_hash, validate_command

COMMAND_BINDING = ("gatewayId", "deviceId", "commandId", "claimId", "grantRevision", "ownershipEpoch")


def match_integration_issuance(request, issued_record, gateway_id, device_id, desired_state):
    deadline = iso_time(parse_time(request["deadline"]))
    command = validate_command(issued_record["command"], gateway_id, {device_id: ""})
    expected_intent = {**request, "gatewayId": gateway_id, "deadline": deadline}
    if (command["commandId"] != request["commandId"] or command["desiredState"]["state"] is not desired_state
            or command["deadline"] != deadline or issued_record["grantId"] != request["grantId"]
            or issued_record["payloadHash"] != payload_hash(command)
            or issued_record["intentHash"] != payload_hash(expected_intent)):
        raise ValueError("Team issuance does not match the bench intent")
    return command


def integration_settlement(command, receipt, team_state):
    command_id = command["commandId"]
    record = team_state.get("gatewayCommands", {}).get(command_id)
    digest = payload_hash(command)
    if (not record or canonical(record["command"]) != canonical(command) or record["payloadHash"] != digest):
        raise ValueError("Central command does not match the issued command")
    stored = team_state.get("gatewayDeviceReceipts", {}).get(command_id)
    if stored is None:
        return None
    receipt_digest = payload_hash(receipt)
    if (record.get("executionState") != "APPLIED_VERIFIED" or record.get("lastReceiptHash") != receipt_digest
            or stored.get("receiptHash") != receipt_digest or canonical(stored.get("receipt")) != canonical(receipt)
            or canonical(record.get("readback")) != canonical(command["desiredState"])):
        raise ValueError("Central settlement does not match the native command receipt")
    return record, stored


def require_integration_event(team_state, kind, identity, fields, *, allow_pending=False):
    matches = [event for event in team_state["receipts"] if event.get("type") == kind
               and all(event.get(key) == value for key, value in identity.items())]
    if not matches and allow_pending:
        return None
    expected = dict(fields, contractId="privacy-bubble.integration.v1", docRevision="2.0.0")
    if (len(matches) != 1 or not isinstance(matches[0].get("eventId"), str) or not ID.fullmatch(matches[0]["eventId"])
            or canonical({key: matches[0].get(key) for key in expected}) != canonical(expected)):
        raise ValueError(f"Missing or inconsistent {kind} evidence")
    return matches[0]


def inspect_integration_command(command, receipt, team_state):
    settlement = integration_settlement(command, receipt, team_state)
    if settlement is None:
        return None
    record, stored = settlement
    identity = {key: command[key] for key in ("gatewayId", "commandId")}
    generation = record["desiredGeneration"]
    if type(generation) is not int or generation < 1:
        raise ValueError("Invalid central device generation")
    start_fields = {key: command[key] for key in COMMAND_BINDING if key not in identity}
    start_fields.update(payloadHash=record["payloadHash"], desiredGeneration=generation, executionState="IN_FLIGHT",
                        dispatchStartedAt=record["dispatchStartedAt"], claimCommittedAt=record["claimCommittedAt"])
    started_event = require_integration_event(team_state, "GATEWAY_DISPATCH_STARTED", identity, start_fields)
    settled_fields = {"ueId": command["deviceId"], "epoch": command["ownershipEpoch"], "claimId": command["claimId"],
                      "payloadHash": record["payloadHash"], "desiredGeneration": generation,
                      "executionState": "APPLIED_VERIFIED", "receiptHash": stored["receiptHash"]}
    settled_event = require_integration_event(team_state, "GATEWAY_RECEIPT_SETTLED", identity, settled_fields)

    issued_at, deadline = map(parse_time, (command["issuedAt"], command["deadline"]))
    claimed_at, started_at, expires_at, settled_at = map(parse_time, (
        record["claimCommittedAt"], record["dispatchStartedAt"], record["claimExpiresAt"], record["settledAt"]))
    receipt_at = parse_time(receipt["receivedAt"])
    central_received_at = parse_time(stored["receivedAt"])
    if (not issued_at <= claimed_at <= started_at < expires_at <= deadline
            or not started_at <= parse_time(started_event["timestamp"]) <= settled_at
            or not settled_at <= central_received_at <= parse_time(settled_event["timestamp"])
            or not started_at - timedelta(seconds=2) <= receipt_at <= central_received_at + timedelta(seconds=2)):
        raise ValueError("Central dispatch and settlement timestamps are inconsistent")
    return {"dispatchEventId": started_event["eventId"], "settlementEventId": settled_event["eventId"]}
