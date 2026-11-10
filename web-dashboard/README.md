# BubbleLock WEB-DASHBOARD

Privacy Bubble Keyring 운영 대시보드입니다. React·TypeScript 화면, CORE·INTEGRATION 영수증 JSONL 재생, SSE 재개, 자원 조회, 감사 검색과 MEC·handover·FL·MCP 상태 표시를 제공합니다.

## 통합 기준

- 역할: WEB-DASHBOARD / DOC-REV 2.0.0
- 공통 기준: [PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md](../PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md)
- 이벤트 계약: [dashboard-event.schema.json](contracts/dashboard-event.schema.json), schemaVersion 1.0.0
- 원본: CORE GatewayBridge·GroupDispatcher, KEYRING Gateway, PC-MOBIUS-INTEGRATION의 journal
- 표시 범위: 로컬 재생 snapshot, `simulation:true`, loopback HTTP
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

서버는 시작 시 파일을 한 번 읽습니다. 파일 갱신 후 서버를 다시 실행하고 화면의 **처음부터 재동기화**로 새 snapshot을 읽습니다.

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

`npm test`의 24개 시험은 CORE 계약, SSE cursor/HTTP, Group 타임라인, 통합 runtime journal 생성·검색·재생, canonical 키링 명령·ACK·telemetry 호환을 검증합니다. `npm run typecheck`, `npm run typecheck:contract`, `npm run build`로 TypeScript와 배포 파일을 검사합니다.

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
