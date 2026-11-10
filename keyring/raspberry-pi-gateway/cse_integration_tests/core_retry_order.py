"""Opt-in CORE retry ordering test with the team handler and real Mobius4 SDT."""
import asyncio
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

from bubble_gateway.store import Store
from helpers import observation
from test_mobius_cse import MobiusCseTests


class CoreRetryOrderTests(MobiusCseTests):
    async def create_resource(self, path, resource_type, body):
        rqi = "core-order-create-" + uuid.uuid4().hex
        headers = self.hub._m2m_headers(rqi, create=True)
        headers["Content-Type"] = f"application/json;ty={resource_type}"
        status, response, _ = await self.hub._http_json("POST", self.stack.origin + path, headers=headers, body=body)
        self.assertEqual((status, self.hub._response_rsc(status, response, rqi)), (201, 2001))

    async def switch_state(self, path):
        rqi = "core-order-read-" + uuid.uuid4().hex
        status, response, body = await self.hub._http_json(
            "GET", self.stack.origin + path, headers=self.hub._m2m_headers(rqi))
        self.assertEqual((status, self.hub._response_rsc(status, response, rqi)), (200, 2000))
        return body["pb:binarySwitch"]["state"]

    async def test_core_retry_keeps_binary_switch_in_order(self):
        ae = "core-order-" + uuid.uuid4().hex[:12]
        await self.create_resource("/Mobius", 2, {"m2m:ae": {"rn": ae, "api": "Nprivacy-bubble", "rr": True}})
        for name in ("baseline", "ordered"):
            await self.create_resource("/Mobius/" + ae, 28, {"pb:binarySwitch": {
                "rn": name, "cnd": "org.onem2m.common.moduleclass.binarySwitch", "state": False}})
        paths = [f"/Mobius/{ae}/{name}" for name in ("baseline", "ordered")]

        store, reopen, _path, _binding = self.store_for()
        store.observation(self.parent, observation(state=True), core_enabled=True)
        store.observation(self.parent, observation(sequence=2, state=False), core_enabled=True)
        with patch("bubble_gateway.store.time.time", return_value=1000):
            store.retry(Store.request_id("core-telemetry", "kr-test:boot-test:1"), 0)
            store.close()
            store = reopen()
            self.assertEqual(await self.drain_due(store), {"published": 2})
            self.assertEqual(await self.count(), 2)
            self.assertIsNone(store.due())
        projections = []
        with patch("bubble_gateway.store.time.time", return_value=2000):
            while item := store.due():
                self.assertEqual(item["container"], "@core/telemetry")
                projections.append(item["payload"])
                store.delivered(item["rqi"])
        self.assertEqual([(row["sequence"], row["state"]) for row in projections], [(0, True), (1, False)])

        runner = Path(__file__).with_suffix(".mjs")
        process = await asyncio.create_subprocess_exec(
            "node", str(runner), os.environ["KEYRING_TEST_CENTRAL_TREE"], str(self.pki.root),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        data = json.dumps(dict(baseUrl=self.stack.origin, originator=self.stack.admin,
                               paths=paths, projections=projections)).encode()
        try:
            _, stderr = await asyncio.wait_for(process.communicate(data), 15)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise
        self.assertEqual(process.returncode, 0, stderr.decode())
        self.assertIs(await self.switch_state(paths[0]), True)
        self.assertIs(await self.switch_state(paths[1]), False)
        self.delivery_facts = {"reversedOrderSdtState": True, "fixedOrderSdtState": False,
                               "coreSequences": [0, 1], "nativeCinsDuringCoreBackoff": 2}
        print(json.dumps(self.delivery_facts), flush=True)


if __name__ == "__main__":
    unittest.main(defaultTest="CoreRetryOrderTests.test_core_retry_keeps_binary_switch_in_order")
