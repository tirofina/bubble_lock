"""Fresh test-only PKI and loopback HTTPS server. Never reads deployment secrets."""
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class TestPki:
    def __init__(self):
        self.openssl = os.environ.get("KEYRING_TEST_OPENSSL") or shutil.which("openssl")
        if not self.openssl:
            raise RuntimeError("TLS tests require OpenSSL; set KEYRING_TEST_OPENSSL to its executable")
        self.temp = tempfile.TemporaryDirectory(prefix="keyring-tls-test-")
        self.root = Path(self.temp.name)
        self.config = self.root / "openssl.cnf"
        self.config.write_text("[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=keyring-test\n", encoding="ascii")
        try:
            for ca in ("trusted", "rogue"):
                self.run("req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                         "-keyout", self.path(ca, "key"), "-out", self.path(ca), "-subj", f"/CN=keyring-{ca}-test-ca",
                         "-config", self.config, "-addext", "basicConstraints=critical,CA:TRUE",
                         "-addext", "keyUsage=critical,keyCertSign,cRLSign")
            self.leaf("server", "trusted", 2, "serverAuth", "127.0.0.1")
            self.leaf("wrong-name", "trusted", 3, "serverAuth", "127.0.0.2")
            self.leaf("client", "trusted", 4, "clientAuth")
            self.leaf("rogue-client", "rogue", 5, "clientAuth")
        except BaseException:
            self.close()
            raise

    def path(self, name, suffix="pem"):
        return self.root / f"{name}.{suffix}"

    def run(self, *args):
        subprocess.run([self.openssl, *map(str, args)], check=True, capture_output=True, timeout=15)

    def leaf(self, name, ca, serial, purpose, ip=None):
        self.run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", self.path(name, "key"),
                 "-out", self.path(name, "csr"), "-subj", "/CN=" + ("gw-test" if purpose == "clientAuth" else name),
                 "-config", self.config)
        extension = ("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                     f"extendedKeyUsage={purpose}\n" + (f"subjectAltName=IP:{ip}\n" if ip else ""))
        self.path(name, "ext").write_text(extension, encoding="ascii")
        self.run("x509", "-req", "-in", self.path(name, "csr"), "-CA", self.path(ca), "-CAkey", self.path(ca, "key"),
                 "-set_serial", serial, "-days", "1", "-out", self.path(name), "-extfile", self.path(name, "ext"))

    def close(self):
        self.temp.cleanup()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def respond(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        self.server.records.append(dict(method=self.command, path=self.path, headers=dict(self.headers),
                                        body=json.loads(raw) if raw else None,
                                        tls=self.connection.version(), peer=self.connection.getpeercert()))
        status = 302 if self.server.redirect else 201
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "2")
        self.send_header("Connection", "close")
        self.send_header("X-M2M-RI", self.headers.get("X-M2M-RI", ""))
        self.send_header("X-M2M-RSC", "2001")
        if self.server.redirect:
            self.send_header("Location", self.server.origin + "/must-not-follow")
        self.end_headers()
        self.wfile.write(b"{}")
        self.close_connection = True

    do_POST = respond
    do_GET = respond


class LoopbackTlsServer:
    def __init__(self, pki, *, certificate="server", tls12=False, redirect=False):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2 if tls12 else ssl.TLSVersion.TLSv1_3
        if tls12:
            context.maximum_version = ssl.TLSVersion.TLSv1_2
        context.verify_mode = ssl.CERT_REQUIRED
        context.load_verify_locations(cafile=str(pki.path("trusted")))
        context.load_cert_chain(str(pki.path(certificate)), str(pki.path(certificate, "key")))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.records, self.server.redirect = [], redirect
        self.origin = self.server.origin = f"https://127.0.0.1:{self.server.server_port}"
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    @property
    def records(self):
        return self.server.records

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise RuntimeError("loopback TLS test server did not stop")
