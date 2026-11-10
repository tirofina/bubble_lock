import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from bubble_gateway.model import canonical, payload_hash
from bubble_gateway.state_archive import archive
from bubble_gateway.state_identity import DATA_TABLES, StateIdentityError, configured_binding, metadata, readonly
from bubble_gateway.store import CapacityError, Store
from helpers import BINDING, command, config, observation


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "synthetic.sqlite3"
        self.store = self.open_store()
        self.addCleanup(lambda: self.store.close())

    def open_store(self, **changes):
        return Store(self.path, 100, 100000, 20, dict(BINDING, **changes))

    def rows(self):
        return {name: [tuple(row) for row in self.store.db.execute(f"SELECT * FROM {name}")]
                for name in DATA_TABLES}

    def populate(self):
        cmd = command()
        digest = payload_hash(cmd)
        self.store.accept(cmd, digest)
        self.store.begin_dispatch(cmd)
        self.store.observation(BINDING["observationContainer"], observation(), core_enabled=True)
        return cmd, digest

    def test_server_retry_delay_is_preserved_when_database_reopens(self):
        rqi = self.store.request_id("health", "test-retry")
        with patch("bubble_gateway.store.time.time", return_value=1000.0):
            self.store.enqueue("health", "test-retry", BINDING["healthContainer"], {"version": 1})
            self.store.retry(rqi, 0, minimum_delay=45)
        self.store.close()
        self.store = self.open_store()

        with patch("bubble_gateway.store.time.time", return_value=1044.0):
            self.assertIsNone(self.store.due())
        with patch("bubble_gateway.store.time.time", return_value=1045.0):
            self.assertEqual(self.store.due()["rqi"], rqi)

    def test_binding_mismatch_refuses_before_data_changes(self):
        before = self.rows()
        with self.assertRaisesRegex(StateIdentityError, "STATE_IDENTITY_MISMATCH"):
            self.open_store(gatewayId="gw-foreign")
        self.assertEqual(self.rows(), before)

    def test_deployment_binding_keeps_queued_receipts_on_the_original_cse(self):
        deployment_db = self.path.with_name("deployment.sqlite3")
        cfg = config(deployment_db)
        cfg.cse_deployment_id = "scoped-mobius4"
        cfg.receipt_container_ri = "cnt-original"
        cfg.cse_url = "https://old-address.invalid"
        binding = configured_binding(cfg)
        self.assertEqual(binding["bindingVersion"], 2)
        with closing(Store(deployment_db, 100, 100000, 20, binding)) as store:
            store.enqueue("receipt", "pending-receipt", cfg.receipt_container, {}, critical=True)
        cfg.cse_url = "https://replacement-address.invalid"
        with closing(Store(deployment_db, 100, 100000, 20, configured_binding(cfg))) as store:
            self.assertEqual(metadata(store.db)["binding"], binding)
            self.assertEqual(store.due()["container"], cfg.receipt_container)
        for different_deployment in ("production", None):
            cfg.cse_deployment_id = different_deployment
            with self.subTest(deployment=different_deployment), self.assertRaisesRegex(
                    StateIdentityError, "STATE_CSE_DEPLOYMENT_MISMATCH"):
                Store(deployment_db, 100, 100000, 20, configured_binding(cfg))
        cfg.cse_deployment_id = "scoped-mobius4"
        for different_pin in ("cnt-recreated", None):
            cfg.receipt_container_ri = different_pin
            with self.subTest(pin=different_pin), self.assertRaisesRegex(
                    StateIdentityError, "STATE_RECEIPT_CONTAINER_MISMATCH"):
                Store(deployment_db, 100, 100000, 20, configured_binding(cfg))
        with self.assertRaisesRegex(StateIdentityError, "STATE_CSE_DEPLOYMENT_MISMATCH"):
            self.open_store(bindingVersion=2, cseDeploymentId="scoped-mobius4")
        self.assertEqual(metadata(self.store.db)["binding"], BINDING)

    def test_duplicate_conflict_and_interrupted_intent_survive_restart(self):
        cmd, digest = self.populate()
        self.assertEqual(self.store.accept(cmd, digest), "DUPLICATE")
        self.assertEqual(self.store.accept(dict(cmd, desiredState={"state": False}), "0" * 64), "CONFLICT")
        self.store.close()
        self.store = self.open_store()
        self.assertEqual(self.store.pending(), [])
        self.assertEqual(self.store.interrupted(), [{"command": cmd, "digest": digest}])
        self.assertEqual(self.store.begin_dispatch(cmd), "ALREADY_DISPATCHED")

    def test_stale_epoch_and_grant_do_not_dispatch(self):
        self.populate()
        for changes, error in ((dict(ownershipEpoch=1), "STALE_EPOCH"),
                               (dict(grantRevision=2), "STALE_GRANT")):
            cmd = command(commandId=error, **changes)
            self.store.accept(cmd, payload_hash(cmd))
            self.assertEqual(self.store.begin_dispatch(cmd), error)
            self.assertEqual(self.store.db.execute("SELECT status FROM commands WHERE command_id=?",
                                                   (error,)).fetchone()[0], "RECEIVED")

    def test_outbox_capacity_rolls_back_observation_sequence(self):
        self.store.max_rows = 1  # Ordinary traffic has no slots; critical receipts retain reservation.
        with self.assertRaises(CapacityError):
            self.store.observation(BINDING["observationContainer"], observation(), True)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 0)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM core_sequences").fetchone()[0], 0)
        self.store.enqueue("receipt", "synthetic", BINDING["receiptContainer"], {}, critical=True)
        self.assertEqual(self.store.counts()[0], 1)

    def test_nullable_projection_uses_only_the_scoped_route(self):
        container = BINDING["observationContainer"]
        base = observation(battery=None, rssi=None, buttonState="confirm", state=False)
        self.assertTrue(self.store.observation(container, base, True))
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM core_sequences").fetchone()[0], 0)
        self.assertTrue(self.store.observation(container, {**base, "sequence": 2}, True, core_epochs={"kr-test": 7}))
        row = self.store.due(core_epochs={"kr-test": 7}, scoped_only=True)
        self.assertEqual(row["payload"]["schemaVersion"], "1.1.0")
        self.assertEqual(row["payload"]["ownershipEpoch"], 7)
        self.assertIsNone(row["payload"]["batteryPct"])
        self.assertIsNone(row["payload"]["rssiDbm"])
        self.assertIs(row["payload"]["state"], False)
        self.assertEqual(self.store.due()["payload"]["buttonState"], "confirm")

    def test_core_sequence_persists_across_firmware_reboots(self):
        self.store.observation(BINDING["observationContainer"], observation(sequence=99), True)
        self.store.close()
        self.store = self.open_store()
        self.store.observation(BINDING["observationContainer"], observation(bootId="boot-new", sequence=0), True)
        frames = [json.loads(row[0]) for row in self.store.db.execute(
            "SELECT payload FROM outbox WHERE container='@core/telemetry'")]
        self.assertEqual(sorted(frame["sequence"] for frame in frames), [0, 1])
        self.assertFalse(self.store.observation(BINDING["observationContainer"], observation(bootId="boot-new", sequence=0), True))

    def test_core_retry_blocks_only_newer_telemetry_for_the_same_device(self):
        for payload in (observation(state=True), observation(sequence=2, state=False),
                        observation(deviceId="kr-other")):
            self.assertTrue(self.store.observation(BINDING["observationContainer"], payload, True))
        first = Store.request_id("core-telemetry", "kr-test:boot-test:1")
        with patch("bubble_gateway.store.time.time", return_value=1000):
            self.store.retry(first, 0)
            self.store.close()
            self.store = self.open_store()
            sent = []
            while item := self.store.due():
                sent.append((item["container"], item["payload"]["deviceId"]))
                self.store.delivered(item["rqi"])
        self.assertEqual(sent.count((BINDING["observationContainer"], "kr-test")), 2)
        self.assertIn(("@core/telemetry", "kr-other"), sent)
        self.assertNotIn(("@core/telemetry", "kr-test"), sent)

        with patch("bubble_gateway.store.time.time", return_value=2000):
            for sequence, state in ((0, True), (1, False)):
                item = self.store.due()
                self.assertEqual((item["container"], item["payload"]["sequence"], item["payload"]["state"]),
                                 ("@core/telemetry", sequence, state))
                self.store.delivered(item["rqi"])
            self.assertIsNone(self.store.due())

    def test_core_sequence_exhaustion_does_not_wrap_or_queue_partial_observation(self):
        self.store.db.execute("INSERT INTO core_sequences VALUES('kr-test',4294967295)")
        self.store.db.commit()
        with self.assertRaises(CapacityError):
            self.store.observation(BINDING["observationContainer"], observation(), True)
        self.assertEqual(self.store.counts()[0], 0)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 0)

    def test_receipt_delivery_requires_explicit_transport_confirmation(self):
        cmd, digest = self.populate()
        receipt = dict(gatewayId="gw-test", deviceId="kr-test", commandId=cmd["commandId"],
                       payloadHash=digest, status="INDETERMINATE", ackCode="INDETERMINATE")
        self.store.finish(cmd["commandId"], receipt)
        self.store.stage_receipts(BINDING["receiptContainer"], True)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM outbox WHERE container='@core/ack'").fetchone()[0], 0)
        row = self.store.db.execute("SELECT rqi FROM outbox WHERE command_id=?", (cmd["commandId"],)).fetchone()
        self.store.retry(row[0], 0)
        self.assertEqual(self.store.db.execute("SELECT receipt_delivered FROM commands").fetchone()[0], 0)
        self.store.delivered(row[0])
        self.assertEqual(self.store.db.execute("SELECT receipt_delivered FROM commands").fetchone()[0], 1)

    def archive(self, name="archive", adopt=False, timeout=5):
        # POSIX directory durability is not modeled on Windows. All SQLite, file
        # hashing and state logic below is real, against this test's private temp DB.
        with patch("bubble_gateway.state_archive._sync_directory") as sync:
            path = archive(config(self.path), Path(self.temp.name) / name, adopt=adopt, timeout=timeout)
            self.assertGreaterEqual(sync.call_count, 2)
            return path

    def test_wal_archive_preserves_rows_and_cannot_launch_as_live_state(self):
        self.populate()
        before = self.rows()
        manifest_path = self.archive()
        manifest = json.loads(manifest_path.read_text())
        target = manifest_path.parent / "gateway.sqlite3"
        with closing(readonly(target)) as db:
            self.assertEqual({name: [tuple(row) for row in db.execute(f"SELECT * FROM {name}")]
                              for name in DATA_TABLES}, before)
            self.assertEqual(metadata(db)["recovery_state"], "QUARANTINED")
        self.assertEqual(self.rows(), before)
        self.assertEqual(manifest["commandStatuses"], {"DISPATCHING": 1})
        self.assertEqual(manifest["files"][0]["sha256"], hashlib.sha256(target.read_bytes()).hexdigest())
        with self.assertRaisesRegex(StateIdentityError, "STATE_RECOVERY_QUARANTINED"):
            Store(target, 100, 100000, 20, BINDING)

    def test_legacy_requires_explicit_adoption_with_cold_copy_first(self):
        self.populate()
        before = self.rows()
        self.store.db.execute("DROP TABLE gateway_state")
        self.store.db.commit()
        with self.assertRaisesRegex(StateIdentityError, "STATE_LEGACY_ADOPTION_REQUIRED"):
            self.open_store()
        deployment = config(self.path)
        deployment.cse_deployment_id = "unproven"
        refused_output = Path(self.temp.name) / "refused"
        with self.assertRaisesRegex(StateIdentityError, "STATE_CSE_DEPLOYMENT_UNBOUND"):
            archive(deployment, refused_output, adopt=True, timeout=5)
        self.assertFalse(refused_output.exists())
        manifest_path = self.archive(adopt=True)
        self.assertEqual(self.rows(), before)
        self.assertEqual(metadata(self.store.db)["recovery_state"], "LIVE")
        self.assertTrue(json.loads((manifest_path.parent / "adoption.json").read_text())["bindingAdded"])
        self.assertEqual(json.loads(manifest_path.read_text())["sourceIdentityState"], "legacy-unbound")

    def test_invalid_legacy_hash_refused_before_archive_creation(self):
        self.populate()
        self.store.db.execute("DROP TABLE gateway_state")
        self.store.db.execute("UPDATE commands SET payload_hash=?", ("0" * 64,))
        self.store.db.commit()
        with self.assertRaisesRegex(StateIdentityError, "STATE_LEGACY_COMMAND_MISMATCH"):
            self.archive(adopt=True)
        self.assertFalse((Path(self.temp.name) / "archive").exists())

    def test_archive_never_overwrites_and_timeout_has_no_manifest(self):
        self.populate()
        path = self.archive()
        before = path.read_bytes()
        with self.assertRaises(FileExistsError):
            self.archive()
        self.assertEqual(path.read_bytes(), before)
        with self.assertRaises(TimeoutError):
            self.archive(name="timeout", timeout=-1)
        self.assertFalse((Path(self.temp.name) / "timeout" / "manifest.json").exists())
