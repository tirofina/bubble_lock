import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from bubble_gateway.model import canonical, parse_time, payload_hash
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

    def test_heartbeat_waits_for_pending_report_across_restart_without_blocking_credential_receipts(self):
        health = BINDING["healthContainer"]
        first = {"bootId": "first-boot", "observedAt": "2026-11-10T00:00:00.000Z",
                 "uptimeSeconds": 30, "outboxDepth": 0}
        newer = dict(first, bootId="next-boot", observedAt="2026-11-10T00:01:00.000Z")
        state = {"status": "LOST", "credentialRevision": "rev-1"}
        # A deployment may share the health container with another payload type.
        self.store.observation(health, observation())
        self.store.record_credential_status(state, lambda: first)
        self.store.stage_credential_receipt()
        self.assertTrue(self.store.enqueue_heartbeat(first))
        self.assertEqual(self.store.counts()[0], 3)

        rqi = self.store.request_id("health", f"{first['bootId']}:{first['observedAt']}")
        with patch("bubble_gateway.store.time.time", return_value=1000):
            self.store.retry(rqi, 0, minimum_delay=300)
        self.store.close()
        self.store = self.open_store()
        self.assertFalse(self.store.enqueue_heartbeat(newer))
        self.assertEqual(self.store.counts()[0], 3)
        retained = self.store.db.execute("SELECT payload,next_attempt FROM outbox WHERE rqi=?", (rqi,)).fetchone()
        self.assertEqual(tuple(retained), (canonical(first), 1300.0))

        self.store.delivered(rqi)
        self.assertTrue(self.store.enqueue_heartbeat(newer))
        self.assertEqual(self.store.counts()[0], 3)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM credential_receipts WHERE delivered_at IS NULL").fetchone()[0], 1)

    def test_credential_receipts_survive_full_outbox_restart_and_replay_in_order(self):
        initial = {"status": "ACTIVE", "credentialRevision": "rev-1"}
        rotated = {"status": "ACTIVE", "credentialRevision": "rev-2"}
        lost = {"status": "LOST", "credentialRevision": "rev-2"}
        snapshot = lambda: {"bootId": "first-boot"}
        self.store.max_rows = 2  # One ordinary slot.
        self.store.enqueue("observation", "existing", BINDING["observationContainer"], {"sequence": 1})
        ordinary = self.store.due()["rqi"]
        for state in (initial, rotated, lost):
            self.assertTrue(self.store.record_credential_status(state, snapshot))
        self.store.stage_credential_receipt()
        self.assertEqual(self.store.counts()[0], 1)
        self.store.close()
        self.store = self.open_store()
        self.assertFalse(self.store.record_credential_status(lost, lambda: {"bootId": "new-boot"}))
        self.store.delivered(ordinary)

        self.store.stage_credential_receipt()
        first = self.store.due()
        self.assertEqual(first["container"], BINDING["healthContainer"])
        with patch("bubble_gateway.store.time.time", return_value=1000):
            self.store.retry(first["rqi"], 0, minimum_delay=45)
            self.store.stage_credential_receipt()
            self.assertIsNone(self.store.due())
            self.assertEqual(self.store.counts()[0], 1)
        self.store.close()
        self.store = self.open_store()
        with patch("bubble_gateway.store.time.time", return_value=1045):
            replay = self.store.due()
            self.assertEqual((replay["rqi"], replay["payload"]), (first["rqi"], first["payload"]))
            self.store.delivered(first["rqi"])

        previous = initial
        for sequence, state in ((2, rotated), (3, lost)):
            self.store.stage_credential_receipt()
            item = self.store.due()
            self.assertEqual(item["payload"]["credentialTransition"],
                             dict(sequence=sequence, previous=previous, current=state))
            self.store.delivered(item["rqi"])
            previous = state
        self.assertEqual(first["payload"]["credentialTransition"], dict(sequence=1, previous=None, current=initial))
        self.assertEqual([tuple(row) for row in self.store.db.execute(
            "SELECT sequence,delivered_at IS NOT NULL FROM credential_receipts ORDER BY sequence")],
            [(1, 1), (2, 1), (3, 1)])
        self.assertEqual(self.store.counts()[0], 0)

    def test_credential_retention_trims_only_delivered_entries(self):
        for revision in ("rev-1", "rev-2", "rev-3"):
            self.store.record_credential_status({"status": "ACTIVE", "credentialRevision": revision},
                                                lambda: {"bootId": "first-boot"})
        with patch("bubble_gateway.store.RETAIN_DELIVERED_CREDENTIAL_RECEIPTS", 1):
            for _ in range(2):
                self.store.stage_credential_receipt()
                self.store.delivered(self.store.due()["rqi"])
        self.assertEqual([tuple(row) for row in self.store.db.execute(
            "SELECT sequence,delivered_at IS NOT NULL FROM credential_receipts ORDER BY sequence")], [(2, 1), (3, 0)])

    def test_credential_receipt_table_is_added_to_existing_bound_database(self):
        self.populate()
        self.store.db.execute("DROP TABLE credential_receipts")
        self.store.close()
        self.store = self.open_store()
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM credential_receipts").fetchone()[0], 0)
        self.assertEqual(self.store.counts(), (2, 1))

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
        self.assertEqual(self.store.observation_heads(), {})
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM core_sequences").fetchone()[0], 0)
        self.store.enqueue("receipt", "synthetic", BINDING["receiptContainer"], {}, critical=True)
        self.assertEqual(self.store.counts()[0], 1)

    def test_central_observation_is_durable_with_native_copy_and_watermark(self):
        container = BINDING["observationContainer"]
        payload = observation(sensorValues={"location": {"lat": 37.5, "lon": 127.0, "source": "gps"}})
        self.store.max_rows = 2  # One ordinary slot fits only the native copy.
        with self.assertRaises(CapacityError):
            self.store.observation(container, payload, central_enabled=True)
        self.assertEqual(self.store.counts()[0], 0)
        self.assertEqual(self.store.observation_heads(), {})

        self.store.max_rows = 4
        self.assertTrue(self.store.observation(container, payload, central_enabled=True))
        self.store.close()
        self.store = self.open_store()
        self.assertFalse(self.store.observation(container, payload, central_enabled=True))
        item = self.store.due_central_telemetry()
        self.assertEqual((item["container"], item["payload"]), ("@central/telemetry", payload))
        self.store.delivered(item["rqi"])
        self.assertEqual(self.store.due()["payload"], payload)

    def test_central_retry_preserves_device_order_without_holding_other_devices(self):
        container = BINDING["observationContainer"]
        first = observation(sequence=9)
        second = observation(bootId="boot-new", sequence=0)
        other = observation(deviceId="kr-other")
        for payload in (first, second, other):
            self.assertTrue(self.store.observation(container, payload, central_enabled=True))
        identity = {key: first[key] for key in ("gatewayId", "deviceId", "bootId", "sequence")}
        first_rqi = self.store.request_id("central-telemetry", payload_hash(identity))
        with patch("bubble_gateway.store.time.time", return_value=1000):
            self.assertIsNone(self.store.due(skip_native=True))
            self.store.retry(first_rqi, 0)
            self.store.close()
            self.store = self.open_store()
            remaining = self.store.due_central_telemetry()
            self.assertEqual(remaining["payload"], other)
            self.store.delivered(remaining["rqi"])
            self.assertIsNone(self.store.due_central_telemetry())

        with patch("bubble_gateway.store.time.time", return_value=2000):
            for payload in (first, second):
                item = self.store.due_central_telemetry()
                self.assertEqual(item["payload"], payload)
                self.store.delivered(item["rqi"])

    def test_expired_central_rows_free_capacity_without_deleting_native_or_fresh_rows(self):
        container = BINDING["observationContainer"]
        old = observation(observedAt="2026-11-09T09:00:00+09:00")
        equally_old = observation(sequence=2, observedAt="2026-11-09T00:00:00.000Z")
        at_cutoff = observation(sequence=3, observedAt="2026-11-09T00:00:01.000Z")
        self.store.max_rows = 7  # Six ordinary rows fit, leaving a reserved slot for receipts.
        for payload in (old, equally_old, at_cutoff):
            self.assertTrue(self.store.observation(container, payload, central_enabled=True))
        first = self.store.due_central_telemetry()
        self.store.retry(first["rqi"], 0, minimum_delay=3600)
        cutoff = parse_time(at_cutoff["observedAt"])
        self.assertIsNone(self.store.due_central_telemetry())
        self.assertEqual(self.store.expire_central_telemetry(cutoff, limit=1), 1)
        self.assertEqual(self.store.expire_central_telemetry(cutoff, limit=128), 1)
        self.assertEqual(self.store.due_central_telemetry()["payload"], at_cutoff)
        self.assertEqual(self.store.counts()[0], 4)
        self.assertTrue(self.store.observation(container, observation(sequence=4), central_enabled=True))

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
        self.assertEqual(self.store.observation_heads(), {"kr-test": ("boot-test", 99)})
        self.store.observation(BINDING["observationContainer"], observation(bootId="boot-new", sequence=0), True)
        self.assertEqual(self.store.observation_heads(), {"kr-test": ("boot-new", 0)})
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
        self.store.record_credential_status({"status": "ACTIVE", "credentialRevision": "rev-1"},
                                            lambda: {"bootId": "first-boot"})
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
        self.assertEqual(manifest["tableCounts"]["credential_receipts"], 1)
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
