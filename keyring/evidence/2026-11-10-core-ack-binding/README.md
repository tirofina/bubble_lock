# 중앙 HTTP 발급 명령과 CORE ACK 결속 시험

KEYRING 남호 · DOC-REV 2.0.0 · 팀 main `715ef58` · Gateway 0.2.6 · 2026-11-10.

팀 Node mTLS API에서 실제로 발급한 명령을 Gateway의 전체 worker가 처리했다. GATT는 모의 장치였고, Gateway가 만든 native receipt는 실제 격리 Mobius4에 저장됐다. CSE에서 다시 읽은 receipt와 Gateway가 실행 전에 받은 중앙 승인 응답을 Node 검증에 사용했다.

| 사례 | 실제 결과 |
|---|---|
| HTTP로만 발급된 정상 ACK, 팀 CORE 원본 | `REVIEW / ack-command-binding` |
| CORE에 등록된 명령의 payload hash를 바꾼 ACK, 팀 CORE 원본 | `ACK_RECORDED` |
| 정상 native receipt와 정상 MQTT ACK, KEYRING 후보 | 2개 모두 결속 확인 |
| 다른 Gateway·grant·claim·승인 거절·readback·ACK hash·내부 영수증 변조 | 7개 모두 거절 |
| 별도 권한 회수 통합 시험 | BLE 쓰기 0회, `REJECTED / NOT_AUTHORIZED` 영수증 1개 |

팀 CORE 원본 동작은 합성 브로커를 붙인 직접 호출 결과다. 브로커 ACL이나 운영에서 위조가 가능하다는 검증은 아니다. Python Gateway와 팀 Node의 발급 payload SHA-256은 일치했고, CSE receipt는 각각 원본 SQLite와 일치했다.

[후보 함수의 입력 경계](../../integration-candidate/README.md) · [시험 절차](../../raspberry-pi-gateway/TESTING.md#중앙-명령-통합-시험) · [로그](central-dispatch.log) · [결과와 해시](receipt.json)
