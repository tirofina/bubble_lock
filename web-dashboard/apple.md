---
name: Privacy Bubble story demo, Apple HIG brief
role: WEB-DASHBOARD
doc-rev: 2.0.0
scope: "#/story/* (StoryDemo, StoryCoach, VirtualKeyring, StoryMobiusPanel, StoryMobiusTree, LocationMap story variant; story.css, location-map.css) and the operator Mobius Resource Browser on every #/operator/* page (OperatorMobiusBrowser, operator-mobius.css)"
status: canonical design brief for the story demo
inputs: DESIGN.md (token values), docs/hig-sources.md (HIG pages and their web adaptation)
---

# apple.md

This file is the canonical design brief for the Privacy Bubble story demo and the operator
Mobius Resource Browser. Every final design decision on `#/story/*` cites a section here (P1 to
P13, S1 to S9); the operator browser follows section 12. `DESIGN.md`
keeps the token values and the rest of the web app; this file decides how the story demo
uses them. Change the brief first, then the code.

Roles. Design (Claude): this file, `src/story.css`, visual QA. Function (Codex): state
machine, API wiring, component markup per section 10, capture script and tests. Both
sides treat section 10 as the shared contract and section 11 as the shared acceptance test.

Design direction: a calm console. One product, one record, one person on one screen,
with the hierarchy carried by type size, weight and whitespace instead of boxes.

## 1. Principles

| ID | Principle | What it means on screen | Source |
| --- | --- | --- | --- |
| P1 | Progressive disclosure | The first screen shows the keyring alone. Mobius, the app and the scene navigation appear only after the first real button press, in reading order: request, created record, readback. | HIG Layout |
| P2 | One hero per screen | Intro: the keyring. System: the record that was just written. The phone is the witness. Outside the phone screen, each stage has one 21px or larger headline at most. | HIG Layout, Typography |
| P3 | 44px targets | Every control, including the two invisible keyring hit areas, is at least 44 x 44 CSS px at every breakpoint. Hit areas never overlap. | HIG Buttons, WCAG 2.5.8 |
| P4 | System type | `--font` and `--mono` from `styles.css`. Sizes from the DESIGN.md scale (34, 28, 21, 17, 15, 13) plus 12 and 11 on phones. Nothing renders below 11px. Paths and RSC codes use `--mono` with tabular numbers. | HIG Typography |
| P5 | Restrained color and depth | One blue family for actions and highlights. Keyring blue `#4b9fd6` and orange `#ef7a3d` appear only on and around the keyring. Status always carries a word. Depth comes from surface change and a 1px hairline; the product shadow belongs to the keyring alone. | HIG Color, DESIGN.md 6 |
| P6 | Motion follows real state | A success mark appears only after the server response is in. Staggering orders data that has already arrived; it never stands in for a pending request. | HIG Motion |
| P7 | Reduced motion | Under `prefers-reduced-motion: reduce`, travel becomes a 160ms crossfade, breathing halos become a steady ring, pulses become a steady tint, the rotate glyph is drawn already turned. | HIG Accessibility, Motion |
| P8 | State change and spatial relation first | The record sits on the left (Mobius); the person's two devices sit together on the right (phone, then the keyring at the outer edge, under the right thumb). A press travels right to left into the record and the phone shows the result. Transitions move the same object from one place to another; nothing appears from nowhere. | HIG Layout |
| P9 | Firmware truth | The LCD shows only READY, CONFIRM and PANIC with the firmware glyphs and colors. The hit areas sit on the real button positions measured from the product render. | Keyring firmware r26 |
| P10 | Inclusive defaults | Korean and English, light and dark from the system setting, full keyboard path, 3px `:focus-visible` ring (inset inside clipped panes), polite live regions for new records. | HIG Accessibility, Dark Mode |
| P11 | Plain surfaces | Flat canvas, hairline separators, no gradients, no frosted cards, one explanation line per screen. The floating keyring has no background, border, shadow box or tool row. | DESIGN.md 7 |
| P12 | One viewport | `.story-demo` fills exactly 100vw x 100dvh. The document and every pane keep zero scroll in both axes. The one intentional inner scroller is the Resource tree box (`.mobius-tree-scroll`): it holds the complete oneM2M hierarchy and scrolls vertically by wheel, touch pan and keyboard. Segmented panels switch content and CSE records page one record at a time. Safe-area insets keep every control clear of the notch, Dynamic Island, sensor housing and home indicator. | HIG Layout, WCAG 1.4.10 |
| P13 | Guide, then step aside | Every scene carries one small guide tip (S9) that names the current idea and the next real action. Highlights come in three strengths: the keyring button is the strongest, the exact next action (app button, map, Next arrow, guided Mobius tab or panel region) is medium, and secondary Mobius evidence is the weakest. The tip ignores the pointer and lives in a slot the layout already keeps free, so the highlighted target stays fully operable and visible. | HIG Onboarding, Motion |

Sources: https://developer.apple.com/design/human-interface-guidelines/layout ,
https://developer.apple.com/design/human-interface-guidelines/typography ,
https://developer.apple.com/design/human-interface-guidelines/color ,
https://developer.apple.com/design/human-interface-guidelines/dark-mode ,
https://developer.apple.com/design/human-interface-guidelines/accessibility ,
https://developer.apple.com/design/human-interface-guidelines/buttons (retrieved 2026-10-29, see
`docs/hig-sources.md`), https://developer.apple.com/design/human-interface-guidelines/motion
(added for P6 and P7), https://developer.apple.com/design/human-interface-guidelines/segmented-controls
(panel switcher), https://developer.apple.com/design/human-interface-guidelines/onboarding
(scene guide, P13), https://developer.apple.com/design/human-interface-guidelines/maps (approved
map, S8), https://osmfoundation.org/wiki/Licence/Attribution_Guidelines and
https://leafletjs.com/reference.html#control-attribution (map attribution),
https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html ,
https://www.w3.org/WAI/WCAG21/Understanding/orientation.html ,
https://www.w3.org/WAI/WCAG21/Understanding/reflow.html .

## 2. Tokens for the story demo

Color, type, radius and spacing come from `src/styles.css`. The story demo adds:

| Token | Value | Use |
| --- | --- | --- |
| `--keyring-confirm` | `#4b9fd6` | Confirm dot in hints |
| `--keyring-panic` | `#ef7a3d` | Emergency dot in hints |
| `--halo-confirm` / `--halo-panic` | `#2b86d6` / `#ea5a1c` | Guidance halo around the confirm (blue) and emergency (orange-red) button |
| `--story-quick` | 160ms | Opacity and color changes, reduced-motion crossfade |
| `--story-base` | 280ms | Pane entrance (opacity plus 12px slide) |
| `--story-travel` | 640ms | Keyring travel from intro to dock |
| `--story-stagger` | 90ms | Gap between trace steps that are already resolved |
| `--story-breathe` | 2.4s | Guided-button halo cycle (ease-in-out) |
| `--story-fresh` | 2.4s | New-record tint: two soft pulses, then a steady selected tint |
| `--segment-track` / `--segment-thumb` | `--surface-strong` / `--surface`; dark: `rgb(118 118 128 / .24)` / `#636366` | Panel switcher, scene chevron hover |
| `--tree-bg` / `--tree-shade` | `--canvas` (`--surface` on the portrait sheet) / `--muted` at 26% | Resource tree edge shades: 10px shade over a 20px cover that travels with the rows (S4) |
| `--proof-pad` / `--proof-marker` / `--proof-gap` | 28 / 36 / 24px desktop; 14 / 24 / 10-12px phone landscape; 10 / 20 / 6px iPhone mini Safari | System proof receipt (S7); `--proof-title`, `--proof-detail`, `--proof-code`, `--proof-count` set its type per tier |
| `--finale-slot` / `--finale-end-slot` | 0px; leading 48px where the brand sits at the stage's bottom-left (shallow); trailing 96px where the flags close the row (iPhone mini Safari) | Leading and trailing margins of the System proof actions row |
| `--flag` (per language button) | inline SVG: Taegukgi for `lang="ko"`, the US flag for `lang="en"` | Language control at the top-right: 22 x 15px flag centered (flex) in a 44px button |
| `--coach-halo` / `--coach-wave` | `--accent` at 30% / 36% | Scene guide highlight (S9): a steady 4px halo, and the wave that travels to 10px twice |
| `--guide-fill` / `--guide-ring` | `--accent` at 12% / 60% | Medium Mobius mark: the tint and 1.5px inset ring on the guided tab, the 2px inset ring on the open guided record region |
| `--guide-soft` | `--accent` at 30% | Weakest Mobius mark: the 1px inset ring on a secondary evidence region; the secondary tab dot uses `--guide-ring` |
| `--coach-proof` | `--success` at 34% | System proof highlight: a 4px ring around the receipt and its session footer |
| `--safe-top/right/bottom/left` | `env(safe-area-inset-*)` | Every edge offset below |
| `--topbar-h` / `--nav-h` | 56 / 44px desktop, 44 / 44px phone portrait, 0 / 44px phone landscape | Top bar and bottom navigation rows; `--chrome-top` and `--chrome-bottom` add the safe areas |
| `--z-topbar` / `--z-intro` / `--z-dock` / `--z-modal` / `.skip` | 10 / 20 / 30 / 40 / 50 | Stacking order |

Keyring sizes (render is 271 x 359, aspect 0.755; height = width x 1.3247). The intro lays
the keyring out at `--dock-kw x --intro-scale` (S2 explains why).

| Place | Docked width (`--dock-kw`) | Dock position | Intro scale | Intro width |
| --- | --- | --- | --- | --- |
| Desktop, 1280px and wider | 160px | 24px from right and bottom (plus safe areas); 1440 x 900: x 1256, y 664, 160 x 212 | 1.9 | 304px |
| Desktop, 1024 to 1279px | 136px | 20px from right and bottom | 2.1 | 286px |
| Desktop, 820px tall or less | 112px | 20px from right and bottom; 1024 x 768: x 892, y 600 | 2.2 | 246px |
| Phone landscape, taller than 340px | 112px | Right track beside the app, 6px above the bottom bar; 844 x 390: x 724, y 192 | 1.7 | 190px |
| Installed web app, phone landscape (`data-display-mode="standalone"`, 440px tall or less) | up to 176px (812 x 375: 176 x 233, OLED 67 x 38) | Right rail between the brand and the scene navigation; 812 x 375 with insets 44 / 44 / 21: x 592, y 73 | 1.15 | 202px |
| Safari tab, phone landscape 300px tall or less (iPhone mini) | up to 148px (812 x 265: 148 x 196, OLED 57 x 32) | Right rail above the scene navigation; 812 x 265 with insets 44 / 44 / 21: x 619, y 2 | 1.05 | 155px |
| Phone landscape, 301 to 340px tall | up to 112px (shrinks to fit the rail) | Right control rail between the flags and the scene navigation; 844 x 320: x 724, y 102, 112 x 148; 1000 x 327: x 880, y 109 | 1.7 | 190px |
| Portrait below 1024px | 112px | 12px from right, 4px from bottom (or the home-indicator inset); 390 x 844: x 266, y 692 | 2.05 | 230px |
| Phone portrait, 700px tall or less / 600px or less | 112px | same | 1.8 / 1.4 | 202 / 157px |

