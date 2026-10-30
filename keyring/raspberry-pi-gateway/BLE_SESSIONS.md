# BLE 재접속과 명령 세션

KEYRING / 남호 · DOC-REV 2.0.0 · Gateway0.2.1 · 2026-10-30.

Gateway0.2.0은 GATT 조각을 보낼 때마다 `peer.client`를 다시 조회했다. 첫 조각 전송 중 연결이 교체되면 남은 조각은 새 클라이언트로 흘렀다. 모의 시험에서는 새 연결에12번 추가 WRITE가 발생했다. 이전 연결의 disconnect·observation·receipt 콜백도 동일한 peer를 사용해 새 연결을 끊거나 수신 버퍼를 오염시키거나 현재 pending 명령을 정산했다. handshake 도중 protocol failure가 발생해도 ready를 설정하는 경로가 있었다. [수정 전 실패 로그](../evidence/2026-10-30-ble-sessions/baseline.log)에5개 재현 결과를 보존했다.

## 처리 규칙

1. 연결 시도마다 프로세스 내부 generation을 할당한다. 연결 상실·protocol failure·명령 중단 시 즉시 무효화한다. generation은 중앙 `ownershipEpoch`와 별개이며 wire/schema/DB에는 추가하지 않는다.
2. disconnect와 두 notification 콜백은 생성된 연결의 generation을 캡처한다. 오래된 콜백은 수신 버퍼·pending future·연결 상태를 변경하지 않는다.
3. 명령은 시작 시 클라이언트와 generation을 고정한다. 각20byte WRITE 전후와 결과 반환 전에 같은 인증 세션인지 확인한다. 교체되면 중단하고 다음 연결에 이어 보내지 않는다.
4. 오래된 명령의 예외 처리와 future 정리는 새 연결을 종료하거나 다른 pending 상태를 지우지 않는다. 실패 결과는 기존 Gateway receipt 처리에서 미확정 상태로 남기며 자동 재실행하지 않는다.
5. identity 확인·notify 등록·최초 observation READ가 끝날 때까지 세션을 확인한다. 도중에 연결 또는 프로토콜이 실패하면 ready로 승격하지 않는다. journal capture의 마지막 identity 확인도 generation을 확인한다.

장치 journal의 과거 boot receipt는 같은 현재 연결을 통해 다시 조회할 수 있다. 과거 bootId라는 이유만으로 거절하지 않는다. 콜백이 속한 연결과 장치가 보관한 명령의 bootId는 서로 다른 검사 대상이다.

## 회귀 시험

Rubric R02·R03·R10 연결 항목이며 다음 ID는 KEYRING 내부 제안 ID다.

| ID | test_ble_sessions.py | 기대 결과 |
|---|---|---|
| KR-BLE-SESSION-01 | test_old_disconnect_does_not_disconnect_replacement | 이전 disconnect는 무시하고 현재 disconnect는 pending을 실패시킴 |
| KR-BLE-SESSION-02 | test_old_observation_cannot_poison_new_frame_buffer | 이전 조각은 버리고 현재 연결 observation은 정상 수신 |
| KR-BLE-SESSION-03 | test_old_receipt_cannot_settle_current_pending_command | 동일 commandId/hash의 이전 콜백은 정산하지 않고 현재 콜백은 수신 |
| KR-BLE-SESSION-04 | test_partial_command_never_continues_on_replacement_client | 새 연결 추가 WRITE0회, 오래된 작업 정리 후 새 연결 유지 |
| KR-BLE-SESSION-05 | test_failed_handshake_never_marks_session_ready | handshake 실패 시 ready 설정0회 |

수정 전5개 실패, 수정 후 기존 시험을 포함한42개 통과다. wheel을 빌드하고 별도 경로에 설치한 패키지로도42개가 통과했다. [실행 로그·패키지 SHA256](../evidence/2026-10-30-ble-sessions/README.md)에 연결한다. 시험은 fake GATT·합성 명령·임시 DB를 사용했다. 실제 BLE/BlueZ·장비·Pi·중앙 통합·운영 서비스 시험은 실행하지 않았다.
