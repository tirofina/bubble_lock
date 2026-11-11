from contextlib import closing
from pathlib import Path
import tempfile
import unittest

from bubble_gateway.model import central_observation_id, payload_hash
from bubble_gateway.store import Store
from helpers import BINDING, observation
from pi_led_cycle import content_name
from scoped_r18_observation import compare_observation, comparison_passed, inspect_location_response
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
                      "observedAt": stamp, "timestamp": stamp, "sequence": 21, "simulation": False}
        self.binding = dict(BINDING, bindingVersion=3, gatewayId=GATEWAY, originator="Sscoped-r18-gateway-b", cseId="Mobius4",
                            cseDeploymentId="scoped-mobius4", pcApiDeploymentId="scoped-command-api-r18",
                            observationContainer=PATHS["observation"], observationContainerRi="cnt-observation",
                            healthContainer=PATHS["health"], healthContainerRi="cnt-health")
        self.create_database(self.database, self.binding)

    def create_database(self, database, binding):
        with closing(Store(database, 100, 100000, 20, binding)) as store:
            store.observation(PATHS["observation"], self.observation, central_enabled=True)
            store.delivered(Store.request_id("observation", f"{R18_DEVICE}:{self.usb['bootId']}:{self.observation['sequence']}"))

    def compare(self, events):
        return compare_observation(self.capture, self.usb, self.database, {"receipts": events}, payload_hash)

    def test_central_acceptance_binds_content_and_keeps_pending_pi_state(self):
        pending = self.compare([])
        self.assertFalse(pending["centralTelemetryAccepted"])
        self.assertFalse(comparison_passed(pending, require_physical=True))
        report = self.compare([self.event])
        self.assertTrue(report["centralTelemetryAccepted"])
        self.assertFalse(report["nativePendingOnPi"])
        self.assertTrue(report["centralPendingOnPi"])
        self.assertTrue(report["healthContainerVerified"])
        self.assertTrue(report["physicalRelayEvidenceMatched"])
        self.assertTrue(comparison_passed(report, require_physical=True))
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
        self.capture["healthContainerRi"] = "cnt-other"
        with self.assertRaisesRegex(ValueError, "differs from the Pi database binding"):
            self.compare([self.event])

    def test_pending_health_body_is_compared_with_mobius4(self):
        with closing(Store(self.database, 100, 100000, 20, self.binding)) as store:
            store.enqueue_heartbeat(self.capture["health"]["con"])
        self.assertTrue(self.compare([self.event])["healthPendingOnPi"])
        self.capture["health"]["con"]["outboxDepth"] = 7
        with self.assertRaisesRegex(ValueError, "Pending Pi payload .* differs"):
            self.compare([self.event])

    def test_simulated_central_acceptance_and_old_unpinned_database_do_not_match_physical_evidence(self):
        report = self.compare([dict(self.event, simulation=True)])
        self.assertTrue(report["centralTelemetryAccepted"])
        self.assertTrue(report["centralEvent"]["simulation"])
        self.assertFalse(report["physicalRelayEvidenceMatched"])
        self.assertFalse(comparison_passed(report, require_physical=True))
        self.assertTrue(comparison_passed(report, require_physical=False))

        old_db = self.database.with_name("unpinned.sqlite3")
        old_binding = dict(self.binding)
        old_binding.pop("healthContainerRi")
        self.create_database(old_db, old_binding)
        report = compare_observation(self.capture, self.usb, old_db, {"receipts": [self.event]}, payload_hash)
        self.assertTrue(report["centralTelemetryAccepted"])
        self.assertIsNone(report["healthContainerVerified"])
        self.assertFalse(report["physicalRelayEvidenceMatched"])
        self.assertFalse(comparison_passed(report, require_physical=True))
        self.assertTrue(comparison_passed(report, require_physical=False))

    def test_location_projection_matches_both_routes_and_checks_scope_and_expiry(self):
        stamp = self.observation["observedAt"]
        ble = {"gatewayId": GATEWAY, "observedAt": stamp, "rssiDbm": self.observation["rssi"], "simulation": False}
        portal = {"path": "/v1/portal/locations", "status": 200, "capturedAt": stamp,
                  "body": {"deviceIds": [R18_DEVICE], "readExpiresAt": "2026-11-11T09:00:07.000Z",
                           "observations": [dict(ble, deviceId=R18_DEVICE)]}}
        web = {"path": "/api/portal/locations", "status": 200, "capturedAt": stamp,
               "body": {"mode": "live", "source": "portal-api", "readExpiresAt": portal["body"]["readExpiresAt"],
                        "devices": [{"deviceId": R18_DEVICE, "ble": ble}]}}
        report = compare_observation(self.capture, self.usb, self.database, {"receipts": [self.event]}, payload_hash,
                                     portal_response=portal, web_response=web)
        self.assertEqual(report["portalLocationResponse"]["status"], "matched")
        self.assertEqual(report["webLocationResponse"]["status"], "matched")
        self.assertTrue(comparison_passed(report, require_physical=True))
        report["webLocationResponse"]["status"] = "observation-missing"
        self.assertFalse(comparison_passed(report, require_physical=True))

        cases = [(dict(portal, status=403), False, "access-denied"),
                 (dict(portal, body=dict(portal["body"], deviceIds=[])), False, "device-outside-response-scope"),
                 (dict(portal, capturedAt=portal["body"]["readExpiresAt"]), False, "expired-at-capture"),
                 (dict(web, body=dict(web["body"], source="combined")), True, "source-unconfirmed")]
        for response, is_web, expected in cases:
            with self.subTest(expected=expected):
                result = inspect_location_response(response, self.observation, self.event, web=is_web)
                self.assertEqual(result["status"], expected)
        ble["rssiDbm"] -= 1
        self.assertEqual(inspect_location_response(web, self.observation, self.event, web=True)["status"],
                         "observation-missing")
