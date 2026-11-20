"""Read an r18 location response using a temporary approval on the loopback bench."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import uuid

import httpx

from bubble_gateway.ble_characterize import read_usb_boot
from bubble_gateway.config import ID
from bubble_gateway.model import central_observation_id, iso_time, utc_now, validate_observation
from pi_led_cycle import write_new_json
from scoped_command_io import DEFAULT_HEADERS, exchange, scoped_api, scoped_cse, tls_context
from scoped_feather_evidence import read_json
from scoped_feather_pi import R18_BOARD, R18_BRINGUP_FIRMWARES
from scoped_r18_observation import read_observation_candidate
from scoped_r18_pulse import GATEWAY, R18_DEVICE, SUBJECT

OPERATOR = "scoped-command-operator-r18"
PURPOSE = "r18-scoped-location-trial"
PORTAL = "/v1/portal/locations"


def location_keys(response):
    body = response["body"]
    if R18_DEVICE not in body["deviceIds"]:
        return set()
    return {(row["observedAt"], row["rssiDbm"]) for row in body["observations"]
            if row.get("deviceId") == R18_DEVICE and row.get("gatewayId") == GATEWAY
            and isinstance(row.get("observedAt"), str) and type(row.get("rssiDbm")) is int}


def observation_key(observation):
    return observation["observedAt"], observation["rssi"]


async def pair_live_observation(get_location, read_candidate, read_observation_id):
    observations, responses = {}, {}

    def remember(cache, key, value):
        cache[key] = value
        if len(cache) > 32:
            del cache[next(iter(cache))]

    async def read_versioned_location():
        before = await read_observation_id()
        response = await get_location()
        after = await read_observation_id()
        if before is None or before != after:
            return None
        return dict(response, observationId=before)

    while True:
        candidate, response = await asyncio.gather(read_candidate(), read_versioned_location())
        if response is not None:
            for projection in location_keys(response):
                key = (response["observationId"], *projection)
                remember(responses, key, response)
                if key in observations:
                    return observations[key], response
        if candidate is not None:
            observation = candidate["native"]["con"]
            key = (central_observation_id(observation), *observation_key(observation))
            if key in responses:
                return candidate, responses[key]
            remember(observations, key, candidate)
        await asyncio.sleep(0.25)


def device_visible(response):
    body = response["body"]
    return R18_DEVICE in body["deviceIds"] or any(row.get("deviceId") == R18_DEVICE for row in body["observations"])


async def capture_portal(request, output, capture_path, revision, seconds, *, read_candidate=None,
                         read_observation_id=None):
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
                if read_candidate is not None:
                    capture, latest = await pair_live_observation(get_location, read_candidate, read_observation_id)
                    write_new_json(output / "observation.json", dict(capture, teamRevision=revision))
                    matched = True
                else:
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
                        if observation_key(observation) in location_keys(latest):
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
    usb = None
    if args.live_observation:
        usb = read_usb_boot(args.usb_boot_log, R18_BOARD, args.firmware_revision)
        if any(usb[key] for key in ("motorActive", "auxEnabled", "mainFault")):
            raise ValueError("USB boot did not capture safe output and fault pins")
    context = tls_context(operator_dir / "operator.pem", operator_dir / "operator.key")
    async with httpx.AsyncClient(base_url=f"https://127.0.0.1:{api['port']}", verify=context,
                                 trust_env=False, follow_redirects=False, timeout=5) as client:
        async def request(method, path, body=None):
            status, _, result = await exchange(client, method, path, DEFAULT_HEADERS, body)
            return status, result

        if not args.live_observation:
            return await capture_portal(request, args.output, args.observation_capture, api["revision"], args.seconds)
        async with scoped_cse() as cse:
            started_at = utc_now()
            state_path = operator_dir / "runtime.json"

            async def read_candidate():
                return await read_observation_candidate(cse, usb=usb, firmware=args.firmware_revision,
                    observation_pin=args.observation_container_ri, health_pin=args.health_container_ri,
                    started_at=started_at, require_rssi=True)

            async def read_observation_id():
                state = await asyncio.to_thread(read_json, state_path)
                row = state.get("gatewayTelemetry", {}).get(f"{GATEWAY}:{R18_DEVICE}")
                return None if row is None else row["observationId"]

            return await capture_portal(request, args.output, None, api["revision"], args.seconds,
                                        read_candidate=read_candidate, read_observation_id=read_observation_id)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument("--observation-capture", type=Path, help="r18 observation artifact, may arrive after startup")
    sources.add_argument("--live-observation", action="store_true", help="pair CSE and authorized location reads in this trial")
    parser.add_argument("--usb-boot-log", type=Path)
    parser.add_argument("--firmware-revision", choices=R18_BRINGUP_FIRMWARES)
    parser.add_argument("--observation-container-ri")
    parser.add_argument("--health-container-ri")
    parser.add_argument("--output", type=Path, required=True, help="new private location trial directory")
    parser.add_argument("--seconds", type=int, choices=range(10, 46), default=35, metavar="10..45")
    args = parser.parse_args()
    pins = (args.observation_container_ri, args.health_container_ri)
    live_fields = (*pins, args.usb_boot_log, args.firmware_revision)
    if args.live_observation:
        if not all(live_fields) or pins[0] == pins[1] or any(not ID.fullmatch(pin) for pin in pins):
            parser.error("--live-observation requires a USB log, firmware revision and distinct CSE container IDs")
    elif any(field is not None for field in live_fields):
        parser.error("USB log, firmware revision and CSE container IDs are used with --live-observation")
    os.umask(0o077)
    raise SystemExit(0 if asyncio.run(run(args)) else 1)
