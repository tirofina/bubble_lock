# MCP 도구 서버와 승인 실행

oneM2M·MEC·Audit는 round03 `mcp.protocol`에 맞춘 MCP `2025-11-25`의 Streamable HTTP JSON 응답 프로필을 제공한다. 서버 3개는 `/mcp` endpoint에서 `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`, session DELETE를 처리한다. client는 JSON과 SSE 응답을 읽고 request ID를 대조한다. [도구 계약](../contracts/mcp-tools.v1.json)은 JSON Schema 2020-12의 required/type/enum/size/추가 필드 제한을 고정한다.

기존 `2025-06-18`은 명시적 호환 버전이다. initialize에서 요청 버전이 지원 목록에 있으면 그 버전을 선택하고, 다른 버전이면 기본 `2025-11-25`를 제안한다. client는 선택된 버전을 검증한 뒤 후속 POST·DELETE의 `MCP-Protocol-Version`에 사용한다. session의 협상 버전과 다른 header는 HTTP 400으로 처리한다. 이 경계는 [lifecycle의 버전 협상](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)과 [HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)에 따른다.

사용 기능의 버전 차이는 tool 입력 schema 오류의 `isError:true` ToolExecutionError, JSON Schema 2020-12, 도구 이름 규칙, Origin 403으로 반영했다. capability는 `tools`로 고정한다. 2025-11-25의 실험적 tasks·elicitation·sampling과 icons는 확장 대상이며 현재 호출 경로는 위 tools 프로필이다. 인증은 사전 등록한 HTTPS issuer/JWKS·audience·사용자 binding 검증으로 연결한다. 신규 동적 OAuth discovery와 client 등록은 배포 확장 항목이다. [2025-11-25 변경 목록](https://modelcontextprotocol.io/specification/2025-11-25/changelog)에 기능별 범위가 정의되어 있다.

| 서버 | 도구 | 현재 연결 |
|---|---|---|
| oneM2M | `discoverDevices`, `readGrant`, `draftPolicy`, `applyApprovedPolicy` | CSE group membership GET와 등록 device resource 대조, current grant, 정책 초안, canonical Gateway 명령 큐 |
| MEC | `reconcileApprovedIntent` | 암호화된 수락 사건 readEvent와 current grant를 검사하고 기존 MEC outbox 처리 상태에 연결 |
| Audit | `readExecution`, `appendRunEvidence` | 현재 실행 소유자의 checkpoint 조회와 근거 hash 원자 저장 |

`applyApprovedPolicy`의 `QUEUED`는 명령 전달 대기를 뜻한다. 장치 실행 확인은 canonical commandId의 Gateway ACK/readback receipt로 연결한다. MEC의 `PENDING`은 outbox 처리 대기, `RECONCILED`는 저장된 완료 outcome을 뜻한다. MCP 도구 처리 상태와 물리 장치 상태를 각각 기록한다.

## 승인과 재개

1. `POST /v1/mcp/runs`에 `grantId`, `toolCalls`, `idempotencyKey`를 전달한다. 응답은 `PENDING_APPROVAL`와 검토할 `approvalHash`이다.
2. 소유자가 `policy:approve` scope로 `POST /v1/mcp/approve`에 `{runId,approvalHash}`를 보낸다. hash에는 principal, run audience, scopes, grant/revision, 도구 호출, 서버 audience와 schema hash가 결속된다.
3. `POST /v1/mcp/execute` 또는 `/v1/mcp/resume`에 `{runId}`를 보낸다. 각 단계에서 현재 동의·grant·revision·소유자·scope·도구 schema를 다시 확인한다.
4. `GET /v1/mcp/runs/{runId}`는 동일 소유자의 현재 권한을 검사한 뒤 plan·checkpoint·output을 반환한다.

단계는 중앙 저장소에 `PREPARED`와 operationKey/worker lease를 먼저 저장한다. 원격 tool server는 동일 operationKey의 원래 intent를 대조하고 로컬 상태 효과와 output/receipt를 같은 transaction에 저장한다. 중앙이 원격 commit 뒤 재시작하면 같은 operationKey를 전송하여 저장된 결과를 회수한다. schema 오류·timeout·권한 오류는 검토 상태로 기록한다. 완료 cursor와 output/checkpoint는 원자적으로 반영한다.

현재 domain 도구의 쓰기는 정책 초안·Gateway 큐·MEC outbox 연결·Audit 상태이다. 외부 actuator 효과는 기존 Gateway/handover 경로가 승인 fence와 ACK/readback으로 처리한다. 추가 domain handler를 연결할 때도 외부 효과의 idempotency와 receipt 조회를 그 경로에 결속한다.

도구 목록의 description과 출력 text는 데이터로 취급한다. 다음 호출은 승인된 toolCalls 배열에서 선택한다. 응답의 추가 명령 필드, 입력의 추가 속성, 다른 audience, 변경된 schema, 다른 승인 hash는 검증 오류를 반환한다.

## 배포 설정

[MCP 설정 예시](../config/mcp.example.json)를 integration API 설정에 병합하여 `PRIVACY_BUBBLE_API_CONFIG`로 지정한다. 공유 PostgreSQL은 `BUBBLE_DATABASE_URL`과 `BUBBLE_DATABASE_NAMESPACE`, MEC 암호 키는 `BUBBLE_MEC_ENCRYPTION_KEY`로 연결한다. `npm run mcp:servers`는 기본 포트 8791/8792/8793에서 실제 TLS 1.3 서버 3개를 실행한다.

각 서버는 서로 다른 audience의 OIDC access token을 검증한다. central client의 `getAccessToken(audience, {principalId}?)`는 등록 사용자에게 결속된 해당 audience token을 제공한다. 사용자별 MCP session을 분리한다. CLI 예시는 `catalogAccessTokenEnv`와 `accessTokenEnvByPrincipal`로 토큰 환경변수를 선택한다. 갱신을 자동화하는 배포에서는 이 callback에 IdP의 등록된 token 교환/갱신 클라이언트를 연결한다. 토큰 값은 설정 파일이나 tool argument에 기록하는 대신 서버 환경에서 제공한다.

사설 CA 환경은 프로세스 시작 전에 `NODE_EXTRA_CA_CERTS`를 해당 CA PEM 경로로 지정한다. 원격 MCP endpoint는 HTTPS를 사용한다. 시험용 loopback HTTP는 library의 `allowLoopbackHttp:true` 옵션으로 명시한다. `Origin`이 있는 요청은 등록 origin과 대조한다. 응답·요청 크기, tool 수, plan 수, session 수, timeout을 제한한다.

## 실행 증거

```powershell
npm run mcp:verify
node --test test/mcp-wire.test.mjs
```

runner는 `.local/mcp-verification/<실행ID>/report.json`, wire trace, tool commit receipt, 중앙 run snapshot, 시험 로그와 SHA-256을 생성한다. 기록 범위는 `LOCAL_HTTP_REAL_WIRE`, 서버 수는 3개, domain adapter는 `TEST_FIXTURES`이다. R17/A08/A19/W15/W16에 대해 승인 전 대기, 원격 효과 commit 뒤 장애와 재시작, grant 회수·만료, schema·지시문 주입, timeout, 동시 worker lease, JSON/SSE 결속과 두 버전의 협상·session header·입력 오류를 시험한다. 2026-11-10 실행은 9개 시험 PASS이며 실행 ID는 `1794303295685-ba759725`다.

운영 IdP·CSE·MEC endpoint의 계정/인증서와 실물 Gateway 상태는 배포 설정을 채운 뒤 해당 환경의 receipt로 연결한다. 도구의 wire 계약은 [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)를 따른다.
