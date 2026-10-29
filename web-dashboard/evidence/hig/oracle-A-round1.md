st_01a185c4 [completed] model GPT-6 Astra (reasoning high, variant medium)
## 최종 판정: REVISE
**신뢰도: HIGH** — 확인된 결함 기준. 미촬영 상호작용의 실제 동작까지 승인하는 판정은 아닙니다.

경로 기준: `web-dashboard/`. 캡처 위치: `evidence/hig/`.

### 차단점

- **[evidence][defect] 폰 상태 증거 불일치:** `after-390-{light,dark}-{loading,error,offline}.png` 6개는 실제 **1440×900 데스크톱 화면**입니다. manifest도 이를 기록합니다. 390×844 CSS/DPR3 상태 검증을 대체할 수 없습니다.
- **[product][defect] 선택 시 행 이동:** `src/Resources.tsx:42`, `src/styles.css:142`에서 선택된 트리에만 “선택됨” 행을 추가합니다. 선택 변경 시 앞선 행이 축소되어 아래 버튼 위치가 바뀝니다. 구조 확인: `after-390-light-resources.png`.
- **[product][defect] 로딩 전환의 레이아웃 이동:** `src/Resources.tsx:80,157,165`, `src/App.tsx:92,110`에서 결과를 지우고 짧은 로딩 문구로 교체합니다. `after-1440-dark-loading.png`와 `after-1440-dark-resources.png`에서 공간 차이를 확인했습니다.
- **[product][defect] 상태 피드백 누락:** `src/styles.css:69–70,107,143`. 선택된 트리 스타일이 hover/active 배경을 덮고, 연결 패널 summary의 hover 배경은 부모와 같습니다.
- **[product][defect] 검색 제안 부재:** `src/App.tsx:82–123`, `after-390-light-audit.png`. H10의 최근 검색 또는 제안이 없습니다.

### G–J 체크리스트

- **G1 FAIL** — 애니메이션은 없지만 일부 hover가 시각적으로 무효입니다. `src/styles.css:69,107,143`.
- **G2 FAIL** — 트리 선택 표시가 행 높이와 버튼 위치를 바꿉니다. `src/Resources.tsx:42`.
- **G3 N/A** — 중단·재타기팅할 애니메이션이 없습니다. `src/styles.css` 전체.
- **G4 N/A** — 위치·scale·depth·blur 애니메이션이 없습니다. `src/styles.css` 전체.
- **G5 PASS** — 주 버튼은 `:active`와 즉시 실행 핸들러를 사용합니다. `src/styles.css:74`, `src/App.tsx:168–170`; 프레임 시간은 미측정.
- **G6 FAIL** — 로딩과 결과의 공간이 유지되지 않습니다. `after-1440-dark-loading.png`, `src/Resources.tsx:157–165`.
- **G7 PASS** — 깜박임·반복 진동·읽기를 막는 motion 구현이 없습니다. 검토한 CSS와 컴포넌트 소스.
- **H1 PASS** — loading/empty/error와 문서 공통 offline 분기가 있습니다. `src/App.tsx:110–113,199–200`, `src/Resources.tsx:157–160`, `src/useEventStream.ts:41–44`; 폰 상태 외관은 미검증.
- **H2 PASS** — 즉시 구체적인 조회 문구를 표시하며 spinner는 없습니다. `after-1440-light-loading.png`, `src/Resources.tsx:157,182`.
- **H3 PASS** — 오류는 관련 영역에, 성공은 결과 변화로 표시합니다. `after-1440-light-error.png`, `src/Resources.tsx:159,183`.
- **H4 N/A** — modal alert는 없고 인라인 `role="alert"`만 있습니다. `src/App.tsx:111,181`.
- **H5 FAIL** — 선택된 트리와 연결 summary의 hover/press 피드백이 불완전합니다. `src/styles.css:69–76,107,143`.
- **H6 N/A** — sheet/modal이 없습니다. `src/App.tsx`, `src/Resources.tsx`.
- **H7 PASS** — 새 검색·소스 변경·새 조회가 이전 요청을 abort하며 요청 제한은 12초입니다. `src/App.tsx:98`, `src/Resources.tsx:105,119`, `src/client.ts:24`.
- **H8 N/A** — 권한·consent 요청 기능이 없습니다. `src/Resources.tsx:149–150`.
- **H9 N/A** — 로그인·비밀번호·온보딩 화면이 없습니다. 검토한 컴포넌트 소스.
- **H10 FAIL** — 검색 위치와 범위는 있지만 최근 검색/제안이 없습니다. `after-390-light-audit.png`, `src/App.tsx:82–123`.
- **H11 PASS** — 운영자 설정의 레이블이 명시적이며 시스템 설정을 중복하지 않습니다. `after-1440-dark-settings.png`, `src/Resources.tsx:51–60`.
- **I1 PASS** — 공통 focus-visible, skip link, DOM 순서를 확인했습니다. `after-390-dark-keyboard.png`, `src/styles.css:76,89–90`; 전체 키보드 순회 실측은 아님.
- **I2 PASS** — native form submit을 사용하고 단축키를 가로채지 않습니다. `src/App.tsx:103`, `src/Resources.tsx:136`; 앱 modal/menu 없음, 소스 기반 판정.
- **I3 PASS** — 입력 label과 nav/main/이름 있는 section이 존재합니다. `src/App.tsx:104,160,165,191`, `src/ui.tsx:11`.
- **I4 N/A** — gesture 전용 조작이 없습니다. 트리는 native button입니다. `src/Resources.tsx:40`.
- **I5 N/A** — 재생 미디어가 없고 영상은 제출 대기 텍스트입니다. `src/App.tsx:224`.
- **J1 N/A** — macOS 네이티브 창이 아닌 웹 문서입니다. `src/App.tsx:155–232`.
- **J2 PASS** — 앱 popover 없이 좁은 화면에 재배치되고 URL/numeric/text 입력 모드를 구분합니다. `after-390-dark-settings.png`, `src/Resources.tsx:144`.

### 증거 한계와 보존 확인

기존 검토에서 **after 76개·before 58개·합성 58개, 총 192개 PNG**를 열었습니다. 잘못된 폰 보조 캡처는 통과 근거로 인정하지 않았습니다.

닫힌 `details`의 초기화 버튼은 열기 전 키보드 대상이 아닙니다. 명령 미수신 시 native select의 `disabled` 분기는 확인했지만(`src/App.tsx:192`), **disabled 외관 캡처는 확인되지 않았습니다**. 브라우저 재실행·전체 키보드 순회·프레임 시간 측정은 하지 않았습니다. 테스트 21/21과 build 성공은 전달받은 결과입니다. `evidence/hig-visual-qa.md`는 읽기 시 `ENOENT`였습니다.

실제 DOM, 재사용 토큰·컴포넌트, 필수 콘텐츠, KST 밀리초와 원본 시각, OFF/false, 모의 표시는 보존되어 있습니다. **위 결함과 증거 공백 해소 전에는 PASS할 수 없습니다.**
