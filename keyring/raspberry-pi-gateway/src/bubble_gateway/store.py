"""SQLite journals: local durability is separate from remote oneM2M delivery."""
from __future__ import annotations

import hashlib
import json
import random
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

from .model import canonical, central_observation_id, iso_time
from .core_bridge import telemetry, measurable, acknowledgement
from .state_identity import preflight, install

MAX_PENDING_CREDENTIAL_RECEIPTS = 1024
RETAIN_DELIVERED_CREDENTIAL_RECEIPTS = 128


class CapacityError(RuntimeError):
    pass


class Store:
    def __init__(self, path: Path, max_rows: int, max_bytes: int, max_commands: int, binding: dict):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        preflight(path, binding)
        self.db = sqlite3.connect(str(path), timeout=10)
        self.db.row_factory = sqlite3.Row
        self.max_rows, self.max_bytes, self.max_commands = max_rows, max_bytes, max_commands
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA busy_timeout=10000")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS commands (
                command_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
                payload TEXT NOT NULL, status TEXT NOT NULL,
                received_at TEXT NOT NULL, receipt TEXT,
                receipt_delivered INTEGER NOT NULL DEFAULT 0,
                central_receipt_staged INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS fences (
                device_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, revision INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS observations (
                device_id TEXT PRIMARY KEY, boot_id TEXT NOT NULL, sequence INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS outbox (
                rqi TEXT PRIMARY KEY, container TEXT NOT NULL, payload TEXT NOT NULL,
                payload_bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
                command_id TEXT
            );
            CREATE INDEX IF NOT EXISTS outbox_due ON outbox(next_attempt, created_at);
            CREATE INDEX IF NOT EXISTS outbox_core_pending ON outbox(container) WHERE container='@core/telemetry';
            CREATE INDEX IF NOT EXISTS outbox_central_pending ON outbox(container) WHERE container='@central/telemetry';
            CREATE INDEX IF NOT EXISTS outbox_native_receipt ON outbox(command_id) WHERE command_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS commands_pending_receipt ON commands(receipt_delivered)
                WHERE receipt IS NOT NULL AND receipt_delivered=0;
            CREATE TABLE IF NOT EXISTS core_sequences (
                device_id TEXT PRIMARY KEY, wire_sequence INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS credential_receipts (
                sequence INTEGER PRIMARY KEY, rqi TEXT NOT NULL UNIQUE,
                payload TEXT NOT NULL, delivered_at TEXT
            );
        """)
        try:
            with self.db:
                self.db.execute("BEGIN IMMEDIATE")
                install(self.db, binding)
                columns = {row["name"] for row in self.db.execute("PRAGMA table_info(commands)")}
                if "central_receipt_staged" not in columns:
                    self.db.execute("ALTER TABLE commands ADD COLUMN central_receipt_staged INTEGER NOT NULL DEFAULT 0")
                self.db.execute("""
                    CREATE INDEX IF NOT EXISTS commands_pending_central_receipt ON commands(central_receipt_staged)
                    WHERE receipt IS NOT NULL AND central_receipt_staged=0
                """)
        except Exception:
            self.db.close()
            raise
        self._health_container = binding["healthContainer"]

    @staticmethod
    def request_id(kind: str, identity: str) -> str:
        return "kr-" + hashlib.sha256(f"{kind}:{identity}".encode("utf-8")).hexdigest()[:48]

    def accept(self, command: dict, digest: str) -> str:
        """Never replace a journal entry for an existing commandId."""
        with self.db:
            existing = self.db.execute("SELECT payload_hash FROM commands WHERE command_id=?", (command["commandId"],)).fetchone()
            if existing:
                return "DUPLICATE" if existing["payload_hash"] == digest else "CONFLICT"
            count = self.db.execute("SELECT COUNT(*) FROM commands").fetchone()[0]
            if count >= self.max_commands:
                raise CapacityError("Command journal full; explicit archival/reprovisioning required")
            self.db.execute("INSERT INTO commands(command_id,payload_hash,payload,status,received_at) VALUES(?,?,?,'RECEIVED',?)",
                            (command["commandId"], digest, canonical(command), iso_time()))
        return "NEW"

    def pending(self, limit: int = 16, *, after_rowid: int = 0,
                through_rowid: int = 2**63 - 1) -> list[dict]:
        rows = self.db.execute(
            "SELECT rowid,payload,payload_hash FROM commands WHERE status='RECEIVED' AND rowid>? AND rowid<=? "
            "ORDER BY rowid LIMIT ?", (after_rowid, through_rowid, limit))
        return [{"command": json.loads(row["payload"]), "digest": row["payload_hash"], "rowid": row["rowid"]}
                for row in rows]

    def command_high_water(self) -> int:
        return self.db.execute("SELECT COALESCE(MAX(rowid),0) FROM commands").fetchone()[0]

    def interrupted(self) -> list[dict]:
        rows = self.db.execute("SELECT payload,payload_hash FROM commands WHERE status='DISPATCHING'")
        return [{"command": json.loads(row["payload"]), "digest": row["payload_hash"]} for row in rows]

    def begin_dispatch(self, command: dict) -> str | None:
        """Persist execution intent and accepted ownership fence before BLE writes."""
        with self.db:
            fence = self.db.execute("SELECT epoch,revision FROM fences WHERE device_id=?", (command["deviceId"],)).fetchone()
            if fence:
                if command["ownershipEpoch"] < fence["epoch"]:
                    return "STALE_EPOCH"
                if command["grantRevision"] < fence["revision"]:
                    return "STALE_GRANT"
            changed = self.db.execute("UPDATE commands SET status='DISPATCHING' WHERE command_id=? AND status='RECEIVED'",
                                      (command["commandId"],)).rowcount
            if changed != 1:
                return "ALREADY_DISPATCHED"
            self.db.execute("INSERT INTO fences(device_id,epoch,revision) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET epoch=excluded.epoch,revision=excluded.revision",
                            (command["deviceId"], command["ownershipEpoch"], command["grantRevision"]))
        return None

    def finish(self, command_id: str, receipt: dict) -> bool:
        """Receipt remains in the command journal even if the outbox is full."""
        with self.db:
            result = self.db.execute("UPDATE commands SET status=?,receipt=? WHERE command_id=? AND receipt IS NULL",
                                     (receipt["status"], canonical(receipt), command_id))
        return result.rowcount == 1

    def _enqueue(self, rqi: str, container: str, payload: dict, critical: bool = False, command_id: str | None = None) -> bool:
        if self.db.execute("SELECT 1 FROM outbox WHERE rqi=?", (rqi,)).fetchone():
            return False
        encoded = canonical(payload)
        size = len(encoded.encode("utf-8"))
        count, total = self.db.execute("SELECT COUNT(*),COALESCE(SUM(payload_bytes),0) FROM outbox").fetchone()
        fraction = 1 if critical else 0.9
        if count >= int(self.max_rows * fraction) or total + size > int(self.max_bytes * fraction):
            raise CapacityError("Outbox capacity exceeded")
        self.db.execute("INSERT INTO outbox(rqi,container,payload,payload_bytes,created_at,command_id) VALUES(?,?,?,?,?,?)",
                        (rqi, container, encoded, size, iso_time(), command_id))
        return True

    def enqueue(self, kind: str, identity: str, container: str, payload: dict, critical: bool = False) -> None:
        with self.db:
            self._enqueue(self.request_id(kind, identity), container, payload, critical)

    def enqueue_heartbeat(self, payload: dict) -> bool:
        """Keep one unresolved periodic health snapshot without changing its request body."""
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            pending = self.db.execute("""
                SELECT 1 FROM outbox WHERE container=? AND command_id IS NULL
                  AND CASE WHEN json_valid(payload) THEN
                      json_type(payload, '$.uptimeSeconds')='integer'
                      AND json_type(payload, '$.outboxDepth')='integer'
                      AND json_type(payload, '$.credentialTransition') IS NULL
                  ELSE 0 END
                LIMIT 1
            """, (self._health_container,)).fetchone()
            if pending is not None:
                return False
            identity = f"{payload['bootId']}:{payload['observedAt']}"
            return self._enqueue(self.request_id("health", identity), self._health_container, payload)

    def record_credential_status(self, current: dict, health_snapshot: Callable[[], dict]) -> bool:
        """Record an authenticated central status before relying on it locally."""
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            last = self.db.execute("SELECT sequence,payload FROM credential_receipts ORDER BY sequence DESC LIMIT 1").fetchone()
            previous = json.loads(last["payload"])["credentialTransition"]["current"] if last else None
            if current == previous:
                return False
            count = self.db.execute("SELECT COUNT(*) FROM credential_receipts WHERE delivered_at IS NULL").fetchone()[0]
            if count >= MAX_PENDING_CREDENTIAL_RECEIPTS:
                raise CapacityError("Credential receipt journal full")
            sequence = last["sequence"] + 1 if last else 1
            payload = health_snapshot() | {
                "credentialTransition": {"sequence": sequence, "previous": previous, "current": current},
            }
            rqi = self.request_id("credential-transition", f"{payload['bootId']}:{sequence}")
            self.db.execute("INSERT INTO credential_receipts(sequence,rqi,payload) VALUES(?,?,?)",
                            (sequence, rqi, canonical(payload)))
        return True

    def stage_credential_receipt(self) -> None:
        """Keep later transitions behind the oldest unconfirmed transition."""
        row = self.db.execute("SELECT rqi,payload FROM credential_receipts "
                              "WHERE delivered_at IS NULL ORDER BY sequence LIMIT 1").fetchone()
        if row is not None:
            try:
                with self.db:
                    self._enqueue(row["rqi"], self._health_container, json.loads(row["payload"]))
            except CapacityError:
                pass  # Still in the independent journal; retry after outbox space opens.

    def observation(self, container: str, payload: dict, core_enabled: bool = False, *,
                    core_epochs: dict[str, int] | None = None, central_enabled: bool = False) -> bool:
        with self.db:
            previous = self.db.execute("SELECT boot_id,sequence FROM observations WHERE device_id=?", (payload["deviceId"],)).fetchone()
            if previous and previous["boot_id"] == payload["bootId"] and payload["sequence"] <= previous["sequence"]:
                return False
            identity = f"{payload['deviceId']}:{payload['bootId']}:{payload['sequence']}"
            self._enqueue(self.request_id("observation", identity), container, payload)
            if core_enabled and (core_epochs is not None or measurable(payload)):
                previous_core = self.db.execute("SELECT wire_sequence FROM core_sequences WHERE device_id=?", (payload["deviceId"],)).fetchone()
                wire_sequence = previous_core["wire_sequence"] + 1 if previous_core else 0
                if wire_sequence > 4294967295:
                    raise CapacityError("CORE uint32 sequence exhausted; explicit device identity rotation required")
                projection = telemetry(payload, wire_sequence, scoped=core_epochs is not None)
                if core_epochs is not None:
                    projection["ownershipEpoch"] = core_epochs[payload["deviceId"]]
                self._enqueue(self.request_id("core-telemetry", identity), "@core/telemetry", projection)
                self.db.execute("INSERT INTO core_sequences(device_id,wire_sequence) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET wire_sequence=excluded.wire_sequence",
                                (payload["deviceId"], wire_sequence))
            if central_enabled:
                rqi = self.request_id("central-telemetry", central_observation_id(payload))
                self._enqueue(rqi, "@central/telemetry", payload)
            self.db.execute("INSERT INTO observations(device_id,boot_id,sequence) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET boot_id=excluded.boot_id,sequence=excluded.sequence",
                            (payload["deviceId"], payload["bootId"], payload["sequence"]))
        return True

    def observation_heads(self) -> dict[str, tuple[str, int]]:
        return {row["device_id"]: (row["boot_id"], row["sequence"])
                for row in self.db.execute("SELECT device_id,boot_id,sequence FROM observations")}

    def stage_receipts(self, container: str, core_enabled: bool = False) -> None:
        """Stage the native receipt and its optional CORE ACK in one transaction."""
        # Already staged native receipts can remain undelivered during backoff.
        # They must not consume slots in the batch of receipts that still need staging.
        rows = self.db.execute("""
            SELECT command_id,receipt FROM commands
            WHERE receipt IS NOT NULL AND receipt_delivered=0
              AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.command_id=commands.command_id)
            ORDER BY commands.rowid LIMIT 128
        """).fetchall()
        for row in rows:
            try:
                with self.db:
                    receipt = json.loads(row["receipt"])
                    command_id = row["command_id"]
                    created = self._enqueue(self.request_id("receipt", command_id), container,
                                            receipt, True, command_id)
                    # The retained native row (then receipt_delivered after its
                    # confirmation) is the durable staging marker. Recreating a
                    # completed ACK here would bypass the native retry backoff.
                    if created and core_enabled:
                        projected = acknowledgement(receipt)
                        if projected is not None:
                            self._enqueue(self.request_id("core-ack", command_id), "@core/ack", projected, True)
            except CapacityError:
                break

    def stage_central_receipts(self) -> None:
        """Stage the central route and its durable marker together."""
        rows = self.db.execute("""
            SELECT command_id,receipt FROM commands
            WHERE receipt IS NOT NULL AND central_receipt_staged=0
            ORDER BY commands.rowid LIMIT 128
        """).fetchall()
        for row in rows:
            try:
                with self.db:
                    command_id = row["command_id"]
                    self._enqueue(self.request_id("central-receipt", command_id), "@central/receipt",
                                  json.loads(row["receipt"]), True)
                    self.db.execute("UPDATE commands SET central_receipt_staged=1 WHERE command_id=?", (command_id,))
            except CapacityError:
                break

    def central_receipt_claim(self, receipt: dict) -> str:
        row = self.db.execute("SELECT payload,receipt FROM commands WHERE command_id=?",
                              (receipt["commandId"],)).fetchone()
        if row is None or row["receipt"] != canonical(receipt):
            raise ValueError("Central receipt does not match the local command journal")
        return json.loads(row["payload"])["claimId"]

    def due(self, *, core_epochs: dict[str, int] | None = None, scoped_only: bool = False,
            prefer_receipts: bool | None = None, skip_native: bool = False,
            held_receipt_container: str | None = None, hold_credential_receipts: bool = False,
            held_observation_container: str | None = None) -> dict | None:
        # Old ownership routes stay on disk and cannot block the active route.
        # Within the active route, only the oldest projection per device can run.
        epochs = canonical(core_epochs) if core_epochs is not None else None
        row = self.db.execute("""
            WITH core_rows AS (
                SELECT rowid, CASE WHEN json_valid(payload) THEN payload ELSE '{}' END AS message
                FROM outbox WHERE container='@core/telemetry'
            ), core_heads AS (
                SELECT MIN(rowid) AS head FROM core_rows
                WHERE CASE WHEN ?1 IS NULL THEN json_type(message, '$.ownershipEpoch') IS NULL
                    ELSE json_type(message, '$.ownershipEpoch') = 'integer' AND EXISTS (
                       SELECT 1 FROM json_each(?1) AS assignment
                       WHERE assignment.key = json_extract(message, '$.deviceId')
                         AND assignment.value = json_extract(message, '$.ownershipEpoch')
                    ) END
                GROUP BY json_extract(message, '$.deviceId')
            )
            SELECT *, (command_id IS NOT NULL OR container='@core/ack') AS is_receipt
            FROM outbox WHERE next_attempt<=?2
              AND (container<>'@core/telemetry' OR rowid IN (SELECT head FROM core_heads))
              AND container NOT IN ('@central/telemetry', '@central/receipt')
              AND (?3=0 OR container='@core/telemetry')
              AND (?5=0 OR container IN ('@core/ack', '@core/telemetry'))
              AND (?6 IS NULL OR container<>?6)
              AND (?7=0 OR NOT EXISTS (SELECT 1 FROM credential_receipts AS credentials WHERE credentials.rqi=outbox.rqi))
              AND (?8 IS NULL OR container<>?8)
            ORDER BY CASE WHEN is_receipt=?4 THEN 0 ELSE 1 END, created_at,rqi LIMIT 1
        """, (epochs, time.time(), scoped_only, prefer_receipts, skip_native,
              held_receipt_container, hold_credential_receipts, held_observation_container)).fetchone()
        return self._outbox_row(row)

    def due_central_receipt(self) -> dict | None:
        row = self.db.execute("""
            SELECT * FROM outbox WHERE container='@central/receipt' AND next_attempt<=?
            ORDER BY created_at,rqi LIMIT 1
        """, (time.time(),)).fetchone()
        return self._outbox_row(row)

    def due_central_telemetry(self) -> dict | None:
        # Include deferred heads so a retry cannot reorder a device's observations.
        row = self.db.execute("""
            SELECT * FROM outbox WHERE next_attempt<=? AND rowid IN (
                SELECT MIN(rowid) FROM outbox WHERE container='@central/telemetry'
                GROUP BY CASE WHEN json_valid(payload) THEN json_extract(payload, '$.deviceId') END
            ) ORDER BY created_at,rqi LIMIT 1
        """, (time.time(),)).fetchone()
        return self._outbox_row(row)

    def expire_central_telemetry(self, before: datetime, limit: int) -> int:
        """Release expired central copies independently of their retry eligibility."""
        with self.db:
            return self.db.execute("""
                DELETE FROM outbox WHERE rowid IN (
                    SELECT rowid FROM outbox WHERE container='@central/telemetry'
                      AND julianday(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.observedAt') END)
                          < julianday(?)
                    ORDER BY rowid LIMIT ?
                )
            """, (iso_time(before), limit)).rowcount

    @staticmethod
    def _outbox_row(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        result = dict(row)
        result["payload"] = json.loads(result["payload"])
        return result

    def delivered(self, rqi: str) -> None:
        with self.db:
            row = self.db.execute("SELECT command_id FROM outbox WHERE rqi=?", (rqi,)).fetchone()
            if row:
                if row["command_id"]:
                    self.db.execute("UPDATE commands SET receipt_delivered=1 WHERE command_id=?", (row["command_id"],))
                elif self.db.execute("UPDATE credential_receipts SET delivered_at=? "
                                     "WHERE rqi=? AND delivered_at IS NULL", (iso_time(), rqi)).rowcount:
                    self.db.execute("""
                        DELETE FROM credential_receipts WHERE delivered_at IS NOT NULL AND sequence NOT IN (
                            SELECT sequence FROM credential_receipts WHERE delivered_at IS NOT NULL
                            ORDER BY sequence DESC LIMIT ?
                        )
                    """, (RETAIN_DELIVERED_CREDENTIAL_RECEIPTS,))
            self.db.execute("DELETE FROM outbox WHERE rqi=?", (rqi,))

    def mark_receipt_attempt(self, rqi: str) -> None:
        """Persist the first send attempt before the CSE can create the receipt."""
        with self.db:
            self.db.execute("UPDATE outbox SET attempts=1 WHERE rqi=? AND command_id IS NOT NULL AND attempts=0",
                            (rqi,))

    def retry(self, rqi: str, attempts: int, *, minimum_delay: float = 0.0) -> None:
        delay = min(300, 2 ** min(attempts + 1, 8)) * random.uniform(0.8, 1.2)
        with self.db:
            self.db.execute("UPDATE outbox SET attempts=attempts+1,next_attempt=? WHERE rqi=?",
                            (time.time() + max(delay, minimum_delay), rqi))

    def counts(self) -> tuple[int, int]:
        return (self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0],
                self.db.execute("SELECT COUNT(*) FROM commands").fetchone()[0])

    def close(self) -> None:
        self.db.close()
