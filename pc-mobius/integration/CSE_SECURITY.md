# Mobius4 표준 구독 절차

배포 CSE는 `deployment/cse/upstream.json`에 고정한 Mobius4 4.25.0 revision
`e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`의 `cse/`와 `docker/` 바이트를 그대로 실행한다.
아티팩트 빌드는 의존성 메타데이터인 `package.json`과 `package-lock.json`만 고정 버전으로 교체한다.

## 구독 생성

`<subscription>` 생성에는 부모 자원의 CREATE와 구독 대상 자원의 RETRIEVE가 함께 필요하다.
Mobius4는 일반 CREATE 접근 결정과 `cse/resources/sub.js`의 RETRIEVE 결정을 차례로 수행한다.

RETRIEVE 전용 주체는 `integration/src/cse-subscription-lifecycle.mjs`의
`subscribeWithTransientCreate`를 사용한다.

1. ACP 관리자가 해당 주체에 CREATE와 RETRIEVE를 부여한다.
2. 해당 주체가 자신의 Originator로 `<subscription>`을 만든다.
3. ACP 관리자가 원래 정책을 복원하고 readback으로 CREATE 회수를 확인한다.

## 알림 대상 검증

배포 파일 `deployment/cse/local.json`은 다음 값을 제공한다.

```json
{
  "cse": {
    "subscription_verification": true
  }
}
```

Compose는 이 파일을 `/app/config/local.json:ro`에 마운트한다. Mobius4의 node-config가
`config/default.json`과 `config/local.json`을 병합한다.

AE 자원 ID 형식의 `nu`를 사용하면 Mobius4가 AE의 `poa`로 verification request를 보낸다.
요청에는 `vrq: true`와 구독 creator를 나타내는 `cr`이 포함된다. 수신기는 등록한 creator에
2000을 반환하고 다른 creator에 4101을 반환한다. 대시보드 BFF, multi-app 수신기, KEYRING
영수증 ingress가 이 검사를 수행한다.

URL 형식의 `nu`는 Mobius4 4.25.0의 직접 URL 알림 경로를 사용한다. 외부 송신 범위는 VM
네트워크 방화벽이 제한한다.

## 권한 회수

알림 전송 절차는 생성 시 확정한 구독을 사용한다. ACP 회수는 `revokeSubscriber`로 다음 순서를
보장한다.

1. 해당 주체의 `<subscription>`을 삭제한다. 4004는 완료 상태로 정산한다.
2. ACP를 회수 정책으로 갱신한다.
3. ACP readback으로 최종 권한을 확인한다.

handover의 `fence`도 이 순서를 사용한다. `release`는 동일 구독의 4004를 완료 상태로 정산한다.

## VM CSE 구독 목록

acop 비트는 CREATE 1, RETRIEVE 2, UPDATE 4, DELETE 8, NOTIFY 16, DISCOVERY 32이다.

