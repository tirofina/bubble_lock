# KEYRING 완료 조건과 증거 공백

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · 2026-10-30.

루트 계획서의 KEYRING 산출물·7개 완료 자료·첫 통합 조건을 현재 파일/기록과 대조했다. 대상은 firmware0.7.0/Gateway0.2.1이며, 이번 fetch의 main/CORE는91a281b다. 2026-10-29 허가된 로컬 빌드·모의 단위 테스트의 실제 결과는 [실행 증거](evidence/2026-10-29-local-validation/README.md)에 별도로 기록한다. 실물·중앙 통합·release 전체 완료를 선언하지 않는다.

2026-10-30 [BLE 세션 수정·패키지 시험](evidence/2026-10-30-ble-sessions/README.md)을 추가했다. 수정 전 재접속 회귀 시험5개 실패, 수정 후 소스·설치 wheel 각42개 통과다.

## 담당 산출물

| 계획서 요구 | 현재 자료 | 남은 실제 증거/입력 |
|---|---|---|
| KiCad schematic/PCB/BOM/assembly revision | [r18 source·inventory](pcb/r18/README.md),[핀 정정](pcb/HARDWARE_FIRMWARE_MAP.md) | 실제 조립 revision·배선·부품/패널 식별. 과거 CAD 기록은 현재 firmware 시험이 아님 |
| firmware source/build/flash 명령 | [소스](firmware/README.md),[3개 compile profile](firmware/BUILD_PROFILES.md) | 로컬3개 compile profile 통과·도구/dependency revision·artifact hash 확보. 실제 장치 설정 build/flash와 실물 결과 필요 |
| GATT profile/payload schema | [인터페이스](INTERFACE_NOTES.md),[schemas](../contracts/keyring/README.md) | CORE 확장 수용과 pairing/identity/fragment/reconnect 실물 결과 |
| sensor/button/LED/battery/charger | [센서/GPIO](firmware/README.md),[INA219](firmware/POWER_MONITOR.md),[주변장치](firmware/PERIPHERALS.md),[DAC standby](firmware/HEADPHONE_STANDBY.md) | 실제 calibration/출력/오류/wake·JD9853 모듈 init/geometry. LED·충전/온도 gate는 하드웨어 경로 |
| Raspberry Pi Gateway daemon | [소스·설치](raspberry-pi-gateway/README.md) | 실제 Pi/BlueZ·등록 장치/인증서·배포/runtime 증거 |
| MQTT/HTTPS transport | [전송 계약](INTERFACE_NOTES.md),[CORE 차이](CORE_INTEGRATION.md),[임시 CSE](dev/mobius4/README.md) | capability/RVI/ACL·mTLS·application receipt·fallback의 실제 결과 |
| queue/dedup/ACK/readback | [장치 journal](JOURNAL_RETENTION.md),[Gateway state](raspberry-pi-gateway/STATE_RECOVERY.md) | 모의 단위 테스트42개와 wheel build/설치 패키지 시험 통과. 실물 장애 시험·실제 ACK는 남아 있다. 중앙 settlement/checkpoint와 reclaim/복구 활성화 계약은 미확정 |
| power/range/reconnect/command 시험 | 인수인계 KR 항목·모듈별 미실행 목록 | 실제 전원/거리·장애/재시작/기한/회수 결과와 로그 |
| PCB·Gateway·앱 연동 영상 | source·설명 문서 | 실제 Pi→CSE→앱/웹·5분 미만 영상·공개/제출 증거 |

헤드폰 playback·OTA/secure boot/flash encryption은 별도 미구현 목록에 보존한다. 이를 구현한 것처럼 가정하거나 그 목록만으로 원래 완료 기준을 대체하지 않는다.

## 계획서의7개 완료 자료

1. 계약: KEYRING 후보 schema/CORE v1 인수 자료는 있다. INTEGRATION 승인·정산·복구와 확장 수용은 미확인이다.
2. 코드/configuration: 역할 source가 업로드됐다. 실제 설치/설정과 정상 동작은 별도다.
3. 단위/통합/장애 시험: 로컬 소스·설치 wheel 모의 단위 테스트 각42개가 통과했다. 실제 Pi/장비·중앙 통합·현장 장애 시험은 미실행이다.
4. 기대/실제 결과: 로컬 테스트 기대/실제 결과와 빌드 로그는 이번 evidence에 연결한다. KR 실물 항목을 통과로 채우지 않는다.
5. 수행/승인/gate: owner 남호/KEYRING, 사용자 로컬 실행 허가와 Windows/Python/compiler 환경을 기록했다. 독립 검토자 승인·원래 A01~A26 gate 매핑·실물 수행 증거는 미확정이다.
6. 로그/receipt/hash: source commit·CAD byte inventory·[빈 자원 provisioning receipt](dev/mobius4/provisioning-receipt.json)는 있다. 이번 로컬 빌드·테스트의 로그/hash를 별도 연결하며, Pi/E2E receipt·실측 로그를 대신하지 않는다.
7. release manifest: implemented/unverified이며 실제 release SHA·검증 결과 연결은 미완료다.

## 지정 경로에서 찾지 못한 기준 원문

계획서의 정확한 상대 경로를 저장소와 원래 작업공간 root에서 조회했다. 다른 PC·원격·다른 파일명까지 없다고 주장하지 않는다.

| reference | 두 root 지정 경로 | 영향 |
|---|---|---|
| proposal_work/red_blue_green/blue/contracts_round03.json | 미발견 | A01~A26 정의/계약 매핑을 추측하지 않음 |
| deliverables/privacy_bubble_expert_v3/active_release.json | 미발견 | 원래 release 연결표의 실제 상태/승인 미확인 |
| references/hackathon_2026/extracted/Hackathon Rubric 2026.txt | 미발견 | 세부 원문 미인수. 현재 root 계획서 역할/Rubric 표 사용 |

KR-*는 KEYRING 제안 추적 ID이며 원래 A01~A26과 같다고 표기하지 않는다. 원문 인수 뒤 실제 정의를 유지해 매핑한다.

## 다음 단계와 권한

2026-10-29 사용자가 로컬3개 compile profile 빌드·Gateway 모의 단위 테스트와 필요한 개발 dependency 설치를 명시적으로 허가했다. 기존 허가 대기는 해소됐다. 이번 실행 증거와 한계는 [로컬 검증 기록](evidence/2026-10-29-local-validation/README.md)에 연결한다.

허가되어도 flash/COM/실제 BLE·장비·기존 DB adoption/backup·운영 서비스/CSE 통합은 자동 포함되지 않는다. 서버/장비/원문/중앙 계약이 없을 때 승인 응답·측정값·영상·gate receipt를 만들어 채우지 않는다. 전체 goal은 완료가 아니다.
