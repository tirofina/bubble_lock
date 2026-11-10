"""Offline entry point checks using fresh TLS files and isolated paths."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from bubble_gateway.__main__ import main
from tls_fixture import TestPki


class PreflightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pki = TestPki()
        cls.addClassCleanup(cls.pki.close)

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="keyring-preflight-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        self.env = {
            "STATE_DIRECTORY": str(self.state), "GATEWAY_DATABASE": str(self.state / "gateway.sqlite3"),
            "GATEWAY_ID": "gw-test", "M2M_ORIGINATOR": "Ctest", "M2M_CSE_ID": "Mobius4",
            "PC_API_URL": "https://example.invalid", "M2M_CSE_URL": "https://example.invalid",
            "M2M_OBSERVATION_CONTAINER": "/test/obs", "M2M_RECEIPT_CONTAINER": "/test/receipts",
            "M2M_HEALTH_CONTAINER": "/test/health", "M2M_RVI": "4", "MQTT_ENABLED": "false",
            "BLE_DEVICES": json.dumps({"kr-test": "00:00:00:00:00:01"}),
            "TLS_CA_FILE": str(self.pki.path("trusted")), "TLS_CERT_FILE": str(self.pki.path("client")),
            "TLS_KEY_FILE": str(self.pki.path("client", "key")),
        }
        old_mask = os.umask(0o077)
        self.addCleanup(os.umask, old_mask)

    def invoke(self, *, expected_error=None):
        with (patch.dict(os.environ, self.env, clear=True),
              patch.object(sys, "argv", ["bubble-gateway", "--check-config"]),
              patch("bubble_gateway.__main__.logging.basicConfig")):
            with self.assertLogs("bubble_gateway.__main__", level="INFO") as log:
                if expected_error:
                    with self.assertRaises(SystemExit) as raised:
                        main()
                    self.assertEqual(raised.exception.code, 1)
                    self.assertIn(expected_error, log.output[-1])
                else:
                    main()
                    self.assertIn("Gateway configuration check passed", log.output[-1])
            self.assertNotIn(str(self.root), "\n".join(log.output))
        self.assertEqual(list(self.state.iterdir()), [])

    def test_valid_tls_and_state_config_never_open_database_or_start_gateway(self):
        self.invoke()

    def test_wrong_private_key_is_reported_before_database_creation(self):
        self.env["TLS_KEY_FILE"] = str(self.pki.path("rogue-client", "key"))
        self.invoke(expected_error="TLS file check failed (SSLError)")

    def test_database_and_lock_must_stay_under_systemd_state_directory(self):
        self.env["GATEWAY_DATABASE"] = str(self.state / ".." / "outside.sqlite3")
        self.invoke(expected_error="inside STATE_DIRECTORY")
        self.assertFalse((self.root / "outside.sqlite3").exists())
        self.assertFalse((self.root / "outside.lock").exists())

    def test_database_cannot_be_its_own_lifetime_lock(self):
        self.env["GATEWAY_DATABASE"] = str(self.state / "gateway.lock")
        self.invoke(expected_error="different files")
