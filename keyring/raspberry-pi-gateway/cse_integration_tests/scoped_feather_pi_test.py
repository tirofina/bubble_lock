from contextlib import nullcontext
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from scoped_feather_pi import (INTEGRATION_TEAM_REVISION, R18_BOARD, R18_BRINGUP_FIRMWARES, R18_COMMAND_FIRMWARE, R18_DEVICE,
                               R18_LEGACY_COMMAND_FIRMWARE, R18_SLEEP_COMMAND_FIRMWARE, ScopedApiError, capture_r18, export_environment,
                               gateway_environment, verify_integration_api)


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
                verify.assert_called_once_with(8788, INTEGRATION_TEAM_REVISION, self.context, mode="integration")

    def test_r18_requires_its_own_authenticated_profile_and_routes(self):
        root = Path.cwd()
        profile = {"version": 1, "address": "00:00:00:00:00:01", "csePort": 8760, "apiPort": 8789,
                    "tlsDirectory": str(root), "apiMode": "r18", "cseDeploymentId": "scoped-mobius4",
                    "receiptContainerRi": "cnt-receipt", "observationContainerRi": "cnt-observation",
                    "firmwareRevision": R18_COMMAND_FIRMWARE}
        connection = Mock()
        expected = dict(self.capabilities, mode="r18", gatewayId="gw-b", deviceId=R18_DEVICE,
                        boardRevision=R18_BOARD, firmwareRevision=R18_COMMAND_FIRMWARE)
        connection.getresponse.return_value = Mock(status=200, read=Mock(return_value=json.dumps(expected).encode()))
        with (patch("scoped_feather_pi.load_tls", return_value=(root / "ca.pem", root / "gateway-b.pem",
                                                               root / "gateway-b.key", self.context)) as tls,
              patch("scoped_feather_pi.http.client.HTTPSConnection", return_value=connection)):
            env = gateway_environment(profile, root, verify_api=True)
            tls.assert_called_once_with(root, "b")
            self.assertEqual(env["GATEWAY_ID"], "gw-b")
            self.assertEqual(json.loads(env["BLE_DEVICES"]), {R18_DEVICE: profile["address"]})
            self.assertEqual(env["BLE_BOARD_REVISION"], R18_BOARD)
            self.assertEqual(env["FIRMWARE_REVISION_ALLOWLIST"], R18_COMMAND_FIRMWARE)
            self.assertEqual(env["PC_API_DEPLOYMENT_ID"], "scoped-command-api-r18")
            self.assertTrue(env["M2M_OBSERVATION_CONTAINER"].endswith("/command-observations-b"))
            self.assertTrue(env["M2M_RECEIPT_CONTAINER"].endswith("/command-receipts-b"))
            for missing in ("receiptContainerRi", "observationContainerRi"):
                unpinned = {key: value for key, value in profile.items() if key != missing}
                with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, "distinct scoped r18"):
                    gateway_environment(unpinned, root)
            self.assertTrue(env["M2M_HEALTH_CONTAINER"].endswith("/command-health-b"))
            connection.request.assert_called_once_with("GET", "/api/v1/gateways/gw-b/bench-capabilities",
                                                       headers={"Accept": "application/json", "Cache-Control": "no-store"})
            legacy = {key: value for key, value in profile.items() if key != "firmwareRevision"}
            self.assertEqual(gateway_environment(legacy, root)["FIRMWARE_REVISION_ALLOWLIST"], R18_LEGACY_COMMAND_FIRMWARE)
            with self.assertRaises(ScopedApiError):
                gateway_environment(legacy, root, verify_api=True)
            connection.getresponse.return_value.read.return_value = json.dumps(
                dict(expected, firmwareRevision=R18_LEGACY_COMMAND_FIRMWARE)).encode()
            gateway_environment(legacy, root, verify_api=True)
            sleep_profile = dict(profile, firmwareRevision=R18_SLEEP_COMMAND_FIRMWARE)
            with self.assertRaises(ScopedApiError):
                gateway_environment(sleep_profile, root, verify_api=True)
            connection.getresponse.return_value.read.return_value = json.dumps(
                dict(expected, firmwareRevision=R18_SLEEP_COMMAND_FIRMWARE)).encode()
            sleep_env = gateway_environment(sleep_profile, root, verify_api=True)
            self.assertEqual(sleep_env["FIRMWARE_REVISION_ALLOWLIST"], R18_SLEEP_COMMAND_FIRMWARE)
            connection.getresponse.return_value.read.return_value = json.dumps(self.capabilities).encode()
            with self.assertRaises(ScopedApiError):
                gateway_environment(profile, root, verify_api=True)
            for firmware in ("keyring-0.7.15-bringup", "feather-probe-0.2.1"):
                with self.subTest(firmware=firmware), self.assertRaisesRegex(ValueError, "command-enabled r18"):
                    gateway_environment(dict(profile, firmwareRevision=firmware), root)

    def test_profile_pins_only_the_selected_command_firmware(self):
        root = Path.cwd()
        profile = {"version": 1, "address": "00:00:00:00:00:01", "csePort": 8760, "apiPort": 8787,
                   "tlsDirectory": str(root)}
        with patch("scoped_feather_pi.load_tls", return_value=(root / "ca.pem", root / "cert.pem",
                                                              root / "key.pem", self.context)):
            self.assertEqual(gateway_environment(profile, root)["FIRMWARE_REVISION_ALLOWLIST"], "feather-probe-0.2.0")
            lcd = dict(profile, firmwareRevision="feather-probe-0.2.1")
            self.assertEqual(gateway_environment(lcd, root)["FIRMWARE_REVISION_ALLOWLIST"], "feather-probe-0.2.1")
            with self.assertRaisesRegex(ValueError, "Unknown Feather command firmware"):
                gateway_environment(dict(profile, firmwareRevision="feather-probe-0.1.1"), root)

    def test_r18_observation_only_keeps_both_telemetry_routes_and_fences_commands(self):
        root = Path.cwd()
        profile = {"version": 1, "address": "00:00:00:00:00:01", "csePort": 8760, "apiPort": 8789,
                   "tlsDirectory": str(root), "apiMode": "r18", "cseDeploymentId": "scoped-mobius4",
                   "receiptContainerRi": "cnt-receipt", "observationContainerRi": "cnt-observation", "observeOnly": True}
        with patch("scoped_feather_pi.load_tls", return_value=(root / "ca.pem", root / "cert.pem",
                                                              root / "key.pem", self.context)):
            for firmware in R18_BRINGUP_FIRMWARES:
                with self.subTest(firmware=firmware):
                    env = gateway_environment(dict(profile, firmwareRevision=firmware), root)
                    self.assertEqual(env["FIRMWARE_REVISION_ALLOWLIST"], firmware)
                    self.assertEqual(env["COMMANDS_ENABLED"], "false")
                    self.assertEqual(env["CENTRAL_RECEIPTS_ENABLED"], "false")
                    self.assertEqual(env["CENTRAL_TELEMETRY_ENABLED"], "true")
                    self.assertEqual(env["M2M_OBSERVATION_CONTAINER_RI"], "cnt-observation")
                    self.assertEqual(env["MQTT_ENABLED"], "false")
            mqtt_profile = dict(profile, healthContainerRi="cnt-health", mqttPort=8884)
            env = gateway_environment(mqtt_profile, root)
            self.assertEqual((env["MQTT_ENABLED"], env["M2M_MQTT_ENABLED"], env["CORE_BRIDGE_ENABLED"]),
                             ("true", "true", "false"))
            self.assertEqual((env["MQTT_HOST"], env["MQTT_PORT"], env["COMMANDS_ENABLED"]), ("127.0.0.1", "8884", "false"))
            for invalid in (dict(mqtt_profile, observeOnly=False), dict(mqtt_profile, mqttPort=8760),
                            dict(profile, mqttPort=8884)):
                with self.assertRaisesRegex(ValueError, "Scoped MQTT requires r18 observation mode"):
                    gateway_environment(invalid, root)
            with self.assertRaisesRegex(ValueError, "observation-only r18 bring-up"):
                gateway_environment(dict(profile, firmwareRevision=R18_COMMAND_FIRMWARE), root)
            with self.assertRaisesRegex(ValueError, "require r18"):
                gateway_environment(dict(profile, apiMode="integration"), root)

    def test_new_session_can_forward_both_container_pins_and_the_central_deployment(self):
        root = Path.cwd()
        profile = {"version": 1, "address": "00:00:00:00:00:01", "csePort": 8760, "apiPort": 8788,
                   "tlsDirectory": str(root), "apiMode": "integration", "cseDeploymentId": "scoped-mobius4",
                   "receiptContainerRi": "cnt-receipt", "observationContainerRi": "cnt-observation",
                   "pcApiDeploymentId": "central-bench-a"}
        with patch("scoped_feather_pi.load_tls", return_value=(root / "ca.pem", root / "cert.pem",
                                                              root / "key.pem", self.context)):
            env = gateway_environment(profile, root)
            self.assertEqual(env["M2M_RECEIPT_CONTAINER_RI"], "cnt-receipt")
            self.assertEqual(env["M2M_OBSERVATION_CONTAINER_RI"], "cnt-observation")
            self.assertEqual(env["PC_API_DEPLOYMENT_ID"], "central-bench-a")
            for invalid in (dict(profile, observationContainerRi="/foreign/path"),
                            dict(profile, cseDeploymentId="other-cse"), dict(profile, pcApiDeploymentId="a/b")):
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    gateway_environment(invalid, root)

    def test_export_keeps_prepared_values_private_without_a_network_probe_or_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            session = Path(folder)
            settings = {"PATH": "/usr/bin", "PYTHONPATH": "/checkout/src", "GATEWAY_ID": "gw-b",
                        "GATEWAY_DATABASE": str(session / "gateway.sqlite3"),
                        "BLE_DEVICES": json.dumps({R18_DEVICE: "00:00:00:00:00:01"}),
                        "M2M_OBSERVATION_CONTAINER_RI": "cnt-obs", "TLS_KEY_FILE": "/private keys/gateway-b.key"}
            with patch("scoped_feather_pi.load_environment", return_value=settings) as load:
                path = export_environment(session)
                load.assert_called_once_with(session, verify_api=False)
                exported = path.read_text(encoding="utf-8")
                self.assertIn("TLS_KEY_FILE=/private keys/gateway-b.key\n", exported)
                self.assertIn("M2M_OBSERVATION_CONTAINER_RI=cnt-obs\n", exported)
                self.assertNotIn("PATH=", exported)
                with self.assertRaises(FileExistsError):
                    export_environment(session)
                self.assertEqual(path.read_text(encoding="utf-8"), exported)
                self.assertEqual(list(session.iterdir()), [path])
                settings["TLS_KEY_FILE"] = "/private\nGATEWAY_ID=other"
                with self.assertRaisesRegex(ValueError, "cannot be represented"):
                    export_environment(session)

    def test_r18_capture_uses_same_session_lock_and_enrollment(self):
        root = Path.cwd()
        session, output = root / "prepared-r18", root / "device-archive"
        address = "00:00:00:00:00:01"
        lock = Mock()
        lock.fileno.return_value = 71
        environment = {"GATEWAY_ID": "gw-b", "BLE_BOARD_REVISION": R18_BOARD,
                       "FIRMWARE_REVISION_ALLOWLIST": R18_COMMAND_FIRMWARE, "BLE_DEVICES": json.dumps({R18_DEVICE: address}),
                       "GATEWAY_DATABASE": str(session / "gateway.sqlite3"), "BLE_GATT_PROFILE": "core-v1"}
        with (patch("scoped_feather_pi.bench_lock", return_value=nullcontext(lock)) as acquire,
              patch("scoped_feather_pi.load_environment", return_value=environment) as load,
              patch("scoped_feather_pi.os.set_inheritable") as inherit,
              patch("scoped_feather_pi.os.execve") as launch):
            capture_r18(root, session, output)
            acquire.assert_called_once_with(root)
            load.assert_called_once_with(session, verify_api=False)
            inherit.assert_called_once_with(71, True)
            launch.assert_called_once_with(sys.executable, [sys.executable, "-m", "bubble_gateway.journal_cli",
                "--device-id", R18_DEVICE, "--address", address, "--database", environment["GATEWAY_DATABASE"],
                "--gatt-profile", "core-v1", "--board-revision", R18_BOARD, "--firmware-revision", R18_COMMAND_FIRMWARE,
                "--output", str(output)], environment)
            launch.reset_mock()
            environment["GATEWAY_ID"] = "gw-a"
            with self.assertRaisesRegex(ValueError, "prepared r18"):
                capture_r18(root, session, output)
            launch.assert_not_called()
