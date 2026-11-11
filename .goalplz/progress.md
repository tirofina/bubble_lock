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


## 2026-10-30 — 실제 Mobius4 저장 통합 / Gateway0.2.3

DOC-REV2.0.0을 읽고 KEYRING/R02·R03·R10·R11의 실제 CSE 경계를 시험했다. 시작 상태 active, 직전 checkpoint2df3dc2다. main/CORE91a281b·WEB80ed37f는 최종 명시적 fetch에서도 그대로다. WEB ref를 WEB-DASHBOARD로 잘못 지정한 fetch는 missing-ref로 실패했고, 로컬 refs에서 실제 feature/web-dashboard를 확인해 수정했다. 인증/접속 오류는 없었다. Pi SSH/보드·화면 준비 상태 질문은 기존 답변 대기다.

- 캐시된 실제 Mobius4 upstream e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8, 새 tmpfs PostgreSQL/PostGIS, Mosquitto2.1.2·nginx로 test-owned stack을 실행했다. image pull·기존 개발4개 container/기존 DB 변경은 없다. fresh PKI·합성 admin mapping·loopback 임시 포트만 사용했다.
- setup1은 Docker UTF8출력을 CP949로 디코딩해0tests/1error, 남은 CSE/network는 exact label/token 확인 후 정리했다. Docker helper encoding을 UTF8로 수정했다. setup2는 proxy test CA 파일명 불일치로0tests/1error, trusted.pem으로 수정했다. 실패 로그도 보존한다.
- baseline 실제 CSE5개 중4pass/1error: MQTT To에 HTTP 선행 슬래시를 복사해 SP-relative로 잘못 해석됐다. baseline은 숫자 rsc를 출력하지 않아 임의 기재하지 않았다. TS-0009 HTTP mapping 역변환으로 CSE-relative/SP-relative/absolute3가지를 수정했다. HTTP경로·rqi/rn/con·outbox/DB schema·중앙 승인 계약은 유지했다.
- source 기본56개/2.309초, MQTT6개/17.732초, 실제 CSE5개/19.375초. 설치본 기본56개/2.485초, MQTT6개/17.584초, 실제 CSE5개/19.123초. 각각exit0/skipped0. 실제 cin 저장/조회, MQTT3가지 주소와 HTTPS POST fallback0회, 동일내용 중복cin1개, 내용충돌4105/원본보존, CSE만 재시작한 뒤 DBcin보존을 확인했다. DB재시작/전원손실은 시험하지 않았다.
- offline0.2.3 wheel build/install 성공,40685bytes,SHA256 fd6254cea210059330d14910ca0bb2299b638b8b8e98bec70a808befbbc4e63d. 새 install target의 import/version/모든Python module LF 정규화 일치를 확인했다. firmware0.7.0 소스/설정은 변경하지 않았고 이전3개 프로필 build 증거를 유지한다.
- source a970e3a5b2586cc80abd6eea49fb685dc79ab740 일반 push 성공(2df3dc2..a970e3a). keyring/evidence/2026-10-30-real-cse/에 최종6개시험로그·초기실패·baseline·실제broker/CSE/SQL/proxy로그와 소스/환경/image/wheelhash를 보존한다. 최종test-owned container/network잔여0, 기존개발4개running 확인. PKI개인키·DB·wheel binary는 commit하지 않는다.

이번 턴은 실제 CSE통합을 통한 오류수정·검증 progress다. 전체goal은 active/미완료다. 운영principal/AE/ACP/grant·INTEGRATION승인/settlement/recovery·Group/SDT·실물Pi/BLE/키링/앱/웹·전력/거리·JD9853공장init·지정원문·영상/release는 남아 있다.


## 2026-10-30 — 영속 큐와 실제 CSE 장애/프로세스 복구

직전 턴은 Gateway0.2.3 MQTT주소 수정·source/installed 기본56/MQTT6/CSE5와76e6f51까지 업로드한 progress였다. 이번 시작 상태active, DOC-REV2.0.0 재독·팀브랜치 fetch main/CORE91a281b·WEB80ed37f 동일이다. Pi SSH/보드·패널 준비 상태 기존 질문은 답변 대기이며 실제 장비 접근은 시작하지 않았다.

- 기존 CSE5개는 TransportHub만 확인해 actual SQLite와 Gateway._outbox_loop의 장애창을 덮지 않았다. CSE suite에5개를 추가했다. 새 SQLite reopen/dedup→실제 CSE, 합성INDETERMINATE receipt의 MQTT application response 후 delivered0→1, CSE중단 중 동일rqi/payload와backoff 유지/reopen/복구, 원격저장 직후 test child os._exit(73) 뒤 WAL/outbox복구·동일요청cin1개, 내용충돌 때 원격원본/로컬행 보존이다.
- test-only delivery_child.py는 송신loop만 실행한다. Store.delivered 직전 종료를 주입하고 실제SQLite연결을 닫지 않는다. parent는 같은DB를 열고 같은rqi로재전송, cin1/outbox0을 확인했다. idle/backoff정지는 parent의_pause 대체다. BLE·credential/poll/dispatch/health·full daemon·Pi를 실행하지 않았다. 관측/receipt는 합성이며 실제actuation이나중앙정산증거가 아니다.
- source10개33.125초·설치10개33.083초, 각각exit0/failure0/error0/skipped0. 기존CSE5개도 포함한다. 의도한child종료73과전체unittest종료0을 구분했다. runtime0.2.3과DB schema·firmware0.7.0은 변경하지 않았다. 기존wheel SHA256 fd6254cea210059330d14910ca0bb2299b638b8b8e98bec70a808befbbc4e63d의import/version/모든Python module일치를 다시확인했다. 기본56/MQTT6/firmware3은 이번에 변경/재실행하지 않고직전증거를 유지한다.
- 시험소스2166ded59caa05660c2d97e8d961c074345e27fa 일반push성공(76e6f51..2166ded). evidence/2026-10-30-outbox-cse에source/installed10개로그·5개씩deliveryfacts·실제broker/CSE/SQL/proxy로그54파일·소스/환경/image/wheelhash를 보존했다. token소유container/network0개·기존개발4개running확인. 개인키/인증서·DB·wheel binary는commit하지 않는다.
- COMPLETION_GAPS를현행0.2.3과원래산출물/7자료/통합조건으로갱신했다. 세지정원문을저장소/원작업공간root에서다시조회해미발견확인. 원래A01~A26매핑·approver·release를만들지않았다.

이번은 실제영속송신복구경계의새증거를확보한progress다. 전체goal은active/미완료이며 실물Pi/키링/BLE·운영PKI/AE/ACP/grant·INTEGRATION승인/정산/recovery·Group/SDT/앱/웹·JD9853자료·전력/거리·영상/release가남아있다.


## 2026-10-30 — Linux POSIX 상태 CLI 실제 실행

직전 턴은 actual Store/송신loop/CSE10개·5884554까지업로드한progress였다. 이번시작active·DOC-REV2.0.0/AGENTS재독·팀fetch main/CORE91a281b·WEB80ed37f동일. 기존Windows기본tests는directory fsync를대체했고STATE_RECOVERY문서는실제CLI미실행이었다. 이경계를독립진행했다. 기존Pi질문은답변대기다.

- 캐시PostGIS에서/usr/bin/python3 --version확인은실행파일부재/exit127. --rm인새probe뿐이며기존DB/서비스는없다. 캐시개발base9a2d989412a4fcd7645394f7d42683c89a7dbd03ed8780c8c388f07625660d70에Python/pip개발package를설치한전용image를만들었다. build중AlpineAPK다운로드가있었고baseimagepull은없다. PKI생성entrypoint는실행하지않았다.
- 실제Linuxx86_64/Alpine3.21.9/Python3.12.16/SQLite3.48.0/WSL2kernel6.6.87.2·UID65532. 시험은network none·read-onlyroot·source/wheelreadonly·새/tmp와256KiB/limited tmpfs만사용했다. source/installed 각10개 통과. 실제flock다른프로세스→CLI/daemon entry차단, fsync/0700/0600/WALsnapshot, 합성legacyadopt/hash검사, quarantine, ENOSPC28/partialoutput, 기존output/symlink거절, 실fsync후외부SQLitewrite감지를확인했다. timeout=-1은API기한경과만확인했다.
- 최초직접실행source10/1.339초·설치10/0.801초 exit0. 재현run-posix.ps1구현후source10/1.289초·설치10/0.818초로다시실행해exit0/skipped0. runner는logoverwrite를거절하고exactname/token을확인한자원만정리한다. 실제installed console entry와모든Python module LF일치를확인했다. 기존wheel0.2.3 SHA256 fd6254cea210059330d14910ca0bb2299b638b8b8e98bec70a808befbbc4e63d 재사용·재빌드없음. runtime/DBschema/firmware는변경하지않았다.
- source0017edac40815f9d3a812d7f858705496f7aaa3b 일반push성공(5884554..0017eda). evidence/2026-10-30-posix-state에imagebuild·최초/runner실행로그·runtime/runner metadata·source/image/wheelhash를보존했다. 소유container잔여0·기존개발4개running. DB/envplaceholder는container내삭제했고실제PKI/기존DB/장비/BLE/full daemon은없다. daemon entry는lock에서serve전에중단됐다.
- STATE_RECOVERY미실행선언을실제로컬증거와Pi/운영잔여범위로갱신했다. 기본56/MQTT6/CSE10/firmware3은이번에변경/재실행하지않고이전evidence를유지했다.

이번은미검증POSIX운영경계의새실행증거와재현runner를추가한progress다. 전체goal active/미완료. tmpfs fsync는Pi SD전원손실증거가아니다. 실물Pi/키링/BLE·운영DB·중앙principal/AE/ACP/grant·INTEGRATION승인/정산/recovery·Group/SDT/앱/웹·JD9853자료·전력/거리·영상/release는남아있다.


## 2026-10-30 — 외부 통합 의존성 확인 / no-progress 감사1

직전 goal턴은 Linux POSIX10개 source/installed 실행·재현runner·d057f11 push를 완료한progress다. 이번은no-progress1로분류한다. 진행중인실행handle을기다리는verified wait가아니며, 문서/상태기록commit을구현진전으로세지않는다.

- DOC-REV2.0.0과KEYRING완료조건을재독했다. git ls-remote --heads 실제원격은main/CORE91a281b·웹80ed37f·KEYRINGd057f11의4개뿐이다. APP/INTEGRATIONbranch는없고새팀계약도없다.
- pc-mobius/src/gateway-bridge.mjs:257의sendCommand는deviceId/commandId/desiredState/deadline/epoch/issuedAt만만든다. claimId/grantRevision이없다. pc-mobius/src의3개mjs에서Gateway commands/authorize/credentials API구현을찾지못했다. KEYRING의authorize/credentialclient는준비됐으나중앙승인응답을만들어우회할수없다.
- project workspace와사용자가지정한첨부폴더에서contracts_round/active_release/Hackathon Rubric/design_plan/review_policy 파일명패턴을찾았으나없다. 이검사는파일명범위이며archive내부/다른이름/다른PC/원격의부재를주장하지않는다.
- 기존Pi SSH/보드·화면준비질문은답변대기다. 이번에INTEGRATION API계약파일/브랜치/PR주소를별도async질문했다. 응답전실물접속/flash/기존DB/운영서비스나중앙계약종속개발을시작하지않는다.
- 남은핵심은실물Pi/키링/BLE·중앙principal/AE/ACP/grant/명령API·정산/checkpoint/recovery·실물전력/거리/영상/release·구매JD9853 init/원문이다. 현재자료로진행할독립필수구현은확인하지못했다. 임의승인·가짜장비결과·추가fixture를전체완료로대체하지않는다. 새code/build/test실행은없다.

동일외부입력조건의첫no-progress감사이므로전체goal은active/미완료로유지한다. 3회연속동일조건과실제impasse가확인되면goal을blocked로설정한다.


## 2026-10-30 — 외부 통합 의존성 재확인 / no-progress 감사2

시각 2026-10-30T03:08:42.347402+00:00. 직전355bcf0은대기원인기록뿐인no-progress1이다. 이번도no-progress2이며live handle에대한verified wait가아니다. 최신계획서DOC-REV2.0.0을재독하고원격heads를다시조회했다. main/CORE91a281b·웹80ed37f는변화없고APP/INTEGRATIONbranch도없다. KEYRING355bcf0만문서기록으로바뀌었다. 로컬수정사항은없었다.

Pi SSH/보드·패널준비답변과INTEGRATION API계약파일/브랜치/PR답변이아직없다. CORE명령의claimId/grantRevision·중앙승인/정산/checkpoint/복구입력공백이같아서실물/중앙통합을진행할수없다. 기존질문을반복하거나승인/결과를임의생성하지않았다. 독립필수구현을새로확인하지못했고code/build/test·장비/운영실행은없다. 이메타데이터commit을구현진전으로세지않는다.

동일조건2회연속이므로현재goal은active/미완료다. 다음goal턴에서도동일조건과impasse가확인되면3회기준에따라blocked로설정한다.


## 2026-10-30 — 동일 외부 의존성3회 확인 / goal blocked

시각 2026-10-30T03:09:21.672985+00:00. 직전ad17aac은no-progress2의상태기록이었다. 최신DOC-REV2.0.0을재독하고git ls-remote --heads와원본sendCommand257~261행을확인했다. main/CORE91a281b·웹80ed37f는여전히같고APP/INTEGRATIONbranch는없다. KEYRINGad17aac까지의변경은감사기록뿐이다. CORE에는claimId/grantRevision이없고중앙commands/authorize/credentials·정산/checkpoint/복구계약입력도추가되지않았다. Pi SSH/보드·패널준비및API계약경로의기존질문에새답변이없다.

동일차단조건의3번째연속no-progress이며liveprocess에대한verified wait가아니다. 독립필수구현을진행할근거가없으므로update_goal(status=blocked)를호출했고실제반환상태blocked를확인했다. 전체목표는완료되지않았다. 새로운code/build/test·실물/운영실행은없다. 이번최종기록upload도구현진전으로세지않는다.

재개입력: 실제Pi SSH별칭/주소와보드·패널준비상태, INTEGRATION의정본commands/authorize/credentials API계약파일/브랜치/PR와이후정산/checkpoint/복구·모듈init/원문자료. 실제비밀번호/개인키는요청하지않는다. 새정보또는외부상태변경을받고재개할때현재원격/계약부터다시확인한다.


## 2026-11-10 — Feather ST7789 벤치와 Pi 네트워크 진단

DOC-REV 2.0.0. 원격 main `715ef58`와 CORE `d54a43a` 확인. main의 `413fd31`에서 중앙 명령·승인·자격 상태 API를 찾았고 KEYRING BLE 탐색 취소 수정과 회귀시험을 반영했다. Windows에서 새 인증서로 Node/Python mTLS 교차시험 1개, Docker ARM64 Debian에서 설치 Gateway 시험 57개 통과.

기존 Feather ESP32 V2·1.54인치 ST7789·A0/A1 배선에 맞는 별도 벤치 펌웨어를 추가했다. 기본과 BLE 활성 빌드 2개 통과. Windows의 제한된 벤치 광고 검색 실행은 성공했고 대상 0개. COM12는 Windows 장치 목록에서 확인했다. 실물 업로드와 BLE 연결 시험은 별도 단계다.

Pi Zero 2 W는 USB 데이터 포트에 연결됐고 초록 LED가 계속 켜져 있다. Windows에 Gadget 네트워크 어댑터가 없고 해당 Wi-Fi는 5GHz 채널 153으로 확인됐다. 사용자가 Pi의 네트워크를 재설정 중이다. 다음 단계는 Pi 호스트명/IP와 SSH 확인, Feather 시험 업로드 승인 및 장치 관측이다. [실행 기록](../keyring/evidence/2026-11-10-feather-arm64/README.md)


## 2026-11-10 — Feather 실물 교체와 Windows BLE

사용자 승인으로 Feather ESP32 V2·1.54인치 ST7789·A0/A1 구성에 시험용 펌웨어를 올렸다. COM12 업로드 해시 검증, `FEATHER PROBE READY` 부팅 로그, Windows PIN 페어링, Gateway `released` 수신을 확인했다. 180초 관측에서 A0/A1은 수신되지 않아 버튼 입력과 실제 화면 표시 확인이 남았다. 복구 파일 4개와 시험 PIN은 로컬에 보관했다. main/CORE/WEB HEAD는 이전 확인과 같았다. [실물 실행 기록](../keyring/evidence/2026-11-10-feather-device/README.md)

## 2026-11-10 — 화면 유지·실물 Pi 등록·BlueZ 오류 수정

사용자가 현재 구성은 화면·Feather·버튼 두 개임을 확정하고, 순간 표시 현상을 보고해 마지막 입력 화면을 유지하는 `feather-probe-0.1.1`로 수정·빌드·COM12 업로드했다. 해시·부팅 확인 후 사용자가 A0/A1 전환과 해제 후 화면 유지를 확인했다. 실제 BLE 관측 상태는 누름·해제를 유지한다.

사용자가 재설정한 Pi에 제공한 계정으로 SSH 접속했다. Zero 2 W Rev1.0, Debian13.7 aarch64, Python3.13.5, BlueZ5.82를 확인했다. Bluetooth soft block을 해제하고 로컬 PIN으로 한 Feather만 인증·bonding했다. Pi 벤치 가상환경에 Gateway를 설치했다.

실물 Pi에서 initial READ가 BlueZ notify callback에도 전달돼 JSON fragment 버퍼를 오염시키는 오류를 재현했다. 초기 READ를 observation 구독 이전으로 옮기고 모의 회귀시험의 수정 전 FAIL→후 PASS, 전체58개 통과를 확인했다. 보안·형식·generation 검사를 유지한 Gateway0.2.4 wheel을 Pi에 설치하고 소스 일치를 확인했다. 실제90초45개 관측·연결 상태18회 모두 정상, 사용자 버튼 입력으로 released/confirm/panic 수신·observer exit0을 확보했다.

원격 main715ef58/COREd54a43a/WEB80ed37f는 시작 조회에서 이전과 같았다. PIN·SSH 암호·주소·raw BLE 로그는 공개하지 않았다. 전체 daemon/Pi→CSE/실물PCB/앱·웹 통합은 남았고 Docker API는 엔진 pipe 부재로 연결되지 않았다. [실물 Pi 실행 기록](../keyring/evidence/2026-11-10-pi-feather/README.md)

## 2026-11-10 — 실물 Pi에서 HTTPS·MQTT·서버 장애 복구

직전 `686f7b4`에서 Gateway0.2.4·Feather0.1.1·실물 BLE 증거를 업로드했다. 이번 DOC-REV2.0.0과 원격 main715ef58/COREd54a43a/WEB80ed37f를 재확인했고 팀 HEAD는 같았다. Docker 엔진이 다시 정상 응답한 뒤 사용자 목표의 임시 PC Mobius4 서버와 실물 Pi/Feather 경로를 진행했다.

- 새 `relay.py` 벤치 도구는 실제 BLE·Gateway 관측 검증·SQLite·outbox 송신·제품 MQTT/HTTPS를 사용한다. 기존 DB를 거부하고 새 private 출력·명시적 환경 파일 격리·전체 제한시간·실패 receipt·송신 경로 집계·CSE canonical readback을 추가했다. 모의 BLE/HTTP와 실제 임시 SQLite 회귀시험4개 통과, 독립 read-only 검토에서 차단 결함 없음. 제품 Gateway/펌웨어는 이번에 변경하지 않았다.
- 기존 개발 container/DB 네 개를 보존한 새 test-owned CSE/PostgreSQL/nginx/Mosquitto와 fresh PKI를 사용했다. Pi loopback에서 Windows loopback으로 SSH reverse tunnel 두 개를 사용했고 방화벽/LAN bind·운영 권한을 변경하지 않았다.
- 실제 `released` 관측35개: HTTPS 정상5+정상5+CSE중단복구5, MQTT5(HTTPS0), broker중단 후 HTTPSfallback15(MQTT0). 모두 CSE 저장값을 읽어 원본 hash 일치. 마지막 cni35, 다섯 Pi SQLite outbox 각각0, private directory0700/DB0600 확인. 별도 Pi TLS probe 둘은 TLS1.3을 실측했다.
- CSE만 중단했을 때 pending5/attempts1을 확인하고 같은 송신 프로세스에서 복구 후5건을 완료했다. MQTT 응답 구독 준비 후 broker만 중단한 별도 run은15건을 HTTPS로 완료했다. 해당 run의 관측2개 확인 시각은 broker중단 뒤이며, 중단 전 MQTT성공으로 표시하지 않았다. 정상MQTT5건은 별도 run이다.
- 최초 host setup은 request_timeout 누락으로 실패/정리했고 수정한 새 폴더에서 재실행했다. 최초 stop 제어는 Docker inspect UTF8을CP949로읽다 실패하여 실제서버가 중단되지 않았다. 당시 `outage` 이름의 run은 정상HTTPS로 기록했고 실제장애는 `outage-02`다. 실패를 성공장애시험에 합산하지 않았다.
- runner exit0·소유 container/broker/network 잔여0·SSH터널 종료·기존 개발 네 container running을 확인했다. 공개증거에는 raw관측·DB·개인키·PIN·SSH암호·실제BLE주소를 제외했다. [실행 증거](../keyring/evidence/2026-11-10-pi-cse/README.md)

현재 goal은 active/progress/미완료다. 실물 관측→임시CSE 전송은 검증됐고, 전체 daemon의 중앙 승인 명령·ACK, pb:binarySwitch/Group·앱/웹, 제작PCB·전력/거리·SD전원손실·운영 principal/AE/ACP/grant·영상/release는 남았다. 이번 relay/증거를 역할 브랜치에 일반 commit/push한다.

업로드 확인: 구현·회귀시험·35개 실물 관측 증거 commit `dfa5129c2374070f8e3fcdf46fa85eefb2ca9663`를 `origin/codex/keyring-namho`에 일반 push했고 exit0 / `686f7b4..dfa5129`를 확인했다. 이 뒤 기록 commit은 업로드 상태만 현행화한다.

## 2026-11-10 — 중앙 명령 연결 대기와 native receipt

이전 goal turn은 실물 관측35개와 역할 브랜치 `615de79`를 확보한 progress다. 이번 DOC-REV2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 HEAD는 같으며 main의 중앙 API와 팀 시험 fixture를 별도 임시 경로로 추출해 사용했다.

- Gateway 0.2.5는 인증된 GATT의 쓰기 가능한 명령 세션까지 `RECEIVED` 상태로 기다린다. 세션 교체 시 승인을 다시 받아야 하며 이전 generation에 대한 승인은 새 연결에 쓰지 않는다. 대기 행이 후속 장치를 막지 않도록 SQLite rowid 범위로 dispatch 배치를 순환한다. 정상 stop의 worker 완료 경합을 수정했다.
- 기본 63개와 팀 Node mTLS API→전체 Gateway worker→모의 GATT→실제 격리 Mobius4 통합 2개가 통과했다. 승인된 명령은 중복 poll에도 한 번 처리되고 native receipt 1건이 저장됐다. 연결 전에 grant를 회수하면 쓰기 0회, 거절 receipt 1건이다. 두 경우 CSE의 내용을 SQLite와 대조했고 정상 종료했다. [증거](../keyring/evidence/2026-11-10-central-dispatch/README.md)
- 새 PKI·DB·시험 stack만 사용했다. 종료 후 시험 container/network 0개와 기존 개발 4개 running을 확인했다. 이번에는 Pi에 0.2.5를 설치하거나 Feather에 flash하지 않았다.
- 전체 goal은 active/progress다. 실물 GATT 명령·출력, 제작 PCB, Pi systemd, CORE의 HTTP 발급 명령과 ACK 결속, 운영 principal/AE/ACP/grant, 앱/웹·전력/거리·영상/release가 남았다.

Gateway 0.2.5 wheel 로컬 빌드와 Python 모듈 13개 소스 일치를 확인했다. 구현·시험 증거 commit `2014b18bb44ce5e9304cb9494de743313f3bf1e2`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `615de79..2014b18`이다.

## 2026-11-10 — 실물 명령을 위한 Feather 내장 LED 프로필

이전 goal turn은 중앙 mTLS·Gateway 전체 worker·모의 GATT·실제 CSE의 명령 영수증 시험 2개를 확보한 progress다. DOC-REV 2.0.0과 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 재확인했으며 팀 HEAD가 같았다.

- 기존 배선의 Feather V2 GPIO13 내장 LED를 시험 출력으로 선택했다. opt-in 명령 프로필 0.2.0이 CORE v1 WRITE/NOTIFY, 인증·구독·세션 확인, 상대 기한, 16개 NVS intent/완료 journal, epoch·grant, GPIO readback을 처리한다. 실제 핀 값을 관측과 ACK로 보낸다. 기존 0.1.1 관측 프로필과 버튼 화면 동작은 이어간다.
- 실제 보드용 컴파일은 관측·명령 두 프로필 exit 0이다. 첫 컴파일에서 sample 내부 변수 위치를 잘못 넣어 실패했고 위치를 수정한 최종 소스로 다시 빌드했다. MSVC에서 실제 명령 코드와 모의 NVS·GPIO를 실행한 네 그룹도 통과했다. [빌드·시험 로그와 해시](../keyring/evidence/2026-11-10-feather-command/README.md)
- 합성 PIN 빌드 산출물은 로컬에 보관했다. 실물 업로드와 Pi 명령·LED·CSE 영수증은 대기 중이다. 실제 LED 시험이 제작 PCB의 센서·모터·전력 수용이나 CORE 정산을 대체하지 않는다.

구현·빌드·시험 증거 commit `cd4818b77f2ef05552e4fabe3c096ac9942d739e`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `7b2b295..cd4818b`다. 전체 goal은 active/progress다.

## 2026-11-10 — 실제 Pi의 Gateway 전체 데몬과 재시작

이전 goal turn은 Feather 명령 프로필 소스·빌드·호스트 시험을 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 다시 확인했다. 팀 HEAD는 이전과 같다.

- 팀 중앙 API와 Mobius4를 별도 시험 PKI·새 PostgreSQL로 실행하는 fixture를 추가했다. 팀 main의 API 원본은 임시 폴더에 추출해 사용했다. Pi에는 Gateway 0.2.5 wheel을 새 target에 설치했고 소스 파일 13개가 wheel과 바이트 일치했다.
- Pi의 임시 사용자 systemd 두 unit에서 전체 worker를 실행했다. 첫 실행 BLE timeout 1회 뒤 연결됐고 시험 credential `ACTIVE` 상태에서 실물 관측 27개와 health 16개가 CSE에 저장됐다. 마지막 시퀀스 2284와 장치·부팅 ID가 Pi SQLite와 일치했다.
- 첫 종료 직전 대기 관측 2230은 CSE에서 404/4004였다. 같은 DB로 재시작한 뒤 200/2000으로 조회됐고 원본 해시가 일치했다. 최종 outbox 0, 두 unit exit 0 및 종료 뒤 `not-found`를 확인했다.
- 시험 container/network 잔여 0, 기존 개발 container 4개 실행, 터널 종료와 시험 client 키 복사본 제거를 확인했다. [실행 기록과 해시](../keyring/evidence/2026-11-10-pi-full-daemon/README.md)

전체 goal은 active/progress다. 현재 Feather 0.1.1로 관측·상태만 검증했다. 별도 승인 뒤 0.2.0 실물 명령, 제작 PCB·센서·출력·전력, 배포용 systemd와 운영 권한 등록, CORE 정산·앱/웹·release 검증이 남았다.

fixture와 실물 실행 증거 commit `f7e917cfbc4a77ddc2e11bac80f7146a363f4986`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `77b5ba8..f7e917c`다.

## 2026-11-10 — 배포용 systemd 시작 전 설정 검사

이전 goal turn은 실제 Pi 전체 데몬과 관측 재전송을 검증한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 재확인했다. 팀 HEAD는 이전과 같다.

- Gateway 0.2.6에 `--check-config`를 추가하고 배포 unit의 `ExecStartPre`로 연결했다. 실제 transport와 같은 TLS context 함수로 CA·인증서·키를 확인한다. `STATE_DIRECTORY` 안에 SQLite와 잠금 파일이 있어야 하며, 점검 중에는 DB·잠금 파일을 만들지 않는다.
- 기본 67개가 통과했고 로컬 wheel의 모듈 13개가 원본 소스와 일치했다. Ubuntu WSL systemd에서 정상 설정은 본 실행 표시까지 도달했고, 키 불일치와 상태 경로 이탈은 그 전에 차단됐다. 세 경우 상태 파일 0개다. 첫 실행에서 fixture의 반복 `Environment` 파싱을 수정한 뒤 재실행했다.
- 시험 unit과 임시 경로를 정리했다. Pi의 0.2.5 실물 관측 증거와 이 0.2.6 로컬 배포 검사는 범위가 다르다. 배포 unit 운영 설치·중앙 운영 PKI·실물 명령·제작 PCB·정산은 남아 있다. [시험 기록](../keyring/evidence/2026-11-10-deployment-preflight/README.md)

구현·시험 증거 commit `106050ae31a087268ad38d9bf406348dedd9cd29`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `8fdbaec..106050a`다. 전체 goal은 active/progress다.

## 2026-11-10 — 중앙 HTTP 명령과 CORE ACK 결속

이전 goal turn은 Gateway 0.2.6 배포 시작 검사와 실제 WSL systemd 시험을 완료한 progress다. DOC-REV 2.0.0, main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 다시 확인했다. 팀 HEAD는 이전과 같다.

