# CORE 영수증 → 대시보드 이벤트 필드 대응

DOC-REV 2.0.0, 이벤트 schema 1.0.0. 구현은 [../shared/receipt-adapter.ts](../shared/receipt-adapter.ts)와 [../shared/timeline.ts](../shared/timeline.ts), 계약은 [../contracts/dashboard-event.schema.json](../contracts/dashboard-event.schema.json)에 있습니다. 영수증 원본 형식은 `pc-mobius/src/receipt-journal.mjs`, `pc-mobius/src/group-dispatcher.mjs`, `pc-mobius/contracts/raspberrypi-gateway.v1.json`을 그대로 따르며, pc-mobius 코드는 바꾸지 않았습니다.

## 이벤트 공통 필드

| 이벤트 필드 | 출처 |
|---|---|
| `sequence` (SSE `id`) | 재생 adapter가 1부터 매기는 스트림 번호. `receipt.sequence`, `payload.sequence`와 별개 |
| `resourceUri` | 영수증 `oneM2MResource`, 없으면 설정값, 그것도 없으면 `/Mobius/privacy-bubble-test-ae/bubbleState` |
| `currentRevision` | adapter 설정이 줄 때만 값, 아니면 `null`. hash나 sequence로 대신하지 않음 |
| `receivedAt` | `journaledAt ?? timestamp`. 브라우저 시계가 아님 |
| `roleScope` | 설정 메타데이터. 권한 판정 아님 |
| `simulation` | 재생 경로에서는 항상 `true` |
| `source` | `fixture-replay` 또는 `core-journal-replay` |
| `receipt` | 수정하지 않은 CORE 영수증 (`command.accepted`만 `null`) |
| `acceptance` | `command.accepted`에서만 표시된 `ApiAcceptance` 래퍼, 나머지는 `null` |

이벤트 종류: `command.accepted`, `command.dispatched`, `command.ack`, `gateway.telemetry`, `receipt.review`, `group.summary`.

## 네 단계 시각

| 화면 단계 | 규칙 |
|---|---|
| 수락 | `acceptance.acceptedAt`만. dispatch 시각이나 `issuedAt`으로 채우지 않음 |
| 전송 | `DISPATCHED` 영수증의 `timestamp` |
| 적용 | ACK `payload.appliedAt`, 또는 `APPLIED` ACK의 `payload.timestamp` |
| 확인 | `READBACK_VERIFIED` ACK의 `payload.timestamp` |
| Group 단계 | 알려진 구성원 모두가 그 단계를 가졌을 때만, 가장 늦은 구성원 시각 |
| 소요 시간 | 두 단계가 모두 있을 때의 차이. 없거나 역순이면 `null` |

추가 규칙:

- `READBACK_VERIFIED`만 있고 `APPLIED`가 없으면 적용·수락을 채우지 않습니다.
- telemetry의 `status:'APPLIED'`는 자원 갱신이지 명령 적용이 아닙니다.
- `ack:true`는 ACK를 봤다는 뜻이지, 적용 성공을 뜻하지 않습니다.
- readback `false`는 실제 장치 상태입니다. 누락이 아닙니다.
- 구성원 ID는 CORE의 마지막 콜론 규칙으로 `commandId`를 나눠 얻습니다 (`grp-demo:keyringA` → `keyringA`).
- `group.summary`는 구성원 목록과 ACK·retry 플래그만 등록하고 시각은 만들지 않습니다.

## CORE에 남은 수용 간극

9절 첫 통합 데모 조건 "웹 대시보드가 수락·전송·적용·확인 시각을 표시한다"는 지금 **부분 충족**입니다.

1. **수락 시각이 CORE 영수증에 없습니다.** 지금은 대시보드 fixture [../fixtures/api-acceptance.json](../fixtures/api-acceptance.json)이 Group 단위 수락만 공급합니다. 실제 영수증 파일(`RECEIPT_FILE`)을 재생하면 수락은 대기로 남습니다. 구성원별 수락은 어느 경우든 대기입니다. CORE나 INTEGRATION이 API 수락 receipt(`acceptedAt`, `commandId`, `grantRevision`)를 내보내야 닫힙니다.
2. **`currentRevision` 출처가 없습니다.** CORE가 자원 revision을 정해 주기 전까지 `null`입니다.
3. **지속 global sequence가 없습니다.** 스트림 번호는 재생 snapshot마다 새로 매겨집니다. 운영 스트림에서는 CORE 쪽 정본 번호가 필요합니다.
4. **영수증 hash 검증이 없습니다.** `hash`는 보존만 합니다.
5. **`ty` 불일치.** CORE 시험 계약은 binarySwitch에 `ty=4`, 표준과 upstream은 flexContainer `ty=28`입니다. 대시보드는 28을 씁니다. 근거는 [primary-sources.md](primary-sources.md).

이 간극들은 기록만 했고, 화면이나 adapter가 값을 지어내서 메우지 않습니다.
