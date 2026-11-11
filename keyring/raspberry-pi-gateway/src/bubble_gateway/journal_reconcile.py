"""Read-only comparison of an exported device journal, Gateway archive and native CSE receipts."""
from __future__ import annotations

import argparse
import asyncio
from contextlib import closing
from dataclasses import replace
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import re
import sqlite3
import sys

from .ble import BleProtocolError, _object
from .config import ID, GatewayConfig, env_file_values, read_env_file
from .integration_evidence import inspect_integration_command, inspect_integration_receipt
from .journal_export import read_archive
from .model import canonical, iso_time, parse_time, payload_hash, validate_command
from .state_archive import _file_digest
from .state_identity import StateIdentityError, configured_binding, match, metadata, readonly
from .store import Store
from .transport import RemoteResponseError, TransportHub

TEAM_STATE_MAX_BYTES = 32 * 1024 * 1024
NATIVE_RECEIPT_MAX_BYTES = 16 * 1024
GATEWAY_ONLY_COMMAND_LIMIT = 128


def _gateway_only_pending(db: sqlite3.Connection, device_id: str, command_ids: list[str],
                          include_unstaged_central: bool) -> dict:
    columns = {row["name"] for row in db.execute("PRAGMA table_info(commands)")}
    central_unstaged = "receipt IS NOT NULL"
    if "central_receipt_staged" in columns:
        central_unstaged += " AND central_receipt_staged=0"
    final_write = "ble_final_write_started" if "ble_final_write_started" in columns else "NULL"
    rows = db.execute(f"""
        WITH candidates AS (
            SELECT command_id, payload_hash, status, {final_write} AS final_write,
                (receipt IS NOT NULL AND receipt_delivered=0) AS native_pending,
                (command_id IN (
                    SELECT json_extract(CASE WHEN json_valid(payload) THEN payload END, '$.commandId')
                    FROM outbox WHERE container='@central/receipt'
                ) OR (?3 AND ({central_unstaged}))) AS central_pending
            FROM commands
            WHERE json_extract(CASE WHEN json_valid(payload) THEN payload END, '$.deviceId')=?1
              AND command_id NOT IN (SELECT value FROM json_each(?2))
        )
        SELECT *, COUNT(*) OVER () AS total FROM candidates
        WHERE status IN ('RECEIVED', 'DISPATCHING') OR native_pending OR central_pending
        ORDER BY command_id LIMIT ?4
    """, (device_id, canonical(command_ids), include_unstaged_central, GATEWAY_ONLY_COMMAND_LIMIT)).fetchall()
    commands = []
    for row in rows:
        entry = {"commandId": row["command_id"], "payloadHash": row["payload_hash"], "gatewayStatus": row["status"],
                 "nativeReceiptPending": bool(row["native_pending"]), "centralReceiptPending": bool(row["central_pending"])}
        if row["status"] == "DISPATCHING":
            marker = row["final_write"]
            entry["bleFinalWriteMayHaveStarted"] = bool(marker) if marker in (0, 1) else None
        commands.append(entry)
    return {"count": rows[0]["total"] if rows else 0, "commands": commands}


