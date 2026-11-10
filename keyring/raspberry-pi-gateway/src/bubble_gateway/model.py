"""Closed command contract and time/identity checks at the execution boundary."""
from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from typing import Any

from .config import ID

COMMAND_KEYS = frozenset({"version", "gatewayId", "deviceId", "commandId", "claimId",
                          "desiredState", "issuedAt", "deadline", "grantRevision", "ownershipEpoch"})
MAX_REVISION = 2147483647


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_time(value: datetime | None = None) -> str:
    return (value or utc_now()).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value: Any) -> datetime:
    if (not isinstance(value, str) or len(value) > 64
            or not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", value)
            or "T" not in value):
        raise ValueError("Expected timezone-qualified RFC3339 timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() is None:
        raise ValueError("Timestamp has no timezone")
    return parsed.astimezone(timezone.utc)


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def payload_hash(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def validate_command(raw: Any, gateway_id: str, devices: dict[str, str]) -> dict:
    if not isinstance(raw, dict) or set(raw) != COMMAND_KEYS:
        raise ValueError("Command fields do not match keyring-command schema")
    if type(raw["version"]) is not int or raw["version"] != 1:
        raise ValueError("Unsupported command version")
    for key in ("gatewayId", "deviceId", "commandId", "claimId"):
        if not isinstance(raw[key], str) or not ID.fullmatch(raw[key]):
            raise ValueError(f"Invalid {key}")
    if raw["gatewayId"] != gateway_id or raw["deviceId"] not in devices:
        raise ValueError("Command is not assigned to this gateway/device")
    desired = raw["desiredState"]
    if not isinstance(desired, dict) or set(desired) != {"state"} or type(desired["state"]) is not bool:
        raise ValueError("desiredState must contain a boolean state")
    for key, minimum in (("grantRevision", 1), ("ownershipEpoch", 0)):
        if type(raw[key]) is not int or not minimum <= raw[key] <= MAX_REVISION:
            raise ValueError(f"Invalid {key}")
    issued, deadline = parse_time(raw["issuedAt"]), parse_time(raw["deadline"])
    if deadline <= issued:
        raise ValueError("deadline must follow issuedAt")
    if len(canonical(raw).encode("utf-8")) > 4096:
        raise ValueError("Command exceeds wire limit")
    return dict(raw)


def authorization_deadline(command: dict, digest: str, response: Any) -> datetime:
    keys = {"allowed", "commandId", "deviceId", "claimId", "grantRevision", "ownershipEpoch", "payloadHash", "expiresAt"}
    if not isinstance(response, dict) or set(response) != keys or type(response.get("allowed")) is not bool:
        raise ValueError("Authorization response schema mismatch")
    if not response["allowed"]:
        raise PermissionError("Current grant disallows execution")
    for key in ("commandId", "deviceId", "claimId", "grantRevision", "ownershipEpoch"):
        if type(response[key]) is not type(command[key]) or response[key] != command[key]:
            raise PermissionError("Authorization binding mismatch")
    if response["payloadHash"] != digest:
        raise PermissionError("Authorization payload hash mismatch")
    return min(parse_time(response["expiresAt"]), parse_time(command["deadline"]))


def validate_observation(raw: Any, gateway_id: str, devices: dict[str, str]) -> dict:
    keys = {"version", "gatewayId", "deviceId", "bootId", "sequence", "observedAt", "receivedAt",
            "rssi", "battery", "buttonState", "sensorValues", "state", "firmwareRevision", "timestampSource"}
    if not isinstance(raw, dict) or set(raw) != keys or type(raw.get("version")) is not int or raw["version"] != 1:
        raise ValueError("Observation schema mismatch")
    if raw["gatewayId"] != gateway_id or raw["deviceId"] not in devices:
        raise ValueError("Unregistered observation source")
    if not isinstance(raw["bootId"], str) or not ID.fullmatch(raw["bootId"]):
        raise ValueError("Invalid boot identity")
    if type(raw["sequence"]) is not int or not 0 <= raw["sequence"] <= 4294967295:
        raise ValueError("Invalid observation sequence")
    parse_time(raw["observedAt"])
    parse_time(raw["receivedAt"])
    for key, minimum, maximum in (("battery", 0, 100), ("rssi", -127, 20)):
        value = raw[key]
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum):
            raise ValueError(f"Invalid {key}")
    if raw["rssi"] is not None and type(raw["rssi"]) is not int:
        raise ValueError("RSSI must be an integer or null")
    if raw["buttonState"] not in {"released", "confirm", "panic"} or type(raw["state"]) is not bool:
        raise ValueError("Invalid observation state")
    if not isinstance(raw["sensorValues"], dict) or len(raw["sensorValues"]) > 32:
        raise ValueError("Invalid sensor values")
    if any(not isinstance(key, str) or not 1 <= len(key) <= 64 for key in raw["sensorValues"]):
        raise ValueError("Invalid sensor name")
    if not isinstance(raw["firmwareRevision"], str) or not 1 <= len(raw["firmwareRevision"]) <= 64:
        raise ValueError("Invalid firmware revision")
    if raw["timestampSource"] != "gateway-received" or len(canonical(raw).encode("utf-8")) > 8192:
        raise ValueError("Invalid observation envelope")
    return raw
