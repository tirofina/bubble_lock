"""Opt-in POSIX CLI tests: real flock/fsync/SQLite and test-owned files only."""
from contextlib import closing
import errno
import hashlib
import json
import os
from pathlib import Path
import select
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from bubble_gateway import state_archive
from bubble_gateway.model import payload_hash
from bubble_gateway.state_identity import DATA_TABLES, StateIdentityError, configured_binding, metadata, readonly
from bubble_gateway.store import Store
from helpers import BINDING, command, config, observation


class PosixStateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.name != "posix" or os.getuid() == 0:
            raise RuntimeError("POSIX integration requires an unprivileged Linux process")
        cls.addClassCleanup(os.umask, os.umask(0o077))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="keyring-posix-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "synthetic.sqlite3"
        self.store = Store(self.path, 100, 5000000, 20, BINDING)
        self.addCleanup(self.store.close)
        self.cfg = config(self.path)
        self.env_file = self.root / "synthetic.env"
        # The state operator validates existence, without opening TLS sessions or
        # reading keys. These placeholders are not certificates or credentials.
        for name in ("ca", "cert", "key"):
            (self.root / name).write_text("TEST PLACEHOLDER - NOT A CREDENTIAL\n", encoding="ascii")
        self.values = {
            "GATEWAY_ID": "gw-test", "M2M_ORIGINATOR": "Ctest", "M2M_CSE_ID": "test-cse",
            "M2M_RVI": "3", "M2M_CSE_URL": "https://127.0.0.1:1", "PC_API_URL": "https://127.0.0.1:1",
            "TLS_CA_FILE": str(self.root / "ca"), "TLS_CERT_FILE": str(self.root / "cert"),
            "TLS_KEY_FILE": str(self.root / "key"), "MQTT_ENABLED": "false",
            "BLE_DEVICES": json.dumps({"kr-test": "00:00:00:00:00:01"}),
            "GATEWAY_DATABASE": str(self.path), "M2M_OBSERVATION_CONTAINER": BINDING["observationContainer"],
            "M2M_RECEIPT_CONTAINER": BINDING["receiptContainer"], "M2M_HEALTH_CONTAINER": BINDING["healthContainer"],
        }
        self.write_env()

    def write_env(self):
        self.env_file.write_text("".join(f"{k}={v}\n" for k, v in self.values.items()), encoding="utf-8")

    def cli(self, output=None, operation="snapshot", *, database=None, selection=()):
        if database is not None:
            self.values["GATEWAY_DATABASE"] = str(database)
            self.write_env()
        installed = os.environ.get("KEYRING_TEST_STATE_CLI")
        args = [sys.executable, installed] if installed else [sys.executable, "-m", "bubble_gateway.state_archive"]
        output_arg = [] if output is None else ["--output", str(output)]
        return subprocess.run([*args, operation, "--env-file", str(self.env_file), *output_arg, *selection],
                              capture_output=True, text=True, encoding="utf-8", timeout=8)

    def populate(self):
        cmd = command()
        self.store.accept(cmd, payload_hash(cmd))
        self.store.begin_dispatch(cmd)
        self.store.observation(BINDING["observationContainer"], observation(), core_enabled=True)

    def rows(self, db=None):
        db = db or self.store.db
        return {name: [tuple(row) for row in db.execute(f"SELECT * FROM {name}")]
                for name in DATA_TABLES}

    def fact(self, **values):
        print("POSIX_FACT " + json.dumps({"test": self._testMethodName, **values}, sort_keys=True), flush=True)

    def test_prepare_cutover_carries_core_counter_without_transferring_source_rows(self):
        self.check_core_cutover("gw-test")

    def test_prepare_cutover_carries_device_counter_across_gateway_id_change(self):
        self.check_core_cutover("gw-next")

    def check_core_cutover(self, target_gateway):
        self.populate()
        target_path, target_env = self.root / "target.sqlite3", self.root / "target.env"
        values = dict(self.values, GATEWAY_ID=target_gateway, GATEWAY_DATABASE=str(target_path), M2M_CSE_DEPLOYMENT_ID="target-cse",
                      MQTT_ENABLED="true", MQTT_HOST="broker.invalid", M2M_MQTT_ENABLED="false", CORE_BRIDGE_ENABLED="true")
        target_env.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")
        selection = ("--target-env-file", str(target_env))
        plan = self.cli(operation="plan-cutover", selection=selection)
        self.assertEqual(plan.returncode, 0, plan.stderr)
        self.assertEqual(json.loads(plan.stdout)["coreSequenceContinuity"],
                         {"deviceCount": 1, "pendingForTargetScope": 1, "exhaustedDeviceCount": 0})
        blocked = self.cli(operation="prepare-cutover", selection=selection)
        self.assertEqual(blocked.returncode, 1, blocked.stdout)
        self.assertIn("STATE_CUTOVER_CORE_SCOPE_PENDING", blocked.stderr)
        self.assertFalse(target_path.exists())

        rqi = self.store.db.execute("SELECT rqi FROM outbox WHERE container='@core/telemetry'").fetchone()[0]
        self.store.delivered(rqi)
        before = self.rows()
        prepared = self.cli(operation="prepare-cutover", selection=selection)
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        self.assertEqual(json.loads(prepared.stdout)["coreSequencesSeeded"], 1)
        self.assertEqual(stat.S_IMODE(target_path.stat().st_mode), 0o600)
        with closing(readonly(target_path)) as db:
            binding = metadata(db)["binding"]
            self.assertEqual(binding["cseDeploymentId"], "target-cse")
            self.assertEqual(binding["gatewayId"], target_gateway)
            self.assertEqual(self.rows(db), {name: [("kr-test", 0)] if name == "core_sequences" else [] for name in DATA_TABLES})
        again = self.cli(operation="prepare-cutover", selection=selection)
        self.assertIn("STATE_CUTOVER_TARGET_PATH_IN_USE", again.stderr)
        target_config = config(target_path)
        target_config.cse_deployment_id = "target-cse"
        target_config.gateway_id = target_gateway
        self.assertEqual(binding, configured_binding(target_config))
        with closing(Store(target_path, 100, 5000000, 20, binding)) as store:
            store.observation(BINDING["observationContainer"], observation(gatewayId=target_gateway, sequence=2),
                              core_enabled=True)
            payload = store.db.execute("SELECT payload FROM outbox WHERE container='@core/telemetry'").fetchone()[0]
            self.assertEqual(json.loads(payload)["sequence"], 1)
        self.assertEqual(self.rows(), before)

    def test_snapshot_keeps_committed_wal_and_owner_only_permissions(self):
        self.populate()
        self.assertGreater(self.path.with_name(self.path.name + "-wal").stat().st_size, 0)
        before = self.rows()
        output = self.root / "snapshot"
        result = self.cli(output)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((output / "manifest.json").read_text())
        snapshot = output / "gateway.sqlite3"
        with closing(readonly(snapshot)) as db:
            self.assertEqual(self.rows(db), before)
            self.assertEqual(metadata(db)["recovery_state"], "QUARANTINED")
        self.assertEqual(self.rows(), before)
        modes = {p.name: oct(stat.S_IMODE(p.stat().st_mode))
                 for p in (output, snapshot, output / "manifest.json")}
        self.assertEqual(modes, {"snapshot": "0o700", "gateway.sqlite3": "0o600", "manifest.json": "0o600"})
        self.assertEqual(manifest["files"][0]["sha256"], hashlib.sha256(snapshot.read_bytes()).hexdigest())
        self.fact(walCommittedRowsPreserved=True, sourceRowsUnchanged=True, modes=modes,
                  archiveRecoveryState="QUARANTINED", realDirectoryFsync=True)

    def test_cli_and_daemon_refuse_other_process_lock(self):
        self.populate()
        before = self.rows()
        lock = self.path.with_suffix(".lock")
        script = "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()"
        child = subprocess.Popen([sys.executable, "-c", script, str(lock)], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([child.stdout], [], [], 5)[0], "lock holder did not become ready")
            self.assertEqual(child.stdout.readline().strip(), "locked")
            output = self.root / "locked-snapshot"
            result = self.cli(output)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("BlockingIOError", result.stderr)
            installed = os.environ.get("KEYRING_TEST_STATE_CLI")
            args = ([sys.executable, str(Path(installed).with_name("bubble-gateway"))] if installed
                    else [sys.executable, "-m", "bubble_gateway"])
            daemon = subprocess.run([*args, "--env-file", str(self.env_file)], capture_output=True,
                                    text=True, encoding="utf-8", timeout=8)
            self.assertEqual(daemon.returncode, 1, daemon.stdout + daemon.stderr)
            self.assertIn("BlockingIOError", daemon.stderr)
            self.assertFalse(output.exists())
            self.assertEqual(self.rows(), before)
        finally:
            child.communicate(timeout=5)  # stdin EOF releases only this test child's lock.
        self.assertEqual(child.returncode, 0)
        self.fact(realOtherProcessFlock=True, snapshotExit=1, daemonEntryExit=1,
                  daemonServeStarted=False, outputCreated=False, sourceRowsUnchanged=True)

    def test_cli_adopt_preserves_rows_and_quarantines_snapshot(self):
        self.populate()
        self.store.db.execute("DROP TABLE gateway_state")
        self.store.db.commit()
        before = self.rows()
        output = self.root / "adopt"
        result = self.cli(output, "adopt")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rows(), before)
        self.assertEqual(metadata(self.store.db)["recovery_state"], "LIVE")
        self.assertTrue(json.loads((output / "adoption.json").read_text())["bindingAdded"])
        with closing(readonly(output / "gateway.sqlite3")) as db:
            self.assertEqual(metadata(db)["recovery_state"], "QUARANTINED")
            self.assertEqual(self.rows(db), before)
        self.fact(sourceRowsUnchanged=True, sourceIdentityState="LIVE", bindingAdded=True,
                  snapshotRecoveryState="QUARANTINED", realDirectoryFsync=True)

    def test_identity_mismatch_refused_before_output(self):
        self.populate()
        before = self.rows()
        self.values["GATEWAY_ID"] = "foreign-gateway"
        self.write_env()
        output = self.root / "foreign"
        result = self.cli(output)
        self.assertEqual(result.returncode, 1)
        self.assertIn("STATE_IDENTITY_MISMATCH", result.stderr)
        self.assertFalse(output.exists())
        self.assertEqual(self.rows(), before)
        self.fact(sourceRowsUnchanged=True, outputCreated=False, exitCode=1)

    def test_retire_core_archives_only_the_selected_old_epoch(self):
        self.populate()
        container = BINDING["observationContainer"]
        self.store.observation(container, observation(sequence=2), core_enabled=True, core_epochs={"kr-test": 7})
        self.store.observation(container, observation(sequence=3), core_enabled=True, core_epochs={"kr-test": 9})
        self.values.update(MQTT_ENABLED="true", MQTT_HOST="127.0.0.1", CORE_BRIDGE_ENABLED="true",
                           CORE_TELEMETRY_EPOCHS='{"kr-test":9}')
        self.write_env()
        before = self.rows()
        selection = ("--device-id", "kr-test", "--retired-epoch")
        refused = self.root / "refuse-current"
        denied = self.cli(refused, "retire-core", selection=(*selection, "9"))
        self.assertEqual(denied.returncode, 1, denied.stdout + denied.stderr)
        self.assertIn("STATE_RETIRED_CORE_SCOPE_INVALID", denied.stderr)
        self.assertFalse(refused.exists())
        self.assertEqual(self.rows(), before)

        output = self.root / "retired"
        result = self.cli(output, "retire-core", selection=(*selection, "7"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        retired_id = Store.request_id("core-telemetry", "kr-test:boot-test:2")
        self.assertEqual(self.rows(), {**before, "outbox": [row for row in before["outbox"] if row[0] != retired_id]})
        with closing(readonly(output / "gateway.sqlite3")) as db:
            self.assertEqual(self.rows(db), before)
            self.assertEqual(metadata(db)["recovery_state"], "QUARANTINED")
        prepared = json.loads((output / "retirement-plan.json").read_text())
        completed = json.loads((output / "retirement.json").read_text())
        self.assertEqual((prepared["status"], completed["status"]), ("PREPARED", "RETIRED"))
        self.assertEqual((completed["retiredEpoch"], completed["configuredEpoch"], completed["rowCount"]), (7, 9, 1))
        self.assertEqual(completed["rowsSha256"], prepared["rowsSha256"])
        self.fact(archivedRowsPreserved=True, onlySelectedEpochRemoved=True, currentEpochRefused=True)

    def test_quarantined_copy_cannot_be_opened_or_archived(self):
        self.populate()
        output = self.root / "quarantined"
        self.assertEqual(self.cli(output).returncode, 0)
        snapshot = output / "gateway.sqlite3"
        before = snapshot.read_bytes()
        with self.assertRaisesRegex(StateIdentityError, "STATE_RECOVERY_QUARANTINED"):
            Store(snapshot, 100, 100000, 20, BINDING)
        second = self.root / "no-reactivation"
        result = self.cli(second, database=snapshot)
        self.assertEqual(result.returncode, 1)
        self.assertIn("STATE_RECOVERY_QUARANTINED", result.stderr)
        self.assertFalse(second.exists())
        self.assertEqual(snapshot.read_bytes(), before)
        self.fact(archiveCannotLaunch=True, archiveCannotBeRearchivedAsLive=True, snapshotUnchanged=True)

    def test_real_full_filesystem_retains_partial_output(self):
        limited = Path(os.environ["KEYRING_TEST_SMALL_FS"])
        self.assertLessEqual(os.statvfs(limited).f_blocks * os.statvfs(limited).f_frsize, 1048576)
        temp = tempfile.TemporaryDirectory(prefix="keyring-full-test-", dir=limited)
        self.addCleanup(temp.cleanup)
        parent = Path(temp.name)
        observed_errno = None
        with (parent / "fill").open("wb", buffering=0) as fill:
            try:
                while True:
                    fill.write(b"x" * 16384)
            except OSError as exc:
                observed_errno = exc.errno
        self.assertEqual(observed_errno, errno.ENOSPC)
        self.populate()
        before = self.rows()
        output = parent / "partial"
        result = self.cli(output)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(output.is_dir())
        self.assertFalse((output / "manifest.json").exists())
        self.assertFalse((output / "adoption.json").exists())
        self.assertEqual(self.rows(), before)
        self.fact(realEnospcErrno=observed_errno, exitCode=1, partialOutputRetained=True,
                  completedManifest=False, sourceRowsUnchanged=True)

    def test_copy_deadline_retains_partial_output_without_manifest(self):
        self.populate()
        before = self.rows()
        output = self.root / "deadline"
        with self.assertRaises(TimeoutError):
            state_archive.archive(self.cfg, output, adopt=False, timeout=-1)
        self.assertTrue(output.is_dir())
        self.assertFalse((output / "manifest.json").exists())
        self.assertEqual(self.rows(), before)
        self.fact(apiExpiredDeadline=True, partialOutputRetained=True, completedManifest=False,
                  sourceRowsUnchanged=True)

    def test_existing_output_and_symlink_never_overwritten(self):
        self.populate()
        output = self.root / "existing"
        output.mkdir()
        sentinel = output / "keep"
        sentinel.write_bytes(b"synthetic sentinel")
        self.assertEqual(self.cli(output).returncode, 2)
        link = self.root / "link"
        link.symlink_to(output, target_is_directory=True)
        self.assertEqual(self.cli(link).returncode, 2)
        self.assertEqual(sentinel.read_bytes(), b"synthetic sentinel")
        self.assertEqual(list(output.iterdir()), [sentinel])
        self.fact(existingOutputExit=2, symlinkExit=2, targetUnchanged=True)

    def test_legacy_hash_mismatch_refused_before_output(self):
        self.populate()
        self.store.db.execute("DROP TABLE gateway_state")
        self.store.db.execute("UPDATE commands SET payload_hash=?", ("0" * 64,))
        self.store.db.commit()
        before = self.rows()
        output = self.root / "invalid-legacy"
        result = self.cli(output, "adopt")
        self.assertEqual(result.returncode, 1)
        self.assertIn("STATE_LEGACY_COMMAND_MISMATCH", result.stderr)
        self.assertFalse(output.exists())
        self.assertIsNone(metadata(self.store.db))
        self.assertEqual(self.rows(), before)
        self.fact(invalidHashRefused=True, bindingAdded=False, outputCreated=False, sourceRowsUnchanged=True)

    def test_adoption_detects_other_process_write_after_durable_snapshot(self):
        self.populate()
        self.store.db.execute("DROP TABLE gateway_state")
        self.store.db.commit()
        output = self.root / "race"
        real_sync = state_archive._sync_directory
        changed = False

        def after_real_sync(path):
            nonlocal changed
            real_sync(path)  # Do not replace directory fsync with a mock.
            if not changed:
                changed = True
                script = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE fences SET epoch=epoch+1'); c.commit(); c.close()"
                subprocess.run([sys.executable, "-c", script, str(self.path)], check=True, timeout=5)

        with patch.object(state_archive, "_sync_directory", side_effect=after_real_sync):
            with self.assertRaisesRegex(StateIdentityError, "STATE_CHANGED_DURING_ARCHIVE"):
                state_archive.archive(self.cfg, output, adopt=True, timeout=5)
        self.assertTrue(changed)
        self.assertTrue((output / "manifest.json").is_file())
        self.assertFalse((output / "adoption.json").exists())
        self.assertIsNone(metadata(self.store.db))
        self.assertEqual(self.store.db.execute("SELECT epoch FROM fences").fetchone()[0], 3)
        with closing(readonly(output / "gateway.sqlite3")) as db:
            self.assertEqual(metadata(db)["recovery_state"], "QUARANTINED")
            self.assertEqual(db.execute("SELECT epoch FROM fences").fetchone()[0], 2)
        self.fact(realOtherProcessWrite=True, realDirectoryFsync=True, adoptionRefused=True,
                  sourceIdentityAdded=False, sourceEpoch=3, snapshotEpoch=2, snapshotRecoveryState="QUARANTINED")
