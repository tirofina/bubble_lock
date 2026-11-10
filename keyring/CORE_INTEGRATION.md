# CORE·Gateway 통합 계약

DOC-REV 2.0.0 · 2026-11-10 · Gateway 계약 1.0.0.

중앙 통합 이력 `413fd31`·`191b603`과 키링 역할 브랜치 `686f7b4`를 연결했다. BLE 탐색 취소, BlueZ READ/notification 순서 수정, Feather·실제 Pi 관측 증거를 함께 보존한다.

## 관측과 명령

기본 `core-v1` BLE UUID와 키링 identity 확장을 사용한다. Gateway는 실제 battery/RSSI가 있는 관측을 CORE telemetry로 투영하고 bootId·firmwareSequence·gatewayId·timestampSource를 보존한다. nullable 원본 관측은 native oneM2M CIN에 저장한다.

CORE는 HTTP PUT 또는 MQTT UPDATE `op=3`, `rvi=4`로 binarySwitch 상태를 전송한다. MQTT To는 CSE/SP/절대 주소 범위를 변환하며 UPDATE 완료 코드 `2004`를 사용한다. flexContainer와 Group member type은 `28`이다.

중앙 `GatewayControl`은 현재 consent/grant와 등록 장치를 연결해 canonical command를 발급한다. 명령의 `version`, `gatewayId`, `deviceId`, `commandId`, `claimId`, `desiredState.state`, `issuedAt`, `deadline`, `grantRevision`, `ownershipEpoch`를 CORE `sendCommand(command)`와 Group `memberCommands`에 보존한다. canonical hash와 전송 입장 generation은 중앙 기록·lane·outbox에서 같은 명령에 결속한다.

## Gateway API

| 경로 | 동작 |
|---|---|
| `GET /api/v1/gateways/{id}/credentials/status` | 인증서 revision·ACTIVE/LOST/REVOKED 상태 |
| `GET /api/v1/gateways/{id}/commands?limit=16` | 현재 유효한 canonical 명령 최대 16개 |
| `POST /api/v1/gateways/{id}/authorize` | command·claim·grant·epoch·hash·기한 재확인 |
| `POST /api/v1/gateways/{id}/dispatch-start` | 영속 intent 기록 후 BLE 전송 직전 현재 claim·전송 입장 확인 |
| `POST /api/v1/gateways/{id}/receipts` | epoch·revision·hash·readback을 검증한 결과 정산 |
| `POST /v1/gateways/{id}/commands` | `bubble:command` 권한 소유자의 명령 발급 |

`/api/v1`과 `/v1` Gateway 경로는 같은 계약을 제공한다. Gateway 인증서는 principalId·fingerprint·등록 gatewayId에 결속된다. 승인 응답은 `contracts/keyring/authorization.schema.json`, 상태 응답은 `credential-status.schema.json`을 따른다. 등록과 LOST 수명주기는 [Gateway 등록](../pc-mobius/integration/GATEWAY_REGISTRATION.md)에 정리한다.

## 영수증과 재시도

CORE는 중간 RECEIVED/FORWARDED ACK를 대기 상태로 유지하고 device·grant·epoch·readback이 일치하는 READBACK_VERIFIED에서 완료한다. MQTT publish 중 도착한 즉시 ACK/oneM2M 응답도 처리한다. Group 재시도는 중앙에서 발급한 원래 명령을 보존한다.

Gateway native receipt, CORE ACK, 중앙 receipt outbox는 SQLite 원자 staging과 독립 재시도를 사용한다. broker PUBACK은 broker 수신 증거, 중앙 oneM2M 처리 영수증은 정책·장치 결과 증거로 기록한다. 웹은 CORE와 통합 서비스 receipt를 같은 JSONL에서 읽는다.

## 검증과 인계

`npm run verify`에서 Python Gateway와 Node 중앙 API를 실제 TLS 1.3/mTLS로 연결한다. 명령 조회, Python/JS canonical hash, 승인·전송 입장, 최종 영수증, grant 회수, 인증서·범위, Panic 사건·위치 lease와 회귀시험을 실행한다.

기존 [Feather·Pi 실물 증거](evidence/2026-11-10-pi-feather/README.md)는 화면 유지, 인증된 BlueZ 연결, 버튼 관측을 기록한다. 초기 observation READ를 notification 구독 전에 완료해 READ echo와 알림 조각의 경계를 보존한다. 전체 신규 통합 경로의 실물 실행은 [외부 실증 TODO](../docs/external-validation-todo.md)로 관리한다. 임시·교체 CSE 설정은 [Mobius4 환경](dev/mobius4/README.md)을 따른다.
