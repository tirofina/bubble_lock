import json
import struct
import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

from bubble_gateway.ble import BleProtocolError
from bubble_gateway.journal_export import capture


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
