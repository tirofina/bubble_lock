# CORE·Gateway 통합 계약

DOC-REV 2.0.0 · 2026-11-10 · `codex/integrate-all-branches`.

## 관측과 명령

기본 `core-v1` BLE UUID와 키링 identity 확장을 사용합니다. Gateway는 실제 battery/RSSI가 있는 관측을 CORE telemetry로 투영하고 bootId·firmwareSequence·gatewayId·timestampSource를 보존합니다. nullable 원본 관측은 native oneM2M cin에 저장합니다.

CORE는 HTTP PUT 또는 MQTT UPDATE `op=3`, `rvi=4`로 binarySwitch 상태를 전송합니다. MQTT의 To는 CSE/SP/절대 주소 범위를 변환하며 UPDATE 완료 코드 `2004`를 사용합니다. flexContainer와 Group member type은 `28`입니다.

중앙 `GatewayControl`이 active consent/grant와 등록 장치를 연결해 canonical command를 발급합니다. 명령에는 `version`, `gatewayId`, `deviceId`, `commandId`, `claimId`, `desiredState.state`, `issuedAt`, `deadline`, `grantRevision`, `ownershipEpoch`가 포함됩니다. CORE `sendCommand(command)`와 Group의 `memberCommands`는 이 payload를 그대로 전달합니다.

## Gateway API

| 경로 | 동작 |
|---|---|
| `GET /api/v1/gateways/{id}/credentials/status` | 인증서 revision·ACTIVE/LOST/REVOKED 상태 |
| `GET /api/v1/gateways/{id}/commands?limit=16` | 현재 유효한 canonical 명령 최대 16개 |
| `POST /api/v1/gateways/{id}/authorize` | command·claim·grant·epoch·hash·기한 재확인 |
| `POST /v1/gateways/{id}/commands` | `bubble:command` 권한의 소유자가 명령 발급 |

`/api/v1`과 `/v1` Gateway 경로는 같은 계약을 제공합니다. Gateway 인증서는 principalId·fingerprint·등록 gatewayId에 결속됩니다. 승인 응답은 `contracts/keyring/authorization.schema.json`, 상태 응답은 `credential-status.schema.json`을 따릅니다.

## 영수증과 재시도

CORE는 중간 RECEIVED/FORWARDED ACK를 대기 상태로 유지하고 device·grant·epoch·readback이 일치하는 READBACK_VERIFIED에서 완료합니다. MQTT publish 중 도착한 즉시 ACK/oneM2M 응답도 처리합니다. Group 재시도는 중앙에서 발급한 원래 명령을 보존합니다.

Gateway native receipt와 CORE ACK outbox는 기존 SQLite 원자 staging·독립 재시도를 유지합니다. CORE projection의 broker PUBACK과 중앙의 oneM2M 처리 영수증은 각 경로의 증거로 기록합니다. 웹은 CORE receipt와 통합 서비스 receipt를 동일 JSONL에서 읽습니다.

## 검증

`npm run verify`에서 Python Gateway와 Node 중앙 API를 실제 TLS 1.3/mTLS로 연결합니다. 명령 조회, Python/JS canonical hash, 승인, grant 회수, 인증서 검증과 모듈별 회귀시험을 실행합니다. 장비 경로의 후속 검증은 [통합 실행 범위](../docs/branch-integration.md)를 따릅니다.
