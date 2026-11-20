# R16 MEC 샌드박스 전환 절차

로컬 시뮬레이터로 검증한 MEC IPE를 실제 ETSI MEC 샌드박스(VM <VM_IP>)에 연결하는 명령 모음임.

2026-11-20에 sandbox `bubble`(시나리오 `dep-opt-b`, MEP `mep1`)로 전 과정을 실행했고 33개 항목이 PASS함. 한 번에 실행하는 명령은 `npm --prefix pc-mobius run integration:mec-ipe-sandbox`이며, 결과와 sandbox에서 확인한 동작은 `docs/rubric-work/R15-R16.md`의 "실제 sandbox 실행" 절에 있음. 이 sandbox는 Location v3만 제공하고(v2는 404), ingress CA는 `.local/mec-sandbox/ca.pem`, PC callback 주소는 `http://<PC_IP>:18092`임. 샌드박스 배포 자체는 quahog 세션의 `deploy/mec-sandbox/` 담당 범위이며, 이 문서는 IPE 쪽 설정과 확인 절차만 다룸.

## 준비물

| 항목 | 값 | 보관 위치 |
| --- | --- | --- |
| 샌드박스 주소 | `https://<VM_IP>` | 환경 변수 `MEC_BASE_URL` |
| 샌드박스 이름 | 샌드박스 UI 또는 API가 만든 이름(예: `sbx-xxxx`) | `MEC_SANDBOX_NAME` |
| MEP 이름 | 시나리오의 MEP(예: `mep1`) | `MEC_MEP` |
| k8s ingress CA | VM의 ingress 인증서 CA PEM | `.local/mec-sandbox/ca.pem` (`MEC_CA_FILE`) |
| UE 주소 | 시나리오의 UE IP(예: `10.100.0.1`) | 요청 cin의 `ueAddress` |
| 셀 ID | 시나리오 POA의 셀 ID | 승인 정책의 `servingCells` |
| IPE callback 주소 | 샌드박스 pod가 접근 가능한 PC LAN 주소 | `MEC_CALLBACK_PUBLIC_URL` |
| CSE | 로컬 Mobius4 (`http://127.0.0.1:7599`, `/Mobius`) | `ONEM2M_CSE_URL`, `ONEM2M_CSE_BASE`, `ONEM2M_CSE_ID` |

인증서와 키, 상태 파일은 모두 `.local/` 아래에 둠.

## 1. MEC011 목록 점검

Git Bash 기준 명령임.

```bash
export MEC_BASE_URL=https://<VM_IP>
export MEC_SANDBOX_NAME=sbx-xxxx
export MEC_MEP=mep1
export MEC_CA_FILE=.local/mec-sandbox/ca.pem
npm --prefix pc-mobius run integration:mec-ipe -- --discover-only
```

PowerShell 기준 명령임.

```powershell
$env:MEC_BASE_URL = 'https://<VM_IP>'
$env:MEC_SANDBOX_NAME = 'sbx-xxxx'
$env:MEC_MEP = 'mep1'
$env:MEC_CA_FILE = '.local/mec-sandbox/ca.pem'
npm --prefix pc-mobius run integration:mec-ipe -- --discover-only
```

출력 `services`에 `MEC013`(Location)과 `MEC012`(RNIS)가 `state: ACTIVE`로 있어야 함. `locationApiVersion`이 `v2`면 Location v2 경로(`userTracking`, `periodic`, `zonalTraffic`)를, `v3`면 `subscriptions/users`, `subscriptions/zones`를 사용함. 결과 파일은 `.local/mec-ipe/discovery-<시각>.json`에 저장됨.

| 출력 상태 | 조치 |
| --- | --- |
| `MEC_TRANSPORT_REVIEW` | `MEC_CA_FILE` 경로와 CA 내용 확인, 인증서 SAN에 접속 주소가 있는지 확인 |
| `MEC_HTTP_REVIEW` 404 | `MEC_SANDBOX_NAME`, `MEC_MEP` 철자 확인, 샌드박스 시나리오 배포 상태 확인 |
| `endpointRebased: true` | 목록의 endpoint 호스트가 접속 주소와 달라 접속 주소로 바꿔 사용한 상태임. 다른 호스트를 그대로 쓰려면 `MEC_ALLOWED_ORIGINS`에 그 origin을 추가함 |
| 버전 불일치 | `MEC_LOCATION_VERSION=v2` 또는 `v3`로 고정함 |

