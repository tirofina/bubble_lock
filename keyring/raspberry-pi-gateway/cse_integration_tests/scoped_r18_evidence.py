"""Inspect interrupted r18 pulse artifacts without contacting the bench services."""

import argparse
import csv
from datetime import datetime
import json
from pathlib import Path
import re
import sqlite3

from bubble_gateway.config import ID
from bubble_gateway.integration_evidence import (inspect_integration_command, inspect_integration_observation,
                                                 match_integration_issuance, require_integration_event)
from bubble_gateway.model import canonical, iso_time, parse_time, payload_hash
from pi_led_cycle import receipt_name, verify_observation_resource
from r18_pulse_trace import inspect_pulse_trace
from scoped_feather_evidence import (interrupted_pi_result, read_json, read_optional, read_pi_commands,
                                    validate_interrupted_receipt)
from scoped_feather_pi import R18_COMMAND_FIRMWARES, R18_LEGACY_COMMAND_FIRMWARE
from scoped_r18_pulse import (GATEWAY, PATHS, R18_DEVICE, TELEMETRY_EVENT_FIELDS, check_pulse_wake_baseline,
                             pulse_journal_readiness, read_pulse_wake_report, validate_container_pins)


def check_receipt(receipt, command, boot_id, firmware):
    validate_interrupted_receipt(receipt, command, receipt["status"])
    if receipt["status"] == "APPLIED" and (receipt.get("bootId") != boot_id
                                           or receipt.get("firmwareRevision") != firmware):
        raise ValueError("Applied receipt differs from the r18 baseline")


def inspect_post_pulse(result, saved_observation, saved_event, command, baseline, receipt, team_state):
    proof = {"postPulseObservationCaptured": result is not None, "postPulseCentralTelemetryVerified": False}
    if result is None:
        if saved_observation is not None or saved_event is not None:
            raise ValueError("Post-pulse telemetry has no saved pulse result")
        return proof

    command_id = command["commandId"]
    final = result["postPulseObservation"]
    verify_observation_resource(final, R18_DEVICE, baseline["cseResource"]["pi"])
    if (result["commandId"] != command_id or receipt is None or receipt["ackCode"] != "APPLIED"
            or final["state"] is not False or final["bootId"] != baseline["bootId"]
            or final["sequence"] <= baseline["sequence"]
            or parse_time(final["receivedAt"]) < parse_time(receipt["receivedAt"])):
        raise ValueError("Saved OFF observation does not follow the original r18 application")
    if saved_observation is None:
        if saved_event is not None:
            raise ValueError("Saved central telemetry has no matching native observation")
        return proof

    observation = saved_observation["observation"]
    expected = dict(final, gatewayId=GATEWAY, deviceId=R18_DEVICE, payloadHash=observation["payloadHash"])
    if (saved_observation["commandId"] != command_id or canonical(observation) != canonical(expected)
            or parse_time(observation["observedAt"]) > parse_time(observation["receivedAt"])):
        raise ValueError("Saved native observation differs from the r18 pulse result")
    if saved_event is not None and (saved_event["commandId"] != command_id
                                    or saved_event["payloadHash"] != observation["payloadHash"]):
        raise ValueError("Saved central telemetry differs from the r18 OFF observation")
    event = inspect_integration_observation(observation, team_state, allow_pending=True)
    if event is None:
        return proof
    expected_event = {"commandId": command_id, **{key: event[key] for key in TELEMETRY_EVENT_FIELDS}}
    if saved_event is not None and canonical(saved_event) != canonical(expected_event):
        raise ValueError("Saved central telemetry differs from the supplied state snapshot")
    proof.update(postPulseCentralTelemetryVerified=True, postPulseCentralTelemetry=expected_event)
    return proof


