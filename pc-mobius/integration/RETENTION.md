# 보존 기간과 만료 정산

`RetentionService`는 canonical store의 최신 snapshot에서 만료 데이터를 정리하고 `RETENTION_EXPIRED` receipt에 collection별 개수·삭제 시각·식별자 집합 hash를 기록한다. 운영 runtime과 FL worker는 60초 주기로 실행한다. `runtime.retention.runOnce()`는 같은 처리를 즉시 실행한다.

| 분류 | 최대 보존 기간 | 주요 collection |
|---|---:|---|
| 추상 상태·장치 정산 | 7일 | events, abstractStates, portalNotifications, deviceButtonStates, gatewayDeviceReceipts |
| 상세·incident | 24시간 | gatewayTelemetry, locationPayloads, locationLeases, handoverPayloads, handoverObservations, portalIncidents, portalOperations, deviceIncidentEvents, portalCommandRequests |
| 가명·연결 | 24시간 | pseudonymMappings, relayAssociations |
| 최소 감사 | 30일 | receipts, JSONL journal, SQL receipt outbox, mcpEvidence |
| 합성 학습 provenance | 30일 | flProvenance, flWorkerUpdates, participant dataset seed/split, localTrainReceipt |

각 row의 `expiresAt`이 더 이르면 해당 시각을 적용한다. 위치 lease의 짧은 유효기간과 grant의 현재 권한 판정은 조회 경로에서 함께 적용한다. `core.retention.householdPolicies`는 가구별 분류 수명을 밀리초로 단축한다. 예를 들어 `{ "household-1": { "detail": 3600000, "audit": 604800000 } }`는 상세 1시간·감사 7일을 적용한다. 최소 수명은 1초다.

FL provenance 만료는 seed/split/sample ID를 정리하고 해당 contributor가 포함된 모델 serving을 `SERVING_PAUSED/PROVENANCE_EXPIRED`로 전환한다. 모델 바이트·불변 manifest와 해시 계보는 별도 모델 검토 수명으로 유지한다. 새 participant 등록과 승인 checkpoint 기반 재학습으로 다음 모델을 생성한다.

JSONL compaction은 같은 파일의 append와 직렬화하고 임시 파일을 원자적으로 교체한다. PostgreSQL은 receipt outbox의 만료 사본을 함께 삭제하며 journal advisory lock으로 다른 DB worker의 drain과 조율한다. 삭제 receipt에는 상세 원문을 넣는 대신 collection 개수와 hash를 기록한다. 공유 PostgreSQL journal writer는 store outbox 경로를 사용한다.

```powershell
node --test test/retention.test.mjs
node scripts/verify-postgres.mjs
node scripts/run-retention.mjs --config=../.local/api.json
```

마지막 명령의 API 설정에는 `database`, 공통 MEC 암호 키, 선택 `receiptPath`를 넣는다. 로컬 JSON store는 해당 runtime의 `retention.runOnce()`로 실행한다. 자동 주기의 상태는 `runtime.retention.lastResult/lastError`에서 확인한다. 보존 기간 경계, restart, journal 동시 append, FL serving fence, 실제 PostgreSQL 삭제를 시험한다. 외부로 내보낸 release 증거와 사용자 다운로드 파일은 각 보관 담당의 TODO topic으로 관리한다.
