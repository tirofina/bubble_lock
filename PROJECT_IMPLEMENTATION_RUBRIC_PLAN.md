# Privacy Bubble Keyring

## 개발 기준 문서

이 문서는 Privacy Bubble Keyring의 구현 기준, 담당자 분배, 프로토콜 계약, Rubric 추적, 시험 수용 조건을 하나의 기준으로 묶는다. 다섯 명의 구현 담당자가 이 문서를 기준으로 모듈을 개발하고, Red 검증·Blue 보완·Green 독립 설계 검토 사이클에 결과를 연결한다.

현재 목표는 Rubric 17개 항목에서 Expert 수준(항목별 5점, 총 85점)에 도달하는 것이다. Green은 oneM2M 표준제정위원장 관점의 AI 독립 검토 역할로 고정한다. 설계 검토 점수는 실제 구현·시험·공개 활동·면접 증거와 별도 관리하며, 실제 증거는 각 gate의 receipt로 수집한다.

### 기준 자료

- [Hackathon Rubric 원문](references/hackathon_2026/extracted/Hackathon%20Rubric%202026.txt)
- [최신 설계 문서](deliverables/privacy_bubble_expert_v3/design_plan.html)
- [최신 실행 계약](proposal_work/red_blue_green/blue/contracts_round03.json)
- [Green 평가 정책](proposal_work/red_blue_green/green/review_policy.json)
- [Red·Blue·Green 검토 이력](deliverables/privacy_bubble_expert_v3/review_history.html)
- [현재 release 연결표](deliverables/privacy_bubble_expert_v3/active_release.json)
- [공동 개발 저장소: tirofina/bubble_lock](https://github.com/tirofina/bubble_lock)

## 공동 개발 저장소와 에이전트 운영

### 저장소 기준

- 원격 저장소: `https://github.com/tirofina/bubble_lock`
- 로컬 공동 작업 폴더: `github_upload/bubble_lock`
- 기본 브랜치: `main`
- 통합 브랜치: `integration/privacy-bubble`
- 공통 기준 문서: 저장소 루트의 `PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md`
- 기준 문서 개정은 `DOC-REV` 값을 커밋 메시지와 Pull Request에 기록한다.
- 저장소의 기존 README와 커밋 이력은 프로젝트 출발점으로 보존하며, 모든 구현은 이 문서의 Rubric·프로토콜·gate 기준에 연결한다.
- 현재 공통 문서 기준: `DOC-REV 2.0.0` on `PC-MOBIUS-CORE`
- 원격 반영은 팀 통합 승인과 Red 검증을 거친 뒤 진행한다.

### 다섯 에이전트의 역할 선언

각 개발자는 작업 시작 메시지·branch 설명·Pull Request 본문에 아래 형식으로 자신의 역할을 먼저 밝힌다.

```text
ROLE: PC-MOBIUS-CORE | PC-MOBIUS-INTEGRATION | APP | WEB-DASHBOARD | KEYRING
DOC: PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md
DOC-REV: <문서 개정 식별자>
RUBRIC: <담당 R01~R17>
SCOPE: <이번 작업 범위>
INTERFACES: <변경·사용하는 API/프로토콜/oneM2M 자원>
TESTS: <실행할 시험 ID와 기대 receipt>
EVIDENCE: <로그·artifact·hash 경로>
DEPENDENCIES: <다른 역할에 전달할 계약>
```

역할별 선언 기준은 다음과 같다.

| 역할 | branch 예시 | 담당 영역 | 주 Rubric |
|---|---|---|---|
| PC-MOBIUS-CORE | `feature/pc-mobius-core` | Mobius CSE·oneM2M resource·SDT·Group·Subscription·MQTT/HTTP binding·DB 정본 | R01, R02, R03, R06, R07, R11 |
| PC-MOBIUS-INTEGRATION | `feature/pc-mobius-integration` | API/Auth·ACP/grant·MEC·callback·handover·FL·MCP·통합시험·release evidence | R03, R06, R10, R12~R17 |
| APP | `feature/app` | Guardian/Visitor 앱·OIDC·consent·승인·알림·상태 | R03, R09, R10, R14, R17 |
| WEB-DASHBOARD | `feature/web-dashboard` | 운영 화면·resource tree·실시간 event·audit·evidence | R03~R09, R12, R15, R16, R17 |
| KEYRING | `feature/keyring` | PCB·firmware·BLE·Raspberry Pi Gateway·device receipt | R01~R03, R05, R10~R12, R15 |

Role 5의 KEYRING 담당은 키링 PCB·펌웨어와 Raspberry Pi Gateway를 하나의 현장 엣지 묶음으로 관리한다. PC-MOBIUS-CORE 담당은 중앙 Mobius IN-CSE와 oneM2M wire/resource 정본을 관리한다. PC-MOBIUS-INTEGRATION 담당은 정책·API·MEC·handover·FL·MCP·통합 증거를 관리한다.

### Raspberry Pi Gateway 아키텍처 결정

Privacy Bubble의 기본 시연·통합 경로는 `키링 BLE → Raspberry Pi Gateway → MQTT/HTTPS → PC Mobius4`로 고정한다. Raspberry Pi는 BLE GATT 수집, payload schema 검증, sequence·dedup, MQTT QoS 1 전송, HTTPS 보조 전송, ACK/readback 기록을 담당한다. 키링 담당자는 Gateway daemon과 Pi 설치·재연결·전원·범위 시험을 함께 제출하고, PC-MOBIUS-CORE 담당자는 동일 event를 oneM2M subscription과 receipt로 연결한다.

PC 기반 Gateway emulator는 계약·UI 개발용 사전 검증 경로로 활용하고, 최종 통합 evidence와 발표 시연은 Raspberry Pi 실물 경로로 기록한다.

### 다섯 명의 시간·업무 배분

현재 620시간 기본 작업 계획의 역할 키를 다음처럼 매핑한다. 예비 155시간과 여유 30시간은 기존 gate·통합시험·장애 복구에 공동 사용한다.

| 담당 | 기존 역할 키 | 기본 계획 시간 | 핵심 결과 |
|---|---:|---:|---|
| PC-MOBIUS-CORE | A | 159h | CSE·oneM2M·SDT·Group·Subscription·MQTT/HTTP·DB |
| PC-MOBIUS-INTEGRATION | D | 103h | Auth/ACP·MEC·callback·handover·FL·MCP·통합시험 |
| APP | C 일부 | 99h | Guardian/Visitor 앱·승인·consent·알림·상태 |
| WEB-DASHBOARD | E | 130h | 운영 UI·event·audit·evidence·Article/영상 지원 |
| KEYRING | B | 129h | PCB·firmware·BLE·Raspberry Pi Gateway·실물시험 |
| **합계** |  | **620h** | 25개 작업과 26개 수용시험 |

APP 담당의 서버 연동·인증 일부는 PC-MOBIUS-INTEGRATION과 공동 수행하며, Rubric·API·receipt owner는 각 기능별로 한 명을 지정한다.

### 동시에 개발하는 작업 규칙

1. 모든 역할은 작업 시작 전에 이 문서를 읽고 역할 선언을 남긴다.
2. 역할별 branch에서 독립적으로 개발하고, 공유 인터페이스는 계약 파일로 먼저 고정한다.
3. 공통 계약 변경은 `contracts/` 또는 `interfaces/`의 schema·OpenAPI·oneM2M resource 예시와 함께 Pull Request에 포함한다.
4. 각 Pull Request는 담당 Rubric, protocol, test ID, expected/actual, receipt hash를 연결한다.
5. 공유 파일은 지정 owner가 변경하고, 다른 역할은 Pull Request comment로 변경 요청을 남긴다.
6. oneM2M resource·SDT·MQTT/HTTP binding 변경은 PC-MOBIUS-CORE가 canonical contract를 갱신하고 PC-MOBIUS-INTEGRATION·앱·웹·키링이 같은 revision을 반영한다.
7. API/Auth·ACP/grant·MEC·handover·FL·MCP 변경은 PC-MOBIUS-INTEGRATION이 계약을 갱신하고 PC-MOBIUS-CORE가 resource/DB 영향 범위를 교차 확인한다.
8. 매 통합 시점에 `integration/privacy-bubble`에서 다섯 역할의 branch를 순서대로 검증하고 end-to-end receipt를 생성한다.
9. 통합 순서는 `PC-MOBIUS-CORE contract → PC-MOBIUS-INTEGRATION contract → KEYRING/Gateway → APP·WEB client → 통합시험 → Red 검증 → Blue 보완 → Green 검토`로 운영한다.
10. 각 에이전트는 완료 보고에 구현 파일, 실행 명령, 시험 결과, 로그 hash, 다음 역할에 전달할 계약을 함께 적는다.
11. 실제 비밀키·개인정보·운영 credential은 저장소의 예시 환경변수와 local secret store로 관리하고, 문서에는 schema·rotation receipt만 남긴다.

### Pull Request 본문 템플릿

```markdown
## ROLE
PC-MOBIUS-CORE | PC-MOBIUS-INTEGRATION | APP | WEB-DASHBOARD | KEYRING

## DOC / RUBRIC
- Document: PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md
- DOC-REV: <revision>
- Rubric: R01, R02, ...

## Change
- 구현 범위:
- 연결한 인터페이스:
- 변경한 oneM2M resource / API / MQTT topic / BLE characteristic:

## Verification
- Test IDs:
- Command:
- Expected:
- Actual:
- Receipt path:
- Log SHA256:

## Handoff
- 다음 역할:
- 전달할 contract revision:
- 필요한 환경·credential·endpoint:
```

### 저장소 목표 구조

```text
bubble_lock/
├─ PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md
├─ pc-mobius/
│  ├─ cse/
│  ├─ api/
│  ├─ policy/
│  ├─ mec-adapter/
│  ├─ handover/
│  ├─ fl/
│  ├─ mcp/
│  └─ tests/
├─ app/
├─ web-dashboard/
├─ keyring/
│  ├─ pcb/
│  ├─ firmware/
│  └─ raspberry-pi-gateway/
├─ contracts/
├─ tests/
├─ evidence/
└─ docs/
```

### 에이전트 간 인터페이스 인수인계

| 제공자 | 소비자 | 전달물 | 수용 조건 |
|---|---|---|---|
| KEYRING | PC-MOBIUS-CORE | BLE payload, Gateway MQTT/HTTPS payload, ACK/readback | schema hash·deviceId·sequence·commandId 일치 |
| PC-MOBIUS-CORE | PC-MOBIUS-INTEGRATION | resource·DB·wire contract | revision·migration·event schema 일치 |
| PC-MOBIUS-CORE | APP | oneM2M API·session·status API | OpenAPI revision·idempotency·receipt 일치 |
| PC-MOBIUS-CORE | WEB-DASHBOARD | resource tree·event stream API | event sequence·role scope·resync 확인 |
| PC-MOBIUS-INTEGRATION | APP | auth·consent·approval·notification API | principal·scope·TTL·grantRevision 일치 |
| PC-MOBIUS-INTEGRATION | WEB-DASHBOARD | policy·audit·handover·evidence API | operator ACP·audit receipt 생성 |
| APP | PC-MOBIUS-INTEGRATION | approvalHash·grant·incident intent | consent revision·purpose·expiry 일치 |
| WEB-DASHBOARD | PC-MOBIUS-INTEGRATION | 운영 action·조회·evidence query | role scope·audit receipt 생성 |
| PC-MOBIUS-INTEGRATION | KEYRING | desired state·deadline·epoch·commandId | device journal·ACK·readback 일치 |

### 동시 개발 체크포인트

- 매일 작업 시작 시 역할 선언과 branch 상태를 기록한다.
- 인터페이스 변경 시 같은 날 계약 JSON·테스트 fixture·문서 링크를 갱신한다.
- 통합 전 각 역할은 자신의 모듈 시험과 receipt hash를 제출한다.
- 통합 후 PC-MOBIUS-CORE와 PC-MOBIUS-INTEGRATION이 end-to-end test를 공동 실행하고, Red가 독립 교차검증을 수행한다.
- Green 검토용 후보는 HTML·contracts·calendar·fixtures·source manifest를 하나의 revision packet으로 고정한다.

## 1. 제품 개념

Privacy Bubble Keyring은 키링의 근접 관측, 라즈베리파이 현장 Gateway, oneM2M Mobius CSE, MEC 위치 서비스, 보호자 앱과 운영 대시보드를 연결한다. 보호자 승인과 ACP를 기준으로 방문자·릴레이·MEC·자동화 Agent가 접근하며, Group 제어·handover·FL·MCP 실행의 결과를 oneM2M 자원과 감사 receipt로 남긴다.

### 핵심 시나리오

1. 키링이 BLE로 관측·버튼·배터리 상태를 라즈베리파이에 전달한다.
2. 라즈베리파이 Gateway가 데이터를 검증하고 MQTT 또는 HTTPS로 Mobius CSE에 전달한다.
3. Mobius가 SDT ModuleClass·Group·Subscription·ACP로 자원과 권한을 관리한다.
4. MEC Location/RNIS 이벤트가 callback으로 들어오고, oneM2M 정책·앱·handover 상태에 반영된다.
5. 보호자 앱이 승인한 명령은 Group/fan-out으로 실행되며 구성원별 ACK와 readback을 기록한다.
6. 위치·가용성·부하 조건에 따라 Edge-A와 Edge-B 사이에서 자원·구독·Group·권한 맥락을 복원한다.
7. FL VM이 승인된 참여자와 데이터셋으로 round를 수행하고, MCP Agent가 oneM2M·MEC·Audit 도구를 승인 범위에서 실행한다.

## 2. 전체 아키텍처와 역할 경계

```text
키링 PCB·펌웨어
  │ BLE GATT
  ▼
라즈베리파이 Gateway (Role 5가 함께 담당)
  │ MQTT 3.1.1 oneM2M binding baseline 또는 Mobius probe로 확정한 지원 버전
  │ HTTPS REST + TLS/mTLS
  ▼
로컬 PC
  ├─ Mobius IN-CSE
  ├─ MQTT broker / 검증 proxy / oneM2M HTTP binding
  ├─ PostgreSQL 정책·권한·실행 정본
  ├─ Application API + OIDC/mTLS 인증
  ├─ MEC Location/RNIS Adapter + callback ingress
  ├─ Edge-A / Edge-B CSE container와 handover coordinator
  ├─ ESTIMED VM FL coordinator
  ├─ oneM2M·MEC·Audit MCP 서버
  └─ 웹 대시보드 hosting·WebSocket/SSE event gateway
       ▲                         ▲
       │ HTTPS/WebSocket          │ oneM2M resource/event
  모바일 앱                    웹 대시보드
```

### 중앙 PC의 범위

- Mobius IN-CSE와 oneM2M resource tree
- AE 등록, `cnt`, `cin`, `flexContainer`, `group`, `subscription`, `acp`
- SDT `org.onem2m.common.moduleclass.binarySwitch`, `pb:binarySwitch`, `state:boolean`
- Group/fan-out, member별 ACK/readback, command receipt
- PostgreSQL의 grants·ownership·execution·outbox·device receipt
- OIDC/mTLS, MQTT ACL, Originator binding, grant revision·expiry·revoke
- MEC service discovery, Location/RNIS subscription, callback, reconcile
- Edge-A/Edge-B 자원 복원, epoch, QUIESCING drain, CUTOVER, rollback
- FL participant·dataset·task·round·model artifact 관리
- MCP tool schema·approval hash·checkpoint·resume·audit
- 대시보드 API, event stream, test runner, release manifest

### 라즈베리파이 Gateway의 범위

Role 5가 PCB·펌웨어와 함께 구현한다.

- BLE scan·pairing·GATT characteristic 수집
- 키링 device identity·firmware revision·배터리·RSSI·timestamp 수집
- oneM2M payload 변환과 schema 검증
- TLS 연결, MQTT session, HTTPS fallback, reconnect backoff
- SQLite 또는 동등한 local queue와 durable resend
- commandId 수신·장치 실행·ACK·readback·device journal
- gateway health heartbeat와 local runtime digest
- credential 등록·회전·LOST 상태 receipt
- 중앙 PC의 current grant·epoch·deadline을 확인한 현장 실행

### 앱 담당

- Guardian·Visitor 로그인과 OIDC token 처리
- 기기 등록, household 연결, consent, 목적·TTL·scope 표시
- incident 요청, Group 명령 승인, 권한 회수·만료 표시
- 키링·Gateway·MEC 위치·handover 상태 조회
- push/in-app 알림과 command receipt 확인
- 앱 API의 idempotency key, correlation ID, retry, reconnect
- 사용자 접근 범위에 맞춘 ACP/UI 검증

### 웹 대시보드 담당

- 운영자·보호자용 resource tree와 실시간 상태 화면
- 장치·Gateway·CSE·MEC service health
- Group 구성, fan-out 결과, member별 ACK/readback
- 위치 이벤트·geofence·handover timeline
- grant·ACP·consent·audit receipt 검색
- FL round와 model lineage 표시
- MCP run 상태와 승인 hash 확인
- Article·영상·GitHub·시험 receipt를 연결하는 evidence view

### 키링 담당

- PCB schematic·layout·BOM·조립 revision
- BLE GATT service/characteristic과 firmware state machine
- 센서·버튼·LED·부저·배터리·충전·보호 회로
- `observation`, `battery`, `button`, `command receipt` payload
- 저전력 상태, wake event, reconnect, command ACK
- 라즈베리파이 Gateway daemon과 device adapter
- PCB·firmware·Gateway 통합시험과 실물 영상 증거

## 3. 프로토콜과 데이터 계약

### BLE GATT: 키링 ↔ 라즈베리파이

- 고정 항목: service UUID, characteristic UUID, MTU, payload version, firmware version
- 관측 필드: `deviceId`, `sequence`, `observedAt`, `rssi`, `battery`, `buttonState`, `sensorValues`
- 명령 필드: `commandId`, `desiredState`, `issuedAt`, `grantRevision`, `ownershipEpoch`, `deadline`
- 결과 필드: `commandId`, `acceptedAt`, `appliedAt`, `ackCode`, `readback`, `firmwareRevision`
- 시험: pairing, reconnect, RSSI 변화, 배터리 경보, ACK timeout, 동일 commandId 재수신

### MQTT: 라즈베리파이 ↔ Mobius

Mobius broker capability probe 결과를 release manifest에 기록하고 oneM2M binding 버전을 고정한다.

- TLS/mTLS identity와 broker ACL
- clientId, keepalive, session expiry, reconnect backoff
- request topic, response topic, event topic, dead-letter topic
- QoS, retain/session 정책, packet identifier, correlation data
- `X-M2M-Origin`, `X-M2M-RI`, `X-M2M-RVI`, `ty`, `rsc` 매핑
- `commandId`, `claimId`, `grantRevision`, `ownershipEpoch`, `payloadHash`
- offline queue, resend, dedup, ACK/readback, timeout receipt
- 시험: broker 재시작, Gateway 재시작, topic ACL, 다른 Originator, duplicate publish, out-of-order event

### HTTPS REST: 앱·대시보드·Gateway ↔ PC API

- TLS 1.3 baseline, Gateway mTLS, 사용자 OIDC issuer·audience·subject·expiry
- principal→canonical AE originator binding
- request ID, correlation ID, idempotency key, API version
- `200`, `201`, `202`, `204`, `4000`, `4030`, `4040`, `4125` 결과 매핑
- retry-after, timeout, structured error, audit receipt

### oneM2M resource contract

- `AE` 등록 receipt와 AE-ID
- `cnt`·`cin` 기반 observation/FL/audit resource
- `flexContainer` SDT: `cnd=org.onem2m.common.moduleclass.binarySwitch`
- wire envelope: `pb:binarySwitch`
- datapoint: mandatory RW `state:boolean`
- `group`과 fan-out point, member별 `macp`, member별 ACK/readback
- `subscription`과 notification callback
- `acp`의 `pv`·`pvs` 분리, role별 CRUDN/DISCOVER
- discovery: `fu=1`, `ty=28`, `cnd=...binarySwitch`

### MEC 양방향 계약

- MEC011 service discovery
- Location `/location/v2/subscriptions/userTracking`
- RNIS `/rni/v2/subscriptions`
- POST·GET·PUT·DELETE와 operationId·status·schema
- subscription ID, callback route token, service generation, grant revision
- `clientCorrelator`, `callbackData`, `filterCriteriaAssocHo`
- `eventId`, `sequence`, `observedAt`, `receivedAt`, `uncertainty`, `simulation`
- dedup 24시간, stale 30초, future 2초, 30초 desired/actual reconcile
- endpoint 교체, restart, orphan cleanup, late callback, tombstone

### WebSocket 또는 SSE: PC API ↔ 대시보드

- event type, sequence, resource URI, current revision, receivedAt
- connection token과 role scope
- reconnect 후 last sequence부터 resync
- command receipt·MEC event·handover state·FL state·MCP run 표시

### MCP

- oneM2M 서버: `discoverDevices`, `readGrant`, `draftPolicy`, `applyApprovedPolicy`
- MEC 서버: `reconcileApprovedIntent`
- Audit 서버: `readExecution`, `appendRunEvidence`
- JSON Schema 2020-12, required/type/enum/size, `additionalProperties=false`
- audience·scope·approvalHash·idempotencyKey·timeout·checkpoint·resume

## 4. Rubric 17개 항목과 담당자

| 항목 | Expert 구현 기준 | 주 담당 | 협업 |
|---|---|---|---|
| R01 | Group/fan-out, member ACP, 실제 ACK/readback, retry | PC-MOBIUS-CORE | 키링·앱 |
| R02 | BLE·MQTT·HTTPS·WebSocket의 조건별 사용과 패킷 시험 | KEYRING | PC-MOBIUS-CORE·앱·웹 |
| R03 | 키링→Gateway→CSE→복수 앱의 사건 흐름 | PC-MOBIUS-CORE | PC-MOBIUS-INTEGRATION·앱·웹·키링 |
| R04 | HW·자원·프로토콜·효과·재현을 담은 Article | WEB-DASHBOARD | PC-MOBIUS-INTEGRATION |
| R05 | 실물·모의·실측을 구분한 5분 미만 영상 | 키링 | 전원 |
| R06 | 독립 GitHub, build/deploy/test/replay와 release SHA | PC-MOBIUS-INTEGRATION | 전원 |
| R07 | oneM2M 도입 효과를 코드·설정·지연으로 비교 | PC-MOBIUS-CORE | WEB-DASHBOARD |
| R08 | 공개 기술 질문·응답·재현 commit·후속 기여 | 웹 | PC |
| R09 | 구성원별 구조 설명·장치 교체·회수·전환 리허설 | 앱 | 전원 |
| R10 | TLS/mTLS, OIDC, MQTT ACL, ACP, grant 수명·회수 | PC-MOBIUS-INTEGRATION | 앱·키링 |
| R11 | TS-0023 SDT, schema, discovery, 공급자·클라이언트 교체 | PC-MOBIUS-CORE | 키링 |
| R12 | 위치/health 기반 handover, 상태·구독·보안 맥락 복원 | PC-MOBIUS-INTEGRATION | 키링·웹 |
| R13 | 프로젝트 지리·host inventory·MEC/VM orchestration | PC-MOBIUS-INTEGRATION | WEB-DASHBOARD |
| R14 | ESTIMED VM, dynamic selection, resilient multi-round FL | PC-MOBIUS-INTEGRATION | APP |
| R15 | BLE 관측·MEC UE 위치·oneM2M 정책·geofence | PC-MOBIUS-INTEGRATION | 키링·앱 |
| R16 | Location·RNIS 두 MEC 서비스의 양방향 trace | PC-MOBIUS-INTEGRATION | WEB-DASHBOARD |
| R17 | 복수 MCP 서버, 승인 hash, persistent run, resume | PC-MOBIUS-INTEGRATION | 앱·웹 |

R04~R09는 구현 결과를 Article·영상·GitHub·공개 토론·면접 evidence로 연결한다. 각 항목은 `rubricId → sectionId → contract → testId → owner → gate → receipt` 순서로 추적한다.

## 5. 작업 패키지와 산출물

### PC-MOBIUS-CORE 담당 산출물

- Mobius runtime configuration과 Docker/실행 명령
- oneM2M resource tree·SDT registry·XSD lineage
- MQTT broker/proxy·HTTP binding·Originator binding
- PostgreSQL schema와 migration
- Group/fan-out·dispatch·ACK/readback
- core OpenAPI/JSON Schema·resource integration tests
- Mobius runtime release manifest·replay command·runtime receipt

### PC-MOBIUS-CORE 현재 구현 기준

학교 PC에서는 저장소 내부 `pc-mobius/`를 임시 통합 기준으로 사용한다. 실제 Mobius4 소스는 별도 경로로 유지하고 `MOBIUS4_ROOT` 환경변수로 연결하여, 다른 PC에서도 같은 실행 명령과 계약 fixture를 재사용한다.

- `pc-mobius/contracts/oneM2M-test-contract.v1.json`: AE·flexContainer·subscription·group·discovery·MQTT/HTTP 계약과 예상 응답 코드
- `pc-mobius/contracts/raspberrypi-gateway.v1.json`: BLE payload·MQTT topic·HTTPS 보조 전송·ACK/readback 계약
- `pc-mobius/specializations/binarySwitch.xsd`: `org.onem2m.common.moduleclass.binarySwitch`를 위한 TS-0023 flexContainer schema
- `pc-mobius/scripts/prepare-specialization.mjs`: Mobius4 registry에 schema를 병합하고 기존 registry 백업 생성
- `pc-mobius/src/gateway-bridge.mjs`: Raspberry Pi MQTT telemetry·command·ACK를 oneM2M HTTP resource와 receipt로 연결
- `pc-mobius/src/receipt-journal.mjs`: JSONL 영수증과 SHA-256 hash를 영속화하는 저장소
- `pc-mobius/src/group-dispatcher.mjs`: oneM2M Group/fan-out·member ACK/readback·pending retry
- `pc-mobius/src/gateway-bridge.mjs`: HTTP binding과 MQTT binding을 동일 receipt contract로 지원
- `pc-mobius/db/migrations/001_core_receipts.sql`: gateway·dispatch·receipt·oneM2M binding PostgreSQL 정본
- `pc-mobius/release/manifest.json`: CORE artifact·hash·replay command release 정본
- `pc-mobius/scripts/validate-contract.mjs`: 계약 구조·헤더·응답 코드·프로토콜 경로를 자동 검증
- `pc-mobius/scripts/run-contract.mjs`: 실행 중인 Mobius4에 HTTP 계약을 순서대로 전송하고 JSON receipt 생성
- `pc-mobius/scripts/start-mobius4-test.ps1`: 환경변수 기반 Mobius4 실행 래퍼(포트·DB·MQTT는 Mobius4 설정으로 주입)
- `pc-mobius/config/mobius4-test.env.example`: 학교 PC와 후속 PC에서 공통으로 쓰는 실행 변수 템플릿

CORE 개발자는 모든 wire 변경을 먼저 계약 fixture와 문서 개정에 반영하고, 실행 결과를 `pc-mobius/receipts/`에 저장한다. 통합 담당자는 동일한 `DOC-REV`와 계약 파일을 기준으로 API/Auth·MEC·callback·handover·FL·MCP를 연결한다.

### PC-MOBIUS-INTEGRATION 담당 산출물

- API gateway·OIDC/mTLS·principal/originator binding
- ACP·grant·consent·approval·audit policy service
- MEC Location/RNIS adapter·callback ingress·reconcile
- Edge-A/Edge-B handover coordinator·epoch·rollback
- ESTIMED VM FL coordinator·artifact serving fence
- MCP oneM2M/MEC/Audit server와 persistent run DB
- integration runner·fault fixtures·release evidence·replay report

### 앱 담당 산출물

- Guardian/Visitor 화면
- OIDC login과 token refresh
- device/household registration
- consent·grant approval·revoke·expiry
- incident·Group command·notification
- live status·location·handover·FL status
- API client retry/idempotency/reconnect
- 모바일 통합시험 receipt와 발표용 화면 녹화

### 웹 대시보드 담당 산출물

- 운영 화면·resource tree·device inventory
- realtime event stream과 reconnect resync
- Group·member ACK·readback 화면
- policy·ACP·audit·handover timeline
- MEC subscription/callback 상태
- FL round/model lineage와 MCP run view
- Article·영상·GitHub·시험 evidence index
- 브라우저 QA screenshot과 접근성 확인 결과

### 키링 담당 산출물

- KiCad schematic·PCB·BOM·assembly revision
- firmware source·build·flash 명령
- BLE GATT profile과 payload schema
- sensor/button/LED/battery/charger 동작
- Raspberry Pi Gateway daemon
- MQTT/HTTPS transport client
- local queue·dedup·ACK/readback
- power·range·reconnect·command execution 시험
- PCB 실물·Gateway·앱 연동 영상

## 6. 완료 기준

각 기능은 아래 7개 자료를 함께 갖추면 완료 상태로 표시한다.

1. 인터페이스 계약(JSON Schema/OpenAPI/oneM2M resource)
2. 구현 코드와 configuration
3. 단위·통합·장애 시험
4. 기대 결과와 실제 결과
5. 담당자·검토자·gate ID
6. 로그·receipt·artifact hash
7. release manifest와 문서 연결

상태 값은 `planned → implemented → verified → released`를 사용한다. 실제 실행 결과는 `planned` 설계값과 `verified` receipt를 분리해 기록한다.

## 7. 개발 순서와 gate

### Stage 0: 공통 계약

- 네 담당자가 이 문서를 읽고 branch·owner·interface를 등록한다.
- BLE, MQTT, HTTPS, oneM2M, MEC, API, receipt schema를 고정한다.
- Mobius capability probe와 runtime digest를 기록한다.

### Stage 1: 핵심 데이터 경로

- 키링 PCB → BLE → Raspberry Pi
- Raspberry Pi → MQTT/HTTPS → Mobius CSE
- Mobius → API → 앱·웹
- observation·command·ACK·readback의 end-to-end receipt

### Stage 2: oneM2M 복합 서비스

- SDT binarySwitch
- discovery query
- Group/fan-out
- Subscription notification
- role별 ACP·grant

### Stage 3: MEC·보안·연속성

- Location/RNIS service discovery와 양방향 callback
- callback dedup·reconcile·tombstone
- permit claim·revoke·expiry·dispatch
- Edge-A/B handover·drain·epoch·rollback

### Stage 4: FL·MCP

- ESTIMED VM 등록
- participant·dataset·task·round·update·result
- consent revision·dynamic selection·crash recovery
- MCP approval·tool execution·checkpoint·resume·audit

### Stage 5: 공개 증거

- Article, 5분 미만 영상, stand-alone GitHub
- 공개 기술 토론 기록
- 구성원별 interview rehearsal
- A01~A26 시험 결과와 release SHA

주요 gate는 G-SDT, G-SEC, G-MEC, G-CONT, G-RELEASE, G-SUBMIT으로 관리하며, 각 gate에 performer·approver·hostId·runtime digest·testId·expected·actual·logSha256·artifactRef를 기록한다.

## 8. Red·Blue·Green 운영 방식

1. Red가 독립적으로 계약·프로토콜·시험·근거를 점검한다.
2. Blue가 findings를 구현 계약과 fixture로 반영한다.
3. Green이 고정된 17개 기준으로 전체 항목을 다시 검토한다.
4. 후보 HTML·계약·첨부 파일의 SHA256을 packet에 고정한다.
5. Green의 17개 점수, 총점, 추가 수용 조건, announcement를 보존한다.
6. 실제 구현 receipt는 설계 점수와 별도 release evidence로 연결한다.

새 기능을 추가할 때마다 이 문서의 담당자 표, 프로토콜 표, Rubric 매핑, 시험 ID, gate receipt schema를 같은 회차에 갱신한다.

## 9. 첫 번째 통합 데모 수용 조건

- 키링이 BLE로 상태를 전송한다.
- 라즈베리파이가 MQTT 또는 HTTPS로 Mobius에 전달한다.
- Mobius가 oneM2M 자원과 `pb:binarySwitch/state`를 저장한다.
- 앱에서 승인한 Group 명령이 키링에 도달한다.
- 키링이 ACK와 readback을 반환한다.
- 웹 대시보드가 수락·전송·적용·확인 시각을 표시한다.
- 권한 회수 후 신규 명령이 최신 grant 기준으로 판정된다.
- MEC Location 또는 RNIS 이벤트가 callback으로 들어와 정책에 반영된다.
- 동일 commandId의 재시작·재전송 결과가 하나의 receipt로 정산된다.

이 통합 데모를 기반으로 handover·FL·MCP와 공개 evidence를 연결해 Rubric 17개 Expert 경로를 완성한다.
