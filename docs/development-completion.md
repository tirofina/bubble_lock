# bubble_lock 개발 완료 기록

작성일: 2026-11-11 · 기준: `PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md` DOC-REV 2.0.0 · 저장소: `tirofina/bubble_lock`

## 1. 작업 범위와 결과

원격 브랜치 전체의 이력을 통합한 프로젝트에 사용자·운영 포털, 실제 지도, 키링별 위치와 BLE 추정 원을 추가했다. 제공 ZIP과 구현 루브릭을 대조해 중앙 정책, Gateway, 펌웨어, oneM2M, MEC, Edge 배치, FL, MCP, 인증, 보존 정책의 연결을 보강했다. 개발 내용은 이 문서에 모으고 요구사항별 추적표와 실행 증거는 [루브릭 감사](rubric-audit.md), [감사 JSON](rubric-audit.json)에 연결한다.

현재 완료 범위는 소스 구현, 로컬 실제 TLS·DB·CSE·별도 프로세스 통합 실행, 웹 브라우저 검증, 펌웨어 컴파일이다. Raspberry Pi·키링 실물, 외부 Edge·MEC·ESTIMED·OIDC 계정, 공개 실증은 사용자 지정 [외부 실증 TODO](external-validation-todo.md)로 관리한다.

## 2. 브랜치와 구성 통합

| 구성 | 통합 내용 |
|---|---|
| `main`, `PC-MOBIUS-CORE` | CORE oneM2M HTTP/MQTT, SDT, 명령·그룹·ACK/readback |
| `codex/keyring-namho` | ESP32-S3 펌웨어, Raspberry Pi Gateway, BLE wire, PCB 자료 |
| `feature/web-dashboard` | SSE, 명령 타임라인, 운영 상태·감사 화면 |
| 후속 `codex/keyring-location-map` | 지도·역할별 포털·정밀 위치 권한 및 루브릭 보강 |

기존 통합 기준 커밋은 `191b603d540b244d138d7b5b51278f35ddee4738`이다. 마감 시 원격 `main`의 `715ef58`과 키링 브랜치의 `686f7b4`까지 확인하고 `902392f`로 추가 병합했다. 최신 BlueZ READ/notification 순서 수정, Feather probe·실제 Pi 관측 증거를 포함하며 BLE 세션 회귀시험 7개를 통과했다. 원본 이력은 Git 병합 이력과 추적 브랜치에 보존했다. 공유 계약은 `contracts/keyring`, `pc-mobius/contracts`, `web-dashboard/contracts`에 두고 생산자와 소비자를 함께 검증한다.

## 3. 사용자·운영 대시보드

시작 페이지에서 사용자 포털과 운영 포털로 각각 진입한다. 공통 탐색, 상태 카드, 폰트·여백·색상, 모바일 화면을 정리했다.

| 화면 | 기능 |
|---|---|
| 사용자 개요 | 가구·키링 현황, 최근 사건·알림·승인 상태 |
| 사용자 지도 | 키링 선택, 실제 지도 타일, 위치 핀, 정확도·BLE 원, 출처·관측 시각 |
| 가족·장치 | 가구 구성원 및 키링 등록·조회 |
| 동의·권한 | consent/grant 생성·회수, 현재 revision 표시 |
| 활동·알림 | 사건 생성, 명령 승인, 보호자 알림 |
| 위치 공유 | 사건·목적·수신자·대상 키링·1/3/5분 lease 선택과 종료 |
| 운영 개요 | 서비스 상태, 명령·영수증 타임라인, 지도·감사 탐색 |

OIDC 로그인은 BFF의 PKCE, state·nonce, HttpOnly 세션, refresh·logout으로 연결했다. 중앙 API는 RS256/ES256 서명·issuer·audience·시간·등록 주체를 검증한다. 운영 화면은 operator scope, 사용자 데이터는 현재 가구·역할·권한으로 조회한다.

브라우저 진입 주소:

- 시작: `http://127.0.0.1:5173/`
- 사용자 지도: `http://127.0.0.1:5173/#/user/map`
- 운영: `http://127.0.0.1:5173/#/operator/overview`

