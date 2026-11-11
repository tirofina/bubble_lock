"""Feather relay with fake BLE/HTTP and a real fresh SQLite outbox; no radio."""
import asyncio
from dataclasses import replace
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx

from bubble_gateway.config import GatewayConfig
from bubble_gateway.model import canonical, payload_hash
from bubble_gateway.state_identity import configured_binding
from bubble_gateway.store import Store
from helpers import observation


path = Path(__file__).resolve().parents[1] / "relay.py"
spec = importlib.util.spec_from_file_location("feather_relay", path)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class FeatherRelayTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="feather-relay-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "output"
        self.output.mkdir(mode=0o700)
        # Transport is mocked below: these files only satisfy configuration checks.
        cert = self.root / "synthetic.pem"
        cert.write_text("mock-only", encoding="ascii")
        env = dict(GATEWAY_ID="gw-feather-bench", M2M_ORIGINATOR="Ctest", M2M_CSE_ID="test-cse",
                   M2M_CSE_URL="https://fixture.invalid", PC_API_URL="https://fixture.invalid",
                   TLS_CA_FILE=str(cert), TLS_CERT_FILE=str(cert), TLS_KEY_FILE=str(cert),
                   M2M_RVI="4", MQTT_ENABLED="false", CORE_BRIDGE_ENABLED="false",
                   M2M_OBSERVATION_CONTAINER="/test/observations", M2M_RECEIPT_CONTAINER="/test/receipts",
                   M2M_HEALTH_CONTAINER="/test/health", GATEWAY_DATABASE=str(self.root / "unused.sqlite3"),
                   BLE_DEVICES=json.dumps({relay.DEVICE_ID: "00:00:00:00:00:01"}),
                   BLE_GATT_PROFILE="core-v1", BLE_PAIR="true", FIRMWARE_REVISION_ALLOWLIST=relay.FIRMWARE)
        self.environment = env
        with patch.dict(os.environ, env, clear=True):
            self.config = GatewayConfig.from_env()
        self.frames = [observation(gatewayId=self.config.gateway_id, deviceId=relay.DEVICE_ID,
                                   firmwareRevision=relay.FIRMWARE, battery=None,
                                   sequence=index + 1, buttonState=state)
                       for index, state in enumerate(("released", "confirm", "panic"))]

    def scoped_config(self):
        return replace(self.config, gateway_id="gw-a", cse_url="https://localhost:8760",
                       mqtt_enabled=True, mqtt_host="localhost", mqtt_port=8884, m2m_mqtt_enabled=False,
                       core_bridge_enabled=True, core_telemetry_epochs={relay.DEVICE_ID: 1},
                       observation_container=relay.BENCH_ROOT + "/observations",
                       receipt_container=relay.BENCH_ROOT + "/receipts",
                       health_container=relay.BENCH_ROOT + "/health")

    def test_explicit_env_wins_and_inherited_environment_is_restored(self):
        env_file = self.root / "relay.env"
        env_file.write_text("".join(f"{key}={value}\n" for key, value in self.environment.items()),
                            encoding="utf-8")
        inherited = dict(M2M_CSE_URL="https://unexpected.invalid",
                         BLE_DEVICES=json.dumps({"unexpected-device": "00:00:00:00:00:99"}),
                         TLS_KEY_FILE=str(self.root / "unexpected-missing.key"),
                         RELAY_PARENT_ONLY="preserve-this-value")
        with patch.dict(os.environ, inherited, clear=True):
            before = dict(os.environ)
            loaded = relay.load_config(env_file)
            self.assertEqual(loaded, self.config)
            self.assertEqual(dict(os.environ), before)

    async def run_relay(self, corrupt=False, mqtt=False, scoped=False):
        stored, fleets, hubs = {}, [], []
        http_posts = []
        frames = [dict(frame, gatewayId="gw-a") for frame in self.frames] if scoped else self.frames
        applied = []

        class FakeFleet:
            def __init__(self, _config):
                self.closed = False
                fleets.append(self)

            async def start(self, callback):
                if mqtt:
                    assert hubs[0]._ready.is_set(), "BLE started before MQTT response subscription"
                async def deliver():
                    for frame in frames:
                        await callback(frame)
                        await asyncio.sleep(0)
                self.task = asyncio.create_task(deliver())

            async def close(self):
                self.closed = True
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)

        def handle(request):
            rqi = request.headers["X-M2M-RI"]
            headers = {"X-M2M-RI": rqi}
            if request.method == "POST":
                http_posts.append(request.url.path)
                cin = json.loads(request.content)["m2m:cin"]
                stored[request.url.path + "/" + cin["rn"]] = cin
                return httpx.Response(201, headers=headers | {"X-M2M-RSC": "2001"}, json={})
            if scoped and request.url.path == relay.FEATHER_SDT:
                return httpx.Response(200, headers=headers | {"X-M2M-RSC": "2000"},
                                      json={"pb:binarySwitch": {"rn": "featherState", "state": applied[-1],
                                            "cnd": "org.onem2m.common.moduleclass.binarySwitch"}})
            cin = json.loads(canonical(stored[request.url.path]))
            if corrupt:
                cin["con"]["buttonState"] = "panic"
            return httpx.Response(200, headers=headers | {"X-M2M-RSC": "2000"}, json={"m2m:cin": cin})

        class FakeMqtt:
            def __init__(self, hub):
                self.hub = hub

            def publish(self, topic, *, payload, qos, retain):
                if scoped:
                    assert topic == f"privacy-bubble/gateway/gw-a/telemetry-epoch/{relay.DEVICE_ID}/1"
                    assert qos == 1 and retain is False
                    sample = json.loads(payload)
                    assert sample["schemaVersion"] == "1.1.0" and sample["batteryPct"] is None
                    applied.append(sample["state"])
                    receipt = dict(version=1, gatewayId="gw-a", deviceId=relay.DEVICE_ID,
                                   ownershipEpoch=1, sequence=sample["sequence"],
                                   payloadHash=hashlib.sha256(payload).hexdigest(),
                                   cseRequestId="kr-" + f"{sample['sequence']:048x}", responseStatus=2004)
                    self.hub._on_message(None, None, SimpleNamespace(
                        topic=f"privacy-bubble/gateway/gw-a/telemetry-result/{relay.DEVICE_ID}/1",
                        retain=False, payload=json.dumps(receipt).encode()))
                    return SimpleNamespace(rc=0)
                assert topic == self.hub._request_topic and qos == 1 and retain is False
                request = json.loads(payload)
                cin = request["pc"]["m2m:cin"]
                stored["/" + request["to"] + "/" + cin["rn"]] = cin
                self.hub._receive({"rqi": request["rqi"], "rsc": 2001})
                return SimpleNamespace(rc=0)

            def disconnect(self):
                pass

            def loop_stop(self):
                pass

        class MockHttpHub(relay.RelayTransport):
            async def start(self):
                hubs.append(self)
                self._http = httpx.AsyncClient(transport=httpx.MockTransport(handle), trust_env=False)
                if self.config.mqtt_enabled:
                    self._loop = asyncio.get_running_loop()
                    self._mqtt = FakeMqtt(self)
                    asyncio.get_running_loop().call_soon(self._ready.set)

        config = replace(self.config, mqtt_enabled=mqtt, mqtt_host="fixture.invalid")
        if scoped:
            config = self.scoped_config()
        with patch.object(relay, "BleFleet", FakeFleet), patch.object(relay, "RelayTransport", MockHttpHub):
            summary = await relay.run_capture(config, self.output, 3, 5,
                                              scoped_database=self.root / "scoped.sqlite3" if scoped else None)
        self.assertTrue(all(fleet.closed for fleet in fleets))
        self.assertTrue(all(hub._http is None for hub in hubs))
        self.assertFalse(self.config.database.exists())
        self.assertEqual(len(stored), 3)
        self.assertEqual(len(http_posts), 0 if mqtt and not scoped else 3)
        return summary

    async def test_real_outbox_relay_matches_each_cse_readback(self):
        summary = await self.run_relay()
        self.assertEqual(summary["status"], "passed")
        self.assertEqual((summary["capturedCount"], summary["publishedCount"], summary["readbackCount"]), (3, 3, 3))
        self.assertEqual(summary["sequences"], [1, 2, 3])
        self.assertEqual(summary["buttonStates"], ["released", "confirm", "panic"])
        self.assertEqual(summary["payloadSha256"], [payload_hash(frame) for frame in self.frames])
        self.assertEqual(summary["readbackSha256"], summary["payloadSha256"])
        captured = [json.loads(line) for line in (self.output / "observations.jsonl").read_text().splitlines()]
        self.assertEqual(captured, self.frames)
        self.assertFalse(summary["tlsPolicy"]["handshakeVersionMeasured"])
        self.assertEqual(summary["deliveryChannels"], {"mqtt": 0, "https": 3})

    async def test_mqtt_application_responses_settle_real_outbox_without_http_posts(self):
        summary = await self.run_relay(mqtt=True)
        self.assertEqual(summary["status"], "passed")
        self.assertEqual((summary["capturedCount"], summary["publishedCount"], summary["readbackCount"]), (3, 3, 3))
        self.assertEqual(summary["deliveryChannels"], {"mqtt": 3, "https": 0})
        self.assertEqual(summary["readbackSha256"], summary["payloadSha256"])

    async def test_readback_mismatch_fails_after_successful_publication(self):
        summary = await self.run_relay(corrupt=True)
        self.assertEqual(summary["status"], "failed")
        self.assertEqual(summary["error"], "READBACK_MISMATCH")
        self.assertEqual(summary["publishedCount"], 3)
        self.assertEqual(summary["readbackCount"], 0)
        relay.write_receipt(self.output, summary)
        receipt = json.loads((self.output / "receipt.json").read_text())
        self.assertEqual(receipt["capturedCount"], 3)
        self.assertNotIn("fixture.invalid", json.dumps(receipt))
        self.assertNotIn("00:00:00:00:00:01", json.dumps(receipt))

    async def test_scoped_relay_keeps_native_and_application_receipts_separate(self):
        summary = await self.run_relay(scoped=True)
        self.assertEqual(summary["status"], "passed", summary)
        self.assertEqual(summary["publishedCount"], 3)
        self.assertEqual(summary["deliveryChannels"], {"mqtt": 0, "https": 3})
        self.assertEqual(summary["readbackSha256"], summary["payloadSha256"])
        self.assertEqual(summary["scopedReceiptCount"], 3)
        self.assertEqual([receipt["sequence"] for receipt in summary["scopedReceipts"]], [0, 1, 2])
        self.assertIs(summary["sdtReadbackState"], False)

    async def test_scoped_recovery_reuses_pending_bytes_without_starting_ble(self):
        config = self.scoped_config()
        database = self.root / "scoped.sqlite3"
        original = dict(self.frames[0], gatewayId="gw-a")
        store = Store(database, 100, 5000000, 20, configured_binding(config))
        try:
            store.observation(config.observation_container, original, True, core_epochs=config.core_telemetry_epochs)
            expected = {rqi: row["payload"] for rqi, row in relay.pending_recovery_rows(store, config).items()}
        finally:
            store.close()

        async def start(hub):
            hub._ready.set()

        async def publish(_hub, rqi, container, payload):
            self.assertTrue((self.output / "recovery-plan.jsonl").is_file())
            self.assertEqual(payload, expected[rqi])
            if container == "@core/telemetry":
                wire = {key: value for key, value in payload.items() if key != "ownershipEpoch"}
                return {"payloadHash": payload_hash(wire), "responseStatus": 2004}

        async def readback(_hub, rqi, _container):
            return expected[rqi]

        with (patch.object(relay, "BleFleet", side_effect=AssertionError("recovery started BLE")),
              patch.object(relay.TransportHub, "start", start),
              patch.object(relay.TransportHub, "publish", publish),
              patch.object(relay.TransportHub, "read_content", readback)):
            summary = await relay.run_recovery(config, self.output, database, 5)
        self.assertEqual(summary["status"], "passed", summary)
        self.assertEqual((summary["pendingCount"], summary["confirmedCount"], summary["remainingCount"]), (2, 2, 0))
        rows = [json.loads(line) for line in (self.output / "recovery-receipts.jsonl").read_text().splitlines()]
        self.assertEqual({row["rqi"] for row in rows}, set(expected))
        self.assertEqual(sum("scopedReceipt" in row for row in rows), 1)
        self.assertEqual(sum("readbackSha256" in row for row in rows), 1)
        store = Store(database, 100, 5000000, 20, configured_binding(config))
        try:
            self.assertEqual(store.counts(), (0, 0))
            self.assertEqual(store.db.execute("SELECT wire_sequence FROM core_sequences").fetchone()[0], 0)
        finally:
            store.close()
