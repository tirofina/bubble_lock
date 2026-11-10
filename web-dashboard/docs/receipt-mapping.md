# CORE·KEYRING·INTEGRATION 영수증 필드 대응

DOC-REV 2.0.0, 이벤트 schema 1.0.0. [adapter](../shared/receipt-adapter.ts), [타임라인](../shared/timeline.ts), [통합 표시](../shared/integration.ts), [JSON Schema](../contracts/dashboard-event.schema.json)를 기준으로 합니다.

## 이벤트 공통 필드

| 필드 | 출처 |
|---|---|
| `sequence`, SSE `id` | snapshot 순서대로 1부터 부여 |
| `resourceUri` | CORE의 oneM2MResource 또는 adapter 설정/기본값, INTEGRATION은 `/v1/events/{eventId}` |
| `currentRevision` | adapter 설정값 또는 `null` |
| `receivedAt` | `journaledAt ?? timestamp` |
| `roleScope` | 표시 메타데이터 |
| `simulation` | 재생 경로의 `true` |
| `source` | `fixture-replay`, `core-journal-replay`, `integration-journal-replay` |
| `receipt` | 원본 영수증과 해시 유지 |
| `acceptance` | 기본 fixture의 명시적 API 수락 기록 |

이벤트 종류는 `command.accepted`, `command.dispatched`, `command.ack`, `gateway.telemetry`, `receipt.review`, `group.summary`, `integration.receipt`입니다.

## 명령 시각

| 단계 | 원본 |
|---|---|
| 수락 | `acceptance.acceptedAt` |
| 전송 | `DISPATCHED.timestamp` |
| 적용 | `payload.appliedAt`, `gatewayReceipt.appliedAt`, 또는 APPLIED ACK의 timestamp |
| 확인 | READBACK_VERIFIED ACK의 timestamp |
| Group 단계 | 모든 알려진 구성원의 단계가 채워지면 가장 늦은 시각 |
| 소요 시간 | 두 단계가 관측되고 시간순으로 정렬되면 차이값, 나머지는 `null` |

KEYRING `gatewayReceipt.appliedAt`는 `timestampSource`와 함께 기록합니다. readback은 boolean과 `{state:boolean}` 두 형식을 지원하며 `false`를 그대로 표시합니다. 구성원 ID는 CORE Group 명령의 마지막 콜론 뒤 문자열을 사용합니다. Group 요약은 멤버 목록·ACK·재시도 상태를 제공합니다.

## canonical KEYRING 호환

`keyringCommandPayload`와 `keyringReceipt`는 저장소의 `contracts/keyring/command.schema.json`, `receipt.schema.json`을 반영합니다. telemetry는 `pc-mobius/contracts/gateway-event.schema.json`을 반영합니다. nested receipt의 deviceId·commandId·gatewayId·grantRevision·ownershipEpoch·payloadHash·readback을 외부 ACK와 대조합니다.

## INTEGRATION 기록

`privacy-bubble.integration.v1`의 `docRevision:2.0.0`, `eventId`, `timestamp`와 type 또는 MEC eventType/service/ueId를 검증합니다. 확장 필드는 원형을 보존하여 Gateway enrollment·command authorization을 포함한 새 통합 이벤트를 전달합니다.

- `integration.receipt`는 명령 상태와 독립적으로 cursor를 갱신합니다.
- `/api/audit`는 전체 통합 snapshot을 검색합니다. 결과 상태는 allowed 값이 true/false일 때 각각 allowed/denied, 나머지는 pending입니다.
- 서비스 카드는 MEC, HANDOVER, FL, MCP의 최신 기록에서 시각·상태·식별자·hash를 표시합니다.
- 외부 journal의 수락 단계는 명시적 acceptance 계약이 연결될 때 채워집니다.
- 원본 receiptHash는 보존하고 통합시험에서 writer의 SHA-256 결과와 대조합니다.
