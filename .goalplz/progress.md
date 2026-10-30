# KEYRING 진행 기록

## 2026-10-28 — 지속 목표 시작 / DOC-REV 2.0.0 인수

- 사용자 승인: KEYRING 계속 구현, 팀 변경 인수·연동, 역할 브랜치 Git 업로드, 임시 Mobius4 환경 구성. 운영 merge·장비 flash·전면 테스트는 승인 범위로 간주하지 않는다.
- baseline commit `19cb374`: 기존 펌웨어·Pi Gateway·계약·배포 문서 소스를 보존했다. 이전의 uncommitted 작업을 사용자 요청으로 commit했다.
- 원격에서 `PC-MOBIUS-CORE`와 갱신된 main을 읽었다. CORE/source plan revision `91a281b12769493fab6d34d573a6a979f37f7b02`, DOC-REV 2.0.0.
- merge commit `7d1d454`: 역할 브랜치로 팀 코드를 인수했다. 루트 계획서 add/add 충돌은 원격 최신 2.0.0 채택으로 해결했고 이전 1.0.0은 baseline commit에 남아 있다. main/CORE 원격 브랜치를 수정하지 않았다.
- 새 소스: CORE UUID profile/identity extension, telemetry·성공 ACK projection, SQLite CORE sequence, MQTT command 수신과 승인 필드 fail-closed, 임시 Mobius4 compose/PKI/launch 문서.
- upstream `IoTKETI/mobius4`는 저장소 외부 `github_upload/_local/mobius4`에 clone했고 commit `e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`을 기록했다. 실제 upstream CSE 코드에 손대지 않았다.
- Docker provisioning 준비에서 engine pipe 부재가 확인됐다. Desktop 시작 후 사용자가 오류·종료를 보고했고 재실행했다고 알려 왔다. 종료 원인은 미확인이다. 재시작 반복·DB 삭제는 하지 않았다. 다음으로 요청된 로컬 서버 provisioning을 진행한다.
- 테스트·린트·펌웨어 빌드·flash·장비/COM 연결·통합 시험: 미실행. 원격 commit 업로드 상태와 실제 서버 기동은 각 도구 결과로 별도 기록한다.

## 다음 구현 순서

### 로컬 서버 provisioning 진행

사용자의 Docker 재실행 후 이미지와 CA/client certificate를 실제 생성했다. Compose 출력에서 postgres healthy, broker/mobius4/tls started를 확인했다. 최초 AE 생성 실패 원인은 Mobius4 AE-ID 저장소 varchar(30)에 49자 임시 관리자 ID를 사용한 것이었다. ID를 25자로 제한했고 Mobius4의 초기 DB identity 고정 때문에 기존 volume을 삭제·migration하지 않고 새 pgdata_v2/identity_v2 volume을 생성했다. 최초 volume과 local env 백업은 보존했다. 이후 bootstrap 출력에서 AE 및 첫 container HTTP201/rsc2001 생성이 관찰됐다. 전체 bootstrap 완료 결과는 후속 기록한다.

upstream 서버 image의 npm ci가 자체 출력한 audit summary는 25 vulnerabilities(7 moderate,17 high,1 critical)였다. 별도의 npm audit/test/fix 명령은 실행하지 않았고 dependency 원본은 변경하지 않았다. 서버는 loopback 개발 범위로 제한되어 있으며 운영 적합성을 주장하지 않는다.

Bootstrap가 완료되어 AE(ty2), container 3개(ty3), binarySwitch(ty28) 모두 HTTP201/rsc2001 생성됐다. 실제 설치 결과는 `keyring/dev/mobius4/provisioning-receipt.json`에 공개 가능한 필드만 보관한다. synthetic 관측·장치 command는 생성하지 않았다. 서비스 주소는 localhost:8759/8883이며 Pi 접근·INTEGRATION API·실물 연결은 별도 미완료다. 소스 checkpoint의 원격 업로드를 진행한다.

### Git 업로드 결과와 원격 요청 중단

- source commit `7835874`: CORE 연동과 임시 Mobius4 구성 및 실제 empty-resource 설치 receipt를 commit했다.
- `git push -u origin codex/keyring-namho`가 성공했고 새 원격 역할 브랜치가 생성됐다. main/CORE에는 push하지 않았다.
- 검토용 Draft PR 생성 요청은 GitHub connector에서 `403 Resource not accessible by integration`을 반환했다. PR은 생성되지 않았다.
- 사용자 웹 접근 지침에 따라 해당 오류 이후 GitHub API·CLI 등 다른 경로 재시도와 추가 push/fetch를 중단했다. 재접속은 사용자가 명시적으로 요청할 때 진행한다.
- 이 마지막 상태 기록은 로컬에만 남는다. 전체 goal은 active이며 미완료다. GitHub 재접속이 없어도 남은 독립 firmware/Gateway 구현은 계속할 수 있다.

1. 격리된 임시 Mobius4 provisioning과 실제 생성/기동 상태를 기록한다. 시작과 E2E 검증은 구분한다.
2. CORE와 MQTT app-level receipt/durable ingress 및 BLE frame 확장을 맞추고, INTEGRATION의 claim/grant/current authorization API가 생기면 실제 adapter를 연결한다. 없는 승인 값을 만들지 않는다.
3. 장치 journal 정산·보관 계약, motion wake와 남은 주변장치 드라이버를 하드웨어 출처에 맞춰 구현한다.
4. 사용자 명시 실행 요청과 실물 장비가 확보되면 power/range/reconnect/ACK·시연 evidence를 수집한다. 그 전에는 전체 goal을 complete로 표시하지 않는다.

## 2026-10-28 — 펌웨어 motion/power checkpoint (로컬)

이전 goal 턴은 source commit7835874의 원격 업로드와 실제 임시 서버 자원 생성으로 progress였다. 이번 턴도 현재 plan/AGENTS/source/log를 읽고 독립 구현을 진행했다. GitHub 재접속은 사용자 명시 요청이 없어서 수행하지 않았다.

