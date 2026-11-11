# BLE 재접속과 명령 세션

## 승인 기한과 GATT 전송

Gateway 0.2.21은 중앙 응답의 `expiresAt`과 명령 `deadline` 중 이른 시각에 250ms 여유를 두고 단조 시계 기한을 고정한다. SQLite에 실행 의도를 쓰고 GATT 작업을 기다리는 시간도 같은 기한에서 차감한다. Gateway는 각 20바이트 조각 직전에 인증 세션·자격 상태와 revision·시계·기한을 확인한다. 조각 전송을 중단하면 연결을 무효화해 다음 세션에서 부분 프레임을 비운다.

승인 요청 중 자격 revision이 바뀌면 새 승인까지 대기한다. SQLite 기록 후 전송 전에 상태가 바뀌면 거절 영수증을 남긴다. BLE 처리 중 중단은 `TIMEOUT` 또는 `INDETERMINATE`로 보존한다. BlueZ에 넘긴 조각은 장치의 `remainingMs`와 저널 규칙에 따라 처리된다. 새 사례는 모의 시험 소스로 추가했으며 실행은 남아 있다.

Gateway 0.2.42는 마지막 GATT 쓰기 시작 뒤 한 번 정한 BLE 기한 안에 현재 연결에서 받은 일치 영수증을 보존한다. 그 뒤 연결이 종료되거나 마지막 쓰기가 오류·타임아웃으로 끝나도 먼저 수용한 결과와 readback을 SQLite에 전달한다. 영수증은 마지막 조각보다 이르거나 기한에 도달한 뒤에는 수용하지 않는다. 이 경로에서 명령을 재전송하지 않으며, 사용자 취소와 일치 영수증이 없는 종료는 기존 처리를 따른다.

Gateway 0.2.43은 일치 영수증 알림을 처리하는 동안 장치 결과를 판정해 SQLite에 커밋한다. 마지막 쓰기 응답이 보류된 채 종료되더라도 커밋된 영수증은 재시작 후 기존 전송 대기열로 넘어간다. 최초 저장이 실패하면 수신 결과로 한 번 더 저장을 시도한다. 재시도까지 실패하면 기존 실행 의도를 남겨 재시작에서 미확정으로 처리한다.

Gateway 0.2.45에서 `PC_DISPATCH_START_REQUIRED=true`를 사용하면 최초 승인과 SQLite 실행 의도 기록 뒤 같은 명령·claim·payload hash로 중앙의 `POST /dispatch-start`를 호출한다. 중앙은 현재 정책을 확인해 `IN_FLIGHT`를 기록한다. Pi는 두 승인 기한 중 이른 값을 적용하고, 응답을 받은 뒤 BLE 세션·자격 상태·시계를 다시 확인한다. 응답이 없거나 권한이 바뀌면 BLE 쓰기 전에 거절 영수증을 남긴다. 기존 격리 시험 프로필은 환경 설정 기본값 `false`를 사용한다. 이 변경은 원격 main `bc2a45d`의 INTEGRATION 계약을 따른다.

## 현재 부팅과 새 적용 영수증

Gateway 0.2.8은 대기 중인 commandId와 payloadHash가 일치하는 `APPLIED`에 현재 GATT identity의 bootId를 요구한다. 부팅 ID가 다르면 세션을 끊고 명령 결과를 미확정으로 기록한다. 이미 전송한 명령은 자동 재실행하지 않는다. 과거 journal의 `DUPLICATE`는 원래 bootId와 적용 당시 readback을 유지하며, 현재 부팅의 관측 시각으로 환산하지 않는다.

## 재연결과 관측 시각 기준

Gateway 0.2.90은 관측 구독 뒤 `BLE_OBSERVATION_TIMEOUT`초 동안 새로운 BLE 관측 알림이 큐에 들어오지 않으면 `observation_notification_timeout`을 기록한다. 기본값은 30초이며 5~300초로 설정할 수 있다. 시작할 때 읽은 GATT 값, 중복 순번과 이전 연결 알림은 이 시간을 갱신하지 않는다. 시간 초과 시 해당 세션의 명령 준비 상태를 해제하고 같은 장치에 다시 연결한다. 이미 전송 중인 명령은 기존 세션 종료 규칙에 따라 처리한다.

Gateway 0.2.40은 장치별 마지막으로 큐에 넣은 관측의 부팅 ID·sequence·uptime을 BLE 재연결 뒤에도 사용한다. 같은 부팅에서 이미 받은 번호 이하의 READ나 알림은 버린다. 번호가 증가해도 uptime이 이전보다 낮으면 프로토콜 오류로 연결을 해제한다. 새로 인증된 부팅은 낮은 번호로 시작할 수 있다.

Gateway 프로세스가 다시 시작하면 기존 SQLite의 마지막 부팅 ID와 sequence로 중복 수신을 차단한다. SQLite의 기존 관측 커서는 uptime을 저장하지 않으므로 uptime 비교는 프로세스에서 새 관측을 받은 뒤 시작한다. 큐가 가득 차서 등록에 실패한 관측은 커서를 전진시키지 않는다.

