# KEYRING 인수인계 — 남호

2026-10-29 업데이트: 저장소 최신 DOC-REV 2.0.0과 CORE `91a281b`를 인수했다. oneM2M/SDT/topic/DB는 PC-MOBIUS-CORE, commands/authorize/credential와 grant/claim/epoch는 PC-MOBIUS-INTEGRATION에 연결한다. [상세 CORE 차이 및 변경 제안](../keyring/CORE_INTEGRATION.md)에 BLE UUID 변경, sequence 유지, 승인 필드 누락, CORE ty/op 불일치를 기록했다. 원본 팀 구현은 보존했다.

기준 문서: `PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md` · DOC-REV: `2.0.0` · 계약 후보: `0.1.0` · 브랜치: `codex/keyring-namho`

2026-10-29 사용자 허가로 기본/ST7789/JD9853 compile profile 세 개와 Gateway 모의 단위 테스트37개가 통과했다. source3c27f4d를 역할 브랜치에 업로드했다. [원본 로그·receipt·산출물 hash](../keyring/evidence/2026-10-29-local-validation/README.md)에 범위와 한계를 기록한다. flash·실제 장비·기존 DB·운영 서비스·Pi/CSE 통합은 실행하지 않았다.

2026-10-30 Gateway0.2.1에서 BLE 연결 세대별 callback과 command WRITE를 분리했다. 재접속 회귀5개를 추가했고 소스·설치 wheel 각각42개가 통과했다. [수정 규칙](../keyring/raspberry-pi-gateway/BLE_SESSIONS.md)과 [실행 증거](../keyring/evidence/2026-10-30-ble-sessions/README.md)를 연결한다.

2026-10-30 Gateway0.2.2에서 native 재시도 중 완료한 CORE ACK를 재생성하는 오류를 수정했다. 소스·설치 wheel 각47개 시험 통과, DB schema 변경 없음. [경로 규칙](../keyring/raspberry-pi-gateway/RECEIPT_ROUTING.md)과 [실행 증거](../keyring/evidence/2026-10-30-receipt-routing/README.md)를 연결한다.

2026-10-30 [로컬 HTTPS/TLS8개](../keyring/evidence/2026-10-30-https-tls/README.md)를 추가했다. 소스·기존 설치0.2.2 wheel 각55개 통과. 실제 임시 PKI·loopback TLS/HTTP를 사용했으며 운영 CSE·MQTT·장비에 접속하지 않았다.

## 구현 범위와 상태

| 영역 | 전달물 | 현재 상태 |
|---|---|---|
| 하드웨어 연결 | 기존 r18 PCB 및 최신 핀맵을 연결하는 [PCB 문서](../keyring/pcb/README.md) | r18 native 원본 snapshot·로컬 CAD·기존 BOM/배선표 포함. PCB 재설계·제조·조립·새 검증은 하지 않음 |
| 펌웨어 | [ESP32-S3 소스와 설정](../keyring/firmware/README.md) | 소스 작성, 빌드·flash·장비 실행 미실행 |
| 화면·음향·SD | [두 LCD 프로필, MAX98357A cue, SD receipt 복사](../keyring/firmware/PERIPHERALS.md) | keyring-0.4.0 선택형 구현. JD9853 구매 모듈 초기화·실물 표시·부하 미확인 |
| 공급 전원 계측 | [INA219·BLE detail·화면·Gateway 연결](../keyring/firmware/POWER_MONITOR.md) | keyring-0.6.0 소스 작성. 실물 calibration·전류·전력/배터리 수명 측정 미실행 |
| DAC 대기 상태 | [MAX9850 종료 요청·공유 I2S guard](../keyring/firmware/HEADPHONE_STANDBY.md) | keyring-0.7.0 소스 작성. 실제 mute/전류/음향 미검증. 헤드폰 재생 미구현 |
| BLE | identity / observation / command / receipt UUID와 fragmentation | 구현 계약 작성, pairing·notify·reconnect 미검증 |
| Gateway | [daemon 및 설치 안내](../keyring/raspberry-pi-gateway/README.md) | 소스 작성, Raspberry Pi 배포·실행 미실행 |
| 권한·연속성 | 중앙 승인, epoch/deadline, 중복·journal·queue 처리 | 구현 작성, 중앙 정책과 장애 시나리오 미검증 |
| journal 보관 | [읽기 전용 snapshot·보관 CLI](../keyring/JOURNAL_RETENTION.md) | keyring-0.5.0 소스 작성. 실제 보관/정산·reclaim 미실행, 중앙 계약 필요 |
| Gateway 상태 | [binding·cold snapshot·legacy adoption](../keyring/raspberry-pi-gateway/STATE_RECOVERY.md) | Gateway0.2.0 모의 단위 테스트에서 임시 SQLite backup/adoption·격리 확인. 실제 POSIX CLI·기존 DB migration/backup 미실행. 복구 활성화는 중앙 checkpoint 계약 후 구현 |
| 전송 | MQTT 3.1.1 및 mTLS HTTPS, oneM2M 응답 판정 | 구현 작성, Mobius capability probe 미실행 |
| 계약 | [JSON Schema](../contracts/keyring/README.md)와 [전송 계약](../keyring/INTERFACE_NOTES.md) | 후보 계약. canonical revision 합의 전 |
| 공개 증거 | 시험 receipt, 로그 hash, 실물 영상, release manifest | 로컬 빌드·모의 테스트 로그/hash 생성. 실물·통합·영상·release 미완료 |

## PC-MOBIUS에 전달할 계약

