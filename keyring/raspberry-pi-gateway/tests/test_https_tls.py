"""Real TLS and HTTP on owned loopback fixtures; no BLE or operational services."""
import hashlib
import json
import socket
import ssl
import unittest
from unittest.mock import patch

import httpx

from bubble_gateway.transport import RemoteResponseError, TransportHub
from helpers import config
from tls_fixture import LoopbackTlsServer, TestPki


class HttpsTlsTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.pki = TestPki()

    @classmethod
    def tearDownClass(cls):
        cls.pki.close()

    def server(self, **kwargs):
        server = LoopbackTlsServer(self.pki, **kwargs)
        self.addCleanup(server.close)
        return server

    async def hub(self, server, *, ca="trusted", client="client"):
        cfg = config()
        cfg.api_url = cfg.cse_url = server.origin
        cfg.mqtt_enabled, cfg.request_timeout = False, 1
        cfg.ca_file, cfg.cert_file, cfg.key_file = self.pki.path(ca), self.pki.path(client), self.pki.path(client, "key")
        hub = TransportHub(cfg)
        self.addAsyncCleanup(hub.close)
        await hub.start()
        return hub

    async def test_publish_uses_tls13_mtls_and_actual_onem2m_headers(self):
        server = self.server()
        hub = await self.hub(server)
        payload = {"synthetic": True, "label": "키링"}
        await hub.publish("tls-request", "/test/receipts", payload)
        self.assertEqual(len(server.records), 1)
        record = server.records[0]
        self.assertEqual(record["tls"], "TLSv1.3")
        subject = dict(item for group in record["peer"]["subject"] for item in group)
        self.assertEqual(subject["commonName"], "gw-test")
        headers = httpx.Headers(record["headers"])
        self.assertEqual(headers["X-M2M-Origin"], "Ctest")
        self.assertEqual(headers["X-M2M-RI"], "tls-request")
        self.assertEqual(headers["X-M2M-RVI"], "3")
        self.assertEqual(headers["Content-Type"], "application/json;ty=4")
        self.assertEqual((record["method"], record["path"]), ("POST", "/test/receipts"))
        cin = record["body"]["m2m:cin"]
        self.assertEqual(cin["con"], payload)
        self.assertEqual(cin["rn"], "gw-" + hashlib.sha256(b"tls-request").hexdigest())
        print("loopback evidence: TLSv1.3, verified test client CN=gw-test, matching oneM2M CREATE response", flush=True)

    async def test_untrusted_server_ca_is_rejected_before_http(self):
        server = self.server()
        hub = await self.hub(server, ca="rogue")
        with self.assertRaises(httpx.TransportError):
            await hub.publish("bad-ca", "/test/receipts", {})
        self.assertEqual(server.records, [])

    async def test_untrusted_client_is_rejected_before_http(self):
        server = self.server()
        hub = await self.hub(server, client="rogue-client")
        with self.assertRaises(httpx.TransportError):
            await hub.publish("bad-client", "/test/receipts", {})
        self.assertEqual(server.records, [])

    async def test_missing_client_certificate_is_rejected_before_http(self):
        server = self.server()
        context = ssl.create_default_context(cafile=str(self.pki.path("trusted")))
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        async with httpx.AsyncClient(verify=context, trust_env=False, timeout=1) as client:
            with self.assertRaises(httpx.TransportError):
                await client.get(server.origin + "/test")
        self.assertEqual(server.records, [])

    async def test_tls12_only_peer_is_rejected_without_downgrade(self):
        server = self.server(tls12=True)
        hub = await self.hub(server)
        with self.assertRaises(httpx.TransportError):
            await hub.publish("old-tls", "/test/receipts", {})
        self.assertEqual(server.records, [])

    async def test_server_ip_identity_mismatch_is_rejected_before_http(self):
        server = self.server(certificate="wrong-name")
        hub = await self.hub(server)
        with self.assertRaises(httpx.TransportError):
            await hub.publish("bad-name", "/test/receipts", {})
        self.assertEqual(server.records, [])

    async def test_redirect_is_not_followed(self):
        server = self.server(redirect=True)
        hub = await self.hub(server)
        with self.assertRaises(RemoteResponseError) as caught:
            await hub.credential_status()
        self.assertEqual(caught.exception.status_code, 302)
        self.assertEqual(len(server.records), 1)
        self.assertNotIn("must-not-follow", server.records[0]["path"])

    async def test_proxy_and_ca_environment_do_not_override_configured_tls(self):
        server = self.server()
        # Own the potential proxy socket so a regression cannot contact another service.
        with socket.socket() as proxy:
            proxy.bind(("127.0.0.1", 0))
            proxy.listen(1)
            proxy.settimeout(0.01)
            endpoint = f"http://127.0.0.1:{proxy.getsockname()[1]}"
            env = {key: endpoint for key in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")}
            env.update(NO_PROXY="", no_proxy="", SSL_CERT_FILE=str(self.pki.path("rogue")))
            with patch.dict("os.environ", env):
                hub = await self.hub(server)
                await hub.publish("configured-tls", "/test/receipts", {"synthetic": True})
            with self.assertRaises(TimeoutError):
                proxy.accept()
        self.assertEqual(len(server.records), 1)
