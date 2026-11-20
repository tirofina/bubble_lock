"""R02 protocol matrix: the complete Gateway daemon with emulated GATT keyrings.

Started by pc-mobius/scripts/run-protocol-matrix-real.mjs, which owns the real Mobius4,
MQTT broker, CSE HTTPS front and central API. This process runs ``Gateway.run()`` with every
worker (credential, command poll, dispatch, outbox, health). Only Bleak is replaced: each
emulated keyring answers GATT reads and sends LF-framed JSON notifications in the 20-byte
fragments used by keyring/firmware/src/main.cpp. Control arrives as JSON lines on stdin;
records are written as JSON lines under --output.
"""
import argparse
import asyncio
from collections import Counter
import hashlib
import json
import logging
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

from bubble_gateway.config import GatewayConfig, read_env_file
from bubble_gateway.service import Gateway

FRAGMENT = 20  # keyring/firmware/src/main.cpp sends notifications in 20-byte fragments.
LOG = logging.getLogger("protocol_matrix")


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


class Keyring:
    def __init__(self, device_id, address, boot_id, index):
        self.device_id, self.address, self.boot_id, self.index = device_id, address, boot_id, index
        self.sequence, self.started = 0, time.monotonic()
        self.callbacks, self.connected = {}, False

    def frame(self):
        return {"version": 1, "deviceId": self.device_id, "bootId": self.boot_id, "sequence": self.sequence,
                "uptimeMs": int((time.monotonic() - self.started) * 1000), "battery": 80 - self.index % 7,
                "buttonState": "released", "sensorValues": {"batteryAlert": False, "buttonPresses": [0, 0]},
                "state": False}


