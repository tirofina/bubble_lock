# KEYRING 완료 조건과 남은 증거

ROLE KEYRING / 남호 · DOC-REV2.0.0 · 2026-10-30.

최신 루트 계획서의 담당 산출물·7개 완료 자료·첫 통합 조건을 firmware0.7.0/Gateway0.2.3의 현재 소스와 실행 evidence에 대조했다. main/CORE91a281b·WEB80ed37f 기준이다. 로컬 구현·빌드·시험은 확보했으며 실물 Pi/키링과 중앙 통합·release는 미완료다.

현재 [실제 Mobius4/영속 큐10개](evidence/2026-10-30-outbox-cse/README.md)가 소스·설치본에서 각각 통과했다. 직전 [기본56개·MQTT6개·CSE5개](evidence/2026-10-30-real-cse/README.md)와 [firmware3개 프로필](evidence/2026-10-29-local-validation/README.md)은 당시 증거로 유지한다. 현재 CSE10개는 기존5개와 추가영속큐5개를 포함한다.

현재 [Linux POSIX10개](evidence/2026-10-30-posix-state/README.md)도 소스/설치본에서 각각 통과했다. 실제 flock/fsync·0700/0600·WAL·새 합성 legacy CLI adopt·ENOSPC·동시 변경 감지를 확인했다. Pi/운영 DB·중앙 복구 활성화 증거는 남아 있다.

## 담당 산출물

| 계획서 요구 | 현재 자료/실행 증거 | 남은 작업·입력 |
|---|---|---|
| KiCad schematic/PCB/BOM/assembly revision | [r18 snapshot/inventory](pcb/r18/README.md), [핀 정정](pcb/HARDWARE_FIRMWARE_MAP.md), 원본222개 파일 보존 | 실제 조립 revision·배선·부품·패널 식별과 실물 수용 |
| firmware source/build/flash 명령 | [소스](firmware/README.md), [기본/ST7789/JD9853 빌드3개](firmware/BUILD_PROFILES.md), 도구 revision·artifact hash | 실물 설정 build/flash·동작 결과. 현재3개는 unprovisioned compile |
| GATT/profile/payload schema | [인터페이스](INTERFACE_NOTES.md), [schema](../contracts/keyring/README.md), [BLE 세션 회귀](evidence/2026-10-30-ble-sessions/README.md) | CORE 확장 수용과 실제 pairing/identity/fragment/reconnect |
| sensor/button/LED/battery/charger | [센서/GPIO](firmware/README.md), [INA219](firmware/POWER_MONITOR.md), [주변장치](firmware/PERIPHERALS.md), [DAC standby](firmware/HEADPHONE_STANDBY.md) | calibration/오류/wake/출력·전력 측정·구매 JD9853 init/geometry. LED·충전·온도 gate는 하드웨어 경로 |
| Raspberry Pi Gateway daemon | [설치/config/systemd](raspberry-pi-gateway/README.md), Gateway0.2.3 wheel build/install·소스 일치 | 실제 Pi/BlueZ·장치·인증서 배포와 daemon startup/runtime |
| MQTT/HTTPS transport | 실제 TLS/mTLS·ACL6개, 실제 Mobius4 HTTPS/MQTT3주소 범위 저장/조회, duplicate/conflict/CSE restart | 운영 principal→AE/Originator·ACP/grant·capability 합의. 개발 admin mapping은 승인 증거가 아님 |
| queue/dedup/ACK/readback | SQLite reopened queue·CSE 중단/backoff/recovery·원격 commit 뒤 자식 송신 프로세스 exit73/WAL 복구·native receipt 확인 플래그·충돌 원본 보존 | Linux 실제 상태 CLI10개도 확보. 실제 장치 ACK/readback·Pi 전원 손실·운영 DB·중앙 settlement/checkpoint·journal reclaim·복구 승인/활성화 |
| power/range/reconnect/command 시험 | 모의 BLE·기한/fence/명령 회귀와 실제 로컬 전송 복구 | 실제 전원·BLE 거리·명령·회수·journal 장애·재연결 측정 |
| PCB·Gateway·앱 연동 영상 | 코드/config/로컬 실행 로그·hash | 실제 Pi→CSE→앱/웹·5분 미만 영상·공개/제출 evidence |

