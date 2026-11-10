"""Test-only worker: exit after remote confirmation, before local queue confirmation."""
import asyncio
from collections import Counter
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

from bubble_gateway.service import Gateway
from bubble_gateway.store import Store
from bubble_gateway.transport import TransportHub


async def run(path):
    fixture = json.loads(Path(path).read_text(encoding="utf-8"))
    cfg = SimpleNamespace(**fixture["config"])
    store = Store(Path(fixture["database"]), 100, 100000, 20, fixture["binding"])
    hub = TransportHub(cfg)
    await hub.start()
    gateway = Gateway.__new__(Gateway)
    gateway.config, gateway.store, gateway.transport = cfg, store, hub
    gateway.stop, gateway.counters = asyncio.Event(), Counter()

    def interrupt_confirmation(rqi):
        if rqi != fixture["expectedRqi"]:
            raise AssertionError("unexpected test queue entry")
        print(json.dumps({"phase": "remote-confirmed-before-local-confirmation", "rqi": rqi}), flush=True)
        # Deliberate abrupt death of this test-owned subprocess, not daemon shutdown.
        # SQLite and the TLS connection are left for OS cleanup/WAL recovery.
        os._exit(73)

    store.delivered = interrupt_confirmation
    try:
        async with asyncio.timeout(8):
            await gateway._outbox_loop()
    finally:
        await hub.close()
        store.close()


if __name__ == "__main__":
    asyncio.run(run(sys.argv[1]))
