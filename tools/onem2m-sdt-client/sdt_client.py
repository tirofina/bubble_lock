"""Independent oneM2M TS-0023 binarySwitch client, Python standard library only.

The client derives its wire format from the public contract alone:
  * the binarySwitch XSD profile (flexContainer element name, namespace prefix, state type), and
  * the TS-0023 ModuleClass containerDefinition org.onem2m.common.moduleclass.binarySwitch.
It shares no code with the project's JavaScript clients and speaks plain oneM2M HTTP binding
(TS-0009): X-M2M-Origin, X-M2M-RI, X-M2M-RVI, X-M2M-RSC.

Usage:
  py -3 sdt_client.py --endpoint http://127.0.0.1:7599 --originator CAE1 --xsd binarySwitch-r4-profile.xsd discover
  py -3 sdt_client.py ... read /Mobius/kr-A/binarySwitch
  py -3 sdt_client.py ... set /Mobius/kr-A/binarySwitch true
  py -3 sdt_client.py ... verify --toggle /Mobius/kr-B/binarySwitch
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET

BINARY_SWITCH_CND = "org.onem2m.common.moduleclass.binarySwitch"
FLEX_CONTAINER_TY = 28
XS = "http://www.w3.org/2001/XMLSchema"
XSD_TYPES = {"boolean": bool}


class ContractError(ValueError):
    """The CSE answer does not follow the published SDT contract."""


class SdtContract:
    """Wire contract for one flexContainer specialization, read from its XSD."""

    def __init__(self, envelope: str, state_attribute: str, state_type: type, namespace: str, cnd: str):
        self.envelope = envelope
        self.state_attribute = state_attribute
        self.state_type = state_type
        self.namespace = namespace
        self.cnd = cnd

    @classmethod
    def from_xsd(cls, path: str, cnd: str = BINARY_SWITCH_CND) -> "SdtContract":
        prefixes: dict[str, str] = {}
        for _event, (prefix, uri) in ET.iterparse(path, events=["start-ns"]):
            if prefix:
                prefixes.setdefault(uri, prefix)
        schema = ET.parse(path).getroot()
        target = schema.get("targetNamespace")
        prefix = prefixes.get(target)
        if not target or not prefix:
            raise ContractError("XSD targetNamespace requires a declared prefix")
        candidates = [element for element in schema.findall(f"{{{XS}}}element")
                      if (element.get("substitutionGroup") or "").endswith(":sg_flexContainerResource")]
        if len(candidates) != 1:
            raise ContractError("XSD requires exactly one flexContainer specialization element")
        specialization = candidates[0]
        children = [element for element in specialization.iter(f"{{{XS}}}element") if element is not specialization]
        if len(children) != 1:
            raise ContractError("binarySwitch profile requires exactly one custom attribute")
        attribute = children[0]
        declared = (attribute.get("type") or "").split(":")[-1]
        if declared not in XSD_TYPES:
            raise ContractError(f"unsupported XSD type {attribute.get('type')}")
        return cls(f"{prefix}:{specialization.get('name')}", attribute.get("name"), XSD_TYPES[declared], target, cnd)

    def encode(self, state: bool) -> dict:
        if type(state) is not self.state_type:
            raise ContractError(f"{self.state_attribute} requires {self.state_type.__name__}")
        return {self.envelope: {self.state_attribute: state}}

    def decode(self, payload: object) -> bool:
        if not isinstance(payload, dict) or set(payload) != {self.envelope} or not isinstance(payload[self.envelope], dict):
            raise ContractError(f"representation requires the {self.envelope} envelope")
        resource = payload[self.envelope]
        if resource.get("cnd") is not None and resource["cnd"] != self.cnd:
            raise ContractError("containerDefinition differs from the contract")
        value = resource.get(self.state_attribute)
        if type(value) is not self.state_type:
            raise ContractError(f"{self.state_attribute} is not {self.state_type.__name__}")
        return value


class OneM2mHttpClient:
    """Minimal oneM2M HTTP binding client."""

    def __init__(self, endpoint: str, originator: str, rvi: str = "4", timeout: float = 5.0):
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.scheme not in ("http", "https") or parsed.query or parsed.fragment or parsed.username:
            raise ValueError("endpoint requires http(s)://host:port")
        if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("remote CSE endpoints require https")
        if not originator:
            raise ValueError("originator is required")
        self.endpoint = endpoint.rstrip("/")
        self.originator = originator
        self.rvi = rvi
        self.timeout = timeout

    def request(self, method: str, path: str, body: dict | None = None, query: dict | None = None) -> dict:
        if not path.startswith("/") or any(part in ("..", ".") for part in path.split("/")) or "?" in path or "#" in path:
            raise ValueError("resource path must be an absolute CSE path")
        url = self.endpoint + urllib.parse.quote(path)
        if query:
            url += "?" + urllib.parse.urlencode(query)
        rqi = "py-sdt-" + uuid.uuid4().hex
        headers = {"Accept": "application/json", "X-M2M-Origin": self.originator, "X-M2M-RI": rqi, "X-M2M-RVI": self.rvi}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                status, reply_headers, raw = response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            status, reply_headers, raw = error.code, error.headers, error.read()
        if len(raw) > 2 * 1024 * 1024:
            raise ContractError("CSE response is too large")
        if reply_headers.get("X-M2M-RI") != rqi:
            raise ContractError("X-M2M-RI echo mismatch")
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else None
        except ValueError as error:
            raise ContractError("CSE answered non-JSON content") from error
        rsc = reply_headers.get("X-M2M-RSC")
        return {"status": status, "rsc": int(rsc) if rsc and rsc.isdigit() else None, "rqi": rqi, "payload": payload}


class BinarySwitchClient:
    """Discovery, state readback and state update for TS-0023 binarySwitch flexContainers."""

    def __init__(self, http: OneM2mHttpClient, contract: SdtContract, cse_base: str = "/Mobius"):
        self.http = http
        self.contract = contract
        self.cse_base = cse_base.rstrip("/")

    @staticmethod
    def absolute(uri: str) -> str:
        return uri if uri.startswith("/") else "/" + uri

    def discover(self, parent: str | None = None, cnd: str | None = None) -> dict:
        query = {"fu": 1, "ty": FLEX_CONTAINER_TY, "cnd": cnd or self.contract.cnd}
        answer = self.http.request("GET", parent or self.cse_base, query=query)
        if answer["rsc"] != 2000:
            raise ContractError(f"discovery answered rsc {answer['rsc']}")
        uris = (answer["payload"] or {}).get("m2m:uril", [])
        if not isinstance(uris, list) or not all(isinstance(uri, str) for uri in uris):
            raise ContractError("discovery requires m2m:uril")
        return {"rsc": answer["rsc"], "filter": query, "uris": sorted(self.absolute(uri) for uri in uris)}

    def read_state(self, path: str) -> dict:
        answer = self.http.request("GET", path)
        if answer["rsc"] != 2000:
            raise ContractError(f"retrieve answered rsc {answer['rsc']}")
        return {"rsc": answer["rsc"], "state": self.contract.decode(answer["payload"])}

    def set_state(self, path: str, state: bool) -> dict:
        answer = self.http.request("PUT", path, body=self.contract.encode(state))
        if answer["rsc"] != 2004:
            return {"rsc": answer["rsc"], "applied": False}
        readback = self.read_state(path)
        return {"rsc": answer["rsc"], "applied": True, "readback": readback["state"], "readbackRsc": readback["rsc"]}


def verify(client: BinarySwitchClient, toggle: str | None, negative_cnd: str) -> dict:
    discovered = client.discover()
    states = {uri: client.read_state(uri)["state"] for uri in discovered["uris"]}
    unmatched = client.discover(cnd=negative_cnd)
    result = {"client": "python-stdlib-sdt-client", "contract": {"envelope": client.contract.envelope, "stateAttribute": client.contract.state_attribute,
              "stateType": client.contract.state_type.__name__, "namespace": client.contract.namespace, "cnd": client.contract.cnd},
              "discovery": discovered, "states": states, "unmatchedCnd": {"cnd": negative_cnd, "uris": unmatched["uris"]}}
    if toggle:
        before = client.read_state(toggle)["state"]
        flipped = client.set_state(toggle, not before)
        restored = client.set_state(toggle, before)
        result["toggle"] = {"uri": toggle, "before": before, "set": {"state": not before, **flipped}, "restore": {"state": before, **restored}}
    return result


def parse_bool(value: str) -> bool:
    if value not in ("true", "false"):
        raise argparse.ArgumentTypeError("state uses true or false")
    return value == "true"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Independent oneM2M TS-0023 binarySwitch client")
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--originator", required=True)
    parser.add_argument("--xsd", required=True, help="public binarySwitch XSD profile")
    parser.add_argument("--cse-base", default="/Mobius")
    parser.add_argument("--cnd", default=BINARY_SWITCH_CND)
    parser.add_argument("--timeout", type=float, default=5.0)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("discover")
    read = commands.add_parser("read"); read.add_argument("path")
    update = commands.add_parser("set"); update.add_argument("path"); update.add_argument("state", type=parse_bool)
    check = commands.add_parser("verify"); check.add_argument("--toggle"); check.add_argument("--negative-cnd", default="urn:privacy-bubble:unregistered")
    args = parser.parse_args(argv)
    contract = SdtContract.from_xsd(args.xsd, args.cnd)
    client = BinarySwitchClient(OneM2mHttpClient(args.endpoint, args.originator, timeout=args.timeout), contract, args.cse_base)
    if args.command == "discover":
        output = client.discover()
    elif args.command == "read":
        output = client.read_state(args.path)
    elif args.command == "set":
        output = client.set_state(args.path, args.state)
    else:
        output = verify(client, args.toggle, args.negative_cnd)
    with open(__file__, "rb") as source:
        output = {**output, "clientSHA256": hashlib.sha256(source.read()).hexdigest()} if isinstance(output, dict) else output
    json.dump(output, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ContractError, ValueError, OSError) as error:
        json.dump({"status": "FAIL", "error": str(error)}, sys.stderr)
        sys.stderr.write("\n")
        sys.exit(2)
