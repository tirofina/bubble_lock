# 키링 지도와 BLE 위치 연동

지도는 Stadia Maps 또는 OpenStreetMap 배경 위에 키링의 GPS·MEC 위치 핀, 측위 정확도 원, 등록 수신기 중심의 BLE 거리 추정 원을 표시합니다. 키링별 최신 위치와 최신 BLE 관측은 각각의 원본 시각으로 관리합니다.

운영 화면과 사용자 화면은 `GET /api/portal/locations`를 4초 간격으로 조회합니다. 응답의 `readExpiresAt`은 최대 5초이며 브라우저는 해당 시각에 좌표를 비웁니다. LIVE의 `GET /api/locations`도 같은 권한 조회 경로로 연결됩니다. 명령 SSE의 sequence, 위치 파일 cursor, Gateway firmware sequence와 중앙 handover sequence는 각각 관리합니다.

## 중앙 API와 현재 권한

1. Pi Gateway가 인증된 `POST /api/v1/gateways/{gatewayId}/telemetry`로 관측을 전송합니다. 중앙은 등록 인증서·Gateway 상태·기기와 가구 연결·bootId·sequence·관측 시각을 확인합니다.
2. MEC Location callback은 서비스 discovery/subscription에서 발급한 token·source·grant revision과 연계하여 수신합니다. 중앙 위치 조회는 현재 유효한 grant와 등록된 UE/device 연결을 확인합니다.
3. BFF는 OIDC 서버 세션의 access token으로 HTTPS 중앙 API에 연결합니다. `/v1/portal/location-access`에서 초기 범위를 얻고 `/v1/portal/locations`에서 최종 `deviceIds`와 `observations`를 함께 받습니다.
4. 중앙 위치 응답의 `deviceIds`는 관측을 읽는 같은 저장소 트랜잭션에서 재평가합니다. BFF는 초기 범위와 최종 범위의 교집합으로 JSONL·중앙 관측·BLE 수신기 좌표를 함께 선택합니다. 조회 중 grant 회수도 이 단계에 반영합니다.

`portal:read`, 현재 가구 연결, 보호자가 승인한 `location:read` grant와 수신자별 위치 lease가 지도 조회의 공통 기준입니다. 보호자·방문자·운영자 각각의 수신자, 목적, OPEN 사건, 기기 범위, grant·consent revision, lease 만료를 매 조회에서 평가합니다. `dashboard:read`는 운영 진단 화면 접근에 쓰입니다. 운영자 역할 이름과 `variant="operator"`는 위치 접근 권한을 발급하는 수단과 구분합니다. 승인·회수 API와 릴레이 UE 결합 조건은 [정밀 위치 계약](../../pc-mobius/integration/LOCATION_PRIVACY.md)에 정리했습니다.

응답은 `Cache-Control: no-store`를 사용합니다. 중앙 오류, 기기 범위 계약 오류 또는 세션·grant 변경을 받으면 보호된 지도는 현재 좌표를 비우고 연결 상태를 표시합니다. GPS와 BLE는 각자의 `observedAt`으로 병합하므로 새 BLE 수신 시각과 GPS 측정 시각이 각각 유지됩니다. LIVE JSONL의 GPS·BLE는 원본 관측 시각에서 24시간 안의 값을 선택합니다.

## 실행 모드

| 설정 | 위치 데이터 | 화면 출처 |
|---|---|---|
| 기본 실행 | `fixtures/location-demo.json`의 고정 관측 | 모의 지도 |
| `LOCATION_FILE` 지정 | 해당 JSONL에 추가된 관측 | 파일 연동 · 기본 모의 |
| `LOCATION_FILE` + `LOCATION_SIMULATION=false` | 운영자가 연결한 실측 기록 | 관측 원본 기준 |
| `PORTAL_CONFIG_FILE` + OIDC 세션 | 중앙 Gateway·MEC 관측 | `portal-api` |
| OIDC 세션 + `LOCATION_FILE` | 권한 범위의 JSONL·중앙 관측 병합 | `combined` |

원본에 `simulation:true`가 있으면 해당 위치·BLE 관측은 항상 모의로 표시합니다. 수신기 좌표의 `simulation`도 BLE 원의 출처에 함께 반영합니다. `updatedAt`은 snapshot 조회 시각이며 위치·BLE의 `observedAt`은 원본 측정 시각입니다.

저장소 루트의 PowerShell에서 실제 수집 파일을 연결합니다.

```powershell
$env:LOCATION_FILE = (Resolve-Path '.local/live/locations.jsonl').Path
$env:GATEWAY_LOCATIONS_FILE = (Resolve-Path '.local/live/gateways.json').Path
$env:LOCATION_SIMULATION = 'false'
npm run events
```

`locations.jsonl`은 수집기가 한 줄에 하나의 JSON과 줄바꿈을 기록하는 파일입니다. `LOCATION_FILE`에는 아래 형식의 원시 관측, CORE telemetry journal, MEC journal을 함께 넣을 수 있습니다. GPS 좌표는 해당 키링의 측위 센서나 위치 서비스에서 수집합니다. BLE 관측은 그 신호를 받은 Gateway 식별자와 연결합니다.

좌표와 관측 파일은 `.local/`에 보관합니다. 서버는 `127.0.0.1`에 바인딩합니다. LIVE 실행은 [OIDC 세션 설정](oidc-session.md)의 `PORTAL_CONFIG_FILE`과 중앙 HTTPS API를 연결합니다. 체험 사용자 지도는 모의 관측과 모의 수신기를 사용하며, LIVE 시작 시 중앙 관측을 기다리는 빈 snapshot을 제공합니다.

## 입력 예시

