---
name: Privacy Bubble story demo, Apple HIG brief
role: WEB-DASHBOARD
doc-rev: 2.0.0
scope: "#/story/* (StoryDemo, VirtualKeyring, StoryMobiusPanel, StoryMobiusTree, story.css)"
status: canonical design brief for the story demo
inputs: DESIGN.md (token values), docs/hig-sources.md (HIG pages and their web adaptation)
---

# apple.md

This file is the canonical design brief for the Privacy Bubble story demo. Every final
design decision on `#/story/*` cites a section here (P1 to P11, S1 to S6). `DESIGN.md`
keeps the token values and the rest of the web app; this file decides how the story demo
uses them. Change the brief first, then the code.

Roles. Design (Claude): this file, `src/story.css`, visual QA. Function (Codex): state
machine, API wiring, component markup per section 10, capture script and tests. Both
sides treat section 10 as the shared contract.

## 1. Principles

| ID | Principle | What it means on screen | Source |
| --- | --- | --- | --- |
| P1 | Progressive disclosure | The first screen shows the keyring alone. Mobius, the app and navigation appear only after the first real button press, in reading order: request, created record, readback. | HIG Layout |
| P2 | One hero per screen | Intro: the keyring. System: the record that was just written. The phone is the witness, the dock is the tool. Outside the phone screen, each stage has one 21px or larger headline at most. | HIG Layout, Typography |
| P3 | 44px targets | Every control, including the two invisible keyring hit areas, is at least 44 x 44 CSS px at every breakpoint. Hit areas never overlap. | HIG Buttons, WCAG 2.5.8 |
| P4 | System type | `--font` and `--mono` from `styles.css`. Sizes from the DESIGN.md scale only (34, 28, 21, 17, 15, 13). Paths and RSC codes use `--mono` with tabular numbers. | HIG Typography |
| P5 | Restrained color and depth | One blue family for actions and highlights. Keyring blue `#4b9fd6` and orange `#ef7a3d` appear only on and around the keyring. Status always carries a word. Depth comes from surface change and a 1px hairline; the product shadow belongs to the keyring alone. | HIG Color, DESIGN.md 6 |
| P6 | Motion follows real state | A success mark appears only after the server response is in. Staggering orders data that has already arrived; it never stands in for a pending request. | HIG Motion |
| P7 | Reduced motion | Under `prefers-reduced-motion: reduce`, travel becomes a 160ms crossfade, breathing halos become a steady ring, pulses become a steady tint. | HIG Accessibility, Motion |
| P8 | State change and spatial relation first | Layout reads left to right as the data moves: keyring (input) -> Mobius (record) -> phone (person). Transitions move the same object from one place to another; nothing appears from nowhere. | HIG Layout |
| P9 | Firmware truth | The LCD shows only READY, CONFIRM and PANIC with the firmware glyphs and colors. The hit areas sit on the real button positions measured from the product render. | Keyring firmware r26 |
| P10 | Inclusive defaults | Korean and English, light and dark from the system setting, full keyboard path, 3px `:focus-visible` ring, polite live regions for new records. | HIG Accessibility, Dark Mode |
| P11 | Plain surfaces | Flat canvas, hairline separators, no gradients, no frosted cards, one explanation line per screen. The floating keyring has no background, border or shadow box. | DESIGN.md 7 |

Sources: https://developer.apple.com/design/human-interface-guidelines/layout ,
https://developer.apple.com/design/human-interface-guidelines/typography ,
https://developer.apple.com/design/human-interface-guidelines/color ,
https://developer.apple.com/design/human-interface-guidelines/dark-mode ,
https://developer.apple.com/design/human-interface-guidelines/accessibility ,
https://developer.apple.com/design/human-interface-guidelines/buttons (retrieved 2026-10-29, see
`docs/hig-sources.md`), https://developer.apple.com/design/human-interface-guidelines/motion
(added for P6 and P7), https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html ,
https://www.w3.org/WAI/WCAG21/Understanding/orientation.html .

