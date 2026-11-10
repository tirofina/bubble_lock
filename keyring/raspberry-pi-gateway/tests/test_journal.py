import hashlib
import json
import struct
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from bubble_gateway.ble import BleProtocolError
from bubble_gateway.journal_export import capture, compare_archives


class JournalMockTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = dict(version=1, deviceId="kr-test", firmwareRevision="keyring-0.7.0",
                             boardRevision="r18", bootId="boot-test")
        self.manifest = dict(version=1, requestId="00000000", status="ok", type="manifest",
                             snapshotId="a" * 32, deviceId="kr-test", bootId="boot-test",
                             capturedUptimeMs=1000, recordCount=1, preparedCount=1, capacity=32,
                             format=1, maxEpoch=2, maxGrant=3)
        self.parts = [dict(commandId="cmd-test", payloadHash="b" * 64, bootId="boot-test",
                           ownershipEpoch=2, grantRevision=3),
                      dict(phase="prepared", ackCode="INDETERMINATE", desiredState=True,
                           readback=None, acceptedUptimeMs=100, appliedUptimeMs=None, storageCrc32="12345678")]
        self.operations = []
        self.response = None

        async def write(_uuid, packet, response):
            self.assertTrue(response)
            version, operation, nonce, index, part = struct.unpack("<BBIBB", packet)
            self.assertEqual(version, 1)
            self.operations.append(operation)
            frame = (deepcopy(self.manifest) if operation == 1 else
                     dict(version=1, status="ok", type="record", snapshotId=self.manifest["snapshotId"],
                          index=index, part=part, parts=2, data=deepcopy(self.parts[part])) if operation == 2 else
                     dict(version=1, status="ok", type="closed"))
            frame["requestId"] = f"{nonce:08x}"
            self.response = json.dumps(frame).encode()

        async def read(_uuid):
            return self.response

        self.client = SimpleNamespace(services=SimpleNamespace(get_characteristic=lambda _: object()),
                                      write_gatt_char=AsyncMock(side_effect=write),
                                      read_gatt_char=AsyncMock(side_effect=read))

    async def test_prepared_record_is_preserved_without_claiming_application(self):
        snapshot = await capture(self.client, self.identity, "core-v1")
        self.assertEqual(len(snapshot["records"]), 1)
        self.assertEqual(snapshot["records"][0]["phase"], "prepared")
        self.assertIsNone(snapshot["records"][0]["appliedUptimeMs"])
        self.assertEqual(self.operations, [1, 2, 2, 3])  # capture/read/read/volatile-close only

    async def test_prepared_cannot_claim_readback_and_capture_closes_on_error(self):
        self.parts[1]["readback"] = True
        with self.assertRaises(BleProtocolError):
            await capture(self.client, self.identity, "core-v1")
        self.assertEqual(self.operations[-1], 3)

    async def test_duplicate_command_ids_rejected_and_capture_closed(self):
        self.manifest.update(recordCount=2, preparedCount=2)
        with self.assertRaises(BleProtocolError):
            await capture(self.client, self.identity, "core-v1")
        self.assertEqual(self.operations[-1], 3)


class JournalHistoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.first = dict(commandId="cmd-first", payloadHash="b" * 64, bootId="boot-old",
                          ownershipEpoch=2, grantRevision=3, phase="prepared", ackCode="INDETERMINATE",
                          desiredState=True, readback=None, acceptedUptimeMs=100, appliedUptimeMs=None,
                          storageCrc32="12345678")
        self.second = dict(self.first, commandId="cmd-second", grantRevision=4)

    def archive(self, slot, records, *, device="kr-test", boot="boot-old", uptime=1000):
        path = self.root / str(slot)
        path.mkdir()
        data = b"".join((json.dumps(record) + "\n").encode() for record in records)
        (path / "records.jsonl").write_bytes(data)
        identity = dict(version=1, deviceId=device, firmwareRevision=f"keyring-0.7.{slot}",
                        boardRevision="r18", bootId=boot)
        snapshot = dict(version=1, requestId="00000000", status="ok", type="manifest", snapshotId=f"{slot:032x}",
                        deviceId=device, bootId=boot, capturedUptimeMs=uptime, recordCount=len(records),
                        preparedCount=sum(record["phase"] == "prepared" for record in records), capacity=32,
                        format=1, maxEpoch=max((record["ownershipEpoch"] for record in records), default=0),
                        maxGrant=max((record["grantRevision"] for record in records), default=0))
        manifest = dict(archiveVersion=1, identity=identity, gattProfile="core-v1", deviceSnapshot=snapshot,
                        recordCount=len(records), archivedAt=f"2026-11-11T00:00:0{slot}Z",
                        timestampSource="gateway-received", settlementStatus="not-settled",
                        deviceJournalModified=False, containsPlaintextCommandMetadata=True,
                        files=[dict(path="records.jsonl", bytes=len(data), sha256=hashlib.sha256(data).hexdigest())],
                        limitations=["storage CRC is metadata, not a transport signature"])
        (path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        return path

    def test_continuous_prefix_across_reboot_and_firmware_update(self):
        old = self.archive(1, [self.first])
        new = self.archive(2, [self.first, self.second], boot="boot-new", uptime=5)
        report = compare_archives(old, new)
        self.assertEqual(report["status"], "CONTINUOUS")
        self.assertEqual(report["appendedRecordCount"], 1)
        self.assertFalse(report["sameBoot"])
        self.assertEqual(report["settlementStatus"], "not-settled")

    def test_detects_tail_loss_and_same_count_mutation_or_reordering(self):
        old = self.archive(1, [self.first, self.second])
        shortened = self.archive(2, [self.first], boot="boot-new")
        report = compare_archives(old, shortened)
        self.assertEqual(report["status"], "REVIEW_REQUIRED")
        self.assertEqual(report["findings"], [{"code": "fence_regressed", "field": "maxGrant"},
                                             {"code": "record_missing", "baselineIndex": 1}])
        changed = self.archive(3, [self.second, dict(self.first, payloadHash="a" * 64, storageCrc32="12345679")])
        report = compare_archives(old, changed)
        self.assertEqual(report["status"], "REVIEW_REQUIRED")
        self.assertIsNone(report["appendedRecordCount"])
        self.assertEqual([row["code"] for row in report["findings"]],
                         ["record_reordered", "record_changed", "record_reordered"])
        self.assertEqual(report["findings"][1]["fields"], ["payloadHash", "storageCrc32"])

    def test_rejects_unrelated_duplicate_reversed_or_modified_input(self):
        old = self.archive(1, [self.first])
        unrelated = self.archive(2, [self.first], device="kr-other")
        with self.assertRaisesRegex(BleProtocolError, "different devices"):
            compare_archives(old, unrelated)
        with self.assertRaisesRegex(BleProtocolError, "distinct captures"):
            compare_archives(old, old)
        earlier = self.archive(3, [self.first], uptime=999)
        with self.assertRaisesRegex(BleProtocolError, "after the baseline"):
            compare_archives(old, earlier)
        altered = self.archive(4, [self.first])
        (altered / "records.jsonl").write_bytes(b"\n")
        with self.assertRaisesRegex(BleProtocolError, "bytes do not match manifest"):
            compare_archives(old, altered)
