# MEC Location·RNIS 실행 계약

기준은 `privacy_bubble_expert_v3/review_assets/round03/contracts_round03.json`의 `mec_contract`·`callback_ingestion`이다. R15/R16 및 A16–A18의 구현과 M01–M09 실행 증거를 이 문서에 연결한다.

## 실행과 증거

```powershell
cd pc-mobius
npm run integration:mec
npm test
npm run integration
```

`integration:mec`는 로컬 공급자 HTTP 서버 두 서비스를 대상으로 discovery·query·구독 POST/GET/PUT/DELETE와 실제 HTTP 콜백을 실행한다. 결과는 `receipts/mec-http-verification.json`에 저장한다. `simulation: true`는 로컬 공급자 관측임을 나타낸다. 외부 MEC Sandbox 수용은 실제 endpoint·인증서·Swagger hash·operationId·TLS callback 왕복 receipt를 G-MEC에 연결한다.

## 구현 경로

| 파일 | 동작 |
| --- | --- |
| `src/mec-http-client.mjs` | Mp1 서비스 검색, Location/RNIS 조회와 구독 CRUD, 고정 endpoint 범위, 응답 크기·시간 제한 |
| `src/mec-subscriptions.mjs` | 승인 정책의 UE/권한/세대에 결합된 구독, opaque callback 경로, 생성·삭제 불확실성, 재조정·재시도·운영 후속조치 |
| `src/mec-adapter.mjs` | 현재 권한과 시각 검증, canonical 중복 제거, 암호화 수신 저장, outbox 실행, geofence·health 재조정 |
| `src/mec-state.mjs` | 좌표·영역 검증, 시각 정규화, AES-256-GCM, 최소 audit ACK |
| `test/mec-http.test.mjs` | M01–M09, CRUD, 권한 회수 경합·복호화, 재시작, complete inventory 복구 |

## 승인 정책과 API

승인 정책에 `grantId`, `ueId`, `geofence`를 둔다. 자동 핸드오버에는 `targetEdgeId`를 함께 승인한다. `expiresAt`, `services`, `appInstanceId`, `subscriptionIds`는 선택 값이다. 정책의 소유자와 grant 소유자가 일치해야 한다. 콜백 본문은 관측 값만 제공하며, 실행 대상과 영역은 저장된 승인 정책에서 읽는다.

| 경로 | 권한과 동작 |
| --- | --- |
| `POST /v1/mec/subscriptions` | `mec:manage`, 본인 승인 정책, `{policyId, service, idempotencyKey}` |
| `GET /v1/mec/subscriptions` | 본인 정책의 구독 상태 목록 |
| `GET /v1/mec/subscriptions/{key}` | 본인 구독의 영속 상태 |
| `PUT /v1/mec/subscriptions/{key}` | 현재 승인 구독을 공급자 PUT으로 재적용 |
| `DELETE /v1/mec/subscriptions/{key}` | tombstone commit 후 공급자 삭제·재시도 |
| `POST /callbacks/{Location|RNIS}/{token}` | `mec:callback`, 등록된 공급자 principalId와 mTLS fingerprint |
| `POST /v1/mec/callback` | 동일 인증과 `{service, token, payload}` 형태의 호환 수신 경로 |

`MecCallbackIngress.ingest()`는 `simulation: true`를 가진 내부 데모에 사용한다. HTTP 수신은 `ingestCallback()`에서 token·provider·UE·current grant를 검증한다. 공급자 ACK는 payload/dedup/watermark/outbox/receipt가 함께 commit된 뒤 반환한다. 처리 결과는 `ack`, `status`, `receiptId`와 canonical `eventKey`로 확인한다. API 오류의 callback URI는 token을 마스킹한다.

## 데이터 경계와 저장

256bit CSPRNG token의 SHA256과 암호화 전달 secret을 보관한다. 위치 원문은 AES-256-GCM ciphertext로 저장하고, 매 복호화와 집행 때 현재 grant revision·유효기간·동의를 다시 검사한다. 최소 audit에는 hash·수신 시각·판정 사유를 기록한다. 위치·raw callback·token은 상세 audit 본문과 API 구독 목록에서 분리한다.

grant 회수와 콜백 수신은 `store.transaction(lockKey, operation)`으로 직렬화한다. 파일 저장 모드는 단일 Node runtime 안에서 복제 스냅샷을 원자 rename으로 commit한다. 여러 프로세스 배포에는 동일 인터페이스의 PostgreSQL transaction 저장소와 해당 동시성 receipt를 적용한다. callback 공급자 네트워크 요청은 `desired commit → HTTP → actual commit` 단계로 실행한다.

상세 ciphertext·dedup·watermark는 24시간, 최소 callback audit는 30일 보존한다. tombstone은 공급자 정리 완료까지 유지하고 정리 후 24시간을 추가한다. 암호 키는 주입된 32byte `encryptionKey` 또는 상태 파일 옆 `.mec-key` 비밀 파일에 둔다. 운영 환경은 비밀 저장소에서 같은 키를 runtime에 주입한다.

`MEC_UE_LOCATION`은 승인된 UE 위치이고 `BLE_RELAY_OBSERVATION`은 키링과 릴레이의 근접 관측이다. 두 sourceType의 subject와 uncertainty를 유지한다. 키링 위치로 결합하는 단계는 가구 승인 relay/UE 연결 및 거리·시간 조건을 사용한다.

