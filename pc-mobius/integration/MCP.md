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

## LLM agent 프로필

[agent 도구 계약](../contracts/mcp-agent-tools.v1.json)(`privacy-bubble.mcp-agent.v1`)은 Claude Code 같은 범용 MCP client가 직접 호출하는 도구 8개를 정의한다. 이 프로필의 서버는 client가 보낸 `_meta`를 무시하고, 인증된 run token에서 runId, grant revision, audience, deadline, operationKey를 만든다(`createMcpHttpServer`의 `resolveContext`). 쓰기 도구의 operationKey는 runId와 입력의 hash이므로 같은 쓰기 호출은 저장된 결과를 다시 돌려준다. 읽기 도구는 호출마다 새 operationKey를 쓴다. 도구 오류는 reason code가 붙은 `isError` 결과로 돌아가고, 입력 schema 오류에는 AJV 경로와 메시지가 붙는다.

| 서버 | 도구 | 실제 연결 |
|---|---|---|
| oneM2M | `discoverDevices` | `GET <household AE>?fu=1&ty=28&cnd=org.onem2m.common.moduleclass.binarySwitch`로 SDT flexContainer를 찾고 부모 container label에서 deviceId를 읽는다 |
| oneM2M | `readGrant` | 중앙 grant revision, location container `acpi`, grants container의 `VISITOR_GRANT` contentInstance |
| oneM2M | `draftPolicy` | run 상태에 draft, draftHash, 최소 권한 findings를 저장한다. CSE 접근 권한은 이 단계에서 그대로 유지된다 |
| oneM2M | `requestGuardianApproval` | household approvals container에 `APPROVAL_REQUEST` contentInstance를 만든다 |
| oneM2M | `applyApprovedPolicy` | guardian approvalHash를 검사한 뒤 visitor ACP(`acop` 2, `et`=notAfter)를 만들고 location container `acpi`에 붙이며, grants container에 payloadHash가 있는 `VISITOR_GRANT`를 기록한다 |
| MEC | `reconcileApprovedIntent` | `MecAdapter`로 MEC 013 service discovery와 `queries/users`를 호출하고 incident 영역을 판정한 뒤 소수 셋째 자리 좌표 sample을 location container에 기록한다 |
| Audit | `readExecution` | completedSteps, nextStep, guardian 승인 상태, resumedFrom |
| Audit | `appendRunEvidence` | checkpoint output hash, approvalHash, ACP와 grant 경로를 묶은 evidenceHash를 audit container에 기록하고 run을 완료한다 |

`McpAgentWorkflow`(`mcp-orchestrator.mjs`)는 쓰기 단계를 계약 순서대로 한 번씩 실행하고, 각 commit을 dedup 기록과 같은 store transaction 안에서 checkpoint로 저장한다. 순서를 벗어난 호출에는 `ROUTE_ORDER`와 nextStep을 돌려준다. agent token의 scope는 서버별 도구 scope이고 `policy:approve`는 guardian principal에만 있다. guardian 단계는 agent session 밖에서 approvals container의 요청 기록을 guardian originator로 읽고, 저장된 draftHash와 최소 권한 findings를 확인한 뒤 approvalHash를 만든다. `applyApprovedPolicy`는 현재 draftHash에 결속된 guardian approvalHash만 받고, 다른 값에는 `APPROVAL_HASH_MISMATCH`를 돌려주며 그 시도를 run 상태의 `approvalChecks`에 기록한다. guardian이 거절하면 agent는 새 draft와 새 승인 요청으로 진행한다.

run 상태는 `.local/mcp-llm-agent/<run>/agent-state.json`(IntegrationStore, fsync 뒤 rename)에 있다. 새 runner는 같은 파일을 열어 `beginInvocation`으로 resumedFrom(cursor, completedSteps, nextStep)을 기록하고, 새 agent session은 `readExecution`으로 다음 단계를 받는다.

```powershell
$env:MOBIUS4_ROOT = "<mobius4 checkout>"
npm --prefix pc-mobius run mcp:agent                            # claude -p, receipt는 docs/verification-evidence/2026-11-19
node pc-mobius/scripts/run-mcp-llm-agent.mjs --agent=scripted   # 같은 흐름을 scripted MCP client로 실행, 결과는 .local run 폴더
```

runner는 Mobius4 4.24.5를 run 전용 PostgreSQL DB로 시작하고 household, guardian, visitor, stranger AE와 keyring container 2개(SDT, location, grants)를 만든다. MEC Location은 로컬 simulator(`simulation: true`)이다. 첫 invocation은 `requestGuardianApproval` commit 직후 runner process tree(MCP 서버 3개와 claude)를 `taskkill /F /T`로 종료한다. 이어서 guardian 단계, runner의 mismatched hash probe 2건, 두 번째 invocation 순서로 진행한다. Claude Code는 `--tools ""`, `--strict-mcp-config`, `--allowedTools`(MCP 도구 8개), `--permission-mode dontAsk`, `--setting-sources local`, `--no-session-persistence`, 짧은 `--system-prompt`로 실행하며 model은 사용자 기본값을 따른다. transcript는 token, CSE admin originator, DB 비밀번호를 치환하고 계정 rate limit 줄을 제외해 저장한다.

