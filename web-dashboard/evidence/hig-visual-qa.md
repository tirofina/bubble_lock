# Visual QA — Verdict: GOOD

ROLE: WEB-DASHBOARD. DOC-REV 2.0.0. Captured 2026-10-29.

## Surface and brief

One read-only Korean dashboard at /, with command timeline, resources/device
state, audit, integration shells and evidence index. Primary action: 다시 연결 / 새로고침.
Reading priorities: receipt facts, device facts, audit/evidence. Preserve all
mock labels, four timestamp stages, pending stages, false readback, metadata,
settings, evidence links and unsubmitted video/discussion labels. No write,
approval, authentication or real-integration behavior was added.

Layout: persistent sidebar + stack; document is the main scroll owner; compact
navigation wraps and resource panels stack. Compact stages adapt to text size.
Raw JSON alone may own horizontal overflow. See ../DESIGN.md and
../docs/hig-sources.md for design tokens and Apple primary-source decisions.

## Evidence inventory

[hig/capture-manifest.json](hig/capture-manifest.json) records 87 current after
PNGs,58 before/after pair PNGs, dimensions, SHA-256 and per-pair pixel-diff
results/hotspots. Before is clean2529e0a; after is the presentation source
hashed in [hig/round2-proof.json](hig/round2-proof.json). Pair images always place
before on the left and after on the right at identical dimensions/scale.
This is a correction, not a pixel-identical reference clone. Intentional
differences include larger text, control boundaries, KST and restored mobile
evidence descriptions; diff similarity is diagnostic, not the verdict.

One route ×390/1440/1920 CSS px ×light/dark. Phone is true iphone-14
emulation390×844, DPR3, mobile/touch; desktop DPR1, height1080. For each
combination: top, commands, resources, audit, services, evidence and end.
Additional390/1440 pairs: partial command, metadata open, live settings, empty
audit. Supplemental after-only regression evidence: loading, error, offline,
keyboard, hover, press, refresh, 200% text, disabled select, audit/detail errors
and native search suggestions. Those supplemental states have no
reconstructed before artifact and are not presented as before/after proof.

## Exact scenarios and observables

Browser tool: omowright from browser/scripts/omowright.mjs, owned Chrome
CDP9337. connect('http://127.0.0.1:9337'), createAgentTabs(browser).create(
'http://127.0.0.1:5173'). Supplementary navigation uses page.goto(url,{waitUntil:'load'}),
then app readiness and emulate(page,'iphone-14') or explicit1440/1920 metrics.
Navigation reset metrics in this runtime, so emulation is applied AFTER goto
and innerWidth AND actual PNG width are asserted immediately before every
screenshot. Locator waits can also reset metrics; status scenes re-pin before
scrolling to their capture target.

