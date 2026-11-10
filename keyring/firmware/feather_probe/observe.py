"""Observe the ST7789 bench through the same BLE receiver as the Gateway."""

import argparse
import asyncio
import json
import logging
import re
from types import SimpleNamespace

from bleak import BleakScanner
from bubble_gateway.ble import BleFleet
from bubble_gateway.core_bridge import CORE_SERVICE
from bubble_gateway.model import validate_observation

DEVICE_ID = "keyring-feather-lab"
GATEWAY_ID = "gw-feather-bench"
EXPECTED = {"released", "confirm", "panic"}


async def find_feathers() -> list[str]:
    detected = await BleakScanner.discover(timeout=5.0, return_adv=True)
    return sorted(device.address for device, adv in detected.values()
                  if adv.local_name == DEVICE_ID and CORE_SERVICE in adv.service_uuids)


async def observe(address: str, seconds: int) -> int:
    devices = {DEVICE_ID: address}
    fleet = BleFleet(SimpleNamespace(
        gateway_id=GATEWAY_ID, ble_gatt_profile="core-v1", ble_devices=devices,
        ble_pair=True, ble_scan_seconds=10.0, request_timeout=5.0,
        firmware_revision_allowlist=("feather-probe-0.1.0",),
    ))
    states: set[str] = set()
    complete = asyncio.Event()

    async def receive(frame: dict) -> None:
        observation = validate_observation(frame, GATEWAY_ID, devices)
        state = observation["buttonState"]
        if state not in states:
            print(json.dumps({"buttonState": state, "sequence": observation["sequence"]}), flush=True)
            states.add(state)
        if states == EXPECTED:
            complete.set()

    await fleet.start(receive)
    try:
        print("Release both buttons, press A0, then press A1. Hold each press for one second.", flush=True)
        await asyncio.wait_for(complete.wait(), seconds)
    except TimeoutError:
        print(json.dumps({"observed": sorted(states), "missing": sorted(EXPECTED - states),
                          "lastError": fleet.snapshot()[0]["lastError"]}), flush=True)
        return 1
    finally:
        await fleet.close()
    print("Feather button observations passed.", flush=True)
    return 0


async def run(args: argparse.Namespace) -> int:
    address = args.address
    if args.scan_only or address is None:
        matches = await find_feathers()
        print(json.dumps({"matchingFeathers": matches}), flush=True)
        if args.scan_only:
            return 0
        if len(matches) != 1:
            print("Exactly one advertised Feather is required, or pass its address explicitly.", flush=True)
            return 1
        address = matches[0]
    return await observe(address, args.seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--address", help="Bluetooth address of the enrolled bench")
    parser.add_argument("--seconds", type=int, default=90, help="Observation timeout in seconds")
    parser.add_argument("--scan-only", action="store_true", help="List matching adverts without pairing")
    args = parser.parse_args()
    if args.address and not re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", args.address):
        parser.error("--address must be a colon-separated Bluetooth MAC address")
    if not 5 <= args.seconds <= 300:
        parser.error("--seconds must be between 5 and 300")
    logging.basicConfig(level=logging.WARNING)
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
