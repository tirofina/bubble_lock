import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from bubble_gateway.model import central_observation_id, iso_time, payload_hash
from bubble_gateway.store import Store
from pi_led_cycle import content_name, receipt_name
from scoped_r18_pulse import GATEWAY, PATHS, R18_BOARD, R18_COMMAND_FIRMWARE, R18_DEVICE, run_pulse


class R18PulseTests(unittest.IsolatedAsyncioTestCase):
    now = datetime(2026, 11, 11, tzinfo=timezone.utc)
    command_path = f"/api/v1/gateways/{GATEWAY}/commands"
    pins = {"observation": "cnt-observation", "health": "cnt-health", "receipt": "cnt-receipt"}

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name)
        self.posts = []
        self.issued = None
        self.fail_issue = False
        self.trigger = "PULSE"
        self.replaced_parent = None
        self.replace_receipt_route = False
        self.proof = AsyncMock(return_value={"dispatchEventId": "dispatch-a", "settlementEventId": "settlement-a"})
        self.telemetry_proof = AsyncMock(side_effect=self.central_observation)

    async def central_observation(self, observation):
        self.assertEqual(self.posts[-1], "/v1/grants/revoke")
        self.assertTrue((self.output / "pulse-result.json").is_file())
        return {"eventId": "telemetry-a", "observationId": central_observation_id(observation),
                "payloadHash": observation["payloadHash"], "sequence": 9, "observedAt": observation["observedAt"],
                "timestamp": iso_time(self.now)}

    async def cse(self, method, path):
        self.assertEqual(method, "GET")
        timestamp = iso_time(self.now)
        if path == PATHS["receipt"]:
            parent = self.pins["receipt"]
            if self.replace_receipt_route and (self.output / "PULSE").is_file():
                parent = "cnt-replacement"
            return 200, 2000, {"m2m:cnt": {"ri": parent}}
        if path == PATHS["health"] + "/la":
            native = {"ri": "cin-health", "pi": "cnt-health",
                      "con": {"gatewayId": GATEWAY, "bootId": "gateway-boot", "observedAt": timestamp,
                              "credentialStatus": "ACTIVE", "devices": [
                                  {"deviceId": R18_DEVICE, "bootId": "r18-boot", "boardRevision": R18_BOARD,
                                   "firmwareRevision": R18_COMMAND_FIRMWARE, "connected": True, "commandReady": True}]}}
        elif path == PATHS["observation"] + "/la":
            sequence = 6 if self.issued else 5
            rqi = Store.request_id("observation", f"{R18_DEVICE}:r18-boot:{sequence}")
            native = {"ty": 4, "rn": content_name(rqi), "ri": f"cin-{sequence}", "pi": "cnt-observation",
                      "con": {"gatewayId": GATEWAY, "deviceId": R18_DEVICE, "bootId": "r18-boot",
                              "firmwareRevision": R18_COMMAND_FIRMWARE, "state": False, "sequence": sequence,
                              "observedAt": timestamp, "receivedAt": timestamp, "sensorValues": {"fault": False}}}
        else:
            command = self.issued
            self.assertEqual(path, f"{PATHS['receipt']}/{receipt_name(command['commandId'])}")
            receipt = {key: command[key] for key in ("gatewayId", "deviceId", "commandId", "grantRevision", "ownershipEpoch")}
            receipt.update(payloadHash=payload_hash(command), status="APPLIED", ackCode="APPLIED",
                           firmwareRevision=R18_COMMAND_FIRMWARE, bootId="r18-boot", receivedAt=timestamp,
                           readback={"state": True})
            native = {"ri": "cin-receipt", "pi": "cnt-receipt", "ct": "20261111T000000", "con": receipt}
        if self.replaced_parent == native["pi"] and (self.output / "PULSE").is_file():
            native["pi"] = "cnt-replacement"
        return 200, 2000, {"m2m:cin": native}

    async def post(self, path, body):
        self.posts.append(path)
        if path == "/v1/consents":
            return 201, {"consentId": "consent-a"}
        if path == "/v1/grants":
            return 201, {"grantId": "grant-a"}
        if path == "/v1/grants/revoke":
            return 200, {"grantId": "grant-a", "status": "REVOKED"}
        self.assertEqual(path, self.command_path)
        self.assertTrue((self.output / "PULSE").is_file())
        self.assertTrue((self.output / "pulse-intent.json").is_file())
        if self.fail_issue:
            raise TimeoutError("Command response lost")
        self.issued = {key: body[key] for key in ("commandId", "deviceId", "desiredState", "deadline")}
        self.issued.update(version=1, gatewayId=GATEWAY, claimId="claim-a", grantRevision=1, ownershipEpoch=1,
                           issuedAt=iso_time(self.now))
        return 201, self.issued

    def trigger_after_ready(self, message, **_kwargs):
        if message == "R18_PULSE_READY":
            self.assertEqual(self.posts, [])
            (self.output / self.trigger).touch()

    async def exercise(self):
        with (patch("scoped_r18_pulse.utc_now", return_value=self.now),
              patch("pi_led_cycle.utc_now", return_value=self.now),
              patch("builtins.print", side_effect=self.trigger_after_ready)):
            async with asyncio.timeout(1):
                await run_pulse(self.post, self.cse, self.proof, self.output, pins=self.pins,
                                observation_hasher=payload_hash, telemetry_proof=self.telemetry_proof)

    async def test_one_command_then_same_boot_off_and_revocation(self):
        await self.exercise()
        self.assertEqual(self.posts, ["/v1/consents", "/v1/grants", self.command_path, "/v1/grants/revoke"])
        self.proof.assert_awaited_once()
        result = json.loads((self.output / "pulse-result.json").read_text(encoding="utf-8"))
        scope = json.loads((self.output / "pulse-scope.json").read_text(encoding="utf-8"))
        self.assertEqual(scope["containerPins"], self.pins)
        self.assertEqual(result["commandId"], self.issued["commandId"])
        self.assertEqual(result["postPulseObservation"]["sequence"], 6)
        self.assertIsNone(result["physicalPulseMeasured"])
        central = json.loads((self.output / "pulse-central-telemetry.json").read_text(encoding="utf-8"))
        self.assertEqual(central["eventId"], "telemetry-a")
        self.telemetry_proof.assert_awaited_once()

    async def test_central_telemetry_timeout_retains_off_observation_and_revocation(self):
        self.telemetry_proof.side_effect = TimeoutError
        with self.assertRaisesRegex(RuntimeError, "local pulse evidence was retained"):
            await self.exercise()
        self.assertEqual(self.posts[-1], "/v1/grants/revoke")
        self.assertTrue((self.output / "pulse-observation.json").is_file())
        self.assertFalse((self.output / "pulse-central-telemetry.json").exists())

    async def test_lost_issue_response_keeps_intent_and_revokes_without_retry(self):
        self.fail_issue = True
        with self.assertRaisesRegex(TimeoutError, "response lost"):
            await self.exercise()
        self.assertEqual(self.posts.count(self.command_path), 1)
        self.assertEqual(self.posts[-1], "/v1/grants/revoke")
        self.assertTrue((self.output / "pulse-intent.json").exists())
        self.assertTrue((self.output / "pulse-grant-revoked.json").exists())
        self.assertFalse((self.output / "pulse-result.json").exists())

    async def test_stop_after_readiness_does_not_create_a_grant(self):
        self.trigger = "STOP"
        with self.assertRaisesRegex(RuntimeError, "Stopped"):
            await self.exercise()
        self.assertEqual(self.posts, [])

    async def test_replaced_health_container_after_readiness_stops_before_grant(self):
        self.replaced_parent = self.pins["health"]
        with self.assertRaisesRegex(RuntimeError, "health parent differs"):
            await self.exercise()
        self.assertEqual(self.posts, [])

    async def test_replaced_receipt_container_cannot_complete_the_pulse(self):
        self.replaced_parent = self.pins["receipt"]
        with self.assertRaisesRegex(RuntimeError, "receipt parent differs"):
            await self.exercise()
        self.assertEqual(self.posts[-1], "/v1/grants/revoke")
        self.proof.assert_not_awaited()
        self.assertFalse((self.output / "pulse-result.json").exists())

    async def test_replaced_receipt_route_after_readiness_stops_before_grant(self):
        self.replace_receipt_route = True
        with self.assertRaisesRegex(RuntimeError, "receipt route differs"):
            await self.exercise()
        self.assertEqual(self.posts, [])