| 경로와 역할 | CREATE Originator | 구독 대상 acop | `nu` 형식 | Mobius4 4.25.0 결과 | 적용 내용 |
|---|---|---:|---|---|---|
| `deployment/provision-cse.mjs`, `provision.mjs`, `mqtt-bridge.mjs` | 구독 생성 0건 | — | — | AE·ACP·container 프로비저닝과 MQTT primitive 전달 유지 | 변경 0건 |
| `deploy/mec-sandbox/ipe/*` → `MecIpe` intake·ownership·device watch | `MEC_IPE_ORIGINATOR`, 기본 `Cpb-mec-ipe` | IPE 소유 자원 63, 장치 AE 3 | URL, `MEC_IPE_ONEM2M_URL/onem2m/<token>` | CREATE와 RETRIEVE 충족, 직접 URL 전달 | 기존 절차 유지 |
| `MecOneM2mConsumer.watchDevice` | 정책 AE Originator | location·rnis에 35 | URL, 정책 수신기의 `/onem2m/<token>` | CREATE와 RETRIEVE 충족, 직접 URL 전달 | 기존 절차 유지 |
| `web-dashboard/server/cse-live.ts` labeled-keyring 모드 | operator AE 또는 guardian AE | multi-app ACP에서 35 | AE 자원 ID | 생성 성공, `vrq.cr` 일치 시 2000 | BFF ingress에 앱별 creator 검사 추가 |
| `web-dashboard/server/cse-gateway-poll.ts` VM 기본 모드 | 구독 생성 0건 | 읽기 역할에 2 또는 34 | — | `la`와 discovery polling 유지 | 변경 0건 |
| `handover-cse.mjs` 복원 구독 | Edge 설정의 관리 Originator | 복원 자원에 63 | URL과 `subscription` query | 생성·callback 유지 | `fence`에서 구독 삭제 후 ACP 축소 |
| `fl-onem2m-coordinator.mjs` participant·round update 구독 | FL coordinator AE-ID | coordinator ACP에서 63 | URL | 생성·알림 유지 | 기존 절차 유지 |
| `multiapp/automation-ae.mjs`, `gateway-emulator.mjs`, 대시보드 앱 | 각 automation·gateway·operator·guardian AE-ID | 대상 stream에 35 | AE 자원 ID | 생성 성공, creator 검증 성공 | 공용 ingress에 경로별 creator 검사 추가 |
| `keyring/dev/mobius4/receipt-settlement/register-subscriptions.mjs` | `CSE_ADMIN` | 영수증 container 관리 권한 63 | URL | 직접 URL 전달 | ingress의 등록 `creators` 검사 추가 |
| `run-protocol-matrix-real.mjs` app push | app AE-ID | 평상시 34, 생성 구간 35 | URL | 임시 CREATE 구간에서 생성 성공 | `subscribeWithTransientCreate` 적용 |
| `run-acp-real.mjs`, `run-acp-mtls-real.mjs` desired 구독 | MEC IPE AE-ID | 평상시 2, 생성 구간 3 | sink AE 자원 ID | RETRIEVE 전용 4103, 임시 CREATE 2001 | 임시 CREATE·creator 검증·삭제 우선 회수 검사 추가 |
| `run-mec-ipe-real.mjs`, `run-mec-ipe-sandbox.mjs`, `run-mec-day-of-care.mjs` 앱·orchestrator 구독 | app·policy·orchestrator AE-ID | observation·lifecycle 자원에 35 | URL | 생성·알림 유지 | 기존 절차 유지 |
| `run-anomaly-triage.mjs`, `run-video-live.mjs` resident feed 구독 | routine·triage 등 앱 AE-ID | resident ACP에서 35 | URL 또는 triage AE 자원 ID | 생성·알림 유지 | triage AE verification creator 검사 추가 |
| `contracts/oneM2M-test-contract.v1.json`, `v2.json` | contract 실행 Originator | 시험 자원 소유 권한 63 | MQTT URL | CREATE와 RETRIEVE 충족 | 기존 계약 유지 |

`pc-mobius/test`의 fake CSE와 단위 fixture는 저장소 내부 시험 전용이다. VM 실행 목록은 위 표에
정리했다.

## 방화벽 경계

VM의 `cse-lan-firewall.sh`에 CSE 컨테이너 IP를 source로 하는 outbound 규칙을 다음 순서로 추가한다.

| 순서 | 일치 조건 | 처리 |
|---:|---|---|
| 1 | `ESTABLISHED,RELATED` | `ACCEPT` |
| 2 | VM DNS resolver IP의 UDP·TCP 53 | `ACCEPT` |
| 3 | `cse-db` IP의 TCP 5432 | `ACCEPT` |
| 4 | 승인된 내부 AE callback IP와 해당 TCP 포트 | `ACCEPT` |
| 5 | CSE 컨테이너 IP의 나머지 신규 outbound | `DROP` |

Docker 배포에서는 이 순서를 `DOCKER-USER` chain의 Docker 자동 규칙보다 앞에 둔다. callback
주소가 여러 개면 4번 규칙을 주소·포트 쌍마다 만든다. URL `nu`의 목적지가 승인 목록에 속할 때
CSE 알림이 전달되고 나머지 목적지는 5번 규칙에서 정산된다.

## 재현

```powershell
$env:MOBIUS4_ROOT = '<mobius4-4.25.0-upstream 아티팩트 압축 해제 경로>'
node pc-mobius/scripts/run-acp-isolated.mjs
```

runner는 upstream Mobius4 소스 사본으로 CSE 두 개를 띄우고 PostgreSQL·PostGIS를 사용한다.
검사 항목은 역할별 CRUDN·DISCOVER, RETRIEVE 전용 생성 거부, 임시 CREATE 복원, creator 검증,
구독 삭제 우선 회수, 위치 보호이다.

고정 4.25.0 아티팩트 실행 결과는 ACP 838/838, 위치 보호 5/5 PASS이다. 저장소 `npm run verify`는
core 266건, web 117건, Gateway 167건, 교차 런타임 11건과 계약·데모·웹 빌드를 PASS로 정산했다.
