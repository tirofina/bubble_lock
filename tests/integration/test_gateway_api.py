"""Node central API and Python Gateway share a fresh TLS 1.3/mTLS wire."""
import asyncio
import json
from pathlib import Path
import ssl
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
GATEWAY = ROOT / "keyring" / "raspberry-pi-gateway"
sys.path[:0] = [str(GATEWAY / "src"), str(GATEWAY / "tests")]

import httpx
from bubble_gateway.model import authorization_deadline, payload_hash, validate_command, parse_time
from bubble_gateway.transport import TransportHub
from helpers import config, DEVICES
from tls_fixture import TestPki


class CentralGatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_mtls_command_hash_authorization_and_revoke(self):
        pki = await asyncio.to_thread(TestPki)
        self.addCleanup(pki.close)
        process = await asyncio.create_subprocess_exec(
            "node", str(Path(__file__).with_name("gateway-server.mjs")), str(pki.root),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

        async def stop():
            if process.returncode is None:
                process.stdin.write(b"close\n")
                await process.stdin.drain()
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
            self.assertEqual(process.returncode, 0, (await process.stderr.read()).decode())
        self.addAsyncCleanup(stop)
        started = await asyncio.wait_for(process.stdout.readline(), 10)
        self.assertTrue(started, "Node API process must publish its endpoint")
        ready = json.loads(started)
        cfg = config()
        cfg.api_url = cfg.cse_url = ready["origin"]
        cfg.mqtt_enabled, cfg.request_timeout = False, 2
        cfg.ca_file, cfg.cert_file, cfg.key_file = pki.path("trusted"), pki.path("client"), pki.path("client", "key")
        hub = TransportHub(cfg)
        self.addAsyncCleanup(hub.close)
        await hub.start()
        self.assertEqual(await hub.credential_status(), {"gatewayId": "gw-test", "credentialRevision": "1", "status": "ACTIVE"})
        commands = await hub.poll_commands()
        self.assertEqual(commands, [ready["command"]])
        command = validate_command(commands[0], "gw-test", DEVICES)
        digest = payload_hash(command)
        approval = await hub.authorize(command, digest)
        self.assertTrue(approval["allowed"])
        self.assertEqual(authorization_deadline(command, digest, approval), parse_time(command["deadline"]))
        self.assertFalse((await hub.authorize(command, "0" * 64))["allowed"])
        scoped_context = ssl.create_default_context(cafile=str(pki.path("trusted")))
        scoped_context.minimum_version = ssl.TLSVersion.TLSv1_3
        scoped_context.load_cert_chain(str(pki.path("client")), str(pki.path("client", "key")))
        async with httpx.AsyncClient(verify=scoped_context, trust_env=False, timeout=2) as client:
            for path in ("/v1/handover", "/v1/mec/callback", "/v1/fl/rounds", "/v1/mcp/execute"):
                response = await client.post(ready["origin"] + path, json={"principal": {"principalId": "admin", "scopes": ["*"]}})
                self.assertEqual(response.status_code, 403, path)
                self.assertIn("Scope", response.json()["error"])
            response = await client.get(ready["origin"] + "/api/v1/gateways/other-gateway/credentials/status")
            self.assertEqual(response.status_code, 403)

        process.stdin.write(b"revoke\n")
        await process.stdin.drain()
        self.assertTrue(json.loads(await asyncio.wait_for(process.stdout.readline(), 5))["revoked"])
        self.assertFalse((await hub.authorize(command, digest))["allowed"])
        self.assertEqual(await hub.poll_commands(), [])

        context = ssl.create_default_context(cafile=str(pki.path("trusted")))
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        async with httpx.AsyncClient(verify=context, trust_env=False, timeout=2) as client:
            with self.assertRaises((httpx.TransportError, ssl.SSLError)):
                await client.get(ready["origin"] + "/api/v1/gateways/gw-test/credentials/status",
                                 headers={"x-mtls-verified": "true", "x-mtls-fingerprint": "fake"})


if __name__ == "__main__":
    unittest.main()