- 팀 mTLS API에서 발급한 명령, Gateway 전체 worker와 모의 GATT, 실제 격리 Mobius4로 native receipt를 저장·조회했다. 실제 실행 전 승인 응답과 CSE readback을 Node 시험에 전달했다.
- 팀 CORE 원본은 HTTP 발급 ACK를 `REVIEW`로 분류했다. CORE 등록 뒤 ACK hash만 바꾼 사례는 `ACK_RECORDED`로 기록됐다. 이 결과는 합성 MQTT를 사용한 원본 handler 직접 호출 범위다.
- KEYRING 결속 후보는 인증된 Gateway·발급 명령·승인 응답과 native receipt를 비교한다. 정상 2개와 변조/거절 7개를 확인했다. 별도 권한 회수 실행은 BLE 쓰기 0회, 거절 receipt 1개였다. 시험 container/network 잔여 0을 확인했다. [증거](../keyring/evidence/2026-11-10-core-ack-binding/README.md)
- 운영 ACK 수신기 연결과 원자적 정산은 팀 owner 단계다. Feather 0.2.0 플래시·실물 명령과 제작 PCB 수용이 남았다. 전체 goal은 active/progress다.

후보 코드·재현 증거 commit `c441f7c7586f9b5dfbf45e143e88de9bec42765d`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `7891d2c..c441f7c`다.

## 2026-11-10 — 중앙 명령 수신 우선순위

DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 HEAD는 이전과 같다.

- Gateway 0.2.7은 MQTT 대기열과 관계없이 중앙 HTTPS 목록을 조회한다. 같은 commandId에서는 중앙 발급본을 배치에 넣는다. MQTT 단독 사본은 실제 중앙 권한과 해시·기한 확인 뒤에만 저장 대상이 된다. 이미 저장한 명령과 영수증은 그대로 유지한다.
- 기본 71개와 팀 중앙 mTLS 통합 3개가 통과했다. 새 사례는 목록 조회 실패를 주입하고 실제 팀 API가 같은 ID의 변조본을 거절하며 정확한 사본을 승인하는지 확인했다. 기존 두 사례에서 모의 GATT와 격리 Mobius4 receipt를 재확인했다. wheel의 모듈 13개가 소스와 일치했다. [시험 증거](../keyring/evidence/2026-11-10-command-ingress/README.md)
- 0.2.7 Pi 설치와 실제 broker 명령 수신 시험은 남아 있다. 다음 실물 관문은 Feather 명령 프로필과 Pi를 이용한 출력·receipt·CSE 대조다. 운영 CORE 정산·제작 PCB 수용은 별도 관문이다. 전체 goal은 active/progress다.

소스 및 시험 증거 commit `cbef49eb88999dc173f4455666da45c789e073e3`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `058355f..cbef49e`다.

## 2026-11-10 — 실제 MQTT 명령과 ACK 전송

이전 goal turn은 Gateway 0.2.7의 명령 수신 변경을 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- 테스트 전용 CORE/Gateway 인증서와 ACL로 실제 Mosquitto 명령·ACK 토픽을 사용했다. Gateway 인증서의 명령 발행은 ACL이 막았다. CORE 인증서가 보낸 같은 ID의 변조본은 실제 팀 중앙 API가 거절했고 SQLite 명령 행이 생기지 않았다.
- 정확한 원본은 목록 조회 오류를 주입한 상태에서 MQTT로 수신됐다. 장치 연결 후 재승인했고 모의 GATT 명령 프레임 1개, CSE receipt 1건, 수신한 QoS 1 ACK의 CSE 영수증 일치를 확인했다.
- 기본 71개, 중앙 4개, 별도 MQTT 6개가 통과했다. 시험 컨테이너와 네트워크 잔여는 0개다. [시험 기록](../keyring/evidence/2026-11-10-mqtt-command-wire/README.md)
- 팀 CORE 발행기와 운영 ACK 정산, Pi 0.2.7 실물 실행, Feather 출력·제작 PCB 수용은 남았다. 전체 goal은 active/progress다.

시험 코드와 증거 commit `9b0f412adde512a1f28e10fe3f0814e7d13d1290`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `7d44bf2..9b0f412`다.

## 2026-11-10 — Feather ON/OFF 현장 시험 절차

이전 goal turn은 실제 MQTT 명령·ACK 경로를 검증한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- 기존 Pi fixture에 명시적인 ON/OFF 옵션을 추가했다. 기본 실행은 중앙 명령이 0개다. opt-in에서만 PC 시험 Guardian 인증서를 등록하며, 보드의 최근 관측이 맞고 각각의 입력 파일을 만들면 기한이 있는 명령을 한 번 발급한다.
- 부팅 ID, GPIO readback, 후속 관측, CSE receipt를 묶어 기록한다. 읽기 전용 CLI가 SQLite 사본의 명령 본문·해시·전송 완료를 대조한다. 단계가 중단돼도 기록된 발급/관측 증거는 각각 남는다.
- 기본 71개와 리허설 2개가 통과했다. 실제 팀 mTLS와 새 CSE에서 소프트웨어 Feather의 ON/OFF 영수증 2건과 SQLite가 일치했고 변조 영수증은 거절됐다. 시험 컨테이너와 네트워크 잔여 0개다. [시험 기록](../keyring/evidence/2026-11-10-pi-led-rehearsal/README.md)
- Feather 0.2.0 업로드와 실물 Pi·LED 시험, 제작 PCB 수용과 팀 운영 정산은 대기 중이다. 전체 goal은 active/progress다.

시험 절차·코드·증거 commit `a3cf82d8d7c0eb808005a4980fd0410309ed077c`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `f0814e3..a3cf82d`다.

## 2026-11-10 — 현재 부팅의 BLE 적용 영수증

이전 goal turn은 Feather ON/OFF 절차와 로컬 리허설을 완료한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- 수정 전에는 이전 bootId의 `APPLIED`가 현재 연결에서 대기 중인 명령을 성공으로 완료했다. Gateway 0.2.8은 명령 ID와 해시가 맞는 새 `APPLIED`가 현재 bootId를 사용할 때만 수신한다. journal의 과거 `DUPLICATE` readback은 유지한다.
- 기본 73개와 중앙 연동 5개가 통과했다. 모의 GATT에서 이전 bootId를 주입한 사례는 명령 프레임 1개, 미확정 CSE receipt 1건과 자동 재실행 없음으로 끝났다. 실제 팀 API와 격리 Mobius4를 사용했다. wheel 소스 모듈 13개가 일치했다. [시험 기록](../keyring/evidence/2026-11-10-receipt-boot/README.md)
- Pi 0.2.8 설치, 실제 장치의 재부팅·영수증과 Feather 0.2.0 출력 검증은 남았다. 제작 PCB와 팀 운영 정산 역시 대기 중이다. 전체 goal은 active/progress다.

구현·시험 증거 commit `37e654b1f9f9074ffc92e26aa4ee9e222e3112dc`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `cbec589..37e654b`다.

## 2026-11-10 — r18 진동 출력 차단

이전 goal turn은 Gateway 0.2.8 영수증 검증을 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- 펌웨어 0.7.1은 타이머를 먼저 시작한다. AUX 준비 전후 기한·인증 generation·전원 이상을 확인하고 GPIO를 켠다. BLE 종료 콜백도 같은 잠금에서 GPIO를 즉시 내린다.
- 호스트 6개 시험과 provisioning 없는 기본·ST7789·JD9853 빌드가 통과했다. 타이머 실패, 기한·fault 변화, 연결 종료, 만료 정리 중 재활성 차단을 확인했다. [시험과 빌드 해시](../keyring/evidence/2026-11-10-motor-gate/README.md)
- 실제 r18 모터 파형·차단 시간·진동, Feather 명령 flash·Pi 실물 검증과 팀 운영 정산은 대기 중이다. 전체 goal은 active/progress다.

구현·시험 증거 commit `aa0874f818d9629bc752335835fdcaba849c5613`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `3de5360..aa0874f`다.

## 2026-11-10 — Handover 활성 Gateway 결속

이전 goal turn은 r18 펌웨어 0.7.1을 빌드하고 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- 팀 main의 실제 mTLS API에서 전환 전 epoch는 거절됐다. 그러나 등록을 유지한 이전 Gateway에 현재 epoch로 새 명령을 발급하면 기존 API가 승인했다.
- KEYRING 후보는 대상 장치·현재 epoch와 설정에 지정된 활성 Edge/Gateway를 결속한다. 테스트 런타임의 발급·목록·실행 승인에서 이전 Gateway를 차단했다. 대상 Gateway와 롤백 후 재기동한 원래 Gateway는 승인됐다. 누락과 불일치 입력 5개를 거절했다. [실행 기록](../keyring/evidence/2026-11-10-handover-owner/README.md)
- 실제 중앙 정본 매핑·원자적 drain/승인·운영 정산과 Pi/Feather 및 제작 PCB 검증은 남았다. 전체 goal은 active/progress다.

후보·시험 증거 commit `96faff50f71bdf29adae1bc0259ee6a1b7fc04ae`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `6255e97..96faff5`다.

## 2026-11-10 — r18 BLE 명령 원본 검사

이전 goal turn은 handover 소유권 후보와 팀 mTLS 재현을 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- ArduinoJson에서 최상위와 중첩 중복 키가 파싱 후 정상 필드 수로 보이는 현상을 재현했다. r18 펌웨어 0.7.2는 원본 명령 프레임의 중복 키·이스케이프된 NUL·추가 데이터를 NVS/GPIO 처리 전에 거절한다. 정상 공백·키 순서·ASCII 이스케이프는 허용한다.
- 기본·ST7789·JD9853 빌드, r18 호스트 4개 그룹, 기존 Feather 호스트 4개 그룹이 통과했다. [시험과 바이너리 해시](../keyring/evidence/2026-11-10-command-wire/README.md)
- 실제 BLE 명령·Feather flash·Pi/제작 PCB 수용과 팀 운영 정산은 대기 중이다. 전체 goal은 active/progress다.

구현·시험 증거 commit `e6895b1e50838b250859f048185a4bc5d1fc3eaa`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `9e51f82..e6895b1`이다.

## 2026-11-10 — 장치 journal과 원본 CSE 영수증 대조

이전 goal turn은 r18 펌웨어 0.7.2의 명령 원본 검사를 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- Gateway 0.2.9의 `bubble-keyring-reconcile`은 장치 archive와 격리 Gateway SQLite의 해시와 식별자를 검증하고, 설정된 CSE의 영수증을 읽어 저장 당시 bootId·명령 hash·GPIO readback을 대조한다.
- 합성 장치 기록 10건을 격리 Mobius4에서 대조했다. 로컬 전송 완료 표시가 0이지만 CSE 본문은 일치한 경우를 검토 대상으로 남겼다. 누락·충돌·PREPARED를 따로 분류하고 입력 변조와 다른 자원 결속을 거절했다. 보관본과 CSE 영수증 6건은 그대로였다.
- 설치본 기본 시험 73개와 실제 CSE 통합 1개가 통과했다. 모듈 14개를 소스와 대조했다. [시험 기록](../keyring/evidence/2026-11-10-journal-reconcile/README.md)
- 실제 Pi/키링의 journal 수집과 장치 명령, 팀 중앙 정산·reclaim과 제작 PCB 수용은 남았다. 전체 goal은 active/progress다.

구현·시험 증거 commit `42cba320bb6cc8b616c6b8044d2f8e20d008b45f`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `5e8eba8..42cba32`다.

## 2026-11-10 — 짧은 확인·비상 입력의 관측 보존

이전 goal turn은 장치 journal과 CSE 영수증 대조를 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- r18 0.7.3은 현재 상태 외에 같은 부팅의 확인·비상 누계를 보낸다. 기존 대기열에서 누름 프레임이 해제로 교체되거나 센서 상세가 최소 프레임으로 줄어도 누계를 포함한다. 비상 우선과 uint32 상한을 적용한다.
- Gateway 0.2.10은 누계 필드의 타입·길이·범위를 검증한다. 실제 격리 Mobius4의 native cin에서 합성 BLE 입력의 해제 상태와 누계 `[1,2]`를 SQLite 재열기 뒤 확인했다. 두 스키마는 기존 프레임도 허용한다.
- 세 펌웨어 프로필, 호스트 4개 그룹, 기본 74개와 CSE 11개 시험이 통과했다. [시험과 해시](../keyring/evidence/2026-11-10-button-presses/README.md)
- 실제 r18/Pi 버튼 및 명령, 앱 알림, 중앙 정산과 제작 PCB 수용은 대기 중이다. 전체 goal은 active/progress다.

구현·시험 증거 commit `534379bc39c5f4afd272865e22d315de7fda3c99`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `45b1c5d..534379b`다.

## 2026-11-10 — CORE 관측 재시도 순서

이전 goal turn은 r18 확인·비상 누계를 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- 기존 SQLite는 오래된 CORE 관측이 backoff 중일 때 같은 장치의 최신 값을 먼저 전송 대상으로 선택했다. Gateway 0.2.11은 장치별 선두 행만 선택한다. 다른 장치와 native 관측·영수증의 독립 전송을 유지한다.
- 팀 원본 handler로 격리 Mobius4의 실제 SDT를 갱신했다. 역순 1→0은 옛 ON, 수정된 순서 0→1은 최신 OFF가 남았다. CORE backoff 동안 native cin 2건도 저장됐다.
- 기본 75개, native CSE 11개, SDT 1개, Ubuntu SQLite 회귀시험과 wheel 소스 대조가 통과했다. [시험 기록](../keyring/evidence/2026-11-10-core-retry-order/README.md)
- 중앙 동시 UPDATE 순서와 다중 Gateway handover, 실제 Pi/r18·Feather 명령은 대기 중이다. 전체 goal은 active/progress다.

구현·시험 증거 commit `02ed4d367ad1f6a3a77d08b753890ebb545130ea`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `22f312e..02ed4d3`다.

## 2026-11-10 — CORE 관측 동시 갱신 후보

이전 goal turn은 Gateway의 CORE 재시도 순서를 검증한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- 팀 원본 CORE가 두 UPDATE를 동시에 처리하면 최신 OFF가 저장된 뒤 지연된 옛 ON이 덮었다. 후보를 거치면 동일 자원의 완료 순서가 ON → OFF가 됐고 실제 격리 Mobius4에서 최신 OFF를 읽었다.
- 시험용 소유권을 공급해 이전 Gateway와 epoch, 불일치 payload를 차단했다. CSE 반영 직후 응답 유실을 주입해 파일 저장소를 다시 열었고 후속 갱신이 보류됐다. 재시도 순서를 포함한 통합 시험 2개가 통과했다. [실행 기록](../keyring/evidence/2026-11-10-core-concurrent-order/README.md)
- 운영에는 원래 epoch를 결속하는 인증된 CORE 수신, 중복 판정 범위, 중앙 handover drain과 미확정 갱신 복구가 남아 있다. 실제 Pi·Feather 명령과 r18 PCB 수용은 대기 중이다. 전체 goal은 active/progress다.

구현·시험 증거 commit `b945b15dc38f7df39ba3c7739029b8e8ddef4f65`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `7220fec..b945b15`다.

## 2026-11-10 — CORE 관측의 발행 epoch 결속

