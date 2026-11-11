# 명령 영수증의 전달과 중앙 정산

Gateway의 SQLite command journal은 native 영수증 원문을 보존한다. `stage_receipts()`는 native oneM2M, 선택 CORE ACK, 중앙 API 영수증을 하나의 SQLite 트랜잭션으로 outbox에 넣는다. 용량 경계에서는 전체 staging을 되돌리고 journal 원문을 유지한다. 각 경로는 고정 request ID와 독립 재시도 상태를 사용한다.

`CENTRAL_RECEIPTS_ENABLED=true`가 기본값이다. `@central/receipt`는 TLS 1.3과 등록된 클라이언트 인증서를 사용하여 `POST /api/v1/gateways/{gatewayId}/receipts`로 전달된다. API 응답의 `ACCEPTED` 또는 `DUPLICATE`와 같은 commandId를 확인한 후 해당 outbox 행을 완료한다. native oneM2M 전달은 matching application response로 완료하고 CORE MQTT 전달은 broker 확인을 기록한다.

SQLite의 `central_receipt_staged` 컬럼은 시작 트랜잭션에서 추가된다. native 전달이 완료된 기존 영수증도 중앙 경로 최초 활성화 시 staging된다. 중앙 전달 완료·프로세스 재시작 후에는 이 컬럼이 중앙 경로의 완료 이력을 유지한다. CORE projection은 native 최초 staging 시점의 설정을 사용한다. 대기 중인 경로는 각각의 backoff와 함께 유지된다.

중앙 API는 인증서의 Gateway·기기 소속, canonical command의 payloadHash·ownershipEpoch·grantRevision, schema와 시간 순서를 검증한다. 성공 영수증에는 사전 승인 claim, `APPLIED`/`DUPLICATE` ACK, 목표와 일치하는 readback, firmwareRevision·bootId가 필요하다. 이 검증과 함께 command·dispatch outbox를 `APPLIED_VERIFIED`로 정산하고 device lane을 해제한다. 승인 회수 뒤 도착한 기존 claim의 성공 영수증도 같은 정산 절차를 거친다. 동일 영수증 재전송은 고정 hash로 처리하며, 다른 결과가 terminal 상태에 도착하면 conflict로 응답한다.

`TIMEOUT`, `INDETERMINATE`, `ALREADY_DISPATCHED`는 `DISPATCH_UNCERTAIN`과 기존 lane을 유지한다. 장치의 명시적 거절 또는 전송 전 검증 거절은 `SETTLED_CANCELLED`로 정산한다. UTC를 복원할 수 있는 영수증은 장치 accepted/applied 시각을 기록하고, `timestampSource=unavailable` 영수증은 nullable 시각과 실제 readback을 보존한다. 중앙의 claimCommittedAt·ackObservedAt은 server clock으로 기록한다.

## 실행한 검증

`POST /api/v1/gateways/{gatewayId}/dispatch-start`는 SQLite durable intent 저장 직후, BLE 호출 직전에 현재 claim·grant·epoch·deadline을 다시 검사한다. 최초 성공의 `dispatchStartedAt`을 저장하고 command/outbox를 `IN_FLIGHT`로 전환한다. 재시도는 원래 시각을 유지한다. 회수 또는 응답 소실이 BLE 진입보다 앞선 경우 Gateway의 명시적 전송 전 취소 영수증으로 정산한다.

서버는 기기별 `desiredGeneration`을 단조 증가시키고 canonical commandId·claimId·payloadHash에 연결한다. native v1 wire는 이 불변 식별자 묶음으로 해당 generation을 해석한다. 단일 lane에서 이전 claim의 정산 뒤 다음 generation을 입장시키며, 이전 generation의 새 claim은 `DEVICE_GENERATION_STALE`로 정산한다. 늦은 원본 ACK의 중복 처리는 최신 lane과 readback을 유지한다.

| 경계 | 시험 |
|---|---|
| SQLite 3경로 원자성·용량·재시작·설정 전환 | `tests/test_receipt_outbox.py` 7건 |
| canonical binding·5초 TTL·회수·시간·readback·중복·terminal 충돌·전송 시작·generation | `pc-mobius/test/gateway-control.test.mjs` 11건 |
| 실제 Node TLS API ↔ Python Gateway ↔ SQLite | `tests/integration/test_gateway_api.py` 1건 |
| TLS 경로의 PANIC 사건·보호자 알림·중복 제거 | 같은 TLS 통합 시험 |
| 현재 incident/lease/grant에 따른 위치 조회·회수 | 같은 TLS 통합 시험 |

```powershell
python -m unittest discover -s keyring/raspberry-pi-gateway/tests -p test_receipt_outbox.py -v
python -m unittest discover -s tests/integration -p test_gateway_api.py -v
node --test pc-mobius/test/gateway-control.test.mjs pc-mobius/test/retention.test.mjs
```

위 명령은 저장소 루트에서 실행한다. TLS 시험은 새 PKI, 실제 Node/Python 프로세스, 임시 SQLite를 사용하며 장치 readback 입력은 합성 fixture다. 실제 Pi·키링의 BLE·GPIO·오디오 관측은 [외부 실증 TODO](../../docs/external-validation-todo.md)에서 관리한다. 이전 0.2.2의 경로 수정 증거는 [2026-10-30 기록](../evidence/2026-10-30-receipt-routing/README.md)에 보관한다.