| Scenario | Literal action / input | Binary observable | Evidence |
| --- | --- | --- | --- |
| Matrix | Emulation.setEmulatedMedia prefers-color-scheme=light/dark; scrollTo(0,0), document.getElementById(region).scrollIntoView(), scrollTo(0,document.documentElement.scrollHeight); page.screenshot() | Correct viewport dimensions; document width no greater than viewport; readable region | after-{390,1440,1920}-{light,dark}-{top,commands,resources,audit,services,evidence,end}.png |
| Partial/pending | page.locator('#commands select').selectOption('grp-partial') | 부분 확인 plus pending stages remain | *-partial.png |
| Disclosure | page.locator('#commands summary').click() | Expanded metadata/events, visible minus cue | *-metadata.png |
| Settings | page.locator('#resources select').selectOption('live') | Nine labeled settings, honest unconfirmed integration notice | *-settings.png |
| Empty | page.locator('input[type=search]').fill('NO-HIG-MATCH'); page.locator('#audit button').click() | 일치하는 기록이 없습니다 and recovery instruction | *-empty.png |
| Loading | Fetch.enable({patterns:[{urlPattern:'*/api/*',requestStage:'Request'}]}); navigate; wait for '#resources [role=status]'; screenshot; Fetch.disable | Immediate labeled loading state before controlled request release | *-loading.png |
| Failure | live mode; fill first resource input http://127.0.0.1:9338 and second hig-visual-qa; click '#resources button[type=submit]' | '#resources [role=alert]' says Failed to fetch plus Korean recovery instruction; no fixture fallback | *-error.png |
| Offline | Network.emulateNetworkConditions({offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1}) | navigator.onLine=false and visible offline wording; old facts retained | *-offline.png |
| Keyboard | page.keyboard.press('Tab') repeated through all 24 eligible controls | Every target has a 3px focus-visible ring in reading order | after-390-dark-keyboard.png; round2-proof.json |
| Press | primary.hover(); primary.focus(); keyboard.down('Space'); screenshot; keyboard.up('Space') | Visible hover/press feedback and refresh restores data | *-hover.png,*-pressed.png,*-refreshed.png |
| Enlarged text | document.documentElement.style.fontSize='200%'; commands/stages.scrollIntoView() | No document overflow; number01 intact; stages become one324px column | *-text200*.png |
| Reduced motion | Emulation.setEmulatedMedia prefers-reduced-motion=reduce | Media matches; no animation or input-gating motion exists | metrics.json; loading/error/offline captures |
| KST boundary | renderToStaticMarkup(createElement(Timestamp,{at:'2026-10-29T23:59:59.987Z'})) |2026-10-30 08:59:59.987 KST; original datetime unchanged | metrics.json timeCases |
| Disabled | Fetch.enable with */events* Request pause; navigate; wait for resource tree | Native command select disabled=true | *-disabled.png; round2-proof.json |
| Audit failure | Network.setBlockedURLs({urls:['*api/audit*']}); submit hig-error; restore urls=[] | Korean explanation + diagnostic + retry action | *-audit-error.png |
| Detail failure | Owned HTTP fixture at 127.0.0.1:33191: discovery returns /Mobius/hig-device, detail GET returns 404 | Korean detail explanation + reselect/refresh action | after-390-dark-detail-error.png |
| Suggestions | Fill audit input grp; ArrowDown; Escape dismisses | Native datalist references three real fixture queries | after-390-dark-suggestions.png; round2-proof.json |
| Target stability | Record all tree button y/height, select Keyring B, compare exact rectangles at 390/1440 | Arrays identical | round2-proof.json |
| Loading stability | Pause API requests, measure resource/audit heights, release, measure after results | Heights identical across 390/1440 light/dark | round2-proof.json |

Computed sRGB contrast and actual element rectangles are in
[hig/round2-proof.json](hig/round2-proof.json). Minimum text contrast: light5.471:1,
dark7.429:1; ordinary control edges4.033:1 /5.335:1. No measured text
contrast failures or 44px target failures among 24 visible controls. Mobile
body17px/secondary15px; desktop16px/14px. Status uses text labels; selected
resource has both aria-pressed and visible 선택됨. System appearance is used
without an app-specific theme override. Original timestamp instants are retained.

## Findings fixed before independent review

| Initial finding | Correction | Observable evidence |
| --- | --- | --- |
|12px captions and16px phone body | Caption14px desktop,15px compact; body17px compact | Top/timeline/audit pairs |
| Low-contrast input boundary | Separate semantic control-border token; decorative separators remain quiet | Metrics and settings pairs |
| Disclosure looked like plain text | Plus/minus disclosure cue and pressed state | Metadata pair and source |
| Resource selection depended on wash/border | Visible 선택됨 label | Resources pair |
| Mobile evidence descriptions hidden | Reflow full table rows into readable stacked records, retaining descriptions | Evidence pair |
| Caption collapsed vertically during mobile row correction | Explicit block caption; actual image inspection caught and verified repair | Final evidence captures |
|200% number01 split and stages cramped | Nonshrinking number, adaptive9rem cells | Enlarged-text/stage captures |
| UTC/ISO time on Korean operation screen | Explicit KST/UTC+09:00 display, original offset retained in time datetime/title | Timeline/audit/metadata captures and rollover check |

## Independent review

Round 1/3: A and B both REVISE. Reports are
[A](hig/oracle-A-round1.md) and [B](hig/oracle-B-round1.md).
A's first run produced no final output; one no-more-tools continuation recovered
its verdict. Review durations: A 12m22s including recovery; B 11m37s.

Both reviewers caught six invalid phone status captures (1440x900). Those were
replaced by true 1170x2532 phone PNGs, now asserted in capture(). Both product
reports were integrated before one repair wave:

- Native selected value has an unclipped, wrapping companion description.
- Search scope wraps outside the short placeholder; native fixture suggestions
  are offered without changing the search API.
- Korean negative/conditional phrases stay together; prose is capped at 75ch.
- Errors have Korean explanations, retained diagnostics and nearby recovery.
- Every tree row reserves its selection-label line; selection no longer moves
  other hit targets. Selected hover/press and connection-summary hover differ.
