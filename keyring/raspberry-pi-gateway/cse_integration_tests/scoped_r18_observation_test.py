from contextlib import closing
from pathlib import Path
import tempfile
import unittest

from bubble_gateway.model import central_observation_id, payload_hash
from bubble_gateway.store import Store
from helpers import BINDING, observation
from pi_led_cycle import content_name
from scoped_r18_observation import compare_observation
from scoped_r18_pulse import GATEWAY, PATHS, R18_BOARD, R18_DEVICE


class ScopedR18ObservationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.database = Path(temporary.name) / "pi.sqlite3"
        self.firmware = "keyring-0.7.15-bringup"
        stamp = "2026-11-11T09:00:02.000Z"
        self.usb = {"bootId": "r18-boot", "logSha256": "a" * 64}
        self.observation = observation(gatewayId=GATEWAY, deviceId=R18_DEVICE, bootId=self.usb["bootId"],
                                       sequence=8, observedAt=stamp, receivedAt=stamp, firmwareRevision=self.firmware,
                                       sensorValues={"fault": False, "journal": "disabled", "batteryAlert": False})
        rqi = Store.request_id("observation", f"{R18_DEVICE}:r18-boot:8")
        native = {"ty": 4, "rn": content_name(rqi), "ri": "cin-observation", "pi": "cnt-observation",
                  "con": self.observation}
        heartbeat = {"gatewayId": GATEWAY, "bootId": "gateway-boot", "observedAt": stamp,
                     "credentialStatus": "ACTIVE", "commandCount": 0, "devices": [
                         {"deviceId": R18_DEVICE, "bootId": self.usb["bootId"], "boardRevision": R18_BOARD,
                          "firmwareRevision": self.firmware, "connected": True, "commandReady": False}]}
        health = {"ty": 4, "rn": content_name(Store.request_id("health", f"gateway-boot:{stamp}")),
                  "ri": "cin-health", "pi": "cnt-health", "con": heartbeat}
        self.capture = {"startedAt": "2026-11-11T09:00:00.000Z", "capturedAt": stamp, "firmwareRevision": self.firmware,
                        "usbLogSha256": self.usb["logSha256"], "observationContainerRi": "cnt-observation",
                        "healthContainerRi": "cnt-health", "native": native, "health": health}
        self.event = {"type": "GATEWAY_TELEMETRY_ACCEPTED", "contractId": "privacy-bubble.integration.v1",
                      "docRevision": "2.0.0", "eventId": "telemetry-a", "gatewayId": GATEWAY, "deviceId": R18_DEVICE,
                      "observationId": central_observation_id(self.observation), "payloadHash": payload_hash(self.observation),
                      "observedAt": stamp, "timestamp": stamp, "sequence": 21}
        binding = dict(BINDING, bindingVersion=3, gatewayId=GATEWAY, originator="Sscoped-r18-gateway-b", cseId="Mobius4",
                       cseDeploymentId="scoped-mobius4", pcApiDeploymentId="scoped-command-api-r18",
                       observationContainer=PATHS["observation"], observationContainerRi="cnt-observation")
        with closing(Store(self.database, 100, 100000, 20, binding)) as store:
            store.observation(PATHS["observation"], self.observation, central_enabled=True)
            store.delivered(rqi)

    def compare(self, events):
        return compare_observation(self.capture, self.usb, self.database, {"receipts": events}, payload_hash)

    def test_central_acceptance_binds_content_and_keeps_pending_pi_state(self):
        self.assertFalse(self.compare([])["centralTelemetryAccepted"])
        report = self.compare([self.event])
        self.assertTrue(report["centralTelemetryAccepted"])
        self.assertFalse(report["nativePendingOnPi"])
        self.assertTrue(report["centralPendingOnPi"])
        self.assertEqual(report["piWatermarkSequence"], 8)
        self.assertEqual(report["centralEvent"]["eventId"], "telemetry-a")
        with self.assertRaisesRegex(ValueError, "inconsistent GATEWAY_TELEMETRY_ACCEPTED"):
            self.compare([dict(self.event, payloadHash="b" * 64)])

    def test_rejects_another_usb_boot_and_mismatched_health_container(self):
        with self.assertRaisesRegex(ValueError, "captured USB boot"):
            compare_observation(self.capture, dict(self.usb, bootId="foreign-boot"), self.database,
                                {"receipts": []}, payload_hash)
        self.capture["health"]["pi"] = "cnt-other"
        with self.assertRaisesRegex(ValueError, "pinned container"):
            self.compare([self.event])
