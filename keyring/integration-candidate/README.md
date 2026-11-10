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

## 발행 당시 epoch를 보존하는 MQTT 수신 후보

Gateway 0.2.12에서 `CORE_TELEMETRY_EPOCHS`에 중앙이 부여한 장치별 epoch를 설정하면, 관측을 SQLite에 넣는 트랜잭션에서 epoch도 함께 기록한다. 재시도와 재기동은 저장된 epoch로만 `privacy-bubble/gateway/{gatewayId}/telemetry-epoch/{deviceId}/{epoch}`에 발행한다. 본문에는 CORE v1 telemetry를 그대로 보낸다. 활성 설정에 속하지 않는 행은 SQLite에 남기며 최신 epoch의 전송 순서를 막지 않는다. 보류 행은 전체 outbox 용량에 포함된다. 0.2.15의 [수동 보관 절차](../raspberry-pi-gateway/STATE_RECOVERY.md#종료된-core-epoch-보관)에서 종료된 범위를 정리할 수 있다.

[수신 어댑터](core-telemetry-ingress.mjs)는 신뢰한 브로커의 구독 콜백에서 사용한다. 토픽에서 Gateway·장치·epoch를 읽고 본문의 Gateway·장치와 대조한다. retained replay와 본문으로 전달된 epoch는 거절한다. 정본 장치 → SDT 매핑과 현재 소유권을 순서 제어 함수에 전달한다. `apply`는 SDT·Gateway·장치·epoch·sequence에 결속된 `requestId`를 받아 CSE 요청 ID와 중복 판정에 사용한다. 실제 CSE UPDATE 응답이 확인됐을 때 `APPLIED`를 반환해야 한다.

브로커 설정에서는 등록된 각 mTLS 주체가 중앙에서 지정한 **정확한 토픽 하나**에만 쓰도록 한다. 장치나 epoch에 대해 wildcard 쓰기 권한을 부여하면 토픽을 소유권 근거로 사용할 수 없다. 예를 들어 Gateway 인증서 사용자 `bench-gw-a`가 장치 `kr-01`의 epoch 7을 소유한다면 다음처럼 배정한다.

```conf
user bench-gw-a
topic write privacy-bubble/gateway/gw-a/telemetry-epoch/kr-01/7

user bench-core
topic read privacy-bubble/gateway/+/telemetry-epoch/+/+
```

익명 listener, 브리지나 다른 경로에서도 같은 namespace에 발행할 수 없어야 한다. 현재 Mobius4 개발 프로필의 내부 익명 listener에는 이 수신 후보를 연결하지 않는다. 브로커가 retained publish도 차단해야 하며, 같은 SDT를 갱신하는 기존 unscoped 구독 경로는 전환 전에 종료한다. 중앙이 이전 writer의 전송을 종료하고 미확정 UPDATE를 처리한 뒤 새 ACL과 소유권을 배정한다. 기존 메시지에 새 epoch를 다시 붙이지 않는다.

[격리 개발 프로필](../dev/mobius4/README.md#epoch-전용-mqtt-프로필)에서 중앙 소비자를 mTLS 브로커에 연결했다. 실제 두 Gateway 인증서의 토픽 ACL 격리, 교체 전 지연 메시지, SQLite 재기동과 CSE readback은 별도 시험으로 확인해야 한다. 앞선 동시 갱신 시험에는 시험용 소유권을 공급했다.

## Epoch 관측의 적용 영수증

Gateway 0.2.14는 `privacy-bubble/gateway/{gatewayId}/telemetry-result/{deviceId}/{epoch}`를 QoS 1로 구독한다. 브로커 ACL은 중앙 소비자에게만 해당 토픽의 쓰기를, 해당 Gateway 인증서에는 읽기를 허용한다. 중앙은 Mobius4의 UPDATE 응답 2004와 RQI를 확인하고 SDT cursor를 `APPLIED`로 저장한 뒤 [영수증](../../contracts/keyring/core-telemetry-receipt.schema.json)을 발행한다. 영수증에는 원래 관측 본문의 바이트 해시, Gateway·장치·epoch·sequence, CSE 요청 ID를 넣는다.

Gateway는 기다리는 토픽·식별자·sequence·해시가 일치하는 영수증을 받아야 outbox 행을 완료한다. 응답 유실과 timeout은 SQLite 재시도로 이어진다. 중앙에 같은 epoch·sequence·해시의 적용 기록이 있으면 UPDATE를 다시 보내지 않고 영수증을 재발행한다. 같은 sequence의 다른 본문, 이전 epoch, 해시가 없는 이전 형식의 cursor, `PENDING` cursor에는 적용 영수증을 발행하지 않는다. 새 cursor가 저장된 뒤 이전 기록에 대한 개별 조회나 재발행은 제공하지 않는다.

Scoped 관측 전송 작업자는 일반 관측과 명령 영수증 작업자와 분리된다. 격리 프로필에는 중앙 소비자와 응답 ACL을 배치했다. Gateway 0.2.14 빌드와 영수증 발행 시험은 아직 실행하지 않았다. [배치 기록](../evidence/2026-11-10-core-scoped-receipt-rollout/README.md)

## SDT 적용과 소유권 전환

`receive.transition(expected, replacement)`는 원래·새 Gateway의 장치 ID와 단조 증가 epoch를 확인한 뒤 해당 SDT의 갱신과 같은 대기열에 들어간다. 앞서 접수한 갱신이 끝나야 전환을 검토한다. 저장된 cursor가 `PENDING`이면 보류하고, 현재 소유권이 예상값과 일치할 때만 `compareAndSetOwner`가 교체 값을 영속 저장한다. 저장 결과가 불확실하면 해당 자원의 다음 관측도 보류한다.

운영에서는 동일 자원의 모든 UPDATE와 소유권 변경이 이 전환 경계를 공유해야 한다. `compareAndSetOwner`는 중앙 저장소에서 이전 소유권을 원자적으로 비교하고 커밋해야 한다. 여러 writer·Edge에서 공유하는 정본의 fencing, grant 및 구독 복원은 팀 handover coordinator가 맡는다. 격리 프로필은 단일 소비자와 팀 파일 저장소를 사용하며 컨테이너 재기동 이후에도 소유권을 읽는 구조다. 전원 차단 복구와 실제 전환은 별도 검증 범위다. [격리 전환 명령](../dev/mobius4/README.md#격리-소유권-전환)
