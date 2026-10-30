# 남호 — KEYRING

남호의 담당 범위인 키링 펌웨어와 Raspberry Pi Gateway를 이 디렉터리에서 개발한다. 기존 r18 PCB를 하드웨어 기준으로 연결하고 BLE 관측, 중앙 명령 전달, 장치 receipt, oneM2M 전송을 구현한다.

최신 기준은 DOC-REV 2.0.0이다. 원격 PC-MOBIUS-CORE 구현을 역할 브랜치로 merge했다. [팀 계약 연동과 남은 차이](CORE_INTEGRATION.md), [교체 가능한 임시 Mobius4 환경](dev/mobius4/README.md), [지속 개발 목표](../.goalplz/goal-contract.md)를 기준으로 다음 작업을 이어간다. 운영 서버 반영과 최종 merge는 별도 단계다.

```text
ROLE: KEYRING
OWNER: 남호
DOC: PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md
DOC-REV: 2.0.0
RUBRIC: R01, R02, R03, R05, R10, R11, R12, R15
SCOPE: r18 PCB 기반 펌웨어 및 Raspberry Pi Gateway
INTERFACES: KEYRING contract candidate 0.1.0 / BLE GATT / mTLS HTTPS / MQTT 3.1.1 / oneM2M cin
TESTS: Gateway0.2.2 소스·기존 설치 wheel 각55개 통과(모의47개·로컬 HTTPS/TLS8개); 펌웨어 compile profile 결과는 BUILD_PROFILES.md 참조; 실물/E2E 미실행
EVIDENCE: evidence/2026-10-30-https-tls/ — 최신 로그·receipt·hash; 이전 build/BLE/receipt 기록 유지
DEPENDENCIES: PC-MOBIUS API, AE/container/ACP, broker capability, credential 등록
```

## 구성

| 경로 | 담당 내용 |
|---|---|
| [firmware](firmware/README.md) | ESP32-S3 펌웨어, 보드 핀, BLE, 장치 journal, 출력 제어 |
| [주변장치](firmware/PERIPHERALS.md) | ST7789·JD9853 선택형 화면, 스피커 cue, microSD receipt 복사와 미확인 범위 |
| [공급 전원 계측](firmware/POWER_MONITOR.md) | INA219 단발 전류·전압·부하 전력, 센서/전력/상태 detail과 단위 |
| [DAC 대기 상태](firmware/HEADPHONE_STANDBY.md) | MAX9850 mute/shutdown 요청·공유 I2S interlock. 헤드폰 재생은 미구현 |
| [빌드 프로필](firmware/BUILD_PROFILES.md) | 로컬 장치 provisioning을 제외한 세 컴파일 구성과 실제 빌드 기록 |
| [journal 보관](JOURNAL_RETENTION.md) | 암호화 BLE snapshot·수동 보관 CLI, 원본 유지와 중앙 정산 의존성 |
| [Gateway 상태 보관](raspberry-pi-gateway/STATE_RECOVERY.md) | DB identity·WAL snapshot·기존 DB adoption, 중앙 확인 전 복구본 실행 차단 |
| [완료 조건·증거 공백](COMPLETION_GAPS.md) | 계획서 산출물별 자료, 미확인 원문/계약·실측·검증 허가 |
| [영수증 경로](raspberry-pi-gateway/RECEIPT_ROUTING.md) | native 영수증·CORE ACK 최초 원자적 staging과 독립 재시도 |
| [BLE 세션 경계](raspberry-pi-gateway/BLE_SESSIONS.md) | 재접속 시 이전 callback·중단한 명령의 새 연결 전송 차단과5개 회귀 시험 |
| [raspberry-pi-gateway](raspberry-pi-gateway/README.md) | Python daemon, BLE adapter, durable queue, 인증·전송 |
| [pcb](pcb/README.md) | r18 native KiCad 원본·로컬 CAD·BOM/배선표 snapshot과 핀 설명 정정 |
| [INTERFACE_NOTES.md](INTERFACE_NOTES.md) | UUID, payload, 중앙 API 및 oneM2M 전송 계약 |
| [contracts/keyring](../contracts/keyring/README.md) | standalone JSON Schema 2020-12 |
| [인수인계](../docs/keyring-handoff.md) | 구현 범위, 중앙 의존성, 미실행 수용 항목 |

데이터는 `키링 BLE → Gateway 로컬 queue → MQTT 또는 HTTPS → CSE` 순서로 전달한다. 명령은 중앙의 최신 승인·epoch·deadline 판정을 거쳐 BLE로 전달하고, 장치 receipt를 다시 중앙에 보낸다. 장애나 재시작으로 적용 여부가 확정되지 않으면 미확정 결과로 남긴다.

펌웨어 빌드·flash 및 Gateway 설치·실행 절차는 각 모듈 README에 있다. 실제 장치 ID, passkey, BLE 주소, CA/인증서/개인키 및 중앙 주소를 배포 환경에 설정해야 한다. 예시 설정만으로 현장 연결이 완료되지는 않는다.

현재 전체 상태는 **implemented / 실물·통합 unverified**다. 로컬 firmware 빌드는 [기존 실행 증거](evidence/2026-10-29-local-validation/README.md), Gateway 패키지 빌드는 [영수증 경로 실행 증거](evidence/2026-10-30-receipt-routing/README.md), 최신55개·로컬 TLS는 [HTTPS 실행 증거](evidence/2026-10-30-https-tls/README.md)에 연결한다. 실물 동작, BLE 거리·전력, CSE 연동, 영상 및 공개 evidence는 미완료다. 중앙 API와 oneM2M binding은 PC-MOBIUS 담당과 확정해야 하는 계약 후보이다.
