"""Isolated team API and Mobius4 for the Pi bench, command-free by default."""
import argparse
import asyncio
from contextlib import ExitStack
from copy import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import uuid
from zipfile import ZipFile

import httpx
from bubble_gateway.transport import RemoteResponseError, TransportHub
from helpers import config
from mobius_fixture import DisposableMobius
from pi_led_cycle import DEVICE, GATEWAY, GUARDIAN, SUBJECT, run_led_cycle
from tls_fixture import TestPki

REPO = Path(__file__).resolve().parents[3]


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def certificate_fingerprint(path):
    pem = path.read_text(encoding="ascii")
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest().upper()
    return ":".join(fingerprint[i:i + 2] for i in range(0, len(fingerprint), 2))


def start_api(cleanup, pki, team, output, *, led_cycle=False):
    launcher = team / "pc-mobius/scripts/run-integration-api.mjs"
    fingerprint = certificate_fingerprint(pki.path("client"))
    principals = [{"principalId": GATEWAY, "mtlsFingerprint": fingerprint, "scopes": []}]
    if led_cycle:
        principals.append({"principalId": GUARDIAN, "mtlsFingerprint": certificate_fingerprint(pki.path("guardian")),
                           "scopes": ["consent:write", "grant:write", "bubble:command"]})
    config_path = pki.root / "central.json"
    write_json(config_path, {
        "tls": {"key": str(pki.path("server", "key")), "cert": str(pki.path("server")),
                "ca": str(pki.path("trusted"))},
        "principals": principals,
        "gateways": [{"gatewayId": GATEWAY, "principalId": GATEWAY, "fingerprint": fingerprint,
                      "devices": {DEVICE: SUBJECT}, "credentialRevision": "1",
                      "ownershipEpoch": 0, "status": "ACTIVE"}],
    })
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    env = os.environ.copy()
    env.pop("NODE_OPTIONS", None)
    env.pop("NODE_PATH", None)
    env.update(PRIVACY_BUBBLE_API_CONFIG=str(config_path), PRIVACY_BUBBLE_INTEGRATION_PORT=str(port))
    log = cleanup.enter_context((output / "central.log").open("xb"))
    process = subprocess.Popen(["node", str(launcher)], cwd=team, env=env, stdin=subprocess.DEVNULL,
                               stdout=log, stderr=subprocess.STDOUT,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def stop():
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    cleanup.callback(stop)
    return process, f"https://127.0.0.1:{port}"


async def exercise(pki, stack, process, api, output, seconds, *, led_cycle=False):
    cfg = config()
    cfg.gateway_id, cfg.originator, cfg.cse_id, cfg.rvi = GATEWAY, stack.admin, stack.cse_id, "4"
    cfg.cse_url, cfg.api_url = stack.origin, api
    cfg.ca_file, cfg.cert_file, cfg.key_file = pki.path("trusted"), pki.path("client"), pki.path("client", "key")
    cfg.mqtt_enabled, cfg.core_bridge_enabled, cfg.request_timeout = False, False, 4.0
    hub = TransportHub(cfg)
    paths = {role: f"/Mobius/pi-daemon-{stack.token[:12]}-{role}" for role in ("observation", "receipt", "health")}

    async def cse(method, path, *, body=None):
        rqi = "pi-daemon-" + uuid.uuid4().hex
        headers = hub._m2m_headers(rqi, create=body is not None)
        if body is not None:
            headers["Content-Type"] = "application/json;ty=3"
        status, response, result = await hub._http_json(method, cfg.cse_url + path, headers=headers, body=body)
        return status, hub._response_rsc(status, response, rqi), result

    async def ready():
        async with asyncio.timeout(35):
            while True:
                if process.poll() is not None:
                    raise RuntimeError("isolated central API exited before readiness")
                try:
                    central = await hub.credential_status()
                    if central == {"gatewayId": GATEWAY, "credentialRevision": "1", "status": "ACTIVE"} and (
                            await cse("GET", "/Mobius"))[:2] == (200, 2000):
                        return
                except (httpx.TransportError, RemoteResponseError):
                    pass
                await asyncio.sleep(0.25)

    guardian = None
    await hub.start()
    try:
        await ready()
        if await hub.poll_commands() != []:
            raise RuntimeError("fresh bench central API unexpectedly has commands")
        for path in paths.values():
            code = await cse("POST", "/Mobius", body={"m2m:cnt": {"rn": path.rsplit("/", 1)[-1], "mni": 500}})
            if code[:2] != (201, 2001):
                raise RuntimeError("test container creation failed")
        archive_path = output / "pi-client.tgz"
        with tarfile.open(archive_path, "x:gz") as archive:
            for name in ("trusted.pem", "client.pem", "client.key"):
                source = pki.root / name
                item = archive.gettarinfo(str(source), arcname=name)
                item.mode = 0o600
                with source.open("rb") as stream:
                    archive.addfile(item, stream)
        write_json(output / "endpoints.json", {"central": api, "cse": stack.origin, "containers": paths,
                   "gatewayId": GATEWAY, "deviceId": DEVICE, "originator": cfg.originator, "cseId": cfg.cse_id})
        print("STACK_READY", flush=True)
        cycle_complete = False
        try:
            async with asyncio.timeout(seconds):
                if led_cycle:
                    guardian_cfg = copy(cfg)
                    guardian_cfg.cert_file, guardian_cfg.key_file = pki.path("guardian"), pki.path("guardian", "key")
                    guardian = TransportHub(guardian_cfg)
                    await guardian.start()
                    await run_led_cycle(guardian, cse, paths, output)
                    cycle_complete = True
                while not (output / "STOP").exists():
                    if process.poll() is not None:
                        raise RuntimeError("isolated central API exited during test")
                    await asyncio.sleep(0.25)
        except TimeoutError:
            if led_cycle and not cycle_complete:
                raise RuntimeError("No complete LED cycle was recorded before the bench timeout") from None

        counts = {}
        for role, path in paths.items():
            status, rsc, body = await cse("GET", path)
            if (status, rsc) != (200, 2000):
                raise RuntimeError("test container readback failed")
            counts[role] = body["m2m:cnt"]["cni"]
        facts = {"contentInstances": counts, "remainingCentralCommands": len(await hub.poll_commands())}
        if counts["observation"]:
            status, rsc, body = await cse("GET", paths["observation"] + "/la")
            if (status, rsc) != (200, 2000):
                raise RuntimeError("latest observation readback failed")
            obs = body["m2m:cin"]["con"]
            facts["latestObservation"] = {k: obs[k] for k in
                                          ("gatewayId", "deviceId", "bootId", "sequence", "firmwareRevision")}
        if counts["health"]:
            status, rsc, body = await cse("GET", paths["health"] + "/la")
            if (status, rsc) != (200, 2000):
                raise RuntimeError("latest health readback failed")
            health = body["m2m:cin"]["con"]
            facts["latestHealth"] = {k: health[k] for k in
                                     ("credentialStatus", "credentialRevision", "runtimeDigest", "uptimeSeconds",
                                      "commandCount", "outboxDepth", "devices", "counters")}
        write_json(output / "readback.json", facts)
    finally:
        try:
            if guardian is not None:
                await guardian.close()
        finally:
            await hub.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--team-ref", required=True)
    parser.add_argument("--seconds", type=int, default=600, choices=range(30, 1801), metavar="30..1800")
    parser.add_argument("--led-cycle", action="store_true", help="Enable explicit LED_ON and LED_OFF trigger files")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.is_relative_to(REPO):
        parser.error("--output must be outside the repository")
    os.umask(0o077)
    output.mkdir(mode=0o700)
    try:
        with ExitStack() as cleanup:
            team = Path(cleanup.enter_context(tempfile.TemporaryDirectory(prefix="keyring-team-api-")))
            revision = subprocess.check_output(
                ["git", "rev-parse", "--verify", "--end-of-options", args.team_ref + "^{commit}"],
                cwd=REPO, text=True).strip()
            archive = team / "team.zip"
            subprocess.run(["git", "archive", "--format=zip", f"--output={archive}", revision, "pc-mobius"],
                           cwd=REPO, check=True)
            with ZipFile(archive) as package:
                package.extractall(team)
            pki = TestPki()
            cleanup.callback(pki.close)
            if args.led_cycle:
                pki.leaf("guardian", "trusted", 7, "clientAuth", subject=GUARDIAN)
            server = pki.root / "cse-server"
            server.mkdir()
            for name in ("trusted.pem", "server.pem", "server.key"):
                shutil.copyfile(pki.root / name, server / name)
            stack = DisposableMobius(SimpleNamespace(root=server))
            cleanup.callback(stack.close)
            process, api = start_api(cleanup, pki, team, output, led_cycle=args.led_cycle)
            write_json(output / "fixture.json", {"teamRef": revision, "cseToken": stack.token,
                       "brokerToken": stack.broker.token, "images": stack.images | {"broker": stack.broker.image_id},
                       "ledCycleEnabled": args.led_cycle})
            asyncio.run(exercise(pki, stack, process, api, output, args.seconds, led_cycle=args.led_cycle))
        write_json(output / "cleanup.json", {"ownedStackClosed": True, "centralExited": process.poll() is not None})
        print("STACK_CLOSED", flush=True)
    finally:
        (output / "pi-client.tgz").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