The compact width of 112px keeps the projected model at 104px or more after the default
tilt, so the LCD and both physical buttons stay legible on phones.

## 3. Spatial model

```
 desktop (1024px and wider)
 +------------------------------------------------------------------------------+
 | (B) BubbleLock          [guide tip]          Family dashboard  [KR][US]    |  56 + safe top
 +------------------------------------------------------------------------------+
 |      Mobius Resource Browser   [Replay] |   +-------------+   |  gutter     |
 |      [Transaction|Resource tree|Records]|   | 4:31        |   |  (reserved  |
 |      Latest oneM2M transaction          |   | Privacy     |   |   for the   |
 |      Resident confirmation stored       |   | Bubble      |   |   keyring)  |
 |       o BFF request  POST /api/...      |   |             |   |             |
 |       o CREATE <contentInstance> ../e-2 |   |             |   |  [keyring]  |
 |       o RETRIEVE <contentInstance>      |   +-------------+   |             |
 +------------------------------------------------------------------------------+
 |                         <   2/7 Went out   >                                 |  44 + safe bottom
 +------------------------------------------------------------------------------+
```

The stage pads its right edge by the keyring reserve (`dock-right + dock-kw + gutter`) or by
half of the space beyond the 1040px content width, whichever is larger. The fixed keyring
therefore lives in its own gutter beside the phone and never overlaps the app or a control
(P8, P12). `--dock-left` is derived (`100vw - dock-right - dock-kw`), so the S2 travel keeps
one formula for every layout.

## 4. S1 Intro stage (`data-stage="intro"`)

- Full canvas, no cards, no rail, no panels. The top bar shows only the brand and the flags
  at the top-right; the dashboard link and the bottom navigation wait for the system stage (P1).
- The keyring sits at 50% width and on the optical center of the space between the top bar
  and the bottom row, lifted by the hint band, with its own product shadow.
- One hint line under the keyring (24px gap; 12px in landscape), 17px/600 ink (15px in
  landscape), led by a 10px dot in the guided button's color: `파란 버튼을 눌러 보세요` /
  `Press the blue button` (check-in scene: `주황 버튼을 눌러 보세요` / `Press the orange button`).
  This is the only text on the intro besides the top bar (P2, P11).
- The guided button carries the guidance halo of S5 (blue for confirm, orange-red for
  emergency), centered on the visual button, not on the hit area (P5, P7).
- Dragging the keyring rotates it and the focused stage takes arrow keys (P10).
- Both buttons are live. Either press starts S2.

## 5. S2 Sending stage (`data-stage="sending"`)

Starts on the press, ends when the API has answered and the travel has finished
(at least `--story-travel`). Timeline from the press:

| Time | Element | Change |
| --- | --- | --- |
| 0ms | Hit area | Press scale 0.96 for 120ms; LCD latches CONFIRM or PANIC at once (P9) |
| 0 to 160ms | Intro hint | Fades out |
| 0 to 640ms | Keyring | Travels from the intro center to the dock and shrinks to the dock size, one continuous transform with `--ease` (P8) |
| 120 to 280ms | Bottom navigation and dashboard link | Fade in |
| 160 to 440ms | Mobius pane | Opacity 0 to 1, slides 12px from the left (from below in portrait) |
| 160ms | Trace step 1 "BFF request" | Visible and active while the request is in flight |
| response | Trace steps 2 and 3 | Resolve with `--story-stagger` between them, showing the real RSC values (P6) |
| settle | App pane | Opacity 0 to 1, slides 12px from the right |
| settle | Root | `data-stage="system"`; fresh tint starts on the tree node and record (S4) |

On failure the root returns to `intro`, the keyring travels back, and the hint line shows
the server message above the same button guidance.

Reduced motion (P7): no travel and no slide. The intro fades out and the system stage fades
in over `--story-quick`; trace steps appear together once the response is in.

## 6. S3 System stage (`data-stage="system"`), desktop

- Top bar, 56px plus the top inset, on the canvas with a 1px hairline drawn as an inset
  shadow (so the 44px controls keep their exact box). Left: brand. Right: `Family dashboard`
  quiet link.
- Language: two small flags at the top-right of the screen, the last item of the top bar after
  `Family dashboard` (Taegukgi for 한국어, the US flag for English), each a 22 x 15px flag with a
  hairline edge centered in a 44px button; the second flag's edge sits on the 24px gutter line
  (1440 x 900: 88 x 44 at x 1339, y 6; 1024 x 768: x 927, y 2). The
  chosen language shows at full color with a 1.5px accent ring; the other rests at 50% with
  reduced saturation. The words `한국어` and `English` stay as the accessible names (P3, P10).
- Bottom navigation (`nav.story-stepper.story-bottom-nav`): one centered row, 44px, above
  the bottom inset: previous chevron, `2/7 Went out` (13px/600, tabular, min width 9.5em so
  the chevrons stay put), next chevron. No bar, no background; chevrons are 44px circles
  in `--muted` with a track-colored hover (P2, P11). Hidden during the intro.
- Grid: `[Mobius minmax(0, 1fr)] [phone] [keyring gutter]`, column gap `clamp(20px, 2.6vw, 40px)`.
  Phone width `min(390px, max(340px, (stage height - 16px) x 0.47))`, so the frame keeps the
  iPhone aspect and never drops below 340px of text width.
- Mobius pane, flat, one panel at a time (P12):
  1. Header: `Mobius Resource Browser` 17px/700, Live/Replay badge with its word, meta line
     in 13px muted (session id, actions left).
  2. Panel switcher: a segmented control (`Transaction | Resource tree | CSE records`),
     max 440px wide, 44px segments, 12px track radius, 10px thumb radius.
  3. Panel: Transaction is the hero (S4). Resource tree shows the complete hierarchy in one
     bounded scroll box under a single 44px header row (`CSE resource tree` 15px/600, the live
     count `12 resources` 13px muted, a quiet `Sync` on the right); the switcher already names
     the panel, so the section heading stays for screen readers only. The node detail under the
     box shows the type, the RETRIEVE result, the full path and `Copy full path`. CSE records
     page one record at a time. 1440 x 900: box 626 x 478, nine of twelve rows in full view.
- Phone: 390px frame (hairline bezel, outer radius `clamp(36px, 5.6dvh, 54px)`, inner radius
  outer minus 10px), centered vertically, max 880px tall.
- At 820px tall or less the top bar is 48px, the trace tightens (title 17px, codes 12px) and the
  phone uses 21px titles, 15px bubbles, 17px card titles and 44px buttons, so 1024 x 768 and
  1280 x 720 fit every scene.
- Session error (live app, every layout): one status row, warning text on `--warning-soft`
  (13px on desktop, 12px on phones) with a 44px `Reconnect` text button on the right. While it
  shows it stands in for the app title bar and the privacy footnote (the footnote stays in the
  accessibility tree, so the passcode description still resolves); the scene title, cards and
  actions keep their places and nothing overlaps.

## 7. S4 Trace hero and fresh-record highlight

```
Latest oneM2M transaction                                  13px/600 accent-text (desktop only)
Resident confirmation stored                 1:25:41 PM    21px/700 ink, time on the title baseline
 (v) BFF request                                           15px/600
  |  POST /api/story/action keyring-confirm                13px mono muted
 (v) CREATE <contentInstance>
  |  /Mobius/Cpb-story/story-demo/s-../keyring-observation/[e-2]
  |  CREATE RSC 2001                                       13px mono, success
 (v) RETRIEVE <contentInstance>
     /Mobius/Cpb-story/story-demo/s-../keyring-observation/[e-2]
     RETRIEVE RSC 2000
This session stores the away state ... without location coordinates.   15px muted
```

- One vertical line, top to bottom, like a receipt. Markers are 24px circles joined by a
  1px hairline that turns success-tinted once the step is done. Steps 2 and 3 render only
  with real values (P6).
- One hero per action: it lists every record the last action wrote (a keyring press writes
  the button observation and the confirmation or panic record; each gets its own path line
  under CREATE and its own line under RETRIEVE).
- Desktop path: parent segments in `--muted`, the new resource name in accent 600 on
  `--accent-soft`, kept whole (`white-space: nowrap`). Parent segments wrap anywhere; nothing
  truncates.
- Below 1024px (phone landscape and portrait) the Transaction panel is a compact receipt:
  the eyebrow is dropped (the switcher already says Transaction), the title is 15px, codes
  are 11px, the request label and its code share one line, and each record reads as its
  resource name token plus `CREATE RSC 2001` or `RETRIEVE RSC 2000` on one line, records side
  by side and wrapping as whole tokens. The parent path is hidden here and shown in full in
  Resource tree (node detail) and CSE records, so live CSE paths of any length keep the panel
  inside its box (P12). `data-trace-path` still carries the full path.
- Length budget for the compact receipt at 844 x 390: two records per step with live
  paths such as `/Mobius/dash-operator/story-demo/s-13bd1f81b260c3b6c07/keyring-observation/e-2-f4d325`
  fit the 288px panel (iPhone landscape insets: 267px; 390 x 844 portrait: 280px).
- The same new resource name is tinted in three places: the trace path, the tree node and
  the matching record row. Tint: `--accent-soft` background plus a 3px `--accent` inset bar on
  the leading edge; two soft pulses over `--story-fresh`, then the tree node stays in its
  selected state. The tree selects the node and centers it inside its scroll box, smoothly or
  at once under reduced motion (P7, P8).
- The trace hero is a polite live region: screen readers hear the record label and RSC once.

Resource tree (`.mobius-tree-scroll`), every layout:

- One bounded box between two hairlines takes all the height the panel leaves after its header
  (desktop) or after the path line (below 1024px). It is focusable (`tabindex="0"`, labelled
  with the resource count), shows the 3px focus ring inset, contains its overscroll and pans
  vertically on touch.
- Vertical axis only, every layout: the box carries `data-scroll-axis="vertical"`,
  `overflow-x: hidden`, `overflow-y: auto` and `touch-action: pan-y`; TSX pins `scrollLeft` at 0.
  Names, types and long oneM2M paths wrap inside their row (`overflow-wrap: anywhere`), so the
  box's scroll width equals its client width and a sideways swipe moves nothing.
