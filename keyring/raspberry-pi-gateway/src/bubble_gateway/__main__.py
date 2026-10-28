"""Linux entry point; holds an advisory lock for the lifetime of the gateway."""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
from pathlib import Path

from .config import GatewayConfig, read_env_file


async def serve(config: GatewayConfig) -> None:
    from .service import Gateway
    gateway = Gateway(config)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, gateway.stop.set)
    await gateway.run()


def main() -> None:
    parser = argparse.ArgumentParser(description="Privacy Bubble Raspberry Pi Gateway")
    parser.add_argument("--env-file", type=Path)
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
        import fcntl
        config.database.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with config.database.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            asyncio.run(serve(config))
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        # Do not dump environment, certificates, command payloads or raw HTTP bodies.
        logging.getLogger(__name__).error("Gateway stopped: %s", type(exc).__name__)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
