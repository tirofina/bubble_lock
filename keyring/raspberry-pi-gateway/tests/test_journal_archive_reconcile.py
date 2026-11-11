import json
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from bubble_gateway.config import GatewayConfig
from bubble_gateway.journal_reconcile import reconcile
from bubble_gateway.model import iso_time, payload_hash
from bubble_gateway.state_archive import archive
from bubble_gateway.state_identity import StateIdentityError, configured_binding
from bubble_gateway.store import Store
from bubble_gateway.transport import ReceiptParentMismatch, RemoteResponseError
from helpers import BINDING, DEVICES, command, config


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
                        command(commandId="dispatch-possible"), command(commandId="dispatch-legacy"),
                        command(commandId="unrelated", deviceId="other-device")):
                digest = payload_hash(cmd)
                command_id = cmd["commandId"]
                store.accept(cmd, digest)
                if command_id.startswith("dispatch"):
                    store.begin_dispatch(cmd)
                if command_id == "dispatch-possible":
                    self.assertTrue(store.mark_ble_final_write(command_id, digest))
                if command_id == "dispatch-legacy":
                    with store.db:
                        store.db.execute("UPDATE commands SET ble_final_write_started=NULL WHERE command_id=?", (command_id,))
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
        self.assertEqual(pending["count"], 5)
        self.assertEqual([(row["commandId"], row["gatewayStatus"], row["centralReceiptPending"])
                          for row in pending["commands"]],
                         [("central", "APPLIED", True), ("dispatch", "DISPATCHING", False),
                          ("dispatch-legacy", "DISPATCHING", False), ("dispatch-possible", "DISPATCHING", False),
                          ("waiting", "RECEIVED", False)])
        phases = {row["commandId"]: row["bleFinalWriteMayHaveStarted"] for row in pending["commands"]
                  if row["gatewayStatus"] == "DISPATCHING"}
        self.assertEqual(phases, {"dispatch": False, "dispatch-legacy": None, "dispatch-possible": True})
        self.assertEqual(report["reviewCount"], 6)

    async def test_gateway_only_live_receipt_lookup_uses_original_pinned_container(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        values = {
            "GATEWAY_ID": "gw-test", "M2M_ORIGINATOR": "Ctest", "M2M_CSE_ID": "test-cse", "M2M_RVI": "3",
            "M2M_CSE_DEPLOYMENT_ID": "old-cse", "M2M_RECEIPT_CONTAINER_RI": "cnt-old",
            "M2M_CSE_URL": "https://mobius.invalid", "PC_API_URL": "https://central.invalid",
            "M2M_OBSERVATION_CONTAINER": BINDING["observationContainer"], "MQTT_ENABLED": "false",
            "M2M_RECEIPT_CONTAINER": BINDING["receiptContainer"], "M2M_HEALTH_CONTAINER": BINDING["healthContainer"],
            "BLE_DEVICES": json.dumps(DEVICES), "GATEWAY_DATABASE": str(root / "source.db"),
        }
        values.update(dict.fromkeys(("TLS_CA_FILE", "TLS_CERT_FILE", "TLS_KEY_FILE"), str(root / "tls-unused")))
        current = GatewayConfig.from_env(values, require_tls_files=False)
        gateway_archive = root / "gateway"
        cse_rows = {}
        with closing(Store(current.database, 100, 100000, 20, configured_binding(current))) as store:
            for name in ("body-mismatch", "local-only", "matched", "remote-missing"):
                cmd = command(commandId=name)
                digest = payload_hash(cmd)
                store.accept(cmd, digest)
                if name == "local-only":
                    continue
                receipt = {key: cmd[key] for key in ("gatewayId", "deviceId", "commandId", "grantRevision", "ownershipEpoch")}
                receipt.update(version=1, payloadHash=digest, status="APPLIED", ackCode="APPLIED", receivedAt=iso_time())
                store.finish(name, receipt)
                cse_rows[store.request_id("receipt", name)] = dict(
                    ty=4, ri="cin-old", ct="20261111T023456",
                    con=dict(receipt, ackCode="DUPLICATE") if name == "body-mismatch" else receipt,
                )
            with patch("bubble_gateway.state_archive._sync_directory"):
                archive(current, gateway_archive, adopt=False, timeout=5)

        async def read_instance(request_id, container):
            self.assertEqual(container, current.receipt_container)
            hub.verify_receipt_route.assert_awaited_once()
            if request_id == Store.request_id("receipt", "remote-missing"):
                raise RemoteResponseError("missing", 4004, 404)
            return cse_rows[request_id]

        hub = Mock(start=AsyncMock(), close=AsyncMock(), verify_receipt_route=AsyncMock(),
                   read_content_instance=AsyncMock(side_effect=read_instance))
        journal = {"identity": {"deviceId": "kr-test"}, "deviceSnapshot": {"snapshotId": "snapshot"},
                   "files": [{"sha256": "test-digest"}]}
        with (patch("bubble_gateway.journal_reconcile.read_archive", return_value=(journal, [])),
              patch("bubble_gateway.journal_reconcile.TransportHub", return_value=hub)):
            result = await reconcile(current, root / "device", gateway_archive, check_gateway_only_native=True)
            self.assertEqual(hub.read_content_instance.await_count, 3)
            hub.read_content_instance.reset_mock()
            hub.verify_receipt_route.side_effect = ReceiptParentMismatch("wrong container")
            with self.assertRaises(ReceiptParentMismatch):
                await reconcile(current, root / "device", gateway_archive, check_gateway_only_native=True)
            hub.read_content_instance.assert_not_awaited()

        pending = {row["commandId"]: row for row in result["gatewayOnlyPending"]["commands"]}
        self.assertEqual({key: row["nativeReceipt"]["result"] for key, row in pending.items()}, {
            "body-mismatch": "cse_receipt_mismatch", "local-only": "missing_gateway_receipt",
            "matched": "cse_receipt_matched", "remote-missing": "missing_cse_receipt",
        })
        self.assertTrue(pending["matched"]["nativeReceiptPending"])
        self.assertEqual(result["reviewCount"], 4)
        del values["M2M_RECEIPT_CONTAINER_RI"]
        unpinned = GatewayConfig.from_env(values, require_tls_files=False)
        with self.assertRaisesRegex(StateIdentityError, "RECONCILE_RECEIPT_CONTAINER_PIN_REQUIRED"):
            await reconcile(unpinned, root / "device", gateway_archive, check_gateway_only_native=True)

    async def test_archive_only_compares_central_acceptance_for_gateway_only_receipts(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        current = config(root / "source.sqlite3")
        current.commands_enabled = True
        gateway_archive = root / "gateway"
        team = {"gatewayCommands": {}, "gatewayDeviceReceipts": {}, "receipts": []}
        cases = (
            ("cancelled", "REJECTED", "DISPATCH_NOT_SENT", "SETTLED_CANCELLED"),
            ("uncertain", "INDETERMINATE", "RESTART_INTERRUPTED", "DISPATCH_UNCERTAIN"),
            ("applied", "APPLIED", "APPLIED", "APPLIED_VERIFIED"),
            ("wrong-claim", "REJECTED", "DISPATCH_NOT_SENT", "SETTLED_CANCELLED"),
            ("missing-command", "REJECTED", "DISPATCH_NOT_SENT", None),
            ("missing-receipt", "REJECTED", "DISPATCH_NOT_SENT", None),
            ("waiting", None, None, None),
        )
        with closing(Store(current.database, 100, 100000, 20, configured_binding(current))) as store:
            for name, status, code, execution_state in cases:
                cmd = command(commandId=name)
                digest = payload_hash(cmd)
                store.accept(cmd, digest)
                if status is None:
                    continue
                receipt = {key: cmd[key] for key in ("gatewayId", "deviceId", "commandId", "grantRevision", "ownershipEpoch")}
                readback = cmd["desiredState"] if status == "APPLIED" else None
                receipt.update(version=1, payloadHash=digest, status=status, ackCode=code, readback=readback,
                               receivedAt=iso_time(), acceptedAt=None, appliedAt=None)
                store.finish(name, receipt)
                if name == "missing-command":
                    continue
                record = {"command": cmd, "payloadHash": digest, "desiredGeneration": 1}
                team["gatewayCommands"][name] = record
                if execution_state is None:
                    continue
                receipt_digest = payload_hash(receipt)
                record.update(lastReceiptHash=receipt_digest, executionState=execution_state,
                              readback=readback, settlementReason="EXPIRED" if name == "uncertain" else code)
                team["gatewayDeviceReceipts"][name] = {"receiptHash": receipt_digest, "receipt": receipt, "receivedAt": iso_time()}
                team["receipts"].append({
                    "type": "GATEWAY_RECEIPT_SETTLED", "eventId": f"evt-{name}", "contractId": "privacy-bubble.integration.v1",
                    "docRevision": "2.0.0", "gatewayId": cmd["gatewayId"], "commandId": name, "ueId": cmd["deviceId"],
                    "claimId": "different-claim" if name == "wrong-claim" else cmd["claimId"],
                    "epoch": cmd["ownershipEpoch"], "desiredGeneration": 1, "payloadHash": digest,
                    "receiptHash": receipt_digest, "executionState": execution_state, "deviceAppliedAt": None,
                    "timestamp": iso_time(),
                })
            with patch("bubble_gateway.state_archive._sync_directory"):
                archive(current, gateway_archive, adopt=False, timeout=5)

        journal = {"identity": {"deviceId": "kr-test"}, "deviceSnapshot": {"snapshotId": "snapshot"},
                   "files": [{"sha256": "test-digest"}]}
        with (patch("bubble_gateway.journal_reconcile.read_archive", return_value=(journal, [])),
              patch("bubble_gateway.journal_reconcile.TransportHub", side_effect=AssertionError("unexpected network"))):
            report = await reconcile(current, root / "device", gateway_archive, archive_only=True, team_state=team)

        pending = report["gatewayOnlyPending"]
        self.assertEqual(pending["centralReceiptSource"], "captured")
        evidence = {row["commandId"]: row["centralReceipt"] for row in pending["commands"]}
        for name, _, _, state in cases[:3]:
            self.assertEqual(evidence[name]["result"], "central_receipt_matched")
            self.assertEqual(evidence[name]["executionState"], state)
            self.assertEqual(evidence[name]["settlementEventId"], f"evt-{name}")
        self.assertEqual(evidence["wrong-claim"]["result"], "central_receipt_mismatch")
        self.assertEqual(evidence["missing-command"]["result"], "missing_central_command")
        self.assertEqual(evidence["missing-receipt"]["result"], "missing_central_receipt")
        self.assertEqual(evidence["waiting"]["result"], "missing_gateway_receipt")
        self.assertEqual(report["reviewCount"], len(cases))
