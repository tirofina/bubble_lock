"""배포 FL worker의 실제 TLS 및 중앙 승인·재시작 경로를 검증합니다."""
import asyncio
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'keyring' / 'raspberry-pi-gateway' / 'tests'))
from tls_fixture import TestPki


class FlWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_deployed_worker_mtls_authority_and_restart(self):
        pki = await asyncio.to_thread(TestPki)
        self.addCleanup(pki.close)
        await asyncio.to_thread(pki.leaf, 'client-2', 'trusted', 10, 'clientAuth')
        process = await asyncio.create_subprocess_exec('node', str(Path(__file__).with_name('fl-worker-check.mjs')), str(pki.root),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 45)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise
        self.assertEqual(process.returncode, 0, stderr.decode())
        result = json.loads(stdout)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['checks'], 14)

