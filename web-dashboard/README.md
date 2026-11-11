# BubbleLock WEB-DASHBOARD

Privacy Bubble Keyring 사용자·운영 대시보드입니다. 시작 화면에서 가족용 화면과 운영 화면으로 진입합니다. 지도에는 키링별 GPS·MEC 핀, 위치 정확도 원, 수신기 중심 BLE 거리 원을 표시합니다.

## 역할별 화면

| 진입 경로 | 기능 |
|---|---|
| `/#/` | 사용자·운영 대시보드 선택 |
| `/#/user/overview` | 내 키링·권한·알림 요약 |
| `/#/user/map` | 가구와 현재 공유 권한 범위의 키링 지도 |
| `/#/user/devices` | 가구 생성·등록 Gateway 기기 연결 |
| `/#/user/privacy` | 동의 목적·scope·TTL, 권한 발급과 회수 |
| `/#/user/activity` | 방문자 명령 요청·보호자 승인·도움 요청·알림 |
| `/#/operator/overview` | CORE·INTEGRATION journal, 명령·자원·감사·서비스 |
| `/#/operator/evidence` | ZIP 및 R01–R17/A01–A26 추적 감사 |

기본 실행은 `.local/portal-demo/state.json`의 체험 가구와 키링을 사용합니다. 사용자 체험 요청은 격리된 실행 대기열에 기록하며 실물 적용은 Gateway ACK/readback을 기준으로 판정합니다. 체험 지도는 모의 관측만 사용합니다. 방문자 위치는 현재 활성 `location:read` grant와 consent revision을 조회마다 검사합니다. 권한·로그인 연결이 바뀌면 사용자 지도의 기존 좌표를 비웁니다.

실제 계정은 `PORTAL_CONFIG_FILE`에 OIDC와 중앙 HTTPS API를 설정하여 연결합니다. [로그인·배포 안내](docs/oidc-session.md), [설정 예시](config/oidc.example.json)를 참조하세요. 실계정은 서버 세션의 principal과 토큰으로 처리하며 운영 API는 `dashboard:read` scope를 확인합니다. 외부 API 호출은 TLS 1.3과 등록된 CA로 검증합니다.

## 통합 기준

- 역할: WEB-DASHBOARD / DOC-REV 2.0.0
- 공통 기준: [PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md](../PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md)
- 이벤트 계약: [dashboard-event.schema.json](contracts/dashboard-event.schema.json), schemaVersion 1.0.0
- 원본: CORE GatewayBridge·GroupDispatcher, KEYRING Gateway, PC-MOBIUS-INTEGRATION의 journal
- 표시 범위: 명령 journal 재생과 독립적인 위치 관측 피드, loopback HTTP, 관측별 실측·모의 출처
- 운영 인증과 권한 판정: PC-MOBIUS-INTEGRATION의 배포 설정

## 빠른 실행

Node 22.19.0 이상과 npm을 사용합니다. Node의 TypeScript 실행 기능으로 서버와 시험을 실행하며 Vite 7로 화면을 빌드합니다. 다음 명령은 `web-dashboard/`에서 실행합니다.

```sh
npm ci
npm test
npm run typecheck:contract
npm run build
npm run sse
```

별도 터미널에서 `npm run dev`를 실행하고 `http://127.0.0.1:5173`을 엽니다. Vite는 `/events`와 `/api`를 `127.0.0.1:4174`로 프록시합니다. `npm run preview`는 빌드된 화면을 제공합니다.

저장소 루트의 통합 명령도 사용할 수 있습니다.

```sh
npm run setup
npm run verify
npm run demo
npm run events
npm run dashboard
```

`events`와 `dashboard`는 각각 별도 터미널에서 실행합니다. 통합 journal 경로는 아래 `RECEIPT_FILE` 설정으로 선택합니다.

## 키링 위치 지도

사용자 **키링 위치**와 운영 **위치 지도**에서 키링을 선택하면 핀·BLE 수신기 중심 원과 관측 상세를 확인할 수 있습니다. 기본 화면은 서울시청 주변의 모의 키링 3개를 제공합니다. 실측 GPS·MEC·Gateway 관측은 `LOCATION_FILE`, 수신기 좌표·교정값은 `GATEWAY_LOCATIONS_FILE`로 연결하며 5초마다 갱신합니다.

실측 파일 연결과 데이터 예시는 [위치 연동 안내](docs/location-feed.md)에 정리했습니다. 기본 배경은 Stadia Alidade Smooth, 일반 지도는 OpenStreetMap입니다. `VITE_MAP_TILE_URL`·`VITE_MAP_ATTRIBUTION`으로 공급자를 설정하며 공개 배포의 키·도메인 설정은 [지도 디자인 안내](docs/map-design.md)에 있습니다.

## 통합 journal 연결

저장소 루트에서 데모를 만든 뒤 대시보드에 연결합니다.

```powershell
npm --prefix pc-mobius run integration
$env:RECEIPT_FILE = (Resolve-Path 'pc-mobius/receipts/integration-demo.jsonl').Path
npm --prefix web-dashboard run sse
```

