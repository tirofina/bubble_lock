"""Prepare and explicitly start a scoped Feather or r18 Gateway session on the Pi."""
import argparse
from contextlib import closing, contextmanager
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import stat
import sys
import tempfile

GATEWAY_SOURCE = Path(__file__).resolve().parents[1] / "src"
PARENT = "/Mobius/privacy-bubble-test-ae"
CSE_DEPLOYMENT = "scoped-mobius4"
API_PORTS = {"legacy": 8787, "integration": 8788, "r18": 8789}
INTEGRATION_TEAM_REVISION = "bc2a45dfcc014b7cdb0a57a03aca2c04ca8eb989"
DISPLAY_FIRMWARE = "feather-probe-0.2.1"
COMMAND_FIRMWARES = ("feather-probe-0.2.0", DISPLAY_FIRMWARE)
R18_COMMAND_FIRMWARE = "keyring-0.7.14"
R18_BRINGUP_FIRMWARES = ("keyring-0.7.15-bringup", "keyring-0.7.15-st7789-bringup", "keyring-0.7.15-jd9853-bringup")
R18_BOARD = "r18-hand-solder"
R18_DEVICE = "keyring-r18-lab"
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")


class ScopedApiError(ValueError):
    """The forwarded API could not be bound to the selected bench profile."""


def require_private(path, kind):
    info = path.lstat()
    if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Bench settings, state and client key must be private owner files")
    return path


def load_tls(directory, slot="a"):
    require_private(directory, stat.S_ISDIR)
    ca = directory / "ca.pem"
    cert = directory / f"gateway-{slot}.pem"
    key = require_private(directory / f"gateway-{slot}.key", stat.S_ISREG)
    context = ssl.create_default_context(cafile=str(ca))
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(cert, key)
    return ca, cert, key, context


