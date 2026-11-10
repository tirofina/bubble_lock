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

## CSE 명령 영수증의 중앙 정산 후보

[CSE 원본 조회](receipt-native-source.mjs)는 중앙 설정의 Gateway별 전용 receipt 컨테이너와 `gw-<해시>` 하위 경로만 허용한다. Gateway의 `receipt:<commandId>` 요청 ID 규칙으로 자원명을 다시 계산하고 `m2m:cin`의 자원 ID와 생성 시각을 읽는다. 호출자가 고정된 CSE 주소에 인증하여 GET을 보내고 응답 RQI를 검증해야 한다. 매핑된 컨테이너에는 해당 Gateway만 영수증을 쓸 수 있도록 CSE 접근 정책을 배정한다.

[정산 함수](receipt-settlement.mjs)는 중앙 `gatewayCommands`와 `receipts`의 `GATEWAY_COMMAND_AUTHORIZED` 이력을 조회한다. 팀의 `approvalHash`와 영수증 스키마 검증기를 공급한다. 당시 허용 기록은 발급 이후, 허용 만료 전, CSE 생성 시각 이하여야 한다. 임시 Mobius4의 `ct`는 UTC 초 단위이므로 같은 초의 밀리초 승인처럼 시각 순서가 불명확한 건 `REVIEW`로 남긴다. CSE 생성 시각은 보관 시각이며 장치 적용 시각은 별도 증거에서 확인한다.

| 결과 | 처리 |
|---|---|
| `SETTLED` | 발급 내용, 당시 승인, 적용 readback이 일치하며 원본의 해시와 정산 키를 처음 영속 저장했다. |
| `ALREADY_SETTLED` | 같은 정산 키와 영수증 해시의 영속 기록을 반환한다. |
| `WAITING_FOR_NATIVE` | 인증된 CSE가 HTTP 404 및 oneM2M 4004를 응답했다. 나중에 같은 경로로 재시도한다. |
| `REVIEW` | 경로·발급·승인·readback·선택 ACK의 불일치, 또는 기존 기록과 내용 충돌이다. |

인증·전송·중앙 저장소 장애는 호출자에 전달하며 정산 성공을 반환하지 않는다. CORE MQTT ACK를 함께 받았으면 안에 포함된 영수증까지 원본과 대조한다. CSE 원본을 계기로 먼저 정산하는 호출도 지원한다. [격리 POSIX 파일 구현](receipt-settlement-files.mjs)은 운영자가 지정한 소유자 전용 로컬 디렉터리에서 파일 동기화와 덮어쓰기 없는 링크로 한 기록을 확정한다. 운영 CORE는 `(gatewayId, commandId)` 고유 제약과 원자적 저장을 제공하고 ACK 수신기 또는 CSE 알림 소비자를 이 함수에 연결해야 한다.

### PostgreSQL 정산 저장 후보

[정산 테이블](sql/001_command_receipt_settlement.sql)은 팀 companion DB의 `privacy_bubble` 스키마에 추가한다. 팀 `receipt_journal`은 `(receipt_type, correlation_id, receipt_hash)`로 감사 행을 구분한다. KEYRING 정산 테이블은 `(gateway_id, command_id)`당 한 행을 보관한다. 정산 소비자에는 이 테이블의 `SELECT`·`INSERT`와 스키마 사용 권한을 부여한다. 기록은 같은 키로 수정하거나 삭제하지 않는다.

[저장 어댑터](receipt-settlement-postgres.mjs)는 팀이 관리하는 PostgreSQL 연결 풀을 받아 다음과 같이 결합한다.

```js
const settle = createCommandReceiptSettlement({
  ...authenticatedReceiptAdapters,
  commitIfAbsent: createPostgresSettlementCommit(pgPool),
});
```