- firmware revision keyring-0.3.0: MotionWake와 powerState 모듈을 추가했다. r18 U6 INT1 pad12→ACCEL_INT/GPIO17을 실제 PCB 텍스트와 최신 핀맵에서 읽었다.
- ST DS11811 Rev9의 wake register와 Espressif IDF4.4.7 ESP32-S3 sleep API 문서를 읽고 motion latch/event clear, 버튼 ANY_LOW·motion EXT0·timer deep wake 경로를 작성했다. 자료 읽기 외 datasheet score/analyzer·테스트·build·실행은 하지 않았다.
- sleep 기본값은0이다. 명시적으로 켠 장치만 disconnected idle 상태에서 진입한다. 연결/명령/receipt/출력/fault/센서·저장소 오류에서 진입을 막고 callback과 예약을 link lock으로 조정했다. wake 원인과 이벤트는 기존 sensorValues 확장으로 전달한다.
- 관측 프레임 크기를 맞출 때 실제 battery를 유지하고 선택적인 축·전압·중복 상태 설명을 우선 줄인다. 센서값을 추정해 채우지 않는다.
- `keyring/firmware/POWER_WAKE.md`에 설정·출처·가용성 제약과 KR-SLEEP-01~08 미실행 인수 제안을 남겼다. 실제 소비전류·wake·배터리 수명·실물 trace는 미확인이다.
- 코드·문서 수정만 수행했다. 테스트/린트/정적분석/빌드/flash/앱·컨테이너 재시작/장비 시험/검증용 데이터 생성은 하지 않았다. 로컬 commit 후 원격 접근 재허가 전까지 보관한다.

다음 독립 구현: 승인된 출력에 연결할 I2S 알림, 실제 LCD/controller·microSD 하드웨어에 맞춘 주변장치 드라이버, 장치 journal 정산·보관 계약. 중앙 API와 실물 시험 증거는 여전히 별도 의존성이다.

### Git 재접속 명시 승인

사용자가 질문에 `Git 재접속·역할 브랜치 업로드 허용`으로 답했다. 이에 따라 Git fetch를 재개했고 원격 main/CORE가 기존91a281b와 같은 상태임을 확인했다. 새 source commit은 로컬 `d6efe71`이다. 이 기록을 commit한 후 해당 역할 브랜치의 일반 push를 수행한다. GitHub PR API의 권한 오류가 해결됐다고 추정하거나 PR 생성을 재시도하지 않는다.

## 2026-10-28 — 화면 두 종류·음향·SD checkpoint

- 사용자 명시 승인으로 Git 재접속 후 이전 source d6efe71과 기록 a0fb438 push가 성공했다. 이번 fetch에서도 원격 main/CORE는91a281b이며 새 중앙 계약 변경은 없었다. PR API는 재시도하지 않았다.
- 사용자가 LCD 선택 질문에 `두 화면 모두 지원`으로 답했다. firmware keyring-0.4.0에 ST7789 1.54인치240×240 profile1과 JD9853 2.01인치240×296 후보 profile2를 작성했다. 기본 profile0이며 단일 실장 화면을 명시적으로 선택한다. write-only 패널을 탐지/검증됐다고 표시하지 않는다.
- Arduino_GFX f71dbf6532b277401d70442f43a8fa9b61c6a7e3과 JD9853 원저자 source186e52d3c264c899d8910a63297e48a1d2a8d516을 저장소 외부에서 읽었다. 그래픽 dependency만 선언했고 설치/빌드는 하지 않았다. JD9853 COLMOD0x05와 별도 MADCTL/DCS 경로를 작성했으며 다른 패널 power/gamma table은 가져오지 않았다. 구매 모듈 초기화와 geometry/offset은 실물 미확인이다.
- buydisplay 제조사 PDF 요청이HTTP403으로 실패해 해당 사이트 요청을 중단했다. 다른 도구/경로로 재시도하지 않았다. JD9853 기본 경로의 근거는 독립 드라이버 저자 코드이며 구매 패널 제조사 확인을 대신하지 않는다.
- MAX98357A 제조사 자료와 ESP-IDF4.4.7 I2S API를 읽고 승인된 GPIO ON/NVS 완료 이후에만 cue를 요청하는 worker를 추가했다. disconnect/취소/모터 기한은 GPIO mute를 먼저 수행한다. 실물 음향·SPL·전력·clock 측정은 없다.
- 최신 r18 J3/J10·pinmap에 맞춰 LCD/SD SPI를 단일 worker에서 직렬화했다. aux_rail은 motor/audio alert 중 백라이트를 선점하고 별도 timer로 화면 창/fault를 처리한다. 절전 예약은 신규 peripheral I/O를 막는다.
- SD는 기본 비활성 평문 receipt 진단 복사다. queue8행/행1024byte/기본1MiB 상한이며 자동format/삭제/순환 덮어쓰기/재시도는 없다. NVS canonical journal을 대체하지 않는다. JSONL/FAT 전원 차단 원자성을 주장하지 않는다.
- PERIPHERALS.md·third-party notices·핀맵·인터페이스·인수인계와 구현 상태를 갱신했다. tests/lint/정적분석/build/flash/Gateway 실행/컨테이너 재시작/장비·COM 시험/검증 데이터 생성은 모두 미실행이다.

다음 구현: 중앙 정산 후 장치 journal 보관·재등록 계약, 실제 INTEGRATION 승인 API가 추가될 때 adapter 연동, 구매 LCD 모듈 초기화 자료 반영. 실물/통합 evidence와 release는 미완료이며 goal은 active다. 이번 소스 commit과 push 결과는 실제 Git 출력 후 별도 기록한다.

### 주변장치 소스 업로드 결과

source commit `113b03c`를 만들고 `git push origin codex/keyring-namho`가 성공했다(`a0fb438..113b03c`). main·팀 역할 브랜치는 변경하지 않았다. 이 업로드는 코드 공개 checkpoint이며 빌드·동작 검증·공동 merge·최종 release 증거가 아니다. 최신 구현 상태의 sourceCommit도113b03c로 갱신한다.

## 2026-10-28 — NVS journal 읽기·보관 checkpoint

이전 goal 턴은 source113b03c와 기록365f4e7을 역할 브랜치에 push한 실제 progress였다. 이번 턴 시작에 계획서 역할/프로토콜/완료 기준과 AGENTS/자동 검증 금지 스킬을 읽었다. Git fetch 결과 main/CORE는 여전히91a281b이며 새 중앙 정산 계약은 없었다.

