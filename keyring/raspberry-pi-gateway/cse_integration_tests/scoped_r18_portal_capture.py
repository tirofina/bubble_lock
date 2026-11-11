"""Read an r18 location response using a temporary approval on the loopback bench."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import uuid

import httpx

from bubble_gateway.model import iso_time, validate_observation
from pi_led_cycle import write_new_json
from scoped_command_io import DEFAULT_HEADERS, exchange, scoped_api, tls_context
from scoped_feather_evidence import read_json
from scoped_feather_pi import R18_BRINGUP_FIRMWARES
from scoped_r18_pulse import GATEWAY, R18_DEVICE, SUBJECT

OPERATOR = "scoped-command-operator-r18"
PURPOSE = "r18-scoped-location-trial"
PORTAL = "/v1/portal/locations"


def matches_observation(response, observation):
    body = response["body"]
    if observation["deviceId"] not in body["deviceIds"]:
        return False
    return any(row.get("deviceId") == observation["deviceId"] and row.get("gatewayId") == observation["gatewayId"]
               and row.get("observedAt") == observation["observedAt"] and type(row.get("rssiDbm")) is int
               and row["rssiDbm"] == observation["rssi"] for row in body["observations"])


def device_visible(response):
    body = response["body"]
    return R18_DEVICE in body["deviceIds"] or any(row.get("deviceId") == R18_DEVICE for row in body["observations"])


async def capture_portal(request, output, capture_path, revision, seconds):
    async def get_location():
        status, body = await request("GET", PORTAL)
        if status != 200 or not isinstance(body, dict):
            raise RuntimeError(f"Scoped location read returned HTTP {status}")
        return {"path": PORTAL, "status": status, "capturedAt": iso_time(), "body": body}

    async def post(path, body, expected=200):
        status, result = await request("POST", path, body)
        if status != expected or not isinstance(result, dict):
            raise RuntimeError(f"Scoped location approval returned HTTP {status} at {path}")
        return result

    def request_key(action):
        return f"r18-{action}-{uuid.uuid4().hex}"

    initial = await get_location()
    if device_visible(initial):
        raise RuntimeError("An active location approval already exists for the scoped r18 device")
    output.mkdir(mode=0o700)
    consent = grant = incident = lease = None
    matched = False
    cleaned = {}
    latest = None
    try:
        consent = await post("/v1/consents", {"subjectId": SUBJECT, "purpose": PURPOSE,
                                              "scopes": ["location:read"], "ttlSec": 120}, 201)
        grant = await post("/v1/grants", {"consentId": consent["consentId"], "purpose": PURPOSE,
                                         "scopes": ["location:read"], "ttlSec": 90}, 201)
        incident = await post("/v1/portal/incidents", {"householdId": SUBJECT, "deviceId": R18_DEVICE,
                             "kind": "SAFETY", "message": PURPOSE, "idempotencyKey": request_key("incident")})
        lease = await post("/v1/portal/location-leases", {"grantId": grant["grantId"], "recipientId": OPERATOR,
                          "deviceIds": [R18_DEVICE], "purpose": PURPOSE, "incidentId": incident["incidentId"],
                          "ttlSec": 60, "idempotencyKey": request_key("lease")})
        write_new_json(output / "location-lease.json", lease)
        print("R18_LOCATION_LEASE_READY", flush=True)

        try:
            async with asyncio.timeout(seconds):
                while True:
                    try:
                        capture = read_json(capture_path)
                    except (FileNotFoundError, json.JSONDecodeError):
                        await asyncio.sleep(0.2)
                        continue
                    if capture["teamRevision"] != revision:
                        raise ValueError("Observation capture belongs to a different team revision")
                    observation = validate_observation(capture["native"]["con"], GATEWAY, {R18_DEVICE: ""})
                    if observation["firmwareRevision"] not in R18_BRINGUP_FIRMWARES or observation["rssi"] is None:
                        raise ValueError("Expected a captured r18 bring-up observation with RSSI")
                    break
                while True:
                    latest = await get_location()
                    if matches_observation(latest, observation):
                        matched = True
                        break
                    await asyncio.sleep(0.25)
        except TimeoutError:
            pass
        if latest is not None:
            write_new_json(output / "portal-response.json", latest)
    finally:
        cleanup = (
            (lease, "leaseId", "/v1/portal/location-leases/revoke", "lease", "REVOKED"),
            (grant, "grantId", "/v1/grants/revoke", "grant", "REVOKED"),
            (consent, "consentId", "/v1/portal/consents/revoke", "consent", "REVOKED"),
            (incident, "incidentId", "/v1/portal/incidents/resolve", "incident", "RESOLVED"),
        )
        for record, key, path, label, expected_status in cleanup:
            if record is not None:
                try:
                    body = {key: record[key], "idempotencyKey": request_key(f"end-{label}")}
                    result = await post(path, body)
                    cleaned[label] = result.get(key) == record[key] and result.get("status") == expected_status
                except (httpx.HTTPError, RuntimeError, KeyError, ValueError):
                    cleaned[label] = False
        try:
            after = await get_location()
            absent = not device_visible(after)
            write_new_json(output / "portal-after-revocation.json", after)
        except (httpx.HTTPError, RuntimeError, KeyError, ValueError):
            absent = False
        write_new_json(output / "location-trial.json",
                       {"observationMatched": matched, "cleanupConfirmed": cleaned, "deviceAbsentAfterCleanup": absent})
    return matched and all(cleaned.values()) and absent


async def run(args):
    api, operator_dir = scoped_api("r18")
    if (api["gatewayId"], api["deviceId"], api["subjectId"]) != (GATEWAY, R18_DEVICE, SUBJECT):
        raise RuntimeError("Scoped r18 profile differs from the location trial")
    context = tls_context(operator_dir / "operator.pem", operator_dir / "operator.key")
    async with httpx.AsyncClient(base_url=f"https://127.0.0.1:{api['port']}", verify=context,
                                 trust_env=False, follow_redirects=False, timeout=5) as client:
        async def request(method, path, body=None):
            status, _, result = await exchange(client, method, path, DEFAULT_HEADERS, body)
            return status, result

        return await capture_portal(request, args.output, args.observation_capture, api["revision"], args.seconds)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observation-capture", type=Path, required=True, help="r18 observation artifact, may arrive after startup")
    parser.add_argument("--output", type=Path, required=True, help="new private location trial directory")
    parser.add_argument("--seconds", type=int, choices=range(10, 46), default=35, metavar="10..45")
    args = parser.parse_args()
    os.umask(0o077)
    raise SystemExit(0 if asyncio.run(run(args)) else 1)
