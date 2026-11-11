# 지도 화면과 공급자 설정

운영자 `#/operator/map`과 사용자 `#/user/map` 화면은 `LocationMap`을 공유합니다. `variant="operator"`는 원본 좌표·관측 정보와 거리 계산을 제공하고, `variant="user"`는 최근 위치·신호·수신 범위를 우선 표시합니다. 두 LIVE 화면은 `locationUrl="/api/portal/locations"`로 연결합니다. 출처 배지는 GPS·MEC·BLE 관측의 실측·모의 값을 유지합니다.

기본 배경은 밝은 회색 도로·건물과 부드러운 녹지 색상을 가진 **Stadia Maps Alidade Smooth**입니다. 화면의 **밝은 지도 / 일반 지도** 선택으로 OpenStreetMap 배경과 전환합니다. 지도 공급자의 출처는 지도 하단에 항상 표시합니다. 배경 연결 점검이 필요한 경우 일반 지도 전환 버튼을 제공합니다.

## 환경 설정

| 변수 | 역할 |
|---|---|
| `VITE_STADIA_MAPS_KEY` | 운영자가 관리하는 Stadia Maps 배포용 키 |
| `VITE_MAP_TILE_URL` | 기본 배경의 사용자 지정 XYZ 타일 URL |
| `VITE_MAP_ATTRIBUTION` | 사용자 지정 지도 공급자의 출처 표시 |

Stadia Maps는 로컬 개발 서버의 `localhost`와 `127.0.0.1` 요청을 지원합니다. 공개 사이트는 등록 도메인 인증 또는 API 키를 연결합니다. 사용자 지정 배경은 기존 환경변수 형식을 유지합니다. 외부 지도 요청에는 화면의 지리 범위가 포함되며, 키링 식별자·RSSI·위치 관측은 프로젝트 API가 처리합니다.

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
