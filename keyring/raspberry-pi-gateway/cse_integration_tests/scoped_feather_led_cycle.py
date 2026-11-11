"""Run the explicit Feather LED cycle against the existing scoped loopback services."""
import argparse
import asyncio
from functools import partial
import json
from pathlib import Path
import re
import ssl
import subprocess
import uuid

import httpx

from pi_led_cycle import FIRMWARE, run_led_cycle, write_new_json
from scoped_feather_evidence import integration_observation_event, integration_settlement, read_json
from scoped_feather_pi import COMMAND_FIRMWARES

BENCH_ROOT = Path(__file__).resolve().parents[2] / "dev/mobius4"
PROFILE = BENCH_ROOT / ".local/scoped"
PARENT = "/Mobius/privacy-bubble-test-ae"
PATHS = {"observation": f"{PARENT}/command-observations-a", "receipt": f"{PARENT}/command-receipts-a",
         "health": f"{PARENT}/health"}
TEAM_OBSERVATION_HASH = """
import { readFileSync } from 'node:fs';
const { approvalHash } = await import(process.argv[1]);
process.stdout.write(approvalHash(JSON.parse(readFileSync(0, 'utf8'))));
"""


def tls_context(cert, key):
    context = ssl.create_default_context(cafile=str(PROFILE / "tls/ca.pem"))
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(cert, key)
    return context


def hash_observation(team_utils, observation):
    # Use the API's serialization for JSON numbers and object keys.
    try:
        result = subprocess.run(
            ["node", "--input-type=module", "-e", TEAM_OBSERVATION_HASH, team_utils.as_uri()],
            input=json.dumps(observation, allow_nan=False),
            encoding="utf-8", capture_output=True, check=True, timeout=5,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        raise RuntimeError("Could not hash the observation with the pinned team source") from None
    if re.fullmatch(r"[0-9a-f]{64}", result.stdout) is None:
        raise RuntimeError("Invalid observation hash from the pinned team source")
    return result.stdout


async def exchange(client, method, path, headers, body=None):
    async with client.stream(method, path, headers=headers, json=body) as response:
        data = bytearray()
        async for chunk in response.aiter_bytes():
            if len(data) + len(chunk) > 65536:
                raise RuntimeError("Scoped response exceeds the bench size limit")
            data.extend(chunk)
        return response.status_code, response.headers, json.loads(data) if data else None


async def record_central_observations(steps, state_path, output):
    if any("payloadHash" not in step["observation"] for step in steps):
        raise ValueError("Native observation payload hashes are incomplete for the LED cycle")
    print("LED_CYCLE_WAITING_FOR_CENTRAL_TELEMETRY", flush=True)
    try:
        async with asyncio.timeout(35):
            while not (output / "STOP").exists():
                team_state = await asyncio.to_thread(read_json, state_path)
                on, off = (integration_observation_event(step, team_state, allow_pending=True) for step in steps)
                if on is not None and off is not None:
                    if on["sequence"] >= off["sequence"]:
                        raise ValueError("Central telemetry order does not match the LED cycle")
                    keys = ("eventId", "observationId", "payloadHash", "sequence", "observedAt", "timestamp")
                    evidence = [{"commandId": step["command"]["commandId"], **{key: event[key] for key in keys}}
                                for step, event in zip(steps, (on, off))]
                    write_new_json(output / "central-telemetry.json", {"observations": evidence})
                    print("LED_CYCLE_CENTRAL_TELEMETRY_VERIFIED", flush=True)
                    return
                await asyncio.sleep(0.25)
    except TimeoutError:
        raise RuntimeError("Central telemetry did not arrive for both observations; led-cycle.json was retained") from None
    raise RuntimeError("Stopped while waiting for central telemetry; led-cycle.json was retained")


async def run(output, seconds, *, api_mode="legacy", firmware=FIRMWARE):
    environment = dict(line.split("=", 1) for line in (PROFILE / "compose.env").read_text(encoding="utf-8-sig").splitlines()
                       if line and not line.startswith("#"))
    port = int(environment["KEYRING_CSE_TLS_PORT"])
    if not 1 <= port <= 65535 or not environment.get("CSE_ADMIN"):
        raise ValueError("Scoped CSE configuration required")
    core_tls = tls_context(PROFILE / "tls/client.pem", PROFILE / "tls/client.key")
    profiles = json.loads((BENCH_ROOT / "scoped-command-profiles.json").read_text(encoding="utf-8"))
    api = profiles[api_mode]
    operator_dir = PROFILE / api["directory"]
    state_path = operator_dir / "runtime.json"
    integration = api_mode == "integration"
    observation_hasher = None
    if integration:
        if (operator_dir / "team-revision").read_text(encoding="ascii").strip() != api["revision"]:
            raise RuntimeError("Scoped command API source differs from the pinned revision")
        team_utils = operator_dir / "team-source/pc-mobius/integration/src/integration-utils.mjs"
        observation_hasher = partial(hash_observation, team_utils)
        await asyncio.to_thread(observation_hasher, {})
    operator_tls = tls_context(operator_dir / "operator.pem", operator_dir / "operator.key")
    output.mkdir(mode=0o700)
    defaults = {"Accept": "application/json", "Cache-Control": "no-store"}
    async with (
        httpx.AsyncClient(base_url=f"https://127.0.0.1:{port}", verify=core_tls, trust_env=False, timeout=5) as core,
        httpx.AsyncClient(base_url=f"https://127.0.0.1:{api['port']}", verify=operator_tls,
                          trust_env=False, timeout=5) as operator,
        asyncio.timeout(seconds),
    ):
        async def cse(method, path):
            rqi = f"kr-led-{uuid.uuid4()}"
            status, headers, document = await exchange(core, method, path, {
                **defaults, "X-M2M-Origin": environment["CSE_ADMIN"], "X-M2M-RVI": "4", "X-M2M-RI": rqi,
            })
            if headers.get("x-m2m-ri") != rqi:
                raise RuntimeError("Scoped CSE response request ID mismatch")
            rsc = int(headers["x-m2m-rsc"])
            if (status, rsc) == (200, 2000):
                cin = document.get("m2m:cin") if isinstance(document, dict) else None
                name = path.rsplit("/", 1)[-1]
                if (not isinstance(cin, dict) or cin.get("ty") != 4 or not isinstance(cin.get("con"), dict)
                        or (name != "la" and cin.get("rn") != name)):
                    raise RuntimeError("Scoped CSE returned a different content instance")
            return status, rsc, document

        async def operator_post(path, body):
            status, _, document = await exchange(operator, "POST", path, defaults, body)
            return status, document

        async def central_settlement(command, receipt):
            team_state = await asyncio.to_thread(read_json, state_path)
            return integration_settlement(command, receipt, team_state)

        steps = await run_led_cycle(operator_post, cse, PATHS, output, gateway_id="gw-a", subject_id="scoped-feather-bench",
                                    central_settlement=central_settlement if integration else None,
                                    observation_hasher=observation_hasher, firmware=firmware)
        if integration:
            await record_central_observations(steps, state_path, output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New private local directory for triggers and evidence")
    parser.add_argument("--seconds", type=int, default=600, choices=range(30, 1801), metavar="30..1800")
    parser.add_argument("--api-mode", choices=("legacy", "integration"), default="legacy")
    parser.add_argument("--firmware-revision", choices=COMMAND_FIRMWARES, default=FIRMWARE)
    args = parser.parse_args()
    asyncio.run(run(args.output.resolve(), args.seconds, api_mode=args.api_mode, firmware=args.firmware_revision))