[브라우저 검증 기록](ui-evidence/2026-11-10/browser-verification.json)과 같은 폴더의 화면 캡처에 데스크톱·모바일, 키링 선택, 방문자 공유·회수 흐름을 보관한다. 캡처의 키링 위치는 화면에 명시된 모의 관측이다.

## 4. 실제 지도·키링 위치·BLE 원

Leaflet과 지도 타일 공급자를 연결했다. 지도 핀은 GPS/MEC 좌표, BLE 원은 수신기 위치와 RSSI 거리 추정값으로 그린다. GPS 정확도, BLE 추정 거리, 관측 시각·출처를 각각 표시한다. 환경별 신호 보정값은 위치 계약과 설정으로 관리한다.

Gateway의 인증된 BLE 관측과 승인된 수신기 anchor를 중앙 위치 서비스에서 결합한다. GPS와 BLE의 최신 시각을 독립적으로 합치며 시간 역전·오래된 관측·권한 회수를 처리한다. 지도는 4초마다 새 데이터를 조회하고, 짧은 read lease 만료 시 좌표를 제거한다.

정밀 위치 경로는 현재 guardian 승인, 가구, recipient, device, purpose, OPEN incident, consent/grant revision, 최대 5분 공유 lease를 함께 검사한다. 보호자의 키링 B 공유를 받은 방문자에게 B 핀 하나가 나타나고, 공유 종료 후 핀이 제거되는 브라우저 흐름을 확인했다.

원문 좌표는 AES-GCM 암호문으로 저장하고 oneM2M에는 암호문 참조·hash·만료를 연결한다. 기존 평문 관측의 이행, CSE CIN 검증·정리, UE/relay 승인 연계, 거리·시간·RSSI·uncertainty 경계도 검증한다. 상세 계약은 [위치 privacy](../pc-mobius/integration/LOCATION_PRIVACY.md), [포털 위치](../pc-mobius/integration/PORTAL_LOCATION.md), [위치 feed](../web-dashboard/docs/location-feed.md)에 있다.

## 5. 중앙 정책·명령·Gateway

PortalService에 가구·장치·consent·grant·명령 승인·사건·알림 API를 연결했다. PostgreSQL 또는 파일 기반 영속 저장소에서 현재 정책을 읽고, idempotency key와 intent hash로 재시도를 정산한다.

명령은 승인 → 예약 → dispatch claim → 전송 입장 → BLE 전송 → ACK/readback → 영수증 정산으로 이어진다. commandId·claimId·payload hash·grant revision·ownership epoch·deadline을 전체 경로에 유지한다. 예약·claim TTL, 재시작, 전송 경합, 회수 후 최종 정산, 불확정 전송의 lane 점유를 처리한다.

Python Gateway는 SQLite 영속 큐와 native·CORE·중앙 영수증 outbox를 사용한다. 중앙 수신은 등록된 mTLS Gateway, 장치, epoch, revision, payload, readback을 검증한다. 실패 재전송과 프로세스 재시작 뒤에도 같은 관측·명령의 결과를 같은 식별자로 정산한다.

Panic 버튼의 새 상승 이벤트는 장치별 OPEN 사건과 보호자 알림을 만든다. 승인된 자동화 정책은 명령 승인 요청으로 이어지고 정밀 위치는 별도 사건별 lease로 열린다. Gateway LOST는 AE-ID·인증서 수명주기, 개별 키링 사건은 장치·정책 수명주기로 구분한다.

## 6. Gateway 등록·TLS·OIDC

bootstrap 인증서와 일회성 token으로 AE 등록을 수행하고 실제 OpenSSL CSR 서명으로 장치 인증서를 발급한다. bootstrap 권한, 현재 AE-ID·인증서 revision, 재시도와 재시작 복구를 검사한다.

LOST 처리는 해당 Gateway의 현재 인증과 관련 grant를 갱신하고 기존 TLS 세션을 종료한다. 상태 조회는 해당 Gateway 신원 범위로 제공한다. 실제 TLS 1.3 시험에서 bootstrap 등록, 새 인증서 명령 접근, LOST 전환, keep-alive 소켓 종료, 상태 조회를 검증했다.

