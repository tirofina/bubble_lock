st_01a185c3 [completed] model GPT-6 Astra (reasoning high, variant medium)
## 판정: REVISE — 신뢰도 HIGH

BubbleLock HIG 수정의 Pass B 검토를 완료했습니다. **44항목: PASS 30 / FAIL 7 / N/A 7.** 제품 수정사항과 모바일 캡처 오류가 남아 있습니다. 검토 작업은 5/5 완료했으며, 남은 검토 작업은 없습니다.

경로 기준: `/home/gunp4ng/working/bubble_lock/web-dashboard/`. 아래 PNG는 모두 `evidence/hig/`에 있습니다.

### 발견사항과 차단요인

1. **[evidence] [defect] 높음 — 모바일 보충 캡처 6개가 데스크톱 화면입니다.**
   `after-390-{light,dark}-{loading,error,offline}.png`는 실제 **1440×900**입니다. 직접 연 이미지에도 데스크톱 사이드바가 나타납니다. 매니페스트 역시 해당 크기를 기록합니다. 로딩·오프라인 양 테마와 라이트 오류는 대응하는 1440 파일과 SHA-256도 같습니다.
   **조치:** 이 6개만 390×844 CSS / DPR 3에서 다시 촬영하고, 촬영 직전 viewport를 확인하십시오. 현재 자료로 모바일 해당 상태를 승인할 수 없습니다.

2. **[product] [defect] 중간 — 확대된 선택값과 검색 안내가 잘립니다.**
   `after-390-dark-text200.png`의 명령 선택값은 `grp-demo · 확인 완…` 지점에서 잘려 전체 상태가 보이지 않습니다. 정상 배율의 `after-390-dark-audit.png`, `after-1440-light-audit.png`에서도 검색 placeholder 끝의 `action, URI`가 완전히 보이지 않습니다.
   위치: `src/App.tsx:105`, `src/App.tsx:192–194`, `src/styles.css:131–132`.
   **조치:** 검색 범위를 줄바꿈 가능한 보조 문구로 제공하고, 확대 시 선택한 명령·상태를 잘리지 않는 텍스트로 함께 제공하십시오.

3. **[product] [defect] 중간 — 한국어 부정 표현이 분리됩니다.**
   `after-390-{light,dark}-metadata.png`의 현재 revision 설명이 **“sequence로 대체하지 / 않음”**으로 줄바꿈되어 `않음`만 다음 줄에 남습니다.
   위치: `src/App.tsx:67`, `src/styles.css:128–130`.
   **조치:** `대체하지 않음`을 함께 유지하거나, 해당 설명의 모바일 행 배치를 조정하십시오.

4. **[product] [defect] 중간 — 원시 오류 문자열과 복구 안내 누락이 남습니다.**
   `after-1440-{light,dark}-error.png`는 사용자 설명 대신 `Failed to fetch`를 그대로 표시합니다. 자원 오류에는 한국어 재시도 안내가 붙지만, 감사 오류와 자원 상세 오류는 문자열만 출력합니다. 후자는 캡처가 아닌 코드 추적으로 확인했습니다.
   위치: `src/client.ts:10–11`, `src/App.tsx:110–111`, `src/Resources.tsx:159,183`.
   **조치:** 한국어 실패 설명과 해당 위치의 다음 행동을 제공하고, 원문은 진단 정보로 보존하십시오.

5. **[product] [defect] 낮음 — 데스크톱 설명문의 행 길이가 기준을 초과합니다.**
   `after-1440-light-settings.png`의 설정 안내는 **공백 포함 107자**가 한 줄에 놓입니다. A3의 45–75자 기준을 충족하지 않습니다.
   위치: `src/Resources.tsx:149–150`, `src/styles.css:79`.
   **조치:** 설명문만 읽기 적절한 폭으로 제한하십시오. 데이터 표 전체를 좁힐 필요는 없습니다.

