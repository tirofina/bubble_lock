# KEYRING 완료 조건과 남은 증거

ROLE KEYRING / 남호 · DOC-REV2.0.0 · 2026-11-10.

Gateway 0.2.5는 Pi 임시 사용자 systemd에서 실제 Feather 관측 27개와 상태 16개를 격리 Mobius4에 저장했다. 재시작 전 대기 관측 한 건의 payload도 CSE에서 일치했다. 기본 63개와 모의 GATT 명령 통합 2개는 앞선 별도 시험 결과다. 실제 명령·물리 출력, 배포용 systemd, CORE/앱/웹 정산은 남아 있다. [Pi 전체 데몬](evidence/2026-11-10-pi-full-daemon/README.md) · [중앙 명령 시험](evidence/2026-11-10-central-dispatch/README.md)

최신 루트 계획서의 담당 산출물·7개 완료 자료·첫 통합 조건을 ESP32-S3 firmware0.7.0, Feather 벤치0.1.1, Gateway0.2.4의 소스와 실행 evidence에 대조했다. 2026-11-10 원격 main `715ef58`, CORE `d54a43a`, WEB `80ed37f`를 확인했다. 화면·Feather·버튼 두 개와 실물 Pi의 BLE 연결, 버튼 입력·화면 유지, 90초간45개 관측 수신을 확인하고 `686f7b4`로 업로드했다. 실물 관측의 Pi→격리 Mobius4 저장·readback도 확보했으며 제작 PCB·전체 daemon·중앙 명령과 앱/웹·release는 미완료다.

최신 [Pi→CSE 실물 관측 증거](evidence/2026-11-10-pi-cse/)는 HTTPS 경로의5개씩3회 저장·readback 일치, CSE 중단 중 pending5개 보존 후 복구·전달5개, 정상 MQTT 전달5개·HTTPS fallback0개, broker 중단 후 MQTT0개·HTTPS fallback15개를 포함한다. 총35개 관측의 CSE readback이 일치했다. 이번 CSE 시험 관측은 모두 `released`이며 버튼 `confirm/panic`·화면·90초 연속 수신은 [Pi·Feather 증거](evidence/2026-11-10-pi-feather/README.md)에 별도로 남겼다. 시험은 새 관측 container·시험 인증서·새 Pi SQLite를 사용하며, 전체 Gateway daemon과 명령 실행 loop는 시작하지 않았다.

[2026-10-30 실제 Mobius4/영속 큐10개](evidence/2026-10-30-outbox-cse/README.md), [기본56개·MQTT6개·CSE5개](evidence/2026-10-30-real-cse/README.md), [firmware3개 프로필](evidence/2026-10-29-local-validation/README.md)은 당시 버전의 증거로 유지한다. CSE10개는 기존5개와 추가영속큐5개를 포함한다. 같은 시점의 [Linux POSIX10개](evidence/2026-10-30-posix-state/README.md)는 소스/설치본에서 실제 flock/fsync·0700/0600·WAL·새 합성 legacy CLI adopt·ENOSPC·동시 변경 감지를 확인했다. Pi 전원 손실·운영 DB·중앙 복구 활성화 증거는 남아 있다.

## 담당 산출물

