"""Unit tests for the independent Python TS-0023 binarySwitch client (tools/onem2m-sdt-client)."""

import contextlib
import importlib.util
import io
import json
import pathlib
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLIENT = ROOT / "tools" / "onem2m-sdt-client" / "sdt_client.py"
XSD = ROOT / "pc-mobius" / "specializations" / "r4" / "binarySwitch-r4-profile.xsd"
spec = importlib.util.spec_from_file_location("sdt_client", CLIENT)
sdt_client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdt_client)
CND = sdt_client.BINARY_SWITCH_CND


class StubCse(BaseHTTPRequestHandler):
    """CSE double: discovery with cnd filter, flexContainer GET/PUT, RI echo."""
    resources: dict = {}
    requests: list = []
    break_echo = False
    string_state = False

    def log_message(self, *_):
        pass

    def answer(self, status, rsc, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-M2M-RSC", str(rsc))
        self.send_header("X-M2M-RI", "wrong" if self.break_echo else self.headers["X-M2M-RI"])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def record(self, body=None):
        StubCse.requests.append({"method": self.command, "path": self.path, "origin": self.headers["X-M2M-Origin"],
                                 "rvi": self.headers["X-M2M-RVI"], "contentType": self.headers.get("Content-Type"), "body": body})

    def do_GET(self):
        self.record()
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        if query:
            if query.get("fu") != ["1"] or query.get("ty") != ["28"]:
                return self.answer(400, 4000, {"m2m:dbg": "filter"})
            uris = [path.lstrip("/") for path in self.resources] if query.get("cnd") == [CND] else []
            return self.answer(200, 2000, {"m2m:uril": uris})
        if url.path not in self.resources:
            return self.answer(404, 4004, {"m2m:dbg": "not found"})
        state = "false" if self.string_state else self.resources[url.path]
        return self.answer(200, 2000, {"cod:binSh": {"rn": "binarySwitch", "ty": 28, "cnd": CND, "state": state}})

    def do_PUT(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.record(body)
        path = urllib.parse.urlsplit(self.path).path
        if path.endswith("/locked"):
            return self.answer(403, 4103, {"m2m:dbg": "no privilege"})
        if set(body) != {"cod:binSh"} or not isinstance(body["cod:binSh"].get("state"), bool):
            return self.answer(400, 4000, {"m2m:dbg": "bad request"})
        self.resources[path] = body["cod:binSh"]["state"]
        return self.answer(200, 2004, {"cod:binSh": {"state": self.resources[path]}})


class PythonSdtClientTest(unittest.TestCase):
    def setUp(self):
        StubCse.resources = {"/Mobius/kr-A/binarySwitch": False, "/Mobius/kr-B/binarySwitch": True, "/Mobius/kr-C/locked": False}
        StubCse.requests = []
        StubCse.break_echo = False
        StubCse.string_state = False
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), StubCse)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.endpoint = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.contract = sdt_client.SdtContract.from_xsd(str(XSD))
        self.client = sdt_client.BinarySwitchClient(sdt_client.OneM2mHttpClient(self.endpoint, "CpyClient"), self.contract)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_contract_comes_from_public_xsd(self):
        self.assertEqual(self.contract.envelope, "cod:binSh")
        self.assertEqual(self.contract.state_attribute, "state")
        self.assertIs(self.contract.state_type, bool)
        self.assertEqual(self.contract.namespace, "http://www.onem2m.org/xml/protocols/commondomain")
        self.assertEqual(self.contract.encode(True), {"cod:binSh": {"state": True}})
        with self.assertRaises(sdt_client.ContractError):
            self.contract.encode(1)

    def test_discovery_read_and_toggle_follow_onem2m_http_binding(self):
        discovered = self.client.discover()
        self.assertEqual(discovered["uris"], sorted(StubCse.resources))
        self.assertEqual(discovered["filter"], {"fu": 1, "ty": 28, "cnd": CND})
        self.assertEqual(self.client.discover(cnd="urn:other")["uris"], [])
        self.assertIs(self.client.read_state("/Mobius/kr-B/binarySwitch")["state"], True)
        updated = self.client.set_state("/Mobius/kr-A/binarySwitch", True)
        self.assertEqual((updated["rsc"], updated["applied"], updated["readback"]), (2004, True, True))
        denied = self.client.set_state("/Mobius/kr-C/locked", True)
        self.assertEqual((denied["rsc"], denied["applied"]), (4103, False))
        put = [row for row in StubCse.requests if row["method"] == "PUT"][0]
        self.assertEqual(put["body"], {"cod:binSh": {"state": True}})
        self.assertEqual((put["origin"], put["rvi"], put["contentType"]), ("CpyClient", "4", "application/json"))

    def test_contract_violations_are_reported(self):
        StubCse.string_state = True
        with self.assertRaises(sdt_client.ContractError):
            self.client.read_state("/Mobius/kr-A/binarySwitch")
        StubCse.string_state = False
        StubCse.break_echo = True
        with self.assertRaises(sdt_client.ContractError):
            self.client.read_state("/Mobius/kr-A/binarySwitch")
        with self.assertRaises(ValueError):
            sdt_client.OneM2mHttpClient("http://example.com:7599", "C")

    def test_verify_command_toggles_and_restores(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = sdt_client.main(["--endpoint", self.endpoint, "--originator", "CpyClient", "--xsd", str(XSD), "verify", "--toggle", "/Mobius/kr-B/binarySwitch"])
        self.assertEqual(code, 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result["toggle"]["set"]["readback"], False)
        self.assertEqual(result["toggle"]["restore"]["readback"], True)
        self.assertEqual(result["unmatchedCnd"]["uris"], [])
        self.assertEqual(len(result["clientSHA256"]), 64)

    def test_client_source_is_independent_of_project_code(self):
        source = CLIENT.read_text(encoding="utf-8")
        imports = [line for line in source.splitlines() if line.startswith(("import ", "from "))]
        allowed = {"__future__", "argparse", "hashlib", "json", "sys", "urllib.error", "urllib.parse", "urllib.request", "uuid", "xml.etree.ElementTree"}
        for line in imports:
            module = line.split()[1]
            self.assertIn(module, allowed, line)


if __name__ == "__main__":
    unittest.main()