6. **[product] [defect] 중간 — B7의 첫 viewport 조건은 충족하지 않습니다.**
   `after-390-{light,dark}-top.png`는 탐색·연결 안내 다음에 명령 선택의 일부까지만 보여 실제 receipt 단계가 첫 화면에 없습니다. 데스크톱도 자원·감사/증거는 첫 viewport 밖입니다. 문서 전체의 우선순위 순서는 올바릅니다.
   위치: `src/App.tsx:158–205`.
   **조치:** 첫 화면에서 우선순위를 요약해 보여주거나, 의도된 긴 문서형 화면에 대해 B7의 “첫 viewport” 조건을 명시적으로 조정해야 합니다. 세부 내용을 삭제하거나 글자를 축소하는 해결은 적절하지 않습니다.

**승인 차단:** 위 제품 결함 및 잘못된 모바일 캡처입니다. 별도 취향 개선은 승인 조건으로 추가하지 않았습니다.

### 전체 열람 및 근거

- 후속 PNG **76/76**, 비교쌍 **58/58**을 직접 열었습니다. 이전 화면 **58개는 비교쌍 왼쪽에서 전수 확인**했습니다.
- 비교쌍 구성:
  - 390/1440/1920 × light/dark × `top, commands, resources, audit, services, evidence, end`: 42쌍.
  - 390/1440 × light/dark × `partial, metadata, settings, empty`: 16쌍.
- 보충 후속 화면: 로딩·오류·오프라인 12개, 키보드·hover·press·refresh 4개, 200% 글자 2개.
- 검증 기록의 소스 6개 해시는 현재 파일과 모두 일치합니다. 후속 캡처 중 최신 해당 소스보다 오래된 파일은 없었습니다.
- `verification.md`의 테스트 21/21 및 빌드 성공 기록을 읽었습니다. 이번 읽기 전용 검토에서 테스트·빌드는 재실행하지 않았습니다.

### A–F 체크리스트

표의 FAIL은 위 발견사항 번호를 참조합니다. 코드 추적 근거와 실제 캡처 근거를 구분했습니다.

