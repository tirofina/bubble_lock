# 지도 설정과 no-key 로컬 검증

2026-11-12. Brief 항목 10 완료. 실제 지도 공급자 호출은 0건이다.

## 변경

- `web-dashboard/shared/map-presentation.ts`: 사용자 지정 타일 → Stadia 키 → 현재 호스트와 일치하는 등록 도메인 → OpenStreetMap 순서로 기본 지도를 선택한다. 일반 지도는 항상 OpenStreetMap이다.
- `web-dashboard/src/LocationMap.tsx`: `VITE_STADIA_MAPS_DOMAIN`과 실제 `window.location.hostname`을 전달한다. 첫 선택 버튼은 설정에 맞게 `기본 지도`로 표시한다.
- `web-dashboard/.env.example`: 빈 기본값, 공개 브라우저 키, 등록 호스트명, 로컬 XYZ 타일 예시를 제공한다.
- `web-dashboard/docs/map-design.md`: 우선순위, 도메인 등록, 빌드 시점, no-key·타일 실패 동작과 외부 호출 없는 QA 절차를 설명한다.
- `web-dashboard/test/map-presentation.test.ts`: 키·도메인·사용자 지정 URL 선택과 기존 geofence 계약을 검증한다.

## 실행 결과

| 확인 | 실행·관찰 | 결과 |
|---|---|---|
| Red | `cd web-dashboard && node --test test/map-presentation.test.ts` | 기존 구현에서 4 통과, 3 실패, exit 1. `red.log` |
| Green | 같은 명령, 구현 후 실행 | 7 통과, 0 실패, exit 0. `green.log` |
| TypeScript | `cd web-dashboard && npm run typecheck` | exit 0. `typecheck.log` |
| no-key 화면 | 네 지도 환경변수 모두 빈 값, 별도 빈 `envDir`, 실제 `#/user/map` | OpenStreetMap 선택, 핀 3개, BLE 원 3개 |
| 선택 | 키링 B 선택 | 상세 제목과 선택 핀 모두 키링 B |
| BLE | 숨기기 → 보기 | 원 3 → 0 → 3 |
| 확대 | 실제 확대 버튼 | 축척 30 m → 20 m |
| 타일 실패 | 외부 타일 요청을 브라우저에서 abort | 안내 표시, 핀 3개·BLE 원 3개·선택 상태 유지 |
| 복구 | 일반 지도 사용 → 일반 지도 실패 → 다시 불러오기 | 로컬 타일 다시 표시, 안내 해제 |
| 외부 요청 | 페이지 탐색 전에 모든 외부 요청 interception | 96건 중 로컬 응답 86건, 강제 실패 10건, 외부로 계속 진행한 요청 0건, API 키 쿼리 0건 |

요청별 URL·차단 결과와 동작별 실제 값은 `browser-verification.json`에 있다. 로그의 키 문자열은 단위 테스트용 문자열이며 실제 공급자 키가 아니다.

## 화면

| 상태 | 데스크톱 | 모바일 |
|---|---|---|
| 변경 전 | `before-desktop.png` | `before-mobile.png` |
| 변경 후 no-key | `after-desktop.png` | `after-mobile.png` |
| 타일 실패 | — | `tile-failure-mobile.png` |
| 재시도 복구 | — | `recovered-mobile.png` |

데스크톱 viewport는 1440×900, 모바일은 390×844·DPR 3·터치 에뮬레이션이다. 전체 페이지 캡처이므로 이미지 높이는 viewport보다 크다. 데스크톱 PNG 너비 1425는 세로 스크롤바를 제외한 문서 너비이고, 모바일 PNG 너비는 1170이다. 두 화면에서 지도·범례·선택 상세가 보이며 문서 가로 넘침은 없다. 기존 배치·스타일을 유지했고 CSS를 변경하지 않았다.

## QA 실행 경계

작업 전용 Vite 서버를 `127.0.0.1:5276`에서 실행했다. 프로젝트 `.env`를 로드하지 않도록 `envDir`를 빈 작업 전용 임시 디렉터리로 지정하고, `cacheDir`·`RUN_TMP`·`TMPDIR`·`XDG_CACHE_HOME`도 그 디렉터리에 두었다. 실행 환경의 다음 값은 모두 빈 문자열이었다.

```dotenv
VITE_STADIA_MAPS_KEY=
VITE_STADIA_MAPS_DOMAIN=
VITE_MAP_TILE_URL=
VITE_MAP_ATTRIBUTION=
```

omowright로 작업 전용 Chromium headless shell에 연결했다. 브라우저 실행 인자의 `--host-resolver-rules='MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'`로 외부 DNS도 차단했다. `createRoutes(page)`의 전체 URL route를 설치한 뒤 실제 앱을 열었다. 외부 URL에서는 `continue()`를 호출하지 않고, `LOCAL QA TILE` 문자가 들어간 SVG를 `fulfill()`하거나 `abort()`했다. 공급자 출처 링크를 클릭하지 않았다.

위치·인증·포털 API는 브라우저 route에서 로컬 모의 JSON으로 응답했다. 위치 fixture는 기존 `web-dashboard/fixtures/location-demo.json`의 서울광장 키링 A/B/C·수신기 관측과 같은 값을 사용했다. 실제 `LocationMap`·Leaflet·React·위치 파서는 그대로 실행했다. 이 검증은 실제 지도 인증, 외부 지리 타일 내용, OIDC 또는 서버 통합 성공의 증거가 아니다.

첫 타일 실패 시도에서는 브라우저 캐시가 요청을 처리해 오류 이벤트가 발생하지 않았다. 작업 전용 브라우저의 네트워크 캐시를 끈 뒤 새 타일 요청으로 실패와 복구를 확인했다. 탐색이 viewport를 데스크톱 기본값으로 되돌리는 도구 동작도 관찰하여, 모바일 캡처 직전에 에뮬레이션을 다시 적용하고 실제 크기를 기록했다.

전체 13단계 검증과 최종 커밋은 root가 담당한다. 실제 공급자 키와 등록 도메인은 소유자가 선택하며, 이번 작업은 해당 값 없이 로컬 동작을 입증했다.

검증 후 작업 전용 omowright 연결과 route를 닫고, Vite 서버·Chromium 프로세스를 종료했다. 이번에 생성한 `/tmp/bubblelock-map-E95Ctm`의 프로필·캐시·서버 스크립트만 삭제했다.
