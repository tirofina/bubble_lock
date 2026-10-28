"""Bind local durable state to its configured Gateway/CSE resource identity.

This is a local consistency boundary, not proof of a central grant or a restore lease.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from .model import canonical, iso_time, payload_hash
from .config import ID

DATA_TABLES = ("commands", "fences", "observations", "outbox", "core_sequences")
META = "gateway_state"
BINDING_KEYS = {"bindingVersion", "gatewayId", "originator", "cseId", "rvi",
                "observationContainer", "receiptContainer", "healthContainer"}


class StateIdentityError(RuntimeError):
    """A fixed error code; never includes raw payloads or credentials."""


def configured_binding(config: Any) -> dict[str, Any]:
    # Addresses and certificate paths can change without rewriting stored resource identities.
    return {
        "bindingVersion": 1, "gatewayId": config.gateway_id, "originator": config.originator,
        "cseId": config.cse_id, "rvi": config.rvi,
        "observationContainer": config.observation_container,
        "receiptContainer": config.receipt_container, "healthContainer": config.health_container,
    }


def readonly(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("PRAGMA trusted_schema=OFF")
    return db


def tables(db: sqlite3.Connection) -> set[str]:
    objects = list(db.execute("SELECT name,type FROM sqlite_master WHERE substr(name,1,7) <> 'sqlite_'"))
    if any(row["type"] in {"view", "trigger"} for row in objects):
        raise StateIdentityError("STATE_UNSUPPORTED_SCHEMA")
    names = {row["name"] for row in objects if row["type"] == "table"}
    if names - set(DATA_TABLES) - {META}:
        raise StateIdentityError("STATE_UNSUPPORTED_SCHEMA")
    return names


def metadata(db: sqlite3.Connection, names: set[str] | None = None) -> dict | None:
    if META not in (tables(db) if names is None else names):
        return None
    rows = list(db.execute("SELECT id,format,binding,recovery_state,archive_id,created_at FROM gateway_state"))
    if len(rows) != 1 or rows[0]["id"] != 1 or rows[0]["format"] != 1:
        raise StateIdentityError("STATE_INVALID_IDENTITY")
    row = dict(rows[0])
    try:
        binding = json.loads(row["binding"])
    except (ValueError, TypeError, RecursionError):
        raise StateIdentityError("STATE_INVALID_IDENTITY") from None
    if (not isinstance(binding, dict) or set(binding) != BINDING_KEYS
            or type(binding["bindingVersion"]) is not int or binding["bindingVersion"] != 1
            or any(not isinstance(binding[key], str) or not binding[key] for key in BINDING_KEYS - {"bindingVersion"})
            or row["recovery_state"] not in {"LIVE", "QUARANTINED"}):
        raise StateIdentityError("STATE_INVALID_IDENTITY")
    row["binding"] = binding
    return row


def counts(db: sqlite3.Connection, names: set[str] | None = None) -> dict[str, int]:
    names = tables(db) if names is None else names
    # Identifiers come exclusively from this fixed allowlist, never from caller input.
    return {name: db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0] if name in names else 0
            for name in DATA_TABLES}


def match(record: dict, expected: dict, *, require_live: bool = True) -> None:
    if canonical(record["binding"]) != canonical(expected):
        raise StateIdentityError("STATE_IDENTITY_MISMATCH")
    if require_live and record["recovery_state"] != "LIVE":
        raise StateIdentityError("STATE_RECOVERY_QUARANTINED")


def preflight(path: Path, expected: dict) -> None:
    """Caller holds the daemon's lifetime lock. Refuse before RW/WAL/schema setup."""
    if not path.exists():
        return
    with closing(readonly(path)) as db:
        names = tables(db)
        record = metadata(db, names)
        if record is not None:
            match(record, expected)
            if not set(DATA_TABLES) <= names:
                raise StateIdentityError("STATE_INCOMPLETE_SCHEMA")
        elif any(counts(db, names).values()):
            raise StateIdentityError("STATE_LEGACY_ADOPTION_REQUIRED")


