# 명령 영수증의 전달과 중앙 정산

Gateway의 SQLite command journal은 native 영수증 원문을 보존한다. `stage_receipts()`는 native oneM2M, 선택 CORE ACK, 중앙 API 영수증을 하나의 SQLite 트랜잭션으로 outbox에 넣는다. 용량 경계에서는 전체 staging을 되돌리고 journal 원문을 유지한다. 각 경로는 고정 request ID와 독립 재시도 상태를 사용한다.

`CENTRAL_RECEIPTS_ENABLED=true`가 기본값이다. `@central/receipt`는 TLS 1.3과 등록된 클라이언트 인증서를 사용하여 `POST /api/v1/gateways/{gatewayId}/receipts`로 전달된다. API 응답의 `ACCEPTED` 또는 `DUPLICATE`와 같은 commandId를 확인한 후 해당 outbox 행을 완료한다. native oneM2M 전달은 matching application response로 완료하고 CORE MQTT 전달은 broker 확인을 기록한다.

SQLite의 `central_receipt_staged` 컬럼은 시작 트랜잭션에서 추가된다. native 전달이 완료된 기존 영수증도 중앙 경로 최초 활성화 시 staging된다. 중앙 전달 완료·프로세스 재시작 후에는 이 컬럼이 중앙 경로의 완료 이력을 유지한다. CORE projection은 native 최초 staging 시점의 설정을 사용한다. 대기 중인 경로는 각각의 backoff와 함께 유지된다.

중앙 API는 인증서의 Gateway·기기 소속, canonical command의 payloadHash·ownershipEpoch·grantRevision, schema와 시간 순서를 검증한다. 성공 영수증에는 사전 승인 claim, `APPLIED`/`DUPLICATE` ACK, 목표와 일치하는 readback, firmwareRevision·bootId가 필요하다. 이 검증과 함께 command·dispatch outbox를 `APPLIED_VERIFIED`로 정산하고 device lane을 해제한다. 승인 회수 뒤 도착한 기존 claim의 성공 영수증도 같은 정산 절차를 거친다. 동일 영수증 재전송은 고정 hash로 처리하며, 다른 결과가 terminal 상태에 도착하면 conflict로 응답한다.