- firmware keyring-0.5.0: MITM READ/WRITE journal extension0006을 작성했다.8byte selector는 volatile RAM 요청이며 NVS/출력을 수정하지 않는다. 유효한 NVS load에서만 frozen snapshot을 만들고 connection generation/120초 TTL에 묶었다. record는512byte 이내 두 READ 조각으로 전달하고 requestId/snapshotId/index/part를 맞춘다.
- PREPARED의 readback/appliedUptimeMs를 null/INDETERMINATE로 유지한다. 과거 record bootId의 uptime을 capture boot의 시간으로 바꾸지 않는다. native CRC는 storage metadata이며 JSON 서명으로 취급하지 않는다. 관측의 journal usage는 NVS 오류 때 null이고 선택 필드 생략 가능성을 문서화했다.
- Gateway capture helper와 BleFleet.capture_journal을 추가했다. per-device command lock으로 직렬화하고 identity/boot/snapshot/조각/record 수·ID 유일성/phase·시각·fence를 판정한다. 중앙 성공을 합성하지 않는다.
- Linux/BlueZ 수동 bubble-keyring-journal CLI를 작성했다. daemon과 같은 DB lock으로 협조하고 기존 bond를 사용하며 ID/revision을 대조한다. output은 새 owner-only 폴더·파일만 생성하고 JSONL과 SHA256/실제 수/not-settled manifest를 기록하는 소스다. 실제 도구 실행·보관 파일 생성은 하지 않았다.
- JSON Schema4개와 JOURNAL_RETENTION.md, 인수인계·설정을 추가/수정했다. NVS erase/compact/reset API는 추가하지 않았다. 이 단계는 실제 중앙 정산·공간 회수를 대체하지 않으며32개 한계는 남는다. 중앙의 영속 command ID·checkpoint/epoch·settlement receipt·crash 복구 계약이 필요하다.
- 테스트/린트/정적분석/build/flash/장비·COM/CLI 실행/앱·서비스·컨테이너 재시작/검증용 데이터 생성은 모두 미실행이다. 전체 goal의 실물·통합·release 증거는 미완료다.

다음 작업은 중앙 정산 및 INTEGRATION API 계약이 생기면 연동하고, 독립적으로 남은 현장 운용·재연결·전원 상태 전달을 구현하는 것이다. 이 checkpoint의 commit/push 결과는 실제 Git 출력으로 후속 기록한다.

### Journal 소스 업로드 결과

source commit `6203dec`의 일반 push가 성공했다(`365f4e7..6203dec`, origin/codex/keyring-namho). main/CORE·운영 서버는 변경하지 않았다. 이것은 구현 코드 업로드이며 실제 장치 capture/보관·정산·reclaim·동작 검증 증거가 아니다. 구현 상태의 sourceCommit도6203dec로 갱신했다. goal은 active이고 필수 실물/통합/release 증거는 남아 있다.

## 2026-10-28 — r18 native 하드웨어 인계 checkpoint

이전 goal 턴은 journal source6203dec·기록ca027d2를 역할 브랜치에 push한 progress였다. 이번 시작에 최신 계획서 DOC-REV2.0.0의 역할/완료 조건, AGENTS, 자동 검증 금지 스킬을 읽고 Git fetch했다. main/CORE는 기존91a281b로 새 팀 계약 변경이 없었다.

- 기존 pcb README가 저장소 외부 작업공간의 파일만 가리켜 clone만으로 설계를 인수할 수 없었다. KEYRING PCB 자산 인계 범위에서 원본 r18-hand-solder의 native sch/pcb/pro/dru, Release 심볼, 로컬 footprint·모델, BOM/두 LCD 외장표·배선표, 기존 stackup·패드 변경 이력을 keyring/pcb/r18에 복사했다. 원래 파일과 회로/배치/패드/네트/BOM 값을 수정하지 않았다.
- 원본 복사222개·16,312,470byte의 출처/byte 수/SHA256/파일 시각을 source-inventory.json에 기록했다. 해시는 복사한 데이터 식별용이며 코드/CAD/전기 검증이 아니다. .gitattributes에 snapshot byte 보존 규칙을 추가했다. 분석 결과/Checks·제조 거버/드릴·ZIP·editor state·중복 미사용 library는 새 인계에 포함하지 않았고 원래 작업공간에 보존했다.
- KiCad/BOM 스킬의 자산 구조/출처 지침을 적용했다. 분석기·BOM 재추출/부품정보/가격/재고 조회·datasheet 동기화·시뮬레이션·DRC/ERC·제조출력 생성은 실행하지 않았다. 라이선스 안내는 KiCad 공식 library license 페이지를 순차1회 읽고 출처를 링크했다. 원래 model/property/source attribution을 유지하며 프로젝트나 supplier 모델에 일괄 새 라이선스를 부여하지 않는다.
- 원본 README의 과거 DRC/ERC/hash/simulation 주장은 UPSTREAM_README로 보존하고 현재 firmware release 증거와 구분했다. 실제 검증을 수행하거나 과거 결과를 현재 결과로 재사용하지 않았다.
- HARDWARE_FIRMWARE_MAP에 현재 배선표/핀 선언과 충돌하는 U1·U13 BOM prose를 정리했다. GPIO12→AUX_EN4, LCD reset15→43, GPIO5/48 NC를 원본 덮어쓰기 없이 설명했다. U15 INA219B는 실제 BOM에 존재하지만 firmware 계측 경로가 없어 notImplemented/다음 독립 구현 항목으로 기록했다. U16 MAX9850 헤드폰 경로도 여전히 미구현이다.
- 인계 안내·소프트웨어/하드웨어 연결·구현 상태를 갱신했다. KiCad 열기/분석기/DRC/ERC/SPICE/build/flash/장비·COM/앱·서비스·컨테이너 재시작/검증용 데이터 생성은 모두 미실행이다. 실제 조립 revision·배선·전원/RF/열·실물/통합/release evidence는 남아 있다.

다음 독립 구현은 원본 U15 INA219의 제조사 register/전류 sense 연결을 읽고 실제 전류·전압·전력/오류 관측 소스를 추가하는 것이다. 중앙 INTEGRATION 승인/settlement 계약·구매 JD9853 초기화 자료·실물 실행 허가는 여전히 별도 의존성이다. 이번 인계 source commit/push는 실제 Git 결과로 후속 기록한다.

### r18 인계 업로드 결과

source commit `446dc6d`의 역할 브랜치 일반 push가 성공했다(`ca027d2..446dc6d`, origin/codex/keyring-namho). 복사한 원본과 인계 문서를 원격에 반영했으며 main/CORE·운영 서버·원래 하드웨어 파일은 변경하지 않았다. 이것은 자산 인계이며 CAD/전기/firmware 검증·실물 제조·release 완료가 아니다. sourceCommit을446dc6d로 갱신했다. 다음 독립 구현은 U15 INA219 계측이고 전체 goal은 active다.

## 2026-10-28 — INA219 공급 전원 계측 checkpoint

이전 goal 턴은 r18 native source446dc6d와 기록e9ad8ac를 역할 브랜치에 업로드한 progress였다. 이번 시작에 최신 계획서 DOC-REV2.0.0 역할/계약/완료 기준, AGENTS와 code-edit-no-validation 스킬을 읽고 Git fetch했다. main/CORE는 기존91a281b로 새 중앙 계약 변경이 없었다.

