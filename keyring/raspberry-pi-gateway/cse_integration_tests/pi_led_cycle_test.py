"""Opt-in real team API/CSE bench rehearsal with a software Feather peer."""
import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from bubble_gateway.config import GatewayConfig
from bubble_gateway.service import Gateway
from helpers import device_receipt, observation
from pi_led_cycle import DEVICE, FIRMWARE, GATEWAY, verify_database


class SoftwareFeather:
    def __init__(self):
        self.state = False
        self.applied = []

    async def start(self, callback):
        async def observe():
            sequence = 0
            while True:
                sequence += 1
                await callback(observation(gatewayId=GATEWAY, deviceId=DEVICE, sequence=sequence,
                                           state=self.state, firmwareRevision=FIRMWARE))
                await asyncio.sleep(0.25)
        self.task = asyncio.create_task(observe())

    def snapshot(self):
        return [{"deviceId": DEVICE, "connected": True, "firmwareRevision": FIRMWARE}]

    def command_session(self, device_id):
        return 1 if device_id == DEVICE else None

    async def execute(self, command, budget_ms, digest, *, expected_generation):
        if budget_ms <= 0 or expected_generation != 1:
            raise ValueError("invalid simulated session or budget")
        self.state = command["desiredState"]["state"]
        self.applied.append(self.state)
        return device_receipt(command, digest, readback={"state": self.state}, firmwareRevision=FIRMWARE)

    async def close(self):
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)


class PiLedCycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        root = tempfile.TemporaryDirectory(prefix="keyring-led-cycle-test-")
        self.addCleanup(root.cleanup)
        self.root = Path(root.name)
        self.output = self.root / "fixture"

    async def start_fixture(self, *mode):
        path = Path(__file__).with_name("pi_daemon_fixture.py")
        self.process = await asyncio.create_subprocess_exec(
            sys.executable, str(path), "--team-ref", os.environ["KEYRING_TEST_TEAM_REF"], "--seconds", "40",
            "--output", str(self.output), *mode, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        self.addAsyncCleanup(self.stop_fixture)
        await self.wait_for_line("STACK_READY", 45)

    async def wait_for_line(self, expected, seconds=12):
        async with asyncio.timeout(seconds):
            while line := await self.process.stdout.readline():
                if line.decode().strip() == expected:
                    return
                print(line.decode().rstrip(), flush=True)
        self.fail(f"Fixture exited before {expected}")

    async def stop_fixture(self):
        if self.process.returncode is None:
            if self.output.is_dir():
                (self.output / "STOP").touch()
            rest, _ = await asyncio.wait_for(self.process.communicate(), 60)
            if rest:
                print(rest.decode().rstrip(), flush=True)
        self.assertEqual(self.process.returncode, 0)
        self.assertFalse((self.output / "pi-client.tgz").exists())
        self.assertEqual(json.loads((self.output / "cleanup.json").read_text()), {
            "ownedStackClosed": True, "centralExited": True})

    async def test_default_fixture_is_command_free(self):
        await self.start_fixture()
        await self.stop_fixture()
        result = json.loads((self.output / "readback.json").read_text())
        self.assertEqual(result["remainingCentralCommands"], 0)
        self.assertFalse((self.output / "led-cycle.json").exists())

    async def test_led_cycle_checks_two_delivered_receipts_and_the_sqlite_journal(self):
        await self.start_fixture("--led-cycle")
        bundle = self.root / "client"
        bundle.mkdir()
        with tarfile.open(self.output / "pi-client.tgz") as archive:
            self.assertEqual(set(archive.getnames()), {"trusted.pem", "client.pem", "client.key"})
            for member in archive:
                with archive.extractfile(member) as contents:
                    (bundle / member.name).write_bytes(contents.read())
        endpoints = json.loads((self.output / "endpoints.json").read_text())
        paths = endpoints["containers"]
        env = {
            "GATEWAY_ID": GATEWAY, "M2M_ORIGINATOR": endpoints["originator"], "M2M_CSE_ID": endpoints["cseId"],
            "M2M_CSE_URL": endpoints["cse"], "PC_API_URL": endpoints["central"], "M2M_RVI": "4",
            "M2M_OBSERVATION_CONTAINER": paths["observation"], "M2M_RECEIPT_CONTAINER": paths["receipt"],
            "M2M_HEALTH_CONTAINER": paths["health"], "MQTT_ENABLED": "false", "POLL_INTERVAL": "0.5",
            "TLS_CA_FILE": str(bundle / "trusted.pem"), "TLS_CERT_FILE": str(bundle / "client.pem"),
            "TLS_KEY_FILE": str(bundle / "client.key"), "GATEWAY_DATABASE": str(self.root / "gateway.sqlite3"),
            "FIRMWARE_REVISION_ALLOWLIST": FIRMWARE, "BLE_DEVICES": json.dumps({DEVICE: "00:00:00:00:00:01"}),
        }
        with patch.dict(os.environ, env, clear=True):
            cfg = GatewayConfig.from_env()
        gateway = Gateway(cfg)
        feather = gateway.ble = SoftwareFeather()
        runner = asyncio.create_task(gateway.run())
        try:
            await self.wait_for_line("LED_ON_READY")
            await asyncio.sleep(0.7)
            self.assertEqual(feather.applied, [])
            (self.output / "LED_ON").touch()
            await self.wait_for_line("LED_ON_RECORDED")
            await self.wait_for_line("LED_OFF_READY")
            await asyncio.sleep(0.7)
            self.assertEqual(feather.applied, [True])
            (self.output / "LED_OFF").touch()
            await self.wait_for_line("LED_OFF_RECORDED")
            self.assertEqual(feather.applied, [True, False])
        finally:
            gateway.stop.set()
            await asyncio.wait_for(runner, 10)
        await self.stop_fixture()
        evidence_path = self.output / "led-cycle.json"
        grant_ids = set()
        for label, step in zip(("on", "off"), json.loads(evidence_path.read_text())["steps"]):
            intent = json.loads((self.output / f"led-{label}-intent.json").read_text())["request"]
            revoked = json.loads((self.output / f"led-{label}-grant-revoked.json").read_text())
            self.assertEqual(intent["commandId"], step["command"]["commandId"])
            self.assertEqual(intent["grantId"], revoked["grantId"])
            self.assertEqual(revoked["status"], "REVOKED")
            grant_ids.add(revoked["grantId"])
        self.assertEqual(len(grant_ids), 2)
        verifier = await asyncio.create_subprocess_exec(
            sys.executable, str(Path(__file__).with_name("pi_led_cycle.py")),
            "--evidence", str(evidence_path), "--database", str(cfg.database),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(verifier.communicate(), 10)
        self.assertEqual(verifier.returncode, 0, stderr.decode())
        verified = json.loads(stdout)
        self.assertEqual([item["state"] for item in verified["commands"]], [True, False])
        self.assertIsNone(verified["physicalLedObserved"])
        changed = deepcopy(json.loads(evidence_path.read_text()))
        changed["steps"][1]["cseReceipt"]["readback"]["state"] = True
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            verify_database(changed, cfg.database)
        print(json.dumps({"simulatedOutputs": feather.applied, "cseReceipts": len(verified["commands"]),
                          "databaseBindingsVerified": verified["dataBindingsVerified"],
                          "alteredReceiptRejected": True, "physicalLedObserved": None}), flush=True)


if __name__ == "__main__":
    unittest.main()