- Scroll cues, both quiet: a thin native scrollbar in `--muted` at 45% (overlay on iOS, so it
  costs no width there) and a 10px edge shade that appears only on the side where more rows
  wait. The shade is a `background-attachment: scroll` gradient under a `local` cover that
  travels with the first and last rows, so it needs no script and no layout space.
- Rows are 44px targets. Desktop: dot, name (15px/600) and RSC on the first line, the oneM2M
  type (13px muted) under the name. Below 1024px: dot and name (13px/600; 12px on iPhone mini
  tiers) over the type (11px), and the RSC as its own right column of two short mono lines
  (`RETRIEVE /`, `RSC 2000`, 11px, 10ch) so names and types keep the width.
- RSC values use `--mono` 600 with tabular numbers, success when verified. Depth indents 14px
  per level (6px on the iPhone mini tiers).
- Below 1024px the selected node's full path (11px mono, breaks anywhere) and `Sync` (44px,
  icon and 11-12px label) share the last line, path left and Sync right, so no toolbar row or
  column sits above the rows.

## 8. S5 Floating keyring

- One keyring instance for the whole page. It never unmounts between intro and system;
  the travel in S2 is that same element moving (P8).
- `position: fixed`, `z-index: var(--z-dock)`, outside `.story-stage`. The dock box is
  exactly the model (`--kw x --kh`). The wrapper is `pointer-events: none`; the 3D stage and
  the two hit areas are `pointer-events: auto`.
- No background, border, radius, shadow box, heading or tool row (P11). The product render
  carries a two-layer drop shadow (soft 14px plus a 2px contact shadow); in dark mode the
  shadow deepens and a 1px light rim separates the mint body from the black canvas.
- Interaction: drag rotates (rotateX within 32deg, rotateY within 58deg); arrow keys rotate
  the focused stage, Shift doubles the step. Rotate, Move and Reset controls do not exist.
- Position: bottom-right on every layout (S3, S6). Desktop: 24px (20px below 1280px wide)
  from the right and bottom edges plus safe areas, inside a reserved gutter beside the phone.
- Guidance halo (one per guided button, `.is-guided`): a 3px inner ring of `visual + 22px`
  over a 14% tint; an outer wave whose 2.5px edge (an animated outline) travels 18px out and
  fades over a soft 20% fill, every 1.6s (`visual + 63px`: 81px at 112px keyrings, 85px at
  136px, 89px at 160px, 113px on the 304px intro); and a 26% tint on the button itself that
  swells 10%. Confirm uses `--halo-confirm`, emergency `--halo-panic`. The wave stays below the
  LCD, so READY/CONFIRM/PANIC remain readable; halos ignore the pointer, so hit areas keep
  their 46px. Reduced motion: no animation; a static double ring (the 3px inner ring plus a 2px
  outer ring 7px out over a 12% fill) and the button tint at 106%.
- Hit areas: 46px circles centered on the real buttons, so the default pose (rotateX 8deg,
  rotateY -10deg) still projects 45px or more on screen. When the model is small enough that
  the circles would overlap, each target shifts outward so they meet at the midpoint between
  the buttons and still contain the visual button; the halo stays centered on the visual
  button (P3, P9).
- Focus: the stage shows the 3px ring 6px outside the model; the buttons show it on the
  46px circle.

## 9. S6 Phones

### Phone landscape taller than 340px (below 1024px wide, landscape), for example 844 x 390

```
+--------------------------------------------------------------------+
| Mobius Resource Browser [Replay] | Privacy Bubble      |   [KR][US] |
| [Transaction | Resource tree | CSE records]             |            |
| Resident confirmation stored 1:51 PM | Today          |            |
|  v BFF request  POST /api/story/action  | Activity    |  [keyring] |
|  v CREATE  e-2 CREATE RSC 2001 ...  |                 |            |
|  v RETRIEVE ...                     |                 |            |
+--------------------------------------------------------------------+
| (B)                <   2/7 Went out   >       [guide tip          ] |  44 + safe bottom
+--------------------------------------------------------------------+
        Mobius 1fr                        app 40%        112px track
```

- The top bar folds into one bottom bar: brand left, scene navigation centered, the guide tip
  right. The content keeps the full height above it (P12).
- Flags: the top-right of the keyring track, on the safe edge (`top: max(6px, safe-top)`), which
  stays empty above the keyring. 844 x 390 with insets 47 / 47 / 21: 88 x 44 at x 709, y 6, keyring
  112 x 148 at x 685, y 171.
- Stage columns: Mobius `minmax(0, 1fr)`, app `minmax(280px, 40%)` and an empty 112px keyring
  track, 12px gaps, 8px side padding or the left/right insets (47px on iPhone landscape).
- The keyring sits in that right track, 6px above the bottom bar: clear of the app pane
  (12px), the bottom bar (6px) and the scene navigation.
- Mobius pane: one title row (15px title plus badge; session meta lives on desktop and in the
  shallow rail), then the switcher and the panel. A CSE notice stands in for the title row
  while it shows.
- App pane: the phone screen without the status bar, bezel or home indicator, on `--canvas`
  inside a 1px hairline with a 20px radius. Compact app type: title 17px, card text 13px,
  captions 11px, buttons 44px. In landscape the title bar is 36px (compact-height navigation
  bar, HIG 32pt) and cards use 6 x 10px padding with 1.25 line height, so every scene fits
  271px of content height under the iPhone insets.
- Session error (all layouts below 1024px): the app shows one status row, 12px warning text
  on `--warning-soft` with a 44px `Reconnect` text button on the right, 8px under the pane top.
  While it shows, it stands in for the app title bar and the privacy footnote (the footnote
  stays in the accessibility tree, so the passcode description still resolves); the scene
  title, cards and actions keep their places and nothing overlaps. The Mobius pane shows its
  notice as one 11px row above the switcher. Budget: a 93-character English message is a
  55px row at 844 x 390 (3 lines) and a 70px row under the iPhone insets (4 lines); the
  tightest scene (care-request) keeps 1px to spare there.
- Intro in landscape: S1 at 190px, hint line 12px under it, bottom bar visible.

### Shallow landscape, 301 to 340px tall (Safari with toolbars: 844 x 320, 1000 x 327)

```
+-------------------------------------------------------------------------+
| Mobius     | [Transaction|Tree|Records] | Privacy Bubble       | [KR][US]|
| Resource   | Keyring emergency alert    | Check on Mom         |         |
| Browser    |  v BFF request POST ...    | [emergency card]     |         |
| [Replay]   |  v CREATE e-11 RSC 2001 .. | [Call] [Prepare ..]  | keyring |
| Session .. |  v RETRIEVE e-11 RSC 2000  |                      |         |
| (tip)      | The reason is stored ...   | (footnote)           | 7/7 ... |
| (B)        |                            |                      |  <   >  |
+-------------------------------------------------------------------------+
  104px rail       Mobius content           app 40%, min 270px   112px rail
```

- No bottom bar: the content uses the full height. A right control rail (112px, root grid
  column) stacks the flags (top row, right edge), the keyring and the scene navigation (12px label
  over two 44px chevrons) from top to bottom; the brand takes the bottom-left slot under the Mobius
  identity rail. The keyring width is `min(112px, (height - rail navigation - top row - gaps) /
  1.3247)`, so it never touches the controls above or below it, including under a bottom inset.
  844 x 320: flags x 748, y 4, keyring 112 x 148 at x 724, y 102, brand x 8, y 272; 1000 x 327:
  flags x 904, y 4, keyring x 880, y 109.
- A left Mobius identity rail (104px) keeps the title (13px/700), the badge, the session meta
  and, while it shows, the CSE notice; the switcher and the active panel use the column to its
  right. Transaction and CSE records fit as complete pages; Resource tree scrolls inside its own
  box (844 x 320: 299 x 210) above the path and Sync line.
- App pane: 32px title bar, compact cards, 44px actions whose labels may wrap to two lines.
- Budget (measured, all seven scenes, with and without the 93-character error banner, every
  `.story-content` and open panel at scroll size = client size): 844 x 320 app content 272
  (228 with the banner), 1000 x 327 app content 279 (250). The densest case, check-in after a
  keyring PANIC with two public-length records (`e-11-1b8117`, `e-12-2ae5b6`), leaves 33px
  (844 x 320) and 74px (1000 x 327) under the Transaction receipt.

### Safari tab on iPhone mini, 300px tall or less (812 x 265, insets 44 / 44 / 21)

This is the ordinary Safari tab. Page code cannot hide Safari's address and tab bars; the
Home Screen web app (next section) is the path to the full screen.

```
+--------------------------------------------------------------------------------+
| [guide tip]              [Live]  | Check on Mom     [KR][US] |   [keyring      |
| [Transaction|Resource tree|CSE]  | [emergency card]          |    148 x 196,   |
| Keyring emergency alert  4:31 PM | [Call] [Prepare location] |    OLED and     |
|  v BFF request POST ... panic    |                           |    buttons      |
|  v CREATE <contentInstance>      |                           |    readable]    |
|    e-11 CREATE RSC 2001          |                           |                 |
|    e-12 CREATE RSC 2001          | (footnote, full width,    |  <  7/7      >  |
|  v RETRIEVE ... RSC 2000 x 2     |  two lines)               |     Check-in    |
+--------------------------------------------------------------------------------+
   Mobius 300px                      app 258px                   rail 150px
```

- Usable box 724 x 244 (812 x 265 minus 44 / 44 / 21). Columns: Mobius `minmax(0, 1fr)` (300px),
  app 258px, rail 150px, gaps 8px + 8px.
- Rail: the keyring at up to 148px (`min(148px, (height - bottom inset - 44px nav - gaps) /
  1.3247)`, 148 x 196 at 812 x 265, top 2px) and the scene navigation under it (two 44px
  chevrons with an 11px label that wraps to two lines between them). The brand steps out.
- Flags: the keyring rail fills the right edge from top to bottom (keyring 148 x 196 at x 619,
  y 2, scene navigation under it), so the flags take the next top-right slot: the app pane's
  top-right corner, right beside the keyring (88 x 44 at x 518, y 2, 4px inside the pane edge). The
  screen title row is as tall as the flags (40px under the 4px top padding) and ends 90px short of
  the pane's right edge, so the first card starts under the flags. On the intro the rail is empty
  and the flags take the screen's top-right corner (x 680, y 2). On the System proof the receipt
  owns the stage's top-right, so the flags close the actions row at the bottom-right (x 516,
  y 194), and the row ends 96px short of them.
