# BubbleLock WEB-DASHBOARD

Privacy Bubble Keyring의 운영 대시보드입니다. Vite + React + TypeScript 화면과, CORE 영수증 JSONL을 재생하는 작은 SSE 서버로 구성됩니다. 지금 화면에 보이는 데이터는 모두 **모의(simulation)** 입니다. 실제 Mobius, 장치, 인증 경로에서 받은 데이터는 아직 없습니다.

## 역할 선언

```text
ROLE: WEB-DASHBOARD
DOC: PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md
DOC-REV: 2.0.0
RUBRIC: R03, R04, R05, R06, R07, R08, R09, R12, R15, R16, R17
SCOPE: 대시보드 이벤트 계약, 영수증 재생 SSE 서버(Last-Event-ID 재개), 명령 수락·전송·적용·확인 타임라인, Group 구성원별 ACK·readback, oneM2M 자원 트리(fixture와 실서버 discovery 설정), 감사 검색(모의), MEC·handover·FL·MCP 틀(모의), evidence index, R04 Article 뼈대
INTERFACES: GET /events (SSE, message 이벤트, lastSequence 쿼리, Last-Event-ID), GET /api/source, GET /api/resources, GET /api/audit?q=, Mobius4 HTTP discovery (fu=1&drt=1&ty=28&cnd=org.onem2m.common.moduleclass.binarySwitch), pc-mobius 영수증 JSONL
TESTS: test/contract.test.ts, test/sse.test.ts, test/timeline.test.ts (21개), npm run typecheck:contract, npm run build, 부모 브라우저 QA(390px, 1440px)
EVIDENCE: web-dashboard/evidence/, docs/release-manifest.json
DEPENDENCIES: CORE는 영수증 필드를 그대로 유지하고 acceptedAt·currentRevision 공급 방식을 정한다. INTEGRATION은 connection token·role scope 권한 판정·감사 API를 정한다.
```

## 빠른 실행

Node 24 이상과 npm이 필요합니다. 모든 명령은 `web-dashboard/`에서 실행합니다.

```sh
npm ci                      # package-lock.json 기준 설치
npm test                    # node --test test/*.test.ts
npm run typecheck:contract  # shared/server/test 타입 검사
npm run build               # tsc --noEmit && vite build -> dist/
npm run sse                 # 127.0.0.1:4174, 기본 데모 재생 + 표시된 수락 이벤트
npm run dev                 # 127.0.0.1:5173, /events 와 /api 는 4174로 프록시
```

화면을 보려면 터미널 두 개에서 `npm run sse`와 `npm run dev`를 띄우고 `http://127.0.0.1:5173`을 엽니다. `npm run preview`는 정적 파일만 내보내므로 API 서버 역할을 하지 않습니다.

### 실제 영수증 JSONL 재생

```sh
RECEIPT_FILE=/absolute/path/to/pc-mobius/receipts/<journal>.jsonl npm run sse
RECEIPT_FILE=./fixtures/core-partial.jsonl npm run sse
```

- `RECEIPT_FILE`을 주면 `source`가 `core-journal-replay`가 되고, 수락(acceptance) 이벤트는 붙지 않습니다. 그래서 화면의 "수락" 단계는 대기로 남습니다.
- 서버는 시작할 때 파일 전체를 한 번 읽는 불변 snapshot입니다. 파일을 계속 따라 읽지 않습니다. 파일이 바뀌면 서버를 다시 띄우고 화면에서 "처음부터 재동기화"를 누릅니다.
- 형식이 틀린 줄이 있으면 1부터 센 줄 번호와 함께 시작이 실패합니다. 모르는 필드나 ACK 상태도 거부합니다.
- 외부 파일을 재생해도 이벤트에는 `simulation:true`가 붙고, 자원과 감사 응답은 계속 fixture입니다.

## SSE 재개 규칙 (EventSource)

