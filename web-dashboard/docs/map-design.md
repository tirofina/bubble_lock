# 지도 화면과 공급자 설정

운영자 `#/operator/map`과 사용자 `#/user/map` 화면은 `LocationMap`을 공유합니다. `variant="operator"`는 원본 좌표·관측 정보와 거리 계산을 제공하고, `variant="user"`는 최근 위치·신호·수신 범위를 우선 표시합니다. 두 LIVE 화면은 `locationUrl="/api/portal/locations"`로 연결합니다. 출처 배지는 GPS·MEC·BLE 관측의 실측·모의 값을 유지합니다.

화면의 **기본 지도 / 일반 지도** 선택으로 설정한 공급자와 OpenStreetMap 배경을 전환합니다. 기본 지도는 사용자 지정 타일, Stadia Maps 키, 등록 도메인 순으로 설정을 적용합니다. 아무 설정이 없으면 키가 필요 없는 OpenStreetMap을 사용합니다. 지도 공급자의 출처는 지도 하단에 항상 표시합니다. 배경 연결 점검이 필요한 경우 일반 지도 전환 버튼을 제공합니다.

## 환경 설정

| 변수 | 역할 |
|---|---|
| `VITE_STADIA_MAPS_KEY` | Stadia Maps 브라우저용 키. 앞뒤 공백 제거 후 URL 인코딩하며 도메인 설정보다 우선 |
| `VITE_STADIA_MAPS_DOMAIN` | Stadia Maps에 등록한 사이트 호스트명 하나. 예: `maps.example.test`. 프로토콜·포트·경로·와일드카드 제외 |
| `VITE_MAP_TILE_URL` | 기본 배경의 사용자 지정 XYZ 타일 URL |
| `VITE_MAP_ATTRIBUTION` | 사용자 지정 지도 공급자의 출처 표시 |

`web-dashboard/.env.example`을 `.env.local`로 복사하고 필요한 값만 채웁니다. Vite 환경변수는 개발 서버 시작 또는 웹 빌드 시 반영됩니다. 값을 바꾸면 개발 서버를 재시작하고, 배포 파일은 다시 빌드합니다. `VITE_` 값은 브라우저에 공개되므로 서버 비밀키를 넣지 않습니다.

키 없이 도메인 인증을 쓰려면 공급자 관리 화면에 사이트 호스트를 먼저 등록하고 동일한 호스트를 `VITE_STADIA_MAPS_DOMAIN`에 넣습니다. 앱은 이 값의 앞뒤 공백과 대소문자를 정리한 뒤 `window.location.hostname`과 정확히 비교합니다. 하위 도메인까지 자동으로 허용하지 않습니다. 일치하면 API 키 쿼리 없이 Stadia Alidade Smooth를 선택하고, 불일치하거나 미설정이면 OpenStreetMap을 선택합니다. 이 설정은 공급자 등록을 대신하지 않으며 Referer를 위조하지 않습니다. 도메인 인증에는 브라우저가 보내는 사이트 Referer가 필요합니다.

로컬 노트북에서 모든 값을 비워도 지도 선택·확대·키링 핀·BLE 원·관측 상세가 동작합니다. OpenStreetMap 배경은 네트워크가 필요합니다. 배경 요청이 실패해도 위치 layer를 유지하고 연결 안내와 다시 불러오기 동작을 제공합니다. 사용자 지정 타일 URL은 상대 경로도 받으며, Stadia 키를 붙이지 않습니다. **일반 지도** 버튼은 사용자 지정 설정과 무관하게 OpenStreetMap을 선택합니다.

외부 지도 요청에는 화면의 지리 범위가 포함되며, 키링 식별자·RSSI·위치 관측은 프로젝트 API가 처리합니다.

## 외부 공급자 호출 없는 QA

QA에서는 실제 공급자에 접속하지 않습니다. 작업 전용 브라우저에서 페이지를 열기 전에 모든 외부 요청을 가로채 로컬 타일 fixture로 응답하거나 실패시킵니다. `VITE_MAP_TILE_URL=/offline-tiles/{z}/{x}/{y}.png`와 로컬 타일 서버를 쓸 수도 있습니다. 이 경우에도 **일반 지도** 전환 시 생기는 외부 요청은 차단합니다.

키·도메인·사용자 지정 타일 값을 모두 비운 실행으로 기본 선택, 핀 선택, BLE 원 전환, 확대, 타일 실패 후 위치 유지 및 재시도를 확인합니다. 공급자 키·도메인·사용자 지정 URL의 우선순위는 `node --test test/map-presentation.test.ts`로 확인합니다. 데스크톱·모바일 변경 전후 화면과 네트워크 차단 기록은 저장소 `docs/final-evidence/map/`에 보존합니다. 이 증거는 로컬 UI 동작을 검증하며 실제 공급자 인증 성공을 주장하지 않습니다.

공식 자료:

- [Alidade Smooth 스타일과 타일 URL](https://docs.stadiamaps.com/map-styles/alidade-smooth/)
- [Stadia Maps 로컬 개발·도메인·키 인증](https://docs.stadiamaps.com/authentication/)
- [OpenStreetMap 타일 운영 정책](https://operations.osmfoundation.org/policies/tiles/)

## 위치 의미와 안전 구역

GPS·MEC 위치 핀은 해당 키링의 관측 좌표를 가리킵니다. BLE-only 관측은 등록 수신기 중심의 둥근 표식으로 구분합니다. 점선 원은 RSSI 교정값으로 계산한 수신기 중심 추정 범위이며, 위치 정확도는 옅은 실선 원으로 표시합니다. 키링 목록과 지도 핀을 선택하면 같은 장치의 정보가 표시됩니다.

`geofences` prop은 등록된 정책의 안전 구역을 받아 지도에 표시합니다. `MapGeofence` 형식은 아래와 같으며 `circle`과 `bbox`는 기존 MEC 계약과 동일한 필드를 사용합니다. 좌표 범위·반경·사각 경계 순서를 검사한 유효 구역만 렌더링합니다.

```ts
{
  id: policyId,
  label: policyName,
  simulation: sourceSimulation,
  shape: { type: 'circle', lat, lon, radiusM }
}
```

두 화면의 위치 접근 범위는 OIDC 세션, `portal:read`, 현재 household/device 연결과 위치 공유 grant·수신자별 lease로 결정합니다. 운영자도 현재 가구 범위를 사용합니다. `variant`는 화면 구성과 용어를 선택하는 prop입니다. 보호된 조회의 세션·권한·중앙 연결 오류는 지도 layer와 선택 핀을 비우며, 다음 4초 조회에서 상태를 갱신합니다. `readExpiresAt` 타이머는 조회 사이의 승인 만료에도 좌표를 비웁니다.

GPS·MEC의 관측 시각과 BLE 수신 시각은 독립적으로 표시합니다. 60초가 지난 좌표는 갱신 대기 상태와 원본 시각으로 표시하고, BLE 원은 등록 수신기의 좌표·교정 RSSI·환경 지수를 사용합니다. 모의 anchor나 모의 BLE 중 하나가 포함되면 해당 원의 출처를 모의로 유지합니다.

중앙 telemetry→현재 grant 조회→BFF 병합 경로와 실제 두 CSE의 discovery·상태·group fan-out 증거는 [위치 연동 문서](location-feed.md)에 정리했습니다.
