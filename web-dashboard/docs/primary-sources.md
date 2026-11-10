# Mobius4 discovery REST: primary-source contract

ROLE: WEB-DASHBOARD | DOC-REV: 2.0.0 | RUBRIC: R03,R07,R11
Observed: 2026-10-29. Scope: discovery and individual resource retrieval only.

## Evidence boundary and editions

This is source verification, not a successful request receipt from the school PC. Read the complete `PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md` and research brief before collection. Local `pc-mobius/README.md` and `config/mobius4-test.env.example` name Mobius4 and an external `MOBIUS4_ROOT`, but contain no upstream repository URL. The official repository was therefore independently resolved to [IoTKETI/mobius4](https://github.com/IoTKETI/mobius4), not inferred from a local checkout.

- **M**: upstream `master` resolved through the [GitHub commit API](https://api.github.com/repos/IoTKETI/mobius4/commits/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8) to `e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`, committer date `2026-10-20T00:09:58Z`. Its [package.json](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/package.json) declares `4.25.0`. Every code link below pins that revision; the installed PC revision is unknown.
- **C**: [ETSI TS 118 104 V2.7.1 (2016-10), oneM2M TS-0004 v2.7.1 Release 2](https://www.etsi.org/deliver/etsi_ts/118100_118199/118104/02.07.01_60/ts_118104v020701p.pdf). This is the consulted core-protocol baseline, **not a claim to have reviewed the latest Release 4 core edition**.
- **H**: [ETSI TS 118 109 V4.4.1 (2023-12), oneM2M TS-0009 v4.4.1 Release 4](https://www.etsi.org/deliver/etsi_ts/118100_118199/118109/04.04.01_60/ts_118109v040401p.pdf). HTTP binding is **TS-0009**, not TS-0004. Both were consulted.
- Edition caveat: latest-edition status was not established. This report uses the explicitly named editions and does not assert edition-wide Release 4 conformance.

PDF page numbers below are one-based and match printed pages. These are primary publisher transpositions, not third-party summaries.

## Observed code anchors

| ID | Primary permalink and observed anchor |
| --- | --- |
| M1 | [bindings/http.js:524-571](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/bindings/http.js#L524-L571), `httpToPrim`: path conversion; Origin -> `fr`, RI -> `rqi`, RVI -> `rvi`. |
| M2 | [bindings/http.js:572-648](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/bindings/http.js#L572-L648): GET mapping; query `fu`, `ty`, `drt`, `cnd` parsing. |
| M3 | [cse/validation/prim_schema.js:7-67](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/validation/prim_schema.js#L7-L67): required `rqi`, optional `fr`/`rvi`, accepted `fc.cnd` string array and `fc.ty` integer array. |
| M4 | [cse/reqPrim.js:283-334](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/reqPrim.js#L283-L334), Retrieve dispatch: `fu===1` calls `fu1_discovery`; `fu===2` selects retrieval. [Default parameters:410-434](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/reqPrim.js#L410-L434) default an omitted GET `fu` to 2 and `rcn` to 1. |
| M5 | [cse/hostingCSE.js:1042-1078](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/hostingCSE.js#L1042-L1078), `discovery_core`: `fc.ty` selects type models; 28 selects FLX. [set_where_clause:1244-1286](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/hostingCSE.js#L1244-L1286): descendants of target; `cnd` uses an SQL `IN` condition on type 28. |
| M6 | [cse/hostingCSE.js:1482-1507](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/hostingCSE.js#L1482-L1507), `fu1_discovery`: `m2m:uril` array, structured/unstructured selection and partial-result metadata. |
| M7 | [bindings/http.js:312-380](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/bindings/http.js#L312-L380), GET response mapping; [primToHttp:694-705](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/bindings/http.js#L694-L705), response headers and JSON content type; [reqPrim.js:38-41](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/reqPrim.js#L38-L41), RI echo and RVI fallback. |
| M8 | [cse/resources/flx.js:180-224](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/resources/flx.js#L180-L224), `retrieve_a_flx`: stored qualified envelope key, ordinary attributes and custom fields. [resolve_specialization:35-52](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/resources/flx.js#L35-L52), registry and envelope validation. |
| M9 | [test/flexcontainer.test.js:69-79](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/test/flexcontainer.test.js#L69-L79), qualified-key preservation; [235-259](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/test/flexcontainer.test.js#L235-L259), `ty=28`, matching/nonmatching `cnd`, and exclusion of ordinary containers. Tests were read, not run. |
| M10 | [test/helpers/onem2m.js:22-62](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/test/helpers/onem2m.js#L22-L62): actual HTTP helper sends three headers, JSON Accept, unique RI, and `GET ?fu=1`; its RVI is **3**, not 4. |
| M11 | [config/enums.js:1-45](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/config/enums.js#L1-L45): OK=2000, NOT_FOUND=4004, privilege failure=4103, 4=cin, 28=flx. |

## Supported REST contract

Each row is supported for the pinned source, not certified for the unobserved deployment.

| Concern | Verified behavior and evidence |
| --- | --- |
| Headers | Send configured `X-M2M-Origin`, a fresh `X-M2M-RI`, and configured `X-M2M-RVI`. M1/M3/M10 establish parsing and the upstream example; H 6.4.7, 6.4.8 (p.18), 6.4.22 (p.20) define the respective From, Request Identifier and Release Version Indicator mappings. RI is schema-required; the source schema does **not** require Origin/RVI universally. The project's `4` is a configured intent, not a tested server capability. |
| Discovery | `GET /{CSEBase-or-subtree}?fu=1&ty=28&cnd=org.onem2m.common.moduleclass.binarySwitch`. M2-M5 establish the complete parse/validation/dispatch/SQL chain. C 6.3.4.2.31 (p.49), 7.3.3.14 (p.103) define discovery usage; H 6.2.1 and 6.2.2.2 (pp.9-13) define GET/query mapping. Discover the **parent subtree**, not just the prospective leaf: M5 filters descendants. |
| Type/filter distinction | `ty=28` here is a query filter, not a GET Content-Type parameter. C table 6.3.4.2.1-1 (p.40) and M11 identify flexContainer=28 and contentInstance=4. C 8.2.3 table 8.2.3-2 (p.221) maps containerDefinition to `cnd`; H 6.2.2.2 permits attribute short-name queries. M2/M3/M5 confirm this implementation supports the filter rather than silently ignoring it. |
| Discovery body | M6 returns `{"m2m:uril":[...]}`, including an empty array when there are no matches on this normal path. With omitted `drt` or `drt=1`, entries are stored structured `sid` values; `drt=2` returns `ri` values. C 7.5.2 table 7.5.2-2 note 2 (p.213), 8.2.5 (p.228), and 8.4.2 rule 7 (p.232) establish URIList, `uril`, and list-as-array serialization. This is a list of addresses, not embedded resource objects. |
| Follow-up retrieval | GET the returned address using the HTTP path mapping, without `fu=1`; optionally `rcn=1`. M1/M4/M8 establish individual retrieval. For a CSE-relative `Mobius/ae/resource` entry, use `/Mobius/ae/resource` at the configured CSE authority, not `/Mobius/Mobius/ae/resource`. H 6.2.2.1 table 6.2.2.1-1 (p.10) defines CSE-relative `/`, SP-relative `/~`, absolute `/_` mappings. |
| JSON envelope | M8 preserves the specialization's registered qualified key and custom attributes. C 7.4.37.1 (p.191), 7.5.2 (p.213), 8.4.2 (p.232) permit other namespaces and define encapsulation. Do not rewrite every key to `m2m:flx` or strip `pb:`; M9 explicitly tests preservation. |
| HTTP response | M7/M11: normal successful GET is HTTP 200 with `X-M2M-RSC: 2000`, echoed RI, response RVI, and JSON body directly representing primitive Content. HTTP body is **not** an extra `m2m:rsp.pc` wrapper. H 6.3.2, 6.4.17 and 6.5 (pp.15-18,21) support the status/header/body separation. Missing target maps to HTTP 404/RSC 4004; denied ordinary retrieval to HTTP 403/RSC 4103. |
| Bounded results | M6 sets `X-M2M-CTS: 1` and `X-M2M-CTO` through M7 when partial; `lim`/`ofst` parsing is in M2 and validation in M3. H 6.4.20-21 (p.19) defines those headers. A single discovery response must not be represented as proof of a complete inventory. |

GETs need no request body or `Content-Type;ty=...`. M2 treats a semicolon-bearing Content-Type as CREATE; the upstream bodyless GET helper avoids it (M10). Use `Accept: application/json`. H 6.4.2-3 (p.17) reserves the Content-Type resource-type parameter for CREATE.

### Source-derived examples, not observed deployment responses

The host, CSEBase, subtree, identity and RVI below are configuration substitutions. This request shape is derived from M1-M6/M10 and H 6.2/6.4; it has not been sent to a live CSE.

```http
GET /Mobius/privacy-bubble-test-ae?fu=1&ty=28&cnd=org.onem2m.common.moduleclass.binarySwitch HTTP/1.1
Host: configured-cse-host
Accept: application/json
X-M2M-Origin: configured-operator-originator
X-M2M-RI: unique-discovery-request-id
X-M2M-RVI: 4
```

Illustrative M6 body: `{"m2m:uril":["Mobius/privacy-bubble-test-ae/bubbleState"]}`.
Follow-up: `GET /Mobius/privacy-bubble-test-ae/bubbleState` with the same configured Origin/RVI and a new RI.
If CORE has registered and created this specialization, an illustrative M8 body is `{"pb:binarySwitch":{"ty":28,"rn":"bubbleState","cnd":"org.onem2m.common.moduleclass.binarySwitch","state":true}}`; actual retrieval also carries generated metadata. Neither resource existence nor this prefix/datapoint schema has been verified on the PC.

### “JSON-LD” terminology

The verified contract is **oneM2M namespaced JSON**, not verified JSON-LD. M7 emits `application/json`; M8 uses a qualified object key. C 8.4.2 describes JSON serialization. A colon-bearing `pb:binarySwitch` key alone does not establish a JSON-LD context, RDF expansion, `application/ld+json` negotiation or a semantic API. Those behaviors remain unconfirmed; no `@context` or JSON-LD decoder requirement is inferred.

## CORE mismatch: report only, do not change CORE

Local primary artifact: `pc-mobius/contracts/oneM2M-test-contract.v1.json`, `steps` entries `create-state`, `update-state`, `discover-state` (lines 40-77).

- `create-state` declares `resourceType:4` and `application/json;ty=4` around `pb:binarySwitch`. That selects contentInstance, not flexContainer, according to C table 6.3.4.2.1-1 and M11. The same `resourceType:4` metadata appears in the other two steps. The CORE owner must reconcile it before claiming real flexContainer interoperability.
- `discover-state` is a RETRIEVE of `/privacy-bubble-test-ae/bubbleState`, without `fu=1`, `ty=28` or `cnd`. Per M4, that is individual retrieval, not discovery coverage.
- `pc-mobius/config/mobius4-test.env.example:4-8` supplies a loopback URL, local identity and RVI=4. These are examples, not deployment receipts or evidence of registered AE/ACP.

CORE, shared root files and contracts were left untouched.

## Explicit deployment unknowns

| Unknown | Evidence boundary / required owner confirmation |
| --- | --- |
| Runtime revision and endpoint | No installed Mobius source digest, running CSE request or school-PC reachability was observed. Confirm host/TLS, CSEBase and revision; upstream support is not a capability probe. |
| Operator AE and ACP | No operator AE-ID, authentication binding or DISCOVER/RETRIEVE grants were observed. [hostingCSE.js:1189-1206](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/hostingCSE.js#L1189-L1206) filters discoverable resources by originator access decisions; visibility does not prove retrieval permission. CORE/INTEGRATION must provide the deployment contract. |
| Browser CORS | [bindings/http.js:35-40](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/bindings/http.js#L35-L40) invokes `cors()`, but no browser preflight, proxy policy, credential behavior or exposure of RSC/RI/RVI/CTS/CTO response headers was tested. Middleware presence is not browser acceptance evidence. |
| RVI=4 | The local profile requests 4; M3 accepts an optional string and M7 initializes a response from request/config. M10's tests use 3. Acceptance, rejection, negotiated deployment support and response RVI=4 remain unconfirmed; an echo alone is not conformance proof. |
| SDT registry and qualified key | [specialization.js:5-38](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/specialization.js#L5-L38) loads a local registry; M8 checks registered cnd/envelope and returns 4125 for an unknown definition. The reviewed [upstream registry](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/config/specializations.json) has no `binarySwitch` text. The PC's installed `org.onem2m.common.moduleclass.binarySwitch`, `pb` namespace binding and `state:boolean` schema are unconfirmed. H 6.3.2 maps 4125 to HTTP 501; do not silently call a schema error “no devices.” |
| Inventory completeness | Actual page limits, ACP-filtered visibility and mutation during pagination were not measured. No tree completeness or live-data claim follows from these source observations. |

## Verification and ownership receipt

- Read-only retrieval: official GitHub commit/tree/raw sources and official ETSI PDFs. Source anchor review followed HTTP parsing -> schema -> dispatch -> discovery SQL -> serialization, with upstream tests read as corroboration, not executed proof.
- Both publisher PDFs were fetched directly from their ETSI URLs and extracted in memory with installed `pypdf`; both extractions exited 0. An optional `fontTools` warning on the core PDF concerned a CFF font; the cited tables/pages were legible. No package installation was performed. `pdftotext` was unavailable; Python's direct HTTP fetch returned 403; successful byte transfers used the existing JS fetch runtime.
- No unknown upstream scripts, Mobius runtime, live API calls, application tests/build, commit or push were run. This documentation-only scope calls for source/logical review, not implementation test results.
- Owned run root: `/tmp/bubblelock-sources.qfSifwbO`. Exported `TMPDIR` to it, `NODE_COMPILE_CACHE` to its `node-cache`, and `BUN_RUNTIME_TRANSPILER_CACHE_PATH` to its `bun-cache` for command work. No owned servers/background sessions were started; the PDF extractor exited. Cleanup returned `CLEANUP_OK root_absent; no owned servers or background sessions started`; the empty root was removed with `rmdir`, and no owned cache remains.
