# 중앙 발급 명령과 실제 Gateway 영수증 결속 후보

DOC-REV 2.0.0 · KEYRING / 남호.

팀 main `715ef58`의 중앙 HTTP 발급은 명령을 `gatewayCommands`에 저장한다. CORE `GatewayBridge.handleAck`는 별도의 메모리 명령 목록을 읽는다. 두 경계 사이에 공유 조회가 필요하다. KEYRING의 [결속 검증 함수](receipt-binding.mjs)는 중앙에 저장된 발급 기록과 당시 허용 응답, CSE에서 읽은 native receipt를 대조한다. 기존 CORE ACK가 함께 들어오면 원본 receipt 및 적용 시점 readback과 일치해야 한다.

| 입력 | 정본 |
|---|---|
| `trustedGatewayId` | 중앙의 인증된 Gateway 또는 CSE receipt 컨테이너 ACL에서 매핑한 발행자 |
| `commandRecord` | 중앙 `gatewayCommands`의 발급 시점 `command`, `payloadHash` |
| `authorization` | 같은 명령의 실제 실행 승인 기록. 승인 여부, claim, grant revision, ownership epoch, payload hash, expiry 사용 |
| `receipt` | [KEYRING 영수증 스키마](../../contracts/keyring/receipt.schema.json)를 통과한 native cin `con` |
| `ack` | 선택 항목. CORE MQTT `READBACK_VERIFIED`와 그 안의 `gatewayReceipt` |

소비자가 신뢰한 발행자, 중앙 명령과 payload hash, 승인 binding을 확인한 후 `APPLIED` 또는 성공한 `DUPLICATE`의 GPIO readback을 발급 상태와 비교한다. 함수 결과는 결속 확인에 사용할 gateway/device/command ID, hash, readback 값이다. 도착 시간이 늦어진 영수증은 당시 승인 기록으로 판정하며, 현재 grant를 다시 승인해 과거 실행에 붙이는 방식은 쓰지 않는다. 적용 시각이 Gateway 추정치이거나 없는 경우가 있으므로 권한 회수와 실행 사이의 엄격한 시각 판정은 중앙 승인·lease 계약에 맡긴다.

CORE/INTEGRATION의 실제 연결은 발급 기록과 실행 승인 기록을 인증된 수신 처리에 공급하고, `gatewayId + commandId`와 원본 hash로 재전송을 원자적으로 정산해야 한다. 실패·미확정 영수증의 표시와 retry 정책도 중앙 계약이 필요하다. 테스트에서는 중앙 코드의 실제 입력과 결과를 확인했고, 운영 ACK 수신 경로에는 후보 함수 연결과 영속 정산이 남아 있다.

[실행 결과](../evidence/2026-11-10-core-ack-binding/README.md)
