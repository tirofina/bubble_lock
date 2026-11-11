"""Authenticated clients for the existing loopback command bench."""

from contextlib import asynccontextmanager
import json
from pathlib import Path
import re
import ssl
import subprocess
import uuid

import httpx

BENCH_ROOT = Path(__file__).resolve().parents[2] / "dev/mobius4"
PROFILE = BENCH_ROOT / ".local/scoped"
DEFAULT_HEADERS = {"Accept": "application/json", "Cache-Control": "no-store"}
TEAM_OBSERVATION_HASH = """
import { readFileSync } from 'node:fs';
const { approvalHash } = await import(process.argv[1]);
process.stdout.write(approvalHash(JSON.parse(readFileSync(0, 'utf8'))));
"""


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


def tls_context(cert, key):
    context = ssl.create_default_context(cafile=str(PROFILE / "tls/ca.pem"))
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(cert, key)
    return context


async def exchange(client, method, path, headers, body=None):
    async with client.stream(method, path, headers=headers, json=body) as response:
        data = bytearray()
        async for chunk in response.aiter_bytes():
            if len(data) + len(chunk) > 65536:
                raise RuntimeError("Scoped response exceeds the bench size limit")
            data.extend(chunk)
        return response.status_code, response.headers, json.loads(data) if data else None


def scoped_api(api_mode):
    profiles = json.loads((BENCH_ROOT / "scoped-command-profiles.json").read_text(encoding="utf-8"))
    api = profiles[api_mode]
    operator_dir = PROFILE / api["directory"]
    if api_mode != "legacy" and (operator_dir / "team-revision").read_text(encoding="ascii").strip() != api["revision"]:
        raise RuntimeError("Scoped command API source differs from the pinned revision")
    return api, operator_dir


@asynccontextmanager
async def scoped_cse(*, container_paths=()):
    environment = dict(line.split("=", 1) for line in (PROFILE / "compose.env").read_text(encoding="utf-8-sig").splitlines()
                       if line and not line.startswith("#"))
    port = int(environment["KEYRING_CSE_TLS_PORT"])
    if not 1 <= port <= 65535 or not environment.get("CSE_ADMIN"):
        raise ValueError("Scoped CSE configuration required")
    core_tls = tls_context(PROFILE / "tls/client.pem", PROFILE / "tls/client.key")
    async with httpx.AsyncClient(base_url=f"https://127.0.0.1:{port}", verify=core_tls, trust_env=False, timeout=5) as core:
        async def cse(method, path):
            if method != "GET":
                raise ValueError("Bench evidence client only reads from the CSE")
            rqi = f"kr-bench-{uuid.uuid4()}"
            status, headers, document = await exchange(core, method, path, {
                **DEFAULT_HEADERS, "X-M2M-Origin": environment["CSE_ADMIN"], "X-M2M-RVI": "4", "X-M2M-RI": rqi,
            })
            if headers.get("x-m2m-ri") != rqi:
                raise RuntimeError("Scoped CSE response request ID mismatch")
            rsc = int(headers["x-m2m-rsc"])
            if (status, rsc) == (200, 2000):
                name = path.rsplit("/", 1)[-1]
                if path in container_paths:
                    container = document.get("m2m:cnt") if isinstance(document, dict) else None
                    if not isinstance(container, dict) or container.get("ty") != 3 or container.get("rn") != name:
                        raise RuntimeError("Scoped CSE returned a different container")
                else:
                    cin = document.get("m2m:cin") if isinstance(document, dict) else None
                    if (not isinstance(cin, dict) or cin.get("ty") != 4 or not isinstance(cin.get("con"), dict)
                            or (name != "la" and cin.get("rn") != name)):
                        raise RuntimeError("Scoped CSE returned a different content instance")
            return status, rsc, document

        yield cse


@asynccontextmanager
async def scoped_clients(api, operator_dir, *, container_paths=()):
    operator_tls = tls_context(operator_dir / "operator.pem", operator_dir / "operator.key")
    async with (scoped_cse(container_paths=container_paths) as cse,
                httpx.AsyncClient(base_url=f"https://127.0.0.1:{api['port']}", verify=operator_tls,
                                  trust_env=False, timeout=5) as operator):
        async def operator_post(path, body):
            status, _, document = await exchange(operator, "POST", path, DEFAULT_HEADERS, body)
            return status, document

        yield cse, operator_post
