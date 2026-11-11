"""Opt-in real Mobius4 readback against synthetic journal and private Gateway archives."""
import asyncio
from datetime import timedelta
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import httpx
from bubble_gateway.config import GatewayConfig
from bubble_gateway.model import canonical, iso_time, parse_time, payload_hash
from bubble_gateway.service import Gateway
from bubble_gateway.state_archive import archive
from bubble_gateway.store import Store
from bubble_gateway.transport import RemoteResponseError, TransportHub
from helpers import DEVICES, command, device_receipt
from mobius_fixture import DisposableMobius
from tls_fixture import TestPki


class JournalReconcileTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        pki = cls.pki = TestPki()
        cls.addClassCleanup(pki.close)
        server = pki.root / "server-only"
        server.mkdir()
        for name in ("trusted.pem", "server.pem", "server.key"):
            shutil.copyfile(pki.root / name, server / name)
        cls.stack = DisposableMobius(SimpleNamespace(root=server))
        cls.addClassCleanup(cls.stack.close)

    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory(prefix="keyring-reconcile-test-")
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.device_archive = self.directory / "device"
        self.gateway_archive = self.directory / "gateway"
        self.parent = "/Mobius/reconcile-" + uuid.uuid4().hex[:12]
        self.env = {
            "GATEWAY_ID": "gw-test", "M2M_ORIGINATOR": self.stack.admin, "M2M_CSE_ID": self.stack.cse_id,
            "M2M_CSE_URL": self.stack.origin, "PC_API_URL": "https://127.0.0.1:1", "M2M_RVI": "4",
            "M2M_RECEIPT_CONTAINER": self.parent, "M2M_OBSERVATION_CONTAINER": self.parent + "-obs",
            "M2M_HEALTH_CONTAINER": self.parent + "-health", "BLE_DEVICES": json.dumps(DEVICES),
            "TLS_CA_FILE": str(self.pki.path("trusted")), "TLS_CERT_FILE": str(self.pki.path("client")),
            "TLS_KEY_FILE": str(self.pki.path("client", "key")), "MQTT_ENABLED": "false",
            "GATEWAY_DATABASE": str(self.directory / "gateway.sqlite3"), "REQUEST_TIMEOUT": "3",
        }
        self.env_path = self.directory / "reconcile.env"
        self.env_path.write_text("\n".join(f"{key}={value}" for key, value in self.env.items()), encoding="utf-8")
        with patch.dict(os.environ, self.env, clear=True):
            self.config = GatewayConfig.from_env()
        self.hub = TransportHub(self.config)
        self.addAsyncCleanup(self.hub.close)
        await self.hub.start()
        async with asyncio.timeout(20):
            while True:
                try:
                    if (await self.cse("GET", "/Mobius"))[:2] == (200, 2000):
                        break
                except (RemoteResponseError, httpx.TransportError):
                    pass
                await asyncio.sleep(0.2)
        body = {"m2m:cnt": {"rn": self.parent.rsplit("/", 1)[1], "mni": 32}}
        self.assertEqual((await self.cse("POST", "/Mobius", body))[:2], (201, 2001))

    async def cse(self, method, path, body=None):
        rqi = "reconcile-test-" + uuid.uuid4().hex
        headers = self.hub._m2m_headers(rqi, create=body is not None)
        if body is not None:
            headers["Content-Type"] = "application/json;ty=3"
        status, response, document = await self.hub._http_json(
            method, self.stack.origin + path, headers=headers, body=body)
        return status, self.hub._response_rsc(status, response, rqi), document

    def write_device_archive(self, records):
        self.device_archive.mkdir()
        data = "".join(canonical(record) + "\n" for record in records).encode()
        (self.device_archive / "records.jsonl").write_bytes(data)
        identity = dict(version=1, deviceId="kr-test", firmwareRevision="keyring-0.7.2",
                        boardRevision="r18", bootId="boot-now")
        manifest = dict(version=1, requestId="00000001", status="ok", type="manifest",
                        snapshotId="a" * 32, deviceId="kr-test", bootId="boot-now", capturedUptimeMs=1000,
                        recordCount=len(records), preparedCount=sum(row["phase"] == "prepared" for row in records),
                        capacity=32, format=1, maxEpoch=2, maxGrant=3)
        info = dict(archiveVersion=1, settlementStatus="not-settled", deviceJournalModified=False,
                    identity=identity, deviceSnapshot=manifest, recordCount=len(records),
                    files=[dict(path="records.jsonl", bytes=len(data), sha256=hashlib.sha256(data).hexdigest())])
        (self.device_archive / "manifest.json").write_text(canonical(info), encoding="utf-8")

    async def create_archives(self, *, current_boot=False):
        gateway = Gateway(self.config)
        self.addCleanup(gateway.store.close)
        records = []
        for name in ("applied", "unconfirmed", "prepared", "contradiction", "missing-cse", "changed-cse",
                     "foreign", "missing-command", "missing-receipt", "readback-failure"):
            cmd = command(commandId=name)
            digest = payload_hash(cmd)
            prepared = name in {"prepared", "contradiction"}
            readback = name != "readback-failure"
            boot = "boot-now" if current_boot and name in {"applied", "unconfirmed"} else "boot-old"
            record = dict(commandId=name, payloadHash=digest, bootId=boot, ownershipEpoch=2, grantRevision=3,
                          phase="prepared" if prepared else "completed",
                          ackCode="INDETERMINATE" if prepared else "APPLIED" if readback else "READBACK_MISMATCH",
                          desiredState=True, readback=None if prepared else readback, acceptedUptimeMs=100,
                          appliedUptimeMs=None if prepared else 101, storageCrc32="12345678")
            records.append(record)
            if name == "missing-command":
                continue
            gateway.store.accept(cmd, digest)
            if name == "missing-receipt":
                continue
            code = {"unconfirmed": "DUPLICATE", "prepared": "INDETERMINATE",
                    "readback-failure": "READBACK_MISMATCH"}.get(name, "APPLIED")
            status = "APPLIED" if code in {"APPLIED", "DUPLICATE"} else "INDETERMINATE"
            firmware = "keyring-0.7.2" if current_boot and name == "applied" else "keyring-0.7.0"
            reply = device_receipt(cmd, digest, bootId=boot, readback={"state": readback}, firmwareRevision=firmware)
            receipt = gateway._receipt(cmd, digest, status, code, device=reply if name != "prepared" else None)
            gateway.store.finish(name, receipt)
            if name == "foreign":
                record["payloadHash"] = "0" * 64
                continue
            if name != "missing-cse":
                value = dict(receipt, readback={"state": False}) if name == "changed-cse" else receipt
                rqi = Store.request_id("receipt", name)
                await self.hub.publish(rqi, self.parent, value)
                if name == "applied":
                    gateway.store.stage_receipts(self.parent, False)
                    gateway.store.delivered(rqi)
                if current_boot:
                    self.integration_state = self.directory / "runtime.json"
                    self.integration_state.write_text(canonical(self.applied_integration_state(cmd, receipt)),
                                                      encoding="utf-8")
        self.write_device_archive(records)
        # Windows does not implement POSIX directory fsync; the SQLite backup is real.
        with patch("bubble_gateway.state_archive._sync_directory"):
            archive(self.config, self.gateway_archive, adopt=False, timeout=5)

    def applied_integration_state(self, command, receipt):
        command_id = command["commandId"]
        digest, receipt_digest = payload_hash(command), payload_hash(receipt)
        claimed = iso_time(parse_time(command["issuedAt"]) + timedelta(milliseconds=100))
        started = iso_time(parse_time(claimed) + timedelta(milliseconds=100))
        settled = iso_time(parse_time(receipt["receivedAt"]) + timedelta(milliseconds=100))
        record = {"command": command, "payloadHash": digest, "lastReceiptHash": receipt_digest,
                  "executionState": "APPLIED_VERIFIED", "readback": receipt["readback"], "desiredGeneration": 1,
                  "claimCommittedAt": claimed, "dispatchStartedAt": started,
                  "claimExpiresAt": command["deadline"], "settledAt": settled}
        envelope = {"contractId": "privacy-bubble.integration.v1", "docRevision": "2.0.0",
                    "gatewayId": command["gatewayId"], "commandId": command_id, "claimId": command["claimId"],
                    "payloadHash": digest, "desiredGeneration": 1}
        dispatch_event = dict(envelope, type="GATEWAY_DISPATCH_STARTED", eventId="evt-dispatch", timestamp=started,
                              executionState="IN_FLIGHT", deviceId=command["deviceId"], ownershipEpoch=command["ownershipEpoch"],
                              grantRevision=command["grantRevision"], dispatchStartedAt=started, claimCommittedAt=claimed)
        settlement_event = dict(envelope, type="GATEWAY_RECEIPT_SETTLED", eventId="evt-settlement", timestamp=settled,
                                executionState="APPLIED_VERIFIED", ueId=command["deviceId"], epoch=command["ownershipEpoch"],
                                receiptHash=receipt_digest)
        return {"gatewayCommands": {command_id: record}, "receipts": [dispatch_event, settlement_event],
                "gatewayDeviceReceipts": {command_id: {"receiptHash": receipt_digest, "receipt": receipt, "receivedAt": settled}}}

    async def audit(self, *options):
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "bubble_gateway.journal_reconcile", "--env-file", str(self.env_path),
            "--device-archive", str(self.device_archive), "--gateway-archive", str(self.gateway_archive), *options,
            env={key: value for key, value in os.environ.items() if key not in self.env},
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), 25)
        return process.returncode, stdout, stderr

    async def test_readback_comparison_and_archive_integrity(self):
        await self.create_archives()
        before = (await self.cse("GET", self.parent))[2]["m2m:cnt"]["cni"]
        input_files = [self.gateway_archive / "gateway.sqlite3", self.device_archive / "records.jsonl"]
        original = [file.read_bytes() for file in input_files]
        status, stdout, stderr = await self.audit()
        self.assertEqual(status, 0, stderr.decode())
        report = json.loads(stdout)
        expected = {
            "applied": "matched_applied", "unconfirmed": "matched_applied", "prepared": "device_prepared",
            "contradiction": "device_result_mismatch", "missing-cse": "missing_cse_receipt",
            "changed-cse": "cse_receipt_mismatch", "foreign": "gateway_binding_mismatch",
            "missing-command": "missing_gateway_command", "missing-receipt": "missing_gateway_receipt",
            "readback-failure": "matched_readback_failure",
        }
        self.assertEqual({row["commandId"]: row["result"] for row in report["results"]}, expected)
        self.assertEqual(report["reviewCount"], 9)
        self.assertIs(report["results"][1]["gatewayDelivered"], False)
        self.assertEqual(report["receiptContainer"], self.parent)
        matching, changed = report["results"][0], report["results"][5]
        self.assertEqual(matching["gatewayReceiptSha256"], matching["cseReceiptSha256"])
        original_cin = await self.hub.read_content_instance(Store.request_id("receipt", "applied"), self.parent)
        self.assertEqual(matching["nativeResourceId"], original_cin["ri"])
        self.assertRegex(matching["nativeStoredAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$")
        self.assertIs(matching["deviceReadbackState"], True)
        self.assertEqual(report["deviceRecordsSha256"], hashlib.sha256(original[1]).hexdigest())
        self.assertEqual(report["recordCount"], len(expected))
        self.assertNotEqual(changed["gatewayReceiptSha256"], changed["cseReceiptSha256"])
        self.assertEqual(report["settlementStatus"], "not-settled")
        self.assertEqual([file.read_bytes() for file in input_files], original)
        self.assertEqual((await self.cse("GET", self.parent))[2]["m2m:cnt"]["cni"], before)

        input_files[1].write_bytes(original[1] + b" ")
        status, stdout, stderr = await self.audit()
        self.assertEqual((status, stdout), (1, b""))
        self.assertIn(b"BleProtocolError", stderr)
        input_files[1].write_bytes(original[1])
        input_files[0].write_bytes(original[0] + b" ")
        status, stdout, stderr = await self.audit()
        self.assertEqual((status, stdout), (1, b""))
        self.assertIn(b"RECONCILE_ARCHIVE_DIGEST", stderr)
        input_files[0].write_bytes(original[0])
        manifest_path = self.gateway_archive / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["binding"]["receiptContainer"] += "-foreign"
        manifest["bindingSha256"] = payload_hash(manifest["binding"])
        manifest_path.write_text(canonical(manifest), encoding="utf-8")
        status, stdout, stderr = await self.audit()
        self.assertEqual((status, stdout), (1, b""))
        self.assertIn(b"RECONCILE_ARCHIVE_BINDING", stderr)
        print(json.dumps({"records": len(expected), "review": report["reviewCount"], "cseCinsUnchanged": before,
                          "deviceAndGatewayTamperingRejected": True, "foreignResourceBindingRejected": True}), flush=True)

    async def test_single_command_binds_capture_boot_and_receipt_firmware(self):
        await self.create_archives(current_boot=True)
        revisions = ("--board-revision", "r18", "--firmware-revision", "keyring-0.7.2")
        status, stdout, stderr = await self.audit("--same-boot-command", "applied", *revisions)
        self.assertEqual(status, 0, stderr.decode())
        report = json.loads(stdout)
        self.assertEqual(report["recordCount"], 1)
        self.assertEqual(report["reviewCount"], 0)
        self.assertEqual(report["selectedCommand"], {
            "commandId": "applied", "boardRevision": "r18", "firmwareRevision": "keyring-0.7.2", "sameBoot": True,
            "sourceRecordCount": 10, "desiredState": True, "acceptedUptimeMs": 100, "appliedUptimeMs": 101,
        })
        self.assertEqual(report["results"][0]["gatewayAckCode"], "APPLIED")
        self.assertEqual(report["results"][0]["result"], "matched_applied")
        self.assertNotIn(b"boot-now", stdout)

        raw = self.integration_state.read_bytes()
        options = ("--same-boot-command", "applied", *revisions, "--team-state", str(self.integration_state))
        status, stdout, stderr = await self.audit(*options)
        self.assertEqual(status, 0, stderr.decode())
        report = json.loads(stdout)
        self.assertEqual(report["integrationStateSha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(report["integrationSettlement"], {
            "status": "settlement_matched", "originalApplicationMatched": True,
            "dispatchEventId": "evt-dispatch", "settlementEventId": "evt-settlement",
        })
        self.assertEqual(report["reviewCount"], 0)
        state = json.loads(raw)
        state["receipts"][0]["claimId"] = "different-claim"
        self.integration_state.write_text(canonical(state), encoding="utf-8")
        status, stdout, stderr = await self.audit(*options)
        self.assertEqual(status, 0, stderr.decode())
        report = json.loads(stdout)
        self.assertEqual(report["integrationSettlement"], {
            "status": "settlement_mismatch", "originalApplicationMatched": False,
        })
        self.assertEqual(report["reviewCount"], 1)

        for command_id, error in (("missing-cse", b"RECONCILE_DEVICE_BOOT_MISMATCH"),
                                  ("unknown", b"RECONCILE_DEVICE_COMMAND_MISSING")):
            with self.subTest(command_id=command_id):
                status, stdout, stderr = await self.audit("--same-boot-command", command_id, *revisions)
                self.assertEqual((status, stdout), (1, b""))
                self.assertIn(error, stderr)
        status, stdout, stderr = await self.audit("--same-boot-command", "applied", "--board-revision", "other",
                                                  "--firmware-revision", "keyring-0.7.2")
        self.assertEqual((status, stdout), (1, b""))
        self.assertIn(b"RECONCILE_DEVICE_REVISION_MISMATCH", stderr)

        status, stdout, stderr = await self.audit("--same-boot-command", "unconfirmed", *revisions)
        self.assertEqual(status, 0, stderr.decode())
        self.assertEqual(json.loads(stdout)["results"][0]["result"], "device_result_mismatch")


if __name__ == "__main__":
    unittest.main()