## 2. Tokens for the story demo

Color, type, radius and spacing come from `src/styles.css`. The story demo adds:

| Token | Value | Use |
| --- | --- | --- |
| `--keyring-confirm` | `#4b9fd6` | Confirm halo, confirm dot in hints |
| `--keyring-panic` | `#ef7a3d` | Emergency halo, emergency dot in hints |
| `--story-quick` | 160ms | Opacity and color changes, reduced-motion crossfade |
| `--story-base` | 280ms | Pane entrance (opacity plus 12px slide) |
| `--story-travel` | 640ms | Keyring travel from intro to dock |
| `--story-stagger` | 90ms | Gap between trace steps that are already resolved |
| `--story-breathe` | 2.4s | Guided-button halo cycle (ease-in-out) |
| `--story-fresh` | 2.4s | New-record tint: two soft pulses, then a steady selected tint |
| `--z-topbar` / `--z-dock` / `--z-modal` / `.skip` | 10 / 30 / 40 / 50 | Stacking order |

Keyring sizes (render is 271 x 359, aspect 0.755; height = width x 1.325):

Intro width = dock width x `--intro-scale`, laid out at that real size (S2 explains why).

| Place | Dock model width (`--dock-kw`) | Intro scale | Intro width |
| --- | --- | --- | --- |
| Desktop, 1280px and wider | 152px | 1.75 (1.45 below 760px tall) | 266px |
| Desktop, 1024 to 1279px | 136px | 1.9 | 258px |
| Below 1024px, landscape | 88px | 1.9 (2.6 from 521px tall) | 167px |
| Below 1024px, portrait | 104px | 2.2 | 229px |
| Phone portrait, 760px and narrower | 72px | 2.7 | 194px |

## 3. Spatial model

```
 desktop and tablet landscape
 +------------------------------------------------------------------------------+
 | BubbleLock        <  o o (2 Went out) o o o o  >       Family dashboard  KO EN |
 +------------------------------------------------------------------------------+
 |  gutter       |  Mobius system column                |   phone             |
 |               |  Just recorded                       |  +-------------+    |
 |               |  Safe check from the keyring         |  | Privacy     |    |
 |               |   o Request   POST /api/story/action |  | Bubble      |    |
 |               |   | Created   RSC 2001 /Mobius/../e-7|  |             |    |
 |   [keyring]   |   o Read back RSC 2000 hash matched  |  |             |    |
 |   rotate move |  Mobius tree  (fresh node tinted)    |  +-------------+    |
 +------------------------------------------------------------------------------+
```

The dock lives in its own gutter column, so it never overlaps Mobius content on desktop.
Input sits bottom-left, the record in the middle, the person on the right (P8).

## 4. S1 Intro stage (`data-stage="intro"`)

- Full canvas, no cards, no rail, no panels. Top bar shows only the brand and the language
  toggle; the scene stepper and dashboard link wait for the system stage (P1).
- The keyring sits at 50% width and 44% of the space under the top bar (optical center),
  with the Level 3 product shadow.
- One hint line under the keyring, 17px/600 ink, led by a 10px dot in the guided button's
  color: `파란 버튼을 눌러 보세요` / `Press the blue button` (check-in scene:
  `주황 버튼을 눌러 보세요` / `Press the orange button`). This is the only text on the
  intro besides the top bar (P2, P11).
- The guided button carries a 2px ring in its product color, centered on the visual
  button (not on the hit area), diameter = visual button + 10px, breathing between 35% and
  75% opacity and scale 0.94 to 1.06 every `--story-breathe` (P5, P7).
- Rotate, Move, Reset, counters and the keyring title are hidden; dragging the keyring
  still rotates it, and the focused stage still takes arrow keys (P10).
- Both buttons are live. Either press starts S2.

## 5. S2 Sending stage (`data-stage="sending"`)

Starts on the press, ends when the API has answered and the travel has finished
(at least `--story-travel`). Timeline from the press:

