# Privacy Bubble Keyring: R04 Article 뼈대

상태: **초안 뼈대**. Rubric R04 (HW·자원·프로토콜·효과·재현). 주 담당 WEB-DASHBOARD, 협업 PC-MOBIUS-INTEGRATION. DOC-REV 2.0.0.

이 문서는 Article의 구조와 지금 있는 근거만 담습니다. `[대기]` 표시는 실물, 영상, 토론, 측정 증거가 아직 없다는 뜻이며, 채우기 전에는 공개하지 않습니다.

## 1. 문제와 개요

키링의 근접 관측을 보호자 승인과 oneM2M ACP 아래에서 다루고, Group 명령의 결과를 구성원별 ACK·readback 영수증으로 남기는 시스템입니다. 기본 경로는 `키링 BLE → Raspberry Pi Gateway → MQTT/HTTPS → PC Mobius4 → 앱·웹 대시보드`입니다 ([기준 문서 2절](../../PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md)).

## 2. 하드웨어

- 키링 PCB, BOM, firmware revision: `[대기]` KEYRING 산출물
- Raspberry Pi Gateway 구성: `[대기]` KEYRING 산출물
- 실물 사진: `[대기]`

## 3. oneM2M 자원

- AE `privacy-bubble-test-ae`, flexContainer `bubbleState`, SDT `org.onem2m.common.moduleclass.binarySwitch`, `pb:binarySwitch/state:boolean`
- Group/fan-out과 구성원별 ACK·readback: CORE `group-dispatcher.mjs`
- discovery `fu=1&ty=28&cnd=...binarySwitch`: 근거 [primary-sources.md](primary-sources.md)
- 대시보드 자원 트리 예시: [../fixtures/resources.json](../fixtures/resources.json) (모의)
- 실제 Mobius 자원 트리 캡처: `[대기]`

## 4. 프로토콜

| 구간 | 프로토콜 | 근거 |
|---|---|---|
| 키링 ↔ Pi | BLE GATT | `[대기]` KEYRING |
| Pi ↔ Mobius | MQTT / HTTPS | `pc-mobius/contracts/raspberrypi-gateway.v1.json` |
| PC API ↔ 대시보드 | SSE (`Last-Event-ID` 재개) | [../contracts/dashboard-event.schema.json](../contracts/dashboard-event.schema.json), [../evidence/http-sse.json](../evidence/http-sse.json) |
| 대시보드 ↔ Mobius | oneM2M HTTP discovery | [primary-sources.md](primary-sources.md), 실서버 미시험 |

패킷 캡처: `[대기]`

## 5. 효과

- 명령 하나의 수락·전송·적용·확인 시각을 구성원별로 보여 줍니다. 필드 규칙은 [receipt-mapping.md](receipt-mapping.md).
- oneM2M 도입 효과(코드·설정·지연 비교, R07): `[대기]` 측정 없음
- 실측 지연 수치: `[대기]` 지금 화면의 시각은 fixture 영수증 값이며 측정이 아닙니다.

## 6. 재현

```sh
cd web-dashboard
npm ci && npm test && npm run build
npm run sse    # 터미널 1
npm run dev    # 터미널 2, http://127.0.0.1:5173
```

실제 영수증 재생은 [../README.md](../README.md)의 `RECEIPT_FILE` 절을 봅니다. 구현 SHA는 [release-manifest.json](release-manifest.json)의 `releaseSha`에 고정했습니다. 프로젝트 전체 release 승인은 별도입니다.

## 7. 한계

모든 화면 데이터는 모의입니다. 인증, 실제 Mobius·장치·MEC·FL·MCP 연동, CORS는 확인하지 않았습니다. 목록은 [../README.md](../README.md#시뮬레이션-범위와-미확인-항목).

## 8. 증거 목록

| 증거 | 상태 |
|---|---|
| 시험 결과 | [release-manifest.json](release-manifest.json) |
| 브라우저 스크린샷 (390px, 1440px) | [동작 기록](../evidence/browser-qa.json), [데스크톱](../evidence/desktop-light.png), [모바일](../evidence/mobile-light.png), [모바일 하단](../evidence/mobile-end.png) · 모의 대시보드 PASS |
| 5분 미만 영상 (실물·모의·실측 구분, R05) | `[대기]` |
| 공개 기술 토론 URL (R08) | `[대기]` |
| 실물 시연 기록 | `[대기]` |