KEYRING은 중앙 command 전체의 hash를 BLE 명령과 receipt에 유지한다. PC는 `commandId`, `deviceId`, `claimId`, `grantRevision`, `ownershipEpoch`, `payloadHash`가 동일한 승인 응답을 제공해야 한다. allowed 응답에도 짧은 expiry를 두고 dispatch와 revoke의 경계를 중앙에서 정해야 한다. Gateway의 승인 조회만으로 동시 회수 race가 완전히 해결되지는 않는다.

중앙에서 준비할 항목은 다음과 같다.

1. Gateway별 mTLS credential 발급·등록, CA, rotation revision 및 LOST/REVOKED 처리.
2. `/api/v1/gateways/{gatewayId}` 아래 commands, authorize, credentials/status API의 경로·응답·실패 규약 확정.
3. Gateway AE와 observation/receipts/health container, ACP, Originator binding, broker ACL 생성.
4. MQTT request/response topic, QoS·session 정책, `rvi`, HTTP 오류 및 `rsc` 매핑을 capability probe 결과로 고정.
5. Group/fan-out command를 장치별 명령으로 분리하고 receipt를 member 결과와 연결. `cod:binSh/state` 및 앱·웹의 상태 정본 갱신.
6. CSE contentInstance의 같은 이름 충돌 시 기존 payload를 조회할 READ 권한 제공. payload가 다르면 성공으로 정산하지 않음.
7. Gateway 재시작·명령 재조회 시 receipt 도착 전의 미정산 명령을 다시 전달. GET만으로 pending 명령 삭제 금지.

앱·웹은 `APPLIED`, `REJECTED`, `TIMEOUT`, `INDETERMINATE`를 구분해 표시해야 한다. gateway-estimated 시각을 장치의 정확한 UTC 측정값으로 표시하지 않는다. BLE RSSI는 거리나 MEC 위치값과 별도 필드로 취급한다.

## 하드웨어 및 배포 제한

기존 로컬 r18 손납땜 보드가 전제다. 자세한 자산 경로와 핀 출처는 PCB 문서에 남겼다. PCB·부품 BOM·조립 revision을 이번 구현 저장소에서 새로 완성했다는 뜻은 아니다. 인계용 원본 snapshot을 저장소에 포함했다. 실제 조립본의 revision 식별과 제조 release는 별도로 맞춰야 한다.

현재 binarySwitch의 대상은 진동 GPIO이다. readback은 GPIO 출력 수준이며 물리적 진동 검출이 아니다. 충전 제어·충전 LED는 보드 하드웨어 경로를 따른다. 배터리 보정, 센서 정확도, 전력·범위, 제품 수준의 사용자 피드백은 실물 수용 단계에서 다룬다.

장치 journal은 중복 실행을 피하기 위해 유한한 저장소가 찼을 때 새 명령을 거절한다. 임의 삭제·재등록으로 과거 commandId의 재실행을 허용하면 안 된다. 현장 수명에 맞는 journal 보존·폐기 정책은 중앙 명령 보존 기간과 함께 확정해야 한다.

## 제안 수용 항목 — 전부 미실행

아래 KR ID는 KEYRING 내부 추적용 신규 ID다. 원문 A01~A26의 개별 정의를 받지 않았으므로 임의로 번호를 대응시키지 않았다. 사용자가 해당 시험을 명시적으로 요청한 뒤 실행하고 실제 결과와 receipt를 기록해야 한다.

| ID | Rubric / gate 연결 | 확인할 내용 | 실제 결과 |
|---|---|---|---|
| KR-BLE-01 | R02, R03 / G-RELEASE | 지정 장치 pairing, identity 불일치 거절, MTU 23 fragmentation | 미실행 |
| KR-OBS-01 | R02, R15 / G-RELEASE | 버튼 debounce, 배터리·센서 오류 null, sequence·boot 중복 처리 | 미실행 |
| KR-CMD-01 | R01, R11 / G-SDT | 승인 명령 적용, GPIO readback, 자동 OFF 후 새로운 관측 | 미실행 |
| KR-SEC-01 | R10 / G-SEC | 만료·회수·다른 claim·hash·epoch의 실행 거절 | 미실행 |
| KR-JOURNAL-01 | R01, R12 / G-CONT | 동일 ID 재전송, 다른 hash 충돌, 전원 차단과 journal full | 미실행 |
| KR-QUEUE-01 | R02, R12 / G-CONT | broker/Gateway 재시작, 저장 queue 재전송, oneM2M 응답 유실 | 미실행 |
| KR-TRANSPORT-01 | R02, R10 / G-SEC | MQTT ACL·mTLS, HTTPS fallback, 동일 rn 충돌의 content 비교 | 미실행 |
| KR-HANDOVER-01 | R12 / G-CONT | 중앙 ownership epoch 전환과 이전 owner의 실행 차단 | 미실행 |
| KR-DEVICE-01 | R02, R05 / G-RELEASE | 조립 revision, 실제 전력·BLE 범위·재연결 측정 | 미실행 |
| KR-DEMO-01 | R03, R05 / G-SUBMIT | 키링→Gateway→CSE→앱·웹 흐름과 5분 미만 실물 영상 | 미실행 |

시험 수행자는 명령, 기대 결과, 실제 결과, hostId, firmware/board revision, runtime digest, 시간, 로그 경로와 SHA256을 함께 남겨야 한다. 현재 로그·실측값·receipt hash는 없으며 수용 gate를 통과했다고 표시하지 않는다.

이번 작업은 코드와 계약 작성까지다. **검증·빌드·실행 미실행.**
