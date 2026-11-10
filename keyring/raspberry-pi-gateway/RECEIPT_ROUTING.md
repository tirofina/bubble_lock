# 영수증과 CORE ACK의 대기열 수명

KEYRING / 남호 · DOC-REV2.0.0 · Gateway0.2.2 · 2026-10-30.

0.2.1에서는 native oneM2M 영수증이 미전달이면 stage_receipts가 CORE ACK를 매번 생성했다. CORE ACK의 broker 전송을 완료하고 outbox에서 지운 뒤에도 native 영수증이 재시도 대기 중이면 ACK가 다시 생겼다. 모의 worker 시험에서 같은 ACK가4회 연속 전송됐다. 이 반복은 native retry backoff를 무력화하고 broker·CORE에 중복 부하를 준다.

0.2.2는 native 영수증을 최초 outbox에 넣는 트랜잭션에서 CORE 성공 ACK도 함께 넣는다. 두 항목의 용량을 확보하지 못하면 트랜잭션 전체를 되돌리고 원래 command receipt를 유지한다. native outbox 행이 이미 있으면 ACK를 다시 만들지 않는다. native 전달 완료 후에는 commands.receipt_delivered가 재등록을 막는다. 기존 다섯 테이블과 데이터 형식은 유지하며 migration은 없다.

각 경로의 전달 상태는 독립적이다. CORE broker 전송만 성공하면 native 영수증은 미전달로 남는다. native 영수증이 먼저 완료돼도 대기 중인 CORE ACK는 계속 재시도한다. broker PUBACK은 CORE 처리나 물리 출력 성공을 입증하지 않으며, native 전달은 matching oneM2M application response로 판정한다. 전송 후 로컬 완료 기록 전 crash·MQTT QoS 중복 전달은 별도 경계다.

CORE_BRIDGE_ENABLED의 projection 선택은 영수증 최초 staging 시 고정한다. 이미 대기 중인 native 영수증에 설정 변경만으로 CORE ACK를 과거로 소급 생성하지 않는다. 이미 있는 outbox 항목은 유지한다. DB 삭제·수동 outbox 재작성으로 재전송을 유도하지 않는다.

## 회귀 시험

R02/R03/R10에 연결한 KEYRING 제안 ID이며 원래 A01~A26 정의를 대체하지 않는다.

| ID | test_receipt_outbox.py | 기대 결과 |
|---|---|---|
| KR-RECEIPT-ROUTE-01 | test_completed_core_ack_is_not_recreated_during_native_retry | CORE 완료 후 native retry 동안 ACK 추가 생성0개 |
| KR-RECEIPT-ROUTE-02 | test_restart_does_not_recreate_completed_core_ack | 재시작 후에도 완료한 ACK 추가 생성0개 |
| KR-RECEIPT-ROUTE-03 | test_native_confirmation_keeps_pending_core_ack_for_its_own_retry | native 완료와 무관하게 미완료 ACK 보존 |
| KR-RECEIPT-ROUTE-04 | test_capacity_failure_does_not_leave_half_a_receipt_pair | 용량 부족 시 두 outbox 항목 모두 미생성·원본 receipt 보존 |
| KR-RECEIPT-ROUTE-05 | test_outbox_worker_does_not_spin_publishing_ack_while_native_is_backed_off | 모의 native 장애 중 ACK 전송1회 후 backoff 대기 |

수정 전5개 중3개 실패·2개 통과, 수정 후 전체47개 통과다. wheel build와 설치한 패키지의47개 시험도 통과했다. [실제 로그·hash](../evidence/2026-10-30-receipt-routing/README.md)에 연결한다. 합성 명령·모의 전송·새 임시 SQLite만 사용했으며 기존 DB·실제 broker/CSE·장비·운영 서비스는 실행하지 않았다.
