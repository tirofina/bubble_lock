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
design decision on `#/story/*` cites a section here (P1 to P12, S1 to S7). `DESIGN.md`
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
| P12 | One viewport | `.story-demo` fills exactly 100vw x 100dvh. The document and every pane have zero scroll in both axes; long content pages (segmented panels, tree and record pagers) instead of scrolling. Safe-area insets keep every control clear of the notch, Dynamic Island, sensor housing and home indicator. | HIG Layout, WCAG 1.4.10 |

Sources: https://developer.apple.com/design/human-interface-guidelines/layout ,
https://developer.apple.com/design/human-interface-guidelines/typography ,
https://developer.apple.com/design/human-interface-guidelines/color ,
https://developer.apple.com/design/human-interface-guidelines/dark-mode ,
https://developer.apple.com/design/human-interface-guidelines/accessibility ,
https://developer.apple.com/design/human-interface-guidelines/buttons (retrieved 2026-10-29, see
`docs/hig-sources.md`), https://developer.apple.com/design/human-interface-guidelines/motion
(added for P6 and P7), https://developer.apple.com/design/human-interface-guidelines/segmented-controls
(panel switcher), https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html ,
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
| `--segment-track` / `--segment-thumb` | `--surface-strong` / `--surface`; dark: `rgb(118 118 128 / .24)` / `#636366` | Panel switcher, pager hover |
| `--flag` (per language button) | inline SVG: Taegukgi for `lang="ko"`, the US flag for `lang="en"` | Language control: 22 x 15px flag in a 44px button |
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
| Phone landscape, 301 to 340px tall | up to 112px (shrinks to fit the rail) | Right control rail between language and scene navigation; 844 x 320: x 725, y 104, 110 x 146; 1000 x 327: x 880, y 109 | 1.7 | 190px |
| Portrait below 1024px | 112px | 12px from right, 4px from bottom (or the home-indicator inset); 390 x 844: x 266, y 692 | 2.05 | 230px |
| Phone portrait, 700px tall or less / 600px or less | 112px | same | 1.8 / 1.4 | 202 / 157px |

The compact width of 112px keeps the projected model at 104px or more after the default
tilt, so the LCD and both physical buttons stay legible on phones.

## 3. Spatial model

```
 desktop (1024px and wider)
 +------------------------------------------------------------------------------+
 | (B) BubbleLock                                           Family dashboard     |  56 + safe top
 +------------------------------------------------------------------------------+
 |      Mobius Resource Browser   [Replay] |   +-------------+   |  gutter     |
 |      [Transaction|Resource tree|Records]|   | 4:31        |   |  (reserved  |
 |      Latest oneM2M transaction          |   | Privacy     |   |   for the   |
 |      Resident confirmation stored       |   | Bubble      |   |   keyring)  |
 |       o BFF request  POST /api/...      |   |             |   |             |
 |       o CREATE <contentInstance> ../e-2 |   |             |   |  [keyring]  |
 |       o RETRIEVE <contentInstance>      |   +-------------+   |             |
 +------------------------------------------------------------------------------+
 | [KR][US]                <   2/7 Went out   >                                 |  44 + safe bottom
 +------------------------------------------------------------------------------+
```

The stage pads its right edge by the keyring reserve (`dock-right + dock-kw + gutter`) or by
half of the space beyond the 1040px content width, whichever is larger. The fixed keyring
therefore lives in its own gutter beside the phone and never overlaps the app or a control
(P8, P12). `--dock-left` is derived (`100vw - dock-right - dock-kw`), so the S2 travel keeps
one formula for every layout.

## 4. S1 Intro stage (`data-stage="intro"`)

- Full canvas, no cards, no rail, no panels. The top bar shows only the brand and the flags
  sit at the bottom-left; the dashboard link and the bottom navigation wait for the system
  stage (P1).
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
- Language: two small flags at the bottom-left of the screen (Taegukgi for 한국어, the US flag
  for English), each a 22 x 15px flag with a hairline edge centered in a 44px button. The
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
  3. Panel: Transaction is the hero (S4). Resource tree pages three rows at a time (below
     1024px each row is two lines: dot and name, then type and RSC flowing together) with a
     `< 1/4 >` pager and a quiet `Sync`; the count line ("10 resources") sits left of the pager.
     The node detail under the rows shows the type, the RETRIEVE result, the full path and
     `Copy full path`. CSE records page one record at a time.
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
  selected state. The tree pages to the node and selects it (P8).
