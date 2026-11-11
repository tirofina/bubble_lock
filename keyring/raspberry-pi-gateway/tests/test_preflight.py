"""Offline entry point checks using fresh TLS files and isolated paths."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import closing
from unittest.mock import AsyncMock, patch

import httpx

from bubble_gateway.__main__ import main
from bubble_gateway.config import GatewayConfig
from bubble_gateway.state_identity import configured_binding
from bubble_gateway.store import Store
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

    def check_route(self, *, credential_status="ACTIVE", commands=None, observed_parent="cnt-pinned",
                    observed_observation_parent="cnt-observation", expected_error=None):
        self.env.update(M2M_CSE_DEPLOYMENT_ID="scoped-mobius4", M2M_RECEIPT_CONTAINER_RI="cnt-pinned",
                        MQTT_ENABLED="true", MQTT_HOST="broker.invalid")
        endpoints = []

        def exchange(method, url, *, headers, body=None):
            self.assertEqual(method, "GET")
            self.assertIsNone(body)
            endpoints.append(url)
            if url.endswith("/test/receipts"):
                return 200, httpx.Headers({"X-M2M-RI": headers["X-M2M-RI"], "X-M2M-RSC": "2000"}), {
                    "m2m:cnt": {"ty": 3, "ri": observed_parent},
                }
            if url.endswith("/test/obs"):
                return 200, httpx.Headers({"X-M2M-RI": headers["X-M2M-RI"], "X-M2M-RSC": "2000"}), {
                    "m2m:cnt": {"ty": 3, "ri": observed_observation_parent},
                }
            if url.endswith("/credentials/status"):
                return 200, httpx.Headers(), {
                    "gatewayId": "gw-test", "credentialRevision": "rev-1", "status": credential_status,
                }
            self.assertTrue(url.endswith("/commands?limit=16"))
            return 200, httpx.Headers(), {"commands": commands or []}

        with (patch.dict(os.environ, self.env, clear=True),
              patch.object(sys, "argv", ["bubble-gateway", "--check-command-route"]),
              patch("bubble_gateway.__main__.logging.basicConfig"),
              patch("bubble_gateway.__main__.serve", new_callable=AsyncMock) as daemon,
              patch("bubble_gateway.transport.mqtt.Client") as mqtt_client,
              patch("bubble_gateway.transport.TransportHub._http_json", new_callable=AsyncMock) as http,
              patch("builtins.print") as output):
            http.side_effect = exchange
            if expected_error:
                with self.assertLogs("bubble_gateway.__main__", level="ERROR") as logs, self.assertRaises(SystemExit):
                    main()
                self.assertIn(expected_error, logs.output[-1])
                output.assert_not_called()
            else:
                main()
                report = json.loads(output.call_args.args[0])
                self.assertEqual((report["receiptContainerRi"], report["credentialStatus"]), ("cnt-pinned", "ACTIVE"))
                if self.env.get("COMMANDS_ENABLED") == "false":
                    self.assertIs(report["commandsEnabled"], False)
                    self.assertNotIn("activeCommands", report)
                else:
                    self.assertEqual(report["activeCommands"], 0)
                if "M2M_OBSERVATION_CONTAINER_RI" in self.env:
                    self.assertEqual(report["observationContainerRi"], self.env["M2M_OBSERVATION_CONTAINER_RI"])
            daemon.assert_not_awaited()
            mqtt_client.assert_not_called()
        self.assertEqual(list(self.state.iterdir()), [])
        return endpoints

    def test_command_route_reads_only_cse_and_central_endpoints(self):
        self.assertEqual(self.check_route(), [
            "https://example.invalid/test/receipts",
            "https://example.invalid/api/v1/gateways/gw-test/credentials/status",
            "https://example.invalid/api/v1/gateways/gw-test/commands?limit=16",
        ])

    def test_command_route_stops_before_poll_on_wrong_parent_or_inactive_credential(self):
        self.assertEqual(len(self.check_route(observed_parent="cnt-other", expected_error="ReceiptParentMismatch")), 1)
        self.assertEqual(len(self.check_route(credential_status="REVOKED", expected_error="credential is not ACTIVE")), 2)

    def test_command_route_checks_pinned_observation_before_central_api(self):
        self.env["M2M_OBSERVATION_CONTAINER_RI"] = "cnt-observation"
        self.assertEqual(self.check_route()[:2], ["https://example.invalid/test/receipts", "https://example.invalid/test/obs"])
        self.assertEqual(len(self.check_route(observed_observation_parent="cnt-replaced",
                                              expected_error="CSE observation parent lookup failed")), 2)

    def test_command_route_reports_existing_active_commands(self):
        self.assertEqual(len(self.check_route(commands=[{"commandId": "existing"}],
                                              expected_error="command list is not empty")), 3)

    def test_observation_only_preflight_never_reads_commands(self):
        self.env.update(COMMANDS_ENABLED="false", M2M_OBSERVATION_CONTAINER_RI="cnt-observation")
        self.assertEqual(self.check_route(commands=[{"commandId": "existing"}]), [
            "https://example.invalid/test/receipts",
            "https://example.invalid/test/obs",
            "https://example.invalid/api/v1/gateways/gw-test/credentials/status",
        ])

    def test_preflight_rejects_a_changed_pc_deployment_before_remote_requests(self):
        self.env["PC_API_DEPLOYMENT_ID"] = "original-central"
        with patch.dict(os.environ, self.env, clear=True):
            config = GatewayConfig.from_env()
        with closing(Store(config.database, 100, 100000, 20, configured_binding(config))):
            pass

        self.env["PC_API_DEPLOYMENT_ID"] = "new-central"
        for flag in ("--check-config", "--check-command-route"):
            with (self.subTest(flag=flag), patch.dict(os.environ, self.env, clear=True),
                  patch.object(sys, "argv", ["bubble-gateway", flag]),
                  patch("bubble_gateway.__main__.logging.basicConfig"),
                  patch("bubble_gateway.__main__.check_command_route", new_callable=AsyncMock) as route,
                  self.assertLogs("bubble_gateway.__main__", level="ERROR") as logs,
                  self.assertRaises(SystemExit) as raised):
                main()
            self.assertEqual(raised.exception.code, 1)
            self.assertIn("STATE_PC_API_DEPLOYMENT_MISMATCH", logs.output[-1])
            route.assert_not_awaited()

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
