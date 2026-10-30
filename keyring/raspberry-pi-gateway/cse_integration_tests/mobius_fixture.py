"""Disposable real Mobius4 stack: fresh tmpfs DB, private network, no existing data."""
import asyncio
import json
import os
import secrets
import time
import uuid
from pathlib import Path

from mqtt_fixture import DockerBroker, docker


class DisposableMobius:
    label = "privacy-bubble.cse-test-token"
    admin, cse_id = "Skeyring-fixture", "Mobius4"

    def __init__(self, pki):
        self.pki, self.token = pki, uuid.uuid4().hex
        self.network, self.broker, self.containers = None, None, {}
        self.password = secrets.token_hex(16)
        self.images = {name: docker("image", "inspect", tag, "--format", "{{.Id}}").stdout.strip()
                       for name, tag in {"postgres": "postgis/postgis:17-3.5",
                                         "cse": "privacy-bubble-keyring-mobius4:local",
                                         "proxy": "nginx:1.28-alpine"}.items()}
        try:
            self.network = docker("network", "create", "--label", f"{self.label}={self.token}",
                                  "keyring-cse-test-" + self.token).stdout.strip()
            self.check_network()
            self.broker = DockerBroker(pki, network=self.network, originator=self.admin,
                                       cse_id=self.cse_id, internal_listener=True)
            self.run("postgres", ["--user", "999:999", "--read-only", "--cap-drop", "ALL", "--memory", "512m",
                "--tmpfs", "/var/lib/postgresql/data:rw,size=256m,uid=999,gid=999,mode=0700",
                "--tmpfs", "/var/run/postgresql:rw,size=16m,uid=999,gid=999,mode=0700",
                "--tmpfs", "/tmp:rw,size=16m", "-e", "POSTGRES_DB=keyring_test", "-e", "POSTGRES_USER=keyring_test",
                "-e", "POSTGRES_PASSWORD=" + self.password])
            deadline = time.monotonic() + 30
            while True:
                self.check("postgres")
                if docker("exec", self.containers["postgres"], "pg_isready", "-h", "127.0.0.1", "-U", "keyring_test", "-d", "keyring_test", check=False).returncode == 0:
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError("fresh test PostgreSQL did not become ready")
                time.sleep(0.2)
            env = dict(CSE_ADMIN=self.admin, CSE_ID="/" + self.cse_id, CSE_BASE_RN="Mobius", CSE_TYPE="1",
                       HTTP_PORT="7599", HTTPS_ENABLED="false", DB_HOST="postgres", DB_PORT="5432",
                       DB_NAME="keyring_test", DB_USER="keyring_test", DB_PW=self.password,
                       MQTT_ENABLED="true", MQTT_HOST="broker", MQTT_PORT="1883", LOG_LEVEL="info")
            source_root = Path(__file__).resolve().parents[2]
            specialization = source_root / "dev/mobius4/specializations.json"
            self.run("cse", ["--network-alias", "mobius4", "--read-only", "--cap-drop", "ALL", "--memory", "512m",
                "--tmpfs", "/var/lib/mobius4:rw,size=16m,uid=1000,gid=1000,mode=0700", "--tmpfs", "/tmp:rw,size=16m",
                "--mount", f"type=bind,source={specialization.as_posix()},target=/app/config/specializations.json,readonly",
                *[part for key, value in env.items() for part in ("-e", key + "=" + value)]])
            template = (source_root / "dev/mobius4/nginx.conf.template").read_text(encoding="utf-8")
            self.proxy_config = pki.root / "cse-proxy.conf"
            self.proxy_config.write_text("log_format keyring_test '$request_method $uri $http_x_m2m_ri';\n" +
                template.replace("CN=keyring-dev-gateway", "CN=gw-test").replace("${CSE_ADMIN}", self.admin)
                        .replace("/etc/nginx/keyring-tls/ca.pem", "/etc/nginx/keyring-tls/trusted.pem")
                        .replace("access_log off;", "access_log /dev/stdout keyring_test;"), encoding="utf-8")
            self.run("proxy", ["--read-only", "--memory", "64m", "--tmpfs", "/var/cache/nginx:rw,size=16m",
                "--tmpfs", "/var/run:rw,size=16m", "-p", "127.0.0.1::8759",
                "--mount", f"type=bind,source={pki.root.as_posix()},target=/etc/nginx/keyring-tls,readonly",
                "--mount", f"type=bind,source={self.proxy_config.as_posix()},target=/etc/nginx/conf.d/default.conf,readonly",
                "--entrypoint", "nginx"], ["-g", "daemon off;"])
            info = self.check("proxy")
            if not info["State"]["Running"]:
                raise RuntimeError("test proxy did not start: " + self.logs("proxy"))
            port = info["NetworkSettings"]["Ports"]["8759/tcp"]
            if len(port) != 1 or port[0]["HostIp"] != "127.0.0.1":
                raise RuntimeError("test CSE HTTPS port is not loopback-only")
            self.origin = "https://127.0.0.1:" + port[0]["HostPort"]
        except BaseException:
            try:
                self.save_failure_logs()
            finally:
                self.close()
            raise

    def save_failure_logs(self):
        output = os.environ.get("KEYRING_TEST_CSE_LOG_DIR")
        if output:
            root = Path(output) / ("startup-failure-" + self.token)
            root.mkdir(parents=True, exist_ok=True)
            for name in self.containers:
                (root / (name + ".log")).write_text(self.logs(name), encoding="utf-8")

    def run(self, name, flags, command=()):
        self.check_network()
        result = docker("run", "-d", "--pull", "never", "--name", f"keyring-cse-test-{name}-{self.token}",
                        "--network", self.network, "--network-alias", name, "--label", f"{self.label}={self.token}",
                        *flags, self.images[name], *command)
        self.containers[name] = result.stdout.strip()
        self.check(name)

    def check_network(self):
        data = json.loads(docker("network", "inspect", self.network).stdout)[0]
        if data["Labels"].get(self.label) != self.token:
            raise RuntimeError("test network ownership mismatch")

    def check(self, name):
        data = json.loads(docker("container", "inspect", self.containers[name]).stdout)[0]
        if data["Config"]["Labels"].get(self.label) != self.token:
            raise RuntimeError("refusing to operate on a container not owned by this test")
        return data

    def logs(self, name):
        self.check(name)
        result = docker("logs", self.containers[name])
        return (result.stdout + result.stderr).replace(self.password, "[test-db-password]")

    def restart_cse(self):
        self.check("cse")
        docker("restart", "--time", "1", self.containers["cse"])

    def stop_cse(self):
        self.check("cse")
        docker("stop", "--time", "1", self.containers["cse"])

    def start_cse(self):
        self.check("cse")
        docker("start", self.containers["cse"])

    def close(self):
        errors = []
        for name in list(reversed(self.containers)):
            try:
                self.check(name)
                docker("rm", "--force", "--volumes", self.containers[name])
                del self.containers[name]
            except Exception as exc:
                errors.append(exc)
        if self.broker:
            try:
                self.broker.close()
                self.broker = None
            except Exception as exc:
                errors.append(exc)
        if self.network and not self.containers and not self.broker:
            self.check_network()
            docker("network", "rm", self.network)
            self.network = None
        if errors:
            raise RuntimeError("owned test stack cleanup failed") from errors[0]