GPS와 BLE를 함께 가진 Gateway 원시 관측의 위치 관련 필드입니다. 실제 Gateway envelope의 나머지 필드는 그대로 유지합니다.

```json
{"deviceId":"keyring-A","gatewayId":"pi-01","observedAt":"2026-11-10T08:00:00.000Z","rssi":-67,"sensorValues":{"location":{"lat":37.5665,"lon":126.978,"source":"gps","accuracyM":8}}}
```

기존 CORE telemetry receipt의 `payload`도 지원합니다.

```json
{"gatewayId":"pi-01","payload":{"deviceId":"keyring-B","timestamp":"2026-11-10T08:00:01.000Z","rssiDbm":-74}}
```

기존 MEC Location journal은 `ueId`를 키링 식별자로 사용합니다.

```json
{"service":"Location","eventType":"UE_LOCATION_UPDATE","ueId":"keyring-A","timestamp":"2026-11-10T08:00:02.000Z","location":{"lat":37.5666,"lon":126.9781,"accuracyM":5}}
```

Gateway 좌표 파일은 아래 배열 형식입니다. `referenceRssiDbm`에는 해당 키링·수신기 조합으로 1 m에서 측정한 RSSI를, `pathLossExponent`에는 설치 환경의 교정 지수를 설정합니다. 아래 숫자는 설정 형식을 설명하는 예시입니다.

```json
[
  {
    "gatewayId":"pi-01",
    "label":"입구 수신기",
    "position":{"lat":37.5665,"lon":126.978},
    "simulation":false,
    "referenceRssiDbm":-59,
    "pathLossExponent":2
  }
]
```

## 원과 핀의 의미

- GPS·MEC 핀: 수집한 위도·경도 위치, 측위 원: 원본 `accuracyM`.
- BLE 원: 등록한 수신기 위치를 중심으로 `d = 10^((RSSI@1m - RSSI) / (10 × n))`을 적용한 추정 거리.
- BLE만 수신한 키링: 수신기 중심 근접 범위로 표시하며, 키링의 방위는 위치 서비스가 제공하는 좌표로 결정합니다.
- 원본 관측 시각 기준 60초가 지나면 갱신 대기 상태를 표시합니다. 기본 데모는 고정된 시뮬레이션 시각을 유지합니다.
- BLE 지도 반경은 최대 1,000 m이며 계산 거리와 상한 적용 여부는 별도 값으로 보존합니다.
- MEC 릴레이 UE 좌표와 키링 BLE 결합은 승인된 association의 거리·시차·현재 grant를 확인합니다. 결과는 릴레이 주변 관측 범위이며 uncertainty는 UE 정확도와 BLE 추정 범위의 합입니다.

## 파일 처리와 운영 점검

한 요청은 최대 4 MiB를 읽고 다음 요청에서 이어서 처리합니다. 키링 snapshot은 최신 관측 기준 1,000개, 한 줄은 64 KiB, 수신기 설정은 256 KiB 범위로 관리합니다. 줄바꿈 직전의 작성 중 데이터는 다음 조회에서 이어 읽고, 파일 교체나 축소 시 새 snapshot으로 전환합니다.

`rejectedRecords`는 JSON 구문·길이 제한 또는 위치/BLE 입력 조건에 따라 제외된 줄 수입니다. 통합 journal의 정책·명령처럼 위치 관측을 포함하지 않는 줄도 이 수에 포함됩니다. `caughtUp`은 현재 파일 끝까지 읽었는지 나타냅니다.

파일 경로·접근권한 또는 수신기 좌표 설정의 점검이 필요한 경우 API가 명시적인 오류를 반환합니다. 운영자는 수집기 상태와 `.local/` 파일을 확인한 뒤 다음 5초 조회에서 회복 상태를 볼 수 있습니다.

검증은 `test/location.test.ts`, `test/location-feed.test.ts`, `test/portal-http.test.ts`에서 좌표·RSSI 정규화, 출처 보존, 독립 최신 시각, 파일 추가·교체·부분 쓰기·동시 조회를 다룹니다. LIVE HTTP 시험은 중앙 BLE와 등록 수신기의 반경 계산, JSONL/중앙 GPS·BLE 독립 시간 병합, 조회 중 grant 회수, 중앙 오류 시 응답 경계, 운영·사용자 API의 동일 권한 범위를 확인합니다.

실제 Mobius4 두 CSE의 wire 실행 증거는 [`handover-real-cse.json`](../../pc-mobius/receipts/handover-real-cse.json)과 [`interop-real-cse.json`](../../pc-mobius/receipts/interop-real-cse.json)에 있습니다. 첫 기록은 서로 다른 AE-ID, ACP·자원·구독·group 복원과 rollback을, 두 번째는 공급자 2개 × 독립 클라이언트 2개의 `fu=1&ty=28&cnd=...` 검색·상태 제어 및 실제 `/fopt` 결과를 담습니다. `/fopt`의 개별 회원 응답은 `2004`와 권한 경계의 `4103`으로 확인했습니다. 서버는 실제 Mobius4/PostgreSQL 실행이며 입력 관측의 모의 표시는 각 receipt에 보존됩니다. 현장 키링·Gateway 관측은 중앙 telemetry 수신 기록으로 별도 추적합니다.

## 지도 공급자

지도는 [Leaflet 1.9.4](https://leafletjs.com/reference-1.9.4.html)의 미터 단위 circle을 사용합니다. 배경과 인증 설정은 [지도 화면과 공급자 설정](map-design.md)에 정리했습니다. 출처 표시는 지도 하단에 유지하며 타일은 브라우저 기본 캐시로 처리합니다. 배경 타일 요청은 화면 영역의 지리 범위를 포함하며 키링 식별자·RSSI·관측 기록은 프로젝트 위치 API가 처리합니다.