| Time | Element | Change |
| --- | --- | --- |
| 0ms | Hit area | Press scale 0.96 for 120ms; LCD latches CONFIRM or PANIC at once (P9) |
| 0 to 160ms | Intro hint | Fades out |
| 0 to 640ms | Keyring | Travels from the intro center to the dock and shrinks to the dock size, one continuous transform with `--ease` (P8) |
| 120 to 280ms | Top bar stepper and link | Fade in |
| 160 to 440ms | Mobius column | Opacity 0 to 1, slides 12px from the left |
| 160ms | Trace step 1 "Request" | Visible and active while the request is in flight |
| response | Trace steps 2 and 3 | Resolve with `--story-stagger` between them, showing the real RSC values (P6) |
| response + 280ms | Phone column | Opacity 0 to 1, slides 12px from the right |
| settle | Root | `data-stage="system"`; fresh tint starts on the tree node and record (S4) |

On failure the root returns to `intro`, the keyring travels back, and the hint line shows
the server message in `--warning` above the same button guidance.

Reduced motion (P7): no travel and no slide. The intro fades out and the system stage fades
in over `--story-quick`; trace steps appear together once the response is in.

## 6. S3 System stage (`data-stage="system"`), desktop and tablet landscape

- Top bar, 56px, sticky, frosted canvas with a hairline bottom (DESIGN.md 6). Left: brand.
  Center: scene stepper. Right: `Family dashboard` quiet link and the language toggle.
- Scene stepper (page control): previous and next chevrons as 44px icon buttons, seven
  44px targets between them. Past and future scenes show an 8px dot (`--control-border`);
  the current scene expands into a 28px pill with its number and label in
  `--accent-text` on `--accent-soft`. Each target has an accessible name "2. Went out".
  It replaces the black rail and the footer under the phone (P2, P11).
- Grid: `[gutter] [Mobius minmax(380px, 560px)] [phone]`, gaps `clamp(24px, 3vw, 48px)`.
  Gutter = dock width + 2 x 32px (216px at 1280 and wider, 184px below).
- Mobius column, flat, sections divided by 32px and a hairline:
  1. Header: `Mobius` 17px/700, Live/Local badge with its word, meta line in 13px muted
     (session id, actions left).
  2. Trace hero (S4). This is the screen's hero.
  3. Mobius tree: 15px/600 heading, node count, quiet Sync button; the tree sits on the
     canvas with hairline top and bottom, max height `40svh`, own scroll.
  4. Records: 15px/600 heading, count, flat list with hairline separators.
- The scene flow card with three boxes, the guard line and the repeated privacy boxes in
  the system column are replaced by the trace hero and one summary line (P11).
- Phone column: the existing 390px phone frame (hairline bezel, 56px radius), sticky
  under the top bar. Screen height `clamp(640px, 100svh - 128px, 844px)` so the frame fits
  a 900px-tall window without scaling controls below 44px (P3).
- Tablet portrait (761 to 1023px wide): Mobius and phone share two columns; the dock floats
  bottom-left over the Mobius column, which reserves bottom padding equal to the dock.

## 7. S4 Trace hero and fresh-record highlight

```
Just recorded                                        13px/600 accent-text
Safe check from the keyring                          21px/700 ink, time 13px muted
 (o) Request    Browser to web server                15px/600
  |             POST /api/story/action  keyring-confirm        13px mono muted
 (v) Created    Mobius CREATE  RSC 2001                         13px mono, RSC in success
  |             /Mobius/Cpb-story/story-demo/s-../keyring-observation/[e-7]
 (v) Read back  RETRIEVE  RSC 2000, content hash matched
The away status is written to this session, never coordinates.   15px muted, scene line
```

- One hero per action: it lists every record the last action wrote (a keyring press writes
  the button observation and the safe-check or panic record; each gets its own path line
  under "Created" and its own RSC line under "Read back").