이전 goal turn은 중앙 동시 갱신을 재현하고 후보를 검증한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- Gateway 0.2.12의 선택 설정은 중앙이 배정한 장치별 epoch를 CORE 관측과 한 트랜잭션으로 저장한다. 발행은 저장된 epoch의 MQTT 토픽으로 제한한다. 설정에서 제외된 행은 보류되며 현재 관측 순서를 막지 않는다. 보류 행은 outbox 용량에 포함된다.
- 중앙 수신 후보는 토픽의 Gateway·장치·epoch를 정본 SDT 라우팅과 순서 함수에 연결한다. 정확한 토픽에 쓰는 mTLS 주체를 하나로 제한하는 ACL, 익명 발행 차단, 기존 구독 종료 및 handover drain 조건을 문서화했다. [연동 조건](../keyring/integration-candidate/README.md#발행-당시-epoch를-보존하는-mqtt-수신-후보)
- 이번 체크포인트는 소스 단계다. 최신 goal의 검증 범위에 따라 빌드·정적분석·시험·실행을 생략했다. 전용 ACL에서 두 Gateway를 전환하며 실제 broker/CSE readback을 확인하는 작업과 실물 명령 시험이 남아 있다. 전체 goal은 active/progress다.

구현 commit `9782c8aa7ca88718ba21ea5df2e6a6a4861cea02`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `3c24c0b..9782c8a`다.

## 2026-11-10 — Epoch 전용 Mobius4 프로필 준비

이전 goal turn은 epoch를 SQLite에 보존하고 수신 후보를 추가한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- 별도 Compose 프로젝트에 전용 mTLS 브로커와 Gateway 인증서 2개, Mobius4, 팀 저장소를 쓰는 scoped 소비자를 연결했다. Gateway 0.2.13은 native cin에 HTTPS만 쓰면서 CORE MQTT를 사용할 수 있다.
- 빈 AE 1개·cnt 3개·SDT 1개를 실제로 생성했다. 이어서 자원 5개의 RQI·이름·타입·specialization을 조회했다. 소비자는 `SCOPED_SUBSCRIBED` 상태였고 기존 개발 프로필의 컨테이너 4개도 계속 실행됐다. [포트와 로컬 로그 해시](../keyring/evidence/2026-11-10-core-scoped-stack/README.md)
- 실행은 임시 서버 준비 범위다. 관측 발행, Gateway 빌드, ACL 거절, handover SDT readback 및 실물 시험은 미실행이다. 전체 goal은 active/progress다.

구현·준비 증거 commit `8b2081f1d4d4e9299bae8a4292e35e8523b94151`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `786c306..8b2081f`다.

## 2026-11-10 — Scoped CORE 관측의 CSE 적용 영수증

이전 goal turn은 전용 mTLS 브로커·소비자·Mobius4 자원을 준비한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- Gateway 0.2.14의 scoped 작업자는 토픽·장치·epoch·sequence·본문 해시가 일치하는 CSE 적용 영수증을 받아 SQLite 행을 완료한다. 일반 관측과 명령 영수증은 별도 작업자에서 전송한다.
- 중앙 소비자는 oneM2M 응답 2004와 RQI를 확인해 cursor를 저장한 뒤 영수증을 보낸다. 동일한 최신 적용 기록은 재전송에 응답하고 본문이 다른 같은 sequence에는 완료 응답을 내지 않는다. 중앙 쓰기·해당 Gateway 읽기 ACL과 JSON 계약을 추가했다. [연동 조건](../keyring/integration-candidate/README.md#epoch-관측의-적용-영수증)
- 회귀시험 소스를 추가했다. 새 Gateway 빌드, 시험 실행, scoped 브로커·소비자 재배치, handover readback과 실물 연동은 대기 중이다. 전체 goal은 active/progress다.

구현 commit `935847a4a1fd8260530e804bb5018b31a590ee8c`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `4211af6..935847a`다.

## 2026-11-10 — Scoped 영수증 소비자와 ACL 배치

이전 goal turn은 영수증 처리와 회귀시험 소스를 작성한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- `start-scoped.ps1 -RefreshIngress`를 추가하고 적용했다. 기존 소비자 종료 코드 0을 확인한 뒤 격리 브로커와 소비자만 교체했다. 기존 개발 프로필 4개와 격리 CSE·DB·TLS의 컨테이너 ID는 교체 전과 같았다.
- ACL과 소비자 모듈 3개의 컨테이너 파일 해시가 작업본과 일치했다. 기존 빈 cursor의 해시도 유지됐다. 새 소비자는 `SCOPED_SUBSCRIBED receipts=1`을 기록했다. [배치 기록](../keyring/evidence/2026-11-10-core-scoped-receipt-rollout/README.md)
- 이번 실행은 임시 서버 구성 반영까지다. 관측·영수증 발행, ACL 차단, Gateway 빌드, handover readback과 실물 시험은 미실행이다. 전체 goal은 active/progress다.

구현·배치 증거 commit `e615f54752bf1edcd487bc4ccf4a21eb37ea8186`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `98ad8cd..e615f54`다.

## 2026-11-10 — SDT 갱신과 소유권 전환 결속

이전 goal turn은 격리 소비자와 영수증 ACL을 배치한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- SDT 갱신과 소유권 전환을 같은 자원 대기열에 넣는다. 이전 UPDATE가 미확정이면 전환을 보류한다. 현재 소유권과 expected epoch가 맞을 때만 새 소유권을 저장하고, 저장 결과가 불확실한 자원은 후속 갱신도 보류한다.
- 격리 소비자의 소유권은 첫 기동에 설정을 읽고 이후에는 영속 저장소를 사용한다. 운영 명령 소스는 A7 → B8과 B8 → A9 및 상태 조회를 지원한다. 중앙 정본의 원자적 전환 연결은 팀 담당 경계다. [격리 명령](../keyring/dev/mobius4/README.md#격리-소유권-전환)
- 회귀시험 소스를 추가했다. handover 소비자·ACL 배치, 실제 소유권 변경, 빌드·시험·실물 검증은 미실행이다. 전체 goal은 active/progress다.

구현 commit `fa62263120786dddac752efb89808c998ac94d6f`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `3cb9dbf..fa62263`다.

## 2026-11-10 — Scoped handover 초기 소유권 배치

이전 goal turn은 SDT 갱신과 handover 대기열을 연결한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- `start-scoped.ps1 -RefreshIngress`로 handover 소비자와 롤백 ACL을 배치했다. 시작·갱신 스크립트는 현재 소비자의 구독 로그를 확인한 뒤 반환한다.
- `handover-scoped.ps1 -Status`가 영속 소유권 `gw-a:7`과 `EMPTY` cursor를 반환했다. 배치 파일 4개의 해시가 일치했고 교체 대상 밖의 컨테이너 ID 7개도 일치했다. [배치 기록](../keyring/evidence/2026-11-10-core-scoped-handover-rollout/README.md)
- 임시 프로필 배치와 상태 조회만 실행했다. 실제 Forward·Rollback, 관측과 영수증 발행, 빌드·시험·실물 검증은 미실행이다. 전체 goal은 active/progress다.

구현·배치 증거 commit `7af699ab4902f5ef937a1ca3ed7ae635c336ed9d`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `3a0e9ad..7af699a`다.

## 2026-11-10 — 종료된 CORE epoch의 활성 대기열 정리

이전 goal turn은 격리 handover 소비자 배치와 초기 A7 소유권 확인을 마친 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- Gateway 0.2.15의 `bubble-gateway-state retire-core`는 daemon lock을 잡고 이전 epoch의 전송 행을 보관한다. 격리 스냅샷과 준비 계획을 먼저 기록한다. 장치·Gateway·epoch·RQI와 행 해시를 대조한 뒤 선택한 CORE telemetry 행만 활성 outbox에서 정리한다.
- 현재 epoch는 거절한다. native 관측·명령 영수증·fence·CORE sequence는 정리 대상에서 제외한다. 원본 변경 전후 기록의 스키마와 합성 POSIX 회귀시험 소스를 추가했다. [보관 절차](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#종료된-core-epoch-보관)
- 이번 체크포인트는 소스 단계다. 빌드·시험·명령 실행과 기존 DB 변경은 없었다. 전체 goal은 active/progress다.

구현 commit `a95bd8482867ece24150cb6b6b1478565c6f73ba`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `a37a580..a95bd84`다.

## 2026-11-10 — Pi 실물 BLE 거리·재연결 기록 도구

이전 goal turn은 종료된 CORE 행의 스냅샷·수동 정리 명령을 구현한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- Gateway 0.2.16은 BlueZ에서 Feather·r18 보드 revision을 대조하는 운영자용 `bubble-keyring-ble-characterize`를 추가했다. 운영자 실측 거리, 광고 RSSI와 나이, 알림 수, sequence 간격, 링크 종료부터 새 세션의 첫 알림까지의 단조 시각을 private JSON으로 기록한다.
- 최초 READ와 끊긴 세션의 콜백을 알림 수에 포함하지 않는 회귀시험 소스를 추가했다. 주소와 원래 boot ID·센서 payload는 결과에 싣지 않는다. [현장 절차](../keyring/raspberry-pi-gateway/TESTING.md#실물-ble-거리재연결-기록)
- 이번 체크포인트는 소스 단계다. 빌드·시험, BLE 접속, 거리·재연결·전원 실측은 미실행이다. 전체 goal은 active/progress다.

구현 commit `30131330493c5f9d6400b5ff5ee63958f789602a`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `f61a0ce..3013133`다.

## 2026-11-10 — r18 wake 관측 보존과 Pi 기록

이전 goal turn은 Pi 실물 BLE 거리·재연결 기록 소스를 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- r18 0.7.4는 health 프레임을 줄여도 `wake`, `wakePins`, `power`를 남긴다. 기존 512바이트 검사를 거치며 최소 프레임에서 버튼 누계와 wake 필드를 함께 확인하는 호스트 회귀 소스를 추가했다.
- Gateway 0.2.17의 `--mode wake`는 BLE를 비운 뒤 초기와 복구 부팅을 대조한다. 첫 복구 부팅의 health 알림에서 확인·비상·움직임·타이머 원인을 구분한다. 실제 절전 진입과 소비전류는 별도 실물 근거가 필요하다. [Pi wake 절차](../keyring/raspberry-pi-gateway/TESTING.md#r18-wake-기록)
- 이번 변경은 소스 단계다. 빌드·회귀시험, 펌웨어 flash, Pi·r18 wake와 전원 실측은 미실행이다. 전체 goal은 active/progress다.

구현 commit `1f89a884683fb13d03f273108b547e55ef206a74`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `e13212e..1f89a88`다.

## 2026-11-10 — Feather 벤치의 scoped Mobius4 경로

이전 goal turn은 r18 wake 필드와 Pi 기록 모드를 작성한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- Gateway 0.2.18은 배터리나 RSSI가 없을 때 epoch 전용 토픽에서만 nullable 1.1.0을 사용한다. 일반 CORE v1은 숫자 계측값을 계속 요구한다. Feather의 버튼 상태는 native cin에 남고 실제 관측의 `state`를 별도 SDT에 쓴다.
- 격리 CSE에서 `featherState` CREATE 201/2001, 영속 `gw-a:1` 소유권, 새 소비자의 구독을 확인했다. ACL과 모듈 해시를 기록했다. [서버 준비 기록](../keyring/evidence/2026-11-10-core-scoped-feather-rollout/README.md)
- 실행은 임시 서버 준비까지다. Gateway 빌드와 회귀시험, Pi 연결 및 실제 Feather 관측·적용 영수증은 미실행이다. 전체 goal은 active/progress다.

구현·준비 기록 commit `03ffb8206eab409b6e669a696f713d561d90f640`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `efe77c7..03ffb82`다.

## 2026-11-10 — Feather scoped 관측·영수증 기록 준비

이전 goal turn은 Feather 전용 SDT와 scope를 준비한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- Gateway 0.2.19의 relay는 세 버튼 상태가 담긴 일반 관측, 같은 관측의 MQTT 적용 영수증, 최종 SDT readback을 분리해 기록한다. 반복 실행에 쓸 시험 전용 SQLite는 scope를 대조하고 미전송 행이 남으면 실행을 중단한다.
- 격리 프록시의 첫 시작은 Nginx map hash 크기 오류로 실패했다. 전체 경로 일치 패턴으로 고친 뒤 Gateway A 인증서로 `featherState` 초기값을 조회해 TLS 1.3·200/2000·RQI 일치를 확인했다. [읽기 경로 배치 기록](../keyring/evidence/2026-11-10-core-scoped-feather-readback/README.md)
- 실제 실행은 임시 TLS 설정과 읽기 경로 확인까지다. 빌드·회귀시험, Pi relay 실행, Feather 관측과 실제 적용 영수증은 미실행이다. 전체 goal은 active/progress다.

구현·준비 기록 commit `ed404f6a39333829c597a3d54dc59f2fb20e0190`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `01e25eb..ed404f6`다.

## 2026-11-10 — 중단된 Feather scoped 관측 복구

이전 goal turn은 scoped relay 작성과 Gateway A의 초기 SDT 조회를 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- `relay.py --recover-scoped`는 이미 생성된 벤치 DB의 native·scoped 관측만 선택한다. 대기열 원본을 보존한 뒤 기존 RQI·sequence·재시도 일정으로 전송한다. 새 BLE 캡처를 시작하지 않는다.
- native cin의 동일 payload readback과 scoped 적용 영수증을 경로별로 기록한다. 각 기록을 fsync한 뒤 대기열 행의 완료를 허용한다. timeout 결과는 확인 수와 남은 수를 별도로 기록한다. [복구 명령](../keyring/firmware/feather_probe/README.md#중단된-scoped-전송-복구)
- 구현과 회귀시험 소스만 반영했다. 복구 실행·빌드·시험·기존 DB 변경은 미실행이다. 전체 goal은 active/progress다.

구현 commit `36ecd72491f9a70e51f2a6388d78d51820b7d76b`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `913393d..36ecd72`다.

## 2026-11-10 — CSE 명령 영수증의 중앙 정산 후보

DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 중앙의 `gatewayCommands` 발급 레코드 및 `GATEWAY_COMMAND_AUTHORIZED` 승인 이력을 KEYRING 정산 입력으로 연결할 수 있도록 후보를 추가했다.

- 설정에 등록된 Gateway별 CSE receipt 컨테이너에서 원본 cin을 읽는다. Gateway 요청 ID로 자원명을 대조하고, 중앙 발급 해시·과거 승인·GPIO readback·선택 ACK가 일치하는 영수증을 정산한다. CSE 생성 시각의 초 단위 정밀도로 선후를 확정할 수 없는 경우에는 검토로 남긴다.
- `(gatewayId, commandId)` 고유 키와 영수증 해시로 재전송과 내용 충돌을 구분한다. 격리 POSIX 파일 저장 후보와 재전송·충돌·저장 장애·동시 쓰기 회귀시험 소스를 추가했다. [중앙 정산 후보](../keyring/integration-candidate/README.md#cse-명령-영수증의-중앙-정산-후보)
- 빌드·회귀시험·Pi/Feather 실행은 미실행이다. 운영 CORE의 인증된 CSE 조회, 중앙 저장소, ACK 수신기 연결과 실제 장치 정산 증거가 남아 있다. 전체 goal은 active/progress다.

구현 commit `4caa505c069dcd0b64b5cac9a30503544e043e5a`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `055bdc3..4caa505`다.

## 2026-11-10 — 격리 Mobius4 명령 영수증 정산 경로

직전 goal turn은 정산 후보와 진행 기록을 원격에 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 다시 확인했다.

- scoped bootstrap과 TLS 프록시 설정에 Gateway A/B의 전용 명령 영수증 컨테이너를 추가했다. 각 Gateway 인증서에 자신의 컨테이너의 생성·이름 조회만 허용하는 경로를 구성했다. 기존 관측·상태·공용 영수증의 기존 정규 경로는 보존한다.
- `receipt-settlement/settle.mjs`는 명령 ID에서 native 자원명을 계산하고 CORE 인증서로 CSE를 조회한다. TLS 1.3·서버 인증서·응답 RQI를 확인하고 KEYRING JSON Schema와 팀 원본의 `approvalHash`로 검증한다. 팀 API의 실제 발급·승인 기록은 같은 스냅샷에서 읽으며 별도 POSIX 정산 디렉터리에 결과를 기록한다. [설정과 실행](../keyring/dev/mobius4/README.md#명령-영수증-정산-준비)
- 소스와 배치 절차를 반영했다. npm 설치·빌드·시험·기존 scoped TLS 교체·CSE 자원 생성·Pi/Feather 실행은 미실행이다. 운영 CORE 자동 수신과 중앙 DB 연결, 실제 장치 readback 및 재전송 영수증은 남아 있다. 전체 goal은 active/progress다.

구현 commit `e5ffd4b5a8e899491b65097bcebe72932ea61156`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `3892946..e5ffd4b`다.

## 2026-11-10 — 격리 Mobius4의 명령 영수증 컨테이너 실제 준비

직전 goal turn은 경로와 수동 정산 명령 소스를 원격에 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- `prepare-scoped-command-receipts.ps1`은 기존 격리 프로젝트의 TLS 프록시를 교체하고 `bootstrap.mjs --scoped-command-receipts`로 전용 컨테이너 두 개만 준비한다. 기존 이름을 조회해 재사용하며 전용 준비 로그를 분리한다.
- 실제 실행에서 격리 Mobius4의 `command-receipts-a`와 `command-receipts-b`가 HTTP 201·RSC 2001로 생성됐고 각각 응답 RQI가 일치했다. 실행 중인 TLS 프록시의 Gateway별 경로 설정을 읽었고 CSE와 PostgreSQL이 같은 인스턴스로 유지된 것을 확인했다. [배치 증거](../keyring/evidence/2026-11-10-scoped-command-receipts/provisioning.json)
- Gateway 인증서별 교차 접근 시험, 실제 팀 발급·승인 연동과 영수증 정산 명령, Pi/Feather 실행·빌드·회귀시험은 미실행이다. 운영 CORE의 자동 수신과 중앙 DB 연결도 남아 있다. 전체 goal은 active/progress다.

준비 절차와 증거 commit `b8c9177c60741976f1127ef5d12dedfe1807fa29`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `cf6b152..b8c9177`다.

## 2026-11-10 — Feather용 격리 팀 명령 API 준비

직전 goal turn은 scoped TLS와 두 빈 CSE 영수증 컨테이너를 실제 배치한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- 팀 원본을 고정 SHA의 Git 객체에서 추출하고 KEYRING 런처에서 팀 mTLS 서버·정책·GatewayControl을 사용한다. 벤치 운영자는 별도 scoped 인증서로, Gateway A는 기존 인증서로 등록한다. 루프백 한 포트와 Feather 한 대로 범위를 지정하고 재시작 시 기존 자격 상태를 보존한다.
- 임시 API가 PC의 `127.0.0.1:8787`에서 `READY`를 보고했고 해당 프로세스가 포트를 열고 있음을 확인했다. 전용 상태 파일에 `gw-a`·`keyring-feather-lab`·epoch 1이 등록됐다. 동의·grant·발급 명령·감사 기록은 모두 0건이다. [배치 증거](../keyring/evidence/2026-11-10-scoped-command-api/provisioning.json)
- 실행 범위는 임시 API 준비와 등록까지다. API 요청·실제 발급·정산·Pi 터널/BLE·장비 명령·빌드·회귀시험은 미실행이다. 운영 CORE 자동 수신과 중앙 DB 연결은 남아 있다. 전체 goal은 active/progress다.

명령 API 준비 commit `7383facdfaf670996931a55d1c15fa62ab9eaf82`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1233b97..7383fac`다.

## 2026-11-10 — Feather ON/OFF와 scoped 영수증 증거 절차 연결

직전 goal turn은 팀 원본 명령 API와 벤치 장치 등록을 실제 준비한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 기존 LED 흐름을 팀 API와 scoped CSE의 별도 mTLS 연결에 연결했다. 단계별 명시적 파일 신호, 같은 부팅 세션의 전후 관측, 명령 ID에서 계산한 원본 영수증을 대조한다. 요청 전 intent 파일을 동기화하고 ON/OFF 각각 60초 grant를 사용해 단계 종료 시 회수한다. 기존 독립 fixture와 Pi SQLite 대조 도구도 같은 절차를 사용한다. [실행 절차](../keyring/raspberry-pi-gateway/TESTING.md#기존-scoped-mobius4에서-feather-led-시험)
- 임시 CSE의 `command-observations-a`와 Gateway A 경로 설정을 실제 준비했다. 빈 컨테이너 생성 응답은 HTTP 201·RSC 2001이고 RQI가 일치했다. Mobius4와 PostgreSQL은 같은 인스턴스를 유지했다. [배치 증거](../keyring/evidence/2026-11-10-scoped-feather-led-cycle/provisioning.json)
- ON/OFF 도구·회귀시험·실제 API 발급·BLE·장비 시험·중앙 정산은 미실행이다. 전용 Pi 데몬의 관측, 실제 LED 확인과 영수증 대조가 남아 있다. 전체 goal은 active/progress다.

LED 절차와 준비 증거 commit `47697ec03421b9b0b708797ed254752c3a8d0300`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `29a1150..47697ec`다.

## 2026-11-10 — Pi의 Feather 명령 세션 분리

직전 goal turn은 scoped LED 흐름을 연결하고 전용 CSE 관측 컨테이너를 실제 준비한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`가 유지됐다.

- `scoped_feather_pi.py`에 `prepare`와 `run`을 추가했다. Pi에서 기존 BLE 등록을 지정하고 Gateway A의 로컬 mTLS 파일을 읽어 소유자 전용 세션 프로필을 만든다. `run`은 고정된 Feather 명령 프로필과 두 loopback HTTPS 연결, 별도 SQLite와 명령 세션 잠금을 사용한다. 같은 세션 재개는 기존 SQLite를 유지한다.
- SSH 역방향 포워딩과 Pi 명령 세션의 사용 절차를 연결했다. 임시 프록시가 mTLS 주체의 CSE originator를 매핑하므로 CSE 관리자 값은 PC에 둔다. [Pi 명령 세션](../keyring/raspberry-pi-gateway/TESTING.md#pi-명령-세션)
- PC에서 격리 CSE와 팀 API loopback 리스너가 열려 있음을 관찰했다. Pi 접속·설정 실행·인증서 복사·빌드·시험·장치 명령·정산은 미실행이다. 전체 goal은 active/progress다.

Pi 세션 소스 commit `6f20aaf67838a245892f6987fb1dea560ebdd841`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1499805..6f20aaf`다.

## 2026-11-10 — 팀 PostgreSQL용 명령 영수증 정산 저장

직전 goal turn은 Feather 전용 Pi 실행 경로를 원격에 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 팀 PostgreSQL의 감사 journal과 별개로 `(gateway_id, command_id)`를 기본 키로 갖는 KEYRING 정산 테이블 후보를 추가했다. 정산 함수와 호환되는 `pg.Pool` 어댑터는 한 트랜잭션에서 삽입을 시도하고, 충돌하면 다음 조회에서 먼저 저장된 행을 반환한다. 커밋 확인 뒤에만 성공을 반환한다. [PostgreSQL 정산 저장 후보](../keyring/integration-candidate/README.md#postgresql-정산-저장-후보)
- 저장 충돌, 키 불일치, 커밋 응답 유실과 연결 폐기 처리를 위한 회귀시험 소스를 추가했다. DB 적용·회귀시험·CORE 수신기 연결·Pi/Feather 실행은 미실행이다. 중앙 DB 실사용과 물리 명령 영수증은 남아 있다. 전체 goal은 active/progress다.

PostgreSQL 정산 소스 commit `a551e9ee797dfa18b26c85a79c23d5ceccd55df5`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `f1a58a5..a551e9e`다.

## 2026-11-10 — Mobius4 알림의 영속 수신과 원본 정산 재시도

직전 goal turn은 PostgreSQL 정산 저장 어댑터 후보를 반영한 progress다. DOC-REV 2.0.0, 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`와 임시 Mobius4 소스 `e8f75b1`을 확인했다.

- 인증된 CSE의 등록 구독만 받는 수신 함수를 추가했다. `nct=3`의 URI를 정확한 컨테이너에 결속하고 `(cse_key, native_ref)`로 PostgreSQL 대기열에 저장한 뒤 응답한다. 구독 확인 요청은 큐를 만들지 않는다. [알림 정산 후보](../keyring/integration-candidate/README.md#mobius4-알림에서-원본-정산까지)
- 작업자는 기간이 있는 lease로 한 행을 맡고 인증된 CSE 원본과 기존 정산 함수를 사용한다. 미도착·일시 오류는 재시도하고, 한도를 넘기거나 불일치하면 검토 상태로 남긴다. 중복 알림과 작업자 재시작은 원본 정산 고유 키를 유지한다.
- DB 마이그레이션·실제 CSE 구독·CORE 배치·시험·실물 명령은 미실행이다. 대기열에 들어오기 전에 실패한 알림은 중앙 발급 기록과 CSE 원본을 대조할 후속 복구가 필요하다. 전체 goal은 active/progress다.

알림 정산 소스 commit `b498e396e6aedcc2a4635eee38961f218d1755e7`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `00270d0..b498e39`다.

## 2026-11-10 — 대기열 도달 전 유실된 영수증 알림 복구

직전 goal turn은 인증된 CSE 알림 수신과 영속 대기열 후보를 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 커밋된 팀 상태의 `gatewayCommands`와 실행 승인 이력을 같은 승인 검증 함수로 결속한다. 허용 시각 구간과 커서로 나누어 확인한다. CSE 교체 시에는 중앙이 명령에 배정한 원래 자원 경로를 공급한다. [알림 유실 복구 후보](../keyring/integration-candidate/README.md#대기열-도달-전-유실-복구)
- 대기열에 행이 없으면 인증된 CSE에서 계산된 native URI를 읽는다. Gateway·명령이 맞는 원본이 있을 때만 기존 고유 키로 넣는다. 기존 검토 기록을 보존하고 미도착·조회 실패·불일치를 보고한다. 콜백과 스윕이 동시에 넣어도 중복 삽입을 막는다.
- 복구 및 회귀시험 소스를 추가했다. 주기 실행·DB 적용·실제 CSE 알림 유실 복구·회귀시험·실물 장치 명령은 미실행이다. 전체 goal은 active/progress다.

알림 유실 복구 commit `c078b3193cde2ea25712884854ab0861ea5b3310`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `8b9c589..c078b31`다.

## 2026-11-10 — 격리 정산 프로세스와 PostgreSQL 실제 준비

직전 goal turn은 유실 복구 스윕을 원격에 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 개발용 `run.mjs`에 팀 상태 스냅샷, scoped mTLS CSE 조회, 복구 스윕과 PostgreSQL 대기열·정산 작업자를 연결했다. 수동 정산은 같은 조회·상태 로더를 사용하며 기존 POSIX ledger를 유지한다. [격리 정산 실행](../keyring/dev/mobius4/README.md#격리-postgresql-정산-실행)
- PostgreSQL 17.5 전용 프로젝트를 `127.0.0.1:5544`에 준비했다. 최초 Windows SQL 바인드 읽기가 실패해 새 볼륨을 보존한 채 SQL을 `psql`의 한 트랜잭션으로 적용했다. 팀 CORE 스키마와 KEYRING 테이블 두 개를 만들었고 정산·대기열은 각각 0행이다. 기존 scoped·base Mobius4 DB는 같은 인스턴스로 유지됐다. [DB 준비 증거](../keyring/evidence/2026-11-10-receipt-database/provisioning.json)
- DB 준비와 SQL 적용을 실행했다. Node 의존성 설치·정산 프로세스 실행·실제 CSE 알림·Pi/Feather 명령·회귀시험은 미실행이다. 전체 goal은 active/progress다.

격리 정산 연결과 DB 준비 증거 commit `2224c26a2b68edc7e6a509a50b8475bfe97e8c63`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1f07be0..2224c26`다.

## 2026-11-10 — 격리 Node 정산 프로세스 실제 기동

직전 goal turn은 격리 PostgreSQL 준비와 프로세스 연결 소스를 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 호스트에 npm 명령이 없어 pnpm을 사용했다. 오프라인 캐시에 AJV가 없어 지정된 세 가지 의존성을 레지스트리에서 설치했고 설치 스크립트는 비활성화했다. 정산 PostgreSQL 연결에 전용 `application_name`을 부여했다.
- 실제 정산 프로세스가 `SCOPED_RECEIPT_PROCESS_READY`를 출력하고 실행을 유지했다. PostgreSQL에서 해당 프로세스의 대기열 조회를 확인했다. 팀 발급 명령은 0건이고 정산·대기열은 각각 0행이다. [기동 증거](../keyring/evidence/2026-11-10-scoped-receipt-runtime/startup.json)
- 이번 실행은 임시 서버의 기동과 빈 대기열 조회까지다. CSE 명령 영수증 조회·정산·콜백·회귀시험·Pi/Feather 장치 명령은 미실행이다. 전체 goal은 active/progress다.

정산 프로세스 기동 증거 commit `6799b9d934aa3b62d4ce0ea7cd3af84793024a12`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `0f6e0c0..6799b9d`다.

## 2026-11-10 — 격리 영수증 mTLS 콜백 수신기 준비

직전 goal turn은 격리 Node 정산 프로세스를 기동하고 빈 PostgreSQL 대기열 조회를 관찰한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- TLS 1.3 클라이언트 인증서의 등록 지문으로 CSE 키를 결정하는 HTTPS 콜백 어댑터를 추가했다. 정확한 POST 경로와 최대 8 KiB JSON을 검증해 기존 영속 대기열로 넘긴다. 기존 팀 서버 코드는 유지했다.
- scoped CA로 전용 중계 인증서를 발급하고 콜백 수신기를 `127.0.0.1:8790`에 기동했다. `SCOPED_RECEIPT_CALLBACK_READY`와 OS 리스너를 관찰했고 대기열과 정산은 각각 0행이다. [시작 증거](../keyring/evidence/2026-11-10-scoped-receipt-callback/startup.json)
- 이번 실행은 임시 콜백 준비까지다. 실제 Mobius4 발신과 mTLS 중계 연결·구독 등록·콜백 요청·회귀시험·Pi/Feather 명령은 미실행이다. 전체 goal은 active/progress다.

콜백 수신기 소스와 기동 증거 commit `f64bb1f3354793794aa15612d7857f0a50db23b7`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `e45a36a..f64bb1f`다.

## 2026-11-10 — Mobius4 영수증 중계와 구독 실제 등록

직전 goal turn은 격리 mTLS 콜백 리스너를 실제 준비한 progress다. DOC-REV 2.0.0, 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- scoped Mobius4의 네트워크 공간 내부 루프백에서만 요청을 받는 전용 중계를 추가했다. 호스트 포트를 게시하지 않고 기존 CSE 인스턴스를 유지했다. 중계의 HEAD 준비 요청은 PC 콜백에서 mTLS를 거쳐 HTTP 405·RSC 4005를 받았다.
- `gw-a`와 `gw-b`의 전용 영수증 컨테이너에 직접 자식 cin 생성 구독 `keyring-settlement`를 등록했다. 두 요청은 HTTP 201·RSC 2001이고 RQI가 일치했다. 현재 Mobius4의 직접 URL 구독은 등록 때 알림 발신을 검증하지 않는다. [준비 증거](../keyring/evidence/2026-11-10-scoped-receipt-relay/provisioning.json)
- 이번에는 임시 중계 연결과 구독 등록까지 실행했다. 수신 대기열과 정산은 각각 0행이며 실제 영수증 알림·정산·회귀시험·Pi/Feather 명령은 미실행이다. 전체 goal은 active/progress다.

중계와 구독 준비 commit `3d78e2d53beb16a462d6703b51556875356a2216`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `55df99a..3d78e2d`다.

## 2026-11-10 — 영수증 전달 경로와 정산 증거 조회

직전 goal turn은 격리 중계와 두 CSE 구독을 실제 등록한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 대기열 삽입 트랜잭션에 `CSE_CALLBACK`·`RECOVERY_SWEEP`의 최초 수신 시각과 최초 생성 여부를 추가했다. 기존 대기열 상태나 정산 결과를 덮어쓰지 않는다. `inspect.mjs`는 명령 ID로 대기열·전달 경로·정산을 읽는다. [조회 절차](../keyring/dev/mobius4/README.md#명령별-영수증-증거-조회)
- 전용 PostgreSQL에 003 마이그레이션을 적용하고, 발급 명령과 대기열이 비어 있을 때 scoped 콜백과 작업자 두 프로세스만 재기동했다. 각 준비 로그와 콜백 리스너를 확인했다. Mobius4와 중계는 같은 인스턴스이며 대기열·전달·정산은 각각 0행이다. [배치 증거](../keyring/evidence/2026-11-10-scoped-receipt-provenance/provisioning.json)
- 이번 실행 범위는 격리 배치다. 명령별 조회 도구 실행·실제 영수증 수신·정산·회귀시험·Pi/Feather 명령은 미실행이다. 전체 goal은 active/progress다.

전달 경로 기록과 배치 commit `7e72b25acc19b84b23c454f4f13245ea4e9350a5`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `d8116cc..7e72b25`다.

## 2026-11-10 — Feather 실물 명령 증거 대조 도구

직전 goal turn은 전달 경로 테이블과 격리 프로세스 배치를 완료한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- ON/OFF 실행 도구는 CSE 원본 receipt의 `ri`와 `ct`를 보존한다. 읽기 전용 검증 도구는 Pi SQLite의 명령·영수증 해시, CSE 원본 ID·시각, 팀 발급·승인, PostgreSQL 정산과 전달 경로를 명령별로 대조한다. 콜백 수신, 중앙 정산과 운영자가 보고한 LED 상태를 별도로 기록한다. [증거 대조 절차](../keyring/raspberry-pi-gateway/TESTING.md#실물-명령-증거-대조)
- 검증·회귀시험 소스만 추가했다. Feather 명령 프로필 0.2.0 flash, Pi 시험 세션·LED 명령·실제 영수증 확인은 별도 실행 승인과 실제 장치가 필요하다. 전체 goal은 active/progress다.

증거 대조 소스 commit `503f9c9ed2095c29c4d23f47657756500a4be276`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `0d8ebe7..503f9c9`다.

## 2026-11-10 — 명령 거절·시간 초과·불확정 영수증 분류

직전 goal turn은 실물 명령 증거 대조 도구를 반영한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 발급 기록과 결속된 `REJECTED`, `TIMEOUT`, `INDETERMINATE` 원본은 실제 ACK 코드와 함께 검토 사유로 보존한다. 긍정 승인 이력이 필요한 성공 정산과 분리하며, 모순되는 성공 ACK는 거절한다. CSE `ct` 초 안에서 승인과 보관의 선후를 확정할 수 없는 건 `AUTHORIZATION_ORDER_UNCERTAIN`으로 남긴다.
- 복구 스윕은 승인 이력이 없는 발급 명령도 마감 시각이 범위에 들어오면 확인한다. 인증 CSE에서 원래 영수증이 존재해야 대기열에 넣으며 원본 부재를 실패 영수증으로 만들지 않는다. [정산과 복구](../keyring/integration-candidate/README.md#cse-명령-영수증의-중앙-정산-후보)
- 구현·회귀시험 소스만 반영했다. 실행 중인 격리 작업자 재기동·실제 실패 영수증·빌드·시험·실물 장치 작업은 미실행이다. 이전 Feather/Pi 실물 승인 요청은 대기 중이다. 전체 goal은 active/progress다.

부정 영수증 분류와 복구 commit `f2cc3f90f59c1bb0a28c307b81ea542eefaa7323`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `a6cc9eb..f2cc3f9`다.

## 2026-11-10 — 장치 저널과 격리 중앙 정산 기록 대조

DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치에 새 변경은 없다.

- 장치·Gateway·CSE 대조 보고서에 장치 기록 파일 SHA256과 CSE 원본 영수증의 ID·생성 시각을 추가했다. 격리 PostgreSQL 조회 도구는 이 보고서로 최대 32개 명령을 한 쿼리에서 비교한다. 정산 일치·누락·불일치와 기존 검토 건을 구분한다. Gateway 전송 미확인은 검토 건수에 남긴다. [운영 절차](../keyring/JOURNAL_RETENTION.md#격리-postgresql-정산-기록-대조)
- 구현·회귀시험 소스만 반영했다. 새 PostgreSQL 조회, 빌드, 시험, 실물 명령은 미실행이다. 장치 저널 회수에는 중앙 계약이 필요하다. 이전 Feather/Pi 실물 승인 요청은 대기 중이며 goal은 active/progress다.

대조 도구 commit `a2c9976e612bca2c033a13bd7b1cf903d4e5d9ae`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `325ba5b..a2c9976`이다.

## 2026-11-10 — 명령 재정산에서 CSE 원본 출처 고정

직전 goal turn은 장치 저널과 격리 중앙 정산 기록의 대조 도구를 올린 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 새 정산 행은 인증 조회의 CSE 키와 경로를 영수증 해시·원본 ID·생성 시각과 함께 저장한다. 재정산에서 원본이 재생성되거나 다른 CSE로 조회되면 검토로 분류한다. 기존 행에 출처 필드가 없으면 그대로 보존하고 출처 미확인으로 남긴다. 저널과 Feather 실물 증거 도구도 정산 행의 출처를 대조한다. [정산 후보](../keyring/integration-candidate/README.md#cse-명령-영수증의-중앙-정산-후보)
- 소스와 회귀시험 사례를 반영했다. 격리 작업자 재기동, DB 조회, 빌드, 시험, 실물 명령은 미실행이다. 명령별 원본 CSE 배정과 저널 회수는 팀 계약에 의존한다. Feather/Pi 실물 시험 승인 요청은 대기 중이며 goal은 active/progress다.

출처 고정 commit `36bc81624abfe9887592b3315217738de097e96e`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `08d2eb2..36bc816`이다.

## 2026-11-10 — Pi 재시작 뒤 새 명령 영수증의 큐 등록

직전 goal turn은 명령 재정산의 CSE 출처를 고정한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치에 새 변경은 없다.

- 재시도 중인 native 영수증을 새 등록용 128개 한도에서 제외한다. 이전 행의 대기 시각과 전송한 CORE ACK의 중복 방지는 유지한다. 이전 영수증 128개가 남은 DB를 다시 열고 다음 영수증이 발송 가능한지 확인하는 회귀시험 소스를 추가했다. [Gateway 큐](../keyring/raspberry-pi-gateway/README.md)
- 기존 wheel 버전 `0.2.19`와 실행 모듈 버전 `0.2.6`의 불일치를 정리했다. wheel 설정이 모듈 버전을 읽도록 바꿨고 이번 소스의 버전은 `0.2.20`이다.
- wheel 빌드, 시험, 기존 DB 접근과 Pi 배포는 미실행이다. 이전 Feather/Pi 실물 시험 승인 요청은 대기 중이며 goal은 active/progress다.

큐 수정 commit `d584caad89ef9dc04f12462b9240dad986baff5d`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `448cd2a..d584caa`다.

## 2026-11-10 — r18 NVS 시작 오류에서 명령 저널 보존

직전 goal turn은 Pi 영수증 큐와 Gateway 버전의 수정 사항을 올린 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 설치된 Arduino 코어의 `esp32-hal-misc.c`는 `NO_FREE_PAGES`와 `NEW_VERSION_FOUND`에서 기본 NVS 파티션을 자동 삭제한다. r18 펌웨어 `keyring-0.7.5`는 이 자동 삭제 분기를 막고 두 상태에서 BLE 시작 전에 잠근다. 기존 파티션·namespace·record format 1을 사용한다.
- 슬롯 읽기는 NVS API 상태를 그대로 받는다. 명시적 미존재만 빈 슬롯으로 취급한다. 읽기 오류·중복 명령·기록 모순은 저장 오류로 분류해 정상 영수증 재발행과 새 명령 실행을 차단한다. [펌웨어 복구 경계](../keyring/firmware/README.md)
- 호스트 오류 주입 시험 소스를 추가했다. 빌드·링크 확인·호스트 시험·flash·전원 차단은 미실행이다. Feather/Pi 실물 명령 승인 요청은 대기 중이며 goal은 active/progress다.

저널 보호 commit `da4e29131f92ad03e2ffee9fc75eba5998bace13`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `37d6cac..da4e291`이다.

## 2026-11-10 — Pi BLE 명령의 승인 기한과 자격 상태 검사

직전 goal turn은 r18 NVS 시작 오류에서 저널을 보존하는 펌웨어 변경을 올린 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- Gateway `0.2.21`은 중앙 승인과 명령 기한 중 이른 값을 단조 시계로 고정한다. SQLite 기록, BLE 작업 시작·잠금 대기, 조각 전송에 같은 기한을 적용한다. 각 조각 직전에 현재 인증 세션, 자격 상태·revision과 시계·기한을 확인한다.
- 실행 의도 기록 전 자격이 바뀌면 다음 승인을 기다린다. 기록 후 BLE 전송 전에는 거절을 남기며, BLE 처리 중 중단은 미확정 또는 시간 초과로 보존한다. 조각 중단 시 해당 세션을 무효화한다. [BLE 경계](../keyring/raspberry-pi-gateway/BLE_SESSIONS.md#승인-기한과-gatt-전송)
- 회귀시험 소스만 반영했다. 빌드, 시험, Pi 배포와 실물 BLE 명령은 미실행이다. Feather/Pi 실물 시험 승인 요청은 대기 중이며 goal은 active/progress다.

승인 기한 고정 commit `edd4b6c22ce15dd2988a02d792f7a7ef052d3179`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1e4cb66..edd4b6c`다.

## 2026-11-10 — Pi·Feather 명령 시험용 격리 정산 작업자 갱신

직전 goal turn은 BLE 조각 전송의 승인 기한과 자격 검사를 올린 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 발급 명령과 영수증이 없는 격리 팀 상태와 전용 PostgreSQL의 대기열·전달·정산 각 0행을 확인한 뒤 정산 작업자만 교체했다. 새 프로세스는 checkout `806416b`의 경로로 실행했고 `SCOPED_RECEIPT_PROCESS_READY`, stderr 0바이트, 전용 DB 작업자 연결 1개를 관찰했다. 전후 네 개 격리 리스너의 프로세스 소유자가 일치했다. [기동 증거](../keyring/evidence/2026-11-10-scoped-receipt-worker-refresh/startup.json)
- 이번 실행은 격리 작업자 배치와 읽기 전용 DB 확인까지다. 이후 대기열·전달·정산은 여전히 각 0행이다. 명령 발급·CSE 실물 영수증·빌드·회귀시험·Pi 및 Feather 장치 작업은 미실행이다. 실물 시험 승인 요청은 대기 중이며 goal은 active/progress다.

기동 증거 commit `558dafb4159ea289ec1589a275adf3f42f6389ca`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `806416b..558dafb`다.

## 2026-11-10 — Mobius4 배포별 Gateway DB 분리

직전 goal turn은 Pi·Feather 시험용 격리 작업자를 갱신한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 새 Gateway DB는 설정의 `M2M_CSE_DEPLOYMENT_ID`를 저장한다. 같은 배포에서 주소만 바뀌면 계속 사용할 수 있고, 다른 ID 또는 ID 누락으로 열면 기존 큐의 쓰기와 전송 전에 중단한다. 배포 ID 없는 원본은 기존 설정으로 계속 사용할 수 있다. [전환 절차](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#cse-배포-전환)
- 새 Feather 시험 프로필은 격리 ID를 설정한다. Gateway 보관 계약과 중앙 저널 대조에도 배포 구분을 반영했다. 배포 ID는 운영자 배정값이며, 실제 서버 확인에는 mTLS와 중앙 자원 확인이 필요하다.
- 회귀시험 소스만 반영했다. 빌드·시험·기존 DB 변경·서버 전환·Pi 배포는 미실행이다. Feather/Pi 실물 시험 승인 요청은 대기 중이며 goal은 active/progress다.

배포 구분 commit `3f954cef262aec7741913dad69af1fe645159dd0`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `10dfa3e..3f954ce`다.

## 2026-11-10 — 명령 영수증의 CSE 컨테이너 자원 ID 고정

직전 goal turn은 Gateway DB를 CSE 배포 ID별로 분리한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- Gateway `0.2.23`의 선택 설정은 새 SQLite에 원본 컨테이너 `ri`를 기록한다. 이름 경로를 mTLS로 조회해 자원 ID를 대조한 뒤 MQTT와 HTTPS는 같은 `ri`에 직접 기록한다. 성공 응답이나 기존 영수증의 부모 `pi`가 다르면 발송 완료로 표시하지 않는다. [전환 절차](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#명령-영수증-컨테이너-id-고정)
- 모의·격리 CSE 회귀시험 소스를 추가했다. 빌드, 시험, CSE ACL 변경, Pi 배포와 실제 명령은 미실행이다. 현재 격리 프록시에서 이 옵션을 켜려면 컨테이너 GET과 자원 ID CREATE 권한을 준비해야 한다. Feather/Pi 실물 시험 승인 요청은 대기 중이며 goal은 active/progress다.

자원 ID 고정 commit `19c95a0b37c57b1dd440bbedbb704a9ed95f174f`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `def9f1e..19c95a0`다.

## 2026-11-11 — 격리 영수증 ID 경로 권한 준비

직전 goal turn은 영수증을 CSE 컨테이너 자원 ID에 고정한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 관리자 인증으로 기존 두 컨테이너를 조회하고 Gateway별 이름 경로 GET과 정확한 자원 ID POST 규칙을 생성했다. 같은 설정으로 재실행할 수 있으며 기존에 저장한 ID가 달라지면 프록시 갱신 전에 중단한다. 새 Pi 명령 세션에 `--receipt-container-ri` 옵션을 추가했다.
- 발급 명령이 0건인 격리 환경에서 TLS 프록시만 갱신했다. 각 Gateway 인증서의 자기 컨테이너 GET은 HTTP 200·oneM2M 2000 및 RQI 일치, 상대 컨테이너 GET은 HTTP 403을 관찰했다. CSE·DB·broker·소비자·중계 컨테이너 ID는 동일했다. [배치 증거](../keyring/evidence/2026-11-11-scoped-receipt-pin/provisioning.json)
- 이번 실행은 격리 설정과 조회 권한 확인까지다. 영수증 POST·정산·빌드·회귀시험·Pi/Feather 실물 명령은 미실행이다. 실물 시험 승인 요청은 대기 중이며 goal은 active/progress다.

격리 권한 배치 commit `3cb1175e24eb7dc24b102dc47e1962fd625d40dc`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `d6ba576..3cb1175`다.

## 2026-11-11 — r18 BLE 명령·영수증의 피어 세션 결속

직전 goal turn은 격리 프록시의 ID 경로 권한을 배치한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 설치된 Arduino BLE 소스에서 기존 콜백이 연결 ID를 생략하고 기본 `notify()`가 피어 전체를 순회하는 것을 확인했다. 펌웨어 `keyring-0.7.6`은 현재 인증된 피어의 쓰기·구독만 처리하고 해당 연결 ID로만 알림을 전송한다. 다른 피어의 종료 이벤트는 활성 연결을 끊지 않는다.
- 연결 교체·재구독 후 이전 부분 프레임을 섞지 않는다. 알림 API 오류 시 같은 조각을 재시도한다. 활성 피어 종료 시 모터를 끄고 영수증 캐시·대기열을 정리한 뒤 새 관측과 광고를 준비한다. [펌웨어 설명](../keyring/firmware/README.md)
- 기존 호스트 회귀시험 코드를 확장했다. 빌드·시험·flash·실물 BLE 세션은 미실행이다. Feather/Pi 실물 시험 승인 요청은 대기 중이며 goal은 active/progress다.

BLE 세션 commit `8c340992d3cde9208338fc24acc3db2a866c2f75`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `3681088..8c34099`다.

## 2026-11-11 — r18 GATT 읽기와 긴 읽기 사본의 세션 분리

직전 goal turn은 r18 명령·저널 쓰기와 알림을 인증 세션에 결속한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- 설치된 Arduino BLE의 긴 읽기는 공유 characteristic offset을 쓰며 후속 요청에서 read callback을 건너뛴다. `keyring-0.7.7`은 GATT 이벤트 등록을 감싸 identity·관측·영수증·저널의 각 READ를 기본 처리기 전에 인증 연결 ID와 대조한다.
- 첫 요청에서 최대 512바이트의 사본을 잡고 같은 세션의 후속 offset에 제공한다. 다른 피어, 범위를 벗어난 offset, 재연결 후 예전 offset을 거절한다. 게시 중 값이 바뀌어도 진행 중인 읽기의 바이트는 유지한다. [펌웨어 설명](../keyring/firmware/README.md)
- 호스트 회귀시험 소스만 확장했다. 빌드·링크·시험·flash·실물 BlueZ 읽기는 미실행이다. Feather/Pi 실물 시험 승인 요청은 대기 중이며 goal은 active/progress다.

GATT 읽기 commit `82d76bb80aeb903ea3cad1681e8abe838a99ee47`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `2aba11d..82d76bb`다.

## 2026-11-11 — Pi 명령 시험의 mTLS 경로 사전 점검

직전 goal turn은 r18 GATT의 읽기와 긴 읽기 사본을 세션에 묶은 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- Gateway `0.2.24`와 격리 Pi 명령 세션에 명시적 `preflight`를 추가했다. Pi 인증서로 영수증 컨테이너 ID, 팀 API의 현재 자격, 활성 명령 목록을 HTTPS GET으로 확인한다. 성공 JSON은 확인한 컨테이너 ID·자격 상태·활성 명령 수·시각을 포함한다. [Pi 사용 절차](../keyring/raspberry-pi-gateway/TESTING.md#pi-명령-세션)
- 모의 시험 소스를 추가했다. 이번 변경의 실행·빌드·시험과 Pi 배포는 미실행이다. Gateway/장치 준비는 이후 실제 BLE 관측으로 별도 확인해야 한다. Feather/Pi 실물 시험 승인 요청은 대기 중이며 goal은 active/progress다.

사전 점검 commit `1cb9e6988103f1d3419bf385e8acfd17c2c14c6d`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `02baf23..1cb9e69`다.

## 2026-11-11 — 중단된 Feather 명령 시험 기록 대조

직전 goal turn은 Pi 명령 경로 사전 점검 도구를 올린 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- ON/OFF 중간에 멈춰도 `--interrupted-output`으로 원래 발급 의도와 팀 상태의 intent hash·command hash, Pi 저널·전송 상태, 보존된 CSE 읽기 기록을 단계별로 대조할 수 있다. 발급 HTTP 응답이 유실돼도 저장된 원래 명령의 ID와 CSE 경로를 확인할 수 있다. [시험과 증거 절차](../keyring/raspberry-pi-gateway/TESTING.md)
- 도구는 로컬 사본을 읽는다. 중단 시험에서 물리 LED와 중앙 정산은 미확인으로 표시한다. 실행·빌드·시험·실물 명령은 미실행이다. Feather/Pi 실물 시험 승인 요청은 대기 중이며 goal은 active/progress다.

중단 기록 대조 commit `6a5537f67d8786ea9bf2f1fb571c24a0855d9553`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `0138f0f..6a5537f`다.

## 2026-11-11 — r18 전원과 BLE 시험 기록 통합

직전 goal turn은 중단된 Feather 명령 기록을 대조하는 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 세 팀 브랜치의 head는 직전과 같다.

- Gateway `0.2.25`에서 `--include-power`를 선택하면 r18 거리·재연결·wake JSON에 INA219 상태, 전압·전류·부하 전력, 부팅별 측정 시각을 추가한다. 같은 부팅에서 재연결한 뒤 반복 수신한 샘플은 구분한다. wake 전후 첫 부팅의 유효 샘플이 비어 있으면 `INSUFFICIENT`로 남긴다. [Pi 사용 절차](../keyring/raspberry-pi-gateway/TESTING.md#r18-ble-시험의-전원-샘플)
- 동일 부팅에서의 반복 계측과 후속 부팅의 잘못된 대체를 다루는 회귀시험 소스를 추가했다. 빌드·시험·실물 계측은 미실행이다. BLE 해제 중 sleep 전류와 배터리 입력은 외부 계측이 필요하다. Feather/Pi 명령 시험과 r18 PCB 인수 시험은 남아 있으며 goal은 active/progress다.

전원 기록 commit `b5be18d47436890e2c80a59b3a8367226c718754`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `133183e..b5be18d`다.

## 2026-11-11 — Gateway HTTPS 서버 지정 재시도

직전 goal turn은 r18 전원·BLE 시험 기록 도구를 올린 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치 head는 직전과 같다.

- Gateway `0.2.26`은 CSE·중앙 API의 HTTPS 429/503 `Retry-After`를 처리한다. 프로세스 안에서는 같은 origin의 새 HTTPS 요청을 보류하며, 개별 outbox 행은 서버 대기 시간과 기존 재시도 간격 중 긴 값을 SQLite에 기록한다. 원래 `rqi`와 payload를 사용해 다시 보낸다. [Gateway 저장과 전송](../keyring/raspberry-pi-gateway/README.md#저장소권한시간-동작)
- HTTP 날짜·초 파싱, 별도 origin 분리, 같은 ID 재시도, SQLite 재개를 다루는 회귀시험 소스를 추가했다. 이번 변경의 빌드·시험·Pi 실행은 미실행이다. Feather/Pi 명령 정산과 r18 실물 인수 시험은 남아 있으며 goal은 active/progress다.

HTTPS 재시도 commit `3cc69fd9d14a08988475c26e203899f506c478e2`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `237c33a..3cc69fd`다.

## 2026-11-11 — 고정 컨테이너의 명령 영수증 저장 확인

직전 goal turn은 Gateway HTTPS 재시도 처리를 올린 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치 head는 직전과 같다.

- Gateway `0.2.27`은 컨테이너 ID가 고정된 명령 영수증을 CREATE한 뒤 동일한 CSE 자원을 HTTPS GET으로 읽는다. CREATE와 조회의 자원 ID가 같고, 부모 ID·이름·타입·저장 본문이 일치할 때만 완료 처리한다. 조회 실패 시 큐를 보존하며 MQTT 응답 뒤 발생한 조회 실패를 HTTPS CREATE fallback으로 처리하지 않는다. [확인 절차](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#명령-영수증-컨테이너-id-고정)
- 기존 격리 proxy 소스에서 Gateway별 자식 GET 경로를 확인했다. 모의·격리 CSE 회귀시험 소스를 보강했다. 이번 빌드·시험·Pi 실행·실물 영수증 관측은 미실행이다. 실물 명령 실행·정산과 r18 인수 검증은 남아 있으며 goal은 active/progress다.

영수증 저장 확인 commit `6f61b3920ffb75c5c31efedab492695ed5d6eef4`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `de4e9e6..6f61b39`다.

## 2026-11-11 — r18 명령 저널 연속성과 쓰기 확인

직전 goal turn은 고정 CSE 영수증 저장 확인을 올린 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치 head는 직전과 같다.

- 펌웨어 `keyring-0.7.8`은 NVS 부팅 복구 중 빈 슬롯 뒤에 기록이 있거나 epoch·grantRevision이 감소하면 새 실행을 막는다. 기존 format 1을 유지한다. PREPARED·COMPLETED commit 뒤 같은 키의 blob을 다시 읽어 바이트가 일치해야 기록을 RAM에 반영한다. PREPARED 확인 실패는 출력 시작을 막고, 완료 확인 실패는 출력을 끄고 `INDETERMINATE`를 보낸다. [저널 경계](../keyring/JOURNAL_RETENTION.md)
- 중간 슬롯 유실, fence 역전, commit 뒤 불일치와 읽기 실패를 주입하는 호스트 시험 소스를 추가했다. 이번 빌드·시험·flash는 미실행이다. 끝쪽 기록만 유실된 경우를 식별하려면 독립 체크포인트가 필요하다. r18 실물 장애 시험과 Feather/Pi 명령 정산은 남아 있으며 goal은 active/progress다.

저널 확인 commit `f7a356405c0b6fe26a299e6b3ca1210ea5aff581`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `d38f943..f7a3564`다.

## 2026-11-11 — r18 저널 끝부분 유실 감지

직전 goal turn은 r18 저널 연속성과 쓰기 확인을 올린 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치 head는 직전과 같다.

- 펌웨어 `keyring-0.7.9`는 기존 NVS 형식 1을 읽고 새 명령부터 같은 namespace의 별도 키에 사용 슬롯 수를 저장한다. 새 PREPARED 기록과 개수가 모두 확인된 뒤 출력을 허용한다. 부팅 때 기록이 줄면 실행을 잠근다. PREPARED 슬롯 하나가 앞선 경우 개수만 복구하고 해당 명령을 미확정으로 유지한다. [저널 경계](../keyring/JOURNAL_RETENTION.md)
- 기존 기록 도입, PREPARED와 개수 갱신 사이 장애, 마지막 슬롯 누락, 체크포인트 유실·손상을 주입하는 호스트 시험 소스를 추가했다. 빌드·시험·flash는 미실행이다. 전체 NVS 손실이나 기록과 체크포인트의 동시 롤백에는 외부 체크포인트가 필요하다. 실물 장애 시험과 중앙 명령 정산은 남아 있으며 goal은 active/progress다.

저널 끝부분 확인 commit `b38dd6b93e4d537d844624738283e6d366344edf`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `e71f2a6..b38dd6b`다.

## 2026-11-11 — 장치 밖 저널 보관본 대조

직전 goal turn은 r18 저널 끝부분 감지의 구현과 업로드로 진행됐다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치 head는 직전과 같다.

- Gateway `0.2.28`의 `bubble-keyring-journal-compare`는 같은 장치의 이전·최신 보관본 두 개를 읽어 해시·수집 순서·기록의 순서와 내용·권한 상한을 대조한다. 누락이나 변경은 `REVIEW_REQUIRED`로 반환한다. 도구는 로컬 파일만 읽으며 정산 상태는 `not-settled`다. 회귀시험 소스를 추가했고 비교 도구와 시험 실행은 미실행이다. [보관본 비교](../keyring/JOURNAL_RETENTION.md#이전-장치-보관본과-비교)
- 사용자에게 Feather 명령 프로필 0.2.0 플래시와 Pi·Mobius4 실물 시험 승인을 받았다. 해당 벤치 실행 결과는 별도로 기록한다.

보관본 비교 commit `2ba76bebbbfe2961b6f33637f0491bfb2136b4c8`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `adb68b5..2ba76be`다.

## 2026-11-11 — 실제 Feather·Pi 명령과 격리 정산 검증

- 사용자 승인에 따라 Feather 0.2.0을 빌드해 COM12에 올렸고 플래시 쓰기 해시를 확인했다. Pi Gateway 0.2.28의 격리 사전 점검에서 고정 컨테이너 ID, 활성 자격, 활성 명령 0건을 확인했다. 기존 격리 CA의 `keyUsage` 누락은 같은 격리 CA 키로 보완한 클라이언트용 인증서로 해결했다. 엄격한 TLS 검증은 유지했다.
- 최초 ON은 Pi의 기존 GATT 캐시에 쓰기 특성이 빠져 `EXPIRED`였다. Mobius4 영수증과 `CSE_CALLBACK`, 중앙 `REVIEW`를 보존했다. Feather만 재등록해 BlueZ의 `write` 특성을 확인한 뒤 새 ON과 OFF를 발급했다.
- 같은 Feather 부팅에서 두 명령 모두 `APPLIED`였고 GPIO readback과 후속 관측이 각각 true와 false였다. Pi SQLite, Mobius4 원본, 팀 승인, 인증 콜백과 격리 PostgreSQL 정산이 일치했다. 성공 명령을 이전 만료 건으로 지정하면 대조 도구가 거절하는 것도 확인했다. Pi 시험 데몬과 SSH 터널은 종료했고, 명령 영수증 대기열은 0건, 관측 대기열은 1건이었다. LED 육안 확인과 r18 검증은 남아 있다. [증거와 해시](../keyring/evidence/2026-11-11-scoped-feather-led/receipt.json)

벤치 보완 commit `e6bf4c1b23a8be8cddce4e2d8e2716035995fff2`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `8694de0..e6bf4c1`이다. goal은 active/progress다.

## 2026-11-11 — Feather 발급 전 Pi 명령 준비 확인

직전 goal turn은 실물 Feather와 Pi Gateway 0.2.28의 ON/OFF 및 격리 정산 증거를 확보한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치 head는 직전과 같다.

- Gateway `0.2.29`는 현재 GATT 세션이 응답형 명령 쓰기를 지원하는지 장치별 `commandReady`로 보고한다. LED 벤치는 같은 Feather 부팅의 관측과 활성 자격을 확인한다. 단계 trigger를 본 뒤 새 health를 기다리고, grant 발급 뒤 같은 Pi 부팅의 준비 상태를 재확인해야 명령을 보낸다. [시험 절차](../keyring/raspberry-pi-gateway/TESTING.md#feather-led-onoff-시험)
- 준비 상태 필드 누락·false, 다른 부팅, 오래된 health를 다루는 회귀시험 소스를 추가했다. 빌드·시험·Pi 배포·실물 재시험은 미실행이다. 앞선 0.2.28의 실물 증거와 범위를 분리한다. goal은 active/progress다.

준비 확인 commit `3bdd273a1a183fbb40d77d4b0288e647fcc72aa7`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1efe0ba..3bdd273`이다.

## 2026-11-11 — r18 명령·영수증의 알림 구독 경계

직전 goal turn은 Feather 발급 전 Pi 준비 확인을 구현한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치 head는 직전과 같다.

- r18 펌웨어 `keyring-0.7.10`은 조립된 명령과 BLE 영수증을 수신 당시 연결 및 영수증 알림 구독에 묶는다. 구독이 바뀌면 이전 대기 명령은 새 모터 출력을 시작할 수 없고, 이전 구독의 미전송 영수증과 READ 사본은 폐기한다. NVS에 저장된 결과는 보존한다. [펌웨어 계약](../keyring/firmware/README.md)
- 타이머 준비 중 재구독, 오래된 큐 명령, 미전송 조각과 긴 READ의 재사용을 다루는 호스트 회귀시험 소스를 추가했다. 빌드·시험·flash는 미실행이다. r18 실물 검증은 남아 있으며 goal은 active/progress다.

구독 경계 commit `28df2d166565bafdd8ced6d2b9447032aa041e58`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `d56fe0f..28df2d1`이다.

## 2026-11-11 — 장애 복구 시 명령 영수증 우선 전송

직전 goal turn은 r18 명령·영수증을 원래 BLE 구독에 묶은 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치 head는 직전과 같다.

- Gateway `0.2.30`은 재전송 시각이 된 native 명령 영수증과 CORE ACK를 먼저 시도한다. 네 번 연속 시도 뒤 일반 항목에도 우선권을 주며, SQLite의 원래 요청 ID와 backoff, scoped CORE 장치별 순서를 보존한다. [영수증 대기열 계약](../keyring/raspberry-pi-gateway/RECEIPT_ROUTING.md)
- 오래된 관측, 재전송 시각 전의 영수증과 전송 가능한 ACK가 함께 쌓인 경우를 다루는 회귀시험 소스를 추가했다. 이번 빌드·시험·Pi 배포·실물 장애 복구는 미실행이다. goal은 active/progress다.

영수증 우선순위 commit `733c45504018f7a5e878f6cae7e09c3bfc1925f1`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `c4130e0..733c455`다.

## 2026-11-11 — CSE Retry-After 동안 대기열 선택 보류

직전 goal turn은 전송 가능한 명령 영수증에 제한된 우선권을 준 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치 head는 직전과 같다.

- Gateway `0.2.31`은 CSE의 HTTPS 보류 기간에 HTTPS가 필요한 경로를 SQLite 송신 선택에서 제외한다. 아직 시도하지 않은 행의 retry 횟수와 시각은 그대로다. oneM2M MQTT가 준비돼 있으면 HTTPS 사전 조회가 필요한 고정 영수증 컨테이너만 제외하며, CORE MQTT 경로는 독립적으로 선택한다. [재시도 동작](../keyring/raspberry-pi-gateway/README.md)
- CSE 보류 시작·종료, 고정 컨테이너 경로, ACK 독립 송신과 대기 행 보존을 다루는 회귀시험 소스를 추가했다. 빌드·시험·Pi 배포·실물 장애 복구는 미실행이다. goal은 active/progress다.

HTTPS 선택 보류 commit `420c07df34944681f86b763f35765db849bd55ae`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `982321c..420c07d`다.

## 2026-11-11 — r18 가속도계와 움직임 경로 재시도

직전 goal turn은 CSE `Retry-After` 동안 막힌 송신 경로의 선택을 보류한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치 head는 직전과 같다.

- 펌웨어 `keyring-0.7.11`은 가속도계 초기화 또는 축 읽기가 실패하면 기존 설정으로 재시도한다. 인터럽트 오류만 있으면 해당 경로를 따로 복구하고 부팅 중 누적 움직임 수를 보존한다. 축 샘플과 인터럽트가 모두 정상인 때만 절전을 검토한다. [절전 경계](../keyring/firmware/POWER_WAKE.md)
- 부팅 시 응답 없음, 축·인터럽트 읽기 장애와 복구, 배터리 경로 독립성을 다루는 호스트 회귀시험 소스를 추가했다. 빌드·시험·flash는 미실행이다. r18 실물 검증은 남아 있으며 goal은 active/progress다.

가속도계 복구 commit `ecbf579e2b80916739af5c07f3c634966ffcd7be`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `e651bc2..ecbf579`다.

## 2026-11-11 — r18 배터리 잔량 경보

직전 goal turn은 가속도계와 움직임 경로의 복구를 구현한 progress다. DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 브랜치 head는 직전과 같다.

- 펌웨어 `keyring-0.7.12`의 경보 기본값은 잔량 20% 이하에서 설정, 25% 이상에서 해제다. BLE는 `batteryAlert`를 모든 detail과 축약 관측에 보내고 읽기 오류에는 `null`을 보낸다. 켜진 LCD는 낮은 잔량을 `LOW`로 표시한다. Gateway `0.2.32`는 잔량과 경보의 일관성을 검사해 native CSE로 전달한다. [센서 설정](../keyring/firmware/README.md)
- 경계값과 임시 읽기 오류, 축약 관측, BLE 및 Gateway 관측 계약을 다루는 회귀시험 소스를 추가했다. 빌드·시험·flash·LCD/배터리 실물 검증은 미실행이다. goal은 active/progress다.

배터리 경보 commit `dd71dace86f89367cd6a51b99bbcbc0f5d980e07`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `738bced..dd71dac`다.

## 2026-11-11 — Pi에서 r18 배터리 경보 전환 기록

직전 goal turn은 r18 저전압 경보를 BLE·LCD·native CSE 관측에 추가한 progress다. DOC-REV 2.0.0 및 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 head와 Gateway 관련 계약은 직전과 같다.

- Gateway `0.2.33`의 배터리 기록 모드는 인증된 r18 알림에서 정상 잔량, 방전 중 중간 구간, 경보 설정, 충전 중 중간 구간, 경보 해제를 한 BLE 세션 안에서 대조한다. 반대 경보, 필드 누락, 잔량 미확인을 구분하고 실제 팩과 계측 IC 모사 입력을 별도로 표기한다. [Pi 실행 절차](../keyring/raspberry-pi-gateway/TESTING.md#r18-배터리-경보-기록)
- 회귀시험 소스는 임계값, 세션 분리, 알림 필드 누락, 센서 읽기 미확인과 다른 기록 모드의 출력 범위를 다룬다. 빌드·시험·Pi 배포·실물 기록은 미실행이다. LCD·충전 표시와 CSE 수신은 별도 증거가 필요하다. goal은 active/progress다.

Pi 배터리 기록 commit `3e4185bf9ecdc6c542686c65bd6bb5134c5a033e`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `49341a8..3e4185b`다.

## 2026-11-11 — 자격 조회 단절 후 이전 명령 승인 차단

직전 goal turn은 Pi의 r18 배터리 전환 기록 모드를 구현한 progress다. DOC-REV 2.0.0, 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`와 팀 중앙의 자격 상태·승인 계약을 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.34`는 중앙 자격 상태의 변경, 조회 실패, TTL 만료로 생긴 단절을 로컬 승인 세대에 반영한다. 같은 revision으로 복구돼도 단절 전에 요청한 중앙 승인은 사용할 수 없다. BLE 조각 송신 중이면 다음 쓰기를 중단하고 미확정 영수증을 보존한다. 자격 TTL은 조회 요청 시작부터 계산한다. [명령 실행 정책](../keyring/raspberry-pi-gateway/README.md)
- 동일 revision 복구, TTL 공백, 지연된 응답, 정상 연속 갱신과 부분 전송 중단을 다루는 회귀시험 소스를 추가했다. 빌드·시험·Pi 배포·실물 명령은 미실행이다. goal은 active/progress다.

자격 단절 commit `723342f7ad6cc2b28cc70fa0cf82ac23d530db97`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `9095f64..723342f`다.

## 2026-11-11 — 자격 상태 전환 영수증 보관과 재전송

직전 goal turn은 자격 단절 후 기존 명령 승인 재사용을 막은 progress다. DOC-REV 2.0.0, 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`와 팀 자격 상태 응답 계약을 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.35`는 중앙 mTLS의 첫 자격 관측과 상태·revision 전환을 SQLite에 저장한다. 일반 outbox 포화 중에도 별도 대기 한도까지 보존하고, 기존 health 컨테이너로 같은 요청 ID와 본문을 순서대로 전송한다. 전송 완료 시각과 최근 완료 128건을 로컬에 남긴다. [전환 영수증](../keyring/raspberry-pi-gateway/RECEIPT_ROUTING.md#자격-상태-전환-영수증)
- 기존 DB의 추가 테이블, 보관본, 큐 포화·재시작·동일 ID, 완료 이력 제한, 저장 실패 시 실행 차단과 벤치 heartbeat 분리를 다루는 회귀시험 소스를 추가했다. 빌드·시험·Pi 배포·실제 CSE 전송은 미실행이다. 중앙의 실제 발급·회전 시각 증거와 실물 연결은 남아 있다. goal은 active/progress다.

자격 전환 영수증 commit `bf1e4a947b00064687277e91e3f917d5ac667755`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `9ff2ad9..bf1e4a9`다.

## 2026-11-11 — 자격 전환 영수증의 CSE 저장 확인

직전 goal turn은 자격 전환 영수증을 SQLite에 보관하고 재전송하도록 구현한 progress다. DOC-REV 2.0.0, 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`와 자격 상태 계약을 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.36`은 MQTT·HTTPS CREATE와 중복 응답 후 해당 contentInstance를 HTTPS로 읽어 이름·유형·리소스 ID·부모 ID·본문을 검사한다. CREATE가 인스턴스를 반환한 경우 조회에서 같은 리소스·부모를 확인한다. 조회 실패는 원래 영수증을 재시도한다. CSE HTTPS 보류 중에는 이 영수증만 health 경로의 선택에서 제외하고 MQTT 일반 heartbeat는 선택할 수 있다. [저장 확인 정책](../keyring/raspberry-pi-gateway/RECEIPT_ROUTING.md#자격-상태-전환-영수증)
- 모의 전송·SQLite 대기열 및 격리 Mobius4 양쪽 binding의 회귀시험 소스를 추가했다. 이번 빌드·시험·Pi 배포·실제 CSE 저장 확인은 미실행이다. 기존 완료 행은 당시 판정 기준으로 남는다. goal은 active/progress다.

자격 영수증 저장 확인 commit `4b82cbfd01cd3154d144443de4e87d5ad0a205f0`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `daadb12..4b82cbf`다.

## 2026-11-11 — r18 제작 PCB 관측 전용 초기 구동

직전 goal turn은 자격 전환 영수증의 CSE 저장 확인을 추가한 progress다. DOC-REV 2.0.0, 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 head와 관련 GATT 계약은 직전과 같다.

- `keyring_r18_bringup`은 별도 identity `keyring-0.7.13-bringup`으로 배터리·가속도·버튼·전원 관측을 제공한다. LCD·오디오 재생·SD·deep sleep을 끄고 BLE 명령과 장치 journal을 열지 않는다. USB 부팅 로그에 모터·AUX·fault와 센서 상태를 추가했다. [PCB 구동 절차](../keyring/pcb/BRING_UP.md)
- Gateway `0.2.37`은 BlueZ에 기존 쓰기 특성이 캐시돼도 관측 전용 identity에서 명령과 저널 selector 쓰기를 차단한다. 펌웨어 관측과 Gateway 캐시 사례의 회귀시험 소스를 추가했다. 빌드·시험·플래시·전원 인가·Pi 연결은 미실행이다. goal은 active/progress다.

r18 초기 구동 commit `b63c795ef872099372191021e846cc3f79571f93`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `d0a5cad..b63c795`다.

## 2026-11-11 — Pi에서 r18 초기 구동 증거 한 세션에 기록

직전 goal turn은 r18 관측 전용 펌웨어와 Gateway의 쓰기 차단을 구현한 progress다. DOC-REV 2.0.0, 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`와 팀 GATT 계약을 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.38`은 `--mode bringup`에서 최초 알림 세션의 확인·비상 누름/해제와 누계, 배터리·3축·motion, INA219, 저널·절전 비활성과 명령 준비·fault를 대조한다. 같은 boot여도 후속 세션 자료로 부족한 단계를 채우지 않는다. 판정에 필요한 필드만 로컬 JSON에 남긴다. [Pi 기록 절차](../keyring/raspberry-pi-gateway/TESTING.md#r18-초기-구동-기록)
- 관측 성공, 세션 분리, 유효하지 않은 누계, 위험 상태 및 원본 프레임 제외 회귀시험 소스를 추가했다. 빌드·시험·Pi 접속·실물 캡처는 미실행이다. 전원 레일·외부 입력 및 충전 전류 실측은 별도다. goal은 active/progress다.

r18 Pi 기록 commit `815d89ce6879af204c21f9cfdd9cbef1724cf679`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `2302da3..815d89c`다.

## 2026-11-11 — r18 BLE 재연결 전후 버튼 누계 기록

직전 goal turn은 r18 초기 구동의 한 세션 기록을 구현한 progress다. DOC-REV 2.0.0, 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`와 팀 BLE 계약을 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.39`는 재연결 전 마지막 알림과 복구 직후 첫 알림의 부팅·sequence·uptime·두 버튼 누계를 대조한다. 알림이 없던 중간 세션은 복구 시간의 끝으로 쓰지 않고, 중간에 관측된 부팅 변경은 별도로 검출한다. [Pi 재연결 기록 절차](../keyring/raspberry-pi-gateway/TESTING.md#r18-재연결-전후-버튼-누계-기록)
- 중간 세션, 부팅 변경, 첫 복구 알림의 역행, 증거 누락과 원본 제외를 다루는 회귀시험 소스를 추가했다. 빌드·시험·Pi 접속·실물 재연결 기록은 미실행이다. goal은 active/progress다.

r18 재연결 기록 commit `ff473c2fd7b834de6b9d1ad239b8f67690006117`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `b4e7cd6..ff473c2`다.

## 2026-11-11 — 재연결 및 재시작 후 이전 BLE 관측 차단

직전 goal turn은 r18의 재연결 전후 버튼 누계 기록을 구현한 progress다. DOC-REV 2.0.0, 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`와 팀 BLE 계약을 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.40`은 장치의 마지막 관측 번호를 연결 종료 뒤에도 유지하고, 프로세스 시작에는 기존 SQLite에서 마지막 부팅과 번호를 읽는다. 같은 부팅의 이미 받은 번호를 거르고 높은 번호의 uptime 역행은 프로토콜 오류로 처리한다. 영수증의 시각 기준은 연결 종료 시 지우고 새 연결에서 수용한 관측으로만 갱신한다. [BLE 경계](../keyring/raspberry-pi-gateway/BLE_SESSIONS.md#재연결과-관측-시각-기준)
- 이전 READ·알림, 새 부팅, uptime 역행, 큐 포화와 SQLite 재시작 커서를 다루는 회귀시험 소스를 추가했다. 빌드·시험·Pi 접속·실물 재연결은 미실행이다. goal은 active/progress다.

이전 관측 차단 commit `1536b05139a6613cf2e2774f5910ef8fa748d4c5`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `7217401..1536b05`다.

## 2026-11-11 — BLE 영수증 수신 시각과 UTC 추정 경계

직전 goal turn은 BLE 재연결·Gateway 재시작 때 이전 관측을 차단한 progress다. DOC-REV 2.0.0, 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`와 영수증 연동 계약을 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.41`은 일치하는 BLE 영수증의 수신 시점에 관측 기준과 UTC 추정값을 확정한다. 새 `APPLIED`가 마지막 조각 전송 이전으로 추정되거나 적용이 수신 이후로 추정되면 수락·적용 추정값을 비운다. 시계 이동에도 같은 처리를 하고 장치 결과·readback·수신 시각을 보존한다. [영수증 시각 경계](../keyring/raspberry-pi-gateway/BLE_SESSIONS.md#재연결과-관측-시각-기준)
- 늦게 반환한 GATT 쓰기 응답, 나중 관측, 시간 범위 위반, 저널 중복 결과와 수신 시각 보관을 다루는 회귀시험 소스를 추가했다. 빌드·시험·Pi 접속·실물 영수증 검증은 미실행이다. goal은 active/progress다.

영수증 시각 commit `19712ecf9e29430bbc4599eff44b30c8842aa2b8`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `e5f048c..19712ec`다.

## 2026-11-11 — 마지막 GATT 응답 유실 뒤 장치 영수증 보존

직전 goal turn은 BLE 영수증의 수신 시각과 UTC 추정 경계를 구현한 progress다. DOC-REV 2.0.0, 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`와 팀 ACK 계약을 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.42`는 마지막 GATT 쓰기 시작 이후, 하나의 BLE 기한 안에 해당 세션에서 받은 일치 영수증을 수용한다. 이후 연결 종료·쓰기 응답 오류·내부 타임아웃에도 그 결과와 readback을 SQLite 경로에 전달한다. 새 연결로 조각을 이어 보내지 않는다. [BLE 처리](../keyring/raspberry-pi-gateway/BLE_SESSIONS.md#승인-기한과-gatt-전송)
- 이른 응답, 기한 이후 응답, 사용자 취소, 기존 연결 교체 방어와 SQLite 정산을 다루는 회귀시험 소스를 추가했다. 빌드·시험·Pi 접속·실물 검증은 미실행이다. goal은 active/progress다.

영수증 보존 commit `2cdc96baae12cb85524488aa5daab0c2f893d627`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `4bde3f7..2cdc96b`다.

## 2026-11-11 — 마지막 GATT 응답 전 SQLite 영수증 저장

DOC-REV 2.0.0과 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.43`은 현재 세션의 기한 내 일치 영수증을 알림 처리 중 SQLite에 커밋한다. 마지막 쓰기 응답을 기다리는 동안 종료되어도 커밋된 결과를 유지한다. SQLite 저장이 일시적으로 실패하면 보관한 영수증으로 저장만 재시도한다. [BLE 처리](../keyring/raspberry-pi-gateway/BLE_SESSIONS.md#승인-기한과-gatt-전송)
- Windows Python 3.11에서 wheel을 빌드하고 설치본의 기본 시험 153개가 통과했다. 마지막 응답을 보류한 상태에서 별도 SQLite 연결로 결과를 읽고, 취소 후 결과와 카운터, SQLite 오류 후 저장 재시도를 확인했다. 해당 버전의 Pi·BlueZ와 r18 시험은 남아 있다. [로컬 시험](../keyring/raspberry-pi-gateway/TESTING.md)
- 사용자가 승인한 Feather 0.2.0·Pi 0.2.28 격리 시험은 이전에 수행했다. ON/OFF 모두 GPIO readback, Mobius4 원본과 중앙 정산이 일치했다. [실물 시험 기록](../keyring/evidence/2026-11-11-scoped-feather-led/receipt.json)

소스 commit `596e44ce7ff2857d015d057ce82f6236a985d34a`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `6af2279..596e44c`다. goal은 active/progress다.

## 2026-11-11 — 고정 영수증 재전송과 Feather 육안 시험

일시 중지 직전에 Gateway 0.2.44 소스와 회귀시험을 작업 트리에 남겼다. 재개 뒤 DOC-REV 2.0.0 및 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. main의 새 INTEGRATION 계약에 `dispatch-start`와 중앙 영수증·관측 수집이 추가됐다. 현재 역할 브랜치의 Gateway 실행 경로와 새 중앙 API를 잇는 작업이 남아 있다.

- Gateway `0.2.44`는 고정 컨테이너의 최초 명령 영수증 전송 시도를 SQLite에 기록한다. 재시도에서는 기존 영수증의 부모·이름·유형·본문을 먼저 확인하고, 확인된 부재에 한해 같은 이름으로 CREATE를 진행한다. 회귀시험 소스를 함께 올렸다. 이 버전의 빌드·시험·배포는 미실행이다. [영수증 대기열](../keyring/raspberry-pi-gateway/RECEIPT_ROUTING.md)
- 실제 Pi Gateway `0.2.43`으로 Feather `0.2.0`의 ON/OFF를 다시 실행했다. 고정 컨테이너와 활성 자격을 확인했고 두 건 모두 장치 ACK·GPIO readback·후속 관측·Mobius4·인증 콜백·중앙 정산이 일치했다. 사용자는 빨간 LED를 식별하지 못했고 ON/OFF에서 점등 변화를 관찰하지 못했다. Pi의 명령 영수증 대기열은 0건이었고 시험 데몬과 SSH 터널을 종료했다. [실물 시험 결과](../keyring/evidence/2026-11-11-feather-visual/receipt.json)

소스 commit `36276bd62467c409a1c8c4778b379f89da02983a`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `bd1d5ec..36276bd`다. goal은 active/progress다.

## 2026-11-11 — 중앙 dispatch-start와 BLE 명령 연결

직전 goal turn은 고정 영수증 재전송 구현을 올리고 Feather 육안 시험 결과를 기록한 progress다. DOC-REV 2.0.0과 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.45`는 `PC_DISPATCH_START_REQUIRED=true` 설정에서 최초 승인과 SQLite 실행 의도 저장 뒤 같은 claim으로 중앙 `dispatch-start`를 호출한다. 두 응답 중 이른 기한을 적용하고 BLE 세션과 자격을 다시 확인한다. 연결 실패, 경로 부재, 승인 거절이나 불일치 시 BLE 명령을 보내기 전에 거절 영수증을 남긴다. 기존 격리 프로필은 기본값 `false`를 사용한다. [승인 및 전송 경계](../keyring/raspberry-pi-gateway/BLE_SESSIONS.md#승인-기한과-gatt-전송)
- 요청 바인딩, 로컬 실행 의도 기록 순서, 기한 단축·만료, 세션 교체, 취소와 경로 부재를 다루는 회귀시험 소스를 추가했다. 빌드·시험·중앙 API 연결·Pi 시험은 미실행이다. 새 중앙 `/receipts`와 `/telemetry` 전송 경로 및 실제 연동 시험이 남아 있다.

소스 commit `1d9dd4fc9bb94bf2a9f953090d0f274827953cac`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `bac1c3f..1d9dd4f`다. goal은 active/progress다.

## 2026-11-11 — 중앙 명령 영수증 정산 경로

직전 goal turn은 중앙 `dispatch-start` 연동을 올린 progress다. DOC-REV 2.0.0과 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 중앙 `/receipts`의 반환 상태, command ID·claim ID 및 영수증 해시 계약을 읽었다.

- Gateway `0.2.46`은 `CENTRAL_RECEIPTS_ENABLED=true` 설정에서 중앙용 영수증과 등록 표시를 같은 SQLite 트랜잭션에 저장한다. 기존 Mobius4 전달 완료 영수증도 같은 중앙 배포에서 등록할 수 있다. 재전송에는 동일 본문과 `Idempotency-Key`를 사용하고, 중앙 응답의 command ID·claim ID·영수증 SHA-256을 확인한다. Mobius4 전송 완료 상태는 해당 경로의 응답으로 관리한다. [중앙 영수증 정산](../keyring/raspberry-pi-gateway/RECEIPT_ROUTING.md#중앙-명령-영수증-정산)
- 기존 DB 열기, 용량 부족, 재시작 후 재전송, CSE 보류 중 중앙 송신, 응답 불일치 회귀시험 소스를 추가했다. 빌드·시험·DB 업그레이드 실행·실제 중앙 API와 Pi 검증은 미실행이다. 새 중앙 `/telemetry` 전달 경로가 남아 있다.

소스 commit `af8fae600965eeff31ba120407c6cd1d48d63cc0`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1e8d322..af8fae6`다. goal은 active/progress다.

## 2026-11-11 — 중앙 BLE 관측 전달

직전 goal turn은 중앙 명령 영수증 정산 경로를 올린 progress다. DOC-REV 2.0.0과 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 중앙 `/telemetry`의 관측 식별자, 상태 응답과 보관 기한을 읽었다.

- Gateway `0.2.47`은 `CENTRAL_TELEMETRY_ENABLED=true`에서 중앙용 BLE 관측을 Mobius4용 항목과 관측 커서와 함께 저장한다. 장치별 미전송 관측을 저장 순서로 처리하고 재전송에 같은 본문과 `Idempotency-Key`를 쓴다. 장치 ID와 `observationId`가 일치하는 `ACCEPTED`, `DUPLICATE`, `STALE` 응답을 처리한다. 시계가 정상이고 관측이 24시간 2초를 넘으면 중앙용 항목을 만료로 집계한다. [중앙 관측 전달](../keyring/raspberry-pi-gateway/IO_NOTES.md#중앙-관측-전달)
- SQLite 용량과 재시작, 장치별 순서, 중앙 응답 ID, `STALE`과 만료를 다루는 회귀시험 소스를 추가했다. 빌드·시험·중앙 API 연결·Pi 검증은 미실행이다. 최신 중앙 배포의 Gateway·장치·가구 등록을 적용한 실제 연동 증거가 남아 있다.

소스 commit `fe03e8ddb64a319d61a50328f526f45bce15084c`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `c7f7cab..fe03e8d`다. goal은 active/progress다.

## 2026-11-11 — 최신 중앙 API 격리 벤치 준비

직전 goal turn은 중앙 BLE 관측 전달을 올린 progress다. DOC-REV 2.0.0과 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 최신 런타임의 가구·장치 등록과 mTLS 경로를 읽었다.

- 새 `integration` 프로필은 최신 팀 소스·계약을 `.local/scoped/command-api-integration/`에 고정하고, 루프백 `8788`에서 시험용 Gateway·가구·장치를 등록하도록 구성했다. 해당 인증서에만 중앙 승인·영수증·관측 경로를 허용한다. Pi 프로필과 PC LED 도구에 같은 모드 선택을 추가했다. [격리 API 준비](../keyring/dev/mobius4/README.md#최신-integration-api-벤치)
- `start-scoped-command-api.ps1 -Mode integration -PrepareOnly`가 exit 0을 반환했다. 팀 소스·계약 아카이브 SHA-256은 `d71f006b9a64576376115303227d8e9b4aa9e8ce5010429e98316cb3f3475b3a`다. 로컬 시험용 운영자 인증서를 발급했다. 팀 Node 의존성 설치와 새 API 시작·등록, 테스트·빌드·Pi 실행은 미실행이다.

소스 commit `fbac3d11035c3de3275e858140a7364fb861f362`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `647696d..fbac3d1`다. goal은 active/progress다.

## 2026-11-11 — 최신 중앙 API 루프백 시작 및 시험 장치 등록

직전 goal turn은 최신 중앙 API 프로필을 준비한 progress다. DOC-REV 2.0.0과 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 head는 직전과 같다.

- 팀 `package-lock.json`을 pnpm 잠금 파일로 변환했다. 일부 패키지가 로컬 캐시에 없어 고정 잠금 파일을 유지하고 공식 npm 레지스트리에서 필요한 패키지를 받았다. 프로덕션 의존성 설치는 exit 0이었고 패키지 스크립트 실행은 껐다.
- 격리 런처가 `127.0.0.1:8788`에서 `READY`를 반환했다. 로컬 상태에서 `gw-a`의 활성 자격, 운영자 보호자 등록과 시험 장치의 Gateway·가구 연결을 확인했다. 발급 명령과 관측은 각각 0건이다. 빌드·시험·Pi 실행은 미실행이다. [시작 기록과 잠금 파일 해시](../keyring/evidence/2026-11-11-current-central-bench/provisioning.json)

사용한 런처 소스는 원격 역할 브랜치에 반영된 `fbac3d11035c3de3275e858140a7364fb861f362`다. goal은 active/progress다.

## 2026-11-11 — 최신 중앙 API의 Feather 시험 증거 대조

직전 goal turn은 최신 중앙 API를 루프백에 시작하고 등록을 확인한 progress다. DOC-REV 2.0.0과 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 중앙의 `GATEWAY_DISPATCH_STARTED`, `GATEWAY_RECEIPT_SETTLED`, `GATEWAY_TELEMETRY_ACCEPTED` 기록을 읽었다.

- 통합 모드 LED 시험은 Mobius4 원본과 일치하는 중앙 `APPLIED_VERIFIED` 기록을 확인한 뒤 다음 단계로 넘어간다. 증거 도구는 Pi SQLite의 컨테이너 고정 ID와 전송 상태를 대조하고 중앙 실행 시작·정산·관측 이벤트 ID를 출력한다. 운영자 육안 기록은 독립 항목이다. [최신 중앙 API 시험 결과 대조](../keyring/raspberry-pi-gateway/TESTING.md#최신-중앙-api의-시험-결과-대조)
- 중앙 정산 대기, 잘못된 claim·영수증 해시·관측 시각을 다루는 회귀시험 소스를 추가했다. 빌드·시험·증거 도구 실행·실제 Pi 연동은 미실행이다.

소스 commit `be596de96ce9c61625af052fd3bc13e7717fb6ab`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `62b81c3..be596de`다. goal은 active/progress다.

## 2026-11-11 — Pi 시작 전 격리 중앙 API 확인

직전 goal turn은 최신 중앙 API의 Feather 시험 및 증거 대조 코드를 올린 progress다. DOC-REV 2.0.0과 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 head는 직전과 같다.

- 통합 벤치는 시험 Gateway 인증서에 `bench-capabilities` 조회를 제공한다. Pi의 `preflight`와 `run`은 모드, 고정 팀 커밋, Gateway·장치 ID와 세 기능을 대조한다. 불일치하면 Gateway와 BLE 시작을 중단한다. [Pi 명령 세션](../keyring/raspberry-pi-gateway/TESTING.md#pi-명령-세션)
- 기존 루프백 리스너의 소유 프로세스와 빈 명령·관측 상태를 확인하고 격리 API를 재시작했다. `127.0.0.1:8788`에서 `READY`와 `dispatch-start`, `receipts`, `telemetry` 목록을 수신했다. Pi의 인증 조회, 회귀시험과 빌드는 미실행이다.

소스 commit `00ee7747efcef1bcdbfe4163b238d138363f65dd`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `d6cae41..00ee774`다. goal은 active/progress다.

## 2026-11-11 — Feather 화면에 명령 상태 표시 및 r18 보조 전원 차단

DOC-REV 2.0.0과 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 사용자는 Feather의 ON/OFF 시험에서 모두 LED 변화가 없었다고 확인했다. 기존 기록에는 GPIO readback, Mobius4 영수증과 중앙 정산이 있다. [기존 실물 기록](../keyring/evidence/2026-11-11-feather-visual/receipt.json)

- Feather `0.2.1`은 1.54인치 ST7789에서 `CMD ON`, `CMD OFF`, GPIO 초기화 오류를 표시한다. BLE 관측과 화면은 같은 GPIO 표본을 쓰며 마지막 A0/A1 입력 표시는 별도 줄에 유지한다. Pi와 PC 격리 도구는 선택한 펌웨어 하나를 대조한다. 과거 `0.2.0` 설정과 증거를 계속 읽는다. [격리 시험 절차](../keyring/raspberry-pi-gateway/TESTING.md#기존-scoped-mobius4에서-feather-led-시험)
- r18 `0.7.14`는 타이머가 alert 고장을 감지하면 모터 GPIO가 LOW로 내려갈 때까지 화면 요청에 의한 보조 전원 재인가를 막는다. 활성 화면의 주기 갱신에서 백라이트를 껐다 켜는 GPIO 전이를 없앴다. 첫 빌드에서 발견한 비공개 `getGattsIf()` 호출을 공개 GATT 등록 이벤트로 교체했다. [보조 전원 설명](../keyring/firmware/PERIPHERALS.md#공용-전원spi절전)
- r18 기본·ST7789·JD9853 빌드와 Feather 기본 관측·명령 빌드가 모두 통과했다. Feather는 Git 밖의 임시 소스 사본에 합성 PIN을 넣어 컴파일했다. r18 및 Feather 호스트 회귀 17개, 벤치 Python 회귀 12개, Gateway 로컬 시험 172개가 통과했다. 모의 ON/OFF 영수증 대조는 0.2.1을 받아들이고 버전이 섞인 기록을 거절했다. Gateway 첫 전체 실행에서 OpenSSL 경로가 빠져 TLS fixture 두 개가 시작되지 않았다. 설치된 Git OpenSSL을 지정한 최종 실행에서 전체가 통과했다. 새 펌웨어의 flash와 화면 육안 확인, 실제 Pi 연동 및 r18 실물 시험은 미실행이다. [빌드 SHA-256](../keyring/implementation-status.json)

소스 commit `916ff1ef1f82daacf1481e057fbf9babb77be3e8` 및 `5e6598fc1931e4fc642b82d6d6e0cbf1ef941806`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `d4fbb06..5e6598f`다. goal은 active/progress다.

## 2026-11-11 — Feather 명령 화면 관측 증거

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01~R03, R05. 직전 goal turn은 Feather 화면·r18 보조 전원 구현, 로컬 빌드와 시험 증거를 올린 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 조회했다. 팀 커밋과 중앙 실행·정산 경계는 직전과 같다.

- 격리 증거 도구는 `--display-observations`로 0.2.1의 실제 화면 문구를 받는다. ON/OFF의 command ID와 후속 관측 시각을 확인하고, ON 기록은 다음 명령 발급 전에 들어와야 한다. 잘못된 문구·GPIO 오류·화면 미표시는 관측대로 남기고 불일치로 판정한다. LED 육안 결과는 별도 필드를 유지한다. [화면 기록 절차](../keyring/raspberry-pi-gateway/TESTING.md#실물-명령-증거-대조)
- 기존 0.2.0의 GPIO·Mobius4·중앙 정산 증거를 완료 상태 표에 반영했다. 0.2.1 화면 관측과 잘못된 명령·시각을 다루는 회귀시험 소스를 추가했다. 이번 도구 실행·빌드·회귀시험·flash·실물 검증은 미실행이다. 제작 PCB와 최신 중앙 API의 실물 통합은 대기 중이다.

소스 commit `426ec9d25344f53f75686490e67f46db37699c7e`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `fec9536..426ec9d`다. goal은 active/progress다.

## 2026-11-11 — r18 USB 부팅과 Pi BLE 기록 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R05. 직전 goal turn은 Feather 화면 관측과 명령 증거 연결을 올린 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`에서 Gateway 등록, BLE 계약과 웹 영수증 매핑을 확인했다. 팀 head는 직전과 같다.

- `keyring-0.7.14-bringup`은 USB CDC에 보드·펌웨어 revision, BLE에 사용하는 부팅 ID와 motor·aux·fault 상태를 기록한다. Gateway `0.2.48`의 `--usb-boot-log`는 한 번의 부팅 로그를 읽고, 알림을 수집한 모든 BLE 세션이 그 부팅인지 대조한다. 다른 부팅 또는 USB 출력·fault 활성은 `MISMATCH`로 보고한다. 결과에는 로그 SHA-256과 일치 여부를 기록하며 원본 부팅 ID는 로컬 로그에만 둔다. [r18 첫 구동](../keyring/pcb/BRING_UP.md)
- 로그 형식 오류, 다른 부팅, 두 번째 부팅의 알림, 출력 활성과 부팅 ID 비공개를 다루는 회귀시험 소스를 추가했다. 빌드·회귀시험·캡처 도구 실행·flash·전원 인가·Pi 접속은 미실행이다. 제작 PCB가 도착하면 USB와 BLE 기록, 전원 레일의 실측이 필요하다.

소스 commit `9644be7a19dfb6c9aa39b774be2549cd3d7c64c0`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `0c12529..9644be7`다. goal은 active/progress다.

## 2026-11-11 — 중앙 관측과 Mobius4 영수증의 독립 전송

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03. 직전 goal turn은 r18 USB·BLE 첫 부팅 기록을 연결한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`의 중앙 `telemetry`·`receipts`와 CORE 경로, 웹 영수증 계약을 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.49`는 중앙 BLE 관측을 전용 전송 작업에서 처리한다. 중앙 관측 응답을 기다리는 동안 Mobius4 관측과 명령 영수증을 기존 작업에서 보낼 수 있다. SQLite 등록, 동일 요청 ID, 장치별 미전송 순서, API origin의 `Retry-After`를 유지한다. [중앙 관측 전달](../keyring/raspberry-pi-gateway/IO_NOTES.md#중앙-관측-전달)
- 중앙 응답을 보류한 동안 Mobius4 관측·명령 영수증 전송과 중앙 항목 보존을 확인하는 회귀시험 소스를 추가했다. 빌드·회귀시험·Pi 실행·실물 연동은 미실행이다. 현재 중앙 API와 실제 Pi의 전송 및 제작 PCB 검증은 남아 있다.

소스 commit `b15b4403e1ea31463412947e7985936939d044d4`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `5870cd2..b15b440`다. goal은 active/progress다.

## 2026-11-11 — 재시도 대기 중인 중앙 관측 만료

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R15. 직전 goal turn은 중앙 관측 전송을 독립시킨 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`가 직전과 같다. 중앙의 관측 시각 기반 보관 기간과 CORE·웹 영수증 경계를 확인했다.

- Gateway `0.2.50`은 시계를 신뢰할 때 재시도 예정 시각과 별개로 만료된 중앙 관측 복제본을 SQLite에서 정리한다. `CENTRAL_TELEMETRY_RETENTION_SECONDS`로 배포별 중앙 보관 기간을 맞추며 기본은 24시간이다. Mobius4 관측과 영수증은 각 전송 규칙을 적용한다. 만료되지 않은 행으로 용량을 채우면 기존 제한이 적용된다. [중앙 관측 전달](../keyring/raspberry-pi-gateway/IO_NOTES.md#중앙-관측-전달)
- UTC 오프셋·만료 경계, 재시도 대기, 용량 반환, 시계 불신 상태를 다루는 회귀시험 소스를 추가했다. 빌드·회귀시험·Pi 실행·실물 연동은 미실행이다. 제작 PCB와 실제 Pi의 통합 증거가 남아 있다.

소스 commit `d8ce9e0ba6ce5e5eee3e2bdf1800a524a38d2a0f`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `e2c8e12..d8ce9e0`다. goal은 active/progress다.

## 2026-11-11 — 중앙 명령 영수증의 독립 전송

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01~R03, R10. 직전 goal turn은 중앙 관측 만료 처리를 추가한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 중앙 응답의 command ID·claim ID·영수증 해시 경계를 확인했다. 팀 head는 직전과 같다.

- Gateway `0.2.51`은 중앙 명령 영수증을 전용 작업에서 보낸다. Mobius4 요청과 중앙 요청은 각자의 응답을 기다린다. 두 작업은 같은 SQLite 명령 저널에서 원자적으로 전송을 등록하고 각각 자기 경로의 행을 전송한다. 재시작 뒤 같은 요청 ID와 backoff를 사용한다. [중앙 영수증 정산](../keyring/raspberry-pi-gateway/RECEIPT_ROUTING.md#중앙-명령-영수증-정산)
- 중앙 응답 대기 중 Mobius4 영수증 완료와 중앙 행 보존을 확인하는 회귀시험 소스를 추가했다. 빌드·회귀시험·실제 Pi 연동은 미실행이다. 두 서버와 Pi의 실제 영수증 대조 및 제작 PCB 검증이 남아 있다.

소스 commit `8a7377ed8a2c2dfa43d591e50584e3775a919a06`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `b2b0370..8a7377e`다. goal은 active/progress다.

## 2026-11-11 — SQLite 용량 부족 시 영수증 등록 분리

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01~R03, R10. 직전 goal turn은 중앙 영수증의 전송을 분리한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 중앙 중복 판정의 영수증 해시와 CORE ACK·웹 확인 계약을 읽었다.

- Gateway `0.2.52`는 중앙 영수증과 등록 표시를 별도 SQLite 트랜잭션에 저장한다. Mobius4 영수증과 선택형 CORE ACK는 같은 트랜잭션에서 등록한다. 한 경로가 용량 부족으로 롤백돼도 다른 경로는 공간이 허용하는 즉시 등록할 수 있다. 등록을 미룬 원본은 명령 저널에 남으며 각 작업은 같은 요청 ID로 재시도한다. [중앙 영수증 정산](../keyring/raspberry-pi-gateway/RECEIPT_ROUTING.md#중앙-명령-영수증-정산)
- 빈 자리 한 개·두 개, 공간 회복과 재시작 후 중복 등록 방지를 다루는 회귀시험 소스를 추가했다. 공통 SQLite 용량 상한이 적용된다. 빌드·회귀시험·실제 Pi 연동은 미실행이다. 두 서버와 Pi의 실제 영수증 대조 및 제작 PCB 검증이 남아 있다.

소스 commit `2e0d5607ee7b679012ecea45aa8274a17057b19d`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `8312341..2e0d560`다. goal은 active/progress다.

## 2026-11-11 — Mobius4 장애 중 정기 상태 보고 적재 제한

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10. 직전 goal turn은 SQLite 영수증 등록을 분리한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 중앙 관측 보관, CORE ACK와 웹 수용 경계를 확인했다.

- Gateway `0.2.53`은 일반 상태 보고가 응답을 기다리면 새 정기 보고를 SQLite에 추가하지 않는다. 기존 본문·요청 ID·재시도 시각을 유지하고, 기다리는 동안의 새 보고는 `health_deferred_pending`으로 집계한다. 업그레이드 전 저장한 보고도 보존한다. 자격 상태 전환은 전용 저널과 순서에 따라 전달한다. [Gateway 통신 메모](../keyring/raspberry-pi-gateway/IO_NOTES.md)
- 재시작과 지연 중 본문 보존, 자격 전환·공용 컨테이너 관측과 동시 적재를 다루는 회귀시험 소스를 추가했다. 빌드·회귀시험·실제 Pi 연동은 미실행이다. Pi와 Mobius4의 실제 장애·복구 및 제작 PCB 검증이 남아 있다.

소스 commit `3f6864a71d03dd5568357ee1c9f23960c20aa177`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `34391f7..3f6864a`다. goal은 active/progress다.

## 2026-11-11 — 중앙 API 저장소를 SQLite에 연결

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10. 직전 goal turn은 Mobius4 장애 중 정기 상태 보고 적재를 제한한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 중앙 Gateway 인증서 수명주기, CORE 경로와 웹 영수증 매핑을 확인했다.

- Gateway `0.2.54`는 새 SQLite에 선택 설정 `PC_API_DEPLOYMENT_ID`를 binding v3로 기록한다. 다른 중앙 저장소 ID로 기존 DB를 지정하거나 ID를 빼면 쓰기·전송 전에 중단한다. 같은 중앙 저장소의 API 주소 변경은 기존 DB를 사용한다. 두 사전 검사는 네트워크 요청 전에 로컬 binding을 읽고, 보관본은 같은 ID를 담는다. [중앙 API 배포 전환](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#중앙-api-배포-전환)
- 주소 변경, 다른 배포 ID, 기존 DB의 ID 덧씌우기 거절과 보관본 격리를 다루는 회귀시험 소스를 추가했다. ID는 운영자 배정값이며 서버의 실제 인증은 mTLS와 중앙 정책을 따른다. 빌드·회귀시험·배포 전환·실제 Pi 연동은 미실행이다.

소스 commit `ed770bf0bb50fd08e2091ab185c810b9d1fd3a9a`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `6fa4e31..ed770bf`다. goal은 active/progress다.

## 2026-11-11 — Mobius4 관측 컨테이너 자원 ID 고정

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10. 직전 goal turn은 중앙 API의 DB 연결을 고정한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 중앙의 CSE 자원 ID 검증과 CORE·웹 자원 경로 계약을 확인했다.

- Gateway `0.2.55`의 선택 설정 `M2M_OBSERVATION_CONTAINER_RI`는 새 DB의 관측 컨테이너를 실제 `ri`에 묶는다. HTTPS 이름 조회가 일치할 때만 MQTT 또는 HTTPS로 해당 ID에 전송하며, 저장본의 부모·자원 ID·본문을 대조한다. 같은 이름이 다른 자원에 배정되면 SQLite가 원래 관측을 보존한다. 명령 사전 검사에서도 설정된 관측 ID를 대조한다. [관측 컨테이너 ID 고정](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#관측-컨테이너-id-고정)
- 이름 재사용, 전송 전환과 readback, DB 재시작·사전 검사 및 HTTPS 보류를 다루는 회귀시험 소스를 추가했다. 실제 배포의 관측 컨테이너 ID와 Gateway 권한이 필요하다. 빌드·회귀시험·Mobius4/Pi 실물 연동은 미실행이다.

소스 commit `aff5ac29b7798f73bf420453f8a54cf11b83b7a5`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `a2a15bd..aff5ac2`다. goal은 active/progress다.

## 2026-11-11 — 격리 관측 ID를 PC와 Pi 설정에 연결

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10. 직전 goal turn은 Gateway의 관측 자원 ID를 고정한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 중앙의 CSE 자원 조회와 CORE·웹 경로 계약을 확인했다.

- PC 준비 도구의 `-PinObservationRoute`는 기존 `command-observations-a`의 `ri`를 읽고 격리 프록시에 `gw-a`의 이름 GET과 해당 `ri`의 POST 규칙을 추가하도록 구성했다. 이전 `ri`와 다르면 갱신을 중단한다. 새 Pi 프로필은 `--observation-container-ri`와 선택형 `--pc-api-deployment-id`를 Gateway 환경으로 전달한다. [Pi 명령 세션](../keyring/raspberry-pi-gateway/TESTING.md#pi-명령-세션)
- ID 전달과 잘못된 ID를 다루는 회귀시험 소스를 추가했다. 빌드·회귀시험·PC 프로비저닝·격리 프록시 갱신·Pi 실행은 미실행이다. `gw-a` 권한과 `gw-b` 교차 차단, Pi→Mobius4 저장 대조가 남아 있다.

소스 commit `a761eaac7945f90dd32bab633be83d920e840a56`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `2569d2e..a761eaa`다. goal은 active/progress다.

## 2026-11-11 — Pi 고정 컨테이너와 Mobius4 관측 증거 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R05. 직전 goal turn은 PC·Pi의 격리 관측 ID 설정을 연결한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 중앙의 관측 수용 이벤트와 CORE·웹 자원 경로 계약을 확인했다.

- 새 ON/OFF 시험은 각 명령 전후의 Mobius4 관측에 인스턴스 유형·이름·자원 ID·부모 ID를 기록한다. Pi DB에 관측 ID가 고정돼 있으면 대조 도구는 모든 부모 ID, 장치·부팅·순번에서 계산한 이름, 해당 요청의 outbox 잔류 여부를 검사한다. 이전 비고정 세션의 관측 컨테이너 검증 결과는 `null`이다. [시험 결과 대조](../keyring/raspberry-pi-gateway/TESTING.md#최신-중앙-api의-시험-결과-대조)
- 다른 부모, 다른 이름·타입, 기록 누락과 대기열 잔류를 다루는 회귀시험 소스를 추가했다. 빌드·회귀시험·증거 도구 실행·실제 Pi–Mobius4 연동은 미실행이다.

소스 commit `e12a8ecf516f4fb764fffad51a283868f09d4319`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `b7ced7e..e12a8ec`다. goal은 active/progress다.

## 2026-11-11 — Mobius4 원본 관측과 중앙 수용 본문 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R05, R15. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 중앙 수용 이벤트가 전체 관측의 `approvalHash`를 기록하고 Pi가 같은 관측 본문을 Mobius4와 중앙 API에 각각 제출하는 것을 소스에서 확인했다.

- PC 격리 시험은 준비된 팀 소스의 해시 함수를 사용해 ON/OFF 직후의 Mobius4 관측을 해시한다. 중앙 수용 이벤트 두 건의 본문 해시와 일치할 때만 본문 대조를 성공으로 보고한다. 시험 기록에는 원본 본문을 추가하지 않는다. [시험 결과 대조](../keyring/raspberry-pi-gateway/TESTING.md#최신-중앙-api의-시험-결과-대조)
- 기존 0.2.0 실물 시험에서 사용자가 LED 변화가 없었다고 확인한 상태를 유지한다. 0.2.1의 1.54인치 화면 `CMD ON`과 `CMD OFF`는 실물 확인이 남았다. 이번에는 회귀시험 소스만 추가했고 빌드·시험·플래시·Pi 실행은 하지 않았다.

소스 commit `35f9f77a4330713b8a7c2a4e33c240ba2dcf939c`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `7eef6b5..35f9f77`이다. goal은 active/progress다.

## 2026-11-11 — Feather OFF 뒤 중앙 관측 수용 기록

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R05, R15. 직전 goal turn은 본문 해시 대조를 추가한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 팀 API가 수용 이벤트를 커밋된 상태 파일에 함께 기록하는 경로를 확인했다.

- PC 시험 도구는 OFF 적용과 단계 grant 회수 뒤 `led-cycle.json`을 저장하고 두 관측의 중앙 수용 이벤트를 기다린다. ON/OFF의 본문 해시와 수용 순서가 맞으면 명령·관측·이벤트 ID와 해시를 `central-telemetry.json`에 저장한다. 수용 대기가 중단되면 기존 시험 기록을 보존한다. [시험 결과 대조](../keyring/raspberry-pi-gateway/TESTING.md#최신-중앙-api의-시험-결과-대조)
- 지연 도착과 해시 불일치를 다루는 회귀시험 소스를 추가했다. 빌드·회귀시험·도구 실행·Feather 플래시와 최신 Pi 실물 시험은 미실행이다.

소스 commit `10a3721f400f5ae5ef7b8aa24032cfc876782113`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `80398a0..10a3721`이다. goal은 active/progress다.

## 2026-11-11 — 중앙 API Retry-After 동안 Pi 대기열 유지

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10, R15. 직전 goal turn은 OFF 뒤 중앙 수용 기록을 추가한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 팀 중앙 관측 수용과 CORE·웹의 재전송 경계를 확인했다.

- Gateway `0.2.56`은 중앙 API의 `Retry-After` 동안 새 중앙 전송을 선택하지 않아 기존 행의 시도 횟수와 예약 시각을 보존한다. 새 명령 영수증은 SQLite 명령 저널에 남고 대기가 끝나면 등록한다. 별도 Mobius4 origin은 전송할 수 있고, 신뢰 가능한 시계로 만료된 중앙 관측은 계속 정리한다. origin 대기 자체는 현재 프로세스의 기존 메모리 상태를 사용한다. [중앙 관측 전달](../keyring/raspberry-pi-gateway/IO_NOTES.md#중앙-관측-전달)
- 중앙 보류 및 해제, 시도 횟수 보존, 만료와 Mobius4 전송을 다루는 회귀시험 소스를 추가했다. 빌드·시험·Pi 실행 및 Feather 0.2.1 화면 검증은 미실행이다.

소스 commit `6ff3fc1cbb99c107c5a5c377c8ffda63d6a9a9ce`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `315c0f0..6ff3fc1`이다. goal은 active/progress다.

## 2026-11-11 — Pi 데몬 재시작 후 HTTPS Retry-After 복원

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10. 직전 goal turn은 중앙 API 보류 중 대기열 보존을 구현한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 팀 중앙 관측의 중복 처리와 CORE의 HTTPS/MQTT 및 ACK 경계를 확인했다.

- Gateway `0.2.57`은 서버 호스트·포트별 `Retry-After` 대기 종료를 현재 Linux 부팅 ID와 함께 SQLite에 저장한다. 같은 부팅에서 데몬을 재시작하면 남은 시간을 이어받고, 새 Pi 부팅에서는 지난 부팅의 대기를 정리한다. 기존 SQLite는 시작할 때 테이블이 추가된다. 새 테이블을 추가한 DB는 0.2.56 이하의 스키마 검사에서 거절된다. [SQLite 복구](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md)
- SQLite 재개, 다른 포트, 기한 만료와 새 Linux 부팅을 다루는 회귀시험 소스를 추가했다. 빌드·시험·기존 DB 마이그레이션 실행·Pi 및 Feather 실물 시험은 미실행이다.

소스 commit `5a3248e167f86f5f3b54798831ada69a8e827380`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `320f482..5a3248e`다. goal은 active/progress다.

## 2026-11-11 — r18 USB 초기 구동 기록 재출력

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R05. 직전 goal turn은 Pi의 HTTPS 재시도 대기 복원을 구현한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 팀 관측 schema의 장치 ID·펌웨어 revision과 CORE Gateway 관측 계약을 확인했다.

- `keyring-0.7.15-bringup`은 부팅 때 읽은 GPIO와 첫 센서 상태를 보존한다. USB 모니터에서 `?`를 보내면 보드를 재부팅하지 않고 같은 초기 기록을 재출력한다. Gateway `0.2.58`은 같은 줄의 반복을 허용하며 다른 부팅 ID, 바뀐 값이나 잘린 줄을 거절한다. BLE 시험의 허용 revision과 첫 구동 절차를 갱신했다. [r18 첫 구동](../keyring/pcb/BRING_UP.md)
- 구버전의 단일 기록, 동일 재출력, 다른 부팅·출력값·잘린 줄을 다루는 회귀시험 소스를 수정했다. 빌드·회귀시험·플래시·USB/BLE 실물 확인은 미실행이다.

소스 commit `cb3675afdc4728cca8d7b68bd9b2e125fc9aaa3b`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `a2ac3e5..cb3675a`다. goal은 active/progress다.

## 2026-11-11 — r18 초기 USB와 마지막 BLE 센서 상태 기록

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R05, R15. 직전 goal turn은 r18의 USB 기록 재출력을 추가한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 팀 관측 schema와 CORE 전송 경계를 확인했다.

- Gateway `0.2.59`의 초기 구동 보고서는 USB 첫 센서 상태, 첫 정상 BLE 관측 순번, 같은 세션의 마지막 센서·INA219 상태를 보존한다. 정상 관측 뒤 마지막에 확인된 센서 또는 INA219 오류는 `MISMATCH`다. 마지막 관측값이 빠지면 `INSUFFICIENT`다. USB 초기 센서 오류 뒤 BLE가 복구된 경우는 두 시점의 값을 모두 남긴다. [r18 초기 구동 기록](../keyring/raspberry-pi-gateway/TESTING.md#r18-초기-구동-기록)
- 회귀시험 소스를 추가했다. 빌드·회귀시험·USB/BLE 실물 캡처와 별도 전원 레일 실측은 미실행이다.

소스 commit `3815c184f4bcb5abbddb462fde2fc4a51bda4d4b`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `f0dc0ba..3815c18`이다. goal은 active/progress다.

## 2026-11-11 — r18 실물 명령 한 건을 같은 부팅과 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01, R02, R03, R05. 직전 goal turn은 r18 초기·최종 센서 증거를 보강한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. CORE의 ACK/readback 경로, 팀 receipt의 boot ID·시간 필드와 r18 펄스 상한을 확인했다.

- Gateway `0.2.60`의 `bubble-keyring-reconcile --same-boot-command`는 정확한 명령 ID, 수집 boot ID, 보드·펌웨어 revision을 대조한다. 보고서는 장치 저널의 수신·적용 uptime과 Pi ACK, Mobius4 원본 영수증 대조 결과를 남긴다. r18의 펄스 길이와 소등 시점은 계측기로 따로 기록한다. [r18 실물 명령 한 건 대조](../keyring/JOURNAL_RETENTION.md#r18-실물-명령-한-건-대조)
- 같은 부팅, 명령 누락, 다른 부팅·revision, 영수증 펌웨어 불일치를 다루는 회귀시험 소스를 추가했다. 빌드·회귀시험·Mobius4 조회·Pi 및 r18 실물 시험은 미실행이다.

소스 commit `5a72c9408c1af2bfc288fceae20e76032606382e`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `4efbc5a..5a72c94`다. goal은 active/progress다.

## 2026-11-11 — r18 최초 적용과 격리 중앙 정산 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01, R03, R05. 직전 goal turn은 r18 단일 명령의 동일 부팅 대조를 추가한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 팀 receipt 계약과 격리 CSE 원본 결속을 확인했다.

- 격리 PostgreSQL 조회는 r18 단일 명령의 ID·보드·펌웨어·부팅 일치·적용 uptime과 ACK를 검증하고 결과에 보존한다. 중앙 정산과 Pi 전달이 일치하고 ACK가 `APPLIED`일 때만 `originalApplicationMatched`가 참이다. `DUPLICATE`가 중앙 정산과 일치하면 최초 적용 확인은 검토로 남는다. [정산 조회](../keyring/JOURNAL_RETENTION.md#격리-postgresql-정산-기록-대조)
- 명령 ID·시각·readback 변형, 중복 ACK·미전달·정산 누락을 다루는 회귀시험 소스를 추가했다. Gateway 패키지 revision은 `0.2.60`이다. 빌드·회귀시험·PostgreSQL 조회·Pi 및 r18 실물 시험은 미실행이다.

소스 commit `38917ff6970f27372be0f1d00715bdd7b110197c`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `9bda0e7..38917ff`다. goal은 active/progress다.

## 2026-11-11 — r18 명령을 최신 중앙 API 상태와 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01, R02, R03, R05. 직전 goal turn은 격리 PostgreSQL의 최초 적용 대조를 보강한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 팀 API의 명령·영수증과 실행 시작·정산 이벤트 계약을 확인했다.

- Gateway `0.2.61`에서 r18 단일 명령 비교에 `--team-state`를 추가했다. 장치·Pi·Mobius4 기록이 먼저 일치하면 중앙 상태 사본에서 정확한 발급 명령·영수증 본문·claim·실행 시작·정산과 시각을 대조한다. Feather 최신 API 시험의 같은 비교 코드를 재사용하며, 보고서에는 두 이벤트 ID와 상태 사본 SHA-256을 보존한다. [최신 중앙 API 상태 대조](../keyring/JOURNAL_RETENTION.md#최신-중앙-api-상태-대조)
- 회귀시험 소스를 추가했다. 격리 명령 발급 프로필의 r18 등록, 빌드·회귀시험·CSE 조회·r18/Pi 실물 명령과 물리 계측은 미실행이다.

소스 commit `b9cbb06ba84f63bd17a5f413a12bb4ea87ef9a1d`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `2a9edb8..b9cbb06`이다. goal은 active/progress다.

## 2026-11-11 — r18 격리 중앙 API·Mobius4·Pi 등록 프로필

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01, R02, R03, R10. 직전 goal turn은 최신 중앙 API 상태와 r18 명령의 대조를 추가한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 중앙 등록의 인증서·장치·시험 주체 결속과 CORE 관측 경로를 확인했다.

- 격리 API의 `r18` 프로필은 `8789`, 별도 상태 디렉터리, `gw-b` 인증서와 `keyring-r18-lab`을 사용한다. Mobius4 준비 스크립트는 B 전용 관측·상태 컨테이너와 관측 ID를 준비할 수 있다. [r18 격리 명령 API](../keyring/dev/mobius4/README.md#r18-격리-명령-api)
- Pi Gateway `0.2.62`와 시험 프로필은 중앙 기능 응답의 Gateway·장치·보드·펌웨어를 확인하고 BLE identity에서도 지정한 보드 revision을 확인한다. 명령 펌웨어 `keyring-0.7.14`만 허용한다. 회귀시험 소스를 추가했다. 실제 배치·키 발급·CSE 권한 확인·빌드·시험·Pi 및 r18 실물 실행은 미실행이다. [Pi r18 명령 세션](../keyring/raspberry-pi-gateway/TESTING.md#r18-pi-명령-세션)

소스 commit `2fec0b4164361e1641af109083f2babb2934c92c`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `a3ec3cd..2fec0b4`다. goal은 active/progress다.

## 2026-11-11 — r18 격리 진동 명령 한 건 발급 도구

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01, R02, R03, R05, R10. 직전 goal turn은 r18 격리 등록 프로필을 추가한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 팀 명령 기한·현재 grant·실행 시작·정산과 CORE ACK/readback 경계를 확인했다.

- PC의 r18 단일 펄스 도구는 현재 부팅·출력 OFF·fault 없음과 Pi 명령 준비를 확인한 뒤 작업자의 `PULSE` 입력을 기다린다. 의도를 저장하고 명령을 한 건 발급한다. 원본 영수증, 중앙 실행 시작·정산, 같은 부팅·컨테이너의 더 새 OFF 관측과 grant 회수를 기록한다. 발급 응답이 끊기면 기존 ID로 증거를 이어 간다. [r18 단일 펄스 시험](../keyring/raspberry-pi-gateway/TESTING.md#r18-단일-펄스-시험)
- 성공·발급 응답 유실·작업자 중단 회귀시험 소스를 추가했다. Gateway 패키지 revision은 `0.2.62`다. 빌드·회귀시험·서버 실행·실물 명령 및 펄스 계측은 미실행이다.

소스 commit `5011fb98c404bb98a3c28af2145abef2d63065d7`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `ffeaad7..5011fb9`다. goal은 active/progress다.

## 2026-11-11 — r18 임시 서버의 실제 PC 루프백 준비

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10. 직전 goal turn은 작업자가 시작하는 단일 펄스 도구를 추가한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 고정 팀 소스와 잠금 파일을 재사용했다.

- r18 API의 별도 디렉터리에 운영자 인증서를 준비하고 고정 의존성 63개를 pnpm 캐시에서 설치했다. `127.0.0.1:8789`에서 `gw-b` mTLS 기능 조회, `ACTIVE` 자격과 활성 명령 0건을 확인했다. 해당 루프백 프로세스는 실행 중으로 남겼다.
- 기존 격리 Mobius4에 `command-observations-b`와 `command-health-b`를 만들고 관측 pin을 등록했다. 기존 TLS 컨테이너에서 두 B 경로와 관측 pin include만 반영해 설정 검사와 reload를 수행했다. B 관측·영수증 조회 성공, A→B 및 B→A 교차 조회 403, 기존 Feather API 응답을 확인했다. [PC 배치 증거](../keyring/evidence/2026-11-11-scoped-r18-enrollment/provisioning.json)
- 일반 빌드·회귀시험·Pi 접속·BLE·실물 명령·펄스 계측은 미실행이다. 실제 Pi에서 Gateway B TLS 파일, loopback 전달과 r18 장치 연결이 남아 있다.

배치 증거 commit `5369fe34031467ed570bf0f3eaf007d086238c07`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `eb1b4f6..5369fe3`다. goal은 active/progress다.

## 2026-11-11 — r18 Pi 세션 설정으로 시험 증거 보관

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01, R02, R03, R05. 직전 goal turn은 r18 PC API와 Mobius4 격리 경로를 실제 배치한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같다. 장치 저널 identity와 CORE ACK/readback 경계를 확인했다.

- Pi 세션 런처에 `export-env`와 `capture-r18`을 추가했다. 기존 세션 설정에서 보관·대조에 필요한 `gateway.env`를 소유자 전용으로 만들며 기존 파일을 보존한다. 장치 저널 캡처는 같은 시험 잠금을 이어받고 정확한 r18 보드·펌웨어를 확인한다. SQLite snapshot과 최신 중앙 정산 대조를 같은 세션으로 연결했다. [Pi 시험 증거 보관](../keyring/raspberry-pi-gateway/TESTING.md#r18-pi-시험-증거-보관)
- Gateway `0.2.63`의 내보내기·잠금·실행 인자 회귀시험 소스를 추가했다. 빌드·회귀시험·Pi 접속·저널 캡처·실물 시험은 미실행이다.

소스 commit `847492ba68d74ccf9b7a8bc10913828e5fe5fcd3`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `551278f..847492b`다. goal은 active/progress다.

## 2026-11-11 — Feather 화면 확인 절차와 중단된 r18 명령 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01, R02, R03, R05. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다.

- Feather 0.2.0 ON/OFF의 기존 실물 시험에서 GPIO 읽기값과 Mobius4 영수증·중앙 정산이 일치했고 사용자는 LED 변화를 보지 못했다. 1.54인치 ST7789에서 Feather 0.2.1의 `CMD ON`과 `CMD OFF`를 읽는 절차를 보강했다. 새 펌웨어 설치와 화면 실물 확인은 대기 중이다. [Feather 화면 확인](../keyring/raspberry-pi-gateway/TESTING.md#기존-scoped-mobius4에서-feather-led-시험)
- Gateway 0.2.64는 r18 발급 응답이 끊겨도 저장한 명령 ID와 요청 해시로 중앙 상태·선택한 Pi DB 사본·확보한 CSE 영수증을 대조한다. 발급, 실행, 정산이 각 사본에 어디까지 남았는지 기록한다. [중단 증거 대조](../keyring/raspberry-pi-gateway/TESTING.md#중단된-r18-펄스-시험-대조)
- Gateway 로컬 190개, 격리 벤치 모의 25개, wheel 빌드와 합성 입력 CLI 확인을 통과했다. 첫 로컬 실행에서 기존 Retry-After 모의 설정에 요청 제한 시간이 빠져 실패했고, 모의 설정을 보완한 뒤 전체를 다시 실행했다. Pi·BLE·실물 실행은 미수행이다.

소스 commit `8cf9a32d0d842833c65bc678d5fd45f92ddc2ba5`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `4abb167..8cf9a32`다. goal은 active/progress다.

## 2026-11-11 — r18 격리 명령 시험의 Mobius4 컨테이너 고정

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01~R03, R05. 직전 goal turn은 Feather 화면 시험과 r18 중단 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`는 직전과 같으며 중앙 발급·실행 및 CORE 영수증 경계를 확인했다.

- Gateway 0.2.65의 r18 Pi 세션은 관측·영수증 컨테이너 ID 두 개를 요구한다. PC 벤치는 health ID까지 받아 관측·health·영수증의 부모를 대조한다. 영수증 경로 자체도 준비 신호와 명령 발급 전에 조회한다. 새 증거는 `pulse-scope.json`에 ID를 저장하며, 이전 증거는 고정 ID가 없다고 표시한 채 읽는다. [r18 시험 절차](../keyring/raspberry-pi-gateway/TESTING.md#r18-단일-펄스-시험)
- 격리 Mobius4 bootstrap의 r18 모드가 health 컨테이너 ID를 출력하도록 변경했다. 관측·영수증 ID는 기존 고정 경로 출력에서 인수한다. [격리 서버 준비](../keyring/dev/mobius4/README.md#r18-격리-명령-api)
- health·영수증 경로 교체, 잘못된 부모 영수증과 Pi SQLite를 다루는 회귀시험 소스를 추가했다. 이번에는 빌드·시험·정적 분석·서버 설정 실행·Pi 접속·BLE·실물 시험을 수행하지 않았다.

소스 commit `41dfc0592ccb49f9c45c5cd61f13e877e842bdd3`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `8ea6a6f..41dfc05`다. goal은 active/progress다.

## 2026-11-11 — r18 펄스 이후 OFF 관측의 중앙 수용 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01~R03, R05. 직전 goal turn은 r18 Mobius4 컨테이너 고정을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀 중앙 수용 이벤트의 식별자 계산, 본문 해시와 중앙 순번 필드를 읽었다.

- Gateway 0.2.66의 격리 r18 벤치는 grant 회수 뒤 Mobius4의 후속 OFF 관측을 고정된 팀 API 해시 함수로 계산해 `GATEWAY_TELEMETRY_ACCEPTED`에 대조한다. 중앙 응답이 늦어져도 먼저 저장한 펄스 결과와 관측 해시를 남긴다. 중앙 상태 사본으로 뒤늦게 대조할 수 있다. [r18 시험](../keyring/raspberry-pi-gateway/TESTING.md#r18-단일-펄스-시험)
- 중앙 수용 지연, 본문 해시 불일치, 권한 회수 뒤 대조를 다루는 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·Pi 접속·BLE·실물 펄스 및 실제 중앙 수용 확인은 미수행이다.

소스 commit `1899c00a420825642118a67ba4663f894819c1a2`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `c1baf6e..1899c00`다. goal은 active/progress다.

## 2026-11-11 — r18 장치 저널과 저장한 Mobius4 영수증의 오프라인 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01~R03, R05. 직전 goal turn은 펄스 뒤 OFF 관측의 중앙 수용 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. CORE의 실제 ACK/readback 증거와 통합 API의 중앙 정산 이벤트 필드를 확인했다.

- Gateway 0.2.67의 r18 벤치는 CSE 영수증 사본에 CIN 이름·유형을 추가한다. `journal_reconcile --native-receipt`는 같은 부팅의 명령 ID에서 계산한 자원 이름과 Pi 설정의 부모 ID를 대조한 뒤, 장치 저널·Pi SQLite 보관본·CSE 영수증을 네트워크 없이 비교한다. 지정한 중앙 상태 사본과도 대조하며 결과에 사용한 영수증 사본의 SHA-256을 기록한다. [오프라인 대조](../keyring/JOURNAL_RETENTION.md#저장한-mobius4-영수증으로-오프라인-대조)
- 새 영수증의 오프라인 비교, CSE 부모·이름 교체와 본문 불일치를 다루는 회귀시험 소스를 추가했다. 장치 저널 시험 데이터가 다른 명령으로 중앙 사본을 덮어쓰는 부분도 수정했다. 빌드·시험·정적 분석·Pi 접속·BLE·실물 검증은 미수행이다.

소스 commit `fa6d5abed463794a23c98f6fe0d6fd7fddba9de1`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `09c7904..fa6d5ab`다. goal은 active/progress다.

## 2026-11-11 — r18 ST7789·JD9853 화면 점검 프로필

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R05. 직전 goal turn은 장치 저널과 저장한 Mobius4 영수증의 오프라인 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 중앙 관측 계약의 sensorValues와 기존 CORE Gateway 계약을 대조했다.

- ST7789와 JD9853를 각각 선택하는 r18 관측 전용 프로필을 추가했다. 버튼으로 켜는 백라이트에서 테두리·RGB 막대·패널 이름·크기와 마지막 버튼을 표시한다. BLE 명령·저널·오디오 재생·SD·deep sleep은 비활성화하며, USB 초기 출력과 패널 선택값을 보관한다. [제작 PCB 화면 점검](../keyring/pcb/BRING_UP.md#화면만-연결한-두-번째-구동)
- Gateway 0.2.68은 USB 패널 값과 펌웨어 revision을 대조하고 같은 부팅의 Pi 보고서에 기록한다. 화면 자체는 육안 확인이 필요하며 구매 JD9853의 초기화·색·크기는 미확인이다. 회귀시험 소스는 추가했으며 빌드·시험·정적 분석·flash·Pi·실물 구동은 미수행이다.

소스 commit `0990c21e31b7e984cd11f9b25b344c5be5f9250c`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1fa3041..0990c21`다. goal은 active/progress다.

## 2026-11-11 — r18 INA219와 외부 계측값 연결

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R05. 직전 goal turn은 두 LCD 점검 프로필을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 중앙 `sensorValues` 계약과 로컬 INA219 부하 측 계측 정의를 대조했다.

- Gateway 0.2.69의 Pi 기록은 USB와 같은 부팅의 첫 BLE 세션에서 INA219 순번·계측 uptime을 표시한다. 오프라인 도구는 운영자 계측 파일을 정확한 Pi 캡처와 샘플에 연결한다. 3.3V 부하 측의 차이만 계산하며 USB 입력·배터리 단자 값은 측정 지점과 함께 기록한다. [외부 계측값 연결](../keyring/raspberry-pi-gateway/TESTING.md#r18-첫-구동의-외부-계측값-연결)
- 캡처 해시, 다른 세션·다른 샘플, 측정 지점별 계산을 다루는 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·Pi 접속·BLE·실물 전원 계측은 미수행이다.

소스 commit `e9f8a41f07ca6b4d8073204e30671a3e32c2a853`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `355b1aa..e9f8a41`다. goal은 active/progress다.

## 2026-11-11 — r18 첫 구동의 Pi 관측 전용 전송

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03. 직전 goal turn은 INA219와 외부 계측값 연결을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 중앙 텔레메트리 수용의 Gateway·장치 등록과 관측 스키마 검사를 확인했다.

- Gateway 0.2.70에서 `--observe-only` r18 Pi 세션을 추가했다. 첫 구동 및 두 LCD 점검 펌웨어 중 하나를 고정하고 기존 `gw-b` mTLS·컨테이너로 Mobius4 관측·health와 중앙 텔레메트리를 전송한다. 명령 조회·실행·장치 명령 영수증을 중지하고 기존 대기 행을 보존한다. [Pi 관측 전용 세션](../keyring/raspberry-pi-gateway/TESTING.md#r18-pi-관측-전용-세션)
- 명령 목록을 읽지 않는 사전 확인, 명령 작업 중지, 기존 영수증 보존과 관측 전달의 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·Pi 접속·BLE·실제 관측 전달 및 중앙 수용 확인은 미수행이다.

소스 commit `98b5ad988af171329e226ecdedf4aef29245ec9c`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `229a881..98b5ad9`다. goal은 active/progress다.

## 2026-11-11 — r18 관측 전용 전송 증거 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03. 직전 goal turn은 관측 전용 Pi Gateway 세션을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`의 현재 계약을 확인했다. 중앙 텔레메트리 수용의 관측 ID·본문 해시·시각을 적용했다.

- Gateway 0.2.71의 r18 도구는 USB와 같은 부팅의 최신 Mobius4 관측·health를 읽어 고정 컨테이너와 명령 비활성 상태를 확인한다. 저장한 Pi SQLite의 마지막 순번과 해당 전송 대기 여부를 대조하고, Mobius4 본문의 팀 해시가 중앙 수용 이벤트에 남았는지 확인한다. 중앙 사본에 이벤트가 없으면 대기 상태를 출력한다. [관측 전달 증거 대조](../keyring/raspberry-pi-gateway/TESTING.md#관측-전달-증거-대조)
- 중앙 수용 지연, 본문 해시 불일치, 다른 부팅·부모 컨테이너를 다루는 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·Pi 접속·BLE·실제 관측 전달과 중앙 수용 검증은 미수행이다.

소스 commit `cf9b7e48d65729a471174b47e8a9857d3166edd7`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1fc4360..cf9b7e4`다. goal은 active/progress다.

## 2026-11-11 — r18 BLE 관측과 팀 위치 조회 응답 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03. 직전 goal turn은 USB·Pi·Mobius4·중앙 텔레메트리 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 위치 BFF 구현은 통합 main에 있고 원격에서 별도 앱 브랜치는 확인되지 않았다.

- Gateway 0.2.72의 r18 캡처에 RSSI 필수 선택을 추가했다. 중앙 위치 API와 LIVE 웹 BFF의 저장 응답에서 같은 기기·Gateway·시각·RSSI·모의 표시를 대조한다. 접근 범위, 조회 만료와 웹 출처를 확인하며 현 격리 명령 API와 별도로 승인된 팀 포털 배치가 필요하다. [중앙 위치 API와 웹 응답 대조](../keyring/raspberry-pi-gateway/TESTING.md#중앙-위치-api와-웹-응답-대조)
- 권한 거절·만료·다른 RSSI·혼합 출처를 다루는 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·Pi 접속·실제 포털 조회·웹 렌더링·별도 앱은 미확인이다.

소스 commit `c21acb88e623cc5d71b382136095281a62b36103`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `36c9bd9..c21acb8`다. goal은 active/progress다.

## 2026-11-11 — 격리 r18 위치 승인·조회·회수

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10. 직전 goal turn은 BLE 관측과 위치 응답 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 팀의 위치 consent·grant·진행 중 사건·수신자별 lease 계약을 적용했다.

- 격리 PC r18 프로필에 선택형 위치 시험 경로를 추가했다. 기존 시험 보호자 인증서, r18 장치 한 개와 최대 60초 lease로 범위를 제한한다. PC 도구는 같은 RSSI 관측의 중앙 위치 응답을 저장하고 lease·grant·consent 회수와 사건 종료 뒤 해당 장치가 조회에서 빠졌는지 다시 읽는다. [격리 위치 시험](../keyring/dev/mobius4/README.md#r18-격리-위치-시험)
- 수신자·기기 범위, 혼합 grant와 회수 전후 조회의 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·서버 시작·Pi 접속·실제 위치 조회는 미수행이다. 웹 OIDC와 앱 연동은 팀 배치가 필요하다.

소스 commit `318ef45b914c784587fd3c032cf051b36c883513`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `4ac2c4a..318ef45`다. goal은 active/progress다.

## 2026-11-11 — r18 Mobius4와 포털 위치 관측 동시 수집

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10. 직전 goal turn은 격리 r18 위치 승인·조회·회수를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 중앙 위치 API의 기기별 최신 관측과 통합 저장소의 스냅샷 교체 동작을 읽었다.

- Gateway 0.2.74는 격리 위치 시험 도구에서 Mobius4와 포털 응답을 병행 수집한다. 포털 조회 전후의 중앙 관측 ID가 유지된 응답을 선택하고, Mobius4의 동일 ID·시각·RSSI를 찾으면 두 파일을 함께 저장한다. 사전 캡처 파일을 사용하는 절차도 제공한다. [위치 응답 대조](../keyring/raspberry-pi-gateway/TESTING.md#중앙-위치-api와-웹-응답-대조)
- 조회 중 최신 관측 교체, 늦은 Mobius4 관측과 동일 시각·RSSI의 다른 ID를 다루는 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·서버 실행·Pi 접속·실제 응답 대조는 미수행이다.

소스 commit `fa149ec91d45e2ea8a5cad1043aa6375a9ac8a8a`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `a5f0551..fa149ec`다. goal은 active/progress다.

## 2026-11-11 — 임시 Mobius4에서 팀 서버로 전환하기 전 Pi 상태 확인

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R11, R12. 직전 goal turn은 r18 위치 관측 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 CORE Gateway·중앙 영수증 계약을 확인했다.

- Gateway 0.2.75의 `bubble-gateway-state plan-cutover`는 독립적으로 읽은 환경 파일 두 개와 원본 SQLite binding을 대조한다. 같은 binding의 기존 DB 재사용과 변경된 binding의 새 DB 경로를 판별하고, DB·WAL·SHM·journal이 남아 있는 새 경로를 거절한다. [전환 전 대기열 확인](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#전환-전-대기열-확인)
- native·CORE·중앙 outbox, 수신·dispatch 명령, outbox 등록 전 영수증과 미전달 credential 영수증을 집계한다. 저장소 주소와 배포 ID의 실제 동일성, 기존 큐와 명령의 정산, 팀 저장소의 인증·권한 및 Pi 전환은 현장 확인이 남았다. DB 경로 변경과 committed WAL을 다루는 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·도구 실행·Pi 접속·배포 전환은 미수행이다.

소스 commit `a0e4819564ec22d90c0fad3d3747aad7feb09358`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `2161057..a0e4819`다. goal은 active/progress다.

## 2026-11-11 — 배포 전환 시 비활성 CORE 경로의 큐 보존

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R11, R12. 직전 goal turn은 배포 전환 전 SQLite 집계를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 CORE 전송 계약을 확인했다.

- Gateway 0.2.76은 CORE 브리지가 비활성화된 동안 기존 CORE telemetry·ACK를 선택하지 않는다. SQLite에 기존 행과 시도 횟수를 보존하고 native 전송을 계속한다. 브리지를 다시 켰을 때는 현재 epoch에 해당하는 telemetry와 활성 명령 경로의 ACK를 선택한다.
- `plan-cutover`는 기존 DB 재사용 시 브리지·명령·중앙 전송 설정과 CORE epoch에 의해 보류될 건수를 보여준다. daemon과 같은 epoch 선택 조건을 사용한다. 두 모드 전환, native 전송 유지, 이전 epoch 및 비활성 중앙 경로의 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·도구 실행·Pi 접속·배포 전환은 미수행이다. [전환 절차](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#전환-전-대기열-확인)

소스 commit `426d9c5f57ce2a2a32f06d061c80dd680d4d1d96`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `601ef7a..426d9c5`다. goal은 active/progress다.

## 2026-11-11 — 배포 전환 뒤 기존 Gateway·키링 명령 보관본 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R11, R12. 직전 goal turn은 비활성 경로의 큐 보존을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 dispatch-start·명령 정산 계약을 확인했다.

- Gateway 0.2.77의 전체 기기 저널 비교는 키링 보관본에 없는 같은 기기의 RECEIVED·DISPATCHING 명령과 미전달 native·중앙 영수증을 추린다. 상세 목록은 최대 128건, 별도 건수에는 전체 일치 건을 기록한다. 키링에 기록이 없다는 사실만으로 실행 여부나 중앙 정산을 확정하지 않는다.
- `--archive-only`는 원래 배포 환경 파일로 격리 SQLite binding을 확인하고 키링 저널과 로컬 영수증을 비교한다. TLS 파일과 서버 연결 없이 처리하며 native 영수증은 미확인으로 남긴다. Pi에만 남은 명령, 독립 중앙 영수증, 기기 범위와 미접속을 다루는 회귀시험 소스를 추가했다. 빌드·시험·도구 실행·Pi 접속·서버 전환은 미수행이다. [보관본 대조 절차](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#기존-배포의-명령과-키링-저널-대조)

소스 commit `50e26c6596d4549d2decec438cdc4ccbf728469e`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `5a1cf6a..50e26c6`다. goal은 active/progress다.

## 2026-11-11 — Pi에만 남은 명령의 기존 CSE 영수증 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R11, R12. 직전 goal turn은 Pi·키링 보관본 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 dispatch-start·명령 영수증 정산 계약을 확인했다.

- Gateway 0.2.78의 `--check-gateway-only-native`는 기존 환경 파일을 독립적으로 읽고 격리 보관본 binding과 기존 CSE의 영수증 컨테이너 ID를 확인한다. 키링 보관본에 없는 명령의 로컬 영수증을 원래 요청 ID의 CSE contentInstance와 대조하고 본문 해시·원본 ID·저장 시각을 기록한다.
- 로컬·CSE 영수증 누락과 본문 불일치를 별도로 표시하고, 일치한 행도 중앙 정산과 장치 근거를 확인할 목록에 남긴다. 정상·누락·다른 본문·다른 컨테이너를 다루는 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·실제 CSE 조회·Pi 접속·배포 전환은 미수행이다. [기존 CSE 대조 절차](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#기존-배포의-명령과-키링-저널-대조)

소스 commit `9b1cad8517b9c62c2a69f4a971441038e788b192`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `912c91f..9b1cad8`다. goal은 active/progress다.

## 2026-11-11 — Gateway 상태 보고의 Mobius4 자원 고정

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R10, R11, R12. 직전 goal turn은 Pi에만 남은 명령의 CSE 영수증 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 Gateway 전송 계약을 확인했다.

- Gateway 0.2.79는 `M2M_HEALTH_CONTAINER_RI`로 heartbeat와 credential 상태 전환 영수증을 같은 CSE 자원에 연결한다. SQLite와 snapshot에 ID를 기록하며 경로에 새 컨테이너가 생기면 원래 큐를 보류한다. 이름 조회, 자원 ID CREATE, 원본 재조회 순서와 HTTPS backoff를 기존 관측·명령 영수증 경로와 공유한다.
- 임시 Mobius4의 `-PinR18HealthRoute`와 새 Pi 세션의 `--health-container-ri`를 연결했다. DB binding 변경·공유 경로 충돌, preflight와 mock MQTT/CSE 재조회 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·ACL 적용·Pi 접속·서버 전환은 미수행이다. [상태 컨테이너 고정](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#gateway-상태-컨테이너-id-고정)

소스 commit `53d1e7658cdef779bade6a6d3cac58e40bdaf9b3`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1e26510..53d1e76`다. goal은 active/progress다.

## 2026-11-11 — r18 ST7789·JD9853 화면 패턴과 BLE 버튼 입력 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01, R02, R11. 직전 goal turn은 Gateway 상태 컨테이너 고정을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀 GATT 관측 계약을 확인했다.

- r18 화면 초기 구동 프로필 두 개를 0.7.16으로 올렸다. 화면 작업자가 CONFIRM/PANIC 패턴을 그렸을 때의 각 버튼 누계를 `health` 프레임에 보낸다. 무화면 초기 구동과 일반 명령 펌웨어의 revision 및 wire 필드는 유지한다.
- Gateway 0.2.80은 같은 BLE 세션의 버튼 누계와 마지막 화면 그리기 기록을 대조한다. 이전 USB 로그와 Pi 세션은 계속 읽을 수 있다. 프로필 불일치, 작업자·버스 오류, 누락과 잘못된 버튼 누계를 다루는 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·업로드·Pi 접속·실제 화면 확인은 미수행이다. [화면 초기 구동](../keyring/pcb/BRING_UP.md#화면만-연결한-두-번째-구동)

소스 commit `7a3875eb711fb000ae73b920814d75006c77c809`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `9e85efd..7a3875e`다. goal은 active/progress다.

## 2026-11-11 — r18 초기 구동 버튼과 화면 표시 요청의 동기화

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01, R02, R11. 직전 goal turn은 r18 화면 그리기 기록과 BLE 버튼 입력 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀 GATT 관측 계약을 확인했다.

- r18 화면 초기 구동 0.7.17은 버튼 상태와 표시 요청을 같은 잠금 안에서 기록하고 화면 작업자를 깨운다. 초기화가 아직 진행 중이면 요청을 보관한다. 준비된 작업자는 정기 갱신 기한을 기다리지 않고 새 상태로 그린다. 요청과 백라이트 활성 시 보드 fault를 확인한다.
- Gateway 0.2.81의 USB/BLE 기록과 격리 세션에 두 0.7.17 revision을 연결했다. 초기화 중 누름, 정기 상태 갱신과 요청 보존, 비상 버튼의 즉시 선택을 다루는 호스트 시험 소스와 USB 호환성 회귀 소스를 반영했다. 빌드·시험·정적 분석·업로드·Pi 접속·화면 확인은 미수행이다. [화면 초기 구동](../keyring/pcb/BRING_UP.md#화면만-연결한-두-번째-구동)

소스 commit `7f5510c2e445419901a0af7dcb2926c3a63cd61e`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `5f38663..7f5510c`다. goal은 active/progress다.

## 2026-11-11 — r18 LCD 실물 관찰과 Pi 버튼 해제 기록 연결

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01, R02, R05, R11. 직전 goal turn은 r18 화면 상태와 표시 요청 동기화를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 GATT·실물 증거 계약을 확인했다.

- Gateway 0.2.82의 `bubble-keyring-display-evidence`는 USB 부팅이 일치한 Pi 캡처에서 확인·비상 버튼 해제 순번을 대조하고, 작업자 화면 판독과 사진·영상의 해시를 같은 비공개 보고서에 기록한다. 화면 문구·패널 라벨·테두리·색 순서의 판독 결과와 BLE 그리기 결과는 각각 남긴다.
- 다른 캡처·부팅·세션, 해제 순번 오류와 같은 영상의 시간 역전을 다루는 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·실물 사진/영상·Pi 접속·도구 실행은 미수행이다. [화면 관찰 기록 연결](../keyring/raspberry-pi-gateway/TESTING.md#r18-화면-관찰-기록-연결)

소스 commit `74e13423638c5d8fa6958028b5d4befed5fb445a`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `b359917..74e1342`다. goal은 active/progress다.

## 2026-11-11 — BLE 재연결과 Pi 재시작 중 같은 부팅의 버튼 누계 보존

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R01, R02, R11. 직전 goal turn은 LCD 관찰과 Pi 버튼 해제 연결을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 Gateway의 순번·저장 계약을 확인했다.

- Gateway 0.2.83은 관측, outbox, 부팅별 확인·비상 버튼 누계를 같은 SQLite 트랜잭션에서 저장한다. 재연결과 Pi 재시작 뒤에도 같은 부팅의 더 높은 순번에서 누계가 역행하면 전송하지 않는다. 누계가 빠진 관측은 기존 값을 유지하고 새 부팅은 독립 누계를 받는다.
- 기존 DB는 새 열을 추가한 뒤 새 유효 관측부터 누계를 기록한다. 이전 버전이 관측 부팅을 갱신한 경우 다른 부팅에서 남은 누계는 사용하지 않는다. SQLite 업그레이드·재시작·BLE 재연결 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·실제 Pi 접속과 BLE 재연결·운영 DB 업그레이드는 미수행이다. [BLE 통신 메모](../keyring/raspberry-pi-gateway/IO_NOTES.md)

소스 commit `7c7c207a5ff48f238041bb09c36a13821c28bf42`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `f3db5f7..7c7c207`다. goal은 active/progress다.

## 2026-11-11 — BLE 관측 세션과 명령 영수증 구독 조건

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R11. 직전 goal turn은 BLE 재연결·Pi 재시작 후 버튼 누계를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 GATT 상태·명령·ACK 특성을 확인했다.

- Gateway 0.2.84는 r18 초기 구동이나 명령 쓰기가 없는 장치에서 관측 특성만 구독한다. 명령 쓰기가 있어도 알림 가능한 영수증 특성이 빠지면 관측을 유지하고 health에 원인을 남긴다. 명령 준비 상태는 같은 인증 세션에서 영수증 구독이 성공한 뒤에만 열린다.
- 캐시된 명령 특성, 영수증 특성 누락, 구독 실패, 정상 명령 구독을 다루는 회귀시험 소스와 기존 중앙 통합 fixture를 갱신했다. 빌드·시험·정적 분석·실제 Pi 접속·BlueZ 연결·실물 명령은 미수행이다. [BLE 통신 메모](../keyring/raspberry-pi-gateway/IO_NOTES.md)

소스 commit `fbd62e8f0193e2d59afe4b6ac719fa1a5be00260`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1140a9f..fbd62e8`다. goal은 active/progress다.

## 2026-11-11 — 명령 기한에 맞춰 중앙 승인 대기 종료

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R10, R11. 직전 goal turn은 BLE 관측과 명령 영수증 구독 조건을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 `EXPIRED` 취소 정산을 확인했다.

- Gateway 0.2.85는 최초 중앙 승인 대기를 명령 기한과 `REQUEST_TIMEOUT` 중 짧은 값으로 제한한다. 명령이 만료되면 실행 의도를 기록하기 전에 `REJECTED / EXPIRED` 영수증을 저장한다. 먼저 요청 제한에 걸리면 명령을 `RECEIVED`로 두고 다음 순회에서 재승인한다.
- 기한 만료에 의한 요청 취소, 더 짧은 요청 제한, 늦게 도착한 승인 응답의 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·실제 Pi 접속·중앙 API 정산·실물 명령은 미수행이다. [BLE 통신 메모](../keyring/raspberry-pi-gateway/IO_NOTES.md)

소스 commit `fddc45578a3444a4fac94bb7ae742e1b44db68ae`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `afd7aa7..fddc455`다. goal은 active/progress다.

## 2026-11-11 — 장치별 중앙 승인과 BLE 명령 처리

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R10, R11. 직전 goal turn은 명령 기한에 맞춘 승인 대기를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 device별 generation·dispatch 계약을 확인했다.

- Gateway 0.2.86은 등록 장치별 명령 처리 루프를 운용한다. 한 장치의 승인이나 BLE 영수증 대기가 다른 장치의 처리를 막지 않으며, 같은 장치 안에서는 기존 순서대로 한 건씩 시도한다. 이전 등록의 대기 명령은 기존 기한 검사를 거친다.
- SQLite는 기존 대기 명령의 저장 payload에서 조회용 device ID를 채운다. 명령 본문·해시·영수증은 그대로 보존한다. 느린 승인과 별도 장치 처리, 같은 장치 순서, 이전 DB 대기 행을 다루는 회귀시험 소스를 추가했다. 빌드·시험·정적 분석·Pi 접속·실물 명령·운영 DB 업그레이드는 미수행이다. [BLE 통신 메모](../keyring/raspberry-pi-gateway/IO_NOTES.md)

소스 commit `dc18ac12a1da621fb11b37a1651323ad0f93837a`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `75dfee3..dc18ac1`다. goal은 active/progress다.

## 2026-11-11 — 수신한 장치 영수증의 SQLite 저장 재시도

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R10, R11. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 영수증 정산 계약을 확인했다.

- Feather의 ON/OFF에서 LED 육안 변화가 없었다. 기존 실물 기록에는 GPIO 읽기값, Pi 영수증, Mobius4 및 중앙 정산이 각각 남아 있다. 1.54인치 ST7789에서 Feather 0.2.1의 `CMD ON`과 `CMD OFF`를 확인하는 실물 단계가 남았다. [Feather 시험 기록](../keyring/evidence/2026-11-11-feather-visual/receipt.json)
- Gateway 0.2.87은 BLE에서 받은 영수증을 최초 수신 시각과 함께 보존하고 SQLite 저장만 재시도한다. 정상 종료 시 마지막 저장을 시도한다. 영수증이 저장되기 전에 프로세스가 종료되면 재시작 시 `INDETERMINATE / RESTART_INTERRUPTED`로 기록한다. [BLE 통신 메모](../keyring/raspberry-pi-gateway/IO_NOTES.md)
- 연속 SQLite 실패와 BLE 응답 타임아웃, 저장 대기 중 취소를 회귀시험으로 다뤘다. 첫 전체 실행의 기존 관측 마이그레이션 테스트 실패를 변경 전 HEAD에서도 재현했다. 잘못 옮겨진 세 줄을 원래 용량 테스트로 되돌린 뒤 Gateway 단위 테스트 224개와 Python wheel 빌드가 통과했다. Pi 배포와 Feather 재플래시·실물 확인은 미수행이다.

소스 commit `3f5b5a068140a120210b22ea6fcc378fcd129171`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `8df2ff2..3f5b5a0`이다. goal은 active/progress다.

## 2026-11-11 — Feather 화면의 단계별 육안 기록

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R05, R11. 직전 goal turn은 수신한 장치 영수증의 SQLite 저장 재시도를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 장치 ACK/readback 증거 계약을 확인했다.

- Feather 0.2.1 화면은 각 단계 완료 후 명령 ID와 시각을 복사할 필요 없이 눈으로 본 문구만 입력한다. PC 도구는 해당 단계의 readback과 grant 회수 응답을 대조하고 명령 ID·PC UTC·화면 문구를 기록한다. OFF 발급 의도가 이미 기록된 뒤의 ON 입력과 같은 파일의 덮어쓰기를 거절한다.
- 기존 증거 대조 도구가 단계별 파일과 이전 JSON 배열을 읽는다. 화면 미표시와 문구 불일치는 관찰값으로 보존한다. 기록 경로의 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·기록 도구 실행·Feather flash·Pi 접속·실제 화면 확인은 미수행이다. [실물 화면 기록 절차](../keyring/raspberry-pi-gateway/TESTING.md#기존-scoped-mobius4에서-feather-led-시험)

소스 commit `657bf8ae6a639062f17ca3c395c01871ef9c37c5`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1798a71..657bf8a`다. goal은 active/progress다.

## 2026-11-11 — Pi 배포 계정의 SQLite 상태 권한 점검

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R11. 직전 goal turn은 Feather 화면 기록 도구를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 명령·영수증 계약을 확인했다.

- Gateway 0.2.88은 systemd의 `STATE_DIRECTORY`를 사용해 DB, 잠금, WAL, 공유 메모리, 롤백 저널의 파일 유형과 위치를 검사한다. 서비스 계정이 SQLite 디렉터리에 쓰고 진입할 수 있는지, 기존 파일에 필요한 접근 권한이 있는지도 확인한다. 오류는 파일 역할을 표시한다.
- 새 하위 디렉터리를 만들기 전의 사전 점검과 상태 디렉터리 및 WAL 접근 거부, 잘못된 보조 파일 유형의 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·Pi 배포·systemd 실행·실제 SQLite 권한 검증은 미수행이다. [Pi 배포 절차](../keyring/raspberry-pi-gateway/README.md#수동-실행-또는-systemd-배포)

소스 commit `efaeb5698a87af465bf9fcfbf5d958bc0a60af10`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `76d4542..efaeb56`이다. goal은 active/progress다.

## 2026-11-11 — r18 관측의 Pi 상태 경로와 중앙 모의 표시 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R05, R15. 직전 goal turn은 Pi 배포 계정의 SQLite 상태 권한 점검을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f` 및 중앙 관측 수용 이벤트의 `simulation` 필드를 확인했다.

- r18 관측 대조 도구는 Mobius4 health의 컨테이너를 Pi DB에 고정한 ID와 비교한다. Pi 전송 큐에 같은 health 요청이 남아 있으면 경로와 본문도 비교한다. ID가 없던 기존 Pi DB는 고정 ID 확인 결과를 `null`로 표시한다.
- 중앙 수용 여부와 실물 전달 증거 일치를 별도로 보고한다. 고정된 health ID 및 중앙 수용 이벤트의 `simulation:false`가 모두 확인돼야 실물 전달 증거 일치를 표시한다. 바뀐 health ID, 남은 health 본문 불일치, 모의 수용, 이전 DB의 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·대조 도구 실행·r18·Pi·Mobius4 실물 통합은 미수행이다. [관측 전달 증거 대조](../keyring/raspberry-pi-gateway/TESTING.md#관측-전달-증거-대조)

소스 commit `59f784b1b34d711d414e428f490579695a9b33a1`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `f67bae8..59f784b`다. goal은 active/progress다.

## 2026-11-11 — 원격 수신 확인 뒤 Pi 완료 기록 재시도

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10. 직전 goal turn은 r18 관측의 Pi 상태 경로와 중앙 모의 표시 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 수용·중복 응답 계약을 확인했다.

- Gateway 0.2.89는 원격 수신을 확인한 후 SQLite 완료 기록에 실패하면 해당 전송 작업에서 기록을 재시도한다. 완료 집계는 저장 뒤에 반영한다. 정상 종료 시 한 번 더 기록하고, 저장 전에 종료되면 행은 기존 재시작 및 요청 ID 규칙을 따른다.
- 중앙 영수증 완료 기록을 재시도하는 동안 Mobius4가 진행하는 경우, 중앙 원격 요청이 같은 프로세스에서 한 번만 발생하는 경우와 종료 시에도 저장할 수 없는 경우를 회귀시험 소스에 추가했다. 빌드·테스트·정적 분석·실제 Pi·Mobius4·중앙 API 실행은 미수행이다. [영수증 대기열](../keyring/raspberry-pi-gateway/RECEIPT_ROUTING.md#중앙-명령-영수증-정산)

소스 commit `e04bbf8c88f8eed42cb84ed7348fae7b71ae3039`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `298ae2c..e04bbf8`이다. goal은 active/progress다.

## 2026-11-11 — 관측 알림이 멈춘 BLE 연결 복구

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02. 직전 goal turn은 Pi의 원격 수신 완료 기록 재시도를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀 BLE 관측 계약을 확인했다.

- Gateway 0.2.90은 구독 이후 새로운 관측 알림이 `BLE_OBSERVATION_TIMEOUT` 동안 들어오지 않으면 해당 연결의 명령 준비 상태를 해제하고 다시 연결한다. 기본값은 30초다. 초기 READ, 중복 순번, 이전 연결 알림은 시간을 갱신하지 않는다. 대기 중인 명령은 기존 연결 종료 경로를 거친다.
- BlueZ 연결이 유지되는 상태에서 알림만 멈춘 경우, 진행 중인 명령 대기 해제, 이전 세션·중복 알림의 시간 갱신 차단을 다루는 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·Pi BlueZ 및 실물 Feather/r18 재연결 시험은 미수행이다. [BLE 재연결](../keyring/raspberry-pi-gateway/BLE_SESSIONS.md#재연결과-관측-시각-기준)

소스 commit `1be3c200ea61994b3777fd94a4dedb300d2a3327`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `7323a88..1be3c20`이다. goal은 active/progress다.

## 2026-11-11 — BLE 초기 GATT 설정과 연결 해제의 대기 제한

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02. 직전 goal turn은 관측 알림이 멈춘 BLE 연결 복구를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀 BLE 관측·영수증 계약을 확인했다.

- Gateway 0.2.91은 연결 뒤 identity와 첫 관측 읽기 및 알림 구독에 총 30초를 적용한다. 설정 제한을 넘으면 이전 세션 콜백을 무효화한 뒤 BlueZ 해제를 최대 15초 기다린다. BlueZ 응답을 받지 못한 경우 로그를 남기고 기존 재접속 대기로 넘어간다.
- 멈춘 읽기와 구독, 응답 없는 해제, 뒤늦은 이전 알림을 모의 회귀시험 소스에 추가했다. 빌드·테스트·정적 분석·실제 Pi BlueZ와 Feather/r18 재연결은 미수행이다. [BLE 재연결](../keyring/raspberry-pi-gateway/BLE_SESSIONS.md#재연결과-관측-시각-기준)

소스 commit `6e82b5aa28e276db9acbdbaf05c416ae20b08428`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `9866b8e..6e82b5a`다. goal은 active/progress다.

## 2026-11-11 — BLE 명령의 종결 조각 전 실패 정산

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R10, R11. 직전 goal turn은 BLE 초기 GATT 설정과 연결 해제 기한을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 중앙 `DISPATCH_NOT_SENT` 정산을 확인했다.

- Gateway 0.2.92는 LF 종결 조각을 시도하기 전 BLE 오류를 `REJECTED / DISPATCH_NOT_SENT`로 남긴다. Feather와 r18 소스는 LF를 받아야 프레임을 처리한다. 종결 조각을 시도한 뒤 영수증을 받지 못하면 기존 미확정·타임아웃 경로를 유지한다.
- 부분 전송 타임아웃과 최종 조각 응답 타임아웃을 구분하는 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·실제 Pi/Feather/r18 전송과 중앙 정산은 미수행이다. [BLE 전송 및 재연결](../keyring/raspberry-pi-gateway/BLE_SESSIONS.md)

소스 commit `ea72bd3656e85e432b17063da7b52eb59dd7923c`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `1a43288..ea72bd3`이다. goal은 active/progress다.

## 2026-11-11 — Pi 재시작 시 마지막 BLE 조각 확인

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R10, R11. 직전 goal turn은 종결 조각 전 BLE 실패 정산을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 `DISPATCH_NOT_SENT` 수용 규칙을 확인했다.

- Gateway 0.2.93은 실행 의도에 종결 조각 미시도 상태를 저장하고, 마지막 BLE 쓰기 직전에 해당 명령 ID·payload hash로 전송 가능성을 커밋한다. 저장이 실패하면 마지막 조각 쓰기를 차단한다. 저장 후 세션·권한·전송 기한을 다시 확인한다.
- 재시작 시 마지막 조각 미시도가 확인된 행은 `DISPATCH_NOT_SENT`로 정산한다. 마지막 조각이 전달됐을 수 있는 행과 열이 없던 기존 DB의 행은 `RESTART_INTERRUPTED`를 사용한다. 마이그레이션, 저장 실패, 저장 중 시계 변경, 재시작 분기 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·실제 Pi SQLite 마이그레이션·재시작·BLE·중앙 정산은 미수행이다. [상태 복구](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md)

소스 commit `5646e6c2fe5ab315ac9b5e4562fd8ccc64d8854c`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `25bfd17..5646e6c`다. goal은 active/progress다.

## 2026-11-11 — Mobius 전환 보고서의 마지막 BLE 조각 상태

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R10, R11. 직전 goal turn은 재시작 후 마지막 BLE 조각 표시 복구를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f` 및 팀 명령 정산 계약을 확인했다.

- Gateway 0.2.94의 `plan-cutover`가 `DISPATCHING` 상태를 마지막 조각 미시도·전송 가능·기록 없음으로 집계한다. `bubble-keyring-reconcile`은 키링 저널에 없는 전송 중 명령마다 해당 상태를 표시한다. 기존 SQLite와 보관본은 읽기 전용으로 읽고 검토 대상과 건수를 유지한다.
- 새 값 세 가지와 열이 없는 이전 DB를 다루는 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·도구 실행·실제 Pi 보관본과 팀 서버 전환은 미수행이다. [상태 복구와 배포 전환](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#중앙-api-배포-전환)

소스 commit `402339eaf875a470be0f25e58b402b10ff6eae33`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `7d0ad7b..402339e`다. goal은 active/progress다.

## 2026-11-11 — Pi 보관본과 중앙 명령 정산 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R10, R11. 직전 goal turn은 Mobius 전환 보고서에 마지막 BLE 조각 상태를 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 중앙 정산 이벤트를 확인했다.

- Gateway 0.2.95의 `bubble-keyring-reconcile --archive-only --team-state`는 키링 저널에 없는 Pi 검토 대상의 영수증을 원래 중앙 배포의 `runtime.json`과 대조한다. 명령·claim·epoch·해시·중앙 이벤트와 시각이 일치하면 중앙 실행 상태와 이벤트 ID를 표시한다.
- Pi 영수증, 중앙 명령, 중앙 영수증 누락을 구분하고 기존 검토 건수를 유지한다. 성공·취소·실행 미확정과 불일치의 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·대조 도구 실행·실제 Pi 및 팀 보관본 대조는 미수행이다. [기존 배포의 명령과 키링 저널 대조](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#기존-배포의-명령과-키링-저널-대조)

소스 commit `fa98bddd2774b895d499373fb24393df5c7fe0ae`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `4f5052e..fa98bdd`다. goal은 active/progress다.

## 2026-11-11 — MQTT 후보 승인 대기 전 HTTPS 명령 저장

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R10, R11. 직전 goal turn은 Pi 보관본과 중앙 정산 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f` 및 팀의 명령 목록·승인 계약을 확인했다.

- Gateway 0.2.96은 HTTPS 명령 목록이 도착하면 유효한 명령을 먼저 SQLite에 저장한다. MQTT 후보는 남은 자리에서 정확한 중앙 binding을 확인한 뒤 저장한다. 기존 전체 배치 조회 도구는 두 경로의 결과를 합쳐 반환한다.
- 목록 조회와 MQTT 후보 승인에는 전체 대기 기한을 적용한다. MQTT 승인 대기 중 HTTPS 명령 저장과 느린 요청 취소를 회귀시험 소스에 추가했다. 빌드·테스트·정적 분석·실제 Pi와 중앙 HTTPS/MQTT 경로 확인은 미수행이다. [Gateway 명령 수신](../keyring/raspberry-pi-gateway/README.md#저장소권한시간-동작)

소스 commit `53f7ea6705d22e16b9d3c02d48508b6ea40b38f4`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `dd0fb20..53f7ea6`이다. goal은 active/progress다.

## 2026-11-11 — Mobius4 장치별 관측 재전송 순서

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R15. 직전 goal turn은 MQTT 후보 승인 대기 전 HTTPS 명령 저장을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f` 및 oneM2M 관측·중앙 전송 계약을 확인했다.

- Gateway 0.2.97은 같은 Mobius4 컨테이너·장치의 관측을 SQLite 등록 순서대로 보낸다. 먼저 등록된 행이 재시도 대기 중이면 같은 장치의 새 부팅 관측도 그 뒤에서 대기한다. 다른 장치, 명령 영수증과 health는 기존 선택 규칙을 따른다.
- 이전 native 관측 행은 저장 본문에서 장치 ID를 채운다. 기존 요청 ID, 본문, 재시도 시각과 CORE 보관 fingerprint는 이어서 사용한다. 재시작·부팅 변경·공유 health·영수증 선택을 다루는 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·실제 Pi 마이그레이션과 Mobius4 재전송은 미수행이다. [BLE·중앙 통신 구현 메모](../keyring/raspberry-pi-gateway/IO_NOTES.md)

소스 commit `163fdf3be325eac3243199cce3ad036beae57338`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `aff79c1..163fdf3`이다. goal은 active/progress다.

## 2026-11-11 — Mobius4와 CORE MQTT 전송 작업 분리

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R11. 직전 goal turn은 Mobius4 장치별 관측 재전송 순서를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀 CORE ACK·텔레메트리 계약을 확인했다.

- Gateway 0.2.98은 Mobius4 native 전송, CORE ACK, CORE 텔레메트리를 독립 작업에서 처리한다. Mobius4 응답 대기 중에도 새 명령의 ACK를 기존 SQLite 트랜잭션으로 등록하고 MQTT로 보낼 수 있다. CORE 텔레메트리는 설정된 ownership epoch와 장치별 순서를 유지한다.
- Mobius4 대기 중 CORE ACK와 기본 텔레메트리 전송, 명령 비활성 모드, native 우선순위와 중복 ACK 회귀시험 소스를 보강했다. 빌드·테스트·정적 분석·실제 Pi·Mobius4·MQTT 브로커 검증은 미수행이다. [영수증과 CORE ACK의 대기열](../keyring/raspberry-pi-gateway/RECEIPT_ROUTING.md)

소스 commit `4a51cc2d262e86c1f6d35535a21f7c63d8094bcd`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `01f86df..4a51cc2`다. goal은 active/progress다.

## 2026-11-11 — 중단된 Feather 화면 시험 기록 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R05, R15. 직전 goal turn은 Mobius4·CORE MQTT 전송 작업 분리를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`의 tip과 명령 발급 계약을 확인했다.

- 0.2.0의 ON/OFF 시험에서 운영자는 두 단계 모두 보드 LED 변화를 보지 못했다. 당시 Pi·Mobius4 GPIO readback과 중앙 정산 결과는 기존 기록에 있다. [실물 시험 기록](../keyring/evidence/2026-11-11-feather-visual/receipt.json)
- Feather 0.2.1 화면 시험이 중단되면 검증 도구가 남아 있는 화면 기록을 명령 ID·GPIO readback·grant 회수에 결합한다. OFF 발급 뒤의 ON 화면 기록은 거부하고 한 단계만 있으면 전체 화면 일치 여부를 비워 둔다. 회귀시험 소스와 절차를 추가했다. 빌드·테스트·정적 분석·장비 업로드·실제 화면 확인은 미수행이다. [중단 복구 절차](../keyring/raspberry-pi-gateway/TESTING.md#기존-scoped-mobius4에서-feather-led-시험)

소스 commit `90b30183bbbba82ddc067319e712b8301bcbd49f`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `5d3266d..90b3018`이다. goal은 active/progress다.

## 2026-11-11 — r18 실물 관측 전달 판정

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R15. 직전 goal turn은 중단된 Feather 화면 기록 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f` 및 main의 중앙 텔레메트리 수용 이벤트에서 `simulation`의 전달을 확인했다.

- r18 실물 관측 대조 절차에 `--require-physical`을 추가했다. Pi DB의 고정 health 컨테이너와 중앙 수용 이벤트의 `simulation:false`가 확인돼야 성공 코드를 반환한다. 모의 이벤트, 기존 health ID 미고정 DB, 중앙 이벤트 미도착, 포털/웹 불일치를 다루는 회귀시험 소스를 보강했다.
- Pi 관측 세션 준비 명령에 실제로 사용할 펌웨어 revision을 넘기도록 예시를 갱신했다. 빌드·테스트·정적 분석·제작 PCB와 Pi 실물 시험·중앙/웹 실물 연동은 미수행이다. [r18 관측 전달 대조](../keyring/raspberry-pi-gateway/TESTING.md#관측-전달-증거-대조)

소스 commit `f2c3126aefa850089feae80e736a15eff8e96b41`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `0250b64..f2c3126`이다. goal은 active/progress다.

## 2026-11-11 — r18 첫 구동에서 실제 펌웨어 파일 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R05. 직전 goal turn은 r18 실물 관측 전달 판정을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 중앙 관측 수용 계약을 확인했다.

- 화면 없음·ST7789·JD9853의 0.7.18 관측 프로필은 실행 중인 앱 파티션의 SHA-256을 최초 USB 기록과 `?` 재출력에 남긴다. Gateway 0.2.99의 `--firmware-image`는 실제 업로드에 사용한 서명 없는 ESP32-S3 앱 파일의 SHA-256 footer와 USB 해시를 대조하고, 같은 BLE 부팅의 보고서에 파일 전체 해시와 크기를 기록한다.
- 격리 Pi 도구는 세 새 revision을 선택할 수 있다. 이전 펌웨어 로그, 다른 빌드·손상된 이미지·해시 읽기 실패를 다루는 회귀시험 소스와 첫 구동 절차를 갱신했다. 빌드·테스트·정적 분석·장비 업로드·실물 USB/BLE 해시 대조는 미수행이다. [첫 구동 절차](../keyring/pcb/BRING_UP.md)

소스 commit `65b3e2fb547dbb12f6901c58556442ae822184f5`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `000485a..65b3e2f`다. goal은 active/progress다.

## 2026-11-11 — r18 첫 구동과 중앙 관측 증거 연결

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R05, R15. 직전 goal turn은 실행 이미지 해시의 첫 구동 기록을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f` 및 main의 중앙 관측 수용 계약을 확인했다.

- 격리 관측 대조에 `--bringup-report`와 `--firmware-image`를 함께 지정하면 첫 구동의 장치·펌웨어·USB 로그·실행 이미지와 Mobius4 관측을 묶는다. 첫 구동의 마지막 BLE 순번보다 뒤인 관측만 수용하고, 결과에 첫 구동 보고서와 바이너리의 SHA-256을 남긴다. 기존 중앙 수용 및 물리 전달 판정도 이어서 적용한다.
- 정상 연결과 USB 로그·바이너리·관측 순번 불일치의 회귀시험 소스 및 절차를 추가했다. 빌드·테스트·정적 분석·실제 PCB/Pi·Mobius4·중앙/웹 연결은 미수행이다. [관측 전달 증거 대조](../keyring/raspberry-pi-gateway/TESTING.md#관측-전달-증거-대조)

소스 commit `b9f119ef306bd82398198d2311397037c8ce68a8`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `a9e1a52..b9f119e`다. goal은 active/progress다.

## 2026-11-11 — Mobius4 관측 전송 경로 기록

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03. 직전 goal turn은 r18 첫 구동과 중앙 관측 증거의 연결을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 CORE Gateway 계약의 MQTT·HTTPS 경로를 확인했다.

- Gateway 0.2.100은 확인된 관측을 outbox에서 완료한 뒤, 선택한 경우 MQTT·HTTPS 전용·HTTPS fallback 결과와 새 자원 생성 여부를 INFO 로그에 남긴다. r18 관측 전용 세션은 기록을 활성화한다. 격리 세션의 native 전송은 HTTPS다.
- r18 대조 도구의 `--pi-log`는 동일 요청 ID·관측 본문 해시를 Mobius4 및 Pi DB 상태와 대조한다. 서로 다른 경로가 같은 요청을 완료했다고 기록됐거나 DB에 아직 대기 중이면 실패한다. 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·실물 Pi 및 Mobius4 경로 검증은 미수행이다. [관측 전달 증거 대조](../keyring/raspberry-pi-gateway/TESTING.md#관측-전달-증거-대조)

소스 commit `120c18e1b69f267075b5f195d200e0e213494c74`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `b66e581..120c18e`다. goal은 active/progress다.

## 2026-11-11 — r18 격리 MQTT 관측 중계

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10. 직전 goal turn은 Mobius4 관측 확인 경로 기록을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 고정 Mobius4 `e8f75b1`의 MQTT·HTTPS 요청 구현을 확인했다.

- Gateway B mTLS 브로커 요청·응답 ACL과 격리 소비자의 선택적 oneM2M MQTT 중계를 추가했다. 시작 시 실제 r18 관측·health의 이름과 고정 ID를 확인하고, 두 컨테이너에 대한 CREATE만 같은 RQI·본문으로 기존 Mobius4 HTTPS에 전달한다. 내장 CSE MQTT listener는 기존 격리 설정을 따른다.
- Pi 관측 전용 세션에 `--mqtt-port`를 추가했다. 별도 터널을 사용해 HTTPS 경로를 유지하면서 MQTT 연결을 끊는 절차와, 두 관측의 전송 로그 대조 절차를 문서화했다. Originator·고정 ID·명령 차단·중복 응답을 다루는 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·Compose 실행·Pi 및 실물 MQTT/HTTPS 전환은 미수행이다. [격리 설정](../keyring/dev/mobius4/README.md#r18-관측-mqtt-중계)

소스 commit `1bdec28748e68ca0a1695672871f91432c14c3b7`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `333623d..1bdec28`이다. goal은 active/progress다.

## 2026-11-11 — r18 한 부팅의 MQTT와 HTTPS 전환 증거

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R05. 직전 goal turn은 격리 r18 MQTT 중계를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f` 및 CORE 전송·중앙 관측 수용 계약을 확인했다.

- Gateway 0.2.101은 native 관측 완료 로그에 Gateway 부팅 ID를 추가한다. 관측 대조의 `--fallback-capture`는 같은 장치·Gateway 부팅, 같은 고정 컨테이너와 Pi 로그에서 MQTT와 HTTPS fallback으로 각각 생성된 관측을 요구한다. BLE 및 비모의 중앙 수용 순번의 증가와 서로 다른 Mobius4 자원을 확인한다.
- 정상 경로와 기존 자원, 중앙 수용 대기, 다른 Gateway 부팅을 다루는 회귀시험 소스와 절차를 추가했다. 빌드·테스트·정적 분석·Pi 및 제작 PCB 실물 전송은 미수행이다. [r18 전환 시험](../keyring/raspberry-pi-gateway/TESTING.md#r18-mqtt와-https-fallback-시험)

소스 commit `f3985b26f7dbd6b2f26fdf70a8d03dcc5f326825`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `97f37a5..f3985b2`다. goal은 active/progress다.

## 2026-11-11 — 실행 중인 임시 Mobius4의 r18 MQTT 설정

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03, R10. 직전 goal turn은 한 부팅의 MQTT/HTTPS 전환 증거 대조를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 CORE 전송 계약을 확인했다.

- `-PrepareR18Mqtt`가 기존 CSE의 관측·health 이름과 고정 ID를 조회하고 로컬 MQTT 설정과 HTTPS 경로를 작성한다. 기존 설정이 실제 ID와 다르면 중단한다. `-RefreshIngress`는 MQTT 설정이 있을 때 r18 구독 준비도 기다린다. [격리 설정](../keyring/dev/mobius4/README.md#r18-관측-mqtt-중계)
- 기존 임시 Compose에 준비를 실행해 관측 `a8o9yh7miw`, health `d6tq49gt37`의 고정 ID를 읽었다. 격리 TLS 프록시·브로커·소비자를 갱신했다. 두 준비 명령은 exit 0이었으며 소비자가 기존 구독과 r18 MQTT 구독 준비를 모두 보고했다. 로컬 설정과 자격 정보는 Git에 포함하지 않았다. 빌드·회귀시험·정적 분석·Pi 연결·실물 관측 발행·HTTPS 전환은 미수행이다.

소스 commit `2017c3fa4193215cf649b588a4453358706173b4`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `3e382d8..2017c3f`다. goal은 active/progress다.

## 2026-11-11 — r18 단일 펄스의 장치 저널 확인

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R10, R11. 직전 goal turn은 임시 Mobius4의 r18 MQTT 설정과 구독 준비를 확인하고 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀 명령 발급·승인 경로를 확인했다.

- 격리 r18 단일 펄스 도구는 같은 부팅의 OFF·fault 없음과 정상 장치 저널·빈 슬롯을 확인한다. grant 발급 후 새 health 관측으로 재확인하고 기준 관측에 슬롯 수를 기록한다. 오류·가득 참·기한 내 관측 부재이면 명령 발급 전에 멈추고, 발급된 grant의 회수를 시도한다.
- 중단 증거 대조에서 새 시험의 기준 저널 기록을 요구한다. 초기 가득 참, grant 이후 오류, 이전 증거 호환을 다루는 회귀시험 소스와 절차를 추가했다. 빌드·테스트·정적 분석·실제 Pi와 r18 명령 및 grant 회수 검증은 미수행이다. [r18 단일 펄스 시험](../keyring/raspberry-pi-gateway/TESTING.md#r18-단일-펄스-시험)

소스 commit `cde0dce987e8c07bb247cd9a2345fd4b9b2325ef`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `83febd1..cde0dce`다. goal은 active/progress다.

## 2026-11-11 — r18 모터 명령의 보조 전원 GPIO 확인

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R10, R11. 직전 goal turn은 r18 단일 펄스의 저널 준비 확인을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 `APPLIED` readback 수용 조건을 확인했다.

- 정식 r18 펌웨어 0.7.19는 alert 시작 때 `AuxEnable` GPIO 쓰기 결과와 HIGH 읽기값을 확인한다. 실패하면 보조 전원을 해제하고, 작동 중 LOW 검출도 기존 alert 인터럽트 경로로 처리한다. 적용 시점의 실패는 장치 저널의 PREPARED와 `INDETERMINATE` 흐름을 따른다.
- 새 Pi 명령 세션·격리 API 프로필은 0.7.19를 고정한다. 이전 0.7.14의 Pi 프로필과 오프라인 기록을 읽는 경로를 유지한다. GPIO 쓰기·읽기 실패와 API revision 불일치 회귀시험 소스를 보강했다. 빌드·테스트·정적 분석·격리 명령 API 재시작·플래시·실물 GPIO/전압·모터 시험은 미수행이다. [보조 전원 동작](../keyring/firmware/PERIPHERALS.md#공용-전원spi절전)

소스 commit `3b2edcc91e19a7812cc93dd6ec1d2cd8fbbd730a`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `02a73d3..3b2edcc`다. goal은 active/progress다.

## 2026-11-11 — 격리 r18 명령 API의 0.7.19 전환

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R10, R11. 직전 goal turn은 펌웨어의 보조 전원 GPIO 확인과 명령 프로필 변경을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 명령 readback 수용 계약을 확인했다.

- `https://127.0.0.1:8789`의 기존 격리 r18 API가 0.7.14 프로필을 사용했고, 연결된 클라이언트와 저장된 명령은 0건이었다. 해당 루프백 프로세스를 종료한 뒤 기존 파일·인증서·팀 소스로 0.7.19 프로필을 시작했다.
- 새 리스너는 `r18-hand-solder`, `keyring-0.7.19`, 팀 commit `bc2a45d`로 `READY`를 보고했다. 상태 파일 SHA-256은 재시작 전후 같았고 저장된 명령은 0건이다. 빌드·회귀시험·정적 분석·Pi 사전 확인·플래시·실물 명령 시험은 미수행이다. [격리 명령 API](../keyring/dev/mobius4/README.md#r18-격리-명령-api)

배포한 프로필 소스는 `3b2edcc91e19a7812cc93dd6ec1d2cd8fbbd730a`이며 `origin/codex/keyring-namho`에 있다. goal은 active/progress다.

## 2026-11-11 — r18 모터 부하 펄스 계측 연결

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R05, R10. 직전 goal turn은 임시 r18 명령 API를 0.7.19 프로필로 전환하고 준비 상태를 기록한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀 명령 readback 계약을 확인했다.

- r18 오프라인 대조가 J6 부하 전압 CSV를 최초 `APPLIED` 영수증에 연결한다. 명령 ID·CSE 자원 ID·영수증 해시·계측 파일 해시를 확인하고, 측정 임계값과 인접 샘플로 상승·하강·지속 시간의 범위를 계산한다. 1,000ms 상한 경계에 걸린 결과와 여러 펄스·잘린 에지를 구분한다.
- 계측값과 명령의 연결은 작업자 기록을 사용한다. 상한 이내·초과·판정 불가 및 잘못 연결된 영수증의 회귀시험 소스와 절차를 추가했다. 빌드·테스트·정적 분석·실제 J6 전압 및 진동 계측은 미수행이다. [r18 펄스 계측값 연결](../keyring/raspberry-pi-gateway/TESTING.md#r18-펄스-계측값-연결)

소스 commit `b22ecc25b78fa413941c31a598094b67c12aed2a`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `aad0f28..b22ecc2`다. goal은 active/progress다.

## 2026-11-11 — r18 저전력 진입 전에 GPIO hold 확인

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R05. 직전 goal turn은 부하 펄스 계측 연결을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀 BLE 관측 계약을 확인했다.

- `KEYRING_ENABLE_SLEEP=1` 빌드 `keyring-0.7.20-sleep`은 BLE 종료 전에 안전 출력 쓰기와 핀별 hold를 완료하고 모터·AUX LOW 및 wake 입력을 다시 확인한다. 준비 실패 시 wake source와 hold를 정리하고 버튼·가속도 입력과 BLE 광고를 복구한다.
- 출력 쓰기·읽기, 부분 hold, pull-up 실패와 마지막 버튼 입력을 다루는 회귀시험 소스와 wake 기록 절차를 추가했다. 빌드·테스트·정적 분석·플래시·실물 sleep/wake·전류 계측은 미수행이다. [저전력·깨우기](../keyring/firmware/POWER_WAKE.md)

소스 commit `00a65e28dbc3aeab153f6a9d44c495233f76177a`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `8d489de..00a65e2`다. goal은 active/progress다.

## 2026-11-11 — r18 절전 빌드의 명령 시험 프로필

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R10, R11. 직전 goal turn은 r18 저전력 GPIO hold 수정과 wake 절차를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀의 명령 readback 수용 조건을 확인했다.

- `keyring-0.7.20-sleep`을 격리 API·Pi 명령 세션·펄스 도구에서 명시적으로 선택할 수 있다. 기본 명령 프로필은 0.7.19다. 펄스 도구는 파일 생성과 명령 준비 전에 Gateway B mTLS 인증서로 실행 중인 API의 revision을 확인한다. 장치 저널 및 오프라인 대조는 시험에서 고정한 revision을 사용한다.
- 0.7.14/0.7.19와 다른 firmware를 광고하는 API 및 0.7.20-sleep 성공 조건을 다루는 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·API 재시작·플래시·실물 wake 후 명령은 미수행이다. [Pi 명령 세션](../keyring/raspberry-pi-gateway/TESTING.md#r18-pi-명령-세션)

소스 commit `3c4569339d1b0b968b4b53d94942b7b84ce8e4bb`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `4d2a95a..3c45693`다. goal은 active/progress다.

## 2026-11-11 — r18 깨우기와 명령 부팅 연결

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R05, R10. 직전 goal turn은 절전 빌드의 격리 명령 프로필을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`와 팀 영수증의 boot ID·readback 조건을 확인했다.

- Gateway 0.2.102는 wake 원인이 확인된 부팅의 SHA-256과 해당 BLE 순번을 보고한다. r18 절전 펄스의 `--wake-report`는 같은 부팅에서 받은 더 새 기준 관측을 요구하고, 사전 선택한 보고서 해시를 보관한다. 오프라인 도구는 원본 보고서, 기준 관측, 최초 `APPLIED` Mobius4 영수증과 중앙 정산을 대조한다.
- 일치·다른 부팅·변경된 보고서를 다루는 회귀시험 소스와 절차를 추가했다. 빌드·테스트·정적 분석·실물 wake·이후 명령 검증은 미수행이다. [r18 Pi 명령 세션](../keyring/raspberry-pi-gateway/TESTING.md#r18-pi-명령-세션)

소스 commit `d2314af943b0ee6dccfffef0a9da2d795f9c2b98`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `461b222..d2314af`다. goal은 active/progress다.

## 2026-11-11 — r18 BLE 버튼 전이 순서 보존

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R15. 직전 사용자 응답은 Feather에서 LED 변화를 보지 못했다는 기존 기록을 재확인했다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 조회했다. main의 중앙 사건 처리는 최신 순번과 `buttonState`의 새 `panic`을 사용한다.

- r18 0.7.21은 활성 관측 구독 안에서 버튼 상태 전이 최대 8건을 일반 센서 상세와 별도로 대기시키고, 알림은 같은 생성 순번대로 보낸다. 만석에서는 먼저 쌓인 7건과 최신 상태를 남긴다. GATT 읽기는 최신 관측을 반환하며 이전 구독의 대기 프레임은 새 구독으로 넘어가지 않는다.
- Gateway 0.2.103, Pi 시험 도구, 격리 API 설정에 0.7.21 계열을 연결했다. 이전 revision은 해당 시험과 기록에서 계속 선택할 수 있다. 알림 조각 전송 중 전이, 큐 만석 및 재구독을 다루는 호스트 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·API 재시작·플래시·r18 버튼 및 중앙 사건 실물 시험은 미수행이다. [실물 시험 절차](../keyring/raspberry-pi-gateway/TESTING.md#r18-초기-구동-기록)

소스 commit `3da95d8d58a6ccebad50eb9a4bd34fce5b6fd14e`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `8a93e58..3da95d8`이다. goal은 active/progress다.

## 2026-11-11 — r18 버튼 전이와 중앙 안전 사건 대조

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R15. 직전 goal turn은 r18 BLE 전이 순서 보존을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 조회했다. Pi의 중앙 텔레메트리 SQLite 대기열은 장치별 첫 관측의 재시도 순서를 유지한다. 팀 main은 관측 후 30초까지 비상 사건을 처리하고, 관측 수용과 사건 영수증을 각각 기록한다.

- 0.7.21 bring-up 전용 도구가 Pi의 완료 요청 ID로 격리 Mobius4 원본을 읽는다. 같은 부팅의 버튼 누름·해제 5단계와 누계, Pi SQLite·완료 로그, 중앙 수용 순번, 동일 비상 관측 ID의 `DEVICE_PANIC_RECONCILED`와 안전 사건을 대조한다. 새 사건 생성과 열린 사건 재사용을 보고서에 기록한다.
- 회귀시험 소스는 관측만 수용된 경우, 수용 순번이 뒤바뀐 경우, 모의 비상 사건을 거절하는 경로를 다룬다. 빌드·테스트·정적 분석·실제 Pi·Mobius4 조회·r18 버튼 시험은 미수행이다. [시험 절차](../keyring/raspberry-pi-gateway/TESTING.md#r18-버튼-사건-시험)

소스 commit `6c46cb3b3d335d06ada928347d831f21ef206a3e`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `82513ab..6c46cb3`이다. goal은 active/progress다.

## 2026-11-11 — 서버 전환 시 CORE 전송 순번 이어받기

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R03. 직전 goal turn은 버튼 전이와 중앙 안전 사건의 대조 도구를 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 조회했다.

- Gateway 0.2.104의 `plan-cutover`는 새 배포 DB에서 보존할 CORE 순번과 대상 범위의 원본 대기 건수를 집계한다. `prepare-cutover`는 양쪽 잠금 아래에서 같은 Gateway ID의 유지 장치별 마지막 할당 순번을 새 binding DB에 기록한다. 새 DB와 상위 디렉터리를 동기화하고, 같은 CORE 범위에 대기 건이 있으면 준비를 중단한다. 원본 DB와 대기열·명령·영수증은 기존 배포에 보존한다.
- 대기 중단, 재실행 보호, 권한, 원본 보존과 이어지는 순번을 다루는 POSIX 회귀시험 소스를 추가했다. 빌드·테스트·정적 분석·실제 Pi 준비 명령·서버 전환은 미수행이다. [전환 절차](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md#새-배포-db에-core-순번-이어받기)

소스 commit `3a1c423409d324d4a290bf41b13010ca0d2d7611`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `41cd094..3a1c423`이다. goal은 active/progress다.

## 2026-11-11 — r18 조립 기록과 첫 구동 연결

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · PCB schematic/layout/BOM/assembly revision. 직전 goal turn은 새 배포 DB의 CORE 순번 보존을 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 조회했다.

- Gateway 0.2.105의 `bubble-keyring-assembly-evidence`는 인계 목록에서 프로젝트·회로도·PCB·reference별 BOM·커넥터 표를 해시로 대조한다. 작업자가 기록한 조립 revision 출처, 실장 상태, 패널과 보드 앞뒤 사진 해시를 새 기록에 남긴다. 조립 revision을 읽지 못했으면 미확인으로 유지한다.
- 격리 Pi 관측 비교에 작업자가 다시 읽은 보드 식별표를 연결할 수 있다. 조립 기록의 해시를 첫 부팅·펌웨어·Pi 관측 대조 결과에 추가한다. 회귀시험 소스를 추가했으며 테스트·빌드·정적 분석·KiCad 실행·실제 조립 기록 및 첫 구동은 미수행이다. [인수 절차](../keyring/pcb/BRING_UP.md#실물-조립-기록)

소스 commit `e9f4e9d39d166a20c47c731d7d3b71134216561e`를 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `5d7765e..e9f4e9d`이다. goal은 active/progress다.

## 2026-11-11 — r18 깨우기 원인의 중앙 전달 확인

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · R02, R05. 직전 goal turn은 조립 인수 기록을 첫 부팅과 관측 대조에 연결해 Git에 반영한 progress다. 원격 main `bc2a45d`, CORE `d54a43a`, WEB `80ed37f`를 조회했다.

- r18 격리 펄스의 `--wake-report`가 같은 부팅의 더 새 OFF health에서 깨우기 원인과 핀을 확인한다. 고정된 Mobius4 자원의 본문 해시를 중앙의 실물 관측 수용 이벤트와 대조한 뒤 명령 준비를 표시한다. 발급 직전에 health를 다시 확인한다.
- 오프라인 도구는 동일 관측 ID와 원본 해시를 다시 대조한다. 다른 핀·누락 관측·다른 관측 ID를 다루는 회귀시험 소스를 추가했다. 테스트·빌드·정적 분석·실제 Pi/Mobius4·r18 깨우기 및 명령 시험은 미수행이다. [실행 절차](../keyring/raspberry-pi-gateway/TESTING.md#r18-pi-명령-세션)

소스 commit `4ecee4f1f3a13f6c4ceb506aa886333935966b02`을 `origin/codex/keyring-namho`에 push했다. 결과는 exit 0, `c8a4e76..4ecee4f`이다. goal은 active/progress다.