class Emulator:
    def __init__(self, gateway, output):
        self.gateway, self.output = gateway, output
        self.fleet = gateway.ble
        token = hashlib.sha256(output.name.encode()).hexdigest()[:8]
        self.keyrings = {device: Keyring(device, address, f"boot-pm-{token}-{index:02d}", index)
                         for index, (device, address) in enumerate(gateway.config.ble_devices.items())}
        self.by_address = {k.address.casefold(): k for k in self.keyrings.values()}
        self.emits = (output / "emits.jsonl").open("a", encoding="utf-8")
        self.cursor = 0

    def classes(self):
        emulator, fleet = self, self.fleet

        class Scanner:
            def __init__(self, detection_callback):
                self.detect, self.task = detection_callback, None

            async def advertise(self):
                while True:
                    for keyring in emulator.keyrings.values():
                        self.detect(SimpleNamespace(address=keyring.address), SimpleNamespace(rssi=-58 - keyring.index % 9))
                    await asyncio.sleep(1)

            async def __aenter__(self):
                self.task = asyncio.create_task(self.advertise())
                return self

            async def __aexit__(self, *_):
                self.task.cancel()

        class Client:
            def __init__(self, device, *, pair, disconnected_callback=None, **_):
                if not pair:
                    raise RuntimeError("pairing must stay required")
                self.keyring = emulator.by_address[device.address.casefold()]
                self.is_connected = False
                self.services = SimpleNamespace(get_service=lambda _: SimpleNamespace(
                    get_characteristic=lambda uuid: SimpleNamespace(properties=["write"]) if uuid == fleet.command_uuid else None))

            async def __aenter__(self):
                self.is_connected = self.keyring.connected = True
                return self

            async def __aexit__(self, *_):
                self.is_connected = self.keyring.connected = False

            async def read_gatt_char(self, uuid):
                k = self.keyring
                if uuid == fleet.identity_uuid:
                    return compact({"version": 1, "deviceId": k.device_id, "firmwareRevision": "keyring-0.7.0",
                                    "boardRevision": "r18", "bootId": k.boot_id}).encode()
                return compact(k.frame()).encode()

            async def start_notify(self, uuid, callback):
                self.keyring.callbacks[uuid] = callback

            async def write_gatt_char(self, *_args, **_kwargs):
                raise RuntimeError("the protocol matrix issues no commands")

        return Scanner, Client

    def emit(self, phase):
        ready = [k for k in self.keyrings.values() if fleet_ready(self.fleet, k.device_id)]
        if not ready:
            return None
        keyring = ready[self.cursor % len(ready)]
        self.cursor += 1
        keyring.sequence += 1
        raw = compact(keyring.frame()).encode() + b"\n"
        callback = keyring.callbacks[self.fleet.observation_uuid]
        emitted = time.time_ns()
        for offset in range(0, len(raw), FRAGMENT):
            callback(None, bytearray(raw[offset:offset + FRAGMENT]))
        identity = f"{keyring.device_id}:{keyring.boot_id}:{keyring.sequence}"
        record = {"phase": phase, "deviceId": keyring.device_id, "bootId": keyring.boot_id, "sequence": keyring.sequence,
                  "emitNs": emitted, "gattBytes": len(raw), "notifications": -(-len(raw) // FRAGMENT),
                  "rqi": self.gateway.store.request_id("observation", identity)}
        self.emits.write(compact(record) + "\n")
        self.emits.flush()
        return record


def fleet_ready(fleet, device_id):
    return fleet.command_session(device_id) is not None


def classify(config, container, payload):
    if container == config.observation_container:
        return "observation"
    if container == config.health_container:
        return "credential-receipt" if "credentialTransition" in payload else "health"
    if container == config.receipt_container:
        return "command-receipt"
    return container


async def control(gateway, emulator, output, commands, files):
    transport = gateway.transport
    publishes = (output / "publishes.jsonl").open("a", encoding="utf-8")
    events = (output / "transport-events.jsonl").open("a", encoding="utf-8")
    # Closed by amain after Gateway.run returns, so in-flight publishes during shutdown are recorded.
    files.extend((publishes, events, emulator.emits))
    stored = {}
    original_publish, original_observation = transport.publish, gateway.observation

    async def observed(raw, *args, **options):
        await original_observation(raw, *args, **options)
        stored[(raw.get("deviceId"), raw.get("bootId"), raw.get("sequence"))] = time.time_ns()

    async def timed(rqi, container, payload, **options):
        before, started, error = Counter(transport.route_counters), time.time_ns(), None
        try:
            return await original_publish(rqi, container, payload, **options)
        except BaseException as exc:
            error = type(exc).__name__
            raise
        finally:
            delta = transport.route_counters - before
            kind = classify(gateway.config, container, payload)
            key = (payload.get("deviceId"), payload.get("bootId"), payload.get("sequence"))
            publishes.write(compact({
                "rqi": rqi, "kind": kind, "startNs": started, "endNs": time.time_ns(), "error": error,
                "routes": sorted(delta), "payloadBytes": len(compact(payload).encode()),
                "deviceId": payload.get("deviceId") if kind == "observation" else None,
                "sequence": payload.get("sequence") if kind == "observation" else None,
                "storedNs": stored.pop(key, None) if kind == "observation" else None}) + "\n")
            publishes.flush()

    transport.publish, gateway.observation = timed, observed

    def say(event, **fields):
        line = compact({"event": event, "atNs": time.time_ns(), **fields})
        events.write(line + "\n")
        events.flush()
        print(line, flush=True)

    async def watch():
        ready, unconfirmed = None, None
        while True:
            now_ready, now_unconfirmed = transport._ready.is_set(), transport._unconfirmed_until is not None
            if now_ready != ready:
                say("mqttReady" if now_ready else "mqttDown")
                ready = now_ready
            if now_unconfirmed != unconfirmed:
                say("mqttUnconfirmed" if now_unconfirmed else "mqttConfirmed")
                unconfirmed = now_unconfirmed
            await asyncio.sleep(0.01)

    watcher = asyncio.create_task(watch())
    try:
        while True:
            message = await commands.get()
            op = message.get("op")
            if op == "status":
                outbox, command_count = gateway.store.counts()
                say("status", outbox=outbox, commands=command_count, mqttReady=transport._ready.is_set(),
                    unconfirmed=transport._unconfirmed_until is not None,
                    bleReady=sum(fleet_ready(gateway.ble, d) for d in gateway.config.ble_devices),
                    routeCounters=dict(transport.route_counters), counters=dict(gateway.counters))
            elif op == "emit":
                count, interval = int(message["count"]), float(message["intervalMs"]) / 1000
                emitted = 0
                next_at = time.monotonic()
                for _ in range(count):
                    if emulator.emit(message["phase"]) is not None:
                        emitted += 1
                    next_at += interval
                    await asyncio.sleep(max(0, next_at - time.monotonic()))
                say("emitDone", phase=message["phase"], count=emitted)
            elif op == "stop":
                outbox, _ = gateway.store.counts()
                say("stopping", outbox=outbox, routeCounters=dict(transport.route_counters), counters=dict(gateway.counters))
                gateway.stop.set()
                return
    finally:
        watcher.cancel()


def stdin_commands(loop, queue):
    for line in sys.stdin:
        line = line.strip()
        if line:
            loop.call_soon_threadsafe(queue.put_nowait, json.loads(line))
    loop.call_soon_threadsafe(queue.put_nowait, {"op": "stop"})


async def amain(args):
    read_env_file(args.env_file)
    config = GatewayConfig.from_env()
    gateway = Gateway(config)
    emulator = Emulator(gateway, args.output)
    scanner, client = emulator.classes()
    commands = asyncio.Queue()
    threading.Thread(target=stdin_commands, args=(asyncio.get_running_loop(), commands), daemon=True).start()
    files = []
    try:
        with patch("bubble_gateway.ble.BleakScanner", scanner), patch("bubble_gateway.ble.BleakClient", client):
            runner = asyncio.create_task(gateway.run(), name="gateway")
            controller = asyncio.create_task(control(gateway, emulator, args.output, commands, files), name="control")
            async with asyncio.timeout(30):
                while not all(fleet_ready(gateway.ble, d) for d in config.ble_devices):
                    if runner.done():
                        runner.result()
                    await asyncio.sleep(0.05)
            print(compact({"event": "ready", "atNs": time.time_ns(), "devices": len(config.ble_devices),
                           "version": __import__("bubble_gateway").__version__}), flush=True)
            done, _ = await asyncio.wait({runner, controller}, return_when=asyncio.FIRST_COMPLETED)
            if runner in done:
                controller.cancel()
                runner.result()
            await runner
    except BaseException:
        LOG.exception("protocol matrix daemon stopped with an error")
        raise
    finally:
        for handle in files:
            handle.close()
    print(compact({"event": "stopped", "atNs": time.time_ns()}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=args.output / "gateway.log", level=logging.INFO,
                        format="%(asctime)s.%(msecs)03d %(levelname)s %(name)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S")
    for name in ("httpx", "httpcore", "bleak"):
        logging.getLogger(name).setLevel(logging.WARNING)
    asyncio.run(amain(args))


if __name__ == "__main__":
    main()