헤드폰 playback·OTA/secure boot/flash encryption·중앙 승인 복구 활성화는 미구현 목록에 유지한다. 원래 완료 조건을 이 목록으로 축소하지 않는다.

## 계획서의7개 완료 자료

1. 계약: KEYRING 후보 schema와 CORE v1 adapter가 있다. INTEGRATION 승인/정산/복구와 확장 수용은 미확정이다.
2. 코드/configuration: 역할 브랜치에 업로드했다. 실물 Pi·장치 설치/runtime은 남아 있다.
3. 단위/통합/장애 시험: firmware3개 build, 기본56개, MQTT6개, 현재 실제 CSE/영속큐10개와 Linux POSIX10개 증거를 확보했다. 실제 Pi/BLE·중앙 통합·전원 손실은 남아 있다.
4. 기대/실제 결과: 로컬 로그·delivery facts·hash를 보존했다. 합성 payload와 test worker를 실물 수행으로 표시하지 않는다.
5. 수행/승인/gate: owner 남호/KEYRING·로컬 수행 환경을 기록했다. approver는 null이며 중앙 gate 승인·A01~A26의 원래 정의/매핑은 미확정이다.
6. 로그/receipt/hash: source·CAD inventory·firmware/wheel·TLS/MQTT/CSE/queue의 실제 로그와 hash가 있다. 실물/E2E·전력/거리·영상은 남아 있다.
7. release manifest: release SHA는 null이다. 독립 검토·중앙 승인·실물 통합과 공개 제출 evidence 뒤에 확정해야 한다.

## 첫 통합 데모 조건

계획서가 요구하는 BLE→실물 Pi→CSE의 pb:binarySwitch/state 저장, 앱 승인 Group 명령, 장치 ACK/readback, 웹 시각 표시, 최신 grant 회수 판정, MEC callback, 동일 commandId receipt 정산은 전체 경로로 아직 검증되지 않았다. 현재 일반 cin 저장·합성 receipt/outbox 시험은 그 일부 전송 경계다. 중앙 command의 누락된 claimId/grantRevision을 임의로 채우지 않는다.

## 지정 원문

현재 저장소와 원래 작업공간 root의 아래 정확한 상대 경로를 다시 조회했으며 모두 미발견이다. 다른 PC/이름/원격의 부재를 뜻하지 않는다.

| 경로 | 영향 |
|---|---|
| proposal_work/red_blue_green/blue/contracts_round03.json | A01~A26 정의·계약 번호를 추측하지 않음 |
| deliverables/privacy_bubble_expert_v3/active_release.json | 원래 release 연결표/승인 미인수 |
| references/hackathon_2026/extracted/Hackathon Rubric 2026.txt | 세부 원문 미인수. 현재 루트 역할/Rubric 표 적용 |

KR-*는 KEYRING 제안 시험 ID다. 원문 인수 후 실제 정의에 맞게 매핑한다.

## 다음 단계

기존 async 질문의 Pi SSH 별칭/주소와 보드·패널 준비 상태 답변을 기다린다. 비밀번호/개인키를 받지 않는다. 중앙 INTEGRATION 승인·정산·복구 계약, 구매 JD9853 모듈 초기화 자료, 지정 원문과 실제 시험 대상을 확보해야 한다. flash·COM·실제 BLE/장비·기존 DB·운영 서비스는 현재 로컬 시험 허가에 포함되지 않는다. 로컬 개발은 최신 사용자 AGENTS의 관련 빌드·시험 요구에 따라 검증한다.
