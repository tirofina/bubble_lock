"""Projection for the CORE v1 gateway contract; never invent missing measurements/grants."""
from __future__ import annotations

from .model import validate_command

CORE_SERVICE = "7f8a0001-4b6e-4f4e-9b0a-505249564255"
CORE_OBSERVATION = "7f8a0002-4b6e-4f4e-9b0a-505249564255"
CORE_COMMAND = "7f8a0003-4b6e-4f4e-9b0a-505249564255"
CORE_RECEIPT = "7f8a0004-4b6e-4f4e-9b0a-505249564255"
CORE_IDENTITY = "7f8a0005-4b6e-4f4e-9b0a-505249564255"  # KEYRING extension


def measurable(observation: dict) -> bool:
    return (observation["battery"] is not None and type(observation["rssi"]) is int)


def telemetry(observation: dict, wire_sequence: int) -> dict:
    if not measurable(observation):
        raise ValueError("CORE v1 requires real battery and RSSI; no null sentinel exists")
    return {
        "deviceId": observation["deviceId"], "sequence": wire_sequence,
        "timestamp": observation["observedAt"], "state": observation["state"],
        "batteryPct": int(round(observation["battery"])), "rssiDbm": observation["rssi"],
        "schemaVersion": "1.0.0", "bootId": observation["bootId"],
        "firmwareSequence": observation["sequence"], "gatewayId": observation["gatewayId"],
        "timestampSource": observation["timestampSource"],
    }


def acknowledgement(receipt: dict) -> dict | None:
    # CORE currently drops pendingCommands for every ackState. Publish only a
    # confirmed success here; rejected/uncertain results stay in the richer cin journal.
    if receipt["status"] != "APPLIED" or receipt["ackCode"] not in {"APPLIED", "DUPLICATE"}:
        return None
    return {
        "deviceId": receipt["deviceId"], "commandId": receipt["commandId"],
        "ackState": "READBACK_VERIFIED", "timestamp": receipt["receivedAt"],
        "readback": receipt["readback"], "payloadHash": receipt["payloadHash"],
        "grantRevision": receipt["grantRevision"], "ownershipEpoch": receipt["ownershipEpoch"],
        "measurementScope": "gpio-at-application", "gatewayReceipt": receipt,
    }


def command(raw: dict, gateway_id: str, devices: dict[str, str]) -> dict:
    """Accept canonical commands or CORE aliases ONLY with all authorization fields."""
    if not isinstance(raw, dict):
        raise ValueError("Command must be an object")
    if "version" in raw:
        return validate_command(raw, gateway_id, devices)
    required = {"deviceId", "commandId", "desiredState", "deadline", "epoch", "issuedAt", "claimId", "grantRevision"}
    if set(raw) != required or type(raw.get("desiredState")) is not bool:
        raise ValueError("CORE command lacks claimId/grantRevision or has unsupported fields")
    return validate_command({
        "version": 1, "gatewayId": gateway_id, "deviceId": raw["deviceId"],
        "commandId": raw["commandId"], "claimId": raw["claimId"],
        "desiredState": {"state": raw["desiredState"]}, "deadline": raw["deadline"],
        "issuedAt": raw["issuedAt"], "ownershipEpoch": raw["epoch"], "grantRevision": raw["grantRevision"],
    }, gateway_id, devices)