def inspect_pulse(directory, team_state, database=None, *, trace_path=None, trace_metadata=None, wake_report=None):
    if (trace_path is None) != (trace_metadata is None):
        raise ValueError("Pulse trace and metadata must be supplied together")
    issued = team_state.get("gatewayCommands")
    stored_receipts = team_state.get("gatewayDeviceReceipts", {})
    if (not directory.is_dir() or not isinstance(issued, dict) or not isinstance(stored_receipts, dict)
            or not isinstance(team_state.get("receipts"), list)):
        raise ValueError("Expected an r18 output directory and an integration state snapshot")
    intent, issued_file, native_file, grant, revoked = (
        read_optional(directory / f"pulse-{suffix}.json")
        for suffix in ("intent", "issued", "receipt", "grant", "grant-revoked")
    )
    result, observation_file, event_file = (
        read_optional(directory / f"pulse-{suffix}.json")
        for suffix in ("result", "observation", "central-telemetry")
    )
    scope = read_optional(directory / "pulse-scope.json")
    pins = None
    journal_required = False
    firmware = R18_LEGACY_COMMAND_FIRMWARE
    wake_digest = None
    if scope is not None:
        if scope["gatewayId"] != GATEWAY:
            raise ValueError("r18 scope belongs to a different Gateway")
        pins = validate_container_pins(scope["containerPins"])
        journal_required = scope.get("journalReadinessRequired", False)
        firmware = scope.get("firmwareRevision", firmware)
        if type(journal_required) is not bool or firmware not in R18_COMMAND_FIRMWARES:
            raise ValueError("Invalid r18 journal readiness scope")
        if "wakeReportSha256" in scope:
            wake_digest = scope["wakeReportSha256"]
            if not isinstance(wake_digest, str) or re.fullmatch(r"[a-f0-9]{64}", wake_digest) is None:
                raise ValueError("Invalid scoped r18 wake report hash")
    wake = read_pulse_wake_report(wake_report, firmware) if wake_report is not None else None
    if wake is not None and wake["reportSha256"] != wake_digest:
        raise ValueError("Wake report differs from the one selected before the pulse")
    report = {"intentCaptured": intent is not None, "issuedResponseCaptured": issued_file is not None,
              "cseReceiptCaptured": native_file is not None, "grantRevocationCaptured": revoked is not None,
              "cseContainerPinsCaptured": pins is not None, "postPulseObservationCaptured": False,
              "postPulseCentralTelemetryVerified": False, "journalReadiness": None, "firmwareRevision": firmware,
              "physicalPulseMeasured": None, "wakeReportSha256": wake_digest,
              "postWakeEvidence": None, "postWakeApplicationVerified": False}
    if intent is None:
        if trace_path is not None:
            raise ValueError("Pulse trace requires the saved r18 command intent")
        if any(artifact is not None for artifact in (issued_file, native_file, result, observation_file, event_file)):
            raise ValueError("r18 artifacts have no matching local intent")
        if revoked is not None and (grant is None or revoked["grantId"] != grant["grantId"] or revoked["status"] != "REVOKED"):
            raise ValueError("r18 grant revocation differs from the saved grant")
        return report

    request = intent["request"]
    command_id, grant_id = request["commandId"], request["grantId"]
    if (intent["gatewayId"] != GATEWAY or set(request) != {"deviceId", "commandId", "grantId", "desiredState", "deadline"}
            or request["deviceId"] != R18_DEVICE or not isinstance(command_id, str) or not ID.fullmatch(command_id)
            or not isinstance(grant_id, str) or not ID.fullmatch(grant_id)
            or canonical(request["desiredState"]) != canonical({"state": True})
            or intent["cseReceiptName"] != receipt_name(command_id)):
        raise ValueError("r18 intent identity or route mismatch")
    if (grant is not None and grant["grantId"] != grant_id
            or revoked is not None and (revoked["grantId"] != grant_id or revoked["status"] != "REVOKED")):
        raise ValueError("r18 grant artifacts differ from the saved intent")
    baseline = intent["baseline"]
    if baseline["state"] is not False:
        raise ValueError("r18 intent did not capture an OFF baseline")
    verify_observation_resource(baseline, R18_DEVICE, pins["observation"] if pins is not None else None)
    parse_time(baseline["receivedAt"])
    if wake is not None:
        check_pulse_wake_baseline(wake, baseline)
        report["postWakeEvidence"] = {**wake, "baselineSequence": baseline["sequence"]}
    journal = baseline.get("journal")
    if journal is not None or journal_required:
        if not isinstance(journal, dict) or pulse_journal_readiness(journal) != journal:
            raise ValueError("r18 intent lacks valid journal readiness evidence")
        report["journalReadiness"] = journal
    if pins is not None:
        health_resource = intent["commandReadiness"]["cseResource"]
        if (health_resource["pi"] != pins["health"] or not isinstance(health_resource["ri"], str)
                or not ID.fullmatch(health_resource["ri"])):
            raise ValueError("Saved r18 readiness has a different health container parent or invalid resource ID")

    parent = None
    if native_file is not None:
        resource = native_file["cseResource"]
        parent = resource["pi"]
        if (any(not isinstance(resource[key], str) or not ID.fullmatch(resource[key]) for key in ("ri", "pi"))
                or not re.fullmatch(r"[0-9]{8}T[0-9]{6}", resource["ct"])):
            raise ValueError("Invalid saved r18 CSE resource")
        if ("ty" in resource or "rn" in resource) and (type(resource.get("ty")) is not int
                or resource["ty"] != 4 or resource.get("rn") != intent["cseReceiptName"]):
            raise ValueError("Saved r18 CSE receipt has a different resource type or name")
        if pins is not None and parent != pins["receipt"]:
            raise ValueError("Saved r18 CSE receipt has a different container parent")
        datetime.strptime(resource["ct"], "%Y%m%dT%H%M%S")
        report.update(cseResourceId=resource["ri"], cseResourceCreated=resource["ct"])
    pi_row = None
    if database is not None:
        pi_pins = (pins["receipt"], pins["observation"]) if pins is not None else None
        pi_row = read_pi_commands(database, gateway_id=GATEWAY, originator="Sscoped-r18-gateway-b",
                                  receipt_container=PATHS["receipt"], deployment_ids=("scoped-mobius4",),
                                  command_id=command_id, receipt_parent=parent, container_pins=pi_pins).get(command_id)
    report.update(commandId=command_id, nativeRef=f"{PATHS['receipt']}/{intent['cseReceiptName']}",
                  deadline=iso_time(parse_time(request["deadline"])), issuanceInTeamSnapshot=command_id in issued,
                  piCommandState="MISSING" if database is not None else None,
                  centralReceiptCaptured=command_id in stored_receipts, centralApplicationVerified=False)
    if command_id not in issued:
        if trace_path is not None:
            raise ValueError("Pulse trace requires the original command in the team snapshot")
        has_event = any(event.get("gatewayId") == GATEWAY and event.get("commandId") == command_id
                        and event.get("type") == "GATEWAY_COMMAND_ISSUED" for event in team_state["receipts"])
        if (any(artifact is not None for artifact in (issued_file, native_file, result, observation_file, event_file, pi_row))
                or command_id in stored_receipts or has_event):
            raise ValueError("Team snapshot omits an issuance referenced by other evidence")
        return report

    issued_record = issued[command_id]
    command = match_integration_issuance(request, issued_record, GATEWAY, R18_DEVICE, True)
    if issued_file is not None and (canonical(issued_file["command"]) != canonical(command)
                                    or issued_file["cseReceiptName"] != intent["cseReceiptName"]):
        raise ValueError("r18 issue response differs from the team snapshot")
    generation = issued_record["desiredGeneration"]
    reserved, expires = issued_record["reservedAt"], issued_record["reservationExpiresAt"]
    if (type(generation) is not int or generation < 1 or reserved != command["issuedAt"]
            or not isinstance(issued_record["executionState"], str)
            or not parse_time(reserved) < parse_time(expires) <= parse_time(command["deadline"])):
        raise ValueError("Invalid r18 reservation")
    event = require_integration_event(team_state, "GATEWAY_COMMAND_ISSUED",
                                      {"gatewayId": GATEWAY, "commandId": command_id},
                                      {"owner": "PC-MOBIUS-INTEGRATION", "deviceId": R18_DEVICE,
                                       "claimId": command["claimId"], "grantId": grant_id, "desiredGeneration": generation,
                                       "payloadHash": issued_record["payloadHash"], "executionState": "RESERVED",
                                       "reservedAt": reserved, "reservationExpiresAt": expires})
    report.update(issuanceEventId=event["eventId"], centralExecutionState=issued_record["executionState"],
                  payloadHash=issued_record["payloadHash"])

    pi_receipt = None
    if pi_row is not None:
        pi_proof, pi_receipt = interrupted_pi_result(pi_row, command)
        report.update(pi_proof)
    native_receipt = native_file["cseReceipt"] if native_file is not None else None
    if native_receipt is not None:
        check_receipt(native_receipt, command, baseline["bootId"], firmware)
        report.update(cseAckCode=native_receipt["ackCode"], cseReceiptSha256=payload_hash(native_receipt))
    stored = stored_receipts.get(command_id)
    if command_id in stored_receipts and (not isinstance(stored, dict) or not isinstance(stored.get("receipt"), dict)):
        raise ValueError("Invalid saved central receipt")
    central_receipt = stored["receipt"] if stored is not None else None
    if central_receipt is not None:
        check_receipt(central_receipt, command, baseline["bootId"], firmware)
        digest = payload_hash(central_receipt)
        if stored["receiptHash"] != digest or issued_record.get("lastReceiptHash") != digest:
            raise ValueError("Central receipt hash differs from the saved body")
        report.update(centralAckCode=central_receipt["ackCode"], centralReceiptSha256=digest)
        if central_receipt["status"] == "APPLIED":
            proof = inspect_integration_command(command, central_receipt, team_state)
            if proof is not None:
                report.update(proof, centralApplicationVerified=True)
    receipts = [receipt for receipt in (pi_receipt, native_receipt, central_receipt) if receipt is not None]
    if len({canonical(receipt) for receipt in receipts}) > 1:
        raise ValueError("Pi, CSE or central receipt bodies differ")
    if pi_receipt is not None:
        check_receipt(pi_receipt, command, baseline["bootId"], firmware)
    report.update(inspect_post_pulse(result, observation_file, event_file, command, baseline, native_receipt, team_state))
    report["postWakeApplicationVerified"] = (wake is not None and report["centralApplicationVerified"]
                                             and native_receipt is not None and native_receipt["ackCode"] == "APPLIED")
    if trace_path is not None:
        if native_receipt is None or native_receipt["status"] != "APPLIED" or native_receipt["ackCode"] != "APPLIED":
            raise ValueError("Pulse trace requires the original APPLIED CSE receipt")
        measurement = inspect_pulse_trace(trace_path, trace_metadata, command_id,
                                          report["cseResourceId"], report["cseReceiptSha256"])
        report.update(physicalPulseMeasured=measurement["measurementStatus"] == "measured", pulseTrace=measurement)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--team-state", type=Path, required=True)
    parser.add_argument("--database", type=Path, help="Read-only Pi SQLite copy from the scoped r18 session")
    parser.add_argument("--pulse-trace", type=Path, help="Operator-captured J6 motor load CSV")
    parser.add_argument("--pulse-trace-metadata", type=Path, help="Metadata binding the CSV to the original CSE receipt")
    parser.add_argument("--wake-report", type=Path, help="Original Pi wake report selected before the pulse")
    args = parser.parse_args()
    if (args.pulse_trace is None) != (args.pulse_trace_metadata is None):
        parser.error("--pulse-trace and --pulse-trace-metadata must be supplied together")
    try:
        trace_metadata = read_json(args.pulse_trace_metadata) if args.pulse_trace_metadata is not None else None
        report = inspect_pulse(args.output_directory, read_json(args.team_state), args.database,
                               trace_path=args.pulse_trace, trace_metadata=trace_metadata, wake_report=args.wake_report)
    except (AttributeError, KeyError, TypeError, OSError, ValueError, RuntimeError, sqlite3.Error, csv.Error) as error:
        parser.exit(1, f"r18 evidence could not be bound ({type(error).__name__}).\n")
    print(json.dumps(report, indent=2))
    if args.pulse_trace is not None and report["pulseTrace"].get("durationStatus") != "within-limit":
        raise SystemExit(1)