| 항목 | 판정 | 근거 |
|---|---|---|
| A1 | PASS | `after-1920-light-top.png`: 중앙 제한 폭과 사이드바 그리드에 정렬. |
| A2 | PASS | `after-390-light-top.png`, `after-1920-dark-end.png`: 배경이 화면 가장자리까지 이어짐. |
| A3 | FAIL | `after-1440-light-settings.png`: 107자 설명 한 줄. 발견 5. |
| A4 | PASS | `src/styles.css:160,165`: 상단·좌우·하단 safe-area 적용; `after-390-dark-end.png` 하단 여백. 실기기 검증은 아님. |
| A5 | PASS | `after-390-light-commands.png`, `metrics.json`: overlay scrollbar, viewport/documentWidth 모두 390. |
| A6 | PASS | `metrics.json` 6개 scroll probe 모두 `document`; `src/styles.css:93,145`의 sticky rail과 JSON 예외도 계약에 부합. |
| A7 | PASS | `after-1440-dark-resources.png`; `src/styles.css:17–23,100–108`: 공통 정렬선과 간격 토큰. |
| A8 | PASS | `after-390-dark-settings.png`, `after-1440-light-commands.png`: 필드·구성원·단계의 그룹 구분 명확. |
| A9 | FAIL | 문서 가로 넘침은 없지만 `after-390-dark-text200.png` 선택값 잘림. 발견 2. |
| A10 | PASS | `after-390-dark-services.png` 하단 다음 패널 일부와 `after-390-dark-metadata.png` disclosure 표시. |
| A11 | N/A | 네이티브 macOS 창이 아닌 웹 문서. 반응형 sidebar는 A12에서 확인. |
| A12 | PASS | `DESIGN.md:68–74`, 6개 scroll probe, `after-1440-dark-top.png`/`after-390-dark-top.png`: sidebar+stack 및 문서 스크롤 일치. |
| B1 | PASS | `after-1440-light-top.png`: 유일한 강조 배경 액션은 다시 연결/새로고침. |
| B2 | N/A | 장치 삭제·승인 등 파괴적 작업 없음; 재동기화는 화면 상태 재구성. `src/App.tsx:185`. |
| B3 | PASS | `after-390-light-top.png`: “명령과 상태 확인”이라는 기능 제목. |
| B4 | PASS | `src/App.tsx:189–225`: 명령 → 자원 → 감사 → 연동 → 증거 순서 유지. |
| B5 | PASS | `after-1440-dark-partial.png`: 강조색은 조작·실제 상태에 사용되고 탐색은 중립적. |
| B6 | PASS | `after-390-dark-commands.png`, `src/styles.css:24–42`: 크기·굵기 계층과 본문/고정폭 두 계열. |
| B7 | FAIL | `after-390-dark-top.png`, `after-1440-light-top.png`: 우선순위 1–3의 실제 내용이 첫 viewport에 나타나지 않음. 발견 6. |
| C1 | PASS | `metrics.json`: 모바일 17/15px, 데스크톱 16/14px; `src/styles.css:30–32`에 얇은 굵기 없음. |
| C2 | FAIL | `after-1440-light-error.png`: 원시 `Failed to fetch`. KST 밀리초 표시는 명시적 제품 요구대로 적절함. 발견 4. |
| C3 | PASS | `after-1440-light-settings.png`, `after-390-light-empty.png`: 조회·검색·새로고침의 결과 중심 액션. |
| C4 | FAIL | `after-390-dark-text200.png` 선택값, `after-390-dark-audit.png` placeholder 잘림. 발견 2. |
| C5 | FAIL | `after-390-light-metadata.png`: “대체하지 / 않음” 분리. 발견 3. |
| C6 | FAIL | 빈 감사·자원 조회 오류 안내는 적절하지만 `src/App.tsx:111`, `src/Resources.tsx:183` 오류 분기에 다음 행동 없음. 발견 4. |
| C7 | PASS | `after-390-light-settings.png`, `src/Resources.tsx:141–147`, `src/App.tsx:104–106`: 실제 label 제공. |
| C8 | PASS | `src/App.tsx:65–74,118,221`, `src/Resources.tsx:169`: 식별자·경로·오류가 실제 DOM 텍스트이며 선택 방지 스타일 없음. 코드 근거. |
| D1 | PASS | `metrics.json`: 측정된 25개 제어의 44px 실패 없음; `src/styles.css:65,96–97,142,155`에 대상 크기·간격 적용. |
| D2 | N/A | 모바일 탐색은 탭바가 아닌 문서 anchor 링크. `src/App.tsx:160–162`. |
| D3 | PASS | `after-1440-dark-top.png`: 제목과 단일 우측 primary의 두 그룹; compact에서는 줄바꿈. |
| D4 | N/A | 분할된 glyph toolbar 버튼군 없음. 탐색 링크는 각각 패딩을 가진 전체 hit area. |
| E1 | PASS | 세 폭의 light/dark 대응 캡처 전체에서 정상 렌더링; 밝은 이미지 자산이나 검은 합성 누락 없음. |
| E2 | PASS | `metrics.json`: 측정 텍스트 최소 5.471/7.429, 제어 경계 4.033/5.335; placeholder·기본 상태 토큰은 `src/styles.css:67,71`. |
| E3 | PASS | `after-1440-dark-partial.png`, `after-390-dark-resources.png`: 상태 문구·ON/OFF·선택됨 제공; focus는 외곽선 형태. |
| E4 | PASS | `src/styles.css:112–115`, `src/App.tsx:31,46,117`: 성공·주의·실패·정보 의미 일관. |
| E5 | N/A | 반투명 overlay 없음. `src/styles.css`의 패널·배경은 불투명 색상. |
| E6 | PASS | `src/styles.css:2,44–60`: 시스템 색상 모드를 따름; 별도 앱 테마 override 없음. |
| F1 | N/A | 별도 아이콘 세트 없음. native control과 disclosure 문자만 사용, emoji 없음. |
| F2 | PASS | `src/styles.css:17–38,118–120`: 간격·반경 토큰 공유; 캡처에서 중첩 테두리 충돌 없음. |
| F3 | PASS | `src/ui.tsx`, `src/App.tsx`, `src/Resources.tsx`: 단일 `/`의 공유 Section/Badge/Stages 사용처를 전체 캡처와 코드로 확인. |
| F4 | PASS | `pair-390-light-top.png`, `pair-1920-dark-top.png`: Privacy Bubble 워드마크 보존, 별도 브랜드 전용 화면 없음. |
| F5 | PASS | `after-390-dark-resources.png`: wash와 명시적 “선택됨”; `src/styles.css:76,143` focus ring과 선택 상태 제공. |
| F6 | PASS | `after-390-light-empty.png`, `after-390-dark-metadata.png`: native 지우기/선택 화살표와 disclosure ±, 명확한 텍스트 검색 액션. |
| F7 | N/A | 앱이 만든 sheet·popover·중첩 alert 창 없음. `src/App.tsx`, `src/Resources.tsx`. |

