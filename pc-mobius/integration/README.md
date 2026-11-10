# PC-MOBIUS-INTEGRATION

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
| `src/policy-service.mjs` | OIDC/mTLS principal binding, ACP scope, consent·grant 발급·회수·만료, approval hash, audit receipt | R10 |
| `src/mec-adapter.mjs` | Location·RNIS adapter, callback ingress, event dedup, geofence·health reconcile, 양방향 trace | R13, R15, R16 |
| `src/handover-coordinator.mjs` | Edge-A/B inventory, health/load selection, drain→active, epoch, subscription·security context, rollback | R12, R13 |
| `src/fl-coordinator.mjs` | ESTIMED VM selection, multi-round update, consent revision, artifact fence, checkpoint·recovery | R14 |
| `src/mcp-orchestrator.mjs` | oneM2M·MEC·Audit server registry, approval hash, persistent run, checkpoint·resume, audit | R17 |
| `src/api-gateway.mjs` | `/v1` 정책·MEC·handover·FL·MCP API 및 idempotency route | R10~R17 |
| `src/gateway-control.mjs` | 인증서·장치 등록, canonical 명령 발급, grant/claim/epoch 승인 | R03, R10 |
| `src/api-server.mjs` | TLS 1.3/mTLS HTTP server와 인증서 principal 연결 | R10 |
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

1. 서버 설정에 인증서 SHA-256 지문과 principal·scope·originator를 등록한다. HTTPS transport가 검증한 인증서를 `/v1/auth/bind`에서 조회한다. OIDC claim 해석 헬퍼는 내부 데모용이며 외부 OIDC 연결은 검증된 인증 middleware에서 principal을 전달하는 방식으로 확장한다.
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
