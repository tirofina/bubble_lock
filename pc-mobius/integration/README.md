# PC-MOBIUS-INTEGRATION

Gateway AE 등록·CSR 인증서 발급·LOST 수명주기는 [GATEWAY_REGISTRATION](GATEWAY_REGISTRATION.md)에 연결한다.

Privacy Bubble의 정책·API·MEC·handover·FL·MCP 통합 계층이다. PC-MOBIUS-CORE가 제공하는 oneM2M resource·MQTT/HTTP·Gateway receipt 계약을 그대로 사용하며, 앱·웹·키링이 같은 `DOC-REV 2.0.0` 이벤트 흐름으로 연결된다.

## 역할 경계

```text
PC-MOBIUS-CORE
  oneM2M CSE / SDT / Group / Subscription / Gateway bridge / core receipt
        │ resource·event·command·ACK/readback
        ▼
PC-MOBIUS-INTEGRATION
  API·OIDC/mTLS·ACP/grant → MEC Location/RNIS → handover
  → ESTIMED VM FL → multi-server MCP → audit/release evidence
```

## 구현 모듈

| 모듈 | 구현 내용 | Rubric |
|---|---|---|
| `src/policy-service.mjs` | ACP scope, consent·grant 발급·회수·만료, household guardian 결속, approval hash, audit receipt | R10 |
| `src/oidc-verifier.mjs` | RS256/ES256 JWT 서명, 등록 JWKS, issuer·audience·expiry·subject 검증, scope 교집합 | R10 |
| `src/portal-service.mjs` | Guardian/Visitor 가구·기기·동의·권한·명령 승인·안전 요청·알림, 가구별 위치 접근 | R10, A26 |
| `src/mec-adapter.mjs` | Location·RNIS adapter, callback ingress, event dedup, geofence·health reconcile, 양방향 trace | R13, R15, R16 |
| `src/handover-coordinator.mjs` | Edge-A/B inventory, health/load selection, drain→active, epoch, subscription·security context, rollback | R12, R13 |
| `src/fl-coordinator.mjs` | ESTIMED VM selection, multi-round update, consent revision, artifact fence, checkpoint·recovery | R14 |
| `src/mcp-orchestrator.mjs` | oneM2M·MEC·Audit server registry, approval hash, persistent run, checkpoint·resume, audit | R17 |
| `src/api-gateway.mjs` | `/v1` 정책·MEC·handover·FL·MCP API 및 idempotency route | R10~R17 |
| `src/gateway-control.mjs` | 인증서·장치 등록, canonical 명령 발급, grant/claim/epoch 승인 | R03, R10 |
| `src/api-server.mjs` | TLS 1.3, mTLS Gateway 및 OIDC 사용자 principal 연결 | R10 |
| `src/integration-store.mjs` | 원자 JSON snapshot과 공통 receipt journal | R06, R17 |
| `src/integration-runtime.mjs` | CORE GatewayBridge와 통합 모듈 wiring | R03, R06 |

## 계약과 실행

- `contracts/integration-contract.v1.json`: integration wire·security·MEC·FL·MCP 계약 정본
- `scripts/validate-integration.mjs`: R06/R10/R12~R17 계약 구조 검증
- `scripts/run-integration.mjs`: consent→grant→MEC callback→handover→FL→MCP 전체 데모
- `scripts/run-integration-api.mjs`: `127.0.0.1:8787/v1` API 실행 프로세스
- `scripts/build-integration-evidence.mjs`: artifact SHA-256와 Rubric mapping release manifest 생성
- `scripts/replay-integration.mjs`: integration summary receipt 재생 검증
- `fixtures/fault-fixtures.json`: MQTT duplicate, MEC replay, edge drain, FL crash, MCP resume 장애 재현 기준
- `integration/release/manifest.json`: 구현 artifact와 실행 명령의 release 기준

```powershell
npm run integration:validate
npm test
npm run integration
npm run integration:api
npm run integration:evidence
npm run integration:replay -- --input=receipts/integration-demo.json
```

실행 결과는 `pc-mobius/receipts/`의 JSONL receipt와 `integration/state/`의 persistent run state로 남는다. 발표용 release packet에는 `integration/release/manifest.json`, summary receipt, CORE release manifest, 실제 Mobius4·Raspberry Pi trace를 함께 묶는다.

## API 대표 흐름

1. 서버 설정에 인증서 SHA-256 지문 또는 OIDC issuer·subject와 principal·scope·originator를 등록한다. OIDC는 서버가 고정한 HTTPS JWKS에서 RS256/ES256 서명, issuer·audience·exp·nbf를 확인하며 token scope와 등록 scope의 교집합을 사용한다. `/v1/auth/bind`는 transport가 검증한 principal을 반환한다.
2. `/v1/consents` → `/v1/grants`에서 purpose·scope·TTL·revision을 발급한다.
3. `/v1/mec/callback`에서 Location/RNIS event를 dedup하고 geofence·health 정책으로 reconcile한다.
4. 승인 intent가 Edge-A/B handover와 subscription·security context epoch를 갱신한다.
5. `/v1/fl/rounds`와 `/v1/fl/updates`가 ESTIMED VM을 동적으로 선택하고 artifact hash fence를 적용한다.
6. `/v1/mcp/runs`가 oneM2M·MEC·Audit MCP를 approval hash로 실행하고 checkpoint·resume receipt를 남긴다.

