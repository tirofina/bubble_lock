import asyncio
import json
from pathlib import Path
import tempfile
import unittest

from bubble_gateway.model import central_observation_id
from helpers import observation
from scoped_r18_portal_capture import GATEWAY, PORTAL, R18_DEVICE, capture_portal, pair_live_observation


class ScopedR18PortalCaptureTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_pair_uses_central_id_across_delayed_and_overlapping_reads(self):
        native = observation(gatewayId=GATEWAY, deviceId=R18_DEVICE, sequence=1)
        next_native = dict(native, sequence=2)
        first_id, next_id = map(central_observation_id, (native, next_native))
        version = iter((first_id, next_id, next_id, next_id, "later", "later"))
        candidates = iter((native, native, next_native))
        response_body = {"deviceIds": [R18_DEVICE], "observations": [
            {"deviceId": R18_DEVICE, "gatewayId": GATEWAY, "observedAt": native["observedAt"], "rssiDbm": native["rssi"]}
        ]}
        responses = iter(({"body": response_body, "capture": 1}, {"body": response_body, "capture": 2},
                          {"body": {"deviceIds": [], "observations": []}, "capture": 3}))

        async def get_location():
            return next(responses)

        async def read_candidate():
            return {"native": {"con": next(candidates)}}

        async def read_observation_id():
            return next(version)

        async with asyncio.timeout(3):
            captured, response = await pair_live_observation(get_location, read_candidate, read_observation_id)
        self.assertEqual(captured["native"]["con"]["sequence"], 2)
        self.assertEqual(response["observationId"], next_id)
        self.assertEqual(response["capture"], 2)

    async def test_captures_only_inside_lease_and_removes_access_after_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            capture = Path(folder) / "observation.json"
            output = Path(folder) / "portal"
            native = observation(gatewayId=GATEWAY, deviceId=R18_DEVICE, firmwareRevision="keyring-0.7.15-bringup")
            capture.write_text(json.dumps({"teamRevision": "team", "native": {"con": native}}), encoding="utf-8")
            active = False
            requests = []
            replies = {
                "/v1/consents": (201, {"consentId": "consent"}),
                "/v1/grants": (201, {"grantId": "grant"}),
                "/v1/portal/incidents": (200, {"incidentId": "incident"}),
                "/v1/portal/location-leases": (200, {"leaseId": "lease"}),
                "/v1/portal/location-leases/revoke": (200, {"leaseId": "lease", "status": "REVOKED"}),
                "/v1/grants/revoke": (200, {"grantId": "grant", "status": "REVOKED"}),
                "/v1/portal/consents/revoke": (200, {"consentId": "consent", "status": "REVOKED"}),
                "/v1/portal/incidents/resolve": (200, {"incidentId": "incident", "status": "RESOLVED"}),
            }

            async def request(method, path, body=None):
                nonlocal active
                requests.append((method, path))
                if path == PORTAL:
                    rows = [{"deviceId": R18_DEVICE, "gatewayId": GATEWAY, "rssiDbm": native["rssi"],
                             "observedAt": native["observedAt"]}] if active else []
                    return 200, {"deviceIds": [R18_DEVICE] if active else [], "observations": rows}
                if path == "/v1/portal/location-leases":
                    self.assertEqual(body["deviceIds"], [R18_DEVICE])
                    active = True
                if path == "/v1/portal/location-leases/revoke":
                    active = False
                return replies[path]

            self.assertTrue(await capture_portal(request, output, capture, "team", 1))
            self.assertEqual(requests[0], ("GET", PORTAL))
            self.assertEqual(requests[-1], ("GET", PORTAL))
            report = json.loads((output / "location-trial.json").read_text(encoding="utf-8"))
            self.assertTrue(report["deviceAbsentAfterCleanup"])
            self.assertEqual(report["cleanupConfirmed"], dict(lease=True, grant=True, consent=True, incident=True))
