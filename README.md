# bubble_lock

Privacy Bubble의 CORE, 정책·MEC·handover·FL·MCP 통합 서비스, ESP32-S3 키링, Raspberry Pi Gateway, 웹 대시보드를 묶은 저장소입니다.

시작 화면에서 사용자 대시보드와 운영 대시보드로 진입합니다. 사용자 화면은 가족·키링 등록, 사건별 위치 공유 승인, 동의·권한 회수, 명령 승인, 알림을 제공합니다. 지도는 GPS/MEC 핀, 위치 정확도 원, 수신기 중심 BLE 추정 원을 표시하며 키링별로 선택할 수 있습니다. 모의 관측과 실제 연결의 출처·관측 시각을 화면에 표시합니다.

## 통합 브랜치

`codex/integrate-all-branches`에서 다음 원격 브랜치의 전체 이력을 통합했습니다. 각 원본은 로컬 추적 브랜치와 `origin/*`에 보관합니다.

| 브랜치 | 원본 커밋 | 구성 |
|---|---|---|
| `main` | `d54a43a` | CORE·중앙 통합 서비스 |
| `PC-MOBIUS-CORE` | `d54a43a` | main과 동일한 CORE 기준 |
| `codex/keyring-namho` | `432a7aa` | 펌웨어·Gateway·PCB·키링 계약 |
| `feature/web-dashboard` | `80ed37f` | 대시보드·SSE·영수증 재생 |

2026-11-10 후속 통합에서 `main`의 `715ef58`, 키링 브랜치의 `686f7b4`까지 반영했습니다. BlueZ 알림 수정과 Feather·Pi 실물 관측 증거를 함께 보존했습니다.

## 설치와 검증

Node.js 22.19 이상, Python 3.11 이상, OpenSSL을 사용합니다. 저장소 루트에서 실행합니다.

```powershell
npm run setup
npm run verify
```

`setup`은 두 Node 패키지와 루트 `.venv`의 Gateway·검증 의존성을 설치합니다. `verify`는 CORE·웹·Gateway 시험, 실제 Node↔Python TLS 1.3/mTLS 교차시험, Edge 프로세스·FL worker 실행, XSD import closure, 계약 검증, oneM2M dry-run, 통합 데모·재생, 웹 빌드를 실행합니다. 결과와 로그 SHA-256은 `.local/verification/verify/results.json`에 저장됩니다. OpenSSL 경로는 `KEYRING_TEST_OPENSSL`, 초기 Python 실행 경로는 `PYTHON`으로 지정할 수 있습니다.

## 실행

```powershell
npm run demo
npm run events
npm run dashboard
```

`events`와 `dashboard`는 각각 터미널에서 실행합니다. 웹 주소는 `http://127.0.0.1:5173`입니다. 중앙 서비스 실행 기록을 보려면 이벤트 서버를 다음과 같이 실행합니다.

- 사용자 지도: `http://127.0.0.1:5173/#/user/map`
- 운영 대시보드: `http://127.0.0.1:5173/#/operator/overview`
- 기본 실행은 명시된 모의 환경입니다. 실제 로그인은 [OIDC 세션 설정](web-dashboard/docs/oidc-session.md), 실제 위치 수신은 [위치 feed](web-dashboard/docs/location-feed.md)와 [정밀 위치 권한](pc-mobius/integration/PORTAL_LOCATION.md)을 따라 연결합니다.

```powershell
$env:RECEIPT_FILE = (Resolve-Path 'pc-mobius/receipts/integration-demo.jsonl').Path
npm run events
```

대시보드는 시작 시 읽은 영수증을 재생합니다. `demo`를 다시 실행한 후 이벤트 서버를 재시작하면 새 기록을 반영합니다.

Gateway용 중앙 API는 [인증서 등록 설정](pc-mobius/config/integration-api.example.json)의 서버·CA 경로, 인증서 SHA-256 지문, 장치·household 매핑을 채운 뒤 실행합니다.

```powershell
$env:PRIVACY_BUBBLE_API_CONFIG = (Resolve-Path '.local/integration-api.json').Path
npm run api
```

설정의 TLS 파일 경로는 `pc-mobius`를 기준으로 해석하므로 절대 경로 사용을 권장합니다. 기본 API 포트는 8787입니다. 인증서 설정을 생략하면 `/healthz` 상태 조회를 제공합니다. API의 인증 주체는 검증된 클라이언트 인증서 또는 서명된 OIDC 토큰과 서버 등록표에서 결정합니다.

## 구성과 연결

- [PC-Mobius](pc-mobius/README.md): oneM2M 자원·MQTT/HTTP·Group/ACK/readback.
- [중앙 통합 서비스](pc-mobius/integration/README.md): consent·grant·명령 승인·MEC·handover·FL·MCP.
- [키링·Gateway](keyring/README.md): BLE 관측·장치 명령·SQLite 큐·TLS 전송.
- [펌웨어](keyring/firmware/README.md): ESP32-S3, 기본/ST7789/JD9853 프로필.
- [웹 대시보드](web-dashboard/README.md): CORE·INTEGRATION 혼합 영수증, 감사 검색, 서비스 상태.
- [통합 계약과 실행 범위](docs/branch-integration.md): 호환 수정, API, 재현 절차.
- [프로젝트 구현 기준](PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md): DOC-REV 2.0.0.
- [전체 개발 완료 기록](docs/development-completion.md): 통합 개발 내용·실행법·검증·인계.
- [ZIP·루브릭 감사](docs/rubric-audit.md): 원본 요구사항·구현·시험 근거.
- [Edge 프로세스 배치](pc-mobius/integration/EDGE_DEPLOYMENT.md): inventory·mTLS·배치·이전·복구.
- [PostgreSQL 정책 정본](pc-mobius/integration/POSTGRES.md): 동시성·이행·재시작.
- [MEC](pc-mobius/integration/MEC.md), [FL](pc-mobius/integration/FL.md), [MCP](pc-mobius/integration/MCP.md): 서비스별 설정과 실행 시험.
- [표준 SDT와 버전 어댑터](pc-mobius/SDT.md): canonical wire·XSD 계보·실제 CSE 교체 시험.

검증은 단위·모의 공급자·실제 로컬 TLS/DB/CSE/프로세스·브라우저·컴파일 범위로 구분합니다. 실물 Pi·키링, 외부 Edge·MEC·ESTIMED·OIDC와 공개 실증은 사용자 지시에 따라 [외부 실증 TODO](docs/external-validation-todo.md)로 관리합니다. 기존 브랜치의 장비·CSE 증거는 각 `evidence/`에 날짜별로 보관합니다.

후속 작업은 [TODO 목록](docs/remaining-todo.md), 최종 실행 결과는 [개발 완료 기록](docs/development-completion.md)에서 확인합니다.