def verify_integration_api(port, revision, context, *, mode="integration"):
    r18 = mode == "r18"
    gateway_id = "gw-b" if r18 else "gw-a"
    expected = {"status": "READY", "scope": "scoped-command-api", "mode": mode,
                "teamRevision": revision, "gatewayId": gateway_id, "deviceId": R18_DEVICE if r18 else "keyring-feather-lab",
                "features": ["dispatch-start", "receipts", "telemetry"]}
    if r18:
        expected.update(boardRevision=R18_BOARD, firmwareRevision=R18_COMMAND_FIRMWARE)
    try:
        with closing(http.client.HTTPSConnection("127.0.0.1", port, timeout=5, context=context)) as connection:
            connection.request("GET", f"/api/v1/gateways/{gateway_id}/bench-capabilities",
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
        raise ValueError("Expected one paired device address")
    cse, api = profile["csePort"], profile["apiPort"]
    if any(type(port) is not int or not 1024 <= port <= 65535 for port in (cse, api)) or cse == api:
        raise ValueError("Use two different unprivileged Pi loopback ports")
    mode = profile.get("apiMode", "legacy")
    if mode not in API_PORTS:
        raise ValueError("Unknown scoped API mode")
    r18 = mode == "r18"
    observe_only = profile.get("observeOnly", False)
    if type(observe_only) is not bool or (observe_only and not r18):
        raise ValueError("Observation-only sessions require r18 mode")
    slot = "b" if r18 else "a"
    device_id = R18_DEVICE if r18 else "keyring-feather-lab"
    revision = profile.get("apiTeamRevision", INTEGRATION_TEAM_REVISION)
    if (not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{40}", revision) is None
            or ("apiTeamRevision" in profile and mode == "legacy")):
        raise ValueError("Expected a full lowercase team revision for integration mode")
    tls = Path(profile["tlsDirectory"])
    if not tls.is_absolute():
        raise ValueError("Expected an absolute client TLS directory")
    ca, cert, key, context = load_tls(tls, slot)
    default_firmware = R18_COMMAND_FIRMWARE if r18 else COMMAND_FIRMWARES[0]
    if observe_only:
        default_firmware = R18_BRINGUP_FIRMWARES[0]
    firmware = profile.get("firmwareRevision", default_firmware)
    if observe_only and firmware not in R18_BRINGUP_FIRMWARES:
        raise ValueError("Expected an observation-only r18 bring-up firmware")
    if r18 and not observe_only and firmware != R18_COMMAND_FIRMWARE:
        raise ValueError("Expected the command-enabled r18 firmware")
    if not r18 and firmware not in COMMAND_FIRMWARES:
        raise ValueError("Unknown Feather command firmware")
    environment = {
        "PATH": os.defpath, "PYTHONPATH": str(GATEWAY_SOURCE), "STATE_DIRECTORY": str(session),
        "GATEWAY_ID": f"gw-{slot}", "M2M_CSE_ID": "Mobius4", "M2M_RVI": "4",
        # The scoped TLS proxy maps the verified client to its local CSE originator.
        "M2M_ORIGINATOR": "Sscoped-r18-gateway-b" if r18 else "Sscoped-feather-gateway-a",
        "M2M_CSE_URL": f"https://127.0.0.1:{cse}",
        "PC_API_URL": f"https://127.0.0.1:{api}",
        "M2M_OBSERVATION_CONTAINER": f"{PARENT}/command-observations-{slot}",
        "M2M_RECEIPT_CONTAINER": f"{PARENT}/command-receipts-{slot}",
        "M2M_HEALTH_CONTAINER": f"{PARENT}/{'command-health-b' if r18 else 'health'}",
        "TLS_CA_FILE": str(ca), "TLS_CERT_FILE": str(cert), "TLS_KEY_FILE": str(key),
        "BLE_DEVICES": json.dumps({device_id: profile["address"]}),
        "BLE_PAIR": "true", "BLE_GATT_PROFILE": "core-v1", "FIRMWARE_REVISION_ALLOWLIST": firmware,
        "MQTT_ENABLED": "false", "M2M_MQTT_ENABLED": "false", "CORE_BRIDGE_ENABLED": "false",
        "GATEWAY_DATABASE": str(session / "gateway.sqlite3"), "POLL_INTERVAL": "1", "REQUEST_TIMEOUT": "5",
        "HEARTBEAT_INTERVAL": "5",
    }
    if mode != "legacy":
        environment.update(PC_DISPATCH_START_REQUIRED="true", CENTRAL_RECEIPTS_ENABLED="true",
                           CENTRAL_TELEMETRY_ENABLED="true")
    if r18:
        environment.update(BLE_BOARD_REVISION=R18_BOARD, PC_API_DEPLOYMENT_ID="scoped-command-api-r18")
    if observe_only:
        environment.update(COMMANDS_ENABLED="false", PC_DISPATCH_START_REQUIRED="false", CENTRAL_RECEIPTS_ENABLED="false")
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
    if r18 and ("M2M_RECEIPT_CONTAINER_RI" not in environment or "M2M_OBSERVATION_CONTAINER_RI" not in environment
                or environment["M2M_RECEIPT_CONTAINER_RI"] == environment["M2M_OBSERVATION_CONTAINER_RI"]):
        raise ValueError("Expected distinct scoped r18 receipt and observation container IDs")
    if "pcApiDeploymentId" in profile:
        deployment = profile["pcApiDeploymentId"]
        if not isinstance(deployment, str) or not IDENTIFIER.fullmatch(deployment):
            raise ValueError("Expected a central API deployment ID")
        environment["PC_API_DEPLOYMENT_ID"] = deployment
    if verify_api and mode != "legacy":
        verify_integration_api(api, revision, context, mode=mode)
    return environment


def prepare(args, session):
    address_file = require_private(args.address_file, stat.S_ISREG)
    with address_file.open(encoding="ascii") as stream:
        address = stream.read(32).strip().upper()
        if stream.read(1):
            raise ValueError("The address file must contain only one paired device address")
    api_port = API_PORTS[args.api_mode] if args.api_port is None else args.api_port
    profile = {"version": 1, "address": address, "tlsDirectory": str(args.tls_dir.absolute()),
               "csePort": args.cse_port, "apiPort": api_port, "cseDeploymentId": CSE_DEPLOYMENT}
    if args.observe_only:
        profile["observeOnly"] = True
    if args.firmware_revision is not None:
        profile["firmwareRevision"] = args.firmware_revision
    if args.api_mode != "legacy":
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
    label = "SCOPED_R18_SESSION_PREPARED" if args.api_mode == "r18" else "SCOPED_FEATHER_SESSION_PREPARED"
    print(f"{label} {session.name}")


def load_environment(session, *, verify_api=True):
    require_private(session, stat.S_ISDIR)
    profile_path = require_private(session / "profile.json", stat.S_ISREG)
    with profile_path.open(encoding="utf-8") as stream:
        profile = json.loads(stream.read(8193))
    fields = {"version", "address", "tlsDirectory", "csePort", "apiPort"}
    optional = {"cseDeploymentId", "receiptContainerRi", "observationContainerRi", "pcApiDeploymentId",
                "apiMode", "apiTeamRevision", "firmwareRevision", "observeOnly"}
    if (not isinstance(profile, dict) or not fields <= profile.keys()
            or profile.keys() - fields - optional):
        raise ValueError("Expected a prepared command session")
    return gateway_environment(profile, session, verify_api=verify_api)


@contextmanager
def bench_lock(root):
    import fcntl

    with os.fdopen(os.open(root / "gateway.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield lock


def run(root, session):
    with bench_lock(root) as lock:
        environment = load_environment(session)
        # Keep the bench-wide lock across exec in addition to the normal SQLite lock.
        os.set_inheritable(lock.fileno(), True)
        os.execve(sys.executable, [sys.executable, "-m", "bubble_gateway"], environment)


def export_environment(session):
    environment = load_environment(session, verify_api=False)
    settings = {key: value for key, value in environment.items() if key not in {"PATH", "PYTHONPATH"}}
    for value in settings.values():
        if (value != value.strip() or any(char in value for char in "\r\n\x00")
                or (len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'")):
            raise ValueError("A prepared setting cannot be represented in a gateway env file")
    path = session / "gateway.env"
    descriptor, staged_name = tempfile.mkstemp(prefix=".gateway-env-", dir=session)
    staged = Path(staged_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            for key, value in settings.items():
                stream.write(f"{key}={value}\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        staged.unlink()
    return path


def capture_r18(root, session, output):
    with bench_lock(root) as lock:
        environment = load_environment(session, verify_api=False)
        devices = json.loads(environment["BLE_DEVICES"])
        if (environment["GATEWAY_ID"] != "gw-b" or environment.get("BLE_BOARD_REVISION") != R18_BOARD
                or environment["FIRMWARE_REVISION_ALLOWLIST"] != R18_COMMAND_FIRMWARE or set(devices) != {R18_DEVICE}):
            raise ValueError("The journal capture requires a prepared r18 session")
        os.set_inheritable(lock.fileno(), True)
        arguments = [sys.executable, "-m", "bubble_gateway.journal_cli", "--device-id", R18_DEVICE,
                     "--address", devices[R18_DEVICE], "--database", environment["GATEWAY_DATABASE"],
                     "--gatt-profile", environment["BLE_GATT_PROFILE"], "--board-revision", R18_BOARD,
                     "--firmware-revision", R18_COMMAND_FIRMWARE, "--output", str(output)]
        os.execve(sys.executable, arguments, environment)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    setup = modes.add_parser("prepare", help="Create a private profile without starting the Gateway")
    setup.add_argument("--address-file", type=Path, required=True)
    setup.add_argument("--tls-dir", type=Path, required=True)
    setup.add_argument("--cse-port", type=int, default=8760)
    setup.add_argument("--api-mode", choices=API_PORTS, default="legacy")
    setup.add_argument("--api-port", type=int, help="Override the selected API mode's Pi loopback port")
    setup.add_argument("--api-team-revision", help="Override the pinned full team commit for integration or r18")
    setup.add_argument("--firmware-revision", choices=(*COMMAND_FIRMWARES, R18_COMMAND_FIRMWARE, *R18_BRINGUP_FIRMWARES))
    setup.add_argument("--observe-only", action="store_true", help="Use an r18 bring-up image and disable command processing")
    setup.add_argument("--receipt-container-ri", help="Use the selected Gateway's receipt pin in a fresh session")
    setup.add_argument("--observation-container-ri", help="Use the selected Gateway's observation pin in a fresh session")
    setup.add_argument("--pc-api-deployment-id", help="Bind a fresh session to the chosen central datastore ID")
    start = modes.add_parser("run", help="Start the Gateway for an explicitly prepared session")
    check = modes.add_parser("preflight", help="Check pinned CSE containers and the central command route over mTLS")
    export = modes.add_parser("export-env", help="Create a private gateway.env from the saved session")
    capture = modes.add_parser("capture-r18", help="Capture the r18 device journal while the bench daemon is stopped")
    capture.add_argument("--output", type=Path, required=True, help="New private device archive directory")
    for mode in (setup, start, check, export, capture):
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
            session = require_private(root, stat.S_ISDIR) / args.session
            if args.mode == "preflight":
                environment = load_environment(session)
                os.execve(sys.executable, [sys.executable, "-m", "bubble_gateway", "--check-command-route"], environment)
            elif args.mode == "export-env":
                print(f"SCOPED_GATEWAY_ENV_EXPORTED {export_environment(session)}")
            elif args.mode == "capture-r18":
                capture_r18(root, session, args.output)
            else:
                run(root, session)
    except BlockingIOError:
        parser.exit(1, "A scoped command Gateway is already running for this Pi user.\n")
    except FileExistsError:
        parser.exit(1, "The requested session or output already exists. Use the existing file or choose a new output.\n")
    except ScopedApiError as error:
        parser.exit(1, f"Scoped central API check failed: {error}.\n")
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(1, f"Scoped command session blocked ({type(error).__name__}). Check the private profile and TLS files.\n")


if __name__ == "__main__":
    main()