- datasheets 스킬을 적용해 기존 INA219 제조사 텍스트와 TI 공식 PDF SBOS448G Rev.G의 register/단위/calibration 설명을 읽었다. TI PDF 열람과 page12 요청은 자료 읽기였으며 코드/실물 화면 검증이 아니다. datasheet score/analyzer/cache validation·시뮬레이션·DRC/ERC는 실행하지 않았다.
- native PCB의 R61 VREG3V3→+3V3, U15 VIN+/VIN-/VS/A0/A1 네트를 읽었다. 실제 공급 도메인은 shunt 뒤3.3V 부하이며 INA219 자체도 포함한다. R61 prose의 supply-before 주장과 U15/C35/native 연결의 차이, R61 MPN/URL 품번 차이를 문서화하고 원본은 보존했다. 배터리 입력/충전 전류를 측정한다고 표시하지 않는다.
- firmware keyring-0.6.0: SupplyMonitor를 추가했다. 고정0x40·nominal100mΩ·cal0x4000·config0x099B의 bus+shunt single shot, CNVR/OVF·범위·cal/config/원시 current 관계 판정,0x0998 standby/readback, 오류5초 backoff, cached sample timestamp/staleness/null, sleep 전 power-down 확인 경로를 작성했다. GPIO timer/BLEcallback/worker에서 I2C하지 않는다. 실제 calibration·전류/전압·전력·sleep 소비전류 측정은 없다.
- signed currentUa와 busVoltageMv·shuntVoltageUv·derived loadPowerUw·readUptimeMs를 정수로 전송한다. 표시 단위를 정확도/분해능 보장으로 사용하지 않는다. peak/평균/누적 energy/배터리 수명 추정이나 새로운 권한·전류 제한 정책을 만들지 않았다.
-512byte READ에서 데이터가 계속 탈락하지 않도록 sensors/energy/health detail을 순환한다. detail별 최신 pending frame3개를 publication order로 전송해 sequence 역전을 피한다. active LF/20byte framing과 공통 battery/button/state/fault/journal을 유지한다. sensor polling을 notification 발행과 분리했고 JSON overflow 시 새 최소 frame으로 재구성한다. 현재 값이 없을 때0을 합성하지 않는다.
- Gateway의 INA219 shape/null/정수 단위·ADC step·시각·signed power product runtime 경로와 standalone schema를 추가했다. native cin은 detail을 유지하며 CORE v1 projection에는 sensor 확장이 없음을 기록했다. LCD 두 profile에는 유효한 공급 전류 또는--를 표시하고 worker 자체도 freshness를 판정한다. 실제 Gateway/장비 연결은 실행하지 않았다.
- POWER_MONITOR.md·인수인계·핀/전원 설명·allowlist 안내·journal CLI 기본 firmware revision과 구현 상태를 갱신했다. 기존 원본 CAD/BOM·NVS/중앙 정책/서버는 수정하지 않았다.
- 테스트/린트/정적분석/build/flash/CLI 실행/장비·COM/앱·서비스·컨테이너 재시작/검증용 데이터 생성은 모두 미실행이다. 새 구현을 verified/released로 표시하지 않는다.

다음 작업: 남은 하드웨어 출력 경로의 실제 지원 범위와 중앙 INTEGRATION 계약을 읽어 이어서 구현한다. INA219 실물 calibration·전원/범위·BLE/CSE 통합/영상·release 증거, JD9853 패널별 초기화, 중앙 settlement/reclaim 계약은 남아 있다. 이 source checkpoint의 commit/push 결과는 실제 Git 출력 후 별도 기록한다.

### INA219 소스 업로드 결과

source commit `a9c55ad` 일반 push가 성공했다(`e9ad8ac..a9c55ad`, origin/codex/keyring-namho). main/CORE·운영 서버·원래 하드웨어 source는 변경하지 않았다. sourceCommit을a9c55ad로 갱신했다. 이것은 driver/전송/화면/Gateway source 업로드이며 실제 계측·통합·검증·release 완료가 아니다. goal은 active이고 실물·중앙 계약 의존성은 남아 있다.

## 2026-10-28 — Gateway 상태 identity·보관 checkpoint

이전 goal 턴은 INA219 sourcea9c55ad와 기록c2ad489를 역할 브랜치에 push한 progress였다. 이번 시작에 계획서 DOC-REV2.0.0의 역할/계약/완료 기준, AGENTS와 code-edit-no-validation을 읽고 Git fetch했다. main/CORE는91a281b로 새 중앙 계약 변경이 없었다.

- 남은 MAX9850 경로의 제조사 보관 텍스트와 native U16 nets를 읽었다. DVDD/AVDD/PVDD는 main+3V3이며 speaker AUX_EN/AMP_GATE처럼 별도 GPIO mute를 가정할 수 없다. 이 경로에 기존 스피커 차단 방식을 그대로 복사하지 않았으며 헤드폰 출력은 여전히 미구현이다. Q4 BOM prose의 GPIO42와 현재 AMP_GATE16 차이도 인계 정정표에 추가했다. 실제 측정/실행은 하지 않았다.
- 직접적인 R12/상태 보관 경로를 구현했다. Gateway0.2.0은 local configured gatewayId/originator/cseId/rvi/container identity를 DB에 연결하고 mismatch/QUARANTINED/필수 table 누락을 BLE·전송 시작 전에 거절한다. endpoint/certificate 경로 변경은 binding에서 제외하지만 다른 configured principal/자원에 state를 조용히 재사용하지 않는다. 로컬 binding을 중앙 권한/attestation으로 표시하지 않는다.
- Python3.11 sqlite3 공식 backup 문서를 읽고 operator-only bubble-gateway-state snapshot/adopt 소스를 추가했다. daemon lock·read-only source·SQLite backup으로 committed WAL을 포함하고, 새 owner-only 파일/폴더에 DB·실제 table/status 수·SHA256 manifest를 기록하는 경로다. source-copy 논리 data row를 유지하면서 복사본 metadata만 QUARANTINED로 만들어 무단 rollback 실행을 막는다. 실제 snapshot/data/manifest를 생성하지 않았다.
- 0.1.x 원본의 비어 있지 않은 unbound DB는 자동 소유를 추정하지 않고 명시적 adopt가 필요하다. adoption은 기존 record의 Gateway/hash/route를 읽고 새 격리 snapshot을 먼저 완성한 다음, data_version/write transaction으로 원본에 binding만 추가하는 코드다. 필요한 초기 CORE table을 추가할 수 있으나 기존 data row/명령을 삭제·재실행하지 않는다. 실제 DB schema/data migration은 실행하지 않았다.
- 복구 copy activation은 중앙 checkpoint/현재 권한·장치 NVS·CORE sequence 상한 계약이 필요해 구현하지 않았다. snapshot이 있다고 R12·정산·recovery 완료로 표시하지 않는다. STATE_RECOVERY.md와 schema3개, 인수인계·버전0.2.0·설정을 갱신했다.
- 테스트/린트/정적분석/build/flash/SQLite/CLI/Gateway 실행/실물·COM/앱·서비스·컨테이너 재시작/검증용 데이터 생성은 모두 미실행이다. 새 코드를 검증 또는 운영 migration 성공으로 보고하지 않는다.

