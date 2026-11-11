"""공유 mTLS 전송의 MEC 응답·본문 크기·시간 경계를 검증합니다."""
import asyncio
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'keyring' / 'raspberry-pi-gateway' / 'tests'))
from tls_fixture import TestPki


class MtlsTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_responses_and_transport_limits(self):
        pki = await asyncio.to_thread(TestPki)
        self.addCleanup(pki.close)
        process = await asyncio.create_subprocess_exec('node', str(Path(__file__).with_name('mtls-transport-check.mjs')), str(pki.root), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 15)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise
        self.assertEqual(process.returncode, 0, stderr.decode())
        result = json.loads(stdout)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['checks'], 7)