- The trace hero is a polite live region: screen readers hear the record label and RSC once.

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
| Mobius Resource Browser [Replay] | Privacy Bubble      |            |
| [Transaction | Resource tree | CSE records]             |            |
| Resident confirmation stored 1:51 PM | Today          |            |
|  v BFF request  POST /api/story/action  | Activity    |  [keyring] |
|  v CREATE  e-2 CREATE RSC 2001 ...  |                 |            |
|  v RETRIEVE ...                     |                 |            |
+--------------------------------------------------------------------+
| (B) [KR][US]       <   2/7 Went out   >                             |  44 + safe bottom
+--------------------------------------------------------------------+
        Mobius 1fr                        app 40%        112px track
```

- The top bar folds into one bottom bar: brand and flags left, scene navigation centered.
  The content keeps the full height above it (P12).
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
| Mobius     | [Transaction|Tree|Records] | Privacy Bubble       |  (B)    |
| Resource   | Keyring emergency alert    | Check on Mom         |         |
| Browser    |  v BFF request POST ...    | [emergency card]     |         |
| [Replay]   |  v CREATE e-11 RSC 2001 .. | [Call] [Prepare ..]  | keyring |
| Session .. |  v RETRIEVE e-11 RSC 2000  |                      |         |
| (notice)   | The reason is stored ...   | (footnote)           | 7/7 ... |
| [KR][US]   |                            |                      |  <   >  |
+-------------------------------------------------------------------------+
  104px rail       Mobius content           app 40%, min 270px   112px rail
```

- No bottom bar: the content uses the full height. A right control rail (112px, root grid
  column) stacks the brand, the keyring and the scene navigation (12px label over two 44px
  chevrons) from top to bottom; the flags sit at the bottom-left under the Mobius identity
  rail. The keyring width is `min(112px, (height - rail navigation - brand - gaps) / 1.3247)`,
  so it never touches the controls above or below it, including under a bottom inset.
- A left Mobius identity rail (104px) keeps the title (13px/700), the badge, the session meta
  and, while it shows, the CSE notice; the switcher and the active panel use the column to its
  right. Every panel is a complete page: no inner scroll and nothing to drag.
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
| Mobius Resource Browser [Live]   | Check on Mom              |   [keyring      |
| Session D58CB3, 38 of 40 ...     | [emergency card]          |    148 x 196,   |
| [Transaction|Resource tree|CSE]  | [Call] [Prepare location] |    OLED and     |
| Keyring emergency alert  4:31 PM |                           |    buttons      |
|  v BFF request POST ... panic    |                           |    readable]    |
|  v CREATE <contentInstance>      |                           |                 |
|    e-11 CREATE RSC 2001          | [KR][US]  (footnote,      |  <  7/7      >  |
|    e-12 CREATE RSC 2001          |           3 lines)        |     Check-in    |
|  v RETRIEVE ... RSC 2000 x 2     |                           |                 |
+--------------------------------------------------------------------------------+
   Mobius 300px                      app 258px                   rail 150px
