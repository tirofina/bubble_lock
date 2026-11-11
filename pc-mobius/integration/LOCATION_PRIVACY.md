# 정밀 위치 승인·암호화 계약

활성 근거는 round03 `canonical_policy.location`과 `mec_contract.location_subject`입니다. 정밀 관측은 AES-256-GCM으로 암호화하며 CSE의 CIN은 payload reference·hash·관측 종류·시각·만료 정보와 oneM2M `et`를 보관합니다. Gateway 관측, handover delta와 MEC callback 원문은 각각 암호화 저장 경로를 사용합니다. 파일 저장소의 키는 상태 JSON과 분리한 `.mec-key` 파일이고 PostgreSQL 런타임은 공통 배포 키를 주입합니다.

## 수신자별 조회 승인

`POST /v1/portal/location-leases`는 같은 가구의 보호자가 승인합니다. BFF 경로는 `/api/portal/location-leases`입니다.

```json
{
  "idempotencyKey":"location-approval-1",
  "grantId":"grant-current",
  "recipientId":"visitor-registered",
  "deviceIds":["keyring-A"],
  "purpose":"선택한 grant의 purpose",
  "incidentId":"incident-open",
  "ttlSec":60
}
```

grant에는 `location:read`가 포함되어야 합니다. 수신자는 현재 가구 구성원이며 사건은 같은 가구의 `OPEN` 사건입니다. 사건이 특정 기기를 가리키면 승인 기기 범위도 해당 기기로 한정합니다. 유효기간은 1~300초이고 grant 만료 시각 안으로 제한합니다. 반환된 lease는 grant·consent revision, 목적, 사건, 수신자, 기기, 승인자와 만료를 함께 기록합니다.

`POST /v1/portal/location-leases/revoke`의 입력은 `{idempotencyKey,leaseId}`이며 수신자 또는 가구 보호자가 회수합니다. 포털 snapshot의 `locationLeases[].effectiveStatus`는 현재 grant·동의 revision, 가구 구성원·보호자 권한, 목적, 사건 상태와 lease 만료를 매번 평가합니다.

`GET /v1/portal/locations`는 같은 트랜잭션에서 `deviceIds`, `observations`, `readExpiresAt`을 반환합니다. 각 decrypt는 수신자·목적·사건·lease·revision을 다시 검사합니다. 응답 권한은 최대 5초이고 브라우저는 만료 시각에 좌표를 비웁니다. 조회 중 회수 경쟁은 BFF의 초기·최종 기기 범위 교집합으로 처리합니다. 원시 LIVE JSONL도 같은 lease 범위와 관측 24시간 경계로 선택합니다.

## 릴레이 UE와 키링의 관계 관측

`POST /v1/portal/relay-associations`는 보호자의 현재 `mec:location` grant, `ueId`, `deviceId`, `gatewayId`, `gatewayPosition`, `maxDistanceM`, `maxAgeMs`, `referenceRssiDbm`, `pathLossExponent`, `idempotencyKey`를 받습니다. 등록 가구·기기·ACTIVE Gateway 연결을 확인하고 수신기 좌표는 association ID에 결속한 AES-GCM으로 보관합니다.

- 거리 상한: 1~1,000m. 시차 상한: 100~30,000ms.
- UE 위치와 BLE 관측의 시차·각 관측의 현재 나이를 함께 검사합니다.
- UE와 등록 수신기의 거리 + UE 정확도 반경 + RSSI 추정 반경이 승인 거리 안에 들어온 관측을 결합합니다.
- 결과 `sourceType`은 `BLE_RELAY_OBSERVATION`이며 정확도 반경은 UE 정확도와 BLE 범위의 합입니다. 지도는 이를 **릴레이 주변 관측 범위**로 표시합니다.
- `locationDeviceBindings` 문자열 매핑은 조회 권한을 발급하는 수단과 구분하며 관계 결합은 현재 승인 association을 사용합니다.

## 보관·기존 데이터 이행

`locationPayloads`, `handoverPayloads`, `gatewayTelemetry`, `handoverObservations`의 상세 보관은 최대 24시간입니다. lease는 해당 승인 만료 시각, association은 grant 만료 또는 24시간 안에서 정리합니다. 공통 `RetentionService`는 만료 자료를 삭제하고 최소 감사 receipt를 기록합니다.

런타임 시작 시 기존 `gatewayTelemetry.observation`과 원문 handover payload를 암호화 reference로 전환합니다. 이전 CSE CIN은 `locationCsePurge`에 등록한 RI와 원문 hash를 실제 응답에 대조한 뒤 삭제·404 readback으로 정산합니다. CSE 연결 설정을 제공하면 시작 시 해당 작업을 진행하며 `PENDING`은 다음 연결 점검 대상으로 유지됩니다. 이행 뒤 복원은 암호화 참조와 새 `et`를 사용합니다.

## 실행 증거

- `test/portal-location.test.mjs`: 암호화, recipient/purpose/incident/lease/revision, Gateway 상태, 릴레이 시간·거리, 승인·회수 HTTP.
- `test/handover-http.test.mjs`: HTTP 계약 서버의 암호화 참조 복원, 이전 CIN 정리, 30전환·1,000관측 보존.
- `scripts/run-location-privacy-real.mjs`: 실행 중인 실제 두 Mobius4 CSE에서 참조·et readback, 수신자 경계, 상태 파일 암호화, 재시작, 회수를 확인합니다.
- [`receipts/location-privacy-real-cse.json`](../receipts/location-privacy-real-cse.json): 실제 CSE HTTP 검증 5개 PASS, 입력 출처는 모의 GPS/BLE fixture입니다.

```powershell
node scripts/run-location-privacy-real.mjs --config=<local-cse-config.json>
```
