"""Read-only comparison of an exported device journal, Gateway archive and native CSE receipts."""
from __future__ import annotations

import argparse
import asyncio
from contextlib import closing
from dataclasses import replace
from pathlib import Path
import sys

from .ble import BleProtocolError, _object
from .config import GatewayConfig, read_env_file
from .journal_export import read_archive
from .model import canonical, iso_time, parse_time, payload_hash, validate_command
from .state_archive import _file_digest
from .state_identity import StateIdentityError, configured_binding, match, metadata, readonly
from .store import Store
from .transport import RemoteResponseError, TransportHub


def _read_gateway_archive(directory: Path, expected: dict, command_ids: list[str]) -> tuple[str, dict]:
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
        rows = {}
        for command_id in command_ids:
            row = db.execute("SELECT payload,payload_hash,status,receipt,receipt_delivered FROM commands "
                             "WHERE command_id=?", (command_id,)).fetchone()
            if row is not None:
                rows[command_id] = dict(row)
    verify_file()
    return archive_id, rows


def _bound_receipt(config, device_id, record, row):
    if type(row["receipt_delivered"]) is not int or row["receipt_delivered"] not in (0, 1):
        raise ValueError("invalid archived delivery state")
    raw = _object(row["payload"].encode("utf-8"), 4096)
    command = validate_command(raw, config.gateway_id, config.ble_devices)
    fields = ("commandId", "grantRevision", "ownershipEpoch")
    if (command["deviceId"] != device_id or any(command[key] != record[key] for key in fields)
            or payload_hash(command) != record["payloadHash"] or row["payload_hash"] != record["payloadHash"]
            or command["desiredState"]["state"] is not record["desiredState"]):
        raise ValueError("device record differs from archived command")
    if row["receipt"] is None:
        return None
    receipt = _object(row["receipt"].encode("utf-8"), 8192)
    expected = {key: command[key] for key in (*fields, "gatewayId", "deviceId")}
    expected.update(version=1, payloadHash=record["payloadHash"], status=row["status"])
    if (canonical({key: receipt.get(key) for key in expected}) != canonical(expected)
            or receipt.get("status") not in {"APPLIED", "REJECTED", "TIMEOUT", "INDETERMINATE"}
            or not isinstance(receipt.get("ackCode"), str)):
        raise ValueError("archived receipt differs from command identity")
    parse_time(receipt["receivedAt"])
    return receipt


def _compared_result(record, receipt):
    status, code = receipt["status"], receipt["ackCode"]
    if record["phase"] == "prepared":
        return "device_prepared" if status != "APPLIED" else "device_result_mismatch"
    expected = ("APPLIED", {"APPLIED", "DUPLICATE"}) if record["ackCode"] == "APPLIED" else (
        "INDETERMINATE", {"READBACK_MISMATCH"})
    firmware = receipt.get("firmwareRevision")
    if (status != expected[0] or code not in expected[1] or receipt.get("bootId") != record["bootId"]
            or not isinstance(firmware, str) or not 1 <= len(firmware) <= 64
            or canonical(receipt.get("readback")) != canonical({"state": record["readback"]})):
        return "device_result_mismatch"
    return "matched_applied" if status == "APPLIED" else "matched_readback_failure"


async def reconcile(config: GatewayConfig, device_archive: Path, gateway_archive: Path) -> dict:
    journal, records = read_archive(device_archive)
    device_id = journal["identity"]["deviceId"]
    if device_id not in config.ble_devices:
        raise StateIdentityError("RECONCILE_DEVICE_NOT_ENROLLED")
    archive_id, rows = _read_gateway_archive(gateway_archive, configured_binding(config),
                                             [record["commandId"] for record in records])
    transport = TransportHub(replace(config, mqtt_enabled=False, core_bridge_enabled=False))
    results = []
    await transport.start()
    try:
        for record in records:
            command_id = record["commandId"]
            row = rows.get(command_id)
            result = {"commandId": command_id, "payloadHash": record["payloadHash"], "devicePhase": record["phase"],
                      "gatewayDelivered": None if row is None else row["receipt_delivered"] == 1}
            results.append(result)
            if row is None:
                result["result"] = "missing_gateway_command"
                continue
            try:
                receipt = _bound_receipt(config, device_id, record, row)
            except (ValueError, KeyError, TypeError, AttributeError, BleProtocolError):
                result["result"] = "gateway_binding_mismatch"
                continue
            if receipt is None:
                result["result"] = "missing_gateway_receipt"
                continue
            result["gatewayReceiptSha256"] = payload_hash(receipt)
            try:
                cin = await transport.read_content(Store.request_id("receipt", command_id), config.receipt_container)
            except RemoteResponseError as exc:
                if (exc.status_code, exc.rsc) != (404, 4004):
                    raise
                result["result"] = "missing_cse_receipt"
                continue
            result["cseReceiptSha256"] = payload_hash(cin)
            result["result"] = (_compared_result(record, receipt) if canonical(cin) == canonical(receipt)
                                else "cse_receipt_mismatch")
    finally:
        await transport.close()
    return {"reportVersion": 1, "checkedAt": iso_time(), "gatewayId": config.gateway_id, "deviceId": device_id,
            "cseId": config.cse_id, "receiptContainer": config.receipt_container,
            "gatewayArchiveId": archive_id, "deviceSnapshotId": journal["deviceSnapshot"]["snapshotId"],
            "settlementStatus": "not-settled", "deviceJournalModified": False,
            "reviewCount": sum(row["result"] != "matched_applied" or not row["gatewayDelivered"] for row in results),
            "results": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--device-archive", type=Path, required=True)
    parser.add_argument("--gateway-archive", type=Path, required=True)
    args = parser.parse_args()
    try:
        read_env_file(args.env_file)
        report = asyncio.run(reconcile(GatewayConfig.from_env(), args.device_archive, args.gateway_archive))
        print(canonical(report))
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except Exception as exc:
        code = str(exc) if isinstance(exc, StateIdentityError) else type(exc).__name__
        print("Journal comparison stopped: " + code, file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
