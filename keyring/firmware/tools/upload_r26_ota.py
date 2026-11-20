"""Upload an r26 OTA image using the device's private build header."""

import argparse
import importlib.util
import ipaddress
from pathlib import Path
import re
import secrets


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("address", help="IPv4 address of the keyring")
    parser.add_argument("image", type=Path, help="OTA-enabled r26 firmware image")
    parser.add_argument("private_header", type=Path, help="Device-specific build header outside the repository")
    parser.add_argument("espota", type=Path, help="Arduino ESP32 tools/espota.py")
    args = parser.parse_args()

    address = str(ipaddress.IPv4Address(args.address))
    header = args.private_header.read_text(encoding="utf-8")
    matches = re.findall(r'^#define KEYRING_OTA_PASSWORD "([0-9A-Fa-f]{24,})"\s*$', header, re.MULTILINE)
    if len(matches) != 1 or not args.image.is_file():
        parser.error("An OTA image and one hexadecimal OTA password are required")
    spec = importlib.util.spec_from_file_location("espota", args.espota)
    if spec is None or spec.loader is None:
        parser.error("Unable to load the installed espota.py")
    espota = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(espota)
    espota.TIMEOUT = 10
    return espota.serve(address, "0.0.0.0", 3232, secrets.randbelow(10000) + 40000,
                        matches[0], str(args.image), espota.FLASH)


if __name__ == "__main__":
    raise SystemExit(main())
