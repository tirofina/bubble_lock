import unittest

from scoped_feather_evidence import ROUTE, inspect_command, physical_observations


class ScopedFeatherEvidenceTests(unittest.TestCase):
    def setUp(self):
        identity = {"gatewayId": "gw-a", "deviceId": "keyring-feather-lab", "commandId": "led-on"}
        binding = {**identity, "claimId": "claim-a", "ownershipEpoch": 1, "grantRevision": 2}
        command = {**binding, "version": 1, "desiredState": {"state": True},
                   "issuedAt": "2026-11-10T09:00:00.000Z", "deadline": "2026-11-10T09:00:25.000Z"}
        self.pi = {"commandId": "led-on", "payloadHash": "a" * 64, "receiptHash": "b" * 64, "state": True}
        name = f"gw-{'c' * 64}"
        self.step = {"command": command, "cseReceiptName": name, "cseResource": {"ri": "cin-a", "ct": "20261110T090004"}}
        self.team = {"gatewayCommands": {"led-on": {"command": command, "payloadHash": self.pi["payloadHash"]}},
                     "receipts": [{**binding, "contractId": "privacy-bubble.integration.v1", "docRevision": "2.0.0",
                                   "owner": "PC-MOBIUS-INTEGRATION", "type": "GATEWAY_COMMAND_AUTHORIZED",
                                   "allowed": True, "payloadHash": self.pi["payloadHash"], "eventId": "evt-a",
                                   "timestamp": "2026-11-10T09:00:02.000Z", "expiresAt": command["deadline"]}]}
        self.inspection = {**identity, "cseKey": "scoped-mobius4", "nativeRef": f"{ROUTE}/{name}",
                           "inbox": {"state": "SETTLED", "lastResult": "SETTLED"},
                           "deliveries": [{"source": "RECOVERY_SWEEP", "queuedNew": True,
                                           "firstSeenAt": "2026-11-10T09:00:05.000Z"}],
                           "settlement": {**identity, "version": 1, "payloadHash": self.pi["payloadHash"],
                                          "receiptSha256": self.pi["receiptHash"], "readbackState": True,
                                          "nativeCseKey": "scoped-mobius4", "nativeRef": f"{ROUTE}/{name}",
                                          "nativeResourceId": "cin-a", "nativeStoredAt": "2026-11-10T09:00:04.000Z",
                                          "authorizationEventId": "evt-a", "recordedAt": "2026-11-10T09:00:06.000Z"}}

    def test_same_receipt_can_settle_through_recovery_without_callback_evidence(self):
        result = inspect_command(self.step, self.pi, self.inspection, self.team)
        self.assertTrue(result["settlementVerified"])
        self.assertEqual(result["deliverySources"], ["RECOVERY_SWEEP"])
        self.inspection["settlement"]["nativeCseKey"] = "replacement-cse"
        with self.assertRaisesRegex(ValueError, "inspected CSE route"):
            inspect_command(self.step, self.pi, self.inspection, self.team)
        self.inspection["settlement"]["nativeCseKey"] = self.inspection["cseKey"]
        self.inspection["settlement"]["nativeResourceId"] = "different-cin"
        with self.assertRaisesRegex(ValueError, "native receipt identity"):
            inspect_command(self.step, self.pi, self.inspection, self.team)

    def test_wrong_authorization_is_rejected_and_physical_evidence_is_separate(self):
        self.team["receipts"][0]["allowed"] = False
        with self.assertRaisesRegex(ValueError, "authorization event"):
            inspect_command(self.step, self.pi, self.inspection, self.team)
        self.assertIsNone(physical_observations([self.step], None))
        observed = {"commandId": "led-on", "ledOn": False, "observedAt": "2026-11-10T09:00:03.000Z"}
        self.assertFalse(physical_observations([self.step], [observed])[0]["matched"])


if __name__ == "__main__":
    unittest.main()
