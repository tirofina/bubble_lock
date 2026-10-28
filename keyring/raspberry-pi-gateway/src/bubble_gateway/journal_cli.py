"""Operator-invoked device journal archive; never starts the Gateway daemon."""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import re
from pathlib import Path

from .ble import SERVICE, IDENTITY, CORE_SERVICE, CORE_IDENTITY, IDENTIFIER, BleProtocolError, _object
from .journal_export import capture, validate_identity, write_archive


async def archive(args: argparse.Namespace) -> Path:
    from bleak import BleakClient
    service, identity_uuid = ((CORE_SERVICE, CORE_IDENTITY) if args.gatt_profile == "core-v1" else (SERVICE, IDENTITY))
    async with BleakClient(args.address, pair=True, timeout=30) as client:
        if client.services.get_service(service) is None:
            raise BleProtocolError("required keyring service missing")
        identity = _object(await client.read_gatt_char(identity_uuid), 512)
        validate_identity(identity, args.device_id)
        if identity["firmwareRevision"] != args.firmware_revision:
            raise BleProtocolError("firmware revision differs from the selected revision")
        snapshot = await capture(client, identity, args.gatt_profile)
        if _object(await client.read_gatt_char(identity_uuid), 512) != identity:
            raise BleProtocolError("keyring identity changed during capture")
    return write_archive(snapshot, identity, args.gatt_profile, args.output)


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only Privacy Bubble keyring journal archive (Linux/BlueZ)")
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--address", required=True, help="previously bonded BlueZ device address")
    parser.add_argument("--database", type=Path, required=True, help="same database path as the Gateway; used only for its process lock")
    parser.add_argument("--output", type=Path, required=True, help="new archive directory; parent must exist")
    parser.add_argument("--gatt-profile", choices=("core-v1", "keyring-v01"), default="core-v1")
    parser.add_argument("--firmware-revision", default="keyring-0.6.0")
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("this operator command requires Linux/BlueZ")
    if IDENTIFIER.fullmatch(args.device_id) is None or re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", args.address) is None:
        parser.error("invalid device enrollment identity/address")
    if args.output.exists() or args.output.is_symlink() or not args.output.parent.is_dir():
        parser.error("output must be a new directory under an existing parent")
    os.umask(0o077)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")
    # Never enable raw BLE/HTTP debug logging or collect passkeys in arguments/files.
    for name in ("bleak", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
    try:
        import fcntl
        # Cooperates with bubble-gateway's existing lifetime lock. No DB read or mutation.
        with args.database.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            path = asyncio.run(archive(args))
        print(f"Journal archive created: {path}; device records retained; not settled")
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except Exception as exc:
        logging.getLogger(__name__).error("Journal archive stopped: %s; no device records erased", type(exc).__name__)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