- Path: parent segments in `--muted`, the new resource name in ink 600 so the eye lands on
  what was created. Paths wrap anywhere; nothing truncates.
- Markers: 24px circles joined by a 1px hairline. Active: accent dot with a soft breathe.
  Done: success check on `--success-soft`. Steps 2 and 3 render only with real values (P6).
- The same new resource name is tinted in three places: the trace path, the tree node and
  the first record row. Tint: `--accent-soft` background plus a 3px `--accent` inset bar on
  the leading edge; two soft pulses over `--story-fresh`, then the tree node stays in its
  normal selected state. The tree expands to the node, selects it and scrolls it into view
  inside the tree only (P8).
- The trace hero is a polite live region: screen readers hear the record label and RSC once.

## 8. S5 Floating keyring dock

- One keyring instance for the whole page. It never unmounts between intro and system;
  the travel in S2 is that same element moving (P8).
- `position: fixed`, `z-index: var(--z-dock)`. The dock wrapper is `pointer-events: none`;
  the 3D stage, the two hit areas and the tools are `pointer-events: auto`. Transparent
  areas around the keyring never block the page.
- No background, border, radius, shadow box or section heading. The keyring keeps its
  product shadow; the tools are plain text controls (P11).
- Desktop: bottom-left in the gutter, 32px from the left and bottom edges plus safe areas.
  Above the model, the guidance caption (13px/600, max 180px, only while the scene's
  guided button is pending). Below it, the tools row: `Rotate` and `Move` as a text
  segmented control (muted label, active label in ink with a 2px ink underline) and
  `Reset` as a quiet accent link, each 44px tall (P3).
- Hit areas: 46px circles centered on the real buttons, so the default pose (rotateX 8deg,
  rotateY -10deg) still projects 45px or more on screen. When the dock is small enough that
  the circles would overlap, each target shifts outward so they meet at the midpoint
  between the buttons and still contain the visual button; the halo stays centered on the
  visual button (P3, P9).
- Drag rotates or moves (by the selected mode), arrow keys work on the focused stage,
  confirm and emergency presses run the real `/api/story/action` (P10).

## 9. S6 Phones

Phone landscape (`orientation: landscape` and height 520px or less), the primary phone
layout:

```
+--------------------------------------------------------------------+
| (B)          <  2/7 Went out  >                            KO EN    |  44px
+----------+------------------------------+--------------------------+
|          | Just recorded                | Privacy Bubble            |
|          | Safe check from the keyring  | Today                     |
|          |  o Request ...               | Activity                  |
|          |  v Created RSC 2001 ../e-7   | 4:31 PM Mom went out      |
| [keyring]|  v Read back RSC 2000        |                           |
|  Rotate  | [ Mobius tree | Records ]    |                           |
|  Move    |  tree with the fresh node    |                           |
|  Reset   |                              |                           |
+----------+------------------------------+--------------------------+
  112px        system pane, own scroll        app pane, own scroll, 42%
```

- Three columns: dock (112px), Mobius pane, app pane (`minmax(300px, 42%)`). The document
  never scrolls; each pane scrolls on its own. Safe-area insets pad left and right.
- Top bar 44px: brand mark only, compact stepper (`<`, "2/7 Went out", `>`), language toggle.
- Mobius pane: trace hero always on top, then a two-segment control
  `Resource tree | CSE records` with one segment always open (tree by default, so the fresh
  node is visible after a press). Body text inside the pane is 15px; paths 13px.
- App pane: the phone screen content without the status bar or bezel, on `--canvas` with
  a 1px hairline and 24px radius, so it reads as the phone without a drawn device.
- Intro in landscape: S1 at the landscape keyring size, hint line under it, fits one
  viewport.

Phone portrait (`orientation: portrait` and width 760px or less):