CORE와 INTEGRATION 기록을 한 파일에 넣어도 같은 순서로 재생합니다.

| 원본 | `source` | 화면 |
|---|---|---|
| 기본 fixture | `fixture-replay` | 명령 타임라인·자원·감사 데모 |
| CORE JSONL | `core-journal-replay` | 명령·장치 receipt |
| INTEGRATION 포함 JSONL | `integration-journal-replay` | 명령·정책·MEC·handover·FL·MCP·Gateway 기록 |

`/api/audit?q=`는 통합 journal의 기록을 검색합니다. 서비스 카드에는 최신 receipt의 상태, 식별자, epoch, hash와 기록 시각을 표시합니다. `/api/resources`는 자원 fixture를 제공하며, 자원 화면의 Mobius 설정으로 실제 discovery/retrieve 경로를 선택할 수 있습니다.

명령 SSE는 시작 시 journal을 한 번 읽습니다. 명령 파일 갱신 후 서버를 다시 실행하고 화면의 **처음부터 재동기화**로 새 snapshot을 읽습니다. 위치 피드의 `LOCATION_FILE`은 실행 중 추가되는 관측을 읽습니다.

## 계약 호환

- CORE 기존 명령과 KEYRING의 10필드 canonical 명령을 함께 수용합니다.
- KEYRING의 `gatewayReceipt`, `{state:false}` readback, `grantRevision`, `ownershipEpoch`, `payloadHash`를 보존합니다.
- telemetry의 `bootId`, `firmwareSequence`, `gatewayId`, `timestampSource`, RSSI 범위 `-127..20`을 CORE 계약과 공유합니다.
- INTEGRATION의 공통 `contractId`, `docRevision`, `eventId`, `timestamp`를 검증하고 원본 필드를 보존합니다.
- 외부 journal은 원본 timestamp와 receiptHash를 유지합니다. API 수락 단계는 명시적인 acceptance 이벤트를 통해 채웁니다.
- 필드 대응과 단계 시각은 [receipt-mapping.md](docs/receipt-mapping.md)에 정리했습니다.

## SSE 재개

- SSE `id`는 snapshot 내 1부터 시작하는 스트림 `sequence`입니다.
- `Last-Event-ID` 또는 `lastSequence` 다음 번호부터 재개하며 헤더를 우선합니다.
- 잘못된 cursor는 400, snapshot 끝을 넘는 cursor는 409와 `resync_required`를 반환합니다.
- 재생 완료 후 연결을 유지하며 15초 간격 heartbeat를 보냅니다.
- 화면은 마지막 유효 cursor와 누적 명령 상태를 보존하고 최근 100개 이벤트를 표시합니다.
- 자원 revision은 adapter 설정값 또는 `null`, roleScope는 표시 메타데이터입니다.

## 검증

`npm test`는 CORE 계약·SSE cursor·Group 타임라인·통합 runtime journal·키링 위치·사용자 포털·OIDC 세션과 권한 경계를 검증합니다. `npm run typecheck`, `npm run typecheck:contract`, `npm run build`로 TypeScript와 배포 파일을 검사합니다. 루트 `npm run verify`에는 실제 TLS API와 BFF upstream 호출 시험도 포함됩니다.

[test/integration-compat.test.ts](test/integration-compat.test.ts)는 병합된 PC 모듈을 직접 실행하여 정책→MEC→handover→FL→MCP receipt를 만든 뒤 대시보드에 전달합니다. 장치 BLE·실물 Pi 검증은 KEYRING의 장비 시험 절차와 연결합니다.

2026-11-10 통합 데모의 22개 receipt를 [재생 원본](evidence/2026-11-10-integration-demo.jsonl)과 [검증 기록](evidence/2026-11-10-integration-verification.json)에 보관했습니다. Handover ACTIVE, FL COMPLETED, MCP RUN_COMPLETED를 확인했습니다. 현재 산출물 hash는 [release manifest](docs/release-manifest.json)에 있습니다.

## 이전 시각 검증 자료

2026-10-29 기록은 당시 화면 기준으로 보관합니다.

- [브라우저 동작 기록](evidence/browser-qa.json)
- [HIG 판정](evidence/hig-visual-qa.md)
- [화면 캡처·해시](evidence/hig/capture-manifest.json)
- [실측 시험 기록](evidence/hig/round2-proof.json)
- [프로토콜 1차 자료](docs/primary-sources.md)
- [Article 초안](docs/R04-article.md)
- [2026-10-29 release manifest](docs/release-manifest-2026-10-29.json)

## 디렉터리

| 경로 | 내용 |
|---|---|
| `contracts/` | 이벤트 JSON Schema |
| `shared/` | 타입, 검증, receipt adapter, 타임라인, 통합 서비스 표시 |
| `server/` | JSONL snapshot, SSE·HTTP 서버 |
| `src/` | React 화면 |
| `fixtures/` | 명령·자원·감사 시험 자료 |
| `test/` | 단위·HTTP·모듈 간 호환 시험 |
| `evidence/`, `docs/` | 검증 이력과 설계 자료 |
