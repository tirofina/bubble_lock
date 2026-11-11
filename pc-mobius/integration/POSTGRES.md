# PostgreSQL 정책 정본

`PostgresIntegrationStore`는 기존 `get/list/collection/put/append/snapshot` 인터페이스와 `transaction(lockKey, operation)`을 제공한다. PostgreSQL namespace 한 행을 `SELECT FOR UPDATE`로 읽고, 최신 정책·권한·claim·FL 상태와 outbox를 같은 SQL transaction에서 commit한다. `runtime_state.version` CAS, 명령/member unique claim, 정책 idempotency unique key, FL `(task, round, baseModelVersion)` unique key와 모델 generation 단조 증가를 SQL로 검증한다.

이는 `SERIALIZABLE` isolation의 namespace 단위 직렬화 방식이다. serialization conflict/deadlock은 최신 snapshot으로 최대 4회 재시도하며 초기 schema transaction에도 같은 복구 한도를 적용한다. 여러 namespace는 독립적으로 진행한다. 현재 namespace 내 정책 정합성을 우선하며, 부하 확장은 같은 계약의 entity별 행 잠금으로 분리할 수 있다. `get/list`의 동기 읽기는 현재 transaction snapshot을 사용한다. 외부 프로세스의 최신 변경을 읽는 작업은 `transaction(...)` 또는 `await store.refresh()`를 사용한다. DB 시각은 authority row lock을 획득한 직후 별도 `clock_timestamp()` 쿼리로 읽는다.

## 설정

실제 접속값은 gitignore 대상인 `.local`의 API 설정에 보관한다. 형식은 [postgres.example.json](../config/postgres.example.json)이다. `createIntegrationRuntime({ database, core })` 또는 `PRIVACY_BUBBLE_API_CONFIG`로 API 설정을 전달한다. 환경변수 방식은 `BUBBLE_DATABASE_URL`, `BUBBLE_DATABASE_NAMESPACE`, `BUBBLE_MEC_ENCRYPTION_KEY`를 사용한다.

모든 worker는 같은 namespace와 32바이트 base64 MEC 암호 키를 사용한다. 이 키는 기존 MEC ciphertext 복구에 연결된다. 원격 PostgreSQL 접속은 `database.ssl`의 CA·인증서 검증 설정과 함께 구성한다. 저장소 초기화는 [003_runtime_transactions.sql](../db/migrations/003_runtime_transactions.sql)을 migration advisory lock 아래 적용한다.

로컬 검증용 PostgreSQL17.11은 `.local/postgres/runtime/pgsql`에서 실행하고, 연결 파일은 `.local/postgres/connection.json`이다. DB는 `bubble_policy`, loopback port는 15432다. OneDrive 경로의 PostgreSQL 초기화 충돌을 해결하기 위해 실제 data는 `%LOCALAPPDATA%/bubble-lock-pg-data-20261110`에 두고 `.local/postgres/data` junction으로 연결했다. 비밀값은 `.local` 파일에서 읽는다.

## 트랜잭션 경계

- `PolicyService`: consent·grant 발급, policy 승인, grant 회수의 읽기·판정·기록을 하나로 묶는다.
- `GatewayControl`: 현재 grant/consent/epoch 판정·claim 생성·감사 receipt를 함께 commit한다. authorize도 최신 DB snapshot과 DB 시각을 사용한다.
- 예약은 `RESERVED/reservedAt/reservationExpiresAt`, 승인 claim은 `DISPATCH_CLAIMED/claimCommittedAt/claimExpiresAt`로 구분한다. 두 기한은 `min(grant, consent, command.deadline, 예약 DB시각+5초)`로 고정한다. 승인과 device lane·dispatchOutbox를 같은 transaction에 저장한다. admitted claim의 만료는 `DISPATCH_UNCERTAIN`으로 정산을 기다리며 정확한 ACK/readback 뒤 `APPLIED_VERIFIED`로 전환한다.
- `dispatch-start`는 전송 직전 current policy·동일 claim을 다시 확인하고 최초 `dispatchStartedAt/IN_FLIGHT`를 저장한다. device별 desiredGeneration과 현재 입장 generation fence는 같은 authority에 보존한다. 원본 receipt·최종 readback·lane 해제·dispatch outbox 정산도 하나의 transaction이다.
- `FlCoordinator`: 각 task 잠금 안에서 selection/update/preparation/commit/publication/withdraw를 SQL transaction으로 처리한다. 모델 commit·pointer·publication outbox가 함께 반영된다.
- MEC·MCP: 각 내부 상태 전이의 기존 transaction 경계를 보존한다. 외부 HTTP/tool 호출은 준비 상태를 commit한 뒤 진행하고, 결과를 다음 transaction에 반영한다.
- API: 로컬 정책·포털·Gateway 요청을 transaction으로 감싸고, MEC/MCP/FL/handover는 자체 단계 경계를 사용한다. DB 연결·transaction 오류는 503으로 반환한다.