경합에서 삽입되지 않은 요청은 `READ COMMITTED` 트랜잭션의 다음 조회로 먼저 커밋된 행을 읽는다. 정산 함수는 기존 해시와 대조해 동일 영수증과 내용 충돌을 구분한다. 커밋 응답을 받지 못하면 같은 키로 다시 처리한다. [PostgreSQL 트랜잭션 격리](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED)

현재는 후보 SQL과 어댑터 소스가 있다. 실제 PostgreSQL에 적용하고 두 연결의 동시 저장·재시작을 확인하는 단계가 남아 있다.

### Mobius4 알림에서 원본 정산까지

Mobius4의 Gateway 전용 영수증 컨테이너 아래 `ty=23` 구독을 둔다. `enc`에는 `net:[3]`과 `chty:[4]`, `nct`에는 `3`을 지정한다. 알림은 `m2m:sgn.sur`에 구독의 structured ID를, `nev.rep.m2m:uri`에 새 cin의 structured ID를 담는다. [Mobius4 알림 구현](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/noti.js)

[수신 함수](receipt-notification-ingress.mjs)는 인증된 전송 계층이 부여한 `verifiedCseKey`로 등록을 찾는다. 구독의 정확한 wire `sur`, oneM2M originator와 RVI를 대조한다. 구독 확인 요청은 응답만 하고, 등록된 컨테이너 바로 아래의 `gw-<해시>` URI만 [PostgreSQL 대기열](receipt-notification-postgres.mjs)에 넣는다. `verifiedCseKey`는 HTTP 본문이나 클라이언트 헤더로 전달하지 않는다. 콜백은 등록된 경로의 POST에서 최대 8 KiB의 JSON 바이트를 넘기고 함수가 반환한 HTTP 상태·oneM2M 헤더로 응답한다.

[HTTPS 전송 어댑터](receipt-notification-https.mjs)는 TLS 1.3에서 검증된 클라이언트 인증서의 SHA-256 지문을 등록 CSE 키에 연결한다. 정해진 경로·메서드와 JSON 요청만 넘긴다. 수신 서버에 등록할 지문은 승인된 CSE 발신 또는 중계 인증서에서 읽는다. [Node.js TLS 인증 상태](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlssocketauthorized)

```js
const inbox = createPostgresReceiptInbox(pgPool);
const receive = createReceiptNotificationIngress({ subscriptions, enqueue: inbox.enqueue });
const drainOne = createReceiptNotificationWorker({ inbox, resolveSettlement });
```

팀 서버 설정의 `subscriptions`에는 `{ cseKey, originator, rvi, subscriptionRef, receiptContainer }`를 넣는다. `subscriptionRef`는 실제 Mobius4가 보내는 `Mobius/.../settlement` 형식, `receiptContainer`는 조회에 쓸 `/Mobius/...` 형식이다. `resolveSettlement(cseKey)`는 고정된 인증 CSE 조회와 PostgreSQL 정산을 묶은 기존 `settle` 함수를 돌려준다. CORE 작업 루프는 `drainOne()`을 반복 호출하고 `IDLE`일 때 대기한다.

[대기열 테이블](sql/002_receipt_notification_inbox.sql)은 `(cse_key, native_ref)`별로 중복 알림을 합친다. 수신 성공은 대기열 커밋 이후에만 반환한다. [작업자](receipt-notification-worker.mjs)는 제한 시간 동안 한 행을 맡고 원본을 조회해 정산한다. 일시 실패는 간격을 늘려 다시 시도한다. 한도를 넘겼거나 영수증이 검토로 분류되면 운영자가 확인할 상태와 코드가 남는다. 처리 도중 프로세스가 끝나면 기한 뒤 다른 작업자가 같은 URI를 처리할 수 있다.

[전달 경로 기록](sql/003_receipt_delivery_provenance.sql)은 같은 트랜잭션에서 `CSE_CALLBACK`과 `RECOVERY_SWEEP`별 최초 시각을 남긴다. `queued_new`는 해당 경로가 대기열 행을 최초로 만들었는지 나타낸다. 이미 정산된 뒤 다른 경로의 알림이 오면 전달 기록만 추가된다. 이전 데이터에 없는 전달 경로는 추정하지 않는다.