- Static loading placeholders reserve flexible result footprints. Exact
  initial loading/result section heights match; arbitrarily large live data can
  still expand naturally. There are no fixed content heights or animations.

B7 is explicitly adapted to this authorized long-document screen: priority
reading order and leading navigation, not all three datasets above a phone
fold. The literal generic "first viewport contains priorities 1–3" condition
is not claimed. Adding a new summary feature, hiding data or shrinking text
would contradict this visual-only correction; see DESIGN.md.

Round 2 final independent visual review: **PASS**, HIGH confidence, 53 PASS,
0 FAIL, 16 N/A across all 69 items. The reviewer inspected all 87 current
screenshots through all 22 contact sheets, plus 23 originals and four changed
before/after pairs, and confirmed all seven current source hashes.
Duration: 5m44s. [Full final verdict](hig/oracle-final-round2.md).
No blocking product/evidence defects or new taste requirements remain.
No ulw-plan file exists, so no additional general reviewer gate applies.

## Tests, scope and cleanup

Final npm test21/21, no skips; npm run build (tsc/Vite) exit0. Exact invocation
and current source hashes: [hig/round2-proof.json](hig/round2-proof.json).
Final frozen-source session bash_13: 21 pass, 0 fail, 0 skipped; tsc/Vite
exit 0, build 1.28s. Earlier [verification](hig/verification.md) is historical,
not the current source manifest. Contracts, tests,
server, shared reducer and pc-mobius have no diff. No PR or Discord message.
LSP unavailable (biome/typescript-language-server absent); TypeScript compiler
ran in build. This is desktop/mobile browser emulation, not physical-device or
VoiceOver certification. Real Mobius/auth/AE/ACP/CORS/SDT/RVI remain outside
this visual correction and unconfirmed.

Owned browser connection closed; Chrome bash_5, dev bash_1 and replay bash_3
were stopped. Read-back `ss -ltnp` for ports 9337/5173/4174/33191 returned
only its header; no process references the owned run root. The detail-error
fixture on port 33191 was stopped and subsequent connection refusal verified.
The final reviewer is terminal. Owned temporary contact sheets, browser
profiles and runtime caches were removed with `/tmp/tmp.2Az82XFb1p`;
read-back stat returned ENOENT. All owned completion watches were closed.

## Completion gate

Satisfied in round 2 of the three-round product-surface budget, on the current
source hashes and complete fresh capture set. No further visual round or
product repair was required. B7 passes only the explicitly documented
long-document adaptation; physical-device and screen-reader certification
remain outside this browser-emulation review.

## Final per-item checklist

P = hig/round2-proof.json; S = current source trace. Screenshot shorthand
390/1440/1920-L/D-name means hig/after-{width}-{light,dark}-{name}.png.
Historical scroll probes are explicitly labeled; they are corroborated by
current source/captures and are not presented as a new round2 measurement.
Native suggestion options, uncaptured native interaction states and semantic
labels have source/recorded-evidence qualifications in the table below.

### A. Layout and alignment

| Item | Verdict | Named evidence |
|---|---|---|
| A1 | PASS | `1920-L/D-top`: centered maximum-width document and aligned sidebar/content grid. |
| A2 | PASS | `390-L/D-top`, `1920-L/D-end`: backgrounds reach display edges without stray margins. |
| A3 | PASS | `1440-L/D-settings`, `pair-1440-light-settings.png`; `src/styles.css:81` caps prose at 75ch with symmetric layout padding. |
| A4 | PASS | `390-L/D-end`; safe-area rules in `src/styles.css:173,178` **[S; emulation, not physical-device proof]**. |
| A5 | PASS | `390-L/D-commands`; P metrics report document width 390, with no reserved phone gutter. |
| A6 | PASS | Historical six-width/theme scroll probes identify `document`; current CSS retains document scrolling and unbounded JSON content **[S + historical measurement]**. |
| A7 | PASS | `1440-L/D-resources`, `390-L/D-settings`: common edges and tokenized spacing. |
| A8 | PASS | `1440-L/D-commands`, `390-L/D-settings`: member, stage and field groups remain distinct. |
| A9 | PASS | Complete capture matrix; `390-dark-text200` and P zoom show no document overflow and a complete selected-value companion. |
| A10 | PASS | `390-L/D-services`, `390-L/D-metadata`: partial following content and disclosure cues communicate continuation. |
| A11 | N/A | Browser document, not a native macOS window; `src/App.tsx` **[S]**. |
| A12 | PASS | `DESIGN.md` Layout contract, current top/resource captures, historical document-only scroll probes and current CSS agree **[current source-traced corroboration, not a fresh probe]**. |

