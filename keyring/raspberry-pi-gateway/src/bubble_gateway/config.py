"""Explicit configuration. No development credentials or insecure TLS fallback."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\Z")


def read_env_file(path: Path) -> None:
    """Read simple KEY=value files, without shell expansion or evaluation."""
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

    @classmethod
    def from_env(cls) -> "GatewayConfig":
        def required(name: str) -> str:
            value = os.getenv(name, "").strip()
            if not value:
                raise ValueError(f"{name} must be configured")
            return value

        def identifier(name: str) -> str:
            value = required(name)
            if not ID.fullmatch(value):
                raise ValueError(f"{name} must be a single safe identifier (1..64 characters)")
            return value

        def number(name: str, default: str, minimum: float, maximum: float) -> float:
            value = float(os.getenv(name, default))
            if not minimum <= value <= maximum:
                raise ValueError(f"{name} out of range")
            return value

        def boolean(name: str, default: str) -> bool:
            value = os.getenv(name, default).lower()
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
            if not path.is_absolute() or not path.is_file():
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
        revisions = tuple(v.strip() for v in os.getenv("FIRMWARE_REVISION_ALLOWLIST", "").split(",") if v.strip())
        return cls(
            gateway_id=identifier("GATEWAY_ID"), originator=identifier("M2M_ORIGINATOR"),
            cse_id=identifier("M2M_CSE_ID"), cse_url=endpoint("M2M_CSE_URL", True),
            api_url=endpoint("PC_API_URL"), ca_file=secret_file("TLS_CA_FILE"),
            cert_file=secret_file("TLS_CERT_FILE"), key_file=secret_file("TLS_KEY_FILE"),
            mqtt_host=required("MQTT_HOST") if boolean("MQTT_ENABLED", "true") else "",
            mqtt_port=int(number("MQTT_PORT", "8883", 1, 65535)),
            mqtt_enabled=boolean("MQTT_ENABLED", "true"),
            mqtt_wrapped_primitive=boolean("MQTT_WRAPPED_PRIMITIVE", "false"),
            mqtt_keepalive=int(number("MQTT_KEEPALIVE", "60", 10, 600)),
            request_timeout=number("REQUEST_TIMEOUT", "10", 1, 60), rvi=required("M2M_RVI"),
            observation_container=container("M2M_OBSERVATION_CONTAINER"),
            receipt_container=container("M2M_RECEIPT_CONTAINER"),
            health_container=container("M2M_HEALTH_CONTAINER"),
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
        )