배치하려면 팀이 콜백의 CSE 인증 경계와 구독을 등록하고 DB 마이그레이션을 적용해야 한다. 사용 중인 Mobius4의 HTTP 알림은 전송 실패를 로그에 남긴다. 이번에는 실제 콜백·DB·재시도 시험을 실행하지 않았다. [Mobius4 HTTP 알림 처리](https://github.com/IoTKETI/mobius4/blob/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/cse/noti.js)

### 대기열 도달 전 유실 복구

[복구 스윕](receipt-notification-recovery.mjs)은 팀 `IntegrationStore`가 저장한 스냅샷의 `gatewayCommands`와 `receipts`를 대조한다. `[from, until)` 구간의 `GATEWAY_COMMAND_AUTHORIZED` 중 허용 결과와 원래 발급 해시·claim·revision·epoch가 맞는 명령을 고른다. 명령당 구간 내 가장 이른 허용 시각을 기준으로 정렬한다. 발급이 구간 전이더라도 허용이 구간 내라면 포함한다.

```js
const sweep = createReceiptNotificationSweep({
  snapshot: committedTeamSnapshot, from, until, hashPayload: approvalHash, resolveRoute, inbox,
});
const page = await sweep({ after, limit: 50 });
```

`resolveRoute({ gatewayId, commandId, issuedAt })`는 정본의 Gateway·명령 배정에 따른 `{ cseKey, receiptContainer, readNativeReceipt }`를 반환한다. CSE가 교체된 경우 원래 영수증 경로를 보존해 선택한다. 기존 대기열 행은 건너뛴다. 빠진 행은 계산된 이름으로 인증 CSE에서 조회하고 Gateway 및 명령 ID가 일치하는 원본을 찾았을 때만 같은 대기열에 넣는다. 콜백과 스윕이 동시에 넣어도 고유 키가 유지된다. 작업자는 원래 승인·스키마·readback을 다시 확인한다.

한 스냅샷에서 `page.next`가 `null`이 될 때까지 같은 `sweep`을 호출한다. `gaps`에는 원본 미도착, 조회 실패, 매핑·원본 불일치를 기록한다. CORE 운영자는 원본 보존 기간 안에서 최근 승인 구간을 겹쳐 다시 조회하고, 누락이 남은 이전 구간은 같은 범위로 재처리한다. DB 오류로 페이지가 중단되면 같은 커서로 재호출할 수 있다. 이미 검토로 남은 행은 기존 검토 절차로 처리한다. 실제 주기 실행과 실물 영수증 복구 시험은 남아 있다.

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

Gateway 0.2.12에서 `CORE_TELEMETRY_EPOCHS`에 중앙이 부여한 장치별 epoch를 설정하면, 관측을 SQLite에 넣는 트랜잭션에서 epoch도 함께 기록한다. 재시도와 재기동은 저장된 epoch로만 `privacy-bubble/gateway/{gatewayId}/telemetry-epoch/{deviceId}/{epoch}`에 발행한다. 활성 설정에 속하지 않는 행은 SQLite에 남기며 최신 epoch의 전송 순서를 막지 않는다. 보류 행은 전체 outbox 용량에 포함된다. 0.2.15의 [수동 보관 절차](../raspberry-pi-gateway/STATE_RECOVERY.md#종료된-core-epoch-보관)에서 종료된 범위를 정리할 수 있다.

0.2.18은 배터리와 RSSI가 모두 있으면 기존 1.0.0 형식으로 보낸다. 둘 중 하나가 없으면 epoch 전용 토픽에서만 [nullable 후보 1.1.0](../../contracts/keyring/scoped-nullable-telemetry.schema.json)을 사용한다. 기존 CORE v1 본문과 일반 MQTT 토픽의 측정 조건은 이전과 같다.

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