- 이름 없는 `message` 이벤트만 씁니다. 종류는 JSON 안의 `type`으로 구분합니다.
- SSE `id`와 JSON `sequence`는 같은 값이고, 재생 adapter가 1부터 매기는 스트림 번호입니다. 영수증의 `sequence`와는 다릅니다.
- 재개는 커서 **다음**부터입니다. `/events?lastSequence=N` 또는 `Last-Event-ID: N`을 쓰며, 둘 다 있으면 `Last-Event-ID`가 이깁니다.
- 숫자가 아닌 커서는 `400`, snapshot 끝보다 큰 커서는 `409 resync_required`입니다. 이 경우 0부터 다시 받아야 합니다.
- 재생이 끝나면 주석 한 줄을 보내고 연결을 유지하며, 15초마다 heartbeat 주석을 보냅니다.
- 화면은 검증에 실패한 이벤트에서 커서를 올리지 않습니다. 네트워크 오류가 나면 EventSource를 닫고, 사용자가 다시 연결을 눌러야 합니다. 브라우저 자동 재연결이 검증된 상태를 앞지르지 못하게 하려는 선택입니다.
- 중복이나 더 오래된 id는 무시하고 `ignoredEvents`만 올립니다.

자세한 필드 대응은 [docs/receipt-mapping.md](docs/receipt-mapping.md)에 있습니다. 요약하면, CORE 영수증에는 **API 수락 시각이 없습니다**. 지금 수락 시각은 fixture 래퍼 [fixtures/api-acceptance.json](fixtures/api-acceptance.json)에서만 오고, 구성원별 수락은 항상 대기로 남습니다. `currentRevision`도 CORE가 주지 않아 `null`입니다.

## 시뮬레이션 범위와 미확인 항목

| 영역 | 상태 |
|---|---|
| 명령 타임라인 | CORE `GatewayBridge`·`GroupDispatcher`·`hashReceipt`로 만든 fixture 영수증 재생. 장치 실행 아님 |
| 자원 트리 | 기본은 [fixtures/resources.json](fixtures/resources.json). 실서버 모드는 구현했지만 실제 Mobius에서 시험하지 않음 |
| 감사 검색 | [fixtures/audit.json](fixtures/audit.json), 화면에 "모의" 표시 |
| MEC Location/RNIS, handover, FL, MCP | 화면 틀만 있음. "모의/미연결" 표시. 측정값과 hash 없음 |
| 인증 | 없음. `/api/source`가 `authentication:'none-loopback-mock'`, `roleScopeIsAuthorization:false`를 돌려줌. `roleScope`는 권한 판정이 아님 |

아직 확인하지 못한 것:

- 실제 Mobius4 실행본의 SHA, endpoint, TLS. 근거 조사는 고정한 upstream 커밋 기준입니다. [docs/primary-sources.md](docs/primary-sources.md)
- 운영자 AE originator와 ACP의 DISCOVER·RETRIEVE 권한. ACP 값은 화면 설정에만 있고 헤더로 보내지 않습니다.
- 브라우저 CORS, preflight, `X-M2M-RSC` 같은 응답 헤더 노출 여부.
- `X-M2M-RVI=4` 지원(기본값은 3), 설치된 binarySwitch SDT registry.
- CORE 계약 `oneM2M-test-contract.v1.json`의 `ty=4`와 표준·upstream `ty=28` 불일치. CORE 소관이라 여기서는 고치지 않았습니다.
- 영수증 `hash`는 그대로 보존만 하고 암호학적으로 검증하지 않습니다.
- 운영용 connection token, 지속 global sequence, 배포 호스팅 라우팅.

## 6절 완료 기준 7개 자료