- Every portrait entry asks for landscape first, including deep links that start at
  `data-stage="system"`. The prompt is `.story-rotate`, a modal dialog (`role="dialog"`,
  `aria-modal`) outside the intro; header, stage and dock are `inert` while it is open.
  It shows only under `max-width: 760px`, `orientation: portrait` and
  `.story-demo[data-portrait="ask"]`, and never in landscape, after `Continue upright`
  (`data-portrait="continue"`) or in `.story-demo.capture`.
- Content: a 44px phone glyph that turns 90 degrees once (static and already turned under
  reduced motion), the title `최적화된 데모를 위해 가로로 돌려 주세요` /
  `Turn your phone sideways for the optimized demo` (21px/700), one 15px muted line, and a
  quiet 44px `세로로 계속 보기` / `Continue upright` button. Text column max 22rem, centered.
- Over the intro the dialog has no scrim: the keyring stays sharp above it as context and the
  prompt starts 28px under the keyring (the guidance halo and hint line are off). Over a
  deep-linked system stage the dialog covers the page with `--canvas` at 94% plus a 12px
  blur, so the app and Mobius read as a quiet background (P2, P11).
- Fixed, z-index `--z-modal` 40 (above the dock), safe-area padding on all four sides, own
  scroll for very short screens (320 x 568 fits). Fades in over `--story-base`; no fade
  under reduced motion. Light and dark use the same tokens. `Continue upright` from the
  intro runs the normal S2 travel into the portrait system stage. The continue path keeps
  WCAG 1.3.4 (no orientation lock).
- Portrait system stage (fallback): top bar 52px; app pane on top (56% of the height, own
  scroll, never covered); Mobius sheet below (44%, own scroll) with the trace hero and a
  segmented control `Resource tree | CSE records | Scenes`; the dock (72px model, tools
  stacked) sits in a left gutter of the sheet, so input stays beside the record as in
  landscape (P8). Everything fits 390 x 844 with 44px targets.

## 9a. Visual decisions recorded during the story.css pass (2026-11-21)

| Decision | Why | Principle |
| --- | --- | --- |
| The intro lays the keyring out at full size; only the 640ms travel uses `transform: scale` (`story-dock-travel` keyframes on `data-stage="sending"`) | A statically scaled 3D layer rasterizes at the dock size and shows a soft render and LCD; real layout size keeps READY/CONFIRM/PANIC crisp | P8, P9 |
| Dock tools and the guidance caption fade in after `--story-travel` | Controls appear only once the keyring has landed | P1, P6 |
| Mobius pane text wraps on words (`overflow-wrap: break-word`); paths, codes and node names may break anywhere; no ellipsis, nowrap or horizontal clipping | English oneM2M labels and full resource paths stay readable at 844px | P4, P10 |
| Tree rows: line one holds the disclosure chevron, kind dot, name and `RETRIEVE / RSC`; line two holds the resource type. Below 1024px each sits on its own line | One aligned grid instead of wrapped fragments | P2, P11 |
| Mobius header is a grid: title and Live/Replay badge on one line, session meta below | Saves a line in landscape and keeps the badge next to the title it qualifies | P2 |
| The record whose path matches the tree and trace gets the tint, bar and pulse; other new rows get a light tint only | One fresh record reads as the answer to the press | P2, P5 |
| Segmented controls on phones use a `--surface-strong` track with a `--surface` thumb; the language toggle uses the same light thumb | A black pill pulled focus away from the hero | P5 |

## 10. Implementation contract (shared by design and function)

Root and stages:

- `.story-demo` carries `data-stage="intro" | "sending" | "system"`. Transitions:
  intro -> sending on a keyring press; sending -> system when the API resolved and at least
  `--story-travel` has passed (0ms under reduced motion); sending -> intro on failure.
- Intro shows on the first visit to `#/story` or `#/story/login` in a browser session with
  no keyring press yet. Deep links to later scenes and `?capture=1` start in `system`.
- `.story-demo` carries `data-portrait="ask" | "continue"` (default `ask`). Only portrait
  phones read it.
- Regions that are visually hidden for the current stage carry the `inert` attribute.

