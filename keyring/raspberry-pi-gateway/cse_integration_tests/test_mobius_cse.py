"""Real disposable Mobius4/PostgreSQL, not the synthetic protocol responder."""
import asyncio
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

import httpx

from bubble_gateway.transport import TransportHub, RemoteResponseError
from bubble_gateway.model import iso_time, payload_hash
from bubble_gateway.service import Gateway
from bubble_gateway.state_identity import configured_binding
from bubble_gateway.store import Store
from helpers import command, config, observation
from tls_fixture import TestPki
from mobius_fixture import DisposableMobius


class MobiusCseTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.pki = TestPki()
        try:
            cls.stack = DisposableMobius(cls.pki)
        except BaseException:
            cls.pki.close()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            cls.stack.close()
        finally:
            cls.pki.close()

    async def asyncSetUp(self):
        self.delivery_facts = {}
        self.hub = await self.hub_for(mqtt=False)
        self.addCleanup(self.save_logs)
        await self.ready()
        self.parent = "/Mobius/cse-test-" + uuid.uuid4().hex[:12]
        rqi = "setup-" + uuid.uuid4().hex
        status, headers, _ = await self.hub._http_json("POST", self.stack.origin + "/Mobius",
            headers=self.hub._m2m_headers(rqi, create=True) | {"Content-Type": "application/json;ty=3"},
            body={"m2m:cnt": {"rn": self.parent.rsplit("/", 1)[1], "mni": 100}})
        self.assertEqual((status, self.hub._response_rsc(status, headers, rqi)), (201, 2001))

    async def hub_for(self, *, mqtt):
        cfg = config()
        cfg.originator, cfg.cse_id, cfg.rvi = self.stack.admin, self.stack.cse_id, "4"
        cfg.api_url = cfg.cse_url = self.stack.origin
        cfg.ca_file, cfg.cert_file, cfg.key_file = self.pki.path("trusted"), self.pki.path("client"), self.pki.path("client", "key")
        cfg.mqtt_enabled, cfg.core_bridge_enabled, cfg.mqtt_wrapped_primitive = mqtt, False, False
        cfg.mqtt_host, cfg.mqtt_port, cfg.mqtt_keepalive, cfg.request_timeout = "127.0.0.1", self.stack.broker.port, 10, 3
        hub = TransportHub(cfg)
        self.addAsyncCleanup(hub.close)
        await hub.start()
        if mqtt:
            await asyncio.wait_for(hub._ready.wait(), 5)
        return hub

    async def ready(self):
        async with asyncio.timeout(30):
            while True:
                try:
                    rqi = "ready-" + uuid.uuid4().hex
                    status, headers, _ = await self.hub._http_json("GET", self.stack.origin + "/Mobius",
                                                               headers=self.hub._m2m_headers(rqi))
                    if status == 200 and self.hub._response_rsc(status, headers, rqi) == 2000:
                        return
                except (httpx.TransportError, RemoteResponseError):
                    pass
                await asyncio.sleep(0.2)

    async def stored(self, rqi):
        rn = "gw-" + hashlib.sha256(rqi.encode()).hexdigest()
        read_rqi = "check-" + uuid.uuid4().hex
        status, headers, body = await self.hub._http_json("GET", self.stack.origin + self.parent + "/" + rn,
                                                       headers=self.hub._m2m_headers(read_rqi))
        self.assertEqual((status, self.hub._response_rsc(status, headers, read_rqi)), (200, 2000))
        return body["m2m:cin"]

    async def count(self):
        rqi = "count-" + uuid.uuid4().hex
        status, headers, body = await self.hub._http_json("GET", self.stack.origin + self.parent,
                                                       headers=self.hub._m2m_headers(rqi))
        self.assertEqual((status, self.hub._response_rsc(status, headers, rqi)), (200, 2000))
        return body["m2m:cnt"]["cni"]

    def save_logs(self):
        output = os.environ.get("KEYRING_TEST_CSE_LOG_DIR")
        if output:
            root = Path(output) / self._testMethodName
            root.mkdir(parents=True, exist_ok=True)
            for name in self.stack.containers:
                (root / (name + ".log")).write_text(self.stack.logs(name), encoding="utf-8")
            (root / "broker.log").write_text(self.stack.broker.logs(), encoding="utf-8")
            if self.delivery_facts:
                (root / "delivery-facts.json").write_text(json.dumps(self.delivery_facts, indent=2) + "\n", encoding="utf-8")

    def store_for(self):
        temp = tempfile.TemporaryDirectory(prefix="keyring-delivery-test-")
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / "synthetic.sqlite3"
        cfg = self.hub.config
        cfg.observation_container = cfg.receipt_container = cfg.health_container = self.parent
        binding = configured_binding(cfg)
        stores = []

        def reopen():
            store = Store(path, 100, 100000, 20, binding)
            stores.append(store)
            return store

        self.addCleanup(lambda: [store.close() for store in stores])
        return reopen(), reopen, path, binding

    async def drain_due(self, store, hub=None):
        """Run the actual sender until its first idle/backoff; no other daemon loops."""
        gateway = Gateway.__new__(Gateway)
        gateway.config, gateway.store, gateway.transport = self.hub.config, store, hub or self.hub
        gateway.stop, gateway.counters = asyncio.Event(), Counter()

        async def idle(_seconds):
            gateway.stop.set()

        gateway._pause = idle
        async with asyncio.timeout(8):
            await gateway._outbox_loop()
        return dict(gateway.counters)

    def queued(self, store):
        row = store.db.execute("SELECT * FROM outbox").fetchone()
        return dict(row) if row else None

    async def test_https_publish_is_stored_and_read_back_from_real_cse(self):
        rqi, payload = "https-" + uuid.uuid4().hex, {"synthetic": True, "label": "키링", "sequence": 1}
        await self.hub.publish(rqi, self.parent, payload)
        self.assertEqual((await self.stored(rqi))["con"], payload)
        self.assertEqual(await self.count(), 1)

    async def test_mqtt_application_receipt_and_storage_without_https_post(self):
        hub = await self.hub_for(mqtt=True)
        paths = (self.parent, "/~/Mobius4" + self.parent, "/_/localhost/Mobius4" + self.parent)
        for index, path in enumerate(paths):
            with self.subTest(path=path):
                rqi, payload = "mqtt-" + uuid.uuid4().hex, {"synthetic": True, "sequence": index}
                await hub.publish(rqi, path, payload)
                self.assertEqual((await self.stored(rqi))["con"], payload)
                logs = await asyncio.to_thread(self.stack.logs, "proxy")
                self.assertNotIn("POST " + path + " " + rqi, logs)
        self.assertEqual(await self.count(), 3)

    async def test_duplicate_request_reuses_single_cin(self):
        rqi, payload = "duplicate-" + uuid.uuid4().hex, {"synthetic": True, "value": 3}
        await self.hub.publish(rqi, self.parent, payload)
        await self.hub.publish(rqi, self.parent, payload)
        self.assertEqual((await self.stored(rqi))["con"], payload)
        self.assertEqual(await self.count(), 1)

    async def test_same_rqi_different_payload_is_rejected_and_original_preserved(self):
        rqi, original = "conflict-" + uuid.uuid4().hex, {"synthetic": True, "value": 4}
        await self.hub.publish(rqi, self.parent, original)
        with self.assertRaises(RemoteResponseError) as caught:
            await self.hub.publish(rqi, self.parent, {"synthetic": True, "value": 5})
        self.assertEqual(caught.exception.rsc, 4105)
        self.assertEqual((await self.stored(rqi))["con"], original)
        self.assertEqual(await self.count(), 1)

    async def test_cse_process_restart_preserves_committed_cin(self):
        rqi, payload = "restart-" + uuid.uuid4().hex, {"synthetic": True, "value": 6}
        await self.hub.publish(rqi, self.parent, payload)
        await asyncio.to_thread(self.stack.restart_cse)
        await self.ready()
        self.assertEqual((await self.stored(rqi))["con"], payload)
        self.assertEqual(await self.count(), 1)

    async def test_outbox_observation_restart_and_dedup_with_real_cse(self):
        store, reopen, _path, _binding = self.store_for()
        payload = observation()
        self.assertTrue(store.observation(self.parent, payload))
        self.assertFalse(store.observation(self.parent, payload))
        original = self.queued(store)
        store.close()
        store = reopen()
        self.assertEqual(self.queued(store), original)
        counters = await self.drain_due(store)
        self.assertEqual(counters, {"published": 1})
        self.assertEqual(store.counts(), (0, 0))
        self.assertFalse(store.observation(self.parent, payload))
        self.assertEqual((await self.stored(original["rqi"]))["con"], payload)
        self.assertEqual(await self.count(), 1)
        self.delivery_facts = {"queueSurvivedReopen": True, "published": 1, "remainingOutbox": 0,
                               "duplicateObservationQueued": False, "remoteCinCount": 1, "rqi": original["rqi"]}

    async def test_outbox_receipt_flag_requires_real_mqtt_application_response(self):
        store, _reopen, _path, _binding = self.store_for()
        cmd = command()
        digest = payload_hash(cmd)
        receipt = dict(version=1, gatewayId="gw-test", deviceId="kr-test", commandId=cmd["commandId"],
                       payloadHash=digest, status="INDETERMINATE", ackCode="INDETERMINATE",
                       readback=None, receivedAt=iso_time(), grantRevision=3, ownershipEpoch=2)
        self.assertEqual(store.accept(cmd, digest), "NEW")
        store.finish(cmd["commandId"], receipt)
        store.stage_receipts(self.parent, core_enabled=False)
        rqi = store.request_id("receipt", cmd["commandId"])
        self.assertEqual(store.db.execute("SELECT receipt_delivered FROM commands").fetchone()[0], 0)
        hub = await self.hub_for(mqtt=True)
        counters = await self.drain_due(store, hub)
        self.assertEqual(counters, {"published": 1})
        self.assertEqual(store.counts(), (0, 1))
        self.assertEqual(store.db.execute("SELECT receipt_delivered FROM commands").fetchone()[0], 1)
        self.assertEqual((await self.stored(rqi))["con"], receipt)
        self.assertEqual(await self.count(), 1)
        self.assertNotIn("POST " + self.parent + " " + rqi, await asyncio.to_thread(self.stack.logs, "proxy"))
        self.delivery_facts = {"syntheticReceipt": True, "deviceExecuted": False, "receiptDeliveredBefore": 0,
                               "receiptDeliveredAfter": 1, "remainingOutbox": 0, "remoteCinCount": 1,
                               "httpsPostFallbackCount": 0, "rqi": rqi}

    async def test_outbox_cse_outage_retains_backoff_across_reopen_then_recovers(self):
        store, reopen, _path, _binding = self.store_for()
        payload = observation()
        store.observation(self.parent, payload)
        original = self.queued(store)
        await asyncio.to_thread(self.stack.stop_cse)
        try:
            counters = await self.drain_due(store)
            self.assertEqual(counters, {"publish_retries": 1})
            failed = self.queued(store)
            self.assertEqual((failed["rqi"], failed["payload"]), (original["rqi"], original["payload"]))
            self.assertEqual(failed["attempts"], 1)
            self.assertGreater(failed["next_attempt"], 0)
            store.close()
            store = reopen()
            self.assertEqual(self.queued(store), failed)
        finally:
            await asyncio.to_thread(self.stack.start_cse)
        await self.ready()
        # Observe real persisted backoff, without patching clocks or queue deadlines.
        import time
        await asyncio.sleep(max(0, failed["next_attempt"] - time.time()) + 0.02)
        self.assertEqual(await self.drain_due(store), {"published": 1})
        self.assertIsNone(self.queued(store))
        self.assertEqual((await self.stored(original["rqi"]))["con"], payload)
        self.assertEqual(await self.count(), 1)
        self.delivery_facts = {"failedAttempts": 1, "backoffPreservedAcrossReopen": True,
                               "remainingOutboxAfterRecovery": 0, "remoteCinCount": 1, "rqi": original["rqi"]}

    async def test_outbox_process_death_after_remote_commit_retries_one_cin(self):
        store, reopen, path, binding = self.store_for()
        payload = observation()
        store.observation(self.parent, payload)
        original = self.queued(store)
        store.close()
        fixture = path.parent / "test-child.json"
        fixture.write_text(json.dumps({"config": vars(self.hub.config), "database": str(path),
                                      "binding": binding, "expectedRqi": original["rqi"]}, default=str), encoding="utf-8")
        child = Path(__file__).with_name("delivery_child.py")
        result = await asyncio.to_thread(subprocess.run, [sys.executable, str(child), str(fixture)],
                                         capture_output=True, text=True, encoding="utf-8", timeout=12)
        self.assertEqual(result.returncode, 73, result.stdout + result.stderr)
        marker = json.loads(result.stdout.strip())
        self.assertEqual(marker, {"phase": "remote-confirmed-before-local-confirmation", "rqi": original["rqi"]})
        self.assertEqual((await self.stored(original["rqi"]))["con"], payload)
        store = reopen()
        self.assertEqual(self.queued(store), original)
        self.assertEqual(await self.drain_due(store), {"published": 1})
        self.assertIsNone(self.queued(store))
        self.assertEqual(await self.count(), 1)
        self.delivery_facts = {"childExitCode": result.returncode, "childMarker": marker,
                               "unconfirmedLocalRowRecovered": True, "remainingOutbox": 0, "remoteCinCount": 1}

    async def test_outbox_content_conflict_retains_row_and_remote_original(self):
        store, _reopen, _path, _binding = self.store_for()
        original, different = {"synthetic": True, "value": 1}, {"synthetic": True, "value": 2}
        rqi = store.request_id("conflict-test", "synthetic")
        await self.hub.publish(rqi, self.parent, original)
        store.enqueue("conflict-test", "synthetic", self.parent, different, critical=True)
        self.assertEqual(await self.drain_due(store), {"publish_retries": 1})
        pending = self.queued(store)
        self.assertEqual((pending["rqi"], pending["attempts"], json.loads(pending["payload"])), (rqi, 1, different))
        self.assertEqual((await self.stored(rqi))["con"], original)
        self.assertEqual(await self.count(), 1)
        self.delivery_facts = {"remoteOriginalPreserved": True, "conflictingOutboxRetained": True,
                               "attempts": 1, "remoteCinCount": 1, "rqi": rqi}
