"""Exercise the deployment gate in disposable system units on an isolated Linux host."""
import argparse
import configparser
import grp
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import uuid
from zipfile import ZipFile

PACKAGE = Path(__file__).resolve().parents[1]
UNIT = PACKAGE / "deploy/privacy-bubble-gateway.service"
MARKER = "KEYRING_MAIN_REACHED"
SANDBOX = ("NoNewPrivileges", "ProtectSystem", "ProtectHome", "PrivateTmp", "PrivateDevices",
           "ProtectKernelTunables", "ProtectKernelModules", "ProtectControlGroups", "RestrictSUIDSGID",
           "LockPersonality", "CapabilityBoundingSet", "RestrictAddressFamilies", "UMask", "StateDirectoryMode")


def prepare(scratch, wheel):
    os.chmod(scratch, 0o755)
    package = scratch / "src/bubble_gateway"
    package.mkdir(parents=True)
    source = PACKAGE / "src/bubble_gateway"
    with ZipFile(wheel) as archive:
        for path in source.glob("*.py"):
            content = archive.read("bubble_gateway/" + path.name)
            if content.replace(b"\r\n", b"\n") != path.read_bytes().replace(b"\r\n", b"\n"):
                raise RuntimeError(f"wheel does not match source: {path.name}")
            (package / path.name).write_bytes(content)
        entrypoints, = (name for name in archive.namelist() if name.endswith(".dist-info/entry_points.txt"))
        if "bubble-gateway = bubble_gateway.__main__:main" not in archive.read(entrypoints).decode():
            raise RuntimeError("wheel has a different entry point")
    for name in ("ca", "client", "other"):
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", f"/CN=keyring-preflight-{name}", "-keyout", str(scratch / f"{name}.key"),
                        "-out", str(scratch / f"{name}.pem")], check=True, capture_output=True, timeout=15)
    gid = grp.getgrnam("nogroup").gr_gid
    for name in ("ca.pem", "client.pem", "client.key", "other.key"):
        os.chown(scratch / name, 0, gid)
        os.chmod(scratch / name, 0o640)


def exercise(scratch, service, case, output):
    name = "keyring-preflight-" + uuid.uuid4().hex[:12]
    state = Path("/var/lib") / name
    if state.exists() or state.is_symlink():
        raise RuntimeError("test state directory already exists")
    outside = scratch / "outside.sqlite3"
    values = {
        "GATEWAY_ID": "gw-test", "M2M_ORIGINATOR": "Ctest", "M2M_CSE_ID": "Mobius4", "M2M_RVI": "4",
        "M2M_CSE_URL": "https://127.0.0.1:9", "PC_API_URL": "https://127.0.0.1:9",
        "M2M_OBSERVATION_CONTAINER": "/test/obs", "M2M_RECEIPT_CONTAINER": "/test/receipts",
        "M2M_HEALTH_CONTAINER": "/test/health", "MQTT_ENABLED": "false",
        "BLE_DEVICES": "'{\"kr-test\":\"00:00:00:00:00:01\"}'",
        "GATEWAY_DATABASE": outside if case == "outside-state" else state / "gateway.sqlite3",
        "TLS_CA_FILE": scratch / "ca.pem", "TLS_CERT_FILE": scratch / "client.pem",
        "TLS_KEY_FILE": scratch / ("other.key" if case == "mismatched-key" else "client.key"),
        "PYTHONPATH": scratch / "src", "PYTHONDONTWRITEBYTECODE": "1",
    }
    envfile = scratch / f"{case}.env"
    envfile.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="ascii")
    os.chown(envfile, 0, grp.getgrnam("nogroup").gr_gid)
    os.chmod(envfile, 0o640)
    preflight = shlex.split(service["ExecStartPre"])[1:]
    if preflight != ["--check-config"]:
        raise RuntimeError("unexpected deploy preflight arguments")
    args = ["systemd-run", "--quiet", "--wait", "--collect", "--pipe", f"--unit={name}",
            "-p", "User=nobody", "-p", "Group=nogroup", "-p", f"WorkingDirectory={scratch}",
            "-p", f"EnvironmentFile={envfile}", "-p", f"StateDirectory={name}",
            "-p", f"ReadWritePaths={state}", "-p", "ExecStartPre=/usr/bin/python3 -m bubble_gateway --check-config"]
    for key in SANDBOX:
        args += ["-p", f"{key}={service[key]}"]
    try:
        completed = subprocess.run([*args, "/usr/bin/printf", MARKER], capture_output=True, text=True, timeout=20)
        log = completed.stderr + completed.stdout + "\n"
        (output / f"{case}.log").write_text(log, encoding="utf-8")
        created = any(state.iterdir()) or outside.exists() or outside.with_suffix(".lock").exists()
        reached = MARKER in completed.stdout
        expected = {"valid": "Gateway configuration check passed", "mismatched-key": "TLS file check failed (SSLError)",
                    "outside-state": "inside STATE_DIRECTORY"}[case]
        if (expected not in log or reached != (case == "valid") or
                (completed.returncode == 0) != (case == "valid") or created):
            raise RuntimeError(f"{case}: wrong preflight outcome; inspect its log")
        return {"case": case, "systemdExit": completed.returncode, "mainReached": reached,
                "stateFilesCreated": created}
    finally:
        subprocess.run(["systemctl", "stop", name + ".service"], capture_output=True, timeout=8)
        if state.exists():
            state.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or Path("/proc/1/comm").read_text().strip() != "systemd":
        parser.error("requires root on an isolated Linux host running systemd")
    args.output.mkdir()
    config = configparser.ConfigParser(interpolation=None, strict=False)
    config.optionxform = str
    config.read(UNIT, encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="keyring-preflight-", dir="/run") as directory:
        scratch = Path(directory)
        prepare(scratch, args.wheel)
        results = [exercise(scratch, config["Service"], case, args.output)
                   for case in ("valid", "mismatched-key", "outside-state")]
    receipt = {"systemd": subprocess.check_output(["systemctl", "--version"], text=True).splitlines()[0],
               "wheelSha256": hashlib.sha256(args.wheel.read_bytes()).hexdigest(), "cases": results}
    (args.output / "facts.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
