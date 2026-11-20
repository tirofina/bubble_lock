"""Read-only comparison with the DOC-REV 2.0.0 integration command history."""

from datetime import timedelta
import re

from .config import ID
from .model import (canonical, central_observation_id, central_receipt_execution_state, iso_time,
                    parse_time, payload_hash, validate_command)

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


def inspect_integration_observation(observation, team_state, *, allow_pending=False):
    fields = {key: observation[key] for key in ("gatewayId", "deviceId", "observedAt")}
    if "payloadHash" in observation:
        native_hash = observation["payloadHash"]
        if not isinstance(native_hash, str) or re.fullmatch(r"[0-9a-f]{64}", native_hash) is None:
            raise ValueError("Invalid native observation payload hash")
        fields["payloadHash"] = native_hash
    telemetry = require_integration_event(
        team_state, "GATEWAY_TELEMETRY_ACCEPTED", {"observationId": central_observation_id(observation)},
        fields, allow_pending=allow_pending)
    if telemetry is not None:
        sequence = telemetry.get("sequence")
        if (type(sequence) is not int or sequence < 0
                or parse_time(telemetry["timestamp"]) < parse_time(observation["observedAt"]) - timedelta(seconds=2)):
            raise ValueError("Invalid central telemetry sequence or timestamp")
    return telemetry


def _receipt_settlement_event(command, receipt, digest, generation, team_state):
    return require_integration_event(
        team_state, "GATEWAY_RECEIPT_SETTLED",
        {"gatewayId": command["gatewayId"], "commandId": command["commandId"], "receiptHash": payload_hash(receipt)},
        {"ueId": command["deviceId"], "claimId": command["claimId"], "epoch": command["ownershipEpoch"],
         "desiredGeneration": generation, "payloadHash": digest,
         "executionState": central_receipt_execution_state(receipt), "deviceAppliedAt": receipt["appliedAt"]},
    )


def _check_settled_receipt(command, receipt, record):
    state = central_receipt_execution_state(receipt)
    if record.get("executionState") != state:
        raise ValueError("Invalid central settlement state")
    if state == "APPLIED_VERIFIED":
        if (canonical(record.get("readback")) != canonical(command["desiredState"])
                or canonical(receipt.get("readback")) != canonical(command["desiredState"])):
            raise ValueError("Central application readback differs from the command")
    elif state == "SETTLED_CANCELLED" and record.get("settlementReason") != receipt["ackCode"]:
        raise ValueError("Central cancellation reason differs from the Pi receipt")


def inspect_integration_receipt(command, receipt, team_state):
    """Compare central acceptance of a Pi receipt without requiring a device record."""
    command_id = command["commandId"]
    record = team_state.get("gatewayCommands", {}).get(command_id)
    stored = team_state.get("gatewayDeviceReceipts", {}).get(command_id)
    if record is None and stored is None:
        return {"result": "missing_central_command"}
    digest = payload_hash(command)
    if record is None or canonical(record["command"]) != canonical(command) or record["payloadHash"] != digest:
        raise ValueError("Central command does not match the Pi command")
    if stored is None and record.get("lastReceiptHash") is None:
        return {"result": "missing_central_receipt"}
    if stored is None:
        raise ValueError("Missing central receipt body")
    current_receipt = stored["receipt"]
    current_digest = payload_hash(current_receipt)
    if stored.get("receiptHash") != current_digest or record.get("lastReceiptHash") != current_digest:
        raise ValueError("Central receipt hash differs from the saved body")

    receipt_digest = payload_hash(receipt)
    expected_state = central_receipt_execution_state(receipt)
    generation = record.get("desiredGeneration", 0)
    if type(generation) is not int or generation < 0:
        raise ValueError("Invalid central device generation")
    event = _receipt_settlement_event(command, receipt, digest, generation, team_state)
    issued = parse_time(command["issuedAt"])
    received = parse_time(receipt["receivedAt"])
    event_at = parse_time(event["timestamp"])
    central_received = parse_time(stored["receivedAt"])
    skew = timedelta(seconds=2)
    if not issued <= received <= event_at + skew:
        raise ValueError("Central receipt chronology does not match the Pi receipt")
    evidence = {"result": "central_receipt_matched", "executionState": expected_state, "receiptHash": receipt_digest,
                "settlementEventId": event["eventId"]}
    current_state = record.get("executionState")
    if receipt_digest == current_digest:
        if canonical(current_receipt) != canonical(receipt) or not received <= central_received + skew or event_at < central_received:
            raise ValueError("Central receipt chronology or body differs from the Pi receipt")
        if current_state == expected_state:
            _check_settled_receipt(command, receipt, record)
            return evidence
        if expected_state != "DISPATCH_UNCERTAIN" or current_state != "APPLIED_VERIFIED":
            raise ValueError("Invalid central settlement transition")
        if canonical(record.get("readback")) != canonical(command["desiredState"]):
            raise ValueError("Central application readback differs from the command")
        settled = require_integration_event(
            team_state, "DISPATCH_READBACK_SETTLED",
            {"ueId": command["deviceId"], "commandId": command_id,
             "claimId": command["claimId"], "epoch": command["ownershipEpoch"]},
            {"readback": command["desiredState"]},
        )
        if not event_at <= parse_time(record["settledAt"]) <= parse_time(settled["timestamp"]):
            raise ValueError("Central readback settlement precedes the original receipt")
        return {**evidence, "currentExecutionState": current_state, "currentSettlementEventId": settled["eventId"]}

    if expected_state != "DISPATCH_UNCERTAIN" or current_state not in ("APPLIED_VERIFIED", "SETTLED_CANCELLED"):
        raise ValueError("Central receipt does not match the Pi receipt")
    binding = {key: command[key] for key in COMMAND_BINDING if key != "claimId"}
    binding.update(payloadHash=digest, version=1)
    if canonical({key: current_receipt.get(key) for key in binding}) != canonical(binding):
        raise ValueError("New central receipt differs from the issued command")
    _check_settled_receipt(command, current_receipt, record)
    settled = _receipt_settlement_event(command, current_receipt, digest, generation, team_state)
    if (not event_at <= central_received <= parse_time(settled["timestamp"])
            or not issued <= parse_time(current_receipt["receivedAt"]) <= central_received + skew):
        raise ValueError("New central settlement chronology is inconsistent")
    return {**evidence, "currentExecutionState": current_state, "currentSettlementEventId": settled["eventId"],
            "currentReceiptHash": current_digest}


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
                      "executionState": "APPLIED_VERIFIED"}
    settled_event = require_integration_event(
        team_state, "GATEWAY_RECEIPT_SETTLED", {**identity, "receiptHash": stored["receiptHash"]}, settled_fields)

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
