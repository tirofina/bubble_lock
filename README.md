# bubble_lock

Privacy Bubble의 CORE, 정책·MEC·handover·FL·MCP 통합 서비스, ESP32-S3 키링, Raspberry Pi Gateway, 웹 대시보드를 묶은 저장소입니다.

## 통합 브랜치

`codex/integrate-all-branches`에서 다음 원격 브랜치의 전체 이력을 통합했습니다. 각 원본은 로컬 추적 브랜치와 `origin/*`에 보관합니다.

| 브랜치 | 원본 커밋 | 구성 |
|---|---|---|
| `main` | `d54a43a` | CORE·중앙 통합 서비스 |
| `PC-MOBIUS-CORE` | `d54a43a` | main과 동일한 CORE 기준 |
| `codex/keyring-namho` | `432a7aa` | 펌웨어·Gateway·PCB·키링 계약 |
| `feature/web-dashboard` | `80ed37f` | 대시보드·SSE·영수증 재생 |

## 설치와 검증

Node.js 22.19 이상, Python 3.11 이상, OpenSSL을 사용합니다. 저장소 루트에서 실행합니다.

```powershell
npm run setup
npm run verify
```

`setup`은 두 Node 패키지와 루트 `.venv`의 Gateway 의존성을 설치합니다. `verify`는 CORE·웹·Gateway 시험, 실제 Node↔Python TLS 1.3/mTLS 교차시험, 계약 검증, oneM2M dry-run, 통합 데모·재생, 웹 빌드를 실행합니다. 결과와 로그 SHA-256은 `.local/verification/verify/results.json`에 저장됩니다. OpenSSL 경로는 `KEYRING_TEST_OPENSSL`, 초기 Python 실행 경로는 `PYTHON`으로 지정할 수 있습니다.

## 실행

```powershell
npm run demo
npm run events
npm run dashboard
```

`events`와 `dashboard`는 각각 터미널에서 실행합니다. 웹 주소는 `http://127.0.0.1:5173`입니다. 중앙 서비스 실행 기록을 보려면 이벤트 서버를 다음과 같이 실행합니다.

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

설정의 TLS 파일 경로는 `pc-mobius`를 기준으로 해석하므로 절대 경로 사용을 권장합니다. 기본 API 포트는 8787입니다. 인증서 설정을 생략하면 `/healthz` 상태 조회를 제공합니다. API의 인증 주체는 검증된 클라이언트 인증서와 서버 등록표에서 결정합니다.

## 구성과 연결

- [PC-Mobius](pc-mobius/README.md): oneM2M 자원·MQTT/HTTP·Group/ACK/readback.
- [중앙 통합 서비스](pc-mobius/integration/README.md): consent·grant·명령 승인·MEC·handover·FL·MCP.
- [키링·Gateway](keyring/README.md): BLE 관측·장치 명령·SQLite 큐·TLS 전송.
- [펌웨어](keyring/firmware/README.md): ESP32-S3, 기본/ST7789/JD9853 프로필.
- [웹 대시보드](web-dashboard/README.md): CORE·INTEGRATION 혼합 영수증, 감사 검색, 서비스 상태.
- [통합 계약과 실행 범위](docs/branch-integration.md): 호환 수정, API, 재현 절차.
- [프로젝트 구현 기준](PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md): DOC-REV 2.0.0.

검증 범위는 로컬 소프트웨어·실제 loopback TLS·컴파일입니다. 실물 Pi·BLE·센서·모터 및 배포 CSE 연결은 해당 장비의 인증서·endpoint·실측 시험으로 이어집니다. 기존 브랜치의 장비·CSE 증거는 각 `evidence/`에 날짜별로 보관합니다.