| # | 기준 | 자료 |
|---|---|---|
| 1 | 인터페이스 계약 | [contracts/dashboard-event.schema.json](contracts/dashboard-event.schema.json) (JSON Schema 2020-12, 1.0.0), [docs/receipt-mapping.md](docs/receipt-mapping.md), [docs/primary-sources.md](docs/primary-sources.md) |
| 2 | 구현 코드와 configuration | [shared/](shared/), [server/](server/), [src/](src/), [package.json](package.json), [vite.config.ts](vite.config.ts), [tsconfig.json](tsconfig.json) |
| 3 | 단위·통합·장애 시험 | [test/contract.test.ts](test/contract.test.ts), [test/sse.test.ts](test/sse.test.ts) (실제 loopback HTTP), [test/timeline.test.ts](test/timeline.test.ts), 장애 fixture [fixtures/malformed-events.json](fixtures/malformed-events.json), [fixtures/core-partial.jsonl](fixtures/core-partial.jsonl) |
| 4 | 기대 결과와 실제 결과 | [docs/release-manifest.json](docs/release-manifest.json)의 `checks`, HTTP SSE 실측 [evidence/http-sse.json](evidence/http-sse.json) |
| 5 | 담당자·검토자·gate ID | [docs/release-manifest.json](docs/release-manifest.json)의 `owner`, `reviewer`, `gates` (부모 self-review, G-WEB-DEMO; 독립 프로젝트 release 승인은 별도) |
| 6 | 로그·receipt·artifact hash | [evidence/](evidence/), [docs/release-manifest.json](docs/release-manifest.json)의 `artifacts` |
| 7 | release manifest와 문서 연결 | [docs/release-manifest.json](docs/release-manifest.json), [docs/R04-article.md](docs/R04-article.md), [DESIGN.md](DESIGN.md), [기준 문서](../PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md) |

상태는 기준 문서대로 `planned → implemented → verified → released`를 씁니다. 모의 대시보드 동작은 브라우저에서 확인했으며, 실제 장치·Mobius 통합과 프로젝트 release 승인은 별도입니다. 초기 기능 데모는 부모 self-review로 확인했고, 아래 HIG 시각 보정은 별도 독립 검토를 통과했습니다. 항목별 범위는 각 증거 문서에 적었습니다.

### 브라우저 검증 증거

- [동작·요청 기록](evidence/browser-qa.json): 네 단계 시각, 부분 실패, 감사 검색·빈 결과, false 상태, 재연결 상태 보존.
- [데스크톱 light](evidence/desktop-light.png), [dark](evidence/desktop-dark.png), [부분 실패](evidence/desktop-partial.png): 1440px.
- [모바일 light](evidence/mobile-light.png), [dark](evidence/mobile-dark.png), [하단](evidence/mobile-end.png): iPhone 14, 390 CSS px. 긴 전체 캡처는 Chrome의 16383 device-pixel 제한에 걸려 하단을 별도로 캡처했습니다.
- [discovery HTTP fixture](evidence/discovery-http-fixture.png), [HTTP 오류](evidence/discovery-error.png): 공식 `m2m:uril`/`pb:binarySwitch` 형태의 로컬 모의 서버로 discovery와 개별 GET을 확인했습니다. 실제 Mobius 실배포 확인은 아닙니다.

### HIG 시각 보정 검증 (2026-10-29)

위 기능 캡처는 초기 `2529e0a`의 기록입니다. 최신 시각 보정은
[항목별 HIG 판정](evidence/hig-visual-qa.md), [Apple 1차 자료](docs/hig-sources.md),
[현재 캡처·해시](evidence/hig/capture-manifest.json),
[실측·최종 시험 기록](evidence/hig/round2-proof.json)을 참조하세요.
390/1440/1920px 밝은·어두운 테마와 상태 화면 87장, 수정 전후 58쌍을
기록했고 독립 최종 검토에서 69항목 중 PASS 53, N/A 16, FAIL 0을 받았습니다.
한국 시간 KST(+09:00)를 기본 표시하되 원본 시각과 밀리초는 보존합니다.
최종 `npm test` 21/21 및 `npm run build`가 통과했습니다.

## 디렉터리

```text
contracts/  대시보드 이벤트 JSON Schema
shared/     브라우저 공용 타입, AJV 검증, 영수증 adapter, 타임라인 reducer
server/     재생 snapshot, SSE·fixture HTTP 서버, CLI
src/        React 화면
fixtures/   CORE 형식 영수증, 수락 래퍼, 자원, 감사, 잘못된 이벤트
test/       node:test 시험
evidence/   실행 증거 (부모가 채움)
docs/       조사, 필드 대응, Article, release manifest
```