### B. Hierarchy

| Item | Verdict | Named evidence |
|---|---|---|
| B1 | PASS | `390/1440/1920-L/D-top`: only “다시 연결 / 새로고침” receives the primary filled style. |
| B2 | N/A | No destructive device/account operation; replay reset reconstructs local display state. `src/App.tsx` **[S]**. |
| B3 | PASS | `390-L/D-top`: plain functional title “명령과 상태 확인”. |
| B4 | PASS | `src/App.tsx` section order and complete capture matrix preserve receipts → resources → audit/evidence. |
| B5 | PASS | `1440-L/D-partial`: neutral navigation, functional accent and semantic status colors. |
| B6 | PASS | `390-L/D-commands`, `1440-L/D-settings`; CSS uses consistent size/weight hierarchy and body/monospace families. |
| B7 | PASS | **Authorized adaptation only:** `DESIGN.md`, QA report and top captures establish priority navigation and document order. **Three full datasets above the phone fold do not pass the literal generic condition and are not claimed to.** |

### C. Text and copy

| Item | Verdict | Named evidence |
|---|---|---|
| C1 | PASS | P metrics: phone body/secondary 17/15px; desktop 16/14px. Current audit/settings captures remain legible. |
| C2 | PASS | `390-dark-audit-error`, `390-dark-detail-error`: Korean explanation precedes retained diagnostics; timeline/audit use required precise KST timestamps. Technical identifiers remain data, not substitute prose. |
| C3 | PASS | `1440-L/D-settings`, `390-L/D-audit`, top captures: explicit refresh, search and discovery actions. |
| C4 | PASS | `390-dark-text200`, `390-dark-text200-stages`: full companion selection text and single-column stages. Native select text remains constrained, but required information is available immediately below it. |
| C5 | PASS | `390-L/D-metadata`: “대체하지 않음” stays together; full-size error/settings captures show readable Korean wrapping. |
| C6 | PASS | `390-L/D-empty`, `390-L/D-error`, `390-dark-audit-error`, `390-dark-detail-error`: local explanation and actionable recovery. |
| C7 | PASS | `1440-L/D-settings`, `390-L/D-audit`; `Resources.tsx` labels all nine settings and `App.tsx` labels search **[visual + S]**. |
| C8 | PASS | IDs, paths, timestamps and diagnostics are DOM text; no selection-blocking CSS. `App.tsx`, `Resources.tsx`, `ui.tsx` **[S]**. |

### D. Touch and pointer targets

| Item | Verdict | Named evidence |
|---|---|---|
| D1 | PASS | P reports zero 44px target failures among 24 measured controls; current phone navigation/settings show separated padded targets. |
| D2 | N/A | Phone navigation is document anchor navigation, not a tab bar. `390-L/D-top`. |
| D3 | PASS | `1440/1920-L/D-top`: title and trailing primary action; compact layout wraps without competing action groups. |
| D4 | N/A | No segmented toolbar button group; anchor links have individual complete hit areas. `src/App.tsx` **[S]**. |

### E. Contrast, colour and themes

| Item | Verdict | Named evidence |
|---|---|---|
| E1 | PASS | All 22 contact sheets cover current light/dark surfaces without compositing defects or mismatched assets. |
| E2 | PASS | P measured minimum text contrast 5.471/7.429 and control edges 4.033/5.335; `390-L/D-disabled` remains readable. |
| E3 | PASS | `390-L/D-metadata`, resource captures and keyboard capture: OFF/false, pending, selection text and geometric focus rings supplement color. |
| E4 | PASS | `1440-L/D-partial`, audit captures and shared `Badge` source preserve consistent status meanings. |
| E5 | N/A | No translucent overlay surface. `src/styles.css` **[S]**. |
| E6 | PASS | System `prefers-color-scheme` rules and paired theme captures; no conflicting app theme override **[S + visual]**. |

### F. Consistency and brand

