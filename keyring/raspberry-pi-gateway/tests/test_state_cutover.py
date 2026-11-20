import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from bubble_gateway.model import payload_hash
from bubble_gateway.state_cutover import cutover_plan
from bubble_gateway.state_identity import StateIdentityError, configured_binding
from bubble_gateway.store import Store
from helpers import command, config, observation


class CutoverTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.current = self.configuration(self.root / "source.db")
        with closing(Store(self.current.database, 100, 100000, 20, configured_binding(self.current))):
            pass

    @staticmethod
    def configuration(path, **changes):
        value = config(path)
        value.cse_deployment_id = "test-mobius"
        value.pc_api_deployment_id = "test-pc"
        value.cse_url = "https://mobius.invalid"
        value.api_url = "https://central.invalid"
        value.mqtt_host = "mqtt.invalid"
        value.mqtt_port = 8883
        value.mqtt_wrapped_primitive = False
        value.commands_enabled = True
        vars(value).update(changes)
        return value

    def test_same_binding_reports_endpoint_change_and_committed_pending_lanes(self):
        with closing(Store(self.current.database, 100, 100000, 20, configured_binding(self.current))) as store:
            store.observation(self.current.observation_container, observation(), core_enabled=True, central_enabled=True)
            store.enqueue("health", "test", self.current.health_container, {"test": True})
            for status in ("received", "dispatching", "dispatching-marked", "dispatching-legacy", "terminal"):
                cmd = command(commandId=status)
                store.accept(cmd, payload_hash(cmd))
                if status.startswith("dispatching"):
                    store.begin_dispatch(cmd)
                if status == "dispatching-marked":
                    self.assertTrue(store.mark_ble_final_write(status, payload_hash(cmd)))
                if status == "dispatching-legacy":
                    with store.db:
                        store.db.execute("UPDATE commands SET ble_final_write_started=NULL WHERE command_id=?", (status,))
                if status == "terminal":
                    store.finish(status, {"commandId": status, "status": "APPLIED"})
            target = self.configuration(self.current.database, api_url="https://tunnel.invalid")
            report = cutover_plan(self.current, target)

        self.assertEqual(report["databaseAction"], "reuse-existing")
        self.assertEqual(report["changedEndpointFields"], ["pcApiUrl"])
        self.assertEqual(report["outboxByRoute"], {"nativeObservationOrHealth": 2, "coreTelemetry": 1,
                                                  "centralTelemetry": 1})
        self.assertEqual(report["journal"], {"commandsReceived": 1, "commandsDispatching": 3,
                                             "dispatchingByFinalBleWrite": {"notStarted": 1, "possiblyStarted": 1, "unknown": 1},
                                             "nativeReceiptsNotStaged": 1, "centralReceiptsWithoutStageMarker": 1,
                                             "credentialReceiptsNotDelivered": 0})

    def test_database_without_final_write_column_reports_unknown_without_migrating(self):
        with closing(Store(self.current.database, 100, 100000, 20, configured_binding(self.current))) as store:
            cmd = command()
            store.accept(cmd, payload_hash(cmd))
            store.begin_dispatch(cmd)
            with store.db:
                store.db.execute("""
                    CREATE TABLE legacy_commands AS SELECT command_id, payload_hash, payload, status,
                        received_at, receipt, receipt_delivered, central_receipt_staged FROM commands
                """)
                store.db.execute("DROP TABLE commands")
                store.db.execute("ALTER TABLE legacy_commands RENAME TO commands")
            report = cutover_plan(self.current, self.current)
            columns = {row["name"] for row in store.db.execute("PRAGMA table_info(commands)")}

        self.assertEqual(report["journal"]["dispatchingByFinalBleWrite"],
                         {"notStarted": 0, "possiblyStarted": 0, "unknown": 1})
        self.assertNotIn("ble_final_write_started", columns)

    def test_new_binding_needs_unused_path_and_does_not_create_database(self):
        target = self.configuration(self.root / "target.db", pc_api_deployment_id="new-pc")
        report = cutover_plan(self.current, target)
        self.assertEqual(report["databaseAction"], "use-new-database")
        self.assertEqual(report["changedBindingFields"], ["pcApiDeploymentId"])
        self.assertIsNone(report["targetHolds"])
        self.assertFalse(target.database.exists())
        target.database.with_name("target.db-wal").touch()
        with self.assertRaisesRegex(StateIdentityError, "STATE_CUTOVER_TARGET_PATH_IN_USE"):
            cutover_plan(self.current, target)

    def test_same_database_reports_disabled_lanes_and_target_epoch_mismatch(self):
        self.current.central_receipts_enabled = True
        with closing(Store(self.current.database, 100, 100000, 20, configured_binding(self.current))) as store:
            container = self.current.observation_container
            store.observation(container, observation(), core_enabled=True, central_enabled=True)
            store.observation(container, observation(sequence=2), core_enabled=True, core_epochs={"kr-test": 6})
            store.observation(container, observation(sequence=3), core_enabled=True, core_epochs={"kr-test": 7})
            store.enqueue("core-ack", "older", "@core/ack", {"commandId": "older"})
            pending = command(commandId="pending")
            store.accept(pending, payload_hash(pending))
            final = command(commandId="final")
            store.accept(final, payload_hash(final))
            store.finish("final", {"commandId": "final", "status": "APPLIED"})

            target = self.configuration(self.current.database, commands_enabled=False, core_telemetry_epochs={"kr-test": 7})
            self.assertEqual(cutover_plan(self.current, target)["targetHolds"], {
                "coreTelemetryScopeMismatch": 2, "coreTelemetryBridgeDisabled": 0, "coreAckDisabled": 1,
                "nativeCommandReceiptsDisabled": 1, "pendingCommandsDisabled": 1,
                "centralTelemetryDisabled": 1, "centralReceiptsDisabled": 1,
            })
            target.core_bridge_enabled, target.core_telemetry_epochs = False, None
            holds = cutover_plan(self.current, target)["targetHolds"]
            self.assertEqual(holds["coreTelemetryScopeMismatch"], 0)
            self.assertEqual(holds["coreTelemetryBridgeDisabled"], 3)

    def test_rejects_reuse_across_bindings_and_reset_under_same_binding(self):
        reused = self.configuration(self.current.database, cse_deployment_id="new-mobius")
        with self.assertRaisesRegex(StateIdentityError, "STATE_CUTOVER_REQUIRES_NEW_DATABASE"):
            cutover_plan(self.current, reused)
        reset = self.configuration(self.root / "empty.db")
        with self.assertRaisesRegex(StateIdentityError, "STATE_CUTOVER_REQUIRES_SOURCE_DATABASE"):
            cutover_plan(self.current, reset)

    def test_source_config_must_match_database(self):
        wrong = self.configuration(self.current.database, pc_api_deployment_id="wrong-pc")
        with self.assertRaisesRegex(StateIdentityError, "STATE_PC_API_DEPLOYMENT_MISMATCH"):
            cutover_plan(wrong, wrong)