- Mobius: a two-line header (12px/700 title and an 11px status badge; 11px session line), the
  switcher (44px segments, 97px each, every label inside its segment) and one panel. Outside
  capture mode the scene guide tip (S9) stands in for the title and session line (196 x 31 at
  x 44, y 2) and the Live/Replay badge moves to the right end of that line, so the header keeps
  its box on every page, the Resource tree page included. Transaction
  is one compact receipt: BFF request with its code on one line; CREATE and RETRIEVE
  `<contentInstance>` each with one line per record (resource name, method, RSC); the scene
  sentence stays in the accessibility tree. Resource tree: the header line holds the scene
  guide tip (in capture mode the header's two lines go to the rows); a 300 x 111 scroll box
  (300 x 142 without the tip) of 44px two-line rows with 6px depth indents and the mono RSC
  column, vertical axis only, then the full path
  (breaks anywhere, two lines) beside a 61 x 44 Sync. CSE records: the record, then the CSE
  root beside its pager.
- App: no title bar at this size (the pane is the app), 15px screen title in the 40px title row,
  11-13px card text, 44px actions, inline form labels (62px) on the login screen, a full-width
  footnote (two lines). The care-request card title names the request, so its `Access request`
  eyebrow stays for screen readers. Check-in with a reviewed draft: the draft card reads as one
  paragraph (what is shared, then `Draft` and the hash as one token) and stands in for the
  footnote, which says the same purpose, recipient and time (screen readers keep both).
- Session error at this size: the app banner (11px text, 44px Reconnect) stands in for the
  screen title and the footnote, and the flags yield while it shows (the banner takes the top
  row); the scene name stays in the rail. The Mobius notice (11px, one 13px line) stands in for
  the session line.
- Budget (measured at DPR 3 with insets 44 / 44 / 21, every visible stage, pane, open panel,
  device, phone, content box and switcher segment at scroll size = client size): app content
  236px in every scene (169px under the 93-character banner); Mobius panel 163px. Free height
  in the app content (English): login 17px, care-request 5px, check-in 32px, check-in with the
  reviewed draft 20px, care-request under the banner 15px. Tightest Mobius case:
  check-in after a keyring PANIC with two public-length records keeps 9px under the receipt
  (2px with the CSE notice). The tree box is the one element
  whose scroll size exceeds its client size (two full rows and half of the third in view with the
  scene guide; three full rows without it).

### Installed web app on iPhone mini (Home Screen launch, 812 x 375, insets 44 / 44 / 21)

The Home Screen launch removes Safari's bars (manifest `display: fullscreen`, fallback
`standalone`; `apple-mobile-web-app-capable`, `black-translucent` status bar). StoryDemo marks it
with `.story-demo[data-display-mode="standalone"]` (display-mode standalone or fullscreen, or
`navigator.standalone`). The tier applies to phone landscape up to 440px tall.

```
+---------------------------------------------------------------------------------+
| Mobius Resource Browser [Live]   | Privacy Bubble        | (B)        [KR][US]  |
| Session CB0801, 38 of 40 ...     | Check on Mom          |                      |
| [Transaction|Resource tree|CSE]  | [emergency card]      |   [keyring 176 x 233 |
| Keyring emergency alert  5:21 PM | [Call] [Prepare ...]  |    OLED 67 x 38,     |
|  v BFF request POST ... panic    |                       |    both buttons      |
|  v CREATE e-11, e-12 RSC 2001    |                       |    readable]         |
|  v RETRIEVE e-11, e-12 RSC 2000  |                       |                      |
| The reason is stored first ...   | (footnote)            |  <  7/7 Check-in  >  |
| [guide tip, 300 x 44]            |                       |                      |
+---------------------------------------------------------------------------------+
   Mobius 300px                      app 232px               rail 176px
```

- Usable box 724 x 354. Root grid: stage (Mobius 300px | app 232px, 8px gap) and a 176px rail
  column, 8px gap; the right inset is the root's right padding.
- Rail: one 44px top row with the brand on the left and the flags on the right edge (flags
  88 x 44 at x 680, y 4, the screen's top-right), the keyring as the fixed overlay (width
  `min(176px, (height - bottom inset - 44px nav - top row - gaps) / 1.3247)`, 176 x 233 at
  x 592, y 73; OLED 67 x 38 CSS px, 200 x 113 physical px), the scene navigation at the bottom
  (two 44px chevrons, 12px label). No grid cell or card frames the keyring.
- Guide strip: the Mobius column keeps a 48px strip at the bottom; the scene guide tip takes its
  full width (300 x 44 at x 44, y 310; 232px wide on the intro, clear of the hint line).
- Mobius: two-line header (13px title, 11px badge; 11px session line), 97 x 44 segments, one
  panel: the compact receipt with its scene sentence visible, the tree as a 300 x 164 scroll box
  above the path and Sync line, the records page with the pager beside the CSE root. A CSE notice
  stands in for the session line.
- App: the 36px title bar stays; landscape compact type with 13px card titles and actions.
- No Safari path: `.story-fullscreen-launch` and `.story-fullscreen-guide` do not render (TSX)
  and the CSS hides them under `data-display-mode="standalone"`.
- Status bar: landscape has no top inset. A portrait Home Screen launch paints a black band of
  `--safe-top` behind the black-translucent status bar so its white text stays readable.
- Budget (measured at DPR 3, `navigator.standalone`, insets 44 / 44 / 21): every scene, with
  and without the 93-character banner, at scroll size = client size; check-in after a keyring
  PANIC keeps 16px under the receipt (20px with the CSE notice) and the records page 67px; the
  tree box scrolls (three full rows of twelve in view, 370px to scroll).

### Full-screen path in iPhone Safari (`.story-fullscreen-launch`, `.story-fullscreen-guide`)

- Launch control: shown only by StoryDemo on iOS Safari (not installed) during the intro. A
  quiet text control at the bottom-right inside the insets (812 x 265: 110 x 44 at x 658,
  y 200): 17px arrow glyph and "Full screen", 13px/600 `--muted`, no fill until hover. It sits
  below the keyring and its halo in visual priority and never overlaps the keyring or flags.
- Guide: a native-style sheet centered in the safe area, max 30rem wide, `--surface`, 18px
  radius, a dimmed backdrop (spread shadow) and a soft drop shadow. Content in a grid: a 40px
  accent glyph, the 17px/700 title, one 13px muted paragraph, the three numbered steps as one
  row of 28px pills, and a tinted 44px `Continue in Safari` button at the bottom-right that
  takes focus. 812 x 265: sheet 480 x 184 at x 166, y 36; steps 111 / 161 / 144px wide;
  button 152 x 44. The `hidden` attribute removes it; StoryDemo makes the stage, top bar,
  intro and keyring inert while it is open.
- Motion: the sheet fades in over `--story-base`; no fade under reduced motion. Light and dark
  use the same tokens.
- Coexistence: the portrait rotate prompt owns portrait. Under `data-portrait="ask"` the
  launch control and the sheet do not show; the sheet (z 45) sits above the rotate prompt
  (z 40) in the stacking order.

### Phone portrait (portrait and 760px wide or less)

- Every portrait entry asks for landscape first, including deep links that start at
  `data-stage="system"`. The prompt is `.story-rotate`, a modal dialog (`role="dialog"`,
  `aria-modal`) outside the intro; header, stage and keyring are `inert` while it is open.
  It shows only under `max-width: 760px`, `orientation: portrait` and
  `.story-demo[data-portrait="ask"]`, and never in landscape, after `Continue upright`
  (`data-portrait="continue"`) or in `.story-demo.capture`.
- Over the intro the dialog has no scrim: the keyring stays sharp above it at 230px as the
  product context (halo and hint off), and the prompt starts 20px under the keyring. Over a
  deep-linked system stage the dialog covers the page with `--canvas` at 94% plus a 12px
  blur, so the app and Mobius read as a quiet background (P2, P11).
- Content: a phone outline (18 x 30px, 2px stroke, `--muted`) that turns 90 degrees once
  (static and already turned under reduced motion), the title
  `최적화된 데모를 위해 가로로 돌려 주세요` / `Turn your phone sideways for the optimized demo`
  (21px/700, balanced), one 15px muted line, and a quiet 44px `세로로 계속 보기` /
  `Continue upright` button that takes focus. Text column max 22rem, centered.
- Fixed, z-index `--z-modal` 40, safe-area padding on all four sides, own scroll only when
  the screen is shorter than its content (intro scale steps down to 1.8 at 700px and 1.4 at
  600px tall). Fades in over `--story-base`. `Continue upright` from the intro runs the
  normal S2 travel into the portrait system stage and keeps WCAG 1.3.4 (no orientation lock).

### Portrait system stage (fallback, below 1024px wide and portrait)

```
+------------------------------+
| (B) [guide tip]     [KR][US] |  44 + safe top
| +--------------------------+ |
| | Privacy Bubble           | |  app pane, 44% of the stage
| | Today ...                | |
| +--------------------------+ |
| Mobius Resource Browser [R]  |  sheet on --surface
| Presence state stored        |
|  v BFF request ...           |
|  v CREATE  e-2 RSC 2001      |
|                              |
| [Transaction|Tree ]  ______  |  bottom deck: 2 x 2 panel
| [Records |Scenes  ] |keyrg| |  switcher left, keyring right,
| <  2/7 Went out  >   |_____| |  scene navigation under the switcher
+------------------------------+
```

- Top bar: brand left, flags at the top-right (88 x 44 at x 298, y 0 at 390 x 844), the scene
  guide tip between them (234 x 44 at x 58).
- App pane on top (44% of the stage), Mobius sheet below on `--surface` with a hairline top.
- Bottom deck: the switcher as a 2 x 2 segmented grid (`Transaction | Resource tree`,
  `CSE records | Scenes`) and the scene navigation under it on the left; the keyring (112px)
  bottom-right, 12px from the right edge. The sheet surface continues under the home indicator. The panel above
  the deck spans the full width, so the keyring never covers a record (P8, P12).
- Scenes panel: seven scene links in two columns (44px rows, 13px/600, numbered 22px
  circles, current scene in accent), then the unnumbered `System proof` link with a check in a
  success-tinted circle, and a `Family dashboard` row.

## 9a. Visual decisions recorded during the story.css passes

