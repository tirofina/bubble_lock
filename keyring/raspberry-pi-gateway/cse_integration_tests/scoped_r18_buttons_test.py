from contextlib import closing
from pathlib import Path
import tempfile
import unittest

from bubble_gateway.model import central_observation_id, payload_hash
from bubble_gateway.store import Store
from helpers import BINDING, observation
from pi_led_cycle import content_name
from scoped_r18_buttons import capture_buttons, compare_buttons
from scoped_r18_pulse import GATEWAY, PATHS, R18_BOARD, R18_DEVICE, SUBJECT


class ScopedR18ButtonsTests(unittest.IsolatedAsyncioTestCase):
    async def test_button_evidence_requires_ordered_telemetry_and_the_bound_panic_incident(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log, database = root / "pi.log", root / "pi.sqlite"
            stamp = "2026-11-11T09:00:00.000Z"
            firmware, boot, gateway_boot = "keyring-0.7.21-bringup", "r18-boot", "pi-boot"
            usb = {"bootId": boot, "logSha256": "a" * 64}
            scope = {"contractId": "privacy-bubble.integration.v1", "docRevision": "2.0.0"}
            binding = dict(BINDING, bindingVersion=3, gatewayId=GATEWAY, originator="Sscoped-r18-gateway-b",
                           cseId="Mobius4", cseDeploymentId="scoped-mobius4", pcApiDeploymentId="scoped-command-api-r18",
                           observationContainer=PATHS["observation"], observationContainerRi="cnt-obs",
                           healthContainer=PATHS["health"], healthContainerRi="cnt-health")
            states = (("released", [0, 0]), ("confirm", [1, 0]), ("confirm", [1, 0]),
                      ("released", [1, 0]), ("panic", [1, 1]), ("released", [1, 1]))
            resources, lines, events = {}, [], []
            with closing(Store(database, 100, 100000, 20, binding)) as store:
                for sequence, (state, presses) in enumerate(states):
                    sample = observation(gatewayId=GATEWAY, deviceId=R18_DEVICE, bootId=boot, sequence=sequence,
                                         observedAt=stamp, receivedAt=stamp, firmwareRevision=firmware, buttonState=state,
                                         state=False, sensorValues={"fault": False, "journal": "disabled",
                                                                    "batteryAlert": False, "buttonPresses": presses})
                    store.observation(PATHS["observation"], sample, central_enabled=True)
                    rqi = Store.request_id("observation", f"{R18_DEVICE}:{boot}:{sequence}")
                    observation_id, digest = central_observation_id(sample), payload_hash(sample)
                    store.delivered(rqi)
                    store.delivered(Store.request_id("central-telemetry", observation_id))
                    name = content_name(rqi)
                    resources[name] = {"ty": 4, "rn": name, "pi": "cnt-obs", "ri": f"cin-{sequence}", "con": sample}
                    lines.append(f"Native observation confirmed rqi={rqi} payloadSha256={digest} "
                                 f"route=https created=true gatewayBootId={gateway_boot}\n")
                    events.append(dict(scope, type="GATEWAY_TELEMETRY_ACCEPTED", eventId=f"evt-{sequence}",
                                       gatewayId=GATEWAY, deviceId=R18_DEVICE, observationId=observation_id,
                                       payloadHash=digest, observedAt=stamp, timestamp=stamp, sequence=sequence,
                                       simulation=False))
            log.write_text("".join(lines), encoding="ascii")
            health_rqi = Store.request_id("health", f"{gateway_boot}:{stamp}")
            health = {"ty": 4, "rn": content_name(health_rqi), "ri": "cin-health", "pi": "cnt-health",
                      "con": {"gatewayId": GATEWAY, "bootId": gateway_boot, "observedAt": stamp,
                              "credentialStatus": "ACTIVE", "commandCount": 0, "devices": [
                                  {"deviceId": R18_DEVICE, "bootId": boot, "boardRevision": R18_BOARD,
                                   "firmwareRevision": firmware, "connected": True, "commandReady": False}]}}
            baseline = {"teamRevision": "rev", "firmwareRevision": firmware, "usbLogSha256": usb["logSha256"],
                        "observationContainerRi": "cnt-obs", "healthContainerRi": "cnt-health", "health": health,
                        "native": next(iter(resources.values())), "startedAt": stamp, "capturedAt": stamp}

            async def cse(method, path):
                self.assertEqual(method, "GET")
                return 200, 2000, {"m2m:cin": resources[path.rsplit("/", 1)[-1]]}

            bundle = await capture_buttons(cse, baseline, log)
            panic_id = events[4]["observationId"]
            incident = {"observationId": panic_id, "incidentId": "incident-a", "householdId": SUBJECT,
                        "deviceId": R18_DEVICE, "observedAt": stamp, "acceptedAt": stamp, "latencyMs": 0,
                        "status": "INCIDENT_OPENED", "simulation": False}
            portal = {key: incident[key] for key in ("incidentId", "householdId", "deviceId")}
            team = {"receipts": events, "deviceIncidentEvents": {}, "portalIncidents": {"incident-a": dict(portal, kind="SAFETY")}}

            def compare():
                return compare_buttons(bundle, baseline, usb, log, database, team, payload_hash)

            with self.assertRaisesRegex(ValueError, "without a matching panic incident"):
                compare()
            team["deviceIncidentEvents"][panic_id] = incident
            events.append(dict(scope, type="DEVICE_PANIC_RECONCILED", eventId="evt-panic", timestamp=stamp, **incident))
            report = compare()
            self.assertEqual(report["centralSequences"], [0, 1, 3, 4, 5])
            self.assertEqual(report["panicIncident"]["eventId"], "evt-panic")

            events[4]["sequence"] = 2
            with self.assertRaisesRegex(ValueError, "did not preserve button order"):
                compare()
            events[4]["sequence"] = 4
            incident["simulation"] = True
            with self.assertRaisesRegex(ValueError, "physical scoped observation"):
                compare()
