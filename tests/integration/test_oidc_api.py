"""서명한 테스트 토큰과 실제 TLS에서 사용자/Gateway 경계를 검증합니다."""
import asyncio
import json
from pathlib import Path
import ssl
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "keyring" / "raspberry-pi-gateway" / "tests"))
import httpx
from tls_fixture import TestPki


class OidcApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_signed_bearer_over_tls_and_gateway_certificate_binding(self):
        pki = await asyncio.to_thread(TestPki)
        self.addCleanup(pki.close)
        process = await asyncio.create_subprocess_exec(
            "node", str(Path(__file__).with_name("oidc-server.mjs")), str(pki.root),
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
        ready = json.loads(await asyncio.wait_for(process.stdout.readline(), 10))
        context = ssl.create_default_context(cafile=str(pki.path("trusted")))
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        async with httpx.AsyncClient(verify=context, trust_env=False, timeout=3) as client:
            endpoint = ready["origin"] + "/v1/portal/snapshot"
            response = await client.get(endpoint, headers={"Authorization": "Bearer " + ready["token"]})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["principal"]["principalId"], "guardian-test")
            self.assertEqual(response.extensions["network_stream"].get_extra_info("ssl_object").version(), "TLSv1.3")
            self.assertEqual((await client.get(endpoint)).status_code, 401)
            self.assertEqual((await client.get(endpoint, headers={"Authorization": "Bearer " + ready["expired"]})).status_code, 401)
            self.assertEqual((await client.get(endpoint, headers={"Authorization": "Bearer " + ready["noScope"]})).status_code, 403)
            gateway = ready["origin"] + "/api/v1/gateways/gw-test/credentials/status"
            self.assertEqual((await client.get(gateway, headers={"Authorization": "Bearer " + ready["token"]})).status_code, 403)
            self.assertEqual((await client.get(gateway, headers={"x-mtls-verified": "true", "x-mtls-fingerprint": "fake"})).status_code, 401)
        context.load_cert_chain(str(pki.path("client")), str(pki.path("client", "key")))
        async with httpx.AsyncClient(verify=context, trust_env=False, timeout=3) as client:
            response = await client.get(ready["origin"] + "/api/v1/gateways/gw-test/credentials/status")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["status"], "ACTIVE")


if __name__ == "__main__":
    unittest.main()