설정과 API는 [Gateway 등록](../pc-mobius/integration/GATEWAY_REGISTRATION.md), [OIDC 세션](../web-dashboard/docs/oidc-session.md)에 정리했다. 운영 인증서·개인키·계정 설정은 `.local` 등 Git 제외 경로에 보관한다.

## 7. oneM2M·SDT·그룹 명령

canonical R4 `cod:binSh` 계약과 R5·기존 wire 어댑터를 분리하고 공식 XSD import closure와 출처 hash를 기록했다. v2 시험 계약은 discovery `fu=1/ty=28/cnd`, 개별 조회·갱신, 별도 readback, group 생성, 실제 `/fopt` 호출을 포함한다.

그룹 명령은 멤버별 commandId, 현재 binding·기한·권한, ACK/readback, 부분 성공·재시도·재시작을 영속 관리한다. 웹 타임라인은 summary 이전에 도착한 영수증도 해당 그룹·멤버로 결합한다.

실제 Mobius4 CSE 두 개에 독립 클라이언트 HTTP·SDK를 연결해 자원 교체·fanout·부분 결과·readback을 검증했다. 표준 근거와 재현 절차는 [SDT 문서](../pc-mobius/SDT.md)에 있다.

## 8. MEC·Edge 배치·handover

MEC Location/RNIS는 discovery, 조회·구독 CRUD, callback, 현재 grant·token·시각·중복 이벤트·영속 outbox·재조정을 구현했다. 배포 OpenAPI JSON의 SHA-256, callback schema, operationId와 실제 HTTP method/path를 검사한다.

자동 이동은 관측 geofence 내부 거리와 uncertainty, 10초 dwell, 표본 간격, 연속 health 관측, 최소 체류·cooldown을 사용한다. 중복·과거 이벤트와 회수 revision을 경계에서 검증한다.

Edge agent는 mTLS로 inventory와 고정 실행 카탈로그를 제공한다. 소스 artifact hash, host/instance/image identity, PID와 health를 확인한 실제 프로세스만 배치 상태로 기록한다. UE·epoch별 lease, target 시작·복구, 마지막 source lease 종료, 실패 rollback을 처리한다.

handover는 대상 process 준비, 현재 정책 재확인, CSE 자원·ACP·group·subscription·상태 이행, cutover, readback, source release 순서로 진행한다. source fencing과 rollback을 포함한다. 별도 Node 프로세스 두 개와 실제 CSE 두 개를 사용한 로컬 시험을 각각 수행했다. 외부 독립 호스트 시험은 TODO topic에 연결한다.

설정·시험: [MEC](../pc-mobius/integration/MEC.md), [Edge 배치](../pc-mobius/integration/EDGE_DEPLOYMENT.md).

## 9. FL·MCP

FL은 float32 softmax `W[8,3]`·`b[3]`, SGD·sample 가중 FedAvg, 108바이트 모델 artifact를 구현했다. participant binding·Ed25519 서명·dataset·epoch·consent·quorum·generation을 검증하며 late join, dropout, 재시작, 동의 회수 후 serving pause와 재학습을 처리한다.

합성 데이터의 고정 시간 분할로 3개 seed 각각 10 round를 실행했다. 배포 worker는 실제 별도 프로세스·mTLS 중앙 조회·영속 서명 update를 사용한다. oneM2M에는 participant/dataset, task/status, round/update, 모델 bytes·manifest·currentModel을 게시하고 실제 CSE에서 재조회한다.

MCP는 Streamable HTTP `2025-11-25` 기본 버전과 `2025-06-18` 협상을 제공하는 3개 서버, 도구 schema, audience별 인증, 현재 grant, 승인, idempotency, worker lease·timeout·crash 복구를 연결했다. 협상한 버전의 후속 header와 도구 입력 schema를 검증한다. 실행법은 [FL](../pc-mobius/integration/FL.md), [MCP](../pc-mobius/integration/MCP.md)에 있다.

