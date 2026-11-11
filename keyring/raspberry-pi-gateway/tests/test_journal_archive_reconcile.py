import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from bubble_gateway.journal_reconcile import reconcile
from bubble_gateway.model import iso_time, payload_hash
from bubble_gateway.state_archive import archive
from bubble_gateway.state_identity import configured_binding
from bubble_gateway.store import Store
from helpers import command, config


class JournalArchiveReconcileTests(unittest.IsolatedAsyncioTestCase):
    async def test_archive_only_reports_unseen_gateway_commands_and_independent_receipts(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        current = config(root / "source.sqlite3")
        current.commands_enabled = True
        gateway_archive = root / "gateway"
        known = command(commandId="known")
        record = {"commandId": "known", "payloadHash": payload_hash(known), "bootId": "boot-known",
                  "grantRevision": known["grantRevision"], "ownershipEpoch": known["ownershipEpoch"],
                  "phase": "completed", "ackCode": "APPLIED", "desiredState": True, "readback": True}

        with closing(Store(current.database, 100, 100000, 20, configured_binding(current))) as store:
            for cmd in (known, command(commandId="central"), command(commandId="settled")):
                digest = payload_hash(cmd)
                store.accept(cmd, digest)
                receipt = {key: cmd[key] for key in ("gatewayId", "deviceId", "commandId", "grantRevision", "ownershipEpoch")}
                receipt.update(version=1, payloadHash=digest, status="APPLIED", ackCode="APPLIED",
                               bootId="boot-known", firmwareRevision="keyring-0.7.14", readback={"state": True},
                               receivedAt=iso_time())
                store.finish(cmd["commandId"], receipt)
            store.stage_receipts(current.receipt_container)
            store.stage_central_receipts()
            for command_id in ("known", "central", "settled"):
                store.delivered(Store.request_id("receipt", command_id))
            for command_id in ("known", "settled"):
                store.delivered(Store.request_id("central-receipt", command_id))

            for cmd in (command(commandId="waiting"), command(commandId="dispatch"),
                        command(commandId="unrelated", deviceId="other-device")):
                store.accept(cmd, payload_hash(cmd))
                if cmd["commandId"] == "dispatch":
                    store.begin_dispatch(cmd)
            with patch("bubble_gateway.state_archive._sync_directory"):
                archive(current, gateway_archive, adopt=False, timeout=5)

        device_archive = {"identity": {"deviceId": "kr-test"}, "deviceSnapshot": {"snapshotId": "snapshot"},
                          "files": [{"sha256": "test-digest"}]}
        with (patch("bubble_gateway.journal_reconcile.read_archive", return_value=(device_archive, [record])),
              patch("bubble_gateway.journal_reconcile.TransportHub", side_effect=AssertionError("unexpected network"))):
            report = await reconcile(current, root / "device", gateway_archive, archive_only=True)
        self.assertEqual(report["nativeReceiptSource"], "not-checked")
        self.assertEqual(report["results"][0]["result"], "native_receipt_not_checked")
        self.assertEqual(report["results"][0]["deviceComparison"], "matched_applied")
        pending = report["gatewayOnlyPending"]
        self.assertEqual(pending["count"], 3)
        self.assertEqual([(row["commandId"], row["gatewayStatus"], row["centralReceiptPending"])
                          for row in pending["commands"]],
                         [("central", "APPLIED", True), ("dispatch", "DISPATCHING", False), ("waiting", "RECEIVED", False)])
        self.assertEqual(report["reviewCount"], 4)
