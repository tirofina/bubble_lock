# Why oneM2M

Privacy Bubble Keyring handles some of the most sensitive data a family has:
where an older parent who lives alone is, and who is allowed to know it. We built
the system on the [oneM2M](https://www.onem2m.org) service layer, running on the
open-source [Mobius4](https://github.com/IoTKETI/mobius4) CSE, because oneM2M
gives every application the same resources, the same access control and the
same event model. The guardian app, the operator console, the MEC location
service, the federated learning coordinator and the AI agent all read and
write one shared, standard resource tree instead of five private APIs.

This page explains which oneM2M features the project uses, what each one
replaces, and where to find the code. The architecture diagrams are in
[architecture.md](architecture.md).

## What oneM2M does for this project

| oneM2M feature | What it does here | Where in the code | What we would build without it |
|---|---|---|---|
| Group and fanOutPoint | One UPDATE to the group's `fopt` (`/privacy-bubble-group/fopt` in the test contract, `/BubbleLock/grp-switches/fopt` on the team server) reaches every member; the CSE returns one aggregated `m2m:agr` response with a result code per member | [group-dispatcher.mjs](../pc-mobius/src/group-dispatcher.mjs), `group-fanout` step in [oneM2M-test-contract.v2.json](../pc-mobius/contracts/oneM2M-test-contract.v2.json) | A custom broadcast service with its own member list, partial-failure bookkeeping and retry rules |
| Subscription and notification | The CSE pushes `m2m:sgn` notifications when a state, observation or receipt changes; the central service settles commands from receipt notifications and the dashboards update without polling | `create-subscription` step in the contract, [handover-cse.mjs](../pc-mobius/integration/src/handover-cse.mjs), [receipt notification ingress](../keyring/integration-candidate/receipt-notification-ingress.mjs) | A private pub/sub layer and per-app polling loops |
| accessControlPolicy (ACP) | The CSE checks every CREATE, RETRIEVE, UPDATE, DELETE, NOTIFY and DISCOVER request against per-role privileges, so a visitor, a relay or the MEC interworking role holds only the rights it needs | [run-acp-real.mjs](../pc-mobius/scripts/run-acp-real.mjs), `fl-model-acp` in [fl-publisher.mjs](../pc-mobius/integration/src/fl-publisher.mjs), `handover-acp` in [handover-cse.mjs](../pc-mobius/integration/src/handover-cse.mjs) | Authorization code repeated in every application that touches device data |
| SDT (TS-0023) and flexContainer | Keyring state is a `binarySwitch` ModuleClass (`cod:binSh`, `state: boolean`) in a flexContainer, so any oneM2M client that knows the binarySwitch model can read and control it | [sdt-adapter.mjs](../pc-mobius/src/sdt-adapter.mjs), [specializations](../pc-mobius/specializations), [SDT notes](../pc-mobius/SDT.md) | A project-specific JSON schema that every client must learn |
| Discovery with filter criteria | Applications find devices with `fu=1&ty=28&cnd=org.onem2m.common.moduleclass.binarySwitch` instead of hard-coded paths | `discover-state` step in the contract, `discoverDevices` MCP tool in [mcp-domain-tools.mjs](../pc-mobius/integration/src/mcp-domain-tools.mjs) | A device registry service |
| container and contentInstance | The Gateway writes each BLE observation, command receipt and health frame as an immutable `m2m:cin`; the request identifier fixes the instance name, so retries over MQTT and HTTPS never duplicate data | [transport.py](../keyring/raspberry-pi-gateway/src/bubble_gateway/transport.py), [INTERFACE_NOTES.md](../keyring/INTERFACE_NOTES.md) | An append-only log store with its own deduplication |
| HTTP and MQTT protocol bindings (TS-0009, TS-0010) | The Gateway sends the same oneM2M primitive over MQTT and falls back to HTTPS; `X-M2M-RI` / `rqi` correlates the response in both cases | [transport.py](../keyring/raspberry-pi-gateway/src/bubble_gateway/transport.py), [gateway-bridge.mjs](../pc-mobius/src/gateway-bridge.mjs) | Two separate device APIs with separate correlation logic |
| Standard resources across CSEs | The handover coordinator recreates AE, ACP, group and subscription on a second CSE and reads the state back; the same code works on any compliant CSE | [handover-coordinator.mjs](../pc-mobius/integration/src/handover-coordinator.mjs), [handover-cse.mjs](../pc-mobius/integration/src/handover-cse.mjs) | Vendor-specific migration scripts |

### Verified on real Mobius4 CSEs (local runs, evidence folder 2026-11-11)

- ACP role matrix: 828 CRUDN and DISCOVER cases across two Mobius4 4.24.5 CSEs,
  all PASS ([acp-real-cse.json](verification-evidence/2026-11-11/acp-real-cse.json)).
- SDT interoperability: two CSE providers times two client implementations (a
  direct HTTP client and an independent SDK client) found every binarySwitch by
  `cnd` discovery, then exchanged state through UPDATE, group fan-out and
  readback
  ([interop-real-cse.json](verification-evidence/2026-11-11/interop-real-cse.json)).
- CSE handover between two real CSEs with PostgreSQL 17
  ([handover-real-cse.json](verification-evidence/2026-11-11/handover-real-cse.json)).
- Federated learning artifacts published to and read back from a real CSE
  ([fl-cse-verification-6.json](verification-evidence/2026-11-11/fl-cse-verification-6.json)).

## Interworking with MEC through an IPE

oneM2M defines the Interworking Proxy application Entity (IPE) as the standard
way to bring a non-oneM2M system into the resource tree. For this project the
non-oneM2M system is ETSI Multi-access Edge Computing:

- [ETSI GS MEC 011](https://forge.etsi.org/rep/mec/gs011-app-enablement-api):
  edge platform application enablement and service discovery (Mp1)
- [ETSI GS MEC 012](https://forge.etsi.org/rep/mec/gs012-rnis-api): Radio
  Network Information API (RNIS)
- [ETSI GS MEC 013](https://forge.etsi.org/rep/mec/gs013-location-api):
  Location API

The design maps MEC location and radio events into oneM2M resources, so every
application reads one model and the CSE enforces the same ACP on MEC-derived
data. The MEC interworking role holds narrow rights: RETRIEVE on the `desired`
container, CREATE and UPDATE on the `actual` container, and NOTIFY towards the
notification sink. These masks are part of the 828-case ACP run above.

Current state, stated precisely:

- The MEC adapter ([mec-adapter.mjs](../pc-mobius/integration/src/mec-adapter.mjs),
  [mec-http-client.mjs](../pc-mobius/integration/src/mec-http-client.mjs)) implements
  service discovery, Location and RNIS queries, subscription CRUD and HTTP
  callbacks with replay protection. It also runs against a local MEC provider
  simulator (`run-mec-ipe-real.mjs`, [MEC notes](../pc-mobius/integration/MEC.md)).
- The oneM2M MEC IPE runs against our own ETSI MEC Sandbox with 33/33 checks
  ([mec-ipe-sandbox.json](verification-evidence/2026-11-20/mec-ipe-sandbox.json))
  and, as a MEC application, relocates from mep1 to mep2 with 25/25 checks
  ([mec-day-of-care.json](verification-evidence/2026-11-20/mec-day-of-care.json)).
  Install record: [deploy/mec-sandbox](../deploy/mec-sandbox/README.md); notes:
  [R15-R16](rubric-work/R15-R16.md).

## Federated learning over oneM2M

The FL coordinator publishes participants, datasets, tasks, rounds, verified
updates, the model bytes with their manifest and the current serving model as
oneM2M resources under a dedicated AE with its own ACP. Raw training rows stay
with each participant. Consent revocation pauses serving and records a new
serving generation. The rubric of the 2026 hackathon names oneM2M TR-0084 for
this category. The local run uses real worker processes against a real Mobius4
CSE for 12 rounds ([fl-onem2m-real-cse.json](verification-evidence/2026-11-19/fl-onem2m-real-cse.json));
a second run trained three workers on the sandbox VM for 6 rounds against the
team server CSE ([fl-server-cse.json](verification-evidence/2026-11-20/fl-server-cse.json)).
Deployment on an ESTIMED VM is listed in
[external-validation-todo.md](external-validation-todo.md).

## AI agent with MCP servers

Three MCP servers (oneM2M, MEC, Audit) expose tools to an agent. The oneM2M
server reads group membership and registered device resources from the CSE and
queues approved policies as canonical Gateway commands. Every run needs an
approval hash from the guardian, and the physical effect still goes through the
Gateway ACK and readback path ([MCP notes](../pc-mobius/integration/MCP.md)).

## oneM2M specifications used

| Document | Use in this project |
|---|---|
| TS-0001 Functional Architecture | Resource model, group management, subscription and notification, access control, IPE concept |
| TS-0003 Security Solutions | Security baseline listed in the project standard set (access control, secure transport) |
| TS-0004 Service Layer Core Protocol | Primitives, resource types, short names, XSD common types ([ts-0004 schemas](https://git.onem2m.org/XMLSchemas/ts-0004)) |
| TS-0009 HTTP Protocol Binding | Gateway HTTPS fallback, CORE HTTP client |
| TS-0010 MQTT Protocol Binding | Gateway and CORE MQTT requests on `/oneM2M/req/{originator}/{cseId}/json` |
| TS-0023 SDT based information model | binarySwitch ModuleClass, `cod:binSh` short names, flexContainer specialization |
| TR-0084 | Federated learning category of the hackathon rubric |
| TR-0077, TR-0086 | Further technical reports the team follows for the hackathon work packages; look them up by number on the published specifications page |

All documents are available from
[oneM2M published specifications](https://www.onem2m.org/technical/published-specifications)
([Release 4](https://www.onem2m.org/technical/published-specifications/release-4),
[Release 5](https://www.onem2m.org/technical/published-specifications/release-5)).

## Learn more about oneM2M

- oneM2M: https://www.onem2m.org
- Published specifications: https://www.onem2m.org/technical/published-specifications
- oneM2M Recipes, tutorials and code examples for developers: https://recipes.onem2m.org
- Mobius4 oneM2M CSE by KETI (4.24.5 for our test runs, 4.25.0 on the team server): https://github.com/IoTKETI/mobius4
- oneM2M XML schemas: https://git.onem2m.org/XMLSchemas/ts-0004

If you build an IoT product that more than one application must trust, start
from a oneM2M CSE. Group, subscription, ACP and SDT gave this project a shared
security and data model on day one, and let a small hackathon team spend its
time on the privacy features instead of on plumbing.