def install(db: sqlite3.Connection, expected: dict, *, legacy: bool = False) -> bool:
    record = metadata(db)
    if record is not None:
        match(record, expected)
        return False
    if not legacy and any(counts(db).values()):
        raise StateIdentityError("STATE_LEGACY_ADOPTION_REQUIRED")
    if legacy:
        # The optional CORE projection table did not exist in the earliest daemon.
        db.execute("CREATE TABLE IF NOT EXISTS core_sequences (device_id TEXT PRIMARY KEY, wire_sequence INTEGER NOT NULL)")
    _write(db, expected, "LIVE", None)
    return True


def _write(db: sqlite3.Connection, expected: dict, state: str, archive_id: str | None) -> None:
    if not db.in_transaction:
        raise StateIdentityError("STATE_WRITE_TRANSACTION_REQUIRED")
    db.execute("""CREATE TABLE IF NOT EXISTS gateway_state (
        id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL,
        binding TEXT NOT NULL, recovery_state TEXT NOT NULL,
        archive_id TEXT, created_at TEXT NOT NULL
    )""")
    db.execute("INSERT OR REPLACE INTO gateway_state VALUES(1,1,?,?,?,?)",
               (canonical(expected), state, archive_id, iso_time()))


def quarantine_copy(db: sqlite3.Connection, expected: dict, archive_id: str) -> None:
    """Only for a newly created archive target; never call on the live state DB."""
    _write(db, expected, "QUARANTINED", archive_id)


def legacy_ownership(db: sqlite3.Connection, expected: dict) -> None:
    """Check retained records before explicit adoption; not CSE authentication."""
    names = tables(db)
    if not {"commands", "fences", "observations", "outbox"} <= names:
        raise StateIdentityError("STATE_INCOMPLETE_SCHEMA")
    for name in ("fences", "observations", "core_sequences"):
        if name in names:
            for row in db.execute(f"SELECT device_id FROM {name}"):
                if not isinstance(row["device_id"], str) or ID.fullmatch(row["device_id"]) is None:
                    raise StateIdentityError("STATE_LEGACY_DEVICE_MISMATCH")
    if "commands" in names:
        for row in db.execute("SELECT command_id,payload_hash,payload,receipt FROM commands"):
            command = json.loads(row["payload"])
            if (not isinstance(command, dict) or command.get("gatewayId") != expected["gatewayId"]
                    or not isinstance(command.get("deviceId"), str) or ID.fullmatch(command["deviceId"]) is None
                    or command.get("commandId") != row["command_id"]
                    or payload_hash(command) != row["payload_hash"]):
                raise StateIdentityError("STATE_LEGACY_COMMAND_MISMATCH")
            if row["receipt"] is not None:
                receipt = json.loads(row["receipt"])
                if (not isinstance(receipt, dict) or receipt.get("gatewayId") != expected["gatewayId"]
                        or receipt.get("commandId") != row["command_id"]
                        or receipt.get("payloadHash") != row["payload_hash"]):
                    raise StateIdentityError("STATE_LEGACY_RECEIPT_MISMATCH")
    if "outbox" in names:
        allowed = {expected[k] for k in ("observationContainer", "receiptContainer", "healthContainer")}
        allowed |= {"@core/telemetry", "@core/ack"}
        for row in db.execute("SELECT container,payload FROM outbox"):
            payload = json.loads(row["payload"])
            if row["container"] not in allowed or not isinstance(payload, dict):
                raise StateIdentityError("STATE_LEGACY_ROUTE_MISMATCH")
            if payload.get("gatewayId") == expected["gatewayId"]:
                continue
            # CORE ACK lacks gatewayId; require its original assigned command.
            command_id = payload.get("commandId")
            if (row["container"] != "@core/ack" or "gatewayId" in payload or "commands" not in names
                    or not isinstance(command_id, str)
                    or db.execute("SELECT 1 FROM commands WHERE command_id=?", (command_id,)).fetchone() is None):
                raise StateIdentityError("STATE_LEGACY_OUTBOX_MISMATCH")
