"""웹 BFF의 실제 HTTPS 호출과 신뢰 CA·서명 토큰 경계를 시험합니다."""
import asyncio
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'keyring' / 'raspberry-pi-gateway' / 'tests'))
from tls_fixture import TestPki


class PortalUpstreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_node_bff_https_ca_and_enrolled_oidc_token(self):
        pki = await asyncio.to_thread(TestPki)
        self.addCleanup(pki.close)
        server = await asyncio.create_subprocess_exec('node', str(Path(__file__).with_name('oidc-server.mjs')), str(pki.root),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        async def stop():
            if server.returncode is None:
                server.stdin.write(b'close\n')
                await server.stdin.drain()
                try:
                    await asyncio.wait_for(server.wait(), 5)
                except TimeoutError:
                    server.kill()
                    await server.wait()
            self.assertEqual(server.returncode, 0, (await server.stderr.read()).decode())
        self.addAsyncCleanup(stop)
        ready = await asyncio.wait_for(server.stdout.readline(), 15)
        check = await asyncio.create_subprocess_exec('node', str(Path(__file__).with_name('portal-upstream-check.mjs')), str(pki.root),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(check.communicate(ready), 15)
        except TimeoutError:
            check.kill()
            await check.wait()
            raise
        self.assertEqual(check.returncode, 0, stderr.decode())
        self.assertEqual(json.loads(stdout)['checks'], 5)
