"""Linux entry point; holds an advisory lock for the lifetime of the gateway."""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
from dataclasses import replace
from pathlib import Path

from .config import DeploymentConfigError, GatewayConfig, check_state_directory, read_env_file, tls_context
from .model import iso_time, validate_credential_status
from .state_identity import StateIdentityError


async def serve(config: GatewayConfig) -> None:
    from .service import Gateway
    gateway = Gateway(config)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, gateway.stop.set)
    await gateway.run()


async def check_command_route(config: GatewayConfig) -> dict:
    import httpx
    from .transport import RemoteResponseError, TransportHub

    if config.receipt_container_ri is None:
        raise DeploymentConfigError("M2M_RECEIPT_CONTAINER_RI is required for this check")
    hub = TransportHub(replace(config, mqtt_enabled=False, m2m_mqtt_enabled=False, core_bridge_enabled=False))
    stage = "mTLS initialization"
    try:
        await hub.start()
        stage = "CSE receipt parent lookup"
        pin = await hub.verify_receipt_route()
        stage = "central credential status"
        credential = validate_credential_status(await hub.credential_status(), config.gateway_id)
        if credential["status"] != "ACTIVE":
            raise DeploymentConfigError("Central Gateway credential is not ACTIVE")
        stage = "central command list"
        if await hub.poll_commands():
            raise DeploymentConfigError("Central Gateway command list is not empty")
        return {"gatewayId": config.gateway_id, "checkedAt": iso_time(), "receiptContainerRi": pin,
                "credentialStatus": "ACTIVE", "activeCommands": 0}
    except DeploymentConfigError:
        raise
    except (RemoteResponseError, httpx.HTTPError, OSError, ValueError) as exc:
        raise DeploymentConfigError(f"{stage} failed ({type(exc).__name__})") from None
    finally:
        await hub.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Privacy Bubble Raspberry Pi Gateway")
    parser.add_argument("--env-file", type=Path)
    checks = parser.add_mutually_exclusive_group()
    checks.add_argument("--check-config", action="store_true", help="Check local config and TLS files without starting the Gateway")
    checks.add_argument("--check-command-route", action="store_true", help="Check the pinned CSE and central API with HTTPS GET")
    parser.add_argument("--log-level", choices=("DEBUG", "INFO", "WARNING", "ERROR"), default="INFO")
    args = parser.parse_args()
    os.umask(0o077)
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # HTTP library debug logging may contain protocol headers. Keep it quiet even at DEBUG.
    for name in ("httpx", "httpcore", "bleak"):
        logging.getLogger(name).setLevel(logging.WARNING)
    try:
        if args.env_file:
            read_env_file(args.env_file)
        config = GatewayConfig.from_env()
        check_state_directory(config.database)
        if args.check_config:
            try:
                tls_context(config)
            except OSError as exc:
                raise DeploymentConfigError(f"TLS file check failed ({type(exc).__name__})") from None
            logging.getLogger(__name__).info("Gateway configuration check passed")
            return
        if args.check_command_route:
            report = asyncio.run(check_command_route(config))
            print(json.dumps(report, separators=(",", ":")))
            return
        import fcntl
        config.database.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with config.database.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            asyncio.run(serve(config))
    except KeyboardInterrupt:
        pass
    except DeploymentConfigError as exc:
        logging.getLogger(__name__).error("Gateway configuration blocked: %s", str(exc))
        raise SystemExit(1) from None
    except StateIdentityError as exc:
        logging.getLogger(__name__).error("Gateway state blocked: %s; see STATE_RECOVERY.md", str(exc))
        raise SystemExit(1) from None
    except Exception as exc:
        # Do not dump environment, certificates, command payloads or raw HTTP bodies.
        logging.getLogger(__name__).error("Gateway stopped: %s", type(exc).__name__)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
