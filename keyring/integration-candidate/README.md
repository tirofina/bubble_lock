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

## Handover 뒤 활성 Gateway 검증

팀 main `715ef58`은 전환 전 epoch의 명령을 거절한다. 같은 장치를 가진 두 Gateway 등록이 모두 유효하면 전환 뒤 이전 Gateway에도 현재 epoch의 새 명령을 발급하고 승인할 수 있다.

[활성 Gateway 확인 함수](handover-owner.mjs)는 handover 관리 장치에 대해 중앙의 등록 정보, handover 기록의 장치·상태·epoch, 서버 설정의 Edge → Gateway 매핑을 함께 확인한다. 관리 장치에는 초기 소유 Edge를 명시적으로 등록한다. `ACTIVE`와 `ROLLED_BACK`은 실제 `edgeId`를 사용한다. `DRAINING`, 기록·매핑 부재, 대상 장치 불일치에는 승인을 보류한다. Gateway 한 대가 여러 장치를 맡을 수 있어 대상 장치 기준으로 판단한다.

후보는 중앙 `GatewayControl.active`의 현재 grant·인증서·기한 검사에 추가하는 조건이다. 이 위치에서 발급·목록·실행 직전 승인에 같은 소유권 검사가 적용된다. 시험은 별도 Edge 이름 두 개와 Gateway 인증서 두 개를 사용하고, Edge마다 활성 Gateway 한 대를 명시했다. 운영 연결에서는 팀이 정본 매핑과 초기 소유권을 공급해야 한다. 이미 내려간 승인과 전송 중 BLE 명령의 처리에는 중앙의 drain·원자적 승인 계약이 필요하다.

[mTLS 재현 기록](../evidence/2026-11-10-handover-owner/README.md)

## CORE 관측의 동시 갱신

팀 main `715ef58`의 CORE 브리지는 같은 장치의 서로 다른 sequence를 동시에 처리한다. 먼저 받은 ON 요청이 지연되면 최신 OFF가 CSE에 저장된 뒤 옛 ON이 덮어쓸 수 있다. [관측 순서 후보](core-telemetry-order.mjs)는 동일한 SDT 경로의 갱신을 하나씩 실행하고, 현재 소유권과 영속 sequence를 확인한다. 이전 epoch와 적용된 sequence 이하를 차단한다. 전송 전 `PENDING`을 저장하고 CSE 적용이 확인된 뒤 `APPLIED`로 전환한다. 응답이나 저장 결과가 불명확하면 해당 자원의 후속 갱신을 보류한다.

| 연결 입력 | 정본 |
|---|---|
| `resource` | 서버 라우팅 설정에서 확정한 정규 SDT 경로 |
| `source` | 인증된 Gateway와 원래 수신 경로에 결속된 장치 ID·소유권 epoch |
| `readOwner` | 중앙의 현재 활성 Gateway·장치·epoch |
| `readCursor` / `writeCursor` | 자원별 영속 순서 기록. 저장 완료와 불명확한 결과를 구분해야 함 |
| `apply` | CSE 적용 결과를 확인하는 호출. MQTT PUBACK은 적용 확인으로 쓰지 않음 |

운영 연결에는 같은 자원을 갱신하는 단일 실행 주체와 handover drain, 또는 여러 실행 주체를 조정하는 중앙 차단 장치가 필요하다. 기존 CORE v1 메시지에는 epoch가 없으므로 대기 메시지에 현재 epoch를 붙이면 이전 소유자의 관측을 구별할 수 없다. 발행자와 원래 epoch를 수신 경로에서 함께 확인하고, 기존 CORE의 중복 키도 epoch와 자원 범위에 맞춰야 한다. 미확정 갱신은 CSE와 영속 기록을 대조한 뒤 같은 자원의 처리 재개 여부를 결정한다.

[격리 Mobius4 재현](../evidence/2026-11-10-core-concurrent-order/README.md)