| Item | Verdict | Named evidence |
|---|---|---|
| F1 | N/A | No independent icon library; native controls and disclosure characters only. `App.tsx`, `styles.css` **[S]**. |
| F2 | PASS | Shared spacing/radius tokens; settings, stage and resource captures show consistent borders and grouping. |
| F3 | PASS | `ui.tsx` shared Section/Badge/Stages are consistently rendered throughout the complete single-route capture set. |
| F4 | PASS | Current top captures and round 1 baseline review retain Privacy Bubble branding without a branding-only screen. |
| F5 | PASS | `390-dark-tree-hover/pressed`, resource captures and P: selection wash/border plus explicit “선택됨”; visible focus ring, no accent side stripe. |
| F6 | PASS | `390-dark-suggestions`, metadata captures: native clear/selection affordances, disclosure ± and explicit text search action. |
| F7 | N/A | No application-created window, sheet or popover. `App.tsx`, `Resources.tsx` **[S]**. |

### G. Motion and feedback

| Item | Verdict | Named evidence |
|---|---|---|
| G1 | PASS | `390-dark-tree-hover`, `390-dark-summary-hover`; P feedback colors differ from rest. No animation loops **[visual + S]**. |
| G2 | PASS | P tree-target arrays match exactly before/after selection at 390/1440; reserved selection line in `styles.css:151`. |
| G3 | N/A | No animation requiring interruption or retargeting. `styles.css` **[S]**. |
| G4 | N/A | No positional, scale, depth or blur animation to replace. `styles.css` **[S]**. |
| G5 | PASS | `390-dark-pressed/refreshed`, tree-pressed capture and synchronous CSS `:active` feedback **[same-frame mechanism source-traced; latency not measured]**. |
| G6 | PASS | P loading/result resource and audit heights match at 390/1440 in both themes; flexible minimum footprints preserve the tested transition without fixed-height panes. |
| G7 | PASS | No flashing, oscillation or reading-blocking motion in current source; static loading captures corroborate **[S + visual]**. |

### H. States

| Item | Verdict | Named evidence |
|---|---|---|
| H1 | PASS | Current loading/empty/error/offline captures and source branches provide relevant states; offline retains prior receipts. |
| H2 | PASS | `390/1440-L/D-loading`: immediate specific status and static placeholders; no stopped spinner or animation requirement. |
| H3 | PASS | Audit/detail/resource error captures place failure beside the affected content; refreshed results show success in place. |
| H4 | N/A | Inline `role="alert"` messages, not modal alert dialogs. `App.tsx`, `Resources.tsx` **[S]**. |
| H5 | PASS | Current hover/pressed/keyboard/disabled captures plus P feedback and native-disabled records; uncaptured native-control states are source/platform-traced. |
| H6 | N/A | No sheet or modal. `App.tsx`, `Resources.tsx` **[S]**. |
| H7 | PASS | AbortController cleanup supersedes pending reads; client requests have a 12-second limit. `App.tsx`, `Resources.tsx`, `client.ts` **[S]**. |
| H8 | N/A | No permission or consent prompt; settings explicitly disclaim authorization. `1440-L/D-settings`. |
| H9 | N/A | No sign-in, password or onboarding surface. Current component source **[S]**. |
| H10 | PASS | `390-L/D-audit` shows one labeled search with complete scope; P and `App.tsx` establish three real fixture suggestions **[options source/JSON-traced, not visually expanded]**. |
| H11 | PASS | `1440-L/D-settings`, `390-L/D-settings`: nine explicit operational fields, no duplicated system settings. |

### I. Keyboard and accessibility

| Item | Verdict | Named evidence |
|---|---|---|
| I1 | PASS | P records all 24 eligible default-view Tab targets with 3px rings in reading order; conditional controls inherit `:focus-visible` **[conditional states S]**. |
| I2 | PASS | Native forms and controls preserve Enter/Escape behavior; no shortcut interception. `App.tsx`, `Resources.tsx`; QA suggestion scenario **[S + recorded scenario]**. |
| I3 | PASS | Native labels, named navigation/sections, main landmark and skip link. `App.tsx`, `Resources.tsx`, `ui.tsx` **[semantic source trace; no new accessibility-tree run]**. |
| I4 | N/A | No gesture-only operation. Tree/actions use native controls **[S]**. |
| I5 | N/A | No autoplay media; video remains explicitly pending. Evidence/end captures. |

### J. Platform specifics

| Item | Verdict | Named evidence |
|---|---|---|
| J1 | N/A | Web document, not a native macOS application. `src/App.tsx` **[S]**. |
| J2 | PASS | Phone settings reflow; URL/numeric/text input modes are explicit in `Resources.tsx`; no custom compact popover or collapsing large-title component **[visual + S]**. |