| Decision | Why | Principle |
| --- | --- | --- |
| The intro lays the keyring out at full size; only the 640ms travel uses `transform: scale` (`story-dock-travel` keyframes on `data-stage="sending"`) | A statically scaled 3D layer rasterizes at the dock size and shows a soft render and LCD; real layout size keeps READY/CONFIRM/PANIC crisp | P8, P9 |
| The keyring tool row is gone; drag and arrow keys rotate | The physical product is the control; text tools boxed it in and cost 48px of height on phones | P2, P11 |
| Scene navigation moves to one minimal bottom row | The top bar keeps identity and language only; navigation sits where the thumb and the eye finish | P2, P12 |
| Phone landscape folds the top bar into the bottom bar | 390px of height leaves room for full paths with RSC only when chrome is one 44px row | P12 |
| The keyring lives in a reserved right gutter (desktop), a right track or control rail (landscape) or the bottom-right of the deck (portrait) | A floating overlay must never cover a record; each layout reserves exactly the model box | P8 |
| Desktop trace is one vertical receipt with full paths; below 1024px the trace shows resource name plus RSC per record and hides the parent path | Live CSE paths (for example `dash-operator` sessions) are longer than replay paths; at 844 x 390 full paths grew the panel to 309px inside 288px. Full paths stay readable in Resource tree and CSE records | P4, P6, P12 |
| Resource names in desktop paths never break (`nowrap`); in the compact receipt each name-plus-RSC record wraps as a whole token | The created name is the answer to the press and must read as one token | P2, P4 |
| Panels switch instead of scrolling; CSE records page one record at a time; Resource tree is the one bounded inner scroller | Every other pane keeps zero scroll, so the one-viewport contract and the keyring position stay stable; the tree is a hierarchy and reads best whole | P12 |
| Segmented controls share one light thumb token pair; dark mode uses the iOS gray thumb | A dark thumb on a dark track read as a hole | P5, P10 |
| Disabled record-pager chevrons are 40% muted glyphs without a fill | Filled grey circles looked like pressed buttons | P5 |
| A session error banner replaces the app title bar and the privacy footnote while it shows (below 1024px) | At 844 x 390 a 93-character message pushed login 88px past the pane; the title and footnote are the least specific lines on screen, and the scene keeps its own content | P2, P12 |
| Phone landscape app pane widened from 36% to 40%, 36px title bar, tighter cards | Under the iPhone insets care-request overflowed by 17px with no error; fewer wrapped lines fix every scene | P12 |
| Compact tree rows are two lines (name over oneM2M type) with the RSC as a right column of two short mono lines | Name, type and RSC flowing together wrapped to three lines per node; the RSC column keeps names and types at full width and shows a third more nodes per screen | P4, P12 |
| Top bar hairline is an inset shadow | A border shrank the 44px controls by 1px and pushed the brand into the safe area | P3, P12 |
| Focus rings inside the Mobius pane are inset (`outline-offset: -3px`) | The pane clips overflow; an outside ring would be cut at the edges | P10 |
| Capture mode (`?capture=1`) ignores every compact app rule | The seven 390 x 844 evidence screens keep the full app design | P11 |
| The keyring moves to the bottom-right on every layout | The person's devices (phone, keyring) belong together; the right thumb reaches the keyring; the left side stays the record | P8 |
| Guidance halo becomes a large double halo (inner ring, travelling outline wave, button tint) | A 2px breathing ring at visual + 10px was easy to miss in the first second of the demo | P2, P5 |
| Shallow landscape (340px tall or less) drops the bottom bar for a right control rail and a left Mobius identity rail | In Safari with toolbars (1000 x 327) the bottom bar and title row left no room: the keyring covered the Mobius title and the check-in actions were cut | P12 |
| The language control becomes two small flags (Taegukgi, US flag), first at the bottom-left | The user asked for flags; superseded by the top-right row below | P10 |
| The installed web app gets its own landscape tier: 176px keyring rail between brand and scene navigation, Mobius 300px, app 232px, a Mobius bottom strip (first for the flags, now for the guide tip) | The Home Screen launch frees 110px of height (375 vs 265): the keyring grows to 176px so the OLED and both buttons read at a glance, and every page keeps its header | P2, P9, P12 |
| Safari's bars are explained, not fought: a quiet Full screen control and a three-step sheet | WebKit lets only the Home Screen web app remove Safari's bars; a sheet with the exact steps is the honest path | P1, P11 |
| iPhone mini landscape (300px tall or less) gets its own tier: 148px keyring rail, two-line Mobius header, tree scroll box above a path and Sync line, no app title bar | 812 x 265 in Safari left 244px of height: the 340px tier clipped the tabs, the receipt and the app actions, and the keyring shrank to about 70px | P2, P12 |
| The error banner rule applies on desktop too; short desktops (820px or less) use compact phone type and a 340px minimum phone width | 1440 x 900 login overflowed 50px with the banner; 1024 x 768 care-request overflowed 90px without it | P12 |
| Resource tree shows the complete hierarchy in one bounded scroll box (wheel, touch pan, keyboard focus) and centers the fresh node; the `< n/m >` tree pager is gone | Three rows per page split twelve resources over four pages and hid the parent-child depth; one box shows nine of twelve rows at 1440 x 900 and three or more on every phone tier | P8, P12 |
| Scroll cues are a thin native scrollbar and 10px edge shades that appear only where more rows wait (local cover over a scroll-attached shade) | A pager or a cue column would spend width; the shades need no script and no layout space and read in light and dark | P11, P12 |
| Desktop tree header is one 44px row (title, live count, Sync); below 1024px Sync shares the last line with the selected node's path | A floating Sync over the rows covered row text while rows scrolled under it; the separate section heading repeated the switcher and the Live/Replay badge | P2, P3, P11 |
| System proof is an unnumbered conclusion: the Mobius pane and the phone chrome step away for a statement, one receipt card and two actions beside the same keyring | Inside a stretched phone frame the receipt was three small cards with 300px of empty canvas above them, and at 812 x 265 the action labels broke into near-vertical words (links inherit `overflow-wrap: anywhere` in narrow grid columns) | P2, P8, P11 |
| Scene seven's next control becomes a success-tinted check circle that invites twice | It opens a different kind of page (the proof), so it reads as the success family of that page while staying a quiet 44px circle in the stepper | P1, P5 |
| Approved map: the readout leaves the canvas for a caption line under it; the live chip owns the top-left, the attribution the bottom-right | Before: the readout sat on the attribution in every layout, the pin met the chip at 812 x 265, 844 x 390 and 844 x 320, and chip, readout, action note and meta text rendered at 8-10px | P4, P11, P12 |
| Approved map below 1024px: eyebrow for screen readers, 32px pin scaled around its tip, coordinates only in the caption; iPhone mini drops the live chip | The map is the answer to the approval; every line above it cost map height (the eyebrow wrapped to two lines at 812 x 375). Scaling around the icon anchor keeps the plotted point exact | P2, P12 |
| Portrait fallback gives the app pane 50% of the stage while the map shows | At 44% the map was 132px tall and Call covered its attribution | P2, P12 |
| Scene guide lives in a free slot per layout and never takes the pointer | A floating card next to the target has no room at 812 x 265; the top bar, bottom bar, Mobius rail, guide strip and Mobius identity line are space the layout already keeps, so the map, the keyring and every action stay uncovered | P2, P13 |
| Highlights: halo for buttons and the map, an aura for the keyring, a success ring for the proof (the Mobius sheet was replaced by the exact tab and region marks above) | Each target type gets the quietest mark that still reads at a glance, and every one is steady under reduced motion | P5, P7, P13 |
| Operator browser beside every page, card without shadow, record as a key / value table, workspace as a size container | At 1440 the map was squeezed to 332px beside a 340px list, keys such as `resourceUri` broke into fragments under the global `dl` grid, and `ONEM2M` lost its spelling under an uppercase transform | P4, P5, P11 |
| Flags move to the top-right on every layout: the end of the desktop and portrait top bars, the top of the keyring track (844 x 390), the top row of the right rail (shallow, installed app; the shallow brand moves to the bottom-left), the app pane's top-right beside the keyring (812 x 265 Safari) | The user asked for the flags at the top-right on 2026-11-22. At the bottom-left they covered the reviewed location draft at 812 x 265 (`minute`, `Draft` under the flags, `Location opens` cut). At 812 x 265 the keyring rail fills the right edge from top to bottom; a rail top row would shrink the keyring from 148 to 113px (OLED below the 52 x 25 floor), so the flags take the next top-right corner and the title row grows to their 44px | P3, P10, P12 |
| Guide highlights in three strengths; the whole-Mobius sheet is gone | The sheet tinted every line of the pane, so the exact tab to open did not stand out and evidence competed with the action. Now the keyring halo is the strongest, the exact next action (app button, map, Next arrow, guided tab or open tree box) is medium, secondary evidence is an accent label, a dot and a 1px soft ring | P2, P5, P13 |
| The Transaction receipt's region mark is a rule in its top padding plus a spine behind the markers | Its title, steps and records start at the panel edge, so any ring would cross text; the top padding (4-20px) and the marker column are the receipt's only text-free bands. Portrait gives the receipt a 4px top padding for the rule | P5, P13 |
| The guided tab mark is the Mobius pane's own grid item over the exact segment | The pane clips at its edges, so an outer ring on the first or last segment would be cut; an inset ring and tint inside the segment keep every edge visible and give the pane one real highlight | P5, P12 |
| A reviewed location draft stands in for the footnote (below 1024px); at 812 x 265 the draft reads as one paragraph and the care-request eyebrow stays for screen readers | The draft states purpose, recipient and time, as the footnote does; the drafted check-in overflowed by 14px (844 x 390), 13px (844 x 320) and 43px (812 x 265) | P2, P12 |
| The map's tile credit link keeps its 11px text and gains a 44px target that reaches up over the map | The link measured 76 x 13 | P3 |

## 9b. S7 System proof (`#/story/finale`, `data-finale="true"`)

The conclusion after scene seven, outside the seven numbered scenes. It connects the three
layers the demo proved: keyring input, the Mobius CREATE RSC 2001 / RETRIEVE RSC 2000 readback
and the browser-session / purpose / scope / expiry boundary.

```
 desktop 1440 x 900
 +------------------------------------------------------------------------------+
 | (B) BubbleLock                                           Family dashboard     |
 +------------------------------------------------------------------------------+
 |                                     +------------------------------------+   |
 |  (v) End-to-end proof complete      | (1) Keyring input                v |   |
 |  One signal became                  |  |  Firmware state and button ...  |   |
 |  verified care            34px/700  | (2) Mobius CSE                 x17 |   |
 |  The same intent and boundary ...   |  |  CREATE RSC 2001 / RETRIEVE ... |   |
 |                                     | (3) Security boundary       shield |   |
 |                                     |     Browser session, purpose, ...  |   |
 |                                     |------------------------------------|   |
 |                                     | Demo session 55C134  * CSE readback|   |
 |                                     +------------------------------------+   |
 |                                     [Replay from the keyring] Open the live > |
 |                                                                   [keyring]  |
 | [KR][US]                  <   System proof   (replay)                         |
 +------------------------------------------------------------------------------+
```

