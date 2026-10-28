"""Operator-only cold state archives and explicit legacy identity adoption.

No restore activation, credentials, service control, BLE or network calls.
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import os
import sqlite3
import time
import uuid
from contextlib import closing
from pathlib import Path

from .config import GatewayConfig, read_env_file
from .model import canonical, iso_time
from .state_identity import (StateIdentityError, configured_binding, counts, install,
                             legacy_ownership, match, metadata, quarantine_copy, readonly, tables)


def _new_file(path: Path, data: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data); handle.flush(); os.fsync(handle.fileno())


def _json_file(path: Path, value: dict) -> None:
    _new_file(path, (canonical(value) + "\n").encode("utf-8"))


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def archive(config: GatewayConfig, output: Path, *, adopt: bool, timeout: float) -> Path:
    """Caller holds the same lifetime lock as the daemon; source DB must exist."""
    expected = configured_binding(config)
    archive_id = str(uuid.uuid4())
    with closing(readonly(config.database)) as source:
        names = tables(source)
        record = metadata(source, names)
        if record is not None:
            match(record, expected)
        else:
            legacy_ownership(source, expected)
        source_version = source.execute("PRAGMA data_version").fetchone()[0]
        output.mkdir(mode=0o700, parents=False, exist_ok=False)
        target_path = output / "gateway.sqlite3"
        # Reserve a new private file before SQLite opens it; never overwrite an old archive.
        descriptor = os.open(target_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        deadline = time.monotonic() + timeout

        def progress(_status: int, _remaining: int, _total: int) -> None:
            if time.monotonic() >= deadline:
                raise TimeoutError("state archive copy deadline")

        with closing(sqlite3.connect(str(target_path), timeout=5)) as target:
            target.row_factory = sqlite3.Row
            # SQLite backup includes committed WAL state. Copying only the live .db would not.
            source.backup(target, pages=128, progress=progress, sleep=0.1)
            copied_record = metadata(target)
            if copied_record is not None:
                match(copied_record, expected)
            else:
                legacy_ownership(target, expected)
            target.execute("PRAGMA journal_mode=DELETE")
            target.execute("PRAGMA synchronous=FULL")
            with target:
                target.execute("BEGIN IMMEDIATE")
                quarantine_copy(target, expected, archive_id)
            captured_counts = counts(target)
            statuses = ({row["status"]: row["n"] for row in target.execute(
                "SELECT status,COUNT(*) AS n FROM commands GROUP BY status")}
                if "commands" in tables(target) else {})
        with target_path.open("rb+") as handle:
            os.fsync(handle.fileno())
        manifest = {
            "archiveVersion": 1, "archiveId": archive_id, "createdAt": iso_time(),
            "binding": expected, "bindingSha256": hashlib.sha256(canonical(expected).encode("utf-8")).hexdigest(),
            "sourceIdentityState": "bound" if copied_record is not None else "legacy-unbound",
            "dataRowsModified": False, "copyRecoveryState": "QUARANTINED",
            "activationStatus": "central-reconciliation-required", "settlementStatus": "not-settled",
            "containsPlaintextDeviceData": True, "credentialFilesIncluded": False,
            "tableCounts": captured_counts, "commandStatuses": statuses,
            "files": [{"path": "gateway.sqlite3", "bytes": target_path.stat().st_size,
                       "sha256": _file_digest(target_path)}],
        }
        manifest_path = output / "manifest.json"
        _json_file(manifest_path, manifest)
        _sync_directory(output)
        _sync_directory(output.parent)
        if adopt:
            # Keep this original DB; never activate the snapshot. Only add missing binding.
            with closing(sqlite3.connect(str(config.database), timeout=5)) as writer:
                writer.row_factory = sqlite3.Row
                writer.execute("PRAGMA trusted_schema=OFF")
                writer.execute("PRAGMA synchronous=FULL")
                with writer:
                    writer.execute("BEGIN IMMEDIATE")
                    if source.execute("PRAGMA data_version").fetchone()[0] != source_version:
                        raise StateIdentityError("STATE_CHANGED_DURING_ARCHIVE")
                    current = metadata(writer)
                    if current is None:
                        legacy_ownership(writer, expected)
                    else:
                        match(current, expected)
                    added = install(writer, expected, legacy=True)
            _json_file(output / "adoption.json", {
                "adoptionVersion": 1, "archiveId": archive_id, "completedAt": iso_time(),
                "bindingSha256": manifest["bindingSha256"], "bindingAdded": added,
                "dataRowsModified": False, "sourceRecoveryState": "LIVE",
            })
            _sync_directory(output)
        return manifest_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Cold Gateway state snapshot / explicit legacy identity adoption")
    parser.add_argument("operation", choices=("snapshot", "adopt"))
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="new private archive directory; parent must exist")
    parser.add_argument("--timeout", type=float, default=120, help="SQLite copy deadline in seconds, 5..3600")
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("this operator command requires POSIX owner-only files and advisory locking")
    if not 5 <= args.timeout <= 3600:
        parser.error("timeout must be between 5 and 3600 seconds")
    if args.output.exists() or args.output.is_symlink() or not args.output.parent.is_dir():
        parser.error("output must be a new directory under an existing parent")
    os.umask(0o077)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")
    try:
        import fcntl
        read_env_file(args.env_file)
        config = GatewayConfig.from_env()
        if not config.database.is_file():
            raise StateIdentityError("STATE_DATABASE_MISSING")
        with config.database.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            path = archive(config, args.output, adopt=args.operation == "adopt", timeout=args.timeout)
        print(f"Gateway state archive created: {path}; copy quarantined; not settled")
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except StateIdentityError as exc:
        logging.getLogger(__name__).error("State operation stopped: %s", str(exc))
        raise SystemExit(1) from None
    except Exception as exc:
        logging.getLogger(__name__).error("State operation stopped: %s; any output retained", type(exc).__name__)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
