"""SQLite journals: local durability is separate from remote oneM2M delivery."""
from __future__ import annotations

import hashlib
import json
import random
import sqlite3
import time
from pathlib import Path

from .model import canonical, iso_time


class CapacityError(RuntimeError):
    pass


class Store:
    def __init__(self, path: Path, max_rows: int, max_bytes: int, max_commands: int):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
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
                receipt_delivered INTEGER NOT NULL DEFAULT 0
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
        """)

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

    def pending(self, limit: int = 16) -> list[dict]:
        rows = self.db.execute("SELECT payload,payload_hash FROM commands WHERE status='RECEIVED' ORDER BY received_at LIMIT ?", (limit,))
        return [{"command": json.loads(row["payload"]), "digest": row["payload_hash"]} for row in rows]

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

    def finish(self, command_id: str, receipt: dict) -> None:
        """Receipt remains in the command journal even if the outbox is full."""
        with self.db:
            self.db.execute("UPDATE commands SET status=?,receipt=? WHERE command_id=? AND receipt IS NULL",
                            (receipt["status"], canonical(receipt), command_id))

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

    def observation(self, container: str, payload: dict) -> bool:
        with self.db:
            previous = self.db.execute("SELECT boot_id,sequence FROM observations WHERE device_id=?", (payload["deviceId"],)).fetchone()
            if previous and previous["boot_id"] == payload["bootId"] and payload["sequence"] <= previous["sequence"]:
                return False
            identity = f"{payload['deviceId']}:{payload['bootId']}:{payload['sequence']}"
            self._enqueue(self.request_id("observation", identity), container, payload)
            self.db.execute("INSERT INTO observations(device_id,boot_id,sequence) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET boot_id=excluded.boot_id,sequence=excluded.sequence",
                            (payload["deviceId"], payload["bootId"], payload["sequence"]))
        return True

    def stage_receipts(self, container: str) -> None:
        rows = self.db.execute("SELECT command_id,receipt FROM commands WHERE receipt IS NOT NULL AND receipt_delivered=0 LIMIT 128").fetchall()
        for row in rows:
            try:
                with self.db:
                    self._enqueue(self.request_id("receipt", row["command_id"]), container,
                                  json.loads(row["receipt"]), True, row["command_id"])
            except CapacityError:
                break

    def due(self) -> dict | None:
        row = self.db.execute("SELECT * FROM outbox WHERE next_attempt<=? ORDER BY created_at,rqi LIMIT 1", (time.time(),)).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["payload"] = json.loads(result["payload"])
        return result

    def delivered(self, rqi: str) -> None:
        with self.db:
            row = self.db.execute("SELECT command_id FROM outbox WHERE rqi=?", (rqi,)).fetchone()
            if row and row["command_id"]:
                self.db.execute("UPDATE commands SET receipt_delivered=1 WHERE command_id=?", (row["command_id"],))
            self.db.execute("DELETE FROM outbox WHERE rqi=?", (rqi,))

    def retry(self, rqi: str, attempts: int) -> None:
        delay = min(300, 2 ** min(attempts + 1, 8)) * random.uniform(0.8, 1.2)
        with self.db:
            self.db.execute("UPDATE outbox SET attempts=attempts+1,next_attempt=? WHERE rqi=?", (time.time() + delay, rqi))

    def counts(self) -> tuple[int, int]:
        return (self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0],
                self.db.execute("SELECT COUNT(*) FROM commands").fetchone()[0])

    def close(self) -> None:
        self.db.close()