- Entry: scene seven's next control carries `data-special`; it reads as a 44px success-tinted
  circle with a check (`--success-soft`, `--success`) that invites with two soft rings, then rests.
  Its accessible name is `Open the system proof`. The stepper on the finale shows `System proof`
  without a number; previous returns to check-in and next (a refresh glyph in accent) replays
  from the keyring (`#/story/login`).
- Stage: the Mobius pane and the phone chrome (bezel, status bar, app title bar, home
  indicator) step away, so the page reads as a conclusion and the keyring stays in its own
  right gutter, rail or track exactly as in the scenes (S5). Nothing covers the keyring.
- Statement (left, 0.8fr): a 40px success seal with the kicker `End-to-end proof complete`
  (15px/600 success), the one headline `One signal became verified care` (34px/700, balanced)
  and one 17px muted sentence.
- Receipt (right, 1.2fr): one surface card with a hairline. Three steps on one success line,
  the S4 trace completed: 36px numbered markers in `--success-soft`, 17px/600 titles, 15px muted
  details, a check, the live count (`x` plus `createRetrieveVerified`, the session's CSE records
  whose CREATE and RETRIEVE both verified) and a shield on the right. The Mobius detail is
  13px mono success, and each detail line runs under the status column, so `RETRIEVE RSC 2000`
  stays whole beside a two-digit count. A footer stub on `--surface-soft` closes the card:
  `Demo session` with the live session id (mono) and `CSE readback verified` with a success dot.
  Every value comes from the session snapshot (P6).
- Actions under the receipt, beside the keyring the replay returns to (P8): a filled accent pill
  `Replay from the keyring` and a plain accent `Open the live dashboard`, labels on one line,
  48px tall on desktop and 44px on phones.
- Composition: the outer rows center the block; the receipt spans the kicker and headline rows,
  which share its extra height, so the statement rests on the receipt's center and the footer
  stays attached. 1440 x 900: receipt 568 x 277 plus a 56px footer at x 657, y 263; actions
  227 x 48 and 232 x 48 at y 616; keyring 160 x 212 at x 1256, y 664.