### 비교 이미지와 diff 추적

58쌍 모두 `dimensionsMatch=true`, `alphaChannelIntact=true`입니다. **3,043개 hotspot**의 좌표는 이미지 경계 안에 있으며, diff 비율은 **3.31–43.67%**, similarity는 **56–97**입니다. 이는 복제 정확도 점수가 아니라 변경 위치 확인에 사용했습니다.

| 비교 case | 쌍 / hotspot | 픽셀 변화의 주된 원인 |
|---|---:|---|
| top | 6 / 312 | 모바일 글자 확대와 탐색 줄 증가, 연결 패널·명령 시작 위치 이동. |
| commands | 6 / 298 | UTC 원문 대신 KST 날짜/시각 분리, 단계 높이와 글자 크기 변경. |
| partial | 4 / 222 | 같은 시각 표현 변경; 미수신 단계·부분 확인 상태는 유지. |
| metadata | 4 / 246 | 날짜 분리·글자 확대·disclosure 표시로 상세 영역 높이 변경. 모바일 부정 표현 결함은 발견 3. |
| resources | 6 / 295 | 선택됨 문구와 제어 경계 추가, 트리 높이와 다음 영역 위치 변경. |
| audit | 6 / 306 | KST 두 줄 표시와 확대된 행·상태 문구 때문에 목록 높이 증가. |
| services | 6 / 276 | 보조 글자 확대에 따른 패널 높이·줄바꿈 변화. 모의 표시는 유지. |
| settings | 4 / 214 | 입력 경계 강화와 label·placeholder 크기 변경. |
| empty | 4 / 222 | 검색 제어 크기와 빈 상태 문구 배치 변화. 복구 안내 보존. |
| evidence | 6 / 322 | 모바일 설명 열 복원과 행별 세로 재배치. |
| end | 6 / 330 | 복원된 증거 설명·대기 사유·footer의 크기 및 높이 변경. |

예를 들어 `390-light-top`의 hotspot `(1,3)`은 탐색 확장에 따른 본문 이동, `1440-dark-metadata`의 `(2,6)`은 상세 내용 재배치, `390-light-resources`의 `(2,4)`는 선택된 트리 항목 변화에 해당합니다. 이러한 의도된 차이를 baseline 불일치 결함으로 처리하지 않았습니다.

### 유지해야 할 장점

- 모바일 증거 설명과 영상·공개 토론의 **대기 사유가 복원**되었습니다.
- KST 밀리초 표시, 원본 `dateTime`, 미수신 시각, ACK/readback 구분과 `OFF · false`가 보존됩니다.
- 시스템 다크 모드, 대비, 문서 단일 스크롤과 200% 단계 단일열 재배치는 적절합니다.
- 모의·미연결·읽기 전용 표기가 일관되며, 장식용 차트나 추가 작업 제어가 없습니다.

이번 결과는 **round 1/3의 REVISE**입니다. 파일·git 변경, 설치, 추가 reviewer 실행은 하지 않았습니다.