현재 source checkpoint는 commit/push 후 실제 Git 결과를 기록한다. 계획서의 필수 검증 증거가 아직 없어 전체 완료가 아니며, 로컬 빌드·Gateway 단위 테스트도 현재 작업의 명시적 허가 전에는 실행하지 않는다. 중앙 INTEGRATION/settlement/recovery 계약, 구매 JD9853 초기화, 실제 board/Pi·측정/영상 증거도 남아 있다.

### Gateway0.2.0 상태 보관 소스 업로드

source commit `a3e1943` 일반 push가 성공했다(`c2ad489..a3e1943`, origin/codex/keyring-namho). sourceCommit을a3e1943로 갱신했다. 이는 코드·계약·운영 안내의 업로드이며 실제 DB adoption/snapshot·복구 활성화·검증·빌드·release 성공이 아니다. main/CORE/운영 서버/기존 DB/장비를 변경하지 않았다. 전체 goal은 active다. 다음에는 외부 DAC의 부팅/절전 안전 상태와 남은 구현·검증 의존성을 이어서 처리한다.

## 2026-10-28 — 외부 DAC 대기 상태·컴파일 프로필 checkpoint

이전 goal 턴은 Gateway state sourcea3e1943와 기록c5f1617을 역할 브랜치에 push한 progress였다. 이번 시작에 최신 계획서2.0.0 역할/완료 기준, AGENTS, code-edit-no-validation을 읽고 Git fetch했다. main/CORE는91a281b이며 새 중앙 계약은 없었다.

- MAX9850의 로컬 제조사 텍스트와 Analog Devices 공식 Rev4 PDF를 읽었다. Volume/General/Enable control과 power-off 설명을 근거로 HeadphoneStandby 소스를 추가했다. 원래 native U16은 main+3V3에서 전원 공급돼 MCU만 재시작할 때 POR default만 가정하지 않는다.
- firmware keyring-0.7.0: 고정0x10에 zero-cross 대기 해제·MUTE/full attenuation·output enable 제거·global shutdown 요청과 control readback을 작성했다. 종료는 앞 I2C 실패가 있어도 시도하고5초 주기로 읽거나 재요청한다. configured_off는 register 상태 의미이며 물리 무음/VMN transient/click/pop/전류 측정이 아니다. DAC 재생·MCLK는 여전히 미구현이다.
- 다른 I2S receiver 상태가 불명확하면 스피커 I2S 설치/계속 재생을 막는 atomic Permit guard, 회복 시 driver 설치1회·과거 cue 재실행 금지, 절전 전 control 요청을 연결했다. crypto/passkey 미설정 상태에서도 DAC 종료 요청은 유지한다. motor GPIO timer/권한/NVS receipt의 의미를 바꾸지 않았다.
- 기본 관리 옵션은1이다.0은 DAC가 없는 별도 board를 명시적으로 선택하는 bypass이며 실제 DAC off 확인으로 표시하지 않는다. health headphone/audio 상태와 HEADPHONE_STANDBY.md에 제약을 기록했다.
- PlatformIO 공식 extends 설명을 읽고 keyring_compile_minimal/st7789/jd9853 구성을 작성했다. local provisioning.h를 제외하고 passkey는 기본 invalid0이며 USB/PSRAM/base dependency 설정을 이어받는다. default 환경은 기존 keyring_r18이다. 설정 작성만 했고 dependency 설치·컴파일·검증·실행은 하지 않았다.
- 테스트/린트/정적분석/build/flash/COM·장비/CLI/Gateway·DB/서비스·컨테이너 실행·재시작/검증용 데이터 생성은 모두 미실행이다. 문서/설정/연결을 갱신했고 실제 장치나 기존 DB·원본 CAD를 변경하지 않았다.

계획서가 요구하는 actual build/test/실물·통합/영상·release 증거는 남아 있다. 소스 업로드 후 현재 작업의 로컬3개 프로필 빌드·Gateway 단위 테스트 실행 여부를 사용자에게 확인한다. 사용자 명시 요청 전에는 이를 시작하지 않는다. 중앙 INTEGRATION·settlement/recovery 승인 계약, JD9853 구매 모듈 초기화, 실물 장비/측정 허가 역시 별도 의존성이다.

### DAC 대기 상태 소스 업로드 결과와 다음 실행 범위

source commit `3d0f0cc` 일반 push가 성공했다(`c5f1617..3d0f0cc`, origin/codex/keyring-namho). sourceCommit을3d0f0cc로 갱신했다. compile profile은 provisioning.h뿐 아니라 local jd9853_panel.h도 제외해 장치별 비공개 설정과 분리한다. 이는 소스/설정 업로드이며 실제 DAC 종료·소비전류·음향·빌드/테스트·release 완료가 아니다.

계획서 actual build/test 증거를 진행하려면 현재 작업의 명시적 실행 요청이 필요하다. 다음 확인 범위는 로컬3개 compile profile과 Gateway 단위 테스트 및 필요한 개발 dependency 설치이며 flash/COM/실제 BLE·장비/운영·기존 DB 실행은 포함하지 않는다. 허가 전에는 dependency 설치·테스트 데이터/fixture 생성·실행을 하지 않는다. goal은 active이며 JD9853 실물 초기화/중앙 승인·settlement/recovery 계약/실물·통합·영상 evidence는 남아 있다.

## 2026-10-28 — 완료 자료 대조 / 기존 검증 질문 답변 대기

앞 goal 턴은 source3d0f0cc·기록98f525e의 실제 push로 progress였다. 현재는 로컬3개 compile profile·Gateway 모의 단위 테스트(+필요 개발 dependency) 허가 질문에 아직 답변이 없다. 자동 계속 요청은 현재 작업의 build/test 허가가 아니다.