- Phone landscape (below 1024px): the same statement | receipt pair (21px headline, 13px step
  titles, 12px details, 11px mono, 24px markers) and one actions row pinned to the bottom line.
  It starts after the brand where the brand sits at the bottom-left (shallow, `--finale-slot`
  48px) and ends before the flags where they close the row (iPhone mini Safari,
  `--finale-end-slot` 96px); everywhere else the flags stay at the top-right.
  844 x 390 keeps the 112px keyring track. Measured: 812 x 265 Safari receipt 324 x 139 at
  x 279, y 17, actions 193 x 44 and 198 x 44 at y 193 (x 51-450), flags x 516-604 closing the row,
  keyring 148 x 196 with a 57 x 32 OLED; 812 x 375 installed app receipt 306 x 195, actions at
  x 51, y 303 (the flags sit in the rail's top row), keyring 176 x 233 with a 67 x 38 OLED.
- iPhone mini Safari (812 x 265): 17px headline, 11-12px receipt type, 20px markers, 6px step gap.
- Portrait fallback: one column (kicker, headline, receipt, footer, two full-width 44px actions)
  above the keyring deck.
- Motion: the seal settles from 60% scale over `--story-base`; the invite rings run twice. Under
  reduced motion both stay still.

## 9c. S8 Approved location map (check-in after approval, `[data-location-shared="true"]`)

Function: check-in offers `Prepare location share` (a reviewed draft, coordinates still closed),
then `Review and share for 5 min` (the lease). While the lease runs, the scene becomes
`section.story-check-in-shared[data-location-shared="true"]` with a real Leaflet map. The map
reads `/api/story/location`, which answers only for the approved five-minute lease of the same
HttpOnly browser session (403 before approval, after expiry and for any other browser session;
405 for anything but GET). The countdown counts the lease down from 5:00.

```
 Mom's location                         [4:57]    title 15-28px/700, countdown pill (success)
 (o) Approved location   Mom's keyring  [Simulated data]   status line (label and badge from 1024px up)
 +-----------------------------------------------+
 | (o) Refreshes every 4 s                       |  live chip, top-left (11px/600)
 |                     (1)                       |  pin, centered by fitBounds
 |             (accuracy circle)                 |
 |                         (c) OpenStreetMap      |  tile attribution, bottom-right (11px)
 |-----------------------------------------------|
 | Location from the network service  43.7334, 7.4153 |  readout caption line under the canvas
 +-----------------------------------------------+
 [ Call ]   (shield) Only you, ends automatically      44-48px Call and the note on every layout
```

- Hierarchy: heading (title and countdown on one line), status line, the map as the hero taking
  every remaining pixel (`.story-location-map-target` and the map frame are flex columns), then
  Call. Below 1024px the eyebrow `Purpose-bound location share` stays for screen readers only;
  the countdown and the status line carry the purpose.
- One owner per edge, so nothing covers anything: the live chip owns the canvas top-left, the
  tile attribution the bottom-right, the pin the middle, and the readout (source and
  coordinates) is a caption line under the canvas inside the same frame, never over the map.
  Below 1024px the caption keeps the coordinates and the source stays for screen readers.
- Pin: 40px on desktop and in capture mode; below 1024px it scales to 32px around its tip
  (`transform-origin: 20px 46px`, the Leaflet icon anchor), so the point on the map stays exact.
- iPhone mini Safari (300px tall or less): the live chip steps out (a 98px canvas would put the
  chip on the pin; the countdown carries the live state there). The heading row is the 40px title
  row beside the flags, so the title may take two lines next to the countdown.
- Credit link target: the 11px tile credit link keeps its text and gains a 44px target that reaches
  30px up over the map (inside the canvas, never over the caption).
- Portrait fallback: while the map shows, the app pane takes 50% of the stage instead of 44%.
- Attribution: the complete active-provider credit stays visible at 11px on a frosted strip;
  an unconfigured public host starts with OpenStreetMap, while a Stadia API key or exact registered
  domain keeps the Stadia Maps, OpenMapTiles and OpenStreetMap credits. The optional Leaflet prefix
  steps out of the small story map (the operator map keeps it). Nothing in the map renders below 11px.
- Measured (scratch review, replay CSE, approved map): 1440 x 900 map frame 298 x 483 (canvas
  296 x 417, caption 296 x 26), Call 115 x 48; 844 x 390 with insets 47 / 47 / 21 canvas 268 x 141,
  Call 98 x 44 beside the 164px note; 812 x 265 Safari canvas 234 x 98 at x 364, y 70 (under the
  40px title row beside the flags), caption 22px, pin 32px centered, Call 96 x 44 at x 363, y 195
  beside the two-line note (132 x 28); 812 x 375 installed app canvas 208 x 176, chip 126 x 22,
  Call 96 x 44; 390 x 844 portrait canvas 334 x 134. In every case the chip, pin, attribution and
  caption have disjoint boxes, and `.story-content` keeps scroll size = client size.

## 9d. S9 Scene guide (`.story-coach`) and highlight (`[data-demo-target]`)

StoryDemo sets `data-coach-target` on the root (`keyring | mobius | app-primary | app-secondary |
map | next | proof`), renders one `aside.story-coach[data-target]` (role status, polite) outside
capture mode, and marks the real element with `data-demo-target`. The tip connects three things:
the current idea (label, title, detail), the highlighted target and the next real action.

- Tip: `--surface`, a 0.5px hairline and a soft 16px shadow, 14px radius (9-12px on phones),
  `pointer-events: none`, z-index 32 (above the keyring dock, under the modal sheets). It enters
  from 97% scale and 40% opacity over `--story-base` and never leaves the viewport while it does.
  Under `aria-hidden="true"` (a modal is open) it does not render.
- Content per layout (what stays visible; the rest stays in the live region for screen readers):

| Layout | Slot | Visible | Box |
| --- | --- | --- | --- |
| Desktop, 1024px and wider | Top bar center (the 56 or 48px bar), clear of the brand, `Family dashboard` and the flags | Label and title on line 1, `Next action` and the action on line 2, 12-13px | content width up to min(700px, 100vw - 480px), 44-45px tall; 1440 x 900: 289-441 x 45 at y 6; 1024 x 768: up to 441 x 44 at x 292, y 2 |
| Phone landscape with a bottom bar (844 x 390) | Bottom bar, right of the scene navigation, under the keyring track | Label, then the action (11px) | 255 x 32-44 at x 542 |
| Shallow landscape (844 x 320, 1000 x 327) | Mobius identity rail, between the session line and the brand | Label and action, 104px wide | 104 x 49-101 |
| iPhone mini Safari (812 x 265) | Mobius title and session line; the Live/Replay badge moves to its right end | The action only, two lines | 196 x 31 at x 44, y 2 |
| Installed web app (812 x 375) | The guide strip under the Mobius column, full column width | Label, then the action | 300 x 44 at x 44, y 310; 232px wide on the intro (clear of the hint line); top of the statement on the System proof (the actions row owns the bottom line) |
| Portrait (390 x 844) | Top bar between the brand and the flags | The action only, two lines at most | 234 x 44 at x 58, y 0 (plus the top inset) |

- Highlight hierarchy (one action per scene, three strengths):

| Strength | Target | Mark |
| --- | --- | --- |
| 1, strongest | Keyring button (`data-coach-target="keyring"`) | The guided-button double halo (S5) in keyring blue or orange-red, plus a soft accent aura around the model |
| 2, medium | App button, map, Next arrow (`app-primary`, `app-secondary`, `map`, `next`) | A steady 4px halo (`--coach-halo`) that sends two waves to 10px, then rests |
| 2, medium | Guided Mobius tab while its panel is closed (`button[data-guide-strength="primary"]`, `aria-pressed="false"`) | Accent label; a 1.5px inset ring (`--guide-ring`) over a 12% tint (`--guide-fill`) drawn exactly over that segment by the pane's `::after` grid item (2px track padding, 2px gaps, three equal segments; 2 x 2 in portrait); the tint pulses twice |
| 2, medium | Open guided panel region (`.story-panel-card.is-mobile-open[data-guide-strength="primary"]`) | A 2px inset ring on the tree box (or the record row) that pulses twice; inset, so it never touches a line of text |
| 2, medium | Open guided Transaction receipt (primary trace, the sending stage) | The receipt's text runs edge to edge, so no ring: a 2px `--guide-ring` rule in the panel's own top padding (the empty band under the switcher, `box-shadow: inset 0 2px 0`) and a `--guide-fill` spine behind the step markers (marker width: 24px desktop, 20px below 1024px, 18px installed app, 16px iPhone mini Safari) that pulses twice |
| 3, weakest | Secondary evidence (`data-guide-strength="secondary"`), shown beside an app or map action | Accent label and a steady 6px dot on its tab; a 1px soft ring (`--guide-soft`) on its open record region; on the Transaction receipt a 1px `--guide-soft` rule in the panel's top padding |
| (proof) | System proof receipt | A 4px success ring drawn by the section's own `::after` grid item |

- No sheet covers the Mobius pane: the guided tab and the visible record region carry the mark,
  so the pane's text keeps its normal contrast and the action stays the only medium mark in view.
- Flow (StoryDemo owns the state): daily scenes guide `Resource tree` first (medium tab), then the
  tree box (medium ring, `data-evidence-progress="open"`), then the Next arrow (medium halo) while
  the tree turns secondary (`viewed`). Care expiry guides `CSE records`, then Next. App and map
  actions show the medium halo beside a secondary evidence mark.
- In-app targets sit on the content edge, so `.story-content` reaches 6px into the phone padding
  (negative margin plus padding) and the halo shows whole while the content keeps its width.
- Reduced motion: no entrance, no waves, no aura pulse, no tab or region pulse; every highlight is
  the steady state.
- Never covered: the tip's box stays clear of the map, the keyring, the scene navigation, the
  flags, the Mobius tabs and open panel, Call and every app action (measured in all six slots
  above), and the highlighted target answers `elementFromPoint` at its center. At 812 x 265 the tip
  stands in for the Mobius title and session line by design (S6).

## 10. Implementation contract (shared by design and function)

Root and stages:

- `.story-demo` carries `data-stage="intro" | "sending" | "system"`. Transitions:
  intro -> sending on a keyring press; sending -> system when the API resolved and at least
  `--story-travel` has passed (0ms under reduced motion); sending -> intro on failure.
- Intro shows on the first visit to `#/story` or `#/story/login` in a browser session with
  no keyring press yet. Deep links to later scenes and `?capture=1` start in `system`.
- `.story-demo` carries `data-portrait="ask" | "continue"` (default `ask`). Only portrait
  phones read it.
- `.story-demo` carries `data-display-mode="browser" | "standalone"` (standalone for display-mode
  standalone or fullscreen, or `navigator.standalone`). Only the installed-app tier reads it.
- On iOS Safari outside the installed app, the intro renders `.story-fullscreen-launch`; the
  first landscape intro of a browser session opens `.story-fullscreen-guide` once. Neither
  renders in the installed app.
- Regions that are visually hidden for the current stage carry the `inert` attribute.
- While mounted outside capture mode, the demo sets `overflow: hidden` and
  `overscroll-behavior: none` on `html` and `body`.

Markup (class names are the contract; CSS owns every visual value):

```
div.story-demo[data-stage][data-scene][data-finale][data-portrait][data-display-mode][data-coach-target]
  [data-coach-evidence=trace|tree|events][data-evidence-progress=closed|open|viewed]   grid rows: top chrome, stage, bottom chrome
  a.skip
  header.story-topbar
    a.story-brand, a.story-topbar-link (family dashboard), LangToggle
  section.story-intro (inert unless intro)
    h1.story-sr
    p.story-intro-hint[aria-live=polite] > i.story-intro-dot.confirm|.panic + text
  button.story-fullscreen-launch[aria-haspopup=dialog][aria-expanded]   (iOS Safari intro only)
    > svg + text
  div.story-fullscreen-guide[role=dialog][aria-modal][hidden]
    > span.story-fullscreen-glyph + p.story-fullscreen-title + p.story-fullscreen-body
      + ol > li x 3 + button.story-fullscreen-continue
  div.story-rotate[role=dialog] > span.story-rotate-glyph + p.story-rotate-title
    + p.story-rotate-body + button.story-rotate-continue
  main.story-stage (inert unless system and no prompt)
    aside.story-mobius[lang=en][data-demo-target=mobius]   StoryMobiusPanel
      header.story-mobius-head > div > h2 + p.story-mobius-meta, span.badge
      p.story-server-message (only after a failed request)
      nav.story-panel-tabs > button[aria-pressed][aria-controls=story-panel-*](.has-new-event)
          [data-evidence-target=trace|tree|events][data-guide-strength=primary|secondary]
        > span.story-panel-alert       (trace, tree, events on every layout; scenes in portrait)
      section#story-panel-trace.story-panel-card.story-trace(.is-mobile-open)[data-phase]
          [data-evidence-target=trace][data-guide-strength]   (tree and events panels carry the same pair)
        div.story-trace-heading > div > p.story-trace-eyebrow + h2.story-trace-title, time.story-trace-time
        ol.story-trace-steps > li.story-trace-step[data-step=request|create|readback](.is-active)(.is-done)
          > span.story-trace-marker + div > strong + code
            (code.story-trace-path[data-trace-path] > span.story-trace-parent + b.story-trace-rn
             + span.story-trace-rsc)
        p.story-trace-summary
      section#story-panel-tree.story-panel-card.story-mobius-tree-card
        div.story-events-head (screen readers), div.mobius-tree-view > div.mobius-tree-toolbar
          (p > strong + span count, button Sync),
          div.mobius-tree-scroll[data-scrollable=true][data-scroll-axis=vertical][tabindex=0][aria-label] > ul.mobius-tree[role=tree]
          > li.mobius-tree-leaf[aria-level] > button(.selected)(.is-fresh)[data-path][data-fresh]
            > span.mobius-node-dot + span.mobius-node-name + small (type) + b(.verified) (RSC),
          div.mobius-node-detail
      section#story-panel-events.story-panel-card.story-mobius-events (li.is-new-event.is-fresh,
        div.story-events-pager, p.story-mobius-root)
      section#story-panel-scenes.story-panel-card.story-scene-panel (portrait only)
        nav > ol > li > a(.active), li.story-scene-finale > a, a.story-mobile-dashboard-link
    div.story-app-column > div.story-device > div.story-phone#story-app
      button.story-primary[data-demo-target=app-primary], button.story-secondary | .story-text-action[data-demo-target=app-secondary]
      section.story-content.story-check-in.story-check-in-shared[data-location-shared=true]   (approved lease only, S8)
        div.story-location-heading > div > p.story-eyebrow + h1, strong.story-location-countdown
        div.story-location-map-target[data-demo-target=map]
          > div.location-experience.location-story[data-story-location-map=true][data-location-ready]
            > div.story-location-meta > span.location-status-dot + strong + span + span.badge
            p.location-alert (feed error only)
            div.map-frame > div.location-canvas (Leaflet) + div.map-corner-note + div.story-location-readout > span + code
        div.story-location-actions > button.story-primary (Call) + span (shield and note)
      section.story-content.story-finale[data-finale-receipt=true][data-demo-target=proof]     (#/story/finale only, S7)
        p.story-finale-kicker > svg + text
        div.story-title-block > h1 + p.story-subtitle
        ol.story-finale-proof > li[data-proof=keyring|mobius|boundary] > span + div > strong + small, svg | b (count)
        p.story-finale-session > span + code (session id) + b
        div.story-finale-actions > a.story-primary (replay) + a.story-secondary (dashboard)
  aside.story-coach[data-target][role=status][aria-live=polite][aria-hidden][inert]   outside capture mode, after main (S9)
    p.story-coach-label > span (dot) + text, strong (title), p.story-coach-detail,
    p.story-coach-action > svg + span > b ("Next action") + text
  nav.story-stepper.story-bottom-nav(.is-finale)    outside the header, after main
    a.story-stepper-prev, span.story-stepper-compact[aria-live=polite] ("2/7 Went out", "System proof"),
    a.story-stepper-next[data-demo-target=next][data-special=true on check-in]
  div.keyring-dock[data-demo-target=keyring][data-guided=confirm|panic|none]  fixed, outside main
    div.virtual-keyring > h3.story-sr + div.keyring-stage[role=application][tabindex=0]
      > div.keyring-model > span.keyring-depth, img, span.keyring-screen-live[data-firmware-screen],
        button.keyring-physical-button.confirm|.panic(.is-guided)(.pressed)
```

Behavior owned by function:

- Tree: every resource renders in `.mobius-tree-scroll`. The node whose path equals the newest
  record gets `.is-fresh` and `data-fresh` for 4000ms, becomes selected, and the box scrolls to
  center it (smooth, instant under reduced motion, again when the box resizes).
- System proof: scene seven's next control (`data-special`) opens `#/story/finale`; the root
  carries `data-scene="finale"` and `data-finale="true"`; the finale's previous control returns
  to check-in and its next control replays from `#/story/login`. The receipt reads
  `createRetrieveVerified` and the browser-session id from the live snapshot.
- CSE records page one record at a time; the first record of a new action gets `.is-new-event`.
- Keyring pose: rotate only, rotateX within 32deg, rotateY within 58deg; no move and no reset.
- Existing contracts stay: browser-isolated session cookie, CSRF and Idempotency-Key on
  `/api/story/action`, scene auto-actions, care and location flows, `?capture=1` app shots.
- Approved map (S8): `/api/story/location` answers GET only, and only for the approved, unexpired
  five-minute lease of the same HttpOnly session; the map root reports `data-location-ready`.
- Scene guide (S9): one cue per scene and stage; the root and the tip carry the same target; the
  tip is `aria-hidden` and `inert` while a modal sheet is open and does not render in capture mode.
  The cue's evidence (`trace | tree | events`) marks the matching tab and panel with
  `data-guide-strength` (`primary` while Mobius is the target, otherwise `secondary`); opening the
  tree sets `open`, a wheel, touch pan, scroll key or node selection sets `viewed`, and opening CSE
  records sets `viewed` at once.
- Resource trees (story and operator): `data-scroll-axis="vertical"`, and the scroll handler pins
  `scrollLeft` at 0.

## 11. Verification

`npm run capture:story` drives real CDP input against the built app and the replay CSE, and
records hashes in `evidence/story-screens/capture-manifest.json`. Every viewport below also
runs the fit check: `.story-demo` equals the viewport, document scroll size equals the
viewport, and no visible stage, pane, open panel, device, phone or content box has
`scrollWidth` or `scrollHeight` beyond its client size, no element scrolls except the Resource
tree box (`.mobius-tree-scroll[data-scrollable="true"]`), nothing sits outside the viewport.

| Viewport | Captures | Assertions |
| --- | --- | --- |
| 1440 x 900 light | intro, system | Intro: only `.story-intro` and `.keyring-dock` visible, no panel visible, model width 200px or more, Tab reaches the confirm button with a 3px outline. A real click on the confirm hit center returns HTTP 200 from `/api/story/action`. System (Transaction, Resource tree, CSE records each fit): dock within 48px of the right and bottom edges, transparent, border 0, fixed, z-index 30, outside `.story-stage`, right of and disjoint from `.story-app-column` (`dock.left >= app.right`); Mobius left of the app; fresh node path equals the fresh record path and a trace path; `elementFromPoint` at the confirm center returns the confirm button; Mobius pane is English only and shows CSEBase, m2m:ae, m2m:cnt, m2m:cin, CREATE, RETRIEVE and RSC with no clipped text |
| 1440 x 900 dark | system | Mobius left of the app |
| 390 x 844 mobile, deep link | none | 44px targets, keyring model 104px wide or more, firmware CONFIRM after a press, wrapping full path in the node detail |
| 844 x 390 landscape | intro, system | All three panels and all seven scenes fit; keyring in the right track (`dock.left >= app.right`, `dock.left >= mobius.right`, within 48px of the right edge), model 104px or more; Mobius left of the app; bottom navigation within 16px of the bottom edge and clear of the keyring; no stepper in the top bar; no keyring tool chrome; every visible target 44px or more |
| 390 x 844 portrait | intro (rotate prompt), fallback system | Prompt and keyring visible, optimized-demo copy, focus on `Continue upright`, 44px button; fallback fits with all four panels and all seven scenes; deep link keeps stage and keyring inert under the dialog |
| iPhone portrait insets 47 / 34 | prompt | `--safe-top` 47, `--safe-bottom` 34, brand top 47 or more, continue button, keyring and bottom navigation bottoms at 810 or less |
| 844 x 390 landscape, session error | login | A 93-character English error banner and the login content both fit the phone pane with no overflow, the banner sits above the content without overlap, Reconnect is 44 x 44 or more |
| iPhone landscape insets 47 left and right, 21 bottom | system | brand, Mobius, keyring and navigation left edges 47 or more; app and navigation right edges 797 or less; keyring and navigation bottoms 369 or less |
| 812 x 375 installed web app, DPR 3, insets 44 / 44 / 21, `data-display-mode="standalone"` (acceptance; capture by function via display-mode emulation or `navigator.standalone`) | intro, system, all seven scenes with and without the 93-character banner, check-in after a keyring PANIC on all three tabs | document 812 x 375; every visible stage, pane, open panel, device, phone, content box and switcher segment at scroll size = client size; keyring 172px or wider with both buttons and the OLED visible; Mobius 300px, segments 90 x 44 or larger with complete labels; keyring clear of Mobius, app, brand, flags and navigation; no `.story-fullscreen-launch` or visible `.story-fullscreen-guide`; every control 44px and inside the insets |
| 812 x 265 Safari tab with an iPhone user agent (acceptance) | intro: guide open, then dismissed | guide inside the insets with scroll size = client size, three steps visible, `Continue in Safari` 44px, focused and topmost; stage, top bar, intro and keyring inert while open; after dismissal the launch control 44px, inside the insets, topmost, clear of keyring and flags; portrait shows only the rotate prompt |
| 812 x 265 iPhone mini landscape, DPR 3, insets 44 / 44 / 21 (acceptance; capture assertions to be added by function) | system, all seven scenes, with and without the 93-character banner; check-in after a keyring PANIC on all three tabs | document 812 x 265; every visible stage, pane, open panel, device, phone, content box and switcher segment at scroll size = client size; keyring (148px) clear of Mobius, app and controls; flags and scene navigation 44px; every control inside the insets |
| 844 x 320 and 1000 x 327 shallow landscape (acceptance; capture assertions to be added by function) | system, all seven scenes, with and without the error banner | every visible stage, pane, open panel, device, phone and content box at scroll size = client size; keyring clear of the Mobius head, switcher, open panel, app pane, brand, language and scene navigation; check-in after a keyring PANIC fits the Transaction receipt |
| 1440 x 900, reduced motion | system | No running animations on the dock after the transition |
| 1440 x 900 interaction | system | Drag rotates the model; no keyring tool chrome; confirm and panic presses return Mobius receipts and panic opens check-in |
| 1440 x 900 Resource tree | system | `.mobius-tree-scroll` has scroll height beyond client height, no `.mobius-tree-pager`, the fresh node inside the box, and a real mouse wheel over the box changes `scrollTop` |
| System proof: 1440 x 900, 812 x 265 Safari, 812 x 375 installed app | `story-finale-desktop`, `story-finale-iphone13mini-landscape`, `story-finale-iphone13mini-fullscreen` | Scene seven's next control carries `data-special` and opens `#/story/finale` with `data-finale="true"`; three `[data-proof]` steps, `CREATE RSC 2001`, `RETRIEVE RSC 2000` and the browser-session / purpose / scope / expiry line; previous `#/story/check-in`, next `#/story/login`; the receipt and the viewport pass the fit check. Design acceptance (scratch QA, all eight layouts): action labels on one line where the row allows, every control 44px or more, keyring and flags clear of the receipt and actions |

| Approved map (S8): 812 x 265 Safari, 812 x 375 installed app, 390 x 844 capture | `story-location-iphone13mini-landscape`, `story-location-iphone13mini-fullscreen`, `story-location-landscape` | Two real clicks (`Prepare location share`, `Review and share for 5 min`) open `[data-location-shared="true"]`; `data-location-ready="true"`, one keyring marker, countdown 4:xx or 5:00, canvas inside the phone and at least 72 / 112 / 100px tall; the viewport passes the fit check. Design acceptance (scratch QA): live chip, pin, attribution and caption on disjoint boxes; nothing in the map below 11px; Call and the flags 8px apart |
| Scene guide (S9): desktop intro and Mobius scene, 844 x 390, 390 x 844, 812 x 265 and 812 x 375 intro, location preparation, review, approved map and System proof | (in the captures above) | Root and tip name the same target; the tip is visible, inside the safe area, at scroll size = client size, `pointer-events: none`, contains `Next action`; the target is visible, highlighted (halo, sheet, aura or ring) and answers `elementFromPoint` at its center; the viewport passes the fit check with `.story-coach` among the measured boxes |
| Readable layout: 844 x 320, 1000 x 327, 812 x 265 and 812 x 375, every scene | (in the scene loops above) | Every visible text line of the app, Mobius, scene navigation, flags and tip lies inside its own box and answers `elementFromPoint` (no covered text); the flags and the scene navigation overlap no app content block; the tip overlaps neither the Mobius tabs, the open panel nor the app column. Design acceptance (scratch QA, all eight layouts, English and Korean): the same with the reviewed location draft and the approved map, flags at the top-right slot of each layout, every control 44 x 44 or larger |
| Resource tree axis: 812 x 265 and 812 x 375 | (tree pages above) | `data-scroll-axis="vertical"`, `overflow-x` hidden, `overflow-y` auto, `touch-action: pan-y`, `scrollLeft` 0 after a sideways attempt, scroll width equals client width |
| Operator map, 1440 x 900 | `operator-map-mobius-desktop` | `.operator-mobius-browser` beside `.operator-workspace` (`workspace.right <= browser.left`), `data-source="replay"` with `Replay data`, English only, Mobius Resource Browser / Resource tree / applicationEntity / flexContainer / group / RSC 2000 present, vertical-only tree (`overflow-x` hidden, pan-y, `scrollLeft` 0), node rows 44px or taller; the AE record opens in Resource record |

The seven `?capture=1` app screens (390 x 844) keep the full app design: status bar, 56px
header, 28px titles, home indicator.

## 12. Operator Mobius Resource Browser (`aside.operator-mobius-browser`, every `#/operator/*` page)

A read-only oneM2M inspector beside the operator's work. It is English only, like the story's
Mobius pane, and it never writes: `GET only, operator AE scope` closes the card.

```
 1440 x 900                                                  workspace 714 | browser 374
 +---------------------------------------------+  +-------------------------------+
 | Location map (34px)                         |  | oneM2M operator read      (r) |  13px muted, 44px refresh
 | (o) Connected  Replaying ...  [Simulated]   |  | Mobius Resource Browser       |  17px/700
 | +-----------------------------------------+ |  | (o) Replay data  RSC 2000  5 resources |  source word first
 | | Location monitoring        [Show all](r)| |  | [ Resource tree | Resource record ]   |  44px segments
 | |                                         | |  |-------------------------------|
 | |          map, full card width           | |  | . Mobius            CSEBase 5 |  44px rows, mono names
 | |          670 x 560                      | |  | . privacy-bubble-group      9 |  wrap inside the row
 | |                                         | |  | | keyringB (selected)      28 |  3px accent bar
 | +-----------------------------------------+ |  |-------------------------------|
 | | Keyrings (list) | Selected keyring      | |  | /Mobius   GET only, operator AE scope |
 +---------------------------------------------+  +-------------------------------+
```

- Placement: `.operator-live-layout` puts the workspace and the browser side by side
  (`minmax(0, 1fr) clamp(320px, 26vw, 380px)`, 24px gap; 320px from 1320px down). The browser is
  sticky 20px from the top and at most the viewport tall. At 1068px and narrower it becomes a
  full-width bottom panel after the work, and its tree or record box takes its content height up
  to min(420px, 56dvh) (min(380px, 52dvh) at 760px and narrower).
- Honest source: the status row starts with the source word in its color, `Live Mobius CSE`
  (success) when `data-source="live"` and `Replay data` (warning) when `data-source="replay"`,
  then the discovery RSC in mono and the resource count.
- Card: one surface with a 1px hairline and the card radius, no shadow. Header: `oneM2M operator
  read` at 13px muted in its own casing (no uppercase transform, so oneM2M keeps its spelling),
  the 17px/700 title, a quiet 44px refresh icon. Tabs: the story's segmented control (2px track,
  44px segments, light thumb).