def _read_gateway_archive(directory: Path, expected: dict, command_ids: list[str], *,
                          device_id: str | None, include_unstaged_central: bool,
                          include_pending_rows: bool) -> tuple[str, dict, dict | None]:
    with (directory / "manifest.json").open("rb") as stream:
        manifest = _object(stream.read(8193), 8192)
    archive_id = manifest.get("archiveId")
    if (type(manifest.get("archiveVersion")) is not int or manifest["archiveVersion"] != 1
            or not isinstance(archive_id, str) or not archive_id
            or manifest.get("copyRecoveryState") != "QUARANTINED"
            or manifest.get("settlementStatus") != "not-settled"
            or manifest.get("dataRowsModified") is not False
            or canonical(manifest.get("binding")) != canonical(expected)
            or manifest.get("bindingSha256") != payload_hash(expected)):
        raise StateIdentityError("RECONCILE_ARCHIVE_BINDING")
    path = directory / "gateway.sqlite3"

    def verify_file() -> None:
        if any(path.with_name(path.name + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
            raise StateIdentityError("RECONCILE_ARCHIVE_SIDECAR")
        file = {"path": path.name, "bytes": path.stat().st_size, "sha256": _file_digest(path)}
        if canonical(manifest.get("files")) != canonical([file]):
            raise StateIdentityError("RECONCILE_ARCHIVE_DIGEST")

    verify_file()
    with closing(readonly(path)) as db:
        db.execute("BEGIN")
        identity = metadata(db)
        if (identity is None or identity["recovery_state"] != "QUARANTINED"
                or identity["archive_id"] != archive_id):
            raise StateIdentityError("RECONCILE_ARCHIVE_IDENTITY")
        match(identity, expected, require_live=False)
        pending = None if device_id is None else _gateway_only_pending(db, device_id, command_ids, include_unstaged_central)
        if include_pending_rows and pending is not None:
            command_ids = command_ids + [entry["commandId"] for entry in pending["commands"]]
        rows = {}
        for command_id in command_ids:
            row = db.execute("SELECT payload,payload_hash,status,receipt,receipt_delivered FROM commands "
                             "WHERE command_id=?", (command_id,)).fetchone()
            if row is not None:
                rows[command_id] = dict(row)
    verify_file()
    return archive_id, rows, pending


def _archived_receipt(config, device_id, command_id, row):
    if type(row["receipt_delivered"]) is not int or row["receipt_delivered"] not in (0, 1):
        raise ValueError("invalid archived delivery state")
    raw = _object(row["payload"].encode("utf-8"), 4096)
    command = validate_command(raw, config.gateway_id, config.ble_devices)
    fields = ("commandId", "grantRevision", "ownershipEpoch")
    if (command["deviceId"] != device_id or command["commandId"] != command_id
            or payload_hash(command) != row["payload_hash"]):
        raise ValueError("archived command identity mismatch")
    if row["receipt"] is None:
        return command, None
    receipt = _object(row["receipt"].encode("utf-8"), 8192)
    expected = {key: command[key] for key in (*fields, "gatewayId", "deviceId")}
    expected.update(version=1, payloadHash=row["payload_hash"], status=row["status"])
    if (canonical({key: receipt.get(key) for key in expected}) != canonical(expected)
            or receipt.get("status") not in {"APPLIED", "REJECTED", "TIMEOUT", "INDETERMINATE"}
            or not isinstance(receipt.get("ackCode"), str)):
        raise ValueError("archived receipt differs from command identity")
    parse_time(receipt["receivedAt"])
    return command, receipt


def _bound_receipt(config, device_id, record, row):
    command, receipt = _archived_receipt(config, device_id, record["commandId"], row)
    if (any(command[key] != record[key] for key in ("grantRevision", "ownershipEpoch"))
            or row["payload_hash"] != record["payloadHash"]
            or command["desiredState"]["state"] is not record["desiredState"]):
        raise ValueError("device record differs from archived command")
    return command, receipt


def _compared_result(record, receipt, *, expected_firmware=None):
    status, code = receipt["status"], receipt["ackCode"]
    if record["phase"] == "prepared":
        return "device_prepared" if status != "APPLIED" else "device_result_mismatch"
    expected = ("APPLIED", {"APPLIED", "DUPLICATE"}) if record["ackCode"] == "APPLIED" else (
        "INDETERMINATE", {"READBACK_MISMATCH"})
    firmware = receipt.get("firmwareRevision")
    if (status != expected[0] or code not in expected[1] or receipt.get("bootId") != record["bootId"]
            or not isinstance(firmware, str) or not 1 <= len(firmware) <= 64
            or (expected_firmware is not None and firmware != expected_firmware)
            or canonical(receipt.get("readback")) != canonical({"state": record["readback"]})):
        return "device_result_mismatch"
    return "matched_applied" if status == "APPLIED" else "matched_readback_failure"


def _captured_receipt(artifact, command_id, config):
    resource = artifact.get("cseResource")
    receipt = artifact.get("cseReceipt")
    request_id = Store.request_id("receipt", command_id)
    name = "gw-" + hashlib.sha256(request_id.encode("utf-8")).hexdigest()
    if (config.receipt_container_ri is None or not isinstance(resource, dict) or not isinstance(receipt, dict)
            or resource.get("pi") != config.receipt_container_ri or resource.get("rn") != name
            or type(resource.get("ty")) is not int or resource["ty"] != 4 or receipt.get("commandId") != command_id):
        raise StateIdentityError("RECONCILE_CAPTURED_RECEIPT_BINDING")
    return {**resource, "con": receipt}


async def _native_receipt_evidence(transport, config, command_id, receipt, *, captured=None):
    cin = captured
    if transport is not None:
        try:
            cin = await transport.read_content_instance(Store.request_id("receipt", command_id), config.receipt_container)
        except RemoteResponseError as exc:
            if (exc.status_code, exc.rsc) != (404, 4004):
                raise
            return {"result": "missing_cse_receipt"}
    content = cin["con"]
    evidence = {"cseReceiptSha256": payload_hash(content)}
    resource_id, created = cin.get("ri"), cin.get("ct")
    try:
        if (type(cin.get("ty")) is not int or cin["ty"] != 4
                or not isinstance(resource_id, str) or ID.fullmatch(resource_id) is None
                or not isinstance(created, str) or re.fullmatch(r"[0-9]{8}T[0-9]{6}", created) is None):
            raise ValueError("invalid native receipt identity")
        stored_at = iso_time(datetime.strptime(created, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc))
    except ValueError:
        return {**evidence, "result": "cse_receipt_identity_invalid"}
    return {**evidence, "nativeResourceId": resource_id, "nativeStoredAt": stored_at,
            "result": "cse_receipt_matched" if canonical(content) == canonical(receipt) else "cse_receipt_mismatch"}


async def _check_gateway_only_receipts(transport, config, device_id, rows, pending):
    candidates = []
    for entry in pending["commands"]:
        command_id = entry["commandId"]
        try:
            _, receipt = _archived_receipt(config, device_id, command_id, rows[command_id])
        except (ValueError, KeyError, TypeError, AttributeError, BleProtocolError):
            entry["nativeReceipt"] = {"result": "gateway_binding_mismatch"}
            continue
        if receipt is None:
            entry["nativeReceipt"] = {"result": "missing_gateway_receipt"}
        else:
            candidates.append((entry, receipt))
    if candidates:
        await transport.verify_receipt_route()
    for entry, receipt in candidates:
        result = await _native_receipt_evidence(transport, config, entry["commandId"], receipt)
        entry["nativeReceipt"] = {**result, "gatewayReceiptSha256": payload_hash(receipt)}


def _check_gateway_only_central(config, device_id, rows, pending, team_state):
    pending["centralReceiptSource"] = "captured"
    for entry in pending["commands"]:
        command_id = entry["commandId"]
        try:
            command, receipt = _archived_receipt(config, device_id, command_id, rows[command_id])
        except (ValueError, KeyError, TypeError, AttributeError, BleProtocolError):
            entry["centralReceipt"] = {"result": "gateway_binding_mismatch"}
            continue
        if receipt is None:
            entry["centralReceipt"] = {"result": "missing_gateway_receipt"}
            continue
        try:
            entry["centralReceipt"] = inspect_integration_receipt(command, receipt, team_state)
        except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
            entry["centralReceipt"] = {"result": "central_receipt_mismatch"}


async def reconcile(config: GatewayConfig, device_archive: Path, gateway_archive: Path, *,
                    same_boot_command: str | None = None, board_revision: str | None = None,
                    firmware_revision: str | None = None, team_state: dict | None = None,
                    native_receipt: dict | None = None, archive_only: bool = False,
                    check_gateway_only_native: bool = False) -> dict:
    compare_pending_central = archive_only and same_boot_command is None and team_state is not None
    if native_receipt is not None and (same_boot_command is None or archive_only):
        raise ValueError("Saved native receipt comparison requires a same-boot command outside archive-only mode")
    if team_state is not None and not compare_pending_central and (same_boot_command is None or archive_only):
        raise ValueError("Team state requires a same-boot command or a full-device archive-only comparison")
    if check_gateway_only_native:
        if archive_only or same_boot_command is not None:
            raise ValueError("Gateway-only native checks require a live full-device comparison")
        if config.receipt_container_ri is None:
            raise StateIdentityError("RECONCILE_RECEIPT_CONTAINER_PIN_REQUIRED")
    journal, records = read_archive(device_archive)
    identity = journal["identity"]
    device_id = identity["deviceId"]
    if device_id not in config.ble_devices:
        raise StateIdentityError("RECONCILE_DEVICE_NOT_ENROLLED")
    selected = None
    if same_boot_command is not None:
        if identity["boardRevision"] != board_revision or identity["firmwareRevision"] != firmware_revision:
            raise StateIdentityError("RECONCILE_DEVICE_REVISION_MISMATCH")
        record = next((row for row in records if row["commandId"] == same_boot_command), None)
        if record is None:
            raise StateIdentityError("RECONCILE_DEVICE_COMMAND_MISSING")
        if record["bootId"] != identity["bootId"]:
            raise StateIdentityError("RECONCILE_DEVICE_BOOT_MISMATCH")
        selected = {"commandId": same_boot_command, "boardRevision": board_revision, "firmwareRevision": firmware_revision,
                    "sameBoot": True, "sourceRecordCount": len(records), "desiredState": record["desiredState"],
                    "acceptedUptimeMs": record["acceptedUptimeMs"], "appliedUptimeMs": record["appliedUptimeMs"]}
        records = [record]
    archive_id, rows, pending = _read_gateway_archive(
        gateway_archive, configured_binding(config), [record["commandId"] for record in records],
        device_id=device_id if selected is None else None,
        include_unstaged_central=config.commands_enabled and config.central_receipts_enabled,
        include_pending_rows=check_gateway_only_native or compare_pending_central,
    )
    captured = _captured_receipt(native_receipt, same_boot_command, config) if native_receipt is not None else None
    transport = None if archive_only or captured is not None else TransportHub(
        replace(config, mqtt_enabled=False, core_bridge_enabled=False))
    results = []
    central = ({"status": "journal_review_required", "originalApplicationMatched": False}
               if team_state is not None and same_boot_command is not None else None)
    try:
        if transport is not None:
            await transport.start()
        for record in records:
            command_id = record["commandId"]
            row = rows.get(command_id)
            result = {"commandId": command_id, "payloadHash": record["payloadHash"], "devicePhase": record["phase"],
                      "deviceReadbackState": record["readback"],
                      "gatewayDelivered": None if row is None else row["receipt_delivered"] == 1}
            results.append(result)
            if row is None:
                result["result"] = "missing_gateway_command"
                continue
            try:
                command, receipt = _bound_receipt(config, device_id, record, row)
            except (ValueError, KeyError, TypeError, AttributeError, BleProtocolError):
                result["result"] = "gateway_binding_mismatch"
                continue
            if receipt is None:
                result["result"] = "missing_gateway_receipt"
                continue
            if selected is not None:
                result["gatewayAckCode"] = receipt["ackCode"]
            result["gatewayReceiptSha256"] = payload_hash(receipt)
            if archive_only:
                result["result"] = "native_receipt_not_checked"
                result["deviceComparison"] = _compared_result(
                    record, receipt, expected_firmware=firmware_revision if selected is not None else None)
                continue
            result.update(await _native_receipt_evidence(transport, config, command_id, receipt, captured=captured))
            if result["result"] == "cse_receipt_matched":
                result["result"] = _compared_result(
                    record, receipt, expected_firmware=firmware_revision if selected is not None else None)
            if central is not None and result["result"] == "matched_applied":
                try:
                    proof = inspect_integration_command(command, receipt, team_state)
                except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
                    central["status"] = "settlement_mismatch"
                else:
                    if proof is None:
                        central["status"] = "settlement_missing"
                    else:
                        central.update(proof, status="settlement_matched",
                                       originalApplicationMatched=result["gatewayDelivered"] and receipt["ackCode"] == "APPLIED")
        if check_gateway_only_native:
            await _check_gateway_only_receipts(transport, config, device_id, rows, pending)
        if compare_pending_central:
            _check_gateway_only_central(config, device_id, rows, pending, team_state)
    finally:
        if transport is not None:
            await transport.close()
    native_source = "not-checked" if archive_only else ("captured" if captured is not None else "live")
    review_count = sum(row["result"] != "matched_applied" or not row["gatewayDelivered"]
                       or (central is not None and not central["originalApplicationMatched"]) for row in results)
    return {"reportVersion": 1, "checkedAt": iso_time(), "gatewayId": config.gateway_id, "deviceId": device_id,
            "cseId": config.cse_id, "cseDeploymentId": config.cse_deployment_id, "receiptContainer": config.receipt_container,
            "nativeReceiptSource": native_source,
            "gatewayArchiveId": archive_id, "deviceSnapshotId": journal["deviceSnapshot"]["snapshotId"],
            "deviceRecordsSha256": journal["files"][0]["sha256"], "recordCount": len(records),
            **({"selectedCommand": selected} if selected is not None else {}),
            **({"gatewayOnlyPending": pending} if pending is not None else {}),
            **({"integrationSettlement": central} if central is not None else {}),
            "settlementStatus": "not-settled", "deviceJournalModified": False,
            "reviewCount": review_count + (pending["count"] if pending is not None else 0),
            "results": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--device-archive", type=Path, required=True)
    parser.add_argument("--gateway-archive", type=Path, required=True)
    parser.add_argument("--same-boot-command", metavar="COMMAND_ID",
                        help="Compare one command from the same device boot as the journal capture")
    parser.add_argument("--board-revision", help="Expected board revision for --same-boot-command")
    parser.add_argument("--firmware-revision", help="Expected firmware revision for --same-boot-command")
    parser.add_argument("--team-state", type=Path,
                        help="Private integration snapshot for a same-boot command or a full archive-only comparison")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--native-receipt", type=Path, help="Saved pulse-receipt.json for offline same-boot comparison")
    source.add_argument("--archive-only", action="store_true", help="Compare device and Gateway archives without network access")
    source.add_argument("--check-gateway-only-native", action="store_true",
                        help="Read CSE receipts for pending commands absent from the device archive")
    args = parser.parse_args()
    if args.same_boot_command is not None:
        if not ID.fullmatch(args.same_boot_command) or not args.board_revision or not args.firmware_revision:
            parser.error("--same-boot-command requires a valid command ID, --board-revision and --firmware-revision")
    elif any(value is not None for value in (args.board_revision, args.firmware_revision, args.native_receipt)):
        parser.error("Revision options and --native-receipt require --same-boot-command")
    if args.team_state is not None:
        if args.archive_only and args.same_boot_command is not None:
            parser.error("--archive-only with --team-state compares the full device")
        if not args.archive_only and args.same_boot_command is None:
            parser.error("--team-state requires --same-boot-command or --archive-only")
    if args.check_gateway_only_native and args.same_boot_command is not None:
        parser.error("--check-gateway-only-native requires a full-device comparison")
    try:
        if args.archive_only or args.check_gateway_only_native:
            config = GatewayConfig.from_env(env_file_values(args.env_file), require_tls_files=not args.archive_only)
        else:
            read_env_file(args.env_file)
            config = GatewayConfig.from_env()
        state = None
        if args.team_state is not None:
            with args.team_state.open("rb") as stream:
                raw = stream.read(TEAM_STATE_MAX_BYTES + 1)
            state = _object(raw, TEAM_STATE_MAX_BYTES)
        captured = None
        if args.native_receipt is not None:
            with args.native_receipt.open("rb") as stream:
                receipt_bytes = stream.read(NATIVE_RECEIPT_MAX_BYTES + 1)
            captured = _object(receipt_bytes, NATIVE_RECEIPT_MAX_BYTES)
        report = asyncio.run(reconcile(config, args.device_archive, args.gateway_archive,
                                       same_boot_command=args.same_boot_command, board_revision=args.board_revision,
                                       firmware_revision=args.firmware_revision, team_state=state, native_receipt=captured,
                                       archive_only=args.archive_only, check_gateway_only_native=args.check_gateway_only_native))
        if state is not None:
            report["integrationStateSha256"] = hashlib.sha256(raw).hexdigest()
        if captured is not None:
            report["nativeReceiptArtifactSha256"] = hashlib.sha256(receipt_bytes).hexdigest()
        print(canonical(report))
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except Exception as exc:
        code = str(exc) if isinstance(exc, StateIdentityError) else type(exc).__name__
        print("Journal comparison stopped: " + code, file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
