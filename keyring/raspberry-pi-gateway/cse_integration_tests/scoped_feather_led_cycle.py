"""Run the explicit Feather LED cycle against the existing scoped loopback services."""
import argparse
import asyncio
import json
from pathlib import Path
import ssl
import uuid

import httpx

from pi_led_cycle import run_led_cycle

PROFILE = Path(__file__).resolve().parents[2] / "dev/mobius4/.local/scoped"
PARENT = "/Mobius/privacy-bubble-test-ae"
PATHS = {"observation": f"{PARENT}/command-observations-a", "receipt": f"{PARENT}/command-receipts-a",
         "health": f"{PARENT}/health"}


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


async def run(output, seconds):
    environment = dict(line.split("=", 1) for line in (PROFILE / "compose.env").read_text(encoding="utf-8-sig").splitlines()
                       if line and not line.startswith("#"))
    port = int(environment["KEYRING_CSE_TLS_PORT"])
    if not 1 <= port <= 65535 or not environment.get("CSE_ADMIN"):
        raise ValueError("Scoped CSE configuration required")
    core_tls = tls_context(PROFILE / "tls/client.pem", PROFILE / "tls/client.key")
    operator_tls = tls_context(PROFILE / "command-api/operator.pem", PROFILE / "command-api/operator.key")
    output.mkdir(mode=0o700)
    defaults = {"Accept": "application/json", "Cache-Control": "no-store"}
    async with (
        httpx.AsyncClient(base_url=f"https://127.0.0.1:{port}", verify=core_tls, trust_env=False, timeout=5) as core,
        httpx.AsyncClient(base_url="https://127.0.0.1:8787", verify=operator_tls, trust_env=False, timeout=5) as operator,
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

        await run_led_cycle(operator_post, cse, PATHS, output, gateway_id="gw-a", subject_id="scoped-feather-bench")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New private local directory for triggers and evidence")
    parser.add_argument("--seconds", type=int, default=600, choices=range(30, 1801), metavar="30..1800")
    args = parser.parse_args()
    asyncio.run(run(args.output.resolve(), args.seconds))