동기 설정 등록에는 `stagePut(collection, id, value)`를 사용할 수 있다. 같은 worker의 다음 transaction/`flush()`에서 최신 DB 상태에 설정을 합친다. 운영 상태 read-modify-write는 `transaction` 내부에서 실행한다.

## 감사 outbox와 복구

`runtime_receipt_outbox`는 상태와 같은 commit에 저장된다. JSONL 출력은 commit 뒤 별도로 수행한다. 파일 append 직후 process가 종료되어도 다음 drain에서 eventId를 대조해 같은 로그를 정산한다. 파일 출력 장애는 DB outbox에 남고 `store.lastJournalError`로 조회한다. `await store.drainJournal()`로 재처리한다.

SQL rollback은 상태·projection·outbox를 함께 되돌린다. 새 worker는 `init()`에서 최신 committed state를 읽는다. FL coordinator는 해당 round에 `recover()`를 호출해 epoch를 올리고, 기존 모델 hash와 nextRound를 이어간다. DB 복구에는 PostgreSQL 백업/WAL과 공통 MEC 암호 키를 함께 보존한다.

기존 JSON 상태를 새 namespace로 이관하는 명령:

```powershell
node scripts/migrate-integration-state.mjs --input=integration/state/runtime.json --namespace=bubble-lock --config=../.local/postgres/connection.json
```

이관기는 version0·빈 namespace를 수용하고 원본 hash, collection 수, receipt 수를 출력한다. 기존 MEC state를 이관할 때 원래 `<statePath>.mec-key`의 32바이트를 새 worker의 공통 키로 설정한다.

## 실제 검증

```powershell
node scripts/verify-postgres.mjs
npm run verify
```

PG runner는 실제 PostgreSQL과 18개 Node 자식 프로세스를 사용한다. 동일 명령 claim, SQL Lock 대기 중 회수/승인, commit 전 process 종료, commit 후 journal 재전송, FL prepared-consent CAS, 2coordinator 단일 commit, 새 process 복구, 실제 API의 DB 연결·SERIALIZABLE isolation, 보존 기간에 따른 상세/SQL outbox/JSONL 삭제, 두 Gateway의 단일 lane·전송 시작·native 영수증 정산, 대기 lock 획득 후 DB 시각을 11개 시험으로 확인한다. 결과와 source SHA·DB version·commit digest·process ID는 `.local/postgres/verification/<run>/report.json`에 기록한다. 보존 정책은 [RETENTION.md](RETENTION.md)에 연결되어 있다.

2026-11-10 실제 검증에서 PostgreSQL17.11 서버를 재시작하고 namespace version·state SHA-256 일치를 확인했다. 해당 근거는 `.local/postgres/restart-report.json`이다. 실제 장치 실행 횟수와 ESTIMED VM 배포 증거는 해당 gate의 별도 receipt에 연결한다.

구현 근거: [PostgreSQL row lock](https://www.postgresql.org/docs/17/explicit-locking.html), [node-postgres transaction](https://node-postgres.com/features/transactions), [공식 Windows 배포](https://www.postgresql.org/download/windows/).