<<<<<<< HEAD
`TIMEOUT`, `INDETERMINATE`, `ALREADY_DISPATCHED`는 `DISPATCH_UNCERTAIN`과 기존 lane을 유지한다. 장치의 명시적 거절 또는 전송 전 검증 거절은 `SETTLED_CANCELLED`로 정산한다. UTC를 복원할 수 있는 영수증은 장치 accepted/applied 시각을 기록하고, `timestampSource=unavailable` 영수증은 nullable 시각과 실제 readback을 보존한다. 중앙의 claimCommittedAt·ackObservedAt은 server clock으로 기록한다.
=======
Gateway 0.2.27에서 컨테이너 ID를 고정한 배포는 native CREATE 뒤 같은 자원을 HTTPS로 조회해 저장된 영수증을 대조한다. 읽기가 실패하면 native 항목이 대기열에 남고 CORE ACK는 독립 상태를 유지한다. [고정 컨테이너 확인 절차](STATE_RECOVERY.md#명령-영수증-컨테이너-id-고정)

Gateway 0.2.30의 송신 worker는 재시도 시각이 된 native 명령 영수증과 CORE ACK를 오래된 관측보다 먼저 시도한다. 영수증을 연속 네 번 시도하면 다음 선택에서 일반 항목을 우선한다. 해당 쪽에 전송할 항목이 없으면 준비된 쪽이 계속 진행한다. 기존 SQLite 행으로 구분하며 요청 ID, 재시도 시각, 분리된 scoped CORE telemetry의 장치별 순서를 유지한다. 이 변경의 시험과 배포는 미실행이다.

CORE_BRIDGE_ENABLED의 projection 선택은 영수증 최초 staging 시 고정한다. 이미 대기 중인 native 영수증에 설정 변경만으로 CORE ACK를 과거로 소급 생성하지 않는다. 이미 있는 outbox 항목은 유지한다. DB 삭제·수동 outbox 재작성으로 재전송을 유도하지 않는다.
>>>>>>> origin/codex/keyring-namho

## 실행한 검증

`POST /api/v1/gateways/{gatewayId}/dispatch-start`는 SQLite durable intent 저장 직후, BLE 호출 직전에 현재 claim·grant·epoch·deadline을 다시 검사한다. 최초 성공의 `dispatchStartedAt`을 저장하고 command/outbox를 `IN_FLIGHT`로 전환한다. 재시도는 원래 시각을 유지한다. 회수 또는 응답 소실이 BLE 진입보다 앞선 경우 Gateway의 명시적 전송 전 취소 영수증으로 정산한다.

<<<<<<< HEAD
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
=======
| ID | test_receipt_outbox.py | 기대 결과 |
|---|---|---|
| KR-RECEIPT-ROUTE-01 | test_completed_core_ack_is_not_recreated_during_native_retry | CORE 완료 후 native retry 동안 ACK 추가 생성0개 |
| KR-RECEIPT-ROUTE-02 | test_restart_does_not_recreate_completed_core_ack | 재시작 후에도 완료한 ACK 추가 생성0개 |
| KR-RECEIPT-ROUTE-03 | test_native_confirmation_keeps_pending_core_ack_for_its_own_retry | native 완료와 무관하게 미완료 ACK 보존 |
| KR-RECEIPT-ROUTE-04 | test_capacity_failure_does_not_leave_half_a_receipt_pair | 용량 부족 시 두 outbox 항목 모두 미생성·원본 receipt 보존 |
| KR-RECEIPT-ROUTE-05 | test_outbox_worker_does_not_spin_publishing_ack_while_native_is_backed_off | 모의 native 장애 중 ACK 전송1회 후 backoff 대기 |
| KR-RECEIPT-ROUTE-06 | test_due_receipts_jump_older_observations_without_starving_them | 도래한 영수증을 먼저 시도하고 네 번 뒤 관측 전송. 대기 중인 영수증은 보존 |

수정 전5개 중3개 실패·2개 통과, 수정 후 전체47개 통과다. wheel build와 설치한 패키지의47개 시험도 통과했다. [실제 로그·hash](../evidence/2026-10-30-receipt-routing/README.md)에 연결한다. 합성 명령·모의 전송·새 임시 SQLite만 사용했으며 기존 DB·실제 broker/CSE·장비·운영 서비스는 실행하지 않았다.

## 자격 상태 전환 영수증

Gateway 0.2.35는 중앙 mTLS 상태 API의 검증된 첫 응답과 `ACTIVE`·`LOST`·`REVOKED` 또는 revision 변경을 `credential_receipts`에 기록한다. 첫 관측의 `previous`는 `null`이다. 발급이나 회전의 실제 시점은 중앙 증거를 따르며 Gateway의 `observedAt`은 응답을 관측한 시각이다. 연결 실패로 인한 `UNKNOWN`은 Gateway의 실행 차단·일반 heartbeat에 반영한다. 같은 상태·revision을 계속 읽어도 영수증은 반복 생성하지 않는다.

대기 영수증은 일반 outbox 용량과 별도로 최대 1,024건을 보존한다. 상한에서 새로운 상태를 기록할 수 없으면 기존 영수증을 보존하고 해당 응답으로 명령 실행 권한을 열지 않는다. outbox에 자리가 생기면 전송 대기 중인 가장 오래된 전환만 기존 health 컨테이너에 등록한다. 재시작과 재전송에도 같은 요청 ID·본문을 쓴다. 완료된 영수증은 최신 128건을 보관한다. [health 스키마](../../contracts/keyring/health.schema.json)

Gateway 0.2.36부터 MQTT·HTTPS의 CREATE 성공과 중복 응답 모두 기존 health 컨테이너의 해당 contentInstance를 HTTPS로 읽어 이름·유형·리소스 ID·부모 ID·본문을 확인한 뒤 전송 완료 시각을 남긴다. CREATE에 인스턴스 정보가 있으면 리소스 ID와 부모 ID도 조회값과 일치해야 한다. 조회 실패나 불일치는 동일 요청 ID로 재시도한다. CSE HTTPS `Retry-After` 중에는 이 영수증을 대기시키며 MQTT가 준비돼 있으면 같은 컨테이너의 일반 heartbeat는 보낼 수 있다. 이미 완료된 0.2.35 행에는 당시 판정 기준이 적용된다.

`credentialTransition.sequence`는 한 Gateway 상태 DB의 수신 순서다. `previous`와 `current`에는 상태·revision만 들어간다. 과거 전환은 최신 상태 조회와 구분하며, 실시간 판단은 `credentialTransition`이 없는 heartbeat를 사용한다. SQLite 보관본은 전환 행과 CSE 전송 완료 시각을 포함한다. [상태 보관](STATE_RECOVERY.md)
>>>>>>> origin/codex/keyring-namho
