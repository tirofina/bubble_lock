"""Operator-only cold archives, explicit identity adoption and retired CORE cleanup.

No restore activation, credentials, service control, BLE or network calls.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sqlite3
import time
import uuid
from contextlib import closing
from pathlib import Path

from .config import GatewayConfig, ID, env_file_values, read_env_file
from .core_bridge import SCOPED_NULLABLE_TELEMETRY
from .model import canonical, iso_time
from .state_cutover import cutover_plan
from .state_identity import (StateIdentityError, configured_binding, counts, install,
                             legacy_ownership, match, metadata, quarantine_copy, readonly, tables)
from .store import Store


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


_RETIRED_CORE_SCOPE = """container='@core/telemetry' AND CASE WHEN json_valid(payload) THEN
    json_extract(payload, '$.deviceId')=?1 AND CASE
        WHEN ?2 IS NULL THEN json_type(payload, '$.ownershipEpoch') IS NULL
        ELSE json_type(payload, '$.ownershipEpoch')='integer' AND json_extract(payload, '$.ownershipEpoch')=?2
    END ELSE 0 END"""


def _retired_core_fingerprint(db: sqlite3.Connection, gateway: str, device: str, epoch: int | None) -> tuple[int, str]:
    count = 0
    digest = hashlib.sha256()
    supported_versions = ("1.0.0", SCOPED_NULLABLE_TELEMETRY) if epoch is not None else ("1.0.0",)
    for row in db.execute(f"SELECT * FROM outbox WHERE {_RETIRED_CORE_SCOPE} ORDER BY rqi", (device, epoch)):
        payload = json.loads(row["payload"])
        if not isinstance(payload, dict) or payload.get("deviceId") != device:
            raise StateIdentityError("STATE_RETIRED_CORE_BINDING_INVALID")
        boot_id, sequence = payload.get("bootId"), payload.get("firmwareSequence")
        if (payload.get("gatewayId") != gateway or payload.get("schemaVersion") not in supported_versions
                or not isinstance(boot_id, str) or ID.fullmatch(boot_id) is None
                or type(sequence) is not int or not 0 <= sequence <= 4294967295
                or row["command_id"] is not None or canonical(payload) != row["payload"]
                or len(row["payload"].encode("utf-8")) != row["payload_bytes"]):
            raise StateIdentityError("STATE_RETIRED_CORE_BINDING_INVALID")
        if row["rqi"] != Store.request_id("core-telemetry", f"{device}:{boot_id}:{sequence}"):
            raise StateIdentityError("STATE_RETIRED_CORE_BINDING_INVALID")
        digest.update((canonical(dict(row)) + "\n").encode("utf-8"))
        count += 1
    return count, digest.hexdigest()


def retire_core(config: GatewayConfig, output: Path, *, device: str, epoch: int | None, timeout: float) -> Path:
    """Caller holds the daemon lifetime lock. Save a full archive before removing an obsolete scope."""
    expected = configured_binding(config)
    active = (config.core_telemetry_epochs or {}).get(device)
    if (not config.core_bridge_enabled or not ID.fullmatch(device) or active is None
            or (epoch is not None and (type(epoch) is not int or not 0 <= epoch < active))):
        raise StateIdentityError("STATE_RETIRED_CORE_SCOPE_INVALID")

    path = config.database.resolve(strict=True)
    initial_file = path.stat()
    with closing(readonly(path)) as source:
        current = metadata(source)
        if current is None:
            raise StateIdentityError("STATE_LEGACY_ADOPTION_REQUIRED")
        match(current, expected)
        version = source.execute("PRAGMA data_version").fetchone()[0]
        fingerprint = _retired_core_fingerprint(source, config.gateway_id, device, epoch)
        row_count, rows_hash = fingerprint
        if not row_count:
            raise StateIdentityError("STATE_NO_RETIRED_CORE_ROWS")
        manifest_path = archive(config, output, adopt=False, timeout=timeout)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        with closing(readonly(output / "gateway.sqlite3")) as copy:
            copied = metadata(copy)
            if copied is None:
                raise StateIdentityError("STATE_RETIRED_CORE_ARCHIVE_MISMATCH")
            match(copied, expected, require_live=False)
            if (copied["recovery_state"] != "QUARANTINED" or copied["archive_id"] != manifest["archiveId"]
                    or _retired_core_fingerprint(copy, config.gateway_id, device, epoch) != fingerprint):
                raise StateIdentityError("STATE_RETIRED_CORE_ARCHIVE_MISMATCH")
        prepared = {
            "retirementVersion": 1, "archiveId": manifest["archiveId"], "gatewayId": config.gateway_id,
            "deviceId": device, "retiredEpoch": epoch, "configuredEpoch": active, "rowCount": row_count,
            "rowsSha256": rows_hash,
            "settlementStatus": "not-settled", "status": "PREPARED", "recordedAt": iso_time(),
        }
        _json_file(output / "retirement-plan.json", prepared)
        _sync_directory(output)

        with closing(sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=5)) as writer:
            writer.row_factory = sqlite3.Row
            writer.execute("PRAGMA trusted_schema=OFF")
            writer.execute("PRAGMA synchronous=FULL")
            with writer:
                writer.execute("BEGIN IMMEDIATE")
                if (config.database.resolve() != path or not os.path.samestat(initial_file, path.stat())
                        or source.execute("PRAGMA data_version").fetchone()[0] != version):
                    raise StateIdentityError("STATE_CHANGED_DURING_ARCHIVE")
                bound = metadata(writer)
                if bound is None:
                    raise StateIdentityError("STATE_CHANGED_DURING_ARCHIVE")
                match(bound, expected)
                if _retired_core_fingerprint(writer, config.gateway_id, device, epoch) != fingerprint:
                    raise StateIdentityError("STATE_CHANGED_DURING_ARCHIVE")
                deleted = writer.execute(f"DELETE FROM outbox WHERE {_RETIRED_CORE_SCOPE}", (device, epoch)).rowcount
                if deleted != row_count:
                    raise StateIdentityError("STATE_RETIRED_CORE_ROW_COUNT_MISMATCH")
        receipt_path = output / "retirement.json"
        _json_file(receipt_path, {**prepared, "status": "RETIRED", "recordedAt": iso_time()})
        _sync_directory(output)
        return receipt_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Cold Gateway state archive, retirement or deployment inventory")
    parser.add_argument("operation", choices=("snapshot", "adopt", "retire-core", "plan-cutover"))
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--target-env-file", type=Path, help="complete candidate configuration for plan-cutover")
    parser.add_argument("--output", type=Path, help="new private archive directory; parent must exist")
    parser.add_argument("--timeout", type=float, default=120, help="SQLite copy deadline in seconds, 5..3600")
    parser.add_argument("--device-id", help="device whose retired CORE scope is selected")
    parser.add_argument("--retired-epoch", help="older integer epoch or 'unscoped' for legacy CORE telemetry")
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("this operator command requires POSIX owner-only files and advisory locking")
    if not 5 <= args.timeout <= 3600:
        parser.error("timeout must be between 5 and 3600 seconds")
    if args.operation == "plan-cutover":
        if args.target_env_file is None or args.output is not None:
            parser.error("plan-cutover requires --target-env-file and reports to stdout")
    else:
        if args.target_env_file is not None:
            parser.error("--target-env-file requires plan-cutover")
        if (args.output is None or args.output.exists() or args.output.is_symlink()
                or not args.output.parent.is_dir()):
            parser.error("output must be a new directory under an existing parent")
    epoch = None
    if args.operation == "retire-core":
        if not args.device_id or not ID.fullmatch(args.device_id) or args.retired_epoch is None:
            parser.error("retire-core requires a valid --device-id and --retired-epoch")
        if args.retired_epoch != "unscoped":
            if (len(args.retired_epoch) > 10 or not args.retired_epoch.isascii()
                    or not args.retired_epoch.isdecimal()):
                parser.error("retired epoch must be an integer or 'unscoped'")
            epoch = int(args.retired_epoch)
    elif args.device_id is not None or args.retired_epoch is not None:
        parser.error("device and epoch selection require retire-core")
    os.umask(0o077)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")
    try:
        import fcntl
        if args.operation == "plan-cutover":
            config = GatewayConfig.from_env(env_file_values(args.env_file))
            target = GatewayConfig.from_env(env_file_values(args.target_env_file))
        else:
            read_env_file(args.env_file)
            config = GatewayConfig.from_env()
        if not config.database.is_file():
            raise StateIdentityError("STATE_DATABASE_MISSING")
        with config.database.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.operation == "plan-cutover":
                print(canonical(cutover_plan(config, target)))
                return
            if args.operation == "retire-core":
                path = retire_core(config, args.output, device=args.device_id, epoch=epoch, timeout=args.timeout)
            else:
                path = archive(config, args.output, adopt=args.operation == "adopt", timeout=args.timeout)
        if args.operation == "retire-core":
            print(f"Retired CORE outbox scope recorded: {path}; copy quarantined; not settled")
        else:
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
