# PC-MOBIUS-CORE 임시 Mobius4 테스트 하니스

이 폴더는 학교 PC에서 Privacy Bubble의 중앙 Mobius IN-CSE와 Raspberry Pi Gateway 연동을 검증하는 휴대 가능한 기준이다. 실제 Mobius4 소스는 저장소 외부 경로로 관리하고 `MOBIUS4_ROOT`로 연결한다. 후속 PC에서도 같은 계약·스크립트·영수증 구조를 재사용할 수 있다.

기본 시연 경로는 `Keyring BLE → Raspberry Pi Gateway → MQTT/HTTPS → Mobius4 PC`이다. `contracts/raspberrypi-gateway.v1.json`이 현장 payload와 ACK/readback 정본이며, PC Gateway emulator는 사전 검증에 사용한다.

## 역할 선언

```text
ROLE: PC-MOBIUS-CORE
DOC: PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md
DOC-REV: 2.0.0
RUBRIC: R01,R02,R03,R06,R07,R11
SCOPE: Mobius CSE, oneM2M resource, SDT, Group, Subscription, MQTT/HTTP binding, DB
```

## 실행 순서

1. Mobius4 소스와 Docker Desktop을 준비한다. Mobius4 공식 Docker Compose가 PostgreSQL/PostGIS·MQTT를 함께 제공한다. `-Mode source` 경로는 이미 준비된 로컬 의존 서비스와 연결한다.
2. `config/mobius4-test.env.example` 값을 로컬 환경에 맞춰 지정한다. `MOBIUS4_ORIGINATOR`와 `MOBIUS4_ADMIN_IDENTITY`는 동일한 개인 테스트용 식별자로 맞춘다.
3. Mobius4의 flexContainer registry에 Privacy Bubble binarySwitch를 등록한다: `node ./scripts/prepare-specialization.mjs --mobius-root <mobius4-source>`.
4. PowerShell에서 `./scripts/start-mobius4-test.ps1 -Mobius4Root <mobius4-source>`를 실행한다. 소스 실행은 `-Mode source`를 지정한다.
5. 다른 터미널에서 `node ./scripts/validate-contract.mjs`로 계약을 확인한다.
6. `node ./scripts/run-contract.mjs`로 AE·flexContainer·subscription·group·retrieve 흐름을 실행하고 `receipts/` JSON을 보관한다.
7. 서비스 준비 전에는 `node ./scripts/run-contract.mjs --dry-run`으로 requestId·receipt 형식을 먼저 확인한다.

Node.js 검증 묶음은 `npm test`, `npm run validate`, `npm run dry-run` 명령으로 실행한다. 이 묶음은 Mobius4 계약과 Raspberry Pi Gateway 계약의 revision·resource·transport 연결을 자동 확인한다.

## Raspberry Pi MQTT ↔ Mobius Bridge

`src/gateway-bridge.mjs`는 Pi telemetry를 `pb:binarySwitch` oneM2M UPDATE로 변환하고, command publish와 ACK/readback을 하나의 receipt 흐름으로 연결한다. `MOBIUS4_ONEM2M_TRANSPORT=http`는 HTTP binding, `MOBIUS4_ONEM2M_TRANSPORT=mqtt`는 `/oneM2M/req/{originator}/{cseId}/json` binding을 사용한다. `src/receipt-journal.mjs`를 통해 JSONL receipt와 SHA-256 hash를 영속화한다. 실제 MQTT broker와 Mobius4가 준비되면 `npm install` 후 `npm run bridge`를 실행한다. 환경변수는 `MOBIUS4_MQTT_URL`, `MOBIUS4_URL`, `MOBIUS4_ORIGINATOR`, `MOBIUS4_GATEWAY_ID`, `MOBIUS4_RECEIPT_PATH`, `MOBIUS4_ONEM2M_TRANSPORT`, `MOBIUS4_CSE_ID`를 사용한다.

`src/group-dispatcher.mjs`는 oneM2M Group/fan-out 명령을 구성원별 commandId로 분배하고, ACK/readback 집계와 pending member retry를 제공한다.

`db/migrations/001_core_receipts.sql`은 gateway event dedup, group dispatch, receipt journal, oneM2M HTTP/MQTT binding을 PostgreSQL에 기록한다. Mobius4 companion DB에 migration을 적용하면 runtime receipt와 재처리 기준을 공유할 수 있다.

`release/manifest.json`과 `scripts/build-release-manifest.mjs`는 구현 artifact SHA-256과 실행 명령을 release evidence로 묶는다. `scripts/replay-receipt.mjs --input <receipt.json>`은 저장된 receipt의 contract·request·status 분포를 재생 검증한다.

개발 흐름은 `npm test`의 fake MQTT·fake HTTP 검증 → 실제 Raspberry Pi MQTT trace → Mobius4 HTTP receipt 순서로 운영한다.

## 계약 기준

`contracts/oneM2M-test-contract.v1.json`이 wire 정본이다. 모든 요청은 `X-M2M-RVI: 4`, `X-M2M-Origin`, 고유 `X-M2M-RI`를 전달한다. HTTP 계약과 MQTT 계약은 같은 requestId를 사용하여 이벤트와 응답을 연결한다.

### 다른 담당자와의 연결

- KEYRING: `bubbleState` flexContainer payload와 Gateway MQTT notification을 사용한다.
- PC-MOBIUS-INTEGRATION: API/Auth·ACP·grant·MEC·callback·handover·FL·MCP 결과를 동일 receipt에 연결한다.
- APP: oneM2M API와 approval/command idempotency를 전달한다.
- WEB-DASHBOARD: subscription event와 resource tree를 표시하고 receipt link를 제공한다.

## 증거 기준

계약 버전, 문서 개정, stepId, requestId, 응답 코드, 타임스탬프를 한 receipt에 기록한다. Red·Blue 검토와 Green 승인에 이 receipt 경로를 함께 제출한다.
