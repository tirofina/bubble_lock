"""Prepare and explicitly start a dedicated Pi session for the scoped Feather command bench."""
import argparse
import json
import os
from pathlib import Path
import re
import ssl
import stat
import sys

GATEWAY_SOURCE = Path(__file__).resolve().parents[1] / "src"
PARENT = "/Mobius/privacy-bubble-test-ae"
CSE_DEPLOYMENT = "scoped-mobius4"


def require_private(path, kind):
    info = path.lstat()
    if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Bench settings, state and client key must be private owner files")
    return path


def load_tls(directory):
    require_private(directory, stat.S_ISDIR)
    ca = directory / "ca.pem"
    cert = directory / "gateway-a.pem"
    key = require_private(directory / "gateway-a.key", stat.S_ISREG)
    context = ssl.create_default_context(cafile=str(ca))
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(cert, key)
    return ca, cert, key


def gateway_environment(profile, session):
    if profile.get("version") != 1 or not re.fullmatch(r"(?:[0-9A-F]{2}:){5}[0-9A-F]{2}", profile["address"]):
        raise ValueError("Expected one paired Feather address")
    cse, api = profile["csePort"], profile["apiPort"]
    if any(type(port) is not int or not 1024 <= port <= 65535 for port in (cse, api)) or cse == api:
        raise ValueError("Use two different unprivileged Pi loopback ports")
    tls = Path(profile["tlsDirectory"])
    if not tls.is_absolute():
        raise ValueError("Expected an absolute client TLS directory")
    ca, cert, key = load_tls(tls)
    environment = {
        "PATH": os.defpath, "PYTHONPATH": str(GATEWAY_SOURCE), "STATE_DIRECTORY": str(session),
        "GATEWAY_ID": "gw-a", "M2M_CSE_ID": "Mobius4", "M2M_RVI": "4",
        # The scoped TLS proxy maps the verified client to its local CSE originator.
        "M2M_ORIGINATOR": "Sscoped-feather-gateway-a", "M2M_CSE_URL": f"https://127.0.0.1:{cse}",
        "PC_API_URL": f"https://127.0.0.1:{api}",
        "M2M_OBSERVATION_CONTAINER": f"{PARENT}/command-observations-a",
        "M2M_RECEIPT_CONTAINER": f"{PARENT}/command-receipts-a", "M2M_HEALTH_CONTAINER": f"{PARENT}/health",
        "TLS_CA_FILE": str(ca), "TLS_CERT_FILE": str(cert), "TLS_KEY_FILE": str(key),
        "BLE_DEVICES": json.dumps({"keyring-feather-lab": profile["address"]}),
        "BLE_PAIR": "true", "BLE_GATT_PROFILE": "core-v1", "FIRMWARE_REVISION_ALLOWLIST": "feather-probe-0.2.0",
        "MQTT_ENABLED": "false", "M2M_MQTT_ENABLED": "false", "CORE_BRIDGE_ENABLED": "false",
        "GATEWAY_DATABASE": str(session / "gateway.sqlite3"), "POLL_INTERVAL": "1", "REQUEST_TIMEOUT": "5",
    }
    if "cseDeploymentId" in profile:
        if profile["cseDeploymentId"] != CSE_DEPLOYMENT:
            raise ValueError("Expected the scoped Mobius4 deployment")
        environment["M2M_CSE_DEPLOYMENT_ID"] = profile["cseDeploymentId"]
    return environment


def prepare(args, session):
    address_file = require_private(args.address_file, stat.S_ISREG)
    with address_file.open(encoding="ascii") as stream:
        address = stream.read(32).strip().upper()
        if stream.read(1):
            raise ValueError("The address file must contain only one paired Feather address")
    profile = {"version": 1, "address": address, "tlsDirectory": str(args.tls_dir.absolute()),
               "csePort": args.cse_port, "apiPort": args.api_port, "cseDeploymentId": CSE_DEPLOYMENT}
    gateway_environment(profile, session)
    session.mkdir(mode=0o700)
    with (session / "profile.json").open("x", encoding="utf-8") as stream:
        json.dump(profile, stream)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    print(f"SCOPED_FEATHER_SESSION_PREPARED {session.name}")


def run(root, session):
    import fcntl

    require_private(session, stat.S_ISDIR)
    profile_path = require_private(session / "profile.json", stat.S_ISREG)
    with profile_path.open(encoding="utf-8") as stream:
        profile = json.loads(stream.read(8193))
    fields = {"version", "address", "tlsDirectory", "csePort", "apiPort"}
    if not isinstance(profile, dict) or profile.keys() not in (fields, fields | {"cseDeploymentId"}):
        raise ValueError("Expected a prepared Feather command session")
    environment = gateway_environment(profile, session)
    with os.fdopen(os.open(root / "gateway.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Keep the bench-wide lock across exec in addition to the normal SQLite lock.
        os.set_inheritable(lock.fileno(), True)
        os.execve(sys.executable, [sys.executable, "-m", "bubble_gateway"], environment)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    setup = modes.add_parser("prepare", help="Create a private profile without starting the Gateway")
    setup.add_argument("--address-file", type=Path, required=True)
    setup.add_argument("--tls-dir", type=Path, required=True)
    setup.add_argument("--cse-port", type=int, default=8760)
    setup.add_argument("--api-port", type=int, default=8787)
    start = modes.add_parser("run", help="Start the Gateway for an explicitly prepared session")
    for mode in (setup, start):
        mode.add_argument("--session", required=True)
    args = parser.parse_args()
    if sys.platform != "linux" or os.getuid() == 0:
        parser.error("Use this bench as the unprivileged Pi user on Linux")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,47}", args.session):
        parser.error("Use a short session name containing letters, digits, underscores or hyphens")
    os.umask(0o077)
    root = Path.home() / ".local/state/privacy-bubble-feather-command"
    try:
        if args.mode == "prepare":
            root.mkdir(mode=0o700, parents=True, exist_ok=True)
            prepare(args, require_private(root, stat.S_ISDIR) / args.session)
        else:
            run(require_private(root, stat.S_ISDIR), root / args.session)
    except BlockingIOError:
        parser.exit(1, "A Feather command Gateway is already running for this Pi user.\n")
    except FileExistsError:
        parser.exit(1, "The session already exists. Use run to resume it or choose a new session name.\n")
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(1, f"Scoped Feather session blocked ({type(error).__name__}). Check the private profile and TLS files.\n")


if __name__ == "__main__":
    main()