로컬 시험에만 `MEC_INSECURE_TLS=1`을 사용함. 샌드박스 연결은 `MEC_CA_FILE`을 사용함.

## 2. IPE 실행

```bash
export ONEM2M_CSE_URL=http://127.0.0.1:7599
export ONEM2M_CSE_BASE=/Mobius
export ONEM2M_CSE_ID=/Mobius4
export MEC_IPE_ORIGINATOR=Cmec-ipe
export MEC_IPE_AE_NAME=mec-ipe
export MEC_IPE_REQUESTERS=Cguardian-app
export MEC_IPE_READERS=Cguardian-app,Cmec-policy
export MEC_IPE_LISTEN_HOST=0.0.0.0
export MEC_IPE_LISTEN_PORT=18080
export MEC_IPE_ONEM2M_URL=http://127.0.0.1:18080
export MEC_CALLBACK_PUBLIC_URL=http://<PC-LAN-IP>:18080
export MEC_APP_INSTANCE_ID=<샌드박스 앱 인스턴스 ID, 선택>
export MEC_IPE_LEASE_SEC=120
npm --prefix pc-mobius run integration:mec-ipe
```

- `ONEM2M_CSE_ID`는 CSE 설정의 `cse_id` 값과 같아야 함. IPE는 알림의 `X-M2M-Origin`을 이 값과 대조함.
- 시작 출력 `IPE_READY`에 `paths.Location`, `paths.RNIS`, `paths.status`가 나옴. 출력 JSON 줄은 trace로 저장함(`... | tee .local/mec-ipe/sandbox-trace.jsonl`).
- PC 방화벽에서 18080 수신을 VM 대역에 허용함. 샌드박스 pod에서 `MEC_CALLBACK_PUBLIC_URL`로 접근 가능해야 MEC 알림이 도착함.
- 공식 meep-ipe(STF_685)를 같은 CSE에 함께 올리는 경우 `MEC_IPE_AE_NAME=pb-mec-ipe`처럼 다른 AE 이름을 사용함.
- 종료(Ctrl+C) 때 IPE가 만든 MEC 구독을 삭제함. 유지하려면 `MEC_IPE_TEARDOWN_ON_EXIT=0`을 설정함.

## 3. 장치 AE 준비

요청 대상 장치 AE에 다음 자원이 필요함. 실제 실행 스크립트 `pc-mobius/scripts/run-mec-ipe-real.mjs`의 장치 준비 구간과 같은 구성임.

| 자원 | ACP |
| --- | --- |
| `/Mobius/<device>` AE | 장치 63, IPE 3(구독용 CREATE+RETRIEVE), 앱과 정책 AE 34. acpi 연결은 CSE admin이 수행함 |
| `/Mobius/<device>/location`, `/rnis` 컨테이너 | 장치 63, IPE 7, 앱과 정책 AE 35 |

## 4. 요청 cin 작성

앱 AE(`Cguardian-app`)가 쓰는 요청 예시임. `intent`의 값은 PC 정책 서비스의 승인 정책과 grant에서 가져옴.

```bash
curl -s -X POST "http://127.0.0.1:7599/Mobius/mec-ipe/locationRequests" \
  -H 'X-M2M-Origin: Cguardian-app' -H 'X-M2M-RI: req-loc-1' -H 'X-M2M-RVI: 4' \
  -H 'Content-Type: application/json;ty=4' -H 'Accept: application/json' \
  -d '{"m2m:cin":{"cnf":"application/json","cr":null,"con":{"op":"subscribe","requestId":"loc-1","deviceAe":"<device>","ueAddress":"10.100.0.1","type":"periodic","periodSec":5,"durationSec":600,"intent":{"policyId":"<policyId>","grantId":"<grantId>","grantRevision":1,"policyRevision":1}}}}'

curl -s -X POST "http://127.0.0.1:7599/Mobius/mec-ipe/rnisRequests" \
  -H 'X-M2M-Origin: Cguardian-app' -H 'X-M2M-RI: req-rnis-1' -H 'X-M2M-RVI: 4' \
  -H 'Content-Type: application/json;ty=4' -H 'Accept: application/json' \
  -d '{"m2m:cin":{"cnf":"application/json","cr":null,"con":{"op":"subscribe","requestId":"rnis-1","deviceAe":"<device>","ueAddress":"10.100.0.1","type":"cellChange","durationSec":600,"intent":{"policyId":"<policyId>","grantId":"<grantId>","grantRevision":1,"policyRevision":1}}}}'
```

