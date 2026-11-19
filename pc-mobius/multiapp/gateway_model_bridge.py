"""Line-delimited JSON bridge to the Raspberry Pi Gateway's own contract checks.

The R03 emulator (pc-mobius/multiapp/gateway-emulator.mjs) sends each observation and each
command it handles through bubble_gateway.model, so the emulated Gateway write path applies the
same validate_observation / validate_command / payload_hash code the Pi daemon runs.
"""
from __future__ import annotations

import json
import sys

from bubble_gateway.model import payload_hash, validate_command, validate_observation


def handle(request: dict) -> dict:
    kind = request.get("kind")
    devices = request.get("devices") or {}
    gateway_id = request.get("gatewayId")
    if kind == "observation":
        validate_observation(request["payload"], gateway_id, devices)
        return {"ok": True, "payloadHash": payload_hash(request["payload"])}
    if kind == "command":
        command = validate_command(request["payload"], gateway_id, devices)
        return {"ok": True, "payloadHash": payload_hash(command)}
    if kind == "hash":
        return {"ok": True, "payloadHash": payload_hash(request["payload"])}
    raise ValueError("unknown request kind")


def main() -> None:
    sys.stdout.write(json.dumps({"id": 0, "ok": True, "ready": True}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        try:
            response = handle(request)
        except Exception as error:  # noqa: BLE001 - reported to the caller as a contract result
            response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        response["id"] = request.get("id")
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