| 계획서 요구 | 현재 자료/실행 증거 | 남은 작업·입력 |
|---|---|---|
| KiCad schematic/PCB/BOM/assembly revision | [r18 snapshot/inventory](pcb/r18/README.md), [핀 정정](pcb/HARDWARE_FIRMWARE_MAP.md), 원본222개 파일 보존 | 실제 조립 revision·배선·부품·패널 식별과 실물 수용 |
| firmware source/build/flash 명령 | [소스](firmware/README.md), [기본/ST7789/JD9853 빌드3개](firmware/BUILD_PROFILES.md), Feather0.1.1 실제 flash·부팅·버튼·화면 유지 | 제작 PCB의 provisioning·flash·동작 결과. ESP32-S3의 기존3개는 unprovisioned compile |
| GATT/profile/payload schema | [인터페이스](INTERFACE_NOTES.md), [schema](../contracts/keyring/README.md), [BLE 세션 회귀](evidence/2026-10-30-ble-sessions/README.md), 실제 Pi/Feather pairing·identity·fragment 수신과90초45개 관측 | 제작 PCB의 CORE 확장 수용·명령·재연결 수용시험 |
| sensor/button/LED/battery/charger | Feather의 두 버튼 입력·ST7789 화면 전환/유지 확인, [센서/GPIO](firmware/README.md), [INA219](firmware/POWER_MONITOR.md), [주변장치](firmware/PERIPHERALS.md), [DAC standby](firmware/HEADPHONE_STANDBY.md) | 제작 PCB의 센서 calibration/오류/wake/출력·전력 측정·구매 JD9853 init/geometry. LED·충전·온도 gate는 하드웨어 경로 |
| Raspberry Pi Gateway daemon | [설치/config/systemd](raspberry-pi-gateway/README.md), 실제 Pi에서 0.2.5 임시 사용자 systemd·BlueZ·시험 mTLS·재시작 | 배포용 systemd unit·실물 명령·운영 인증서/등록 |
| MQTT/HTTPS transport | 기존 TLS/mTLS·ACL6개와 Mobius4 주소 범위 시험, 실물 Pi 관측의 HTTPS5개씩3회·정상 MQTT5개·broker 중단 후 HTTPS fallback15개와 CSE readback 전체 일치 | 운영 PKI·principal→AE/Originator·ACP/grant·capability 합의. 시험 인증서·개발 mapping과 운영 승인 구분 |
| queue/dedup/ACK/readback | 기존 SQLite reopen·exit73/WAL 복구·충돌 보존과 Linux CLI10개, 실물 Pi에서 CSE 중단 중 pending5개 보존→복구 전달5개·관측 readback 일치 | 실제 장치 명령 ACK/readback·Pi 전원 손실·운영 DB·중앙 settlement/checkpoint·journal reclaim·복구 승인/활성화 |
| power/range/reconnect/command 시험 | 모의 BLE·기한/fence/명령 회귀, 실제 로컬 전송 복구, [Pi 거리·재연결 기록 도구 소스](raspberry-pi-gateway/TESTING.md#실물-ble-거리재연결-기록) | 실제 전원·BLE 거리·명령·회수·journal 장애·재연결 측정 |
| PCB·Gateway·앱 연동 영상 | 코드/config/로컬 로그·hash와 실제 Feather→Pi→CSE 관측 receipt | 제작 PCB→Pi→CSE→앱/웹·5분 미만 영상·공개/제출 evidence |

헤드폰 playback·OTA/secure boot/flash encryption·중앙 승인 복구 활성화는 미구현 목록에 유지한다. 원래 완료 조건을 이 목록으로 축소하지 않는다.

## 계획서의7개 완료 자료

1. 계약: KEYRING 후보 schema와 CORE v1 adapter가 있다. 원격 main에서 명령·승인·자격 상태 계약을 확인했고 로컬 mTLS 교차시험이 통과했다. 중앙 정산·복구 활성화와 실물 수용이 남아 있다.
2. 코드/configuration: 역할 브랜치에 업로드했다. 실물 Pi에 Gateway0.2.4를 설치하고 Feather0.1.1을 flash했다. 전체 daemon·제작 PCB 설치/runtime은 남아 있다.
3. 단위/통합/장애 시험: 기존 firmware3개 build, MQTT6개, CSE/영속큐10개, Linux POSIX10개, ARM64 Gateway 기본57개·중앙 mTLS 교차시험1개를 당시 증거로 유지한다. 실제 Pi/BLE 버튼·90초 연속 수신, HTTPS/MQTT 관측 저장·readback, CSE 중단·큐 복구, broker 중단 후 HTTPS fallback을 추가했다. 중앙 명령·앱/웹·Pi 전원 손실은 남아 있다.
4. 기대/실제 결과: 로컬 로그·delivery facts·hash와 실제 Pi 관측·CSE readback hash를 보존했다. 합성 payload 시험, 실물 관측 relay, 전체 daemon 시험을 구분한다.
5. 수행/승인/gate: owner 남호/KEYRING·로컬 수행 환경을 기록했다. approver는 null이며 중앙 gate 승인·A01~A26의 원래 정의/매핑은 미확정이다.
6. 로그/receipt/hash: source·CAD inventory·firmware/wheel·TLS/MQTT/CSE/queue와 실제 Feather/Pi 관측의 로그·hash가 있다. 제작 PCB·명령/앱/웹 E2E·전력/거리·영상은 남아 있다.
7. release manifest: release SHA는 null이다. 독립 검토·중앙 승인·실물 통합과 공개 제출 evidence 뒤에 확정해야 한다.

## 첫 통합 데모 조건

실제 Feather BLE→Pi→격리 Mobius4의 일반 cin 관측 저장·readback을 검증했다. 이 벤치는 화면·Feather·버튼 두 개를 사용하며 센서나 출력 장치는 연결하지 않았다. 계획서가 요구하는 pb:binarySwitch/state SDT 저장·제어, 앱 승인 Group 명령, 장치 ACK/readback, 웹 시각 표시, 최신 grant 회수 판정, MEC callback, 동일 commandId receipt 정산은 전체 경로로 아직 검증되지 않았다. 기존 합성 receipt/outbox와 중앙 mTLS 승인·회수 시험은 각 경계의 증거로 유지한다.

## 지정 원문

현재 저장소와 원래 작업공간 root의 아래 정확한 상대 경로를 다시 조회했으며 모두 미발견이다. 다른 PC/이름/원격의 부재를 뜻하지 않는다.

| 경로 | 영향 |
|---|---|
| proposal_work/red_blue_green/blue/contracts_round03.json | A01~A26 정의·계약 번호를 추측하지 않음 |
| deliverables/privacy_bubble_expert_v3/active_release.json | 원래 release 연결표/승인 미인수 |
| references/hackathon_2026/extracted/Hackathon Rubric 2026.txt | 세부 원문 미인수. 현재 루트 역할/Rubric 표 적용 |

KR-*는 KEYRING 제안 시험 ID다. 원문 인수 후 실제 정의에 맞게 매핑한다.

## 다음 단계

Pi Zero 2 W의 SSH·BlueZ·Feather 연결과 격리 CSE 관측 전송을 확보했다. 다음은 실물 관측을 기반으로 중앙 승인 명령·앱/웹을 연결하고, PCB 도착 후 센서·출력·전력·거리·명령 ACK/readback을 검증하는 단계다. 전체 daemon/systemd, 운영 PKI·AE·ACP/grant, 중앙 정산·복구 계약, JD9853 초기화 자료와 지정 원문도 남은 항목으로 추적한다. [Feather 벤치](firmware/feather_probe/README.md) · [Gateway 시험](raspberry-pi-gateway/TESTING.md)
