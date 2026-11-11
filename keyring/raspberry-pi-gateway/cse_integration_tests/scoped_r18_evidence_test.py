from contextlib import closing
from pathlib import Path
import tempfile
import unittest

from bubble_gateway.model import payload_hash
from bubble_gateway.store import Store
from helpers import BINDING
from pi_led_cycle import content_name, receipt_name, write_new_json
from scoped_r18_evidence import inspect_pulse
from scoped_r18_pulse import GATEWAY, PATHS, R18_COMMAND_FIRMWARE, R18_DEVICE


class R18EvidenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name)
        self.command_id, self.boot_id = "r18-pulse-test", "r18-boot"
        self.start = "2026-11-11T09:00:00.000Z"
        self.deadline = "2026-11-11T09:00:25.000Z"
        self.intent = {"deviceId": R18_DEVICE, "commandId": self.command_id, "grantId": "grant-a",
                       "desiredState": {"state": True}, "deadline": self.deadline}
        self.command = {key: value for key, value in self.intent.items() if key != "grantId"}
        self.command.update(version=1, gatewayId=GATEWAY, claimId="claim-a", grantRevision=1, ownershipEpoch=1,
                            issuedAt=self.start)
        self.command_hash = payload_hash(self.command)
        baseline_rqi = Store.request_id("observation", f"{R18_DEVICE}:{self.boot_id}:1")
        baseline = {"bootId": self.boot_id, "sequence": 1, "state": False, "receivedAt": self.start,
                    "cseResource": {"ty": 4, "rn": content_name(baseline_rqi), "ri": "cin-base", "pi": "cnt-obs"}}
        write_new_json(self.output / "pulse-intent.json", {"gatewayId": GATEWAY, "request": self.intent,
                       "cseReceiptName": receipt_name(self.command_id), "baseline": baseline})
        self.record = {"command": self.command, "payloadHash": self.command_hash, "grantId": "grant-a",
                       "intentHash": payload_hash({**self.intent, "gatewayId": GATEWAY}), "desiredGeneration": 1,
                       "reservedAt": self.start, "reservationExpiresAt": "2026-11-11T09:00:05.000Z",
                       "executionState": "RESERVED"}
        self.envelope = {"contractId": "privacy-bubble.integration.v1", "docRevision": "2.0.0",
                         "gatewayId": GATEWAY, "commandId": self.command_id, "payloadHash": self.command_hash,
                         "desiredGeneration": 1, "claimId": "claim-a"}
        issue = dict(self.envelope, type="GATEWAY_COMMAND_ISSUED", eventId="evt-issued", timestamp=self.start,
                     owner="PC-MOBIUS-INTEGRATION", deviceId=R18_DEVICE, grantId="grant-a", executionState="RESERVED",
                     reservedAt=self.start, reservationExpiresAt=self.record["reservationExpiresAt"])
        self.team = {"gatewayCommands": {self.command_id: self.record}, "receipts": [issue], "gatewayDeviceReceipts": {}}

    def test_recovers_the_original_issuance_without_its_http_response(self):
        database = self.output / "gateway.sqlite3"
        binding = dict(BINDING, bindingVersion=3, gatewayId=GATEWAY, originator="Sscoped-r18-gateway-b",
                       cseId="Mobius4", cseDeploymentId="scoped-mobius4", receiptContainer=PATHS["receipt"],
                       pcApiDeploymentId="scoped-command-api-r18")
        with closing(Store(database, 100, 100000, 20, binding)) as store:
            store.accept(self.command, self.command_hash)
            store.accept(dict(self.command, commandId="other-command"), "a" * 64)
        report = inspect_pulse(self.output, self.team, database)
        self.assertTrue(report["issuanceInTeamSnapshot"])
        self.assertFalse(report["issuedResponseCaptured"])
        self.assertEqual(report["issuanceEventId"], "evt-issued")
        self.assertEqual(report["piCommandState"], "RECEIVED")
        self.assertIsNone(report["physicalPulseMeasured"])

    def test_snapshot_absence_and_tampered_intent_are_distinct(self):
        report = inspect_pulse(self.output, {"gatewayCommands": {}, "receipts": []})
        self.assertFalse(report["issuanceInTeamSnapshot"])
        self.assertFalse(report["centralApplicationVerified"])
        self.record["intentHash"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "does not match the bench intent"):
            inspect_pulse(self.output, self.team)

    def test_matches_central_application_but_rejects_conflicting_native_receipt(self):
        receipt = {key: self.command[key] for key in ("gatewayId", "deviceId", "commandId", "grantRevision", "ownershipEpoch")}
        receipt.update(version=1, payloadHash=self.command_hash, status="APPLIED", ackCode="APPLIED",
                       readback={"state": True}, bootId=self.boot_id, firmwareRevision=R18_COMMAND_FIRMWARE,
                       receivedAt="2026-11-11T09:00:04.000Z")
        digest = payload_hash(receipt)
        self.record.update(executionState="APPLIED_VERIFIED", lastReceiptHash=digest, readback={"state": True},
                           claimCommittedAt="2026-11-11T09:00:01.000Z", dispatchStartedAt="2026-11-11T09:00:02.000Z",
                           claimExpiresAt="2026-11-11T09:00:15.000Z", settledAt="2026-11-11T09:00:05.000Z")
        started = self.record["dispatchStartedAt"]
        settled = self.record["settledAt"]
        self.team["receipts"] += [
            dict(self.envelope, type="GATEWAY_DISPATCH_STARTED", eventId="evt-dispatch", timestamp=started,
                 deviceId=R18_DEVICE, grantRevision=1, ownershipEpoch=1, executionState="IN_FLIGHT",
                 dispatchStartedAt=started, claimCommittedAt=self.record["claimCommittedAt"]),
            dict(self.envelope, type="GATEWAY_RECEIPT_SETTLED", eventId="evt-settlement", timestamp=settled,
                 ueId=R18_DEVICE, epoch=1, executionState="APPLIED_VERIFIED", receiptHash=digest),
        ]
        self.team["gatewayDeviceReceipts"][self.command_id] = {"receipt": receipt, "receiptHash": digest, "receivedAt": settled}
        report = inspect_pulse(self.output, self.team)
        self.assertTrue(report["centralApplicationVerified"])
        self.assertFalse(report["cseReceiptCaptured"])
        self.assertEqual(report["settlementEventId"], "evt-settlement")
        write_new_json(self.output / "pulse-receipt.json", {
            "cseResource": {"ri": "cin-r18", "pi": "cnt-r18", "ct": "20261111T090005"},
            "cseReceipt": dict(receipt, receivedAt="2026-11-11T09:00:04.100Z"),
        })
        with self.assertRaisesRegex(ValueError, "receipt bodies differ"):
            inspect_pulse(self.output, self.team)
