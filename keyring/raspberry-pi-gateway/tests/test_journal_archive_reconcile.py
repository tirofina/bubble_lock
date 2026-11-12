import json
import tempfile
import unittest
from contextlib import closing
from copy import deepcopy
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from bubble_gateway.config import GatewayConfig
from bubble_gateway.integration_evidence import inspect_integration_command, inspect_integration_receipt
from bubble_gateway.journal_reconcile import reconcile
from bubble_gateway.model import iso_time, payload_hash
from bubble_gateway.state_archive import archive
from bubble_gateway.state_identity import StateIdentityError, configured_binding
from bubble_gateway.store import Store
from bubble_gateway.transport import ReceiptParentMismatch, RemoteResponseError
from helpers import BINDING, DEVICES, command, config


class JournalArchiveReconcileTests(unittest.IsolatedAsyncioTestCase):
    def test_central_receipt_history_separates_initial_uncertainty_from_later_readback(self):
        def at(second):
            return f"2026-11-12T00:00:{second:02d}.000Z"

        cmd = command(issuedAt=at(0), deadline=at(10))
        digest = payload_hash(cmd)
        binding = {key: cmd[key] for key in ("commandId", "gatewayId", "deviceId", "grantRevision", "ownershipEpoch")}
        uncertain = dict(binding, version=1, payloadHash=digest, status="INDETERMINATE",
                         ackCode="RESTART_INTERRUPTED", receivedAt=at(3), acceptedAt=None, appliedAt=None, readback=None)
        applied = dict(uncertain, status="APPLIED", ackCode="APPLIED", receivedAt=at(5),
                       readback=cmd["desiredState"], bootId="boot-test", firmwareRevision="keyring-0.7.25")
        initial_hash, applied_hash = map(payload_hash, (uncertain, applied))
        envelope = {"contractId": "privacy-bubble.integration.v1", "docRevision": "2.0.0"}
        initial = dict(envelope, type="GATEWAY_RECEIPT_SETTLED", eventId="evt-initial", timestamp=at(4),
                       gatewayId=cmd["gatewayId"], commandId=cmd["commandId"], ueId=cmd["deviceId"],
                       claimId=cmd["claimId"], epoch=cmd["ownershipEpoch"], desiredGeneration=1,
                       payloadHash=digest, receiptHash=initial_hash, executionState="DISPATCH_UNCERTAIN",
                       deviceAppliedAt=None)
        final = dict(initial, eventId="evt-final", timestamp=at(6), receiptHash=applied_hash,
                     executionState="APPLIED_VERIFIED")
        start = dict(envelope, **binding, type="GATEWAY_DISPATCH_STARTED", eventId="evt-start", timestamp=at(2),
                     claimId=cmd["claimId"], payloadHash=digest, desiredGeneration=1, executionState="IN_FLIGHT",
                     dispatchStartedAt=at(2), claimCommittedAt=at(1))
        record = {"command": cmd, "payloadHash": digest, "lastReceiptHash": applied_hash, "desiredGeneration": 1,
                  "executionState": "APPLIED_VERIFIED", "readback": cmd["desiredState"], "claimCommittedAt": at(1),
                  "dispatchStartedAt": at(2), "claimExpiresAt": at(8), "settledAt": at(6)}
        state = {"gatewayCommands": {cmd["commandId"]: record},
                 "gatewayDeviceReceipts": {cmd["commandId"]: {"receipt": applied, "receiptHash": applied_hash,
                                                             "receivedAt": at(6)}},
                 "receipts": [start, initial, final]}
        history = inspect_integration_receipt(cmd, uncertain, state)
        self.assertEqual(history, {"result": "central_receipt_matched", "executionState": "DISPATCH_UNCERTAIN",
                                   "receiptHash": initial_hash, "settlementEventId": "evt-initial",
                                   "currentExecutionState": "APPLIED_VERIFIED", "currentSettlementEventId": "evt-final",
                                   "currentReceiptHash": applied_hash})
        self.assertEqual(inspect_integration_receipt(cmd, applied, state)["settlementEventId"], "evt-final")
        self.assertEqual(inspect_integration_command(cmd, applied, state),
                         {"dispatchEventId": "evt-start", "settlementEventId": "evt-final"})

        for invalid in (dict(initial, claimId="wrong-claim"), dict(initial, timestamp=at(7))):
            modified = {**state, "receipts": [start, invalid, final]}
            with self.assertRaises(ValueError):
                inspect_integration_receipt(cmd, uncertain, modified)
        modified = {**state, "receipts": [start, initial, initial, final]}
        with self.assertRaises(ValueError):
            inspect_integration_receipt(cmd, uncertain, modified)

        handover = deepcopy(state)
        handover["gatewayCommands"][cmd["commandId"]]["lastReceiptHash"] = initial_hash
        handover["gatewayDeviceReceipts"][cmd["commandId"]] = {
            "receipt": uncertain, "receiptHash": initial_hash, "receivedAt": at(4),
        }
        handover["receipts"][-1] = dict(envelope, type="DISPATCH_READBACK_SETTLED", eventId="evt-handover",
                                        timestamp=at(6), commandId=cmd["commandId"], ueId=cmd["deviceId"],
                                        claimId=cmd["claimId"], epoch=cmd["ownershipEpoch"], readback=cmd["desiredState"])
        self.assertEqual(inspect_integration_receipt(cmd, uncertain, handover)["currentSettlementEventId"], "evt-handover")
        handover["receipts"].pop()
        with self.assertRaises(ValueError):
            inspect_integration_receipt(cmd, uncertain, handover)

    async def test_completed_device_record_explains_uncertain_gateway_receipt_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = config(root / "source.sqlite3")
            current.commands_enabled = True
            gateway_archive = root / "gateway"
            team = {"gatewayCommands": {}, "gatewayDeviceReceipts": {}, "receipts": []}
            board, firmware = "r18-hand-solder", "keyring-0.7.22"
            journal = {"identity": {"deviceId": "kr-test", "boardRevision": board,
                                    "firmwareRevision": firmware, "bootId": "same-boot"},
                       "deviceSnapshot": {"snapshotId": "snapshot"}, "files": [{"sha256": "test-digest"}]}
            records = []
            with closing(Store(current.database, 100, 100000, 20, configured_binding(current))) as store:
                for name, final_attempted in (("uncertain", True), ("in-flight", True), ("before-final", False)):
                    cmd = command(commandId=name)
                    digest = payload_hash(cmd)
                    store.accept(cmd, digest)
                    store.begin_dispatch(cmd)
                    if final_attempted:
                        self.assertTrue(store.mark_ble_final_write(name, digest))
                    records.append({"commandId": name, "payloadHash": digest, "bootId": "same-boot",
                                    "grantRevision": cmd["grantRevision"], "ownershipEpoch": cmd["ownershipEpoch"],
                                    "phase": "completed", "ackCode": "APPLIED", "desiredState": True, "readback": True,
                                    "acceptedUptimeMs": 500, "appliedUptimeMs": 510})
                    if name != "uncertain":
                        continue
                    stamp = iso_time()
                    receipt = {key: cmd[key] for key in ("gatewayId", "deviceId", "commandId", "grantRevision", "ownershipEpoch")}
                    receipt.update(version=1, payloadHash=digest, status="INDETERMINATE", ackCode="RESTART_INTERRUPTED",
                                   acceptedAt=None, appliedAt=None, receivedAt=stamp, bootId=None, readback=None,
                                   firmwareRevision=None, timestampSource="unavailable")
                    store.finish(name, receipt)
                    receipt_hash = payload_hash(receipt)
                    team["gatewayCommands"][name] = {"command": cmd, "payloadHash": digest,
                                                       "lastReceiptHash": receipt_hash, "desiredGeneration": 1,
                                                       "executionState": "DISPATCH_UNCERTAIN"}
                    team["gatewayDeviceReceipts"][name] = {"receiptHash": receipt_hash, "receipt": receipt, "receivedAt": stamp}
                    team["receipts"].append({
                        "type": "GATEWAY_RECEIPT_SETTLED", "eventId": "evt-uncertain",
                        "contractId": "privacy-bubble.integration.v1", "docRevision": "2.0.0",
                        "gatewayId": cmd["gatewayId"], "commandId": name, "ueId": cmd["deviceId"],
                        "claimId": cmd["claimId"], "epoch": cmd["ownershipEpoch"], "desiredGeneration": 1,
                        "payloadHash": digest, "receiptHash": receipt_hash, "executionState": "DISPATCH_UNCERTAIN",
                        "deviceAppliedAt": None, "timestamp": stamp,
                    })
                with patch("bubble_gateway.state_archive._sync_directory"):
                    archive(current, gateway_archive, adopt=False, timeout=5)

            with (patch("bubble_gateway.journal_reconcile.read_archive", return_value=(journal, records)),
                  patch("bubble_gateway.journal_reconcile.TransportHub", side_effect=AssertionError("unexpected network"))):
                full = await reconcile(current, root / "device", gateway_archive, archive_only=True, team_state=team)
                selected = await reconcile(current, root / "device", gateway_archive, archive_only=True, team_state=team,
                                           same_boot_command="uncertain", board_revision=board, firmware_revision=firmware)
            by_id = {row["commandId"]: row for row in full["results"]}
            uncertainty = by_id["uncertain"]["recoveryEvidence"]
            self.assertEqual(uncertainty["classification"], "device_completed_gateway_uncertain")
            self.assertEqual(uncertainty["deviceRecordSha256"], payload_hash(records[0]))
            self.assertEqual(uncertainty["centralReceipt"]["executionState"], "DISPATCH_UNCERTAIN")
            self.assertEqual(selected["results"][0]["recoveryEvidence"], uncertainty)
            self.assertEqual(selected["settlementStatus"], "not-settled")
            self.assertEqual(by_id["in-flight"]["recoveryEvidence"]["classification"], "device_completed_gateway_receipt_missing")
            self.assertNotIn("recoveryEvidence", by_id["before-final"])

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