- 계획서 KEYRING9개 산출물·7개 완료 자료·첫 통합 조건을 기존 source/문서/receipt와 파일 읽기로 대조했다. compiler/lint/analyzer/test/fixture/장비·서비스·DB 실행은 하지 않았다. 코드 기능을 새로 구현했다고 보고하지 않는다.
- fetch 결과 main/CORE91a281b·역할98f525e이며 새 중앙 계약은 인수되지 않았다. 계획서의 contracts_round03.json·active_release.json·Hackathon Rubric 2026.txt 정확한 상대 경로를 repository/original workspace 두 root에서 조회했고 모두 없었다. 다른 PC·원격·다른 파일명까지 없다는 주장은 아니다.
- COMPLETION_GAPS.md에 code/CAD/provisioning과 미확인 build/Pi/E2E/실측·영상·release를 구분했다. A01~A26 정의·기존 release 승인·원문 Rubric을 추정해 채우지 않는다. 이 문서는 실행 결과/시험 통과/새 구현 진척으로 취급하지 않는다.
- 같은 빌드·검증 허가 부재를 앞 질문 턴에 이어 이번에도 확인했다(2회). 아직3회 blocked 기준 전이므로 goal을 active로 유지하고 질문을 중복 생성하지 않는다. 권한/중앙 계약/자료가 바뀌지 않은 채 반복 상태 문서만 만들어 기능 진척으로 계산하지 않는다.

전체 goal은 미완료다. 검증·빌드·실행은 미실행이며 기존 허가 질문의 답변을 기다린다. 이 대조 기록은 release evidence가 아니다.

## 2026-10-28 — blocked 전환 / 반복 실행 중단

직전 턴은 완료 조건·지정 reference 부재를 파일로 대조한 문서 작업이었으며 새 구현/검증 진척으로 계산하지 않는다. 이번 재확인에서도 기존 build/unit-test 허가 질문에 답변이 없고 main/CORE는91a281b다. 이전 질문 턴·공백 대조 턴·이번 턴의 동일 조건3회 후, 더 진행할 새 승인/계약/자료가 없으므로 update_goal(status=blocked)를 호출했고 실제 반환 status=blocked를 확인했다.

검증·빌드·테스트 데이터/fixture·장비·서비스·기존 DB 실행은 하지 않았다. 기능을 임의 추가하거나 같은 상태 기록을 진척으로 계산하며 계속 돌리지 않는다. 전체 목표를 complete로 표시하지 않는다. source firmware0.7.0/Gateway0.2.0은3d0f0cc이며 직전 증거 공백 문서는7f0e3ab로 업로드돼 있다.

다음 진행에는 기존 질문의 로컬3개 compile profile·Gateway 모의 단위 테스트(+필요 개발 dependency) 범위에 대한 현재 작업의 명시적 요청이 필요하다. 그 허가도 flash/COM/실제 BLE·장비·기존 DB·운영 서비스 실행을 포함하지 않는다. 최종 완료의 중앙 INTEGRATION·settlement/recovery 계약, JD9853 구매 모듈 초기화, 지정 원문과 실제 Pi/측정/통합/영상·release evidence도 남아 있다. 이 마지막 상태 commit/push는 기록 보존이며 구현 진척이나 시험 통과가 아니다.


## 2026-10-29 — 명시 허가 후 로컬 빌드3개·Gateway 모의 테스트37개 통과

사용자가 기존 질문에 “로컬 빌드·단위 테스트 허용”으로 답했다. 펌웨어3개 compile profile·Gateway 모의 단위 테스트와 필요한 개발 의존성 설치 범위로 진행했다. 최신 사용자 AGENTS는 코드/스크립트 수정 뒤 관련 검증을 직접 수행하도록 이전 no-validation 기본값을 대체했으며, 저장소 AGENTS와 goal contract의 해당 검증 조항을 갱신했다. flash/COM/실제 BLE·장비/기존 DB/운영 서비스는 실행하지 않았다.

- 시작/종료 준비 시 fetch의 main/CORE는91a281b, WEB은80ed37f였다. 새 팀 계약 변경은 없었다. 원본 중앙 구현·하드웨어 자산은 수정하지 않았다.
- 분리된 .venv에 PlatformIO Core6.2.0과 Gateway 개발 의존성을 설치했다. Windows11/Python3.12.14, espressif32 6.9.0, Arduino2.0.17, Xtensa8.4.0+2021r2-patch5, ArduinoJson6.21.5다.
- 첫 빌드에서 GFX1.6.9의 esp32-hal-periman.h 부재와 C++11 Button 초기화 오류를 재현했다. 원본 upstream v1.4.9의 Arduino2.x 분기를 읽고 dependency를3cc08c4e9ab6d85807e49b657d73fae10871616e로 고정했다. Button에는 명시적 생성자를 추가했다. 이 소스 및 테스트는3c27f4d로 commit/push 성공(d233c0f..3c27f4d, origin/codex/keyring-namho).
- 다음 빌드는 한글 경로 firmware.map을 Windows 링커가 열지 못해 실패했다. 저장소는 보존하고 PLATFORMIO_BUILD_DIR=C:/Users/NH/.cache/keyring-validation-20261029/build로 출력만 바꿨다. 초기 실패/중단 로그도 보존했다.
- 최종 `python -m platformio run -e keyring_compile_minimal -e keyring_compile_st7789 -e keyring_compile_jd9853`는 exit0/3 succeeded,5분59.074초다. minimal flash807093/RAM58160,ST7789 flash889965/RAM59484,JD9853 flash889581/RAM59484 bytes. firmware.bin은 각각807456/890384/890000bytes다. 장치 provisioning.h와 jd9853_panel.h는 제외했고 passkey는 invalid0이므로 실제 장치 펌웨어로 배포하지 않았다.
- `python -m unittest discover -s keyring/raspberry-pi-gateway/tests -v`는37개/0failure/0error/OK,0.908초다. 모의 BLE/MQTT/HTTP, 합성 명령, 테스트 전용 임시 SQLite만 사용했다. 중복/충돌·fence·기한·권한 binding·미확정 실행 재시도 방지·outbox·CORE sequence·journal capture·WAL backup/quarantine/adoption을 확인했다. Windows에서 POSIX directory fsync는 모의 처리했다. 실제 Pi 권한/lock/전원 손실 내구성 증거가 아니다.
- `keyring/evidence/2026-10-29-local-validation/`에 실제 로그·환경 package 목록·receipt와 바이너리/ELF/map/bootloader/partition SHA256을 기록했다. .gitattributes는 evidence 원본 byte를 보존한다. 바이너리·credential·실제 장치 데이터는 Git에 포함하지 않았다.

허가 대기는 해소됐고 이번 로컬 검증 범위는 완료됐다. get_goal의 마지막 반환은 기존 blocked 상태였으며 도구가 지원하지 않는 active 전환을 시도하거나 전체 goal을 complete로 표시하지 않았다. 전체 역할 목표에는 중앙 승인/settlement/recovery 계약·지정 원문·JD9853 구매 모듈 init·실제 Pi/장비/전력·거리/CSE 통합·영상/release evidence가 남아 있다. 로컬 통과를 실물·전체 verified/released로 승격하지 않는다.