```

- Usable box 724 x 244 (812 x 265 minus 44 / 44 / 21). Columns: Mobius `minmax(0, 1fr)` (300px),
  app 258px, rail 150px, gaps 8px + 8px.
- Rail: the keyring at up to 148px (`min(148px, (height - bottom inset - 44px nav - gaps) /
  1.3247)`, 148 x 196 at 812 x 265, top 2px) and the scene navigation under it (two 44px
  chevrons with an 11px label that wraps to two lines between them). The brand steps out.
- Flags: the Mobius column uses its full height for the tree and records pages, so the
  lowest-left free slot is the app pane's bottom-left, beside a three-line privacy footnote
  (x 359, y 195 at 812 x 265). On the intro they sit at the screen's bottom-left (x 44, y 200).
- Mobius: a two-line header (12px/700 title and an 11px status badge; 11px session line), the
  switcher (44px segments, 97px each, every label inside its segment) and one page. Transaction
  is one compact receipt: BFF request with its code on one line; CREATE and RETRIEVE
  `<contentInstance>` each with one line per record (resource name, method, RSC); the scene
  sentence stays in the accessibility tree. Resource tree: three 3-line rows with depth indents
  of 6px per level, the pager and Sync stacked in a 52px column on the right, the full path
  underneath (breaks anywhere, two lines); this page uses the header's height, and the app
  banner carries any CSE notice. CSE records: the record, then the CSE root beside its pager.
- App: no title bar at this size (the pane is the app), 15px screen title, 11-13px card text,
  44px actions, inline form labels (62px) on the login screen, 44px footnote row.
- Session error at this size: the app banner (11px text, 44px Reconnect) stands in for the
  screen title and the footnote, and the flags yield while it shows; the scene name stays in
  the rail. The Mobius notice (11px, one 13px line) stands in for the session line.
- Budget (measured at DPR 3 with insets 44 / 44 / 21, every visible stage, pane, open panel,
  device, phone, content box and switcher segment at scroll size = client size): app content
  236px in every scene (169px under the 93-character banner); Mobius page 163px. Tightest:
  check-in after a keyring PANIC with two public-length records keeps 9px under the receipt
  (2px with the CSE notice), the tree page 4px, care-request under the banner 1px.

### Installed web app on iPhone mini (Home Screen launch, 812 x 375, insets 44 / 44 / 21)

The Home Screen launch removes Safari's bars (manifest `display: fullscreen`, fallback
`standalone`; `apple-mobile-web-app-capable`, `black-translucent` status bar). StoryDemo marks it
with `.story-demo[data-display-mode="standalone"]` (display-mode standalone or fullscreen, or
`navigator.standalone`). The tier applies to phone landscape up to 440px tall.

```
+---------------------------------------------------------------------------------+
| Mobius Resource Browser [Live]   | Privacy Bubble        |         (B)          |
| Session CB0801, 38 of 40 ...     | Check on Mom          |                      |
| [Transaction|Resource tree|CSE]  | [emergency card]      |   [keyring 176 x 233 |
| Keyring emergency alert  5:21 PM | [Call] [Prepare ...]  |    OLED 67 x 38,     |
|  v BFF request POST ... panic    |                       |    both buttons      |
|  v CREATE e-11, e-12 RSC 2001    |                       |    readable]         |
|  v RETRIEVE e-11, e-12 RSC 2000  |                       |                      |
| The reason is stored first ...   | (footnote)            |  <  7/7 Check-in  >  |
| [KR][US]                         |                       |                      |
+---------------------------------------------------------------------------------+
   Mobius 300px                      app 232px               rail 176px
```

- Usable box 724 x 354. Root grid: stage (Mobius 300px | app 232px, 8px gap) and a 176px rail
  column, 8px gap; the right inset is the root's right padding.
- Rail: the brand at the top (44px), the keyring as the fixed overlay (width
  `min(176px, (height - bottom inset - 44px nav - brand - gaps) / 1.3247)`, 176 x 233 at
  x 592, y 73; OLED 67 x 38 CSS px, 200 x 113 physical px), the scene navigation at the bottom
  (two 44px chevrons, 12px label). No grid cell or card frames the keyring.
- Flags: the screen's bottom-left (x 44, y 310), in a 48px strip the Mobius column reserves.
- Mobius: two-line header (13px title, 11px badge; 11px session line), 97 x 44 segments, one
  page: the compact receipt with its scene sentence visible, the tree with its pager and Sync
  stacked beside the rows, the records page with the pager beside the CSE root. A CSE notice
  stands in for the session line.
- App: the 36px title bar stays; landscape compact type with 13px card titles and actions.
- No Safari path: `.story-fullscreen-launch` and `.story-fullscreen-guide` do not render (TSX)
  and the CSS hides them under `data-display-mode="standalone"`.
- Status bar: landscape has no top inset. A portrait Home Screen launch paints a black band of
  `--safe-top` behind the black-translucent status bar so its white text stays readable.
- Budget (measured at DPR 3, `navigator.standalone`, insets 44 / 44 / 21): every scene, with
  and without the 93-character banner, at scroll size = client size; check-in after a keyring
  PANIC keeps 16px under the receipt (20px with the CSE notice), the tree page 26px, the
  records page 67px.

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
| (B)                          |  44 + safe top
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
| [KR][US] < 2/7 >     |_____| |  flags and scene navigation under the switcher
+------------------------------+
```

