"""Prepare and explicitly start a dedicated Pi session for the scoped Feather command bench."""
import argparse
from contextlib import closing
import http.client
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
API_PORTS = {"legacy": 8787, "integration": 8788}
INTEGRATION_TEAM_REVISION = "bc2a45dfcc014b7cdb0a57a03aca2c04ca8eb989"
DISPLAY_FIRMWARE = "feather-probe-0.2.1"
COMMAND_FIRMWARES = ("feather-probe-0.2.0", DISPLAY_FIRMWARE)
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")


class ScopedApiError(ValueError):
    """The forwarded API could not be bound to the selected bench profile."""


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
    return ca, cert, key, context


def verify_integration_api(port, revision, context):
    expected = {"status": "READY", "scope": "scoped-command-api", "mode": "integration",
                "teamRevision": revision, "gatewayId": "gw-a", "deviceId": "keyring-feather-lab",
                "features": ["dispatch-start", "receipts", "telemetry"]}
    try:
        with closing(http.client.HTTPSConnection("127.0.0.1", port, timeout=5, context=context)) as connection:
            connection.request("GET", "/api/v1/gateways/gw-a/bench-capabilities",
                               headers={"Accept": "application/json", "Cache-Control": "no-store"})
            response = connection.getresponse()
            if response.status != 200:
                raise ScopedApiError("the forwarded port did not return the integration profile")
            body = response.read(4097)
            if len(body) > 4096 or json.loads(body) != expected:
                raise ScopedApiError("the forwarded API revision or capabilities differ from the prepared profile")
    except ScopedApiError:
        raise
    except (OSError, http.client.HTTPException, ValueError) as error:
        raise ScopedApiError(f"the integration profile could not be read ({type(error).__name__})") from None


def gateway_environment(profile, session, *, verify_api=False):
    if profile.get("version") != 1 or not re.fullmatch(r"(?:[0-9A-F]{2}:){5}[0-9A-F]{2}", profile["address"]):
        raise ValueError("Expected one paired Feather address")
    cse, api = profile["csePort"], profile["apiPort"]
    if any(type(port) is not int or not 1024 <= port <= 65535 for port in (cse, api)) or cse == api:
        raise ValueError("Use two different unprivileged Pi loopback ports")
    mode = profile.get("apiMode", "legacy")
    if mode not in API_PORTS:
        raise ValueError("Unknown scoped API mode")
    revision = profile.get("apiTeamRevision", INTEGRATION_TEAM_REVISION)
    if (not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{40}", revision) is None
            or ("apiTeamRevision" in profile and mode != "integration")):
        raise ValueError("Expected a full lowercase team revision for integration mode")
    tls = Path(profile["tlsDirectory"])
    if not tls.is_absolute():
        raise ValueError("Expected an absolute client TLS directory")
    ca, cert, key, context = load_tls(tls)
    firmware = profile.get("firmwareRevision", COMMAND_FIRMWARES[0])
    if firmware not in COMMAND_FIRMWARES:
        raise ValueError("Unknown Feather command firmware")
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
        "BLE_PAIR": "true", "BLE_GATT_PROFILE": "core-v1", "FIRMWARE_REVISION_ALLOWLIST": firmware,
        "MQTT_ENABLED": "false", "M2M_MQTT_ENABLED": "false", "CORE_BRIDGE_ENABLED": "false",
        "GATEWAY_DATABASE": str(session / "gateway.sqlite3"), "POLL_INTERVAL": "1", "REQUEST_TIMEOUT": "5",
        "HEARTBEAT_INTERVAL": "5",
    }
    if mode == "integration":
        environment.update(PC_DISPATCH_START_REQUIRED="true", CENTRAL_RECEIPTS_ENABLED="true",
                           CENTRAL_TELEMETRY_ENABLED="true")
    if "cseDeploymentId" in profile:
        if profile["cseDeploymentId"] != CSE_DEPLOYMENT:
            raise ValueError("Expected the scoped Mobius4 deployment")
        environment["M2M_CSE_DEPLOYMENT_ID"] = profile["cseDeploymentId"]
    for field, variable in (("receiptContainerRi", "M2M_RECEIPT_CONTAINER_RI"),
                            ("observationContainerRi", "M2M_OBSERVATION_CONTAINER_RI")):
        if field in profile:
            ri = profile[field]
            if profile.get("cseDeploymentId") != CSE_DEPLOYMENT or not isinstance(ri, str) or not IDENTIFIER.fullmatch(ri):
                raise ValueError(f"Expected a verified scoped resource ID for {field}")
            environment[variable] = ri
    if "pcApiDeploymentId" in profile:
        deployment = profile["pcApiDeploymentId"]
        if not isinstance(deployment, str) or not IDENTIFIER.fullmatch(deployment):
            raise ValueError("Expected a central API deployment ID")
        environment["PC_API_DEPLOYMENT_ID"] = deployment
    if verify_api and mode == "integration":
        verify_integration_api(api, revision, context)
    return environment


