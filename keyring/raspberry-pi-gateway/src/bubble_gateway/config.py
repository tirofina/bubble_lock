"""Explicit configuration. No development credentials or insecure TLS fallback."""
from __future__ import annotations

import json
import os
import re
import ssl
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\Z")


def env_file_values(path: Path) -> dict[str, str]:
    """Read simple KEY=value files, without shell expansion or evaluation."""
    values: dict[str, str] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not sep or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValueError(f"Invalid environment entry at line {number}")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values.setdefault(key, value)
    return values


def read_env_file(path: Path) -> None:
    for key, value in env_file_values(path).items():
        os.environ.setdefault(key, value)


@dataclass(frozen=True)
class GatewayConfig:
    gateway_id: str
    originator: str
    cse_id: str
    cse_url: str
    api_url: str
    ca_file: Path
    cert_file: Path
    key_file: Path
    mqtt_host: str
    mqtt_port: int
    mqtt_enabled: bool
    mqtt_wrapped_primitive: bool
    mqtt_keepalive: int
    request_timeout: float
    rvi: str
    observation_container: str
    receipt_container: str
    health_container: str
    ble_devices: dict[str, str]
    ble_pair: bool
    ble_scan_seconds: float
    ble_command_timeout: float
    firmware_revision_allowlist: tuple[str, ...]
    database: Path
    poll_interval: float
    heartbeat_interval: float
    credential_check_interval: float
    credential_ttl: float
    max_outbox_rows: int
    max_outbox_bytes: int
    max_commands: int
    core_bridge_enabled: bool
    ble_gatt_profile: str
    core_telemetry_epochs: dict[str, int] | None = None
    m2m_mqtt_enabled: bool = True
    cse_deployment_id: str | None = None
    receipt_container_ri: str | None = None
    pc_dispatch_start_required: bool = False
    central_receipts_enabled: bool = False
    central_telemetry_enabled: bool = False
    central_telemetry_retention_seconds: float = 86400
    pc_api_deployment_id: str | None = None
    observation_container_ri: str | None = None
    ble_board_revision: str | None = None
    commands_enabled: bool = True

    @classmethod
    def from_env(cls, values: Mapping[str, str] | None = None, *, require_tls_files: bool = True) -> "GatewayConfig":
        env = os.environ if values is None else values

        def required(name: str) -> str:
            value = env.get(name, "").strip()
            if not value:
                raise ValueError(f"{name} must be configured")
            return value

        def identifier(name: str) -> str:
            value = required(name)
            if not ID.fullmatch(value):
                raise ValueError(f"{name} must be a single safe identifier (1..64 characters)")
            return value

        def number(name: str, default: str, minimum: float, maximum: float) -> float:
            value = float(env.get(name, default))
            if not minimum <= value <= maximum:
                raise ValueError(f"{name} out of range")
            return value

        def boolean(name: str, default: str) -> bool:
            value = env.get(name, default).lower()
            if value not in {"true", "false"}:
                raise ValueError(f"{name} must be true or false")
            return value == "true"

        def endpoint(name: str, origin_only: bool = False) -> str:
            value = required(name).rstrip("/")
            url = urlsplit(value)
            if (url.scheme != "https" or not url.hostname or url.username or url.password
                    or url.query or url.fragment or (origin_only and url.path)):
                raise ValueError(f"{name} must be an HTTPS {'origin' if origin_only else 'base URL'}")
            return value

        def secret_file(name: str) -> Path:
            path = Path(required(name)).expanduser()
            if not path.is_absolute() or (require_tls_files and not path.is_file()):
                raise ValueError(f"{name} must name an existing absolute file")
            return path

        def container(name: str) -> str:
            value = required(name)
            if (not value.startswith("/") or value.startswith("//")
                    or not re.fullmatch(r"/[A-Za-z0-9._~/-]+", value)
                    or any(part in {".", "..", ""} for part in value[1:].split("/"))):
                raise ValueError(f"{name} must be an absolute oneM2M resource path")
            return value

        devices = json.loads(required("BLE_DEVICES"))
        if (not isinstance(devices, dict) or not 1 <= len(devices) <= 32
                or any(not isinstance(k, str) or not ID.fullmatch(k)
                       or not isinstance(v, str) or not re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", v)
                       for k, v in devices.items())):
            raise ValueError("BLE_DEVICES must map 1..32 device IDs to Bluetooth MAC addresses")
        if len({v.upper() for v in devices.values()}) != len(devices):
            raise ValueError("One Bluetooth address cannot represent multiple devices")
        database = Path(required("GATEWAY_DATABASE")).expanduser()
        if not database.is_absolute():
            raise ValueError("GATEWAY_DATABASE must be absolute")
        pair = boolean("BLE_PAIR", "true")
        if not pair:
            raise ValueError("Secure pairing is required; BLE_PAIR=false is not supported")
        revisions = tuple(v.strip() for v in env.get("FIRMWARE_REVISION_ALLOWLIST", "").split(",") if v.strip())
        board_revision = env.get("BLE_BOARD_REVISION", "").strip() or None
        if board_revision is not None and not ID.fullmatch(board_revision):
            raise ValueError("BLE_BOARD_REVISION must be a single safe identifier")
        mqtt_enabled = boolean("MQTT_ENABLED", "true")
        m2m_mqtt_enabled = boolean("M2M_MQTT_ENABLED", str(mqtt_enabled).lower())
        core_bridge = boolean("CORE_BRIDGE_ENABLED", "false")
        if core_bridge and not mqtt_enabled:
            raise ValueError("CORE_BRIDGE_ENABLED requires MQTT_ENABLED=true")
        if m2m_mqtt_enabled and not mqtt_enabled:
            raise ValueError("M2M_MQTT_ENABLED requires MQTT_ENABLED=true")
        if mqtt_enabled and not (core_bridge or m2m_mqtt_enabled):
            raise ValueError("MQTT_ENABLED requires a CORE or oneM2M MQTT route")
        epochs = None
        if "CORE_TELEMETRY_EPOCHS" in env:
            epochs = json.loads(required("CORE_TELEMETRY_EPOCHS"))
            if (not core_bridge or not isinstance(epochs, dict) or epochs.keys() != devices.keys()
                    or any(type(epoch) is not int or not 0 <= epoch <= 2147483647 for epoch in epochs.values())):
                raise ValueError("CORE_TELEMETRY_EPOCHS requires CORE bridge and an epoch for every BLE device")
        profile = env.get("BLE_GATT_PROFILE", "core-v1")
        if profile not in {"core-v1", "keyring-v01"}:
            raise ValueError("BLE_GATT_PROFILE must be core-v1 or keyring-v01")
        deployment = identifier("M2M_CSE_DEPLOYMENT_ID") if "M2M_CSE_DEPLOYMENT_ID" in env else None
        pc_deployment = identifier("PC_API_DEPLOYMENT_ID") if "PC_API_DEPLOYMENT_ID" in env else None
        receipt_ri = identifier("M2M_RECEIPT_CONTAINER_RI") if "M2M_RECEIPT_CONTAINER_RI" in env else None
        observation_ri = identifier("M2M_OBSERVATION_CONTAINER_RI") if "M2M_OBSERVATION_CONTAINER_RI" in env else None
        if receipt_ri is not None and deployment is None:
            raise ValueError("M2M_RECEIPT_CONTAINER_RI requires M2M_CSE_DEPLOYMENT_ID")
        if observation_ri is not None and deployment is None:
            raise ValueError("M2M_OBSERVATION_CONTAINER_RI requires M2M_CSE_DEPLOYMENT_ID")
        observation_container = container("M2M_OBSERVATION_CONTAINER")
        receipt_container = container("M2M_RECEIPT_CONTAINER")
        health_container = container("M2M_HEALTH_CONTAINER")
        commands_enabled = boolean("COMMANDS_ENABLED", "true")
        if not commands_enabled and receipt_container in (observation_container, health_container):
            raise ValueError("Observation-only mode requires a separate receipt container")
        if (observation_container == receipt_container and observation_ri is not None
                and receipt_ri is not None and observation_ri != receipt_ri):
            raise ValueError("Shared observation and receipt container requires matching resource IDs")
        return cls(
            gateway_id=identifier("GATEWAY_ID"), originator=identifier("M2M_ORIGINATOR"),
            cse_id=identifier("M2M_CSE_ID"), cse_url=endpoint("M2M_CSE_URL", True),
            api_url=endpoint("PC_API_URL"), ca_file=secret_file("TLS_CA_FILE"),
            cert_file=secret_file("TLS_CERT_FILE"), key_file=secret_file("TLS_KEY_FILE"),
            mqtt_host=required("MQTT_HOST") if mqtt_enabled else "",
            mqtt_port=int(number("MQTT_PORT", "8883", 1, 65535)),
            mqtt_enabled=mqtt_enabled, m2m_mqtt_enabled=m2m_mqtt_enabled,
            mqtt_wrapped_primitive=boolean("MQTT_WRAPPED_PRIMITIVE", "false"),
            mqtt_keepalive=int(number("MQTT_KEEPALIVE", "60", 10, 600)),
            request_timeout=number("REQUEST_TIMEOUT", "10", 1, 60), rvi=required("M2M_RVI"),
            observation_container=observation_container, receipt_container=receipt_container,
            health_container=health_container,
            ble_devices=devices, ble_pair=pair,
            ble_scan_seconds=number("BLE_SCAN_SECONDS", "5", 1, 30),
            ble_command_timeout=number("BLE_COMMAND_TIMEOUT", "15", 1, 30),
            firmware_revision_allowlist=revisions, database=database,
            poll_interval=number("POLL_INTERVAL", "2", 0.5, 60),
            heartbeat_interval=number("HEARTBEAT_INTERVAL", "30", 5, 3600),
            credential_check_interval=number("CREDENTIAL_CHECK_INTERVAL", "15", 2, 60),
            credential_ttl=number("CREDENTIAL_TTL", "30", 5, 120),
            max_outbox_rows=int(number("MAX_OUTBOX_ROWS", "10000", 100, 1000000)),
            max_outbox_bytes=int(number("MAX_OUTBOX_BYTES", "33554432", 1048576, 1073741824)),
            max_commands=int(number("MAX_COMMANDS", "100000", 100, 10000000)),
            core_bridge_enabled=core_bridge, ble_gatt_profile=profile, core_telemetry_epochs=epochs,
            cse_deployment_id=deployment, receipt_container_ri=receipt_ri,
            pc_dispatch_start_required=boolean("PC_DISPATCH_START_REQUIRED", "false"),
            central_receipts_enabled=boolean("CENTRAL_RECEIPTS_ENABLED", "false"),
            central_telemetry_enabled=boolean("CENTRAL_TELEMETRY_ENABLED", "false"),
            central_telemetry_retention_seconds=number("CENTRAL_TELEMETRY_RETENTION_SECONDS", "86400", 1, 86400),
            pc_api_deployment_id=pc_deployment,
            observation_container_ri=observation_ri,
            ble_board_revision=board_revision,
            commands_enabled=commands_enabled,
        )


def tls_context(config: GatewayConfig) -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=str(config.ca_file))
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(str(config.cert_file), str(config.key_file))
    return context


class DeploymentConfigError(ValueError):
    """A diagnostic for deployment checks that does not include private values."""


def check_state_directory(database: Path) -> None:
    directory = os.getenv("STATE_DIRECTORY")
    if directory is None:
        return  # A foreground or bench run can choose a separate state root.
    state = Path(directory)
    if not state.is_absolute() or not state.is_dir():
        raise DeploymentConfigError("Expected one absolute STATE_DIRECTORY")
    root = state.resolve()
    lock = database.with_suffix(".lock")
    if database == lock:
        raise DeploymentConfigError("GATEWAY_DATABASE and its lock must be different files")
    for path in (database, lock):
        resolved = path.resolve()
        if (path.is_symlink() or (path.exists() and not path.is_file()) or
                resolved == root or not resolved.is_relative_to(root)):
            raise DeploymentConfigError("GATEWAY_DATABASE and its lock must be files inside STATE_DIRECTORY")