## 10. PostgreSQL·보존·감사 증거

PostgreSQL 정본은 transaction·행 잠금·version CAS·유일 제약으로 정책, claim/outbox, FL 상태를 저장한다. SERIALIZABLE 충돌은 명시된 재시도 경로로 정산한다. JSON 이행, DB 재시작, 여러 프로세스 동시 명령·학습 경합을 실제 로컬 PostgreSQL에서 시험했다.

보존 서비스는 추상 7일, 상세·가명 24시간, 감사·FL provenance 30일 및 가구별 단축 정책을 적용한다. 파일·SQL receipt 사본과 사건·버튼·승인 요청에도 기한을 적용하고 삭제 receipt를 남긴다. 상세 설명: [PostgreSQL](../pc-mobius/integration/POSTGRES.md), [보존 정책](../pc-mobius/integration/RETENTION.md).

evidence builder는 소스·계약·설정 예시·SQL·시험·의존성 pin을 수집해 hash manifest와 재현 가능한 묶음을 만든다. ZIP 원문, 루브릭 항목, 구현 파일, 실행 증거의 대응은 최종 감사 문서에서 추적한다.

## 11. 펌웨어·MAX9850

ESP32-S3 기본·ST7789·JD9853과 헤드폰 PCM 프로필을 검증한다. MAX9850 PCM은 16kHz·16bit·256fs MCLK를 사용하고, 공유 I2S 핀·GPIO13 MCLK·I2C semaphore를 보드 연결과 맞췄다. 헤드폰 모드의 스피커 GPIO16, 취소·timeout의 SDIN LOW, worker mute/shutdown·readback, idle MCLK gate를 연결했다.

컴파일 결과와 호스트 mock 시험은 [빌드 프로필](../keyring/firmware/BUILD_PROFILES.md), [헤드폰 상태](../keyring/firmware/HEADPHONE_STANDBY.md)에 기록한다. 전류·음량·click/pop·전기적 측정은 외부 실증 TODO의 실물 시험으로 이어진다.

## 12. 재현 순서

Node.js 22.19 이상, Python 3.11 이상, OpenSSL을 준비하고 저장소 루트에서 실행한다.

```powershell
npm run setup
npm run verify
npm run demo
```

이벤트 서버와 웹은 각각 터미널에서 실행한다.

```powershell
npm run events
npm run dashboard
```

실제 계정·Gateway 연결은 문서의 example 설정을 `.local`로 복사하고 인증서·endpoint·등록 신원을 채운다.

```powershell
$env:PRIVACY_BUBBLE_API_CONFIG = (Resolve-Path '.local/integration-api.json').Path
npm run api
```

`npm run verify`는 Node CORE·웹, Python Gateway, 실제 TLS 교차시험, Edge·FL worker, SDT XSD, 계약, dry-run, 통합 데모·replay, 웹 타입·빌드를 실행한다. 원본 로그와 SHA-256은 `.local/verification/verify/results.json`, 공유용 최종 결과는 이 문서와 감사 기록에 연결한다.

## 13. 최종 검증·인계

2026-11-11 `npm run verify` 13단계 PASS: CORE 155개·웹 69개·Gateway 63개·실제 TLS 통합 6개, 합계 293개 시험과 타입·계약·빌드를 완료했다. 펌웨어 4개 프로필과 C++ mock 시험도 PASS다. 실제 CSE 구독 권한 패치에서 ACP 828건·위치 보호 5건이 PASS다. 공유 로그는 [검증 결과](development-verification.json), 추가 실행은 [증거 manifest](verification-evidence/2026-11-11/manifest.json)에 연결한다. 키 파일 동시 초기화는 완성된 32바이트 키의 원자 게시로 수정했고 64개 동시 초기화·상호 복호화 회귀시험을 통과했다. 구독 패치 적용은 [CSE 보안 문서](../pc-mobius/integration/CSE_SECURITY.md)를 따른다. 나머지 항목은 사용자 지시에 따라 [후속 TODO](remaining-todo.md)로 정리했다.

