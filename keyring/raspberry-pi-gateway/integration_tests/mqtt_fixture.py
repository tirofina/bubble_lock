"""Opt-in MQTT wire fixtures using a cached image and test-owned containers only."""
import asyncio
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import uuid

import paho.mqtt.client as mqtt

REQUEST = "/oneM2M/req/Ctest/test-cse/json"
RESPONSE = "/oneM2M/resp/Ctest/test-cse/json"


def docker(*args, check=True):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, encoding="utf-8", timeout=20)
    if check and result.returncode:
        raise RuntimeError(f"test Docker command failed: {args[0]}: {result.stderr.strip()}")
    return result


class DockerBroker:
    label = "privacy-bubble.test-token"

    def __init__(self, pki, *, network=None, originator="Ctest", cse_id="test-cse", internal_listener=False):
        self.token, self.container = uuid.uuid4().hex, None
        image = os.environ.get("KEYRING_TEST_MQTT_IMAGE", "eclipse-mosquitto:2")
        # Resolve the cached image before starting; --pull never forbids network installs.
        self.image_id = docker("image", "inspect", image, "--format", "{{.Id}}").stdout.strip()
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", self.image_id):
            raise RuntimeError("cached Mosquitto image identity unavailable")
        self.config = pki.root / f"broker-{self.token}.conf"
        self.acl = pki.root / f"acl-{self.token}.txt"
        if any(re.fullmatch(r"[A-Za-z0-9._:-]+", value) is None for value in (originator, cse_id)):
            raise ValueError("test broker identities must be safe topic segments")
        request, response = f"/oneM2M/req/{originator}/{cse_id}/json", f"/oneM2M/resp/{originator}/{cse_id}/json"
        self.acl.write_text("user gw-test\n" + f"topic write {request}\ntopic read {response}\n"
                            "user cse-test\ntopic read /oneM2M/req/#\n" + f"topic write {RESPONSE}\n", encoding="ascii")
        uid = os.getuid() if hasattr(os, "getuid") else 0
        # Container root is used only when the private temporary PKI is root-owned
        # (including Docker Desktop). No deployment credentials are mounted.
        self.config.write_text(("user root\n" if uid == 0 else "") +
            "persistence false\nlog_dest stdout\nlog_type all\nper_listener_settings true\n" +
            ("listener 1883\nallow_anonymous true\n" if internal_listener else "") +
            "listener 8883\nallow_anonymous false\n"
            "cafile /mosquitto/test/trusted.pem\ncertfile /mosquitto/test/server.pem\n"
            "keyfile /mosquitto/test/server.key\nrequire_certificate true\nuse_identity_as_username true\n"
            f"tls_version tlsv1.3\nacl_file /mosquitto/test/{self.acl.name}\n", encoding="ascii")
        try:
            result = docker("run", "-d", "--pull", "never", "--name", "keyring-mqtt-test-" + self.token,
                            "--label", f"{self.label}={self.token}", "--read-only", "--cap-drop", "ALL",
                            "--security-opt", "no-new-privileges:true", "--memory", "128m", "--pids-limit", "64",
                            "--user", str(uid), "-p", "127.0.0.1::8883",
                            "--mount", f"type=bind,source={pki.root.as_posix()},target=/mosquitto/test,readonly",
                            *(["--network", network, "--network-alias", "broker"] if network else []),
                            "--entrypoint", "mosquitto", self.image_id, "-c", f"/mosquitto/test/{self.config.name}")
            self.container = result.stdout.strip()
            if not re.fullmatch(r"[0-9a-f]{64}", self.container):
                raise RuntimeError("test container identity unavailable")
            info = self.inspect()
            if not info["State"]["Running"]:
                raise RuntimeError("test Mosquitto did not start: " + self.logs())
            ports = info["NetworkSettings"]["Ports"]["8883/tcp"]
            if len(ports) != 1 or ports[0]["HostIp"] != "127.0.0.1":
                raise RuntimeError("test MQTT port is not loopback-only")
            self.port = int(ports[0]["HostPort"])
        except BaseException:
            self.close()
            raise

    def inspect(self):
        info = json.loads(docker("container", "inspect", self.container).stdout)[0]
        if info["Config"]["Labels"].get(self.label) != self.token:
            raise RuntimeError("refusing to operate on a container without this test's ownership token")
        return info

    def logs(self):
        self.inspect()
        result = docker("logs", self.container)
        return result.stdout + result.stderr

    def stop(self):
        self.inspect()
        docker("stop", "--time", "1", self.container)

    def close(self):
        if self.container:
            self.inspect()
            docker("rm", "--force", self.container)
            self.container = None


class ProtocolResponder:
    """A synthetic oneM2M response peer, not a Mobius CSE or an authorization API."""
    def __init__(self, pki, loop):
        self.loop, self.ready, self.seen = loop, asyncio.Event(), asyncio.Event()
        self.requests, self.errors, self.rsc, self.wrong_rqi = [], [], 2001, False
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="cse-test-" + uuid.uuid4().hex,
                                  clean_session=True, protocol=mqtt.MQTTv311)
        context = ssl.create_default_context(cafile=str(pki.path("trusted")))
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.load_cert_chain(str(pki.path("cse")), str(pki.path("cse", "key")))
        self.client.tls_set_context(context)
        self.client.connect_timeout = 2
        self.client.on_connect = self.connected
        self.client.on_subscribe = lambda *_: self.signal(self.ready)
        self.client.on_message = self.message

    def signal(self, event):
        if not self.loop.is_closed():
            self.loop.call_soon_threadsafe(event.set)

    def connected(self, client, _user, _flags, reason, _properties):
        if reason != 0:
            self.errors.append("test responder connection denied")
            return
        client.subscribe("/oneM2M/req/#", qos=1)

    def message(self, client, _user, message):
        try:
            wire = json.loads(message.payload)
            request = wire.get("m2m:rqp", wire)
            self.requests.append(dict(topic=message.topic, request=request))
            self.signal(self.seen)
            if self.rsc is not None:
                response = dict(rqi="different-request" if self.wrong_rqi else request["rqi"],
                                rsc=self.rsc, fr="test-cse", to="Ctest")
                client.publish(RESPONSE, json.dumps(response), qos=1, retain=False)
        except Exception as exc:
            self.errors.append(type(exc).__name__)

    async def start(self, port):
        await asyncio.to_thread(self.client.connect, "127.0.0.1", port, 10)
        self.client.loop_start()
        await asyncio.wait_for(self.ready.wait(), 5)
        if self.errors:
            raise RuntimeError(self.errors[0])

    async def close(self):
        await asyncio.to_thread(self.client.disconnect)
        await asyncio.to_thread(self.client.loop_stop)
