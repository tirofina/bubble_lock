# 영수증과 CORE ACK의 대기열 수명

KEYRING / 남호 · DOC-REV2.0.0 · Gateway0.2.2 · 2026-10-30.

0.2.1에서는 native oneM2M 영수증이 미전달이면 stage_receipts가 CORE ACK를 매번 생성했다. CORE ACK의 broker 전송을 완료하고 outbox에서 지운 뒤에도 native 영수증이 재시도 대기 중이면 ACK가 다시 생겼다. 모의 worker 시험에서 같은 ACK가4회 연속 전송됐다. 이 반복은 native retry backoff를 무력화하고 broker·CORE에 중복 부하를 준다.

0.2.2는 native 영수증을 최초 outbox에 넣는 트랜잭션에서 CORE 성공 ACK도 함께 넣는다. 두 항목의 용량을 확보하지 못하면 트랜잭션 전체를 되돌리고 원래 command receipt를 유지한다. native outbox 행이 이미 있으면 ACK를 다시 만들지 않는다. native 전달 완료 후에는 commands.receipt_delivered가 재등록을 막는다. 기존 다섯 테이블과 데이터 형식은 유지하며 migration은 없다.

각 경로의 전달 상태는 독립적이다. CORE broker 전송만 성공하면 native 영수증은 미전달로 남는다. native 영수증이 먼저 완료돼도 대기 중인 CORE ACK는 계속 재시도한다. broker PUBACK은 CORE 처리나 물리 출력 성공을 입증하지 않으며, native 전달은 matching oneM2M application response로 판정한다. 전송 후 로컬 완료 기록 전 crash·MQTT QoS 중복 전달은 별도 경계다.

Gateway 0.2.27에서 컨테이너 ID를 고정한 배포는 native CREATE 뒤 같은 자원을 HTTPS로 조회해 저장된 영수증을 대조한다. 읽기가 실패하면 native 항목이 대기열에 남고 CORE ACK는 독립 상태를 유지한다. [고정 컨테이너 확인 절차](STATE_RECOVERY.md#명령-영수증-컨테이너-id-고정)

Gateway 0.2.44는 컨테이너 ID를 고정한 native 명령 영수증의 첫 전송 시도를 기존 SQLite 행에 기록한다. 완료 확인 전에 종료되거나 재시도에 들어가면 고정 컨테이너와 같은 요청 ID로 만든 자원 이름을 조회한다. 부모 ID·이름·자원 유형·본문이 일치하면 기존 영수증으로 완료 처리한다. 요청 ID가 일치하는 HTTP 404와 oneM2M 4004를 함께 받으면 같은 이름으로 CREATE를 진행한다. 다른 오류나 본문 불일치에서는 영수증을 대기열에 유지한다. CORE ACK와 장치 명령 실행에는 이 절차를 적용하지 않는다.

Gateway 0.2.30의 송신 worker는 재시도 시각이 된 native 명령 영수증과 CORE ACK를 오래된 관측보다 먼저 시도한다. 영수증을 연속 네 번 시도하면 다음 선택에서 일반 항목을 우선한다. 해당 쪽에 전송할 항목이 없으면 준비된 쪽이 계속 진행한다. 기존 SQLite 행으로 구분하며 요청 ID, 재시도 시각, 분리된 scoped CORE telemetry의 장치별 순서를 유지한다. 이 변경의 시험과 배포는 미실행이다.

CORE_BRIDGE_ENABLED의 projection 선택은 영수증 최초 staging 시 고정한다. 이미 대기 중인 native 영수증에 설정 변경만으로 CORE ACK를 과거로 소급 생성하지 않는다. 이미 있는 outbox 항목은 유지한다. DB 삭제·수동 outbox 재작성으로 재전송을 유도하지 않는다.

## 중앙 명령 영수증 정산

Gateway 0.2.46에서 `CENTRAL_RECEIPTS_ENABLED=true`를 사용하면 같은 SQLite 명령 저널의 영수증을 중앙 `POST /receipts`에도 보낸다. 재시도와 재시작에는 같은 본문과 `Idempotency-Key`를 사용한다. 중앙의 `ACCEPTED` 또는 `DUPLICATE` 응답이 원래 command ID, claim ID, 영수증 SHA-256과 일치해야 전송을 완료한다.

중앙용 항목과 최초 등록 표시는 같은 SQLite 트랜잭션에 저장한다. 기능을 켜면 기존 Mobius4 전달이 완료된 영수증도 중앙 대기열에 등록한다. 이 설정은 같은 중앙 배포의 DB에 적용한다. 새 중앙 배포를 시험할 때는 새 Gateway 상태 DB를 사용한다. 중앙 응답으로 Mobius4 전달 완료 여부를 바꾸지 않는다. CSE 전송이 보류된 동안에도 중앙 영수증을 보낼 수 있다.

## 회귀 시험

R02/R03/R10에 연결한 KEYRING 제안 ID이며 원래 A01~A26 정의를 대체하지 않는다.

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