- App pane on top (44% of the stage), Mobius sheet below on `--surface` with a hairline top.
- Bottom deck: the switcher as a 2 x 2 segmented grid (`Transaction | Resource tree`,
  `CSE records | Scenes`) and the scene navigation under it on the left; the keyring (112px)
  bottom-right, 12px from the right edge. The sheet surface continues under the home indicator. The panel above
  the deck spans the full width, so the keyring never covers a record (P8, P12).
- Scenes panel: seven scene links in two columns (44px rows, 13px/600, numbered 22px
  circles, current scene in accent) and a `Family dashboard` row.

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
| Panels page instead of scrolling (switcher plus `< n/m >` pagers) | Zero nested scroll keeps the one-viewport contract and the keyring position stable | P12 |
| Segmented controls share one light thumb token pair; dark mode uses the iOS gray thumb | A dark thumb on a dark track read as a hole | P5, P10 |
| Disabled pager chevrons are 40% muted glyphs without a fill | Filled grey circles looked like pressed buttons | P5 |
| A session error banner replaces the app title bar and the privacy footnote while it shows (below 1024px) | At 844 x 390 a 93-character message pushed login 88px past the pane; the title and footnote are the least specific lines on screen, and the scene keeps its own content | P2, P12 |
| Phone landscape app pane widened from 36% to 40%, 36px title bar, tighter cards | Under the iPhone insets care-request overflowed by 17px with no error; fewer wrapped lines fix every scene | P12 |
| Compact tree rows are two lines (name; type plus RSC) | With the Mobius error notice the iPhone-inset tree clipped 26px inside its pager page | P12 |
| Top bar hairline is an inset shadow | A border shrank the 44px controls by 1px and pushed the brand into the safe area | P3, P12 |
| Focus rings inside the Mobius pane are inset (`outline-offset: -3px`) | The pane clips overflow; an outside ring would be cut at the edges | P10 |
| Capture mode (`?capture=1`) ignores every compact app rule | The seven 390 x 844 evidence screens keep the full app design | P11 |
| The keyring moves to the bottom-right on every layout | The person's devices (phone, keyring) belong together; the right thumb reaches the keyring; the left side stays the record | P8 |
| Guidance halo becomes a large double halo (inner ring, travelling outline wave, button tint) | A 2px breathing ring at visual + 10px was easy to miss in the first second of the demo | P2, P5 |
| Shallow landscape (340px tall or less) drops the bottom bar for a right control rail and a left Mobius identity rail | In Safari with toolbars (1000 x 327) the bottom bar and title row left no room: the keyring covered the Mobius title and the check-in actions were cut | P12 |
| The language control becomes two small flags at the bottom-left (Taegukgi, US flag) | The user asked for flags at the bottom-left; the top-right slot belongs to identity and the dashboard link, and the bottom-left corner is free on every layout | P10 |
| The installed web app gets its own landscape tier: 176px keyring rail between brand and scene navigation, Mobius 300px, app 232px, flags in a Mobius bottom strip | The Home Screen launch frees 110px of height (375 vs 265): the keyring grows to 176px so the OLED and both buttons read at a glance, and every page keeps its header | P2, P9, P12 |
| Safari's bars are explained, not fought: a quiet Full screen control and a three-step sheet | WebKit lets only the Home Screen web app remove Safari's bars; a sheet with the exact steps is the honest path | P1, P11 |
| iPhone mini landscape (300px tall or less) gets its own tier: 148px keyring rail, two-line Mobius header, stacked tree pager, no app title bar | 812 x 265 in Safari left 244px of height: the 340px tier clipped the tabs, the receipt and the app actions, and the keyring shrank to about 70px | P2, P12 |
| The error banner rule applies on desktop too; short desktops (820px or less) use compact phone type and a 340px minimum phone width | 1440 x 900 login overflowed 50px with the banner; 1024 x 768 care-request overflowed 90px without it | P12 |

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
div.story-demo[data-stage][data-portrait][data-display-mode]   grid rows: top chrome, stage, bottom chrome
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
    aside.story-mobius[lang=en]                    StoryMobiusPanel
      header.story-mobius-head > div > h2 + p.story-mobius-meta, span.badge
      p.story-server-message (only after a failed request)
      nav.story-panel-tabs > button[aria-pressed][aria-controls=story-panel-*](.has-new-event)
        > span.story-panel-alert       (trace, tree, events on every layout; scenes in portrait)
      section#story-panel-trace.story-panel-card.story-trace(.is-mobile-open)[data-phase]
        div.story-trace-heading > div > p.story-trace-eyebrow + h2.story-trace-title, time.story-trace-time
        ol.story-trace-steps > li.story-trace-step[data-step=request|create|readback](.is-active)(.is-done)
          > span.story-trace-marker + div > strong + code
            (code.story-trace-path[data-trace-path] > span.story-trace-parent + b.story-trace-rn
             + span.story-trace-rsc)
        p.story-trace-summary
      section#story-panel-tree.story-panel-card.story-mobius-tree-card
        div.story-events-head, div.mobius-tree-view > div.mobius-tree-toolbar
          (p, div.mobius-tree-pager, button Sync), div.mobius-tree-scroll > ul.mobius-tree
          > li.mobius-tree-leaf > button(.selected)(.is-fresh)[data-path][data-fresh], div.mobius-node-detail
      section#story-panel-events.story-panel-card.story-mobius-events (li.is-new-event.is-fresh,
        div.story-events-pager, p.story-mobius-root)
      section#story-panel-scenes.story-panel-card.story-scene-panel (portrait only)
        nav > ol > li > a(.active), a.story-mobile-dashboard-link
    div.story-app-column > div.story-device > div.story-phone#story-app
  nav.story-stepper.story-bottom-nav                outside the header, after main
    a.story-stepper-prev, span.story-stepper-compact[aria-live=polite] ("2/7 Went out"), a.story-stepper-next
  div.keyring-dock[data-guided=confirm|panic|none]  fixed, outside main
    div.virtual-keyring > h3.story-sr + div.keyring-stage[role=application][tabindex=0]
      > div.keyring-model > span.keyring-depth, img, span.keyring-screen-live[data-firmware-screen],
        button.keyring-physical-button.confirm|.panic(.is-guided)(.pressed)
```

Behavior owned by function:

- Tree: the node whose path equals the newest record gets `.is-fresh` and `data-fresh`
  for 4000ms, becomes selected, and the tree pages to it (three rows per page).
- CSE records page one record at a time; the first record of a new action gets `.is-new-event`.
- Keyring pose: rotate only, rotateX within 32deg, rotateY within 58deg; no move and no reset.
- Existing contracts stay: browser-isolated session cookie, CSRF and Idempotency-Key on
  `/api/story/action`, scene auto-actions, care and location flows, `?capture=1` app shots.

## 11. Verification

`npm run capture:story` drives real CDP input against the built app and the replay CSE, and
records hashes in `evidence/story-screens/capture-manifest.json`. Every viewport below also
runs the fit check: `.story-demo` equals the viewport, document scroll size equals the
viewport, and no visible stage, pane, open panel, device, phone or content box has
`scrollWidth` or `scrollHeight` beyond its client size, no element scrolls, nothing sits
outside the viewport.

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

The seven `?capture=1` app screens (390 x 844) keep the full app design: status bar, 56px
header, 28px titles, home indicator.