2026-11-19 실행 receipt [mcp-llm-agent-real-cse.json](../../docs/verification-evidence/2026-11-19/mcp-llm-agent-real-cse.json)은 조건 8개 PASS이다. 첫 invocation은 cursor 4에서 종료했고, 두 번째 invocation은 `applyApprovedPolicy`부터 진행해 앞 단계 재실행 0건으로 완료했다. visitor originator의 location `la` 조회는 2000, SDT와 다른 keyring 조회와 location 쓰기는 4103이다. 단위 시험은 `node --test test/mcp-agent.test.mjs`(4건)이다. 이 흐름은 오후 돌봄 위임(방문 돌봄자 위치 조회 위임) 단계로 유지한다.

## 이상 징후 triage 프로필

[triage 도구 계약](../contracts/mcp-triage-tools.v1.json)(`privacy-bubble.mcp-triage.v1`)은 같은 oneM2M, MEC, Audit 서버에 도구 13개를 둔다. 이상 징후 판정은 결정론적 routine model(`routine-model.mjs`)이 맡고, LLM agent는 경보가 난 뒤의 맥락 수집, 도구 선택, 보호자용 설명을 맡는다.

| 서버 | 도구 | 실제 연결 |
|---|---|---|
| oneM2M | `readAlert`, `readRecentHistory`, `readRoutineProfile`, `readDeviceState` | 거주자 AE의 alerts, location(구간 이름과 소수 셋째 자리 격자), routine, keyring state와 events container |
| oneM2M | `submitTriage` | severity, action(observe, checkIn, emergencyLease), 보호자용 설명을 triageLog에 기록한다. checkIn과 emergencyLease는 incident를 열고 guardianInbox에 알림 cin을 쓴다 |
| oneM2M | `draftLocationLease`, `requestGuardianApproval`, `applyApprovedLease` | 보호자 수신, 목적 2종, 최대 5분 lease 초안과 draftHash, approvals container 요청, guardian approvalHash 검사 뒤 `LocationPrivacyService.createLease` |
| MEC | `queryUeLocation`, `queryZoneStatus`, `queryServingCell` | ETSI MEC Sandbox의 MEC013 v3 `queries/users`, `queries/zones/{zoneId}`, MEC012 `rab_info`. MEP locality에 따라 MEP를 차례로 조회한다 |
| Audit | `readExecution`, `appendTriageEvidence` | run ledger와 evidenceHash 기록 |

`McpTriageWorkflow`는 `McpAgentWorkflow`의 checkpoint, guardian 결정, approvalHash 검사를 그대로 쓰고, 단계 규칙만 바꾼다. 읽기 도구는 순서 제약 없이 호출하고 run마다 14회 예산 안에서 기록한다. `submitTriage`는 `readAlert` 뒤에만 받는다. lease 단계는 action이 emergencyLease일 때만 열리고(`ROUTE_ACTION`), 보호자 결정 전의 apply와 evidence는 `APPROVAL_PENDING`으로 돌아간다. 서버는 설명 문장 안의 좌표형 숫자와 action-severity 불일치를 `EXPLANATION_PRIVACY`, `ACTION_SEVERITY`로 거절한다. 모든 도구 출력은 구간 이름, 시각, 10 m 단위 거리, 소수 셋째 자리 격자만 담고 정밀 좌표는 암호화 참조로 서버 안에 머문다.

```powershell
$env:MOBIUS4_ROOT = "<mobius4 checkout>"
node pc-mobius/scripts/run-anomaly-triage.mjs --agent=scripted --sandbox=dayofcare --evidence   # LLM 호출 0회
node pc-mobius/scripts/run-anomaly-triage.mjs --agent=claude --sandbox=dayofcare                # receipt는 docs/verification-evidence/2026-11-20
```

runner는 Mobius4와 run 전용 DB, 거주자, routine, triage, guardian app, incident service AE를 준비하고, 합성 정상 산책 7일을 locationHistory에 기록한 뒤 routine AE가 CSE에서 다시 읽어 profile을 만든다. 사례마다 sandbox UE를 GIS로 옮기고 MEC013 조회 위치를 location cin으로, MEC012 cell 변화를 rnis cin으로 기록한다. routine AE가 alerts에 cin을 쓰면 triage AE가 oneM2M 알림으로 깨어나 agent를 실행한다. 보호자 승인 뒤 lease 적용은 triage AE가 저장된 run 상태에서 LLM 없이 재개한다. 단위 시험은 `node --test test/mcp-triage.test.mjs`(5건)이다.