- Resource tree: the one inner scroller; vertical axis only (`data-scroll-axis="vertical"`,
  `overflow-x: hidden`, `touch-action: pan-y`, `scrollLeft` pinned at 0). Rows are 44px or taller:
  a 7px dot, the resource name (12px/600 mono) over its oneM2M type (12px), the `ty` code at the
  right; names wrap inside the row instead of truncating. The selected row carries
  `--accent-soft` and a 3px accent bar on the leading edge; depth indents 13px per level (TSX).
- Resource record: the selected path (12px/600 mono, breaks anywhere), then one key / value
  table: keys in mono accent at their natural width, values in mono ink, hairline rows. The
  global `dl` two-column grid used to split keys such as `resourceUri` into fragments; the record
  table now owns its own columns.
- Workspace: a size container (`container: operator-workspace`), so the map card lays out by the
  width it really has: at 1000px or less of workspace the keyring list and the detail move under
  the map (two columns), at 620px or less into one column. The status strip keeps its source
  badge on the first line and balances its sentence.
- Measured (scratch review, replay): 1440 x 900 workspace 714, browser 374 x 442 at x 1026,
  map canvas 670 x 560; 1200 x 800 browser 320, canvas 488 x 560; 1024 x 768 bottom panel 760 wide;
  390 x 844 bottom panel 358 wide. The document scrolls on operator pages; the browser keeps zero
  horizontal scroll.