def prepare(args, session):
    address_file = require_private(args.address_file, stat.S_ISREG)
    with address_file.open(encoding="ascii") as stream:
        address = stream.read(32).strip().upper()
        if stream.read(1):
            raise ValueError("The address file must contain only one paired Feather address")
    api_port = API_PORTS[args.api_mode] if args.api_port is None else args.api_port
    profile = {"version": 1, "address": address, "tlsDirectory": str(args.tls_dir.absolute()),
               "csePort": args.cse_port, "apiPort": api_port, "cseDeploymentId": CSE_DEPLOYMENT,
               "firmwareRevision": args.firmware_revision}
    if args.api_mode == "integration":
        profile["apiMode"] = args.api_mode
        profile["apiTeamRevision"] = INTEGRATION_TEAM_REVISION if args.api_team_revision is None else args.api_team_revision
    elif args.api_team_revision is not None:
        raise ValueError("A team revision requires integration mode")
    if args.receipt_container_ri is not None:
        profile["receiptContainerRi"] = args.receipt_container_ri
    if args.observation_container_ri is not None:
        profile["observationContainerRi"] = args.observation_container_ri
    if args.pc_api_deployment_id is not None:
        profile["pcApiDeploymentId"] = args.pc_api_deployment_id
    gateway_environment(profile, session)
    session.mkdir(mode=0o700)
    with (session / "profile.json").open("x", encoding="utf-8") as stream:
        json.dump(profile, stream)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    print(f"SCOPED_FEATHER_SESSION_PREPARED {session.name}")


def load_environment(session):
    require_private(session, stat.S_ISDIR)
    profile_path = require_private(session / "profile.json", stat.S_ISREG)
    with profile_path.open(encoding="utf-8") as stream:
        profile = json.loads(stream.read(8193))
    fields = {"version", "address", "tlsDirectory", "csePort", "apiPort"}
    optional = {"cseDeploymentId", "receiptContainerRi", "observationContainerRi", "pcApiDeploymentId",
                "apiMode", "apiTeamRevision", "firmwareRevision"}
    if (not isinstance(profile, dict) or not fields <= profile.keys()
            or profile.keys() - fields - optional):
        raise ValueError("Expected a prepared Feather command session")
    return gateway_environment(profile, session, verify_api=True)


def run(root, session):
    import fcntl

    with os.fdopen(os.open(root / "gateway.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        environment = load_environment(session)
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
    setup.add_argument("--api-mode", choices=API_PORTS, default="legacy")
    setup.add_argument("--api-port", type=int, help="Override the selected API mode's Pi loopback port")
    setup.add_argument("--api-team-revision", help="Override the pinned full team commit for integration mode")
    setup.add_argument("--firmware-revision", choices=COMMAND_FIRMWARES, default=COMMAND_FIRMWARES[0])
    setup.add_argument("--receipt-container-ri", help="Use the scoped gw-a receipt pin in a fresh session")
    setup.add_argument("--observation-container-ri", help="Use the scoped gw-a observation pin in a fresh session")
    setup.add_argument("--pc-api-deployment-id", help="Bind a fresh session to the chosen central datastore ID")
    start = modes.add_parser("run", help="Start the Gateway for an explicitly prepared session")
    check = modes.add_parser("preflight", help="Check pinned CSE containers and the central command route over mTLS")
    for mode in (setup, start, check):
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
        elif args.mode == "preflight":
            require_private(root, stat.S_ISDIR)
            environment = load_environment(root / args.session)
            os.execve(sys.executable, [sys.executable, "-m", "bubble_gateway", "--check-command-route"], environment)
        else:
            run(require_private(root, stat.S_ISDIR), root / args.session)
    except BlockingIOError:
        parser.exit(1, "A Feather command Gateway is already running for this Pi user.\n")
    except FileExistsError:
        parser.exit(1, "The session already exists. Use run to resume it or choose a new session name.\n")
    except ScopedApiError as error:
        parser.exit(1, f"Scoped Feather central API check failed: {error}.\n")
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(1, f"Scoped Feather session blocked ({type(error).__name__}). Check the private profile and TLS files.\n")


if __name__ == "__main__":
    main()