## 배포 capability

`createIntegrationRuntime({core:{mec:{Location:{...},RNIS:{...},callbackBaseUrl,encryptionKey}}})`로 adapter를 설정한다. 서버 실행의 `PRIVACY_BUBBLE_API_CONFIG`는 `core`를 runtime으로 전달한다. Location/RNIS 각각에 `endpoint` 또는 `platformRoot`, `allowedEndpoints`, `providerId`, `providerFingerprint`, `simulation`, `capabilities`를 설정한다.

`capabilities.list`, `listComplete`, `update`, `verifiedSourceTime`, `endpointVersion`, `schemaHash`는 공급자 지원 계약을 표시한다. `listComplete`는 공급자가 전체 소유 구독 목록을 제공한다는 확인 이후 사용한다. 실제 관측 수신에는 `deploymentVerified: true`와 해당 Swagger에서 만든 `validateCallback(payload)` 함수를 주입한다. 런타임 JavaScript 설정은 검증 함수를 직접 연결한다. JSON 배포 설정은 아래 deploymentSchema로 원본 OpenAPI hash·operationId·callback schema를 로드한다. callback URL은 공급자가 접근할 수 있는 TLS 주소로 설정한다.

ETSI 공식 참조는 [MEC 012 RNIS API](https://forge.etsi.org/rep/mec/gs012-rnis-api)와 [MEC 013 Location API](https://forge.etsi.org/rep/mec/gs013-location-api)다. 실제 배포 판본은 공급자 manifest의 hash로 고정한다.


## JSON 배포 schema 연결

Location/RNIS 설정의 `deploymentSchema`에 공급자의 OpenAPI JSON과 SHA-256, callback schema의 JSON Pointer, 사용하는 operationId를 지정한다. `run-integration-api.mjs`가 크기·hash·OpenAPI 버전·HTTP method·로컬 참조를 검사하고 Ajv validator를 만든다. callback 원문은 선택 schema를 통과한 뒤 token·UE·시각·현재 grant 검사로 이어진다.

```json
{
  "deploymentSchema": {
    "file": "/etc/bubble-lock/location-openapi.json",
    "sha256": "<sha256 of exact OpenAPI JSON bytes>",
    "callbackPointer": "#/components/schemas/UserTrackingNotification",
    "operations": {
      "query": "<provider query operationId>",
      "create": "<provider subscription POST operationId>",
      "read": "<provider subscription GET operationId>",
      "delete": "<provider subscription DELETE operationId>"
    }
  }
}
```

`capabilities.update/list`를 활성화하면 대응하는 `update/list` operationId도 등록한다. JSON 안의 외부 `$ref`는 단일 문서의 로컬 참조로 묶어 고정한다. service 요청의 method/path는 지정 operationId와 대조하고 receipt transport 결과에 operationId/schemaHash를 보존한다. Mp1 service discovery는 플랫폼 경로의 별도 계약으로 조회한다. 실행 schema 시험은 `node --test test/mec-deployment-schema.test.mjs`다.

## 자동 이동의 관측·시간 경계

MEC reconciler는 승인 정책의 `trigger.kind`를 `HandoverCoordinator.considerTrigger`에 전달한다. 기본 `zone`은 원의 반경에서 haversine 거리를 빼거나 bbox의 가장 가까운 경계 거리를 계산하고, 위치 uncertainty를 뺀 내부 여유가 20m 이상인 관측을 사용한다. source 관측 시각으로 10초 연속 체류를 확인하며 관측 사이 간격은 최대 5초다. 구역 밖·건강 변경·policy/grant revision·epoch 변경은 누적 상태를 초기화한다.

`trigger.kind="health"`는 RNIS의 `UNHEALTHY` 또는 `DOWN`을 사용한다. 1초 이상의 간격으로 3회 관측을 누적하고 정상 관측은 횟수를 초기화한다. 동일 event와 outbox 재시도는 관측 시간이나 실패 횟수를 늘리는 수단과 구분한다. 기존 소유 CSE의 최소 체류는 30초, 실제 이동 후 cooldown은 60초다. 초기 소유자 배치는 현재 승인·구역 조건을 확인하고 별도 `initial-approved-placement` 사유를 기록한다.

트리거가 대기 상태이면 event 처리를 완료하고 다음 새 관측을 기다린다. 실제 전환의 정산 중 상태는 outbox 재시도와 연결한다. 트리거 판정과 handover 준비 트랜잭션 각각에서 현재 grant·revision을 재검사한다. `test/mec-trigger.test.mjs`는 경계 거리·uncertainty·연속 시각·중복·건강 횟수·체류·cooldown·회수를 검증한다.

## 보관 정산

MEC 상세·dedup·watermark·outbox는 24시간 만료를 사용한다. 공급자 cleanup 완료 구독은 request ciphertext를 정리하고 24시간 뒤 구독 상세와 tombstone을 삭제한다. cleanup 진행 중 tombstone은 후속 정산에 보존한다. `MEC_RETENTION_EXPIRED`는 삭제 개수·collection별 개수·삭제 키 집합 hash를 기록한다. 30일 감사 metadata와 PostgreSQL receipt outbox 정리는 공통 `RetentionService`가 담당한다.