Markup (class names are the contract; CSS owns every visual value):

```
div.story-demo[data-stage][data-portrait]
  a.skip
  header.story-topbar
    a.story-brand
    nav.story-stepper
      a.story-stepper-prev, ol > li > a.story-stepper-item(.is-current)(.is-past)
        > span.story-stepper-dot + span.story-stepper-label
      a.story-stepper-next, span.story-stepper-compact ("2/7 Went out")
    a.story-topbar-link (family dashboard)
    LangToggle
  section.story-intro (inert unless intro)
    h1.story-sr
    p.story-intro-hint[aria-live=polite] > i.story-intro-dot.confirm|.panic + text
    div.story-rotate > span.story-rotate-glyph + p.story-rotate-title + p.story-rotate-body
      + button.story-rotate-continue
  main.story-stage (inert while intro)
    aside.story-mobius                       StoryMobiusPanel
      header.story-mobius-head
      section.story-trace[data-phase=sending|verified][aria-live=polite]
        p.story-trace-eyebrow, h2.story-trace-title, time.story-trace-time
        ol.story-trace-steps > li.story-trace-step[data-step=request|create|readback](.is-active)(.is-done)
          > span.story-trace-marker + div > strong + code.story-trace-path
            (span.story-trace-parent + b.story-trace-rn) + span.story-trace-rsc
        p.story-trace-summary (scene flow summary)
      nav.story-panel-tabs (phones only; landscape: tree, events; portrait: tree, events, scenes)
      section.story-panel-card.story-mobius-tree-card
      section.story-panel-card.story-mobius-events  (first li.is-new-event while fresh)
      section.story-panel-card.story-scene-panel     (portrait only)
    div.story-app-column > div.story-device > div.story-phone#story-app
  div.keyring-dock[data-guided=confirm|panic|none]
    VirtualKeyring (moved out of StoryMobiusPanel; markup unchanged)
```

Behavior owned by function:

- Tree: the node whose path equals the newest record gets `.is-fresh` and `data-fresh`
  for 4000ms, becomes selected, its ancestors open, and it scrolls into view inside
  `.mobius-tree-scroll` only.
- Dock move limits: x from -16px to 72px, y from -32px to 16px while docked, so the
  keyring stays on screen.
- The rail (`StoryGuide`) and `StoryFooter` are replaced by `nav.story-stepper`.
- Existing contracts stay: browser-isolated session cookie, CSRF and Idempotency-Key on
  `/api/story/action`, scene auto-actions, care and location flows, `?capture=1` app shots.

## 11. Verification

`npm run capture:story` drives real CDP mouse input against the built app and the replay
CSE, and records numbers in `evidence/story-screens/capture-manifest.json`:

| Viewport | Captures | Assertions |
| --- | --- | --- |
| 1440 x 900 light | intro, system | Intro: only `.story-intro` and `.keyring-dock` visible, no `.story-panel-card` visible, model width 200px or more. A real click on the confirm hit center returns HTTP 200 from `/api/story/action` and `RESIDENT_CONFIRMED` appears. System: dock rect within 48px of the left and bottom edges, dock background transparent and border 0, dock z-index 30, dock rect and `.story-mobius` rect disjoint, `.story-mobius` left of `.story-app-column`, `.is-fresh` node path equals the newest record path equals the trace path, `elementFromPoint` at the confirm center returns the confirm button |
| 1440 x 900 dark | system | Same layout assertions |
| 844 x 390 landscape, mobile | intro, system | No document scroll, dock left of Mobius pane left of app pane, panes disjoint from the dock, every visible target 44px or more |
| 390 x 844 portrait, mobile | intro (rotate prompt), fallback system | Rotate prompt and keyring visible, continue button 44px, fallback fits the viewport with 44px targets |
| any, reduced motion | system | No running animations on the dock, transition happens without travel |
| keyboard | intro | Tab reaches the confirm button and shows a visible focus outline |

The seven `?capture=1` app screens stay as they are.
