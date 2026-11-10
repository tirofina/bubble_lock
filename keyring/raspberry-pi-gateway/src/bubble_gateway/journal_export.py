"""Read-only device journal capture. No erase, settlement or output command exists here."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import re
import secrets
import struct
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ble import BleProtocolError, IDENTIFIER, MAX_UPTIME_MS, _integer, _object

JOURNAL_UUIDS = {
    "core-v1": "7f8a0006-4b6e-4f4e-9b0a-505249564255",
    "keyring-v01": "8b8f0006-8e7a-4f36-a8c2-1c9b5d620001",
}
HEX32 = re.compile(r"[0-9a-f]{32}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
HEX8 = re.compile(r"[0-9a-f]{8}\Z")


def validate_identity(identity: dict[str, Any], device_id: str) -> None:
    fields = {"version", "deviceId", "firmwareRevision", "boardRevision", "bootId"}
    if (set(identity) != fields or type(identity.get("version")) is not int or identity["version"] != 1
            or identity.get("deviceId") != device_id or IDENTIFIER.fullmatch(device_id) is None):
        raise BleProtocolError("journal identity does not match enrollment")
    for key in ("firmwareRevision", "boardRevision", "bootId"):
        if not isinstance(identity[key], str) or not 1 <= len(identity[key]) <= 64:
            raise BleProtocolError("invalid journal identity")
    if IDENTIFIER.fullmatch(identity["bootId"]) is None:
        raise BleProtocolError("invalid journal identity boot ID")


def _manifest(frame: dict[str, Any], identity: dict[str, Any]) -> None:
    fields = {"version", "requestId", "status", "type", "snapshotId", "deviceId", "bootId",
              "capturedUptimeMs", "recordCount", "preparedCount", "capacity", "format", "maxEpoch", "maxGrant"}
    if (set(frame) != fields or type(frame.get("version")) is not int or frame["version"] != 1
            or frame.get("status") != "ok" or frame.get("type") != "manifest"
            or not isinstance(frame.get("requestId"), str) or HEX8.fullmatch(frame["requestId"]) is None
            or frame.get("deviceId") != identity["deviceId"] or frame.get("bootId") != identity["bootId"]
            or not isinstance(frame.get("snapshotId"), str) or HEX32.fullmatch(frame["snapshotId"]) is None
            or type(frame.get("format")) is not int or frame["format"] != 1
            or type(frame.get("capacity")) is not int or frame["capacity"] != 32
            or not _integer(frame.get("recordCount"), maximum=32)
            or not _integer(frame.get("preparedCount"), maximum=frame["recordCount"])
            or not _integer(frame.get("capturedUptimeMs"), maximum=MAX_UPTIME_MS)
            or not _integer(frame.get("maxEpoch"), maximum=2147483647)
            or not _integer(frame.get("maxGrant"), maximum=2147483647)):
        raise BleProtocolError("invalid journal snapshot manifest")


def _part(frame: dict[str, Any], manifest: dict[str, Any], index: int, part: int) -> dict[str, Any]:
    fields = {"version", "requestId", "status", "type", "snapshotId", "index", "part", "parts", "data"}
    if (set(frame) != fields or frame.get("type") != "record"
            or frame.get("snapshotId") != manifest["snapshotId"]
            or type(frame.get("index")) is not int or frame["index"] != index
            or type(frame.get("part")) is not int or frame["part"] != part
            or type(frame.get("parts")) is not int or frame["parts"] != 2
            or not isinstance(frame.get("data"), dict)):
        raise BleProtocolError("journal record part is not bound to this snapshot")
    data = frame["data"]
    expected = ({"commandId", "payloadHash", "bootId", "ownershipEpoch", "grantRevision"} if part == 0 else
                {"phase", "ackCode", "desiredState", "readback", "acceptedUptimeMs", "appliedUptimeMs", "storageCrc32"})
    if set(data) != expected:
        raise BleProtocolError("invalid journal record part shape")
    return data


def _record(record: dict[str, Any], manifest: dict[str, Any]) -> None:
    for key in ("commandId", "bootId"):
        if not isinstance(record[key], str) or IDENTIFIER.fullmatch(record[key]) is None:
            raise BleProtocolError("invalid journal record identity")
    if (not isinstance(record["payloadHash"], str) or HEX64.fullmatch(record["payloadHash"]) is None
            or not _integer(record["ownershipEpoch"], maximum=manifest["maxEpoch"])
            or not _integer(record["grantRevision"], 1, manifest["maxGrant"])
            or type(record["desiredState"]) is not bool
            or not _integer(record["acceptedUptimeMs"], maximum=MAX_UPTIME_MS)
            or not isinstance(record["storageCrc32"], str) or HEX8.fullmatch(record["storageCrc32"]) is None):
        raise BleProtocolError("invalid journal record fields")
    if record["phase"] == "prepared":
        if record["ackCode"] != "INDETERMINATE" or record["readback"] is not None or record["appliedUptimeMs"] is not None:
            raise BleProtocolError("prepared journal record cannot claim application")
    elif record["phase"] == "completed":
        if (record["ackCode"] not in {"APPLIED", "READBACK_MISMATCH"}
                or type(record["readback"]) is not bool
                or not _integer(record["appliedUptimeMs"], record["acceptedUptimeMs"], MAX_UPTIME_MS)
                or (record["ackCode"] == "APPLIED") != (record["desiredState"] == record["readback"])):
            raise BleProtocolError("inconsistent completed journal record")
    else:
        raise BleProtocolError("unknown journal record phase")


async def capture(client: Any, identity: dict[str, Any], profile: str) -> dict[str, Any]:
    """Caller owns an authenticated client and its exclusive per-device operation lock."""
    validate_identity(identity, identity.get("deviceId", ""))
    uuid = JOURNAL_UUIDS[profile]
    if client.services.get_characteristic(uuid) is None:
        raise BleProtocolError("firmware does not expose the journal export extension")
    nonce = secrets.randbits(32)

    async def request(operation: int, index: int = 0, part: int = 0) -> dict[str, Any]:
        nonlocal nonce
        nonce = (nonce + 1) & 0xffffffff
        request_id = f"{nonce:08x}"
        packet = struct.pack("<BBIBB", 1, operation, nonce, index, part)
        async with asyncio.timeout(3):
            await client.write_gatt_char(uuid, packet, response=True)
            while True:
                raw = await client.read_gatt_char(uuid)
                # The attribute can temporarily contain the just-written selector.
                if raw and bytes(raw) != packet:
                    frame = _object(raw, 512)
                    if frame.get("requestId") == request_id:
                        if type(frame.get("version")) is not int or frame["version"] != 1:
                            raise BleProtocolError("invalid journal response version")
                        if frame.get("status") != "ok":
                            raise BleProtocolError("journal request rejected; no capture accepted")
                        return frame
                await asyncio.sleep(0.1)

    async with asyncio.timeout(90):
        manifest = await request(1)
        _manifest(manifest, identity)
        records = []
        seen: set[str] = set()
        try:
            for index in range(manifest["recordCount"]):
                record = {}
                for part in range(2):
                    frame = await request(2, index, part)
                    record.update(_part(frame, manifest, index, part))
                _record(record, manifest)
                if record["commandId"] in seen:
                    raise BleProtocolError("duplicate command ID in journal snapshot")
                seen.add(record["commandId"])
                records.append(record)
            if sum(r["phase"] == "prepared" for r in records) != manifest["preparedCount"]:
                raise BleProtocolError("journal prepared count disagrees with records")
            return {"manifest": manifest, "records": records}
        finally:
            # Ends only volatile capture state. Disconnect/120s TTL also releases it.
            with contextlib.suppress(Exception):
                async with asyncio.timeout(1):
                    await request(3)


def _json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode("utf-8")


def _new_file(path: Path, data: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def write_archive(snapshot: dict[str, Any], identity: dict[str, Any], profile: str, output: Path) -> Path:
    """Create a private new archive; never replace or prune source/device records."""
    if os.name != "posix":
        raise RuntimeError("journal archive requires POSIX owner-only file permissions")
    validate_identity(identity, identity.get("deviceId", ""))
    _manifest(snapshot["manifest"], identity)
    if len(snapshot["records"]) != snapshot["manifest"]["recordCount"]:
        raise BleProtocolError("incomplete journal archive")
    for record in snapshot["records"]:
        _record(record, snapshot["manifest"])
    if (len({r["commandId"] for r in snapshot["records"]}) != len(snapshot["records"])
            or sum(r["phase"] == "prepared" for r in snapshot["records"]) != snapshot["manifest"]["preparedCount"]):
        raise BleProtocolError("inconsistent journal archive membership")
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    data = b"".join(_json(record) for record in snapshot["records"])
    _new_file(output / "records.jsonl", data)
    manifest = {
        "archiveVersion": 1, "identity": identity, "gattProfile": profile,
        "deviceSnapshot": snapshot["manifest"], "recordCount": len(snapshot["records"]),
        "archivedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "timestampSource": "gateway-received", "settlementStatus": "not-settled",
        "deviceJournalModified": False, "containsPlaintextCommandMetadata": True,
        "files": [{"path": "records.jsonl", "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}],
        "limitations": ["GPIO readback is not physical actuation evidence", "storage CRC is metadata, not a transport signature"],
    }
    path = output / "manifest.json"
    _new_file(path, _json(manifest)) # Written last; a partial directory is not a complete archive.
    directory = os.open(output, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return path
