"""Inspect interrupted r18 pulse artifacts without contacting the bench services."""

import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import sqlite3

from bubble_gateway.config import ID
from bubble_gateway.integration_evidence import (inspect_integration_command, match_integration_issuance,
                                                 require_integration_event)
from bubble_gateway.model import canonical, iso_time, parse_time, payload_hash
from pi_led_cycle import receipt_name, verify_observation_resource
from scoped_feather_evidence import (interrupted_pi_result, read_json, read_optional, read_pi_commands,
                                    validate_interrupted_receipt)
from scoped_r18_pulse import GATEWAY, PATHS, R18_COMMAND_FIRMWARE, R18_DEVICE


def check_receipt(receipt, command, boot_id):
    validate_interrupted_receipt(receipt, command, receipt["status"])
    if receipt["status"] == "APPLIED" and (receipt.get("bootId") != boot_id
                                           or receipt.get("firmwareRevision") != R18_COMMAND_FIRMWARE):
        raise ValueError("Applied receipt differs from the r18 baseline")


def inspect_pulse(directory, team_state, database=None):
    issued = team_state.get("gatewayCommands")
    stored_receipts = team_state.get("gatewayDeviceReceipts", {})
    if (not directory.is_dir() or not isinstance(issued, dict) or not isinstance(stored_receipts, dict)
            or not isinstance(team_state.get("receipts"), list)):
        raise ValueError("Expected an r18 output directory and an integration state snapshot")
    intent, issued_file, native_file, grant, revoked = (
        read_optional(directory / f"pulse-{suffix}.json")
        for suffix in ("intent", "issued", "receipt", "grant", "grant-revoked")
    )
    report = {"intentCaptured": intent is not None, "issuedResponseCaptured": issued_file is not None,
              "cseReceiptCaptured": native_file is not None, "grantRevocationCaptured": revoked is not None,
              "physicalPulseMeasured": None}
    if intent is None:
        if issued_file is not None or native_file is not None:
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
    verify_observation_resource(baseline, R18_DEVICE)
    parse_time(baseline["receivedAt"])

    parent = None
    if native_file is not None:
        resource = native_file["cseResource"]
        parent = resource["pi"]
        if (any(not isinstance(resource[key], str) or not ID.fullmatch(resource[key]) for key in ("ri", "pi"))
                or not re.fullmatch(r"[0-9]{8}T[0-9]{6}", resource["ct"])):
            raise ValueError("Invalid saved r18 CSE resource")
        datetime.strptime(resource["ct"], "%Y%m%dT%H%M%S")
        report.update(cseResourceId=resource["ri"], cseResourceCreated=resource["ct"])
    pi_row = None
    if database is not None:
        pi_row = read_pi_commands(database, gateway_id=GATEWAY, originator="Sscoped-r18-gateway-b",
                                  receipt_container=PATHS["receipt"], deployment_ids=("scoped-mobius4",),
                                  command_id=command_id, receipt_parent=parent).get(command_id)
    report.update(commandId=command_id, nativeRef=f"{PATHS['receipt']}/{intent['cseReceiptName']}",
                  deadline=iso_time(parse_time(request["deadline"])), issuanceInTeamSnapshot=command_id in issued,
                  piCommandState="MISSING" if database is not None else None,
                  centralReceiptCaptured=command_id in stored_receipts, centralApplicationVerified=False)
    if command_id not in issued:
        has_event = any(event.get("gatewayId") == GATEWAY and event.get("commandId") == command_id
                        and event.get("type") == "GATEWAY_COMMAND_ISSUED" for event in team_state["receipts"])
        if issued_file is not None or native_file is not None or pi_row is not None or command_id in stored_receipts or has_event:
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
        check_receipt(native_receipt, command, baseline["bootId"])
        report.update(cseAckCode=native_receipt["ackCode"], cseReceiptSha256=payload_hash(native_receipt))
    stored = stored_receipts.get(command_id)
    if command_id in stored_receipts and (not isinstance(stored, dict) or not isinstance(stored.get("receipt"), dict)):
        raise ValueError("Invalid saved central receipt")
    central_receipt = stored["receipt"] if stored is not None else None
    if central_receipt is not None:
        check_receipt(central_receipt, command, baseline["bootId"])
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
        check_receipt(pi_receipt, command, baseline["bootId"])
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--team-state", type=Path, required=True)
    parser.add_argument("--database", type=Path, help="Read-only Pi SQLite copy from the scoped r18 session")
    args = parser.parse_args()
    try:
        report = inspect_pulse(args.output_directory, read_json(args.team_state), args.database)
    except (AttributeError, KeyError, TypeError, OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        parser.exit(1, f"r18 evidence could not be bound ({type(error).__name__}).\n")
    print(json.dumps(report, indent=2))