## 2026-10-30 — BLE 재접속 경계 수정 / Gateway0.2.1

직전 goal 턴은 firmware3개 build·Gateway37개 단위 시험과 소스/증거 push를 완료한 progress였다. 이번 시작/최종 준비 fetch에서 main/CORE91a281b·WEB80ed37f로 새 팀 계약 변경은 없었다. get_goal 실제 상태는 active다. DOC-REV2.0.0의 KEYRING 역할·R02/R03/R10에 맞춰 장비 없이 재현되는 BLE session 결함을 수정했다. 최신 사용자 AGENTS의 수정 후 관련 검증 실행 지침을 적용했다.

- 수정 전0.2.0은 매 조각 전송에 peer.client를 다시 조회했다. 모의 첫 WRITE 도중 연결을 교체하자 새 client에 남은 조각12회 WRITE가 발생했다. 이전 disconnect·observation·receipt callback이 새 연결 상태/수신 버퍼/pending을 변경했고, 실패한 handshake에서도 ready.set이 호출됐다. 새 회귀 시험5개가 모두 실패했으며 baseline exit1 로그를 보존했다.
- Gateway0.2.1은 연결 generation을 할당하고 상실 즉시 무효화한다. callback의 generation을 캡처하고, command client/generation/future를 고정한다. 각 WRITE 전후와 결과/handshake 경계에서 세션을 확인하며 이전 작업의 예외·정리는 새 연결에 적용하지 않는다. journal capture 후 세션 검사도 generation을 확인한다. 이 번호는 프로세스 내부 상태이며 ownershipEpoch·GATT·JSON schema·DB/중앙 계약을 바꾸지 않는다.
- 소스 단위 시험42개/0failure/0error/exit0/1.008초. setuptools84.2.1·wheel0.48.0·packaging26.3을 개발 환경에 설치했다. --no-index --no-deps --no-build-isolation wheel build exit0,privacy_bubble_gateway-0.2.1-py3-none-any.whl40336bytes,SHA256 5f5d14e2b524c38bd57ae502a99e83fbbc0ac487c2aeb9a824898a8caca37f8a.
- wheel을 새 임시 target에 네트워크 없이 설치했다(exit0). import 경로·version0.2.1을 확인한 설치 패키지에서도42개 시험/exit0/0.960초로 통과했다. fake GATT·모의 MQTT/HTTP·임시 SQLite만 사용했다. 실제 scanner/BLE·장비·Pi·daemon·기존 DB·운영 서비스는 실행하지 않았다. firmware 소스/설정은 변경·재빌드하지 않았으며2026-10-29의3개 build 증거를 유지한다.
- 소스48c71e1 일반 push 성공(bf4c8b0..48c71e1,origin/codex/keyring-namho). keyring/evidence/2026-10-30-ble-sessions/에 baseline·source/설치 package 시험·wheel build/install 로그와 실제 SHA256을 저장한다. BLE_SESSIONS.md의 KR-BLE-SESSION-01..05는 KEYRING 제안 추적 ID이며 원래 A01~A26을 대체하지 않는다.

이번 작업은 재접속 결함 수정과 실행 증거로 progress다. 전체 goal은 active/미완료로 유지한다. 중앙 승인·settlement/recovery 계약, 구매 JD9853 init, 지정 reference 원문, 실제 Pi/장비·전력/거리·CSE 통합·영상/release는 남아 있다. 이 의존성을 해결한 것처럼 표시하지 않는다.


## 2026-10-30 — 영수증 이중 경로 재등록 수정 / Gateway0.2.2

직전 goal 턴은 BLE session 결함 재현·수정, source/설치 package 각42개 시험, wheel build/install 및 c1bac3e까지 push를 완료한 progress였다. 이번 시작/종료 준비 fetch의 main/CORE91a281b·WEB80ed37f는 그대로다. DOC-REV2.0.0을 읽고 KEYRING/R02·R03·R10 범위에서 durable queue/receipt 경로를 수정했다. goal의 실제 시작 상태는 active다.

- 0.2.1 stage_receipts는 native receipt_delivered=0이면 이미 전송·제거한 CORE ACK를 다시 생성했다. 새 임시 SQLite와 모의 publish로 회귀5개 중3개 실패·2개 통과를 확인했다. native retry backoff 중 worker가 동일 ACK를4회 보내는 경로를 재현했고 bounded test로 중단했다.
- 0.2.2는 native 영수증의 최초 outbox INSERT와 선택형 CORE ACK를 한 transaction에 묶는다. 이미 native outbox 행이 있으면 ACK를 재생성하지 않는다. native 전달 뒤에는 기존 receipt_delivered가 staging을 막는다. 한 경로가 완료돼도 다른 경로 outbox를 삭제하지 않으며, 용량 부족은 두 항목 모두 rollback하고 원본 receipt를 보존한다. DB schema/기존 데이터/중앙 wire는 변경하지 않았다. CORE projection 선택은 최초 staging 때 고정하며 설정 변경만으로 이미 대기 중인 native 영수증을 backfill하지 않는다.
- 소스47개/exit0/1.073초. offline wheel build exit0,privacy_bubble_gateway-0.2.2-py3-none-any.whl40491bytes,SHA256 88c5efa07fd2f376d005f2665478baa14cf44f055e57874ce3952ee0ebb1eca3. 새 임시 경로 설치 exit0,import 경로·version 확인 후 설치 package에서도47개/exit0/1.068초다.
- 소스3dd2e20 일반 push 성공(c1bac3e..3dd2e20,origin/codex/keyring-namho). keyring/evidence/2026-10-30-receipt-routing/에 실제 baseline/source/설치 시험·build/install 로그와 소스/로그/산출물 hash를 보존한다. KR-RECEIPT-ROUTE-01..05는 KEYRING 제안 추적 ID다.
- fake transport·합성 command·테스트 전용 새 SQLite만 사용했다. 기존 DB·실제 broker/CSE·BLE/장비·Pi·daemon·운영 서비스는 실행하지 않았다. firmware는 수정/재빌드하지 않았다. 이전 firmware3개 build와 BLE42개 시험 evidence는 당시 기록으로 유지한다.

이번 턴은 실제 결함 수정과 실행 증거로 progress다. 전체 goal은 active/미완료다. 중앙 승인/settlement/recovery 계약·구매 JD9853 init·지정 기준 원문·실제 Pi/장비·전력/거리·CSE 통합·영상/release는 남아 있다.


## 2026-10-30 — 실제 loopback HTTPS/TLS 경계 증거