해지는 같은 컨테이너에 `{"op":"unsubscribe","requestId":"loc-1"}` cin을 씀. 장치 AE 삭제도 해당 장치의 MEC 구독을 모두 삭제함.

`run-mec-ipe.mjs` 단독 실행은 `authorize` 훅 없이 생성자 허용 목록과 ACP만 확인함. grant revision 확인까지 포함하려면 PC 런타임에서 `MecIpe`를 만들고 `authorize`에 정책 서비스 판정을 연결함(`run-mec-ipe-real.mjs`의 구성과 같음).

## 5. 확인

```bash
# 요청 상태 (ACTIVE, RENEWED, DELETED, REJECTED)
curl -s "http://127.0.0.1:7599/Mobius/mec-ipe/requestStatus/la" -H 'X-M2M-Origin: Cguardian-app' -H 'X-M2M-RI: chk-1' -H 'X-M2M-RVI: 4' -H 'Accept: application/json'
# 최신 위치 cin (loc는 격자 좌표, precise는 암호문)
curl -s "http://127.0.0.1:7599/Mobius/<device>/location/la" -H 'X-M2M-Origin: Cguardian-app' -H 'X-M2M-RI: chk-2' -H 'X-M2M-RVI: 4' -H 'Accept: application/json'
# zone 안의 장치 (geo-query, geom은 URL 인코딩한 [[[lon,lat],...]])
curl -s -G "http://127.0.0.1:7599/Mobius" --data-urlencode 'fu=1' --data-urlencode 'ty=3' --data-urlencode 'gmty=3' --data-urlencode 'gsf=1' \
  --data-urlencode 'geom=[[[7.42,43.737],[7.425,43.737],[7.425,43.74],[7.42,43.74],[7.42,43.737]]]' \
  -H 'X-M2M-Origin: Cguardian-app' -H 'X-M2M-RI: chk-3' -H 'X-M2M-RVI: 4' -H 'Accept: application/json'
# 샌드박스 쪽 구독 목록
curl -s --cacert .local/mec-sandbox/ca.pem "https://<VM_IP>/sbx-xxxx/mep1/location/v3/subscriptions/users"
curl -s --cacert .local/mec-sandbox/ca.pem "https://<VM_IP>/sbx-xxxx/mep1/rni/v2/subscriptions"
```

UE 이동은 샌드박스 UI의 시나리오 이동 기능이나 자동 이동 설정으로 발생시킴. trace에서 `MEC_SUBSCRIPTION_CREATED`, `MEC_NOTIFICATION_RECEIVED`, `ONEM2M_OBSERVATION_WRITTEN`, `MEC_SUBSCRIPTION_RENEWED`, `MEC_SUBSCRIPTION_DELETED` 순서를 확인함. `MEC_CALLBACK_REVIEW`의 `SCHEMA_REVIEW`나 `LOCATION_UNAVAILABLE`이 보이면 샌드박스 알림 원문을 저장해 `normalizeMecNotification` 필드 대응을 보강함.

## 6. 실물 receipt 항목

`docs/verification-evidence/<날짜>/mec-ipe-sandbox.json`에 다음 항목을 기록함.

| 항목 | 내용 |
| --- | --- |
| `simulation` | `{ "mec": false, "ue": "sandbox-scenario", "cse": false }` |
| `transport` | `onem2m`: 실제 Mobius4 주소 종류, `mec`: `https-k8s-ingress-ca` |
| `mecSandbox` | 호스트, 샌드박스 이름, MEP, 시나리오 이름, 목록 `catalogHash`, CA 파일 SHA-256 |
| `cseVersion` | Mobius4 버전과 source revision |
| `hostCount` | PC 1대와 VM 1대 |
| `flows` | Location, RNIS 각각 요청 cin RI, MEC 구독 ID, 첫 관측 cin RI, 앱 알림 여부, 정책 판단 |
| `renewals`, `teardown` | PUT 횟수, 해지 방식별 공급자 응답 코드 |
| `trace` | IPE 출력 JSON 줄 파일 경로와 SHA-256 |