통합 이벤트는 `contractId`, `docRevision`, `eventId`, `timestamp`, 원본 서비스 필드를 보존하며 JSONL receipt로 웹에 전달한다.

## Gateway API와 권한

[인증서 설정 예시](../config/integration-api.example.json)를 복사해 `PRIVACY_BUBBLE_API_CONFIG`에 절대 경로를 지정한다. `/api/v1/gateways/{id}`의 `commands`, `authorize`, `credentials/status`는 Python Gateway TransportHub 계약을 따른다. `/v1/gateways/{id}/commands` POST는 `bubble:command` scope와 소유자의 active grant로 claim·revision·epoch를 발급한다.

서비스 호출 scope는 `mec:callback`, `handover:write`, `fl:write`, `mcp:run`이다. 정책 작업은 `consent:write`, `grant:write`, `grant:revoke`, `policy:approve`를 사용한다. Gateway 인증서의 scope는 기본 빈 배열이며 자신의 장치 명령 조회·실행 승인·credential 상태 경로에 결속된다.

루트 `npm run verify`는 Python/Node 실제 mTLS 연결과 권한 회수, CORE·웹 영수증 교차시험까지 실행한다. [전체 통합 안내](../../docs/branch-integration.md)에 실행 범위를 정리했다.

## 사용자 포털과 인증 연결

실제 Gateway/MEC 지도 데이터 흐름은 [위치 연동 계약](PORTAL_LOCATION.md), MCP 3서버와 승인·복구 경로는 [MCP 실행 안내](MCP.md)를 따른다.

[포털 계약](../contracts/portal-contract.v1.json)과 [snapshot JSON Schema](../contracts/portal.schema.json)가 Guardian/Visitor API의 정본이다. `GET /v1/portal/snapshot`은 등록된 가구 구성원의 기기·안전 요청·명령 요청과 본인의 동의·권한·알림을 반환한다. 모든 POST는 `idempotencyKey`를 전달하며 principal·action·원래 요청 내용으로 재전송을 결속한다. 상태 변경과 완료 결과는 같은 저장소 transaction에서 원자적으로 반영한다.

| 작업 | POST 경로 | 필요한 권한 |
|---|---|---|
| 가구 등록 | `/v1/portal/households` | `household:write` |
| 기기 등록 | `/v1/portal/devices` | guardian + `device:write` + 운영자가 등록한 Gateway/가구 연결 |
| 동의 생성·회수 | `/v1/portal/consents`, `/v1/portal/consents/revoke` | guardian + `consent:write` |
| 권한 발급·회수 | `/v1/portal/grants`, `/v1/portal/grants/revoke` | 동의/권한 소유자 + `grant:write`/`grant:revoke` |
| 명령 요청·승인 | `/v1/portal/commands/request`, `/v1/portal/commands/approve` | `command:request`; 승인은 guardian + `bubble:command` + 현재 가구 grant |
| 도움·분실·안전 요청 | `/v1/portal/incidents`, `/v1/portal/incidents/resolve` | `incident:write`; 처리는 guardian + `incident:resolve` |
| 알림 확인 | `/v1/portal/notifications/read` | 알림 수신자 + `portal:read` |

`GET /v1/portal/location-access`는 `{deviceIds,householdIds,role}`을 반환한다. 보호자는 소속 가구 기기를 조회하고, 방문자는 해당 가구 보호자의 `location:read` 권한이 활성인 동안 기기 위치를 조회한다. 동의·권한 회수, revision 변경, 만료가 다음 조회에 즉시 반영된다. 웹 위치 데이터 경로는 이 결과로 기기 집합을 필터링한다.

명령 승인은 기존 `GatewayControl`의 canonical 큐에 claim·grantRevision·ownershipEpoch·deadline을 저장한다. `PENDING`은 승인 대기, `PARTIAL`은 일부 기기의 큐 등록, `QUEUED`는 Gateway 전달 대기를 뜻한다. 실제 실행 확인은 Gateway ACK/readback receipt로 연결한다. `PARTIAL` 재시도는 원래 commandId와 intent를 유지한다.

`createPortalDemo({statePath?,clock?})`는 고정된 guardian/visitor/operator identity, `household-demo`, `pi-01`, 키링 3개와 로컬 sandbox 큐를 제공한다. 웹 demo 모드의 역할 선택은 이 고정 identity에 결속된다. 운영 환경은 [설정 예시](../config/integration-api.example.json)에 실제 issuer·JWKS URI·subject enrollment와 인증서 파일을 채워 실행한다. OIDC 설정 시 TLS client certificate는 선택이며, Gateway 경로의 certificate fingerprint 결속은 필수다. TLS 설정 전에는 `/healthz` 상태 조회가 제공된다.

검증은 생성한 RSA/EC 키의 서명·claims 시험, household 경계·grant 회수·부분 큐 복구 시험, Python httpx와 Node 간 실제 TLS 1.3 요청으로 구성된다. 이 증거의 실행 범위는 로컬 프로세스와 시험용 PKI/JWT이며, 외부 IdP 등록·브라우저 PKCE 세션·실물 키링 실행은 각각 배포 설정과 별도 receipt로 연결한다. JWT 검증 기준은 [OpenID Connect 검증 규칙](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)과 [Node crypto.verify](https://nodejs.org/api/crypto.html#cryptoverifyalgorithm-data-key-signature)를 참고한다.