직전 goal 턴은 Gateway0.2.2 영수증 staging 수정·소스/설치 package 각47개·wheel build/install·6893ee5까지 push를 완료한 progress였다. 이번 시작/종료 준비 fetch의 main/CORE91a281b·WEB80ed37f는 그대로다. DOC-REV2.0.0을 읽고 KEYRING/R02·R10의 HTTPS·mTLS 실제 실행 증거를 추가했다. goal의 실제 시작 상태는 active다.

- 기존47개는 HTTP 전송 응답을 모의 처리해 SSL handshake를 실행하지 않았다. tests/tls_fixture.py·test_https_tls.py를 추가하고 임시 trusted/rogue test CA·client/server 인증서와127.0.0.1 전용 server로 실제 Python SSL/httpx·HTTP를 시험했다. 개인키/인증서는 매 suite 임시 생성·종료 삭제하며 파일을 commit하지 않았다. proxy 대조 socket도 시험이 소유한 임시 loopback listener다.
- TLS전용8개/exit0/1.765초, 전체 source55개/exit0/2.450초, 기존 설치 package55개/exit0/2.481초, 모두skipped0이다. TLS1.3·test client CN=gw-test·oneM2M header/UTF8 body/rn을 확인했고 잘못된 CA·client·SAN/IP·무인증·TLS1.2와 redirect·proxy 경계를 검사했다. OpenSSL 실행 파일이 없으면 skip하지 않고 실패한다.
- Windows11/Python3.12.14, Python SSL OpenSSL3.5.8, 인증서 도구 Git OpenSSL3.5.5다. runtime Gateway0.2.2 source3dd2e20은 수정하지 않았다. 기존 wheel SHA256 88c5efa07fd2f376d005f2665478baa14cf44f055e57874ce3952ee0ebb1eca3을 재사용했고 import 경로·version 및 모든 Python module의 소스 일치를 확인했다. package/firmware 재빌드는 하지 않았다.
- 시험 source76253ce 일반 push 성공(6893ee5..76253ce,origin/codex/keyring-namho). keyring/evidence/2026-10-30-https-tls/에 실제3개 실행 로그·소스/로그/기존 wheel hash를 저장한다. KR-HTTPS-TLS-01..08은 KEYRING 제안 ID이며 G-SEC의 로컬 부분 증거다. 중앙 gate 승인을 채우지 않았다.
- 실제 PKI의 principal→AE/Originator binding·grant/ACP, MQTT TLS/ACL·broker/CSE, Pi/BlueZ/장비·기존 DB·daemon·운영 서비스는 실행/검증하지 않았다. test HTTPS 서버를 operational CSE로 표기하지 않는다. 실물 단계의 실제 대상을 확보하려고 Pi SSH 별칭/주소와 키링 보드·화면 준비 상태를 async로 질문했다. 비밀번호·개인키를 요청하지 않았다. 답변 전 실제 장비 연결/flash를 시작하지 않는다.

이번 턴은 기존 미확인 HTTPS/TLS 경계를 실제 로컬 wire로 확인한 progress다. 전체 goal은 active/미완료다. 임시 Mobius4 빈 자원 provisioning과 새 TLS fixture는 Pi→CSE→앱/웹 실물 통합을 대체하지 않는다. 중앙 승인/settlement/recovery 계약·구매 JD9853 init·지정 원문·실측/영상/release도 남아 있다.


## 2026-10-30 — 실제 Mosquitto MQTT/TLS/ACL wire 증거

직전 goal 턴은 실제 loopback HTTPS/TLS8개·소스/기존 설치 package55개씩·bf75795까지 push를 완료한 progress였다. 이번 시작/종료 준비 fetch의 main/CORE91a281b·WEB80ed37f는 그대로다. DOC-REV2.0.0을 읽고 KEYRING/R02·R03·R10의 실제 MQTT 경계를 확인했다. goal 실제 시작 상태는 active다. Pi SSH 별칭/주소·보드/화면 준비 상태의 기존 async 질문은 답변 대기이며 반복 질문하지 않았다.

- Docker daemon29.4.0과 캐시된 eclipse-mosquitto:2 이미지를 확인했다. 실제 Mosquitto2.1.2/Linux amd64, sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f다. --pull never로 새 이미지를 다운로드하지 않고 매 시험 별도 token/container·test PKI·127.0.0.1 임시 포트를 사용했다. 기존 개발 서버4개를 변경/재시작하지 않았다.
- integration_tests/를 기본55개와 분리한 opt-in suite로 추가했다. 실제 Paho/Mosquitto MQTT3.1.1·TLS1.3/mTLS, CN별 topic ACL, matching oneM2M rqi/rsc2001, PUBACK만 있을 때 같은 cin으로 HTTPS fallback, wrong-rqi 무시, rsc4103 거절 시 우회 금지, Other Originator PUBLISH 거절을 확인했다. 실제 broker 종료 때10초 response timeout 전에 pending future가 ConnectionError로 끝남도 assert했다. oneM2M 응답 peer는 합성 fixture이며 Mobius/CSE나 authorization API가 아니다.
- 최종 소스 integration6개/exit0/17.845초, 설치 package integration6개/exit0/17.956초. 변경한 공통 test PKI helper를 포함해 기본 suite도 소스55개/exit0/2.497초·설치55개/exit0/2.364초다. 모두skipped0. 설치0.2.2의 import 경로·version·모든 Python module의 소스 일치를 확인했다.
- runtime source3dd2e20·Gateway0.2.2·기존 wheel SHA256 88c5efa07fd2f376d005f2665478baa14cf44f055e57874ce3952ee0ebb1eca3은 변경/재빌드하지 않았다. TestPki.leaf에 test-only subject 지정만 추가했다. 시험 source5dec2c0 일반 push 성공(bf75795..5dec2c0,origin/codex/keyring-namho).
- keyring/evidence/2026-10-30-mqtt-wire/에4개 실행 로그·각 source/설치 broker6개씩 총12개 broker 로그·환경/image/소스/로그/기존 wheel hash를 보존했다. broker 로그는 실제 TLS cipher·certificate username·QoS/deny 동작을 포함한다. 시험 종료 후 ownership label이 붙은 컨테이너0개, 기존 개발 서버4개 running을 읽기로 확인했다. 임시 인증서/키는 종료 삭제했고 commit하지 않았다.

이번 턴은 실제 broker와 HTTP fallback wire 경계의 실행 증거를 추가한 progress다. 전체 goal은 active/미완료다. 중앙 PKI·principal/AE/grant/ACP·실제 CSE 저장/정산, Pi/BlueZ·키링 실물·전력/거리·구매 JD9853 init·지정 원문·영상/release는 남아 있다. 실제 integration을 합성 프로토콜 peer로 대체해 완료로 표시하지 않는다.
