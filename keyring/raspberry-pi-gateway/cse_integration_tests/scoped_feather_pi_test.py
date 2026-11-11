import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from scoped_feather_pi import INTEGRATION_TEAM_REVISION, ScopedApiError, gateway_environment, verify_integration_api


class ScopedPiProfileTests(unittest.TestCase):
    def setUp(self):
        self.context = object()
        self.capabilities = {"status": "READY", "scope": "scoped-command-api", "mode": "integration",
                             "teamRevision": INTEGRATION_TEAM_REVISION, "gatewayId": "gw-a",
                             "deviceId": "keyring-feather-lab", "features": ["dispatch-start", "receipts", "telemetry"]}

    def test_profile_probe_uses_one_authenticated_get(self):
        connection = Mock()
        connection.getresponse.return_value = Mock(status=200, read=Mock(return_value=json.dumps(self.capabilities).encode()))
        with patch("scoped_feather_pi.http.client.HTTPSConnection", return_value=connection) as https:
            verify_integration_api(8788, INTEGRATION_TEAM_REVISION, self.context)
        https.assert_called_once_with("127.0.0.1", 8788, timeout=5, context=self.context)
        connection.request.assert_called_once_with("GET", "/api/v1/gateways/gw-a/bench-capabilities",
                                                   headers={"Accept": "application/json", "Cache-Control": "no-store"})
        connection.close.assert_called_once()

    def test_profile_probe_rejects_wrong_revision_or_missing_capability(self):
        for payload in (dict(self.capabilities, teamRevision="a" * 40), dict(self.capabilities, features=["receipts"])):
            with self.subTest(payload=payload):
                connection = Mock()
                connection.getresponse.return_value = Mock(status=200, read=Mock(return_value=json.dumps(payload).encode()))
                with patch("scoped_feather_pi.http.client.HTTPSConnection", return_value=connection):
                    with self.assertRaisesRegex(ScopedApiError, "revision or capabilities"):
                        verify_integration_api(8788, INTEGRATION_TEAM_REVISION, self.context)
                connection.close.assert_called_once()

    def test_profile_probe_refuses_redirect_to_a_different_endpoint(self):
        connection = Mock()
        connection.getresponse.return_value = Mock(status=302)
        with patch("scoped_feather_pi.http.client.HTTPSConnection", return_value=connection):
            with self.assertRaisesRegex(ScopedApiError, "did not return"):
                verify_integration_api(8788, INTEGRATION_TEAM_REVISION, self.context)
        connection.request.assert_called_once()
        connection.close.assert_called_once()

    def test_only_integration_start_checks_forwarded_api(self):
        root = Path.cwd()
        profile = {"version": 1, "address": "00:00:00:00:00:01", "csePort": 8760, "apiPort": 8788,
                   "tlsDirectory": str(root), "apiMode": "integration"}
        with patch("scoped_feather_pi.load_tls", return_value=(root / "ca.pem", root / "cert.pem",
                                                              root / "key.pem", self.context)):
            with patch("scoped_feather_pi.verify_integration_api") as verify:
                gateway_environment(profile, root)
                gateway_environment(dict(profile, apiMode="legacy"), root, verify_api=True)
                verify.assert_not_called()
                gateway_environment(profile, root, verify_api=True)
                verify.assert_called_once_with(8788, INTEGRATION_TEAM_REVISION, self.context)