영수증 UTC 추정에 쓰는 시각 기준은 연결이 끝날 때 지운다. 새 연결에서 큐에 등록된 같은 부팅의 관측이 들어올 때 다시 잡는다. 그 전에는 영수증에 장치 결과를 유지하고 추정 시각은 `null`로 남긴다. 이 변경의 시험과 Pi 실물 확인은 미실행이다.

Gateway 0.2.41은 일치하는 영수증 알림 프레임을 다 받은 시점에 `receivedAt`과 UTC 추정값을 확정한다. 마지막 GATT 쓰기 응답을 기다리는 중 나중에 받은 관측으로 시각을 다시 계산하지 않는다. 적용 추정이 알림 수신보다 늦거나, 새 `APPLIED`의 수락 추정이 마지막 조각 전송 시작보다 이르면 수락·적용 시각을 `null`로 남긴다. 저널의 과거 결과는 원래 부팅의 추정 범위에서 이전 시각을 가질 수 있다. 같은 부팅의 기준이 60초 범위를 벗어나거나 단조 시계 대비 UTC 차이가 2초를 넘으면 추정값을 비운다. 장치 결과·readback과 알림 수신 시각은 보존한다.

## 2026-11-10 — BlueZ 초기 READ와 알림 버퍼 분리

Gateway0.2.4는 초기 observation READ·검증·큐 등록을 observation 알림 구독 이전에 수행한다. 실제 Pi의 BlueZ가 READ 전체 값을 PropertiesChanged로도 보내면서 LF 알림 버퍼에 섞이는 오류를 재현했다. 같은 재현 시험의 수정 전 FAIL→후 PASS와 기본58개 통과, 실물90초45개 관측·버튼3상태 수신을 확인했다. [실물 Pi 증거](../evidence/2026-11-10-pi-feather/README.md)를 따른다. session generation·인증·JSON/LF 검사는 유지한다.

## 2026-10-30 — 명령 세션 교체

KEYRING / 남호 · DOC-REV 2.0.0 · Gateway0.2.1 · 2026-10-30.

Gateway0.2.0은 GATT 조각을 보낼 때마다 `peer.client`를 다시 조회했다. 첫 조각 전송 중 연결이 교체되면 남은 조각은 새 클라이언트로 흘렀다. 모의 시험에서는 새 연결에12번 추가 WRITE가 발생했다. 이전 연결의 disconnect·observation·receipt 콜백도 동일한 peer를 사용해 새 연결을 끊거나 수신 버퍼를 오염시키거나 현재 pending 명령을 정산했다. handshake 도중 protocol failure가 발생해도 ready를 설정하는 경로가 있었다. [수정 전 실패 로그](../evidence/2026-10-30-ble-sessions/baseline.log)에5개 재현 결과를 보존했다.

## 처리 규칙

1. 연결 시도마다 프로세스 내부 generation을 할당한다. 연결 상실·protocol failure·명령 중단 시 즉시 무효화한다. generation은 중앙 `ownershipEpoch`와 별개이며 wire/schema/DB에는 추가하지 않는다.
2. disconnect와 두 notification 콜백은 생성된 연결의 generation을 캡처한다. 오래된 콜백은 수신 버퍼·pending future·연결 상태를 변경하지 않는다.
3. 명령은 시작 시 클라이언트와 generation을 고정한다. 각 20바이트 WRITE 전과 중간 조각 응답 뒤에 같은 인증 세션인지 확인한다. 마지막 조각 이후에는 그 세션에서 기한 안에 수용한 영수증이 결과를 확정한다. 연결이 교체되면 다음 연결에 이어 보내지 않는다.
4. 오래된 명령의 예외 처리와 future 정리는 새 연결을 종료하거나 다른 pending 상태를 지우지 않는다. 기한 안에 일치 영수증이 들어오지 않은 실패 결과는 기존 Gateway receipt 처리에서 미확정으로 남기며 자동 재실행하지 않는다.
5. identity 확인·notify 등록·최초 observation READ가 끝날 때까지 세션을 확인한다. 도중에 연결 또는 프로토콜이 실패하면 ready로 승격하지 않는다. journal capture의 마지막 identity 확인도 generation을 확인한다.

현재 연결을 통해 장치 journal의 과거 결과를 받을 수 있다. 과거 결과의 bootId와 알림 콜백이 속한 연결을 각각 확인한다.

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

## r18 관측 전용 revision

Gateway 0.2.37은 인증된 `r18-hand-solder`의 `-bringup` revision에서 BlueZ 캐시에 기존 명령 WRITE 특성이 보여도 `commandReady:false`로 처리한다. 명령 전송과 저널 selector 쓰기를 차단하고 identity·관측 수신은 유지한다. [r18 초기 구동](../pcb/BRING_UP.md)
