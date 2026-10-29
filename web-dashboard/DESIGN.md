# Privacy Bubble operations dashboard

ROLE: WEB-DASHBOARD. DOC-REV: 2.0.0.

## 1. Intent and priorities

A restrained, read-only Korean operations screen. First inspect a command's
actual receipt stages; then find its device; finally inspect audit and evidence.
The primary action is **다시 연결 / 새로고침**. It resumes the stream and refreshes
the currently selected resource source. No device command or approval action exists.

Required content: four command timestamps, per-member ACK/readback and pending
stages, sequence/source/revision metadata, connection/offline/errors, resource
tree, device state, operator settings, searchable simulated audit, simulated
MEC/handover/FL/model-lineage/MCP shells, approvalHash, evidence links and
explicitly pending video/public discussion.

## 2. Design-system inspection

The repository contained no CSS, JSX/TSX components, tokens or DESIGN.md at
inspection. There are therefore no five existing UI components to imitate.
The existing React/Vite scaffold and shared contracts supply composition and
data conventions, not visual conventions. This document and `src/styles.css`
establish the minimal system before screen components.

References: local frontend layout and design-system architecture guidance;
TypeScript strict-language guidance; `docs/primary-sources.md`; shared contract.
No new packages, remote fonts, mood-board assets or decorative charts.
The explicit bounded implementation and parent-owned browser gate take priority
over generic skill suggestions to install tooling or run broad audits.

## 3. Color and typography

All component colors use semantic CSS variables. Light/dark values:

| Token | Light | Dark |
| --- | --- | --- |
| background | #f4f5f2 | #131916 |
| surface | #ffffff | #1b231f |
| subtle | #edf0eb | #242e28 |
| text | #202d26 | #e7eee9 |
| muted | #53645a | #b2c0b7 |
| border | #cbd5cd | #44564a |
| accent | #205c42 | #a3d8b9 |
| accent-hover | #16462f | #c0e7cf |
| on-accent | #ffffff | #12271b |
| success | #246040 | #a5dbb8 |
| warning | #79520d | #ebcb83 |
| danger | #a03135 | #ffb5b7 |
| info | #315f7b | #acd4eb |

Font: `"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui`.
No network font dependency. Monospace identifiers use `ui-monospace`.
Sizes: h1 2rem, h2 1.5rem, h3 1.125rem, h4/body 1rem,
small .875rem, caption .75rem. Body line-height 1.6; heading 1.25.
Weights 400/600/700. No oversized marketing headings.

## 4. Spacing and layout

Tokens use a 4px base: .25, .5, .75, 1, 1.5, 2, 3rem.
Radius: .5rem; borders: 1px; focus: 3px with 3px offset.
Minimum control target: 2.75rem (44px). Sidebar: 14rem.
Content maximum: 90rem; breakpoint: 52rem.

Layout: dashboard - persistent navigation beside receipt detail -> sidebar +
stack, following the local layout reference; scroll owner: document; avoid
nested vertical scroll panels and fixed content heights. At <=52rem navigation
becomes a wrapping horizontal row. Stages use a two-column grid on phones and
four columns on desktop. Resource list/detail collapses to one column.
Long resource paths and hashes wrap; raw JSON alone owns horizontal overflow.

## 5. Primitives and composition

`Section` owns numbered section headings and region labels. `Badge` conveys a
real status with text, never color alone. `StageTime` renders a real timestamp
or explicitly pending evidence. Standard buttons/labels/inputs share tokenized
sizes, borders, hover, focus and disabled states. Data comparisons use tables,
definition lists and ordered stages, not decorative cards.

Command stage order: 수락, 전송, 적용, 확인. UTC timestamps are preserved with
milliseconds; duration is unknown when evidence is absent. ACK observation is
not proof of success. `false` readback is displayed as OFF, not as missing.

## 6. States and provenance

- Default resources and audit come from the mock HTTP API, not bundled success
  fallbacks. Commands are exclusively driven by validated `/events` messages.
- Every replay/audit/resource fixture and unintegrated service shell says 모의.
- Live discovery has separate loading/empty/error states, keeps namespaced JSON,
  and never silently substitutes fixture data on failure.
- Browser offline preserves prior receipts with stale/offline wording.
- Reconnect retains reducer state/cursor. Explicit replay reset clears state
  and resumes at zero. Invalid messages halt ingestion without advancing.
- AE/ACP labels are operator context, not authorization. Settings live only in
  React memory; no credentials, secrets, localStorage or VITE environment values.

## 7. Accessibility and motion

Native navigation links, explicit field labels, visible focus, skip link and
text-based status. Live connection announcements are polite; errors use alerts.
No animation or decorative motion. Light/dark follows `prefers-color-scheme`.
No icon-only actions. Keyboard follows DOM/visual reading order.

## 8. Verification and accepted limits

Owned checks: TypeScript diagnostics and `npm run build`. Parent owns real
browser acceptance at 390px and 1440px in light/dark, using its running SSE
server. No screenshot or accessibility pass is claimed by this document.
Real Mobius reachability, AE/ACP, CORS, RVI, SDT registration, auth and service
integrations remain unconfirmed. Evidence links are repository artifacts;
pending video and public discussion have no invented URLs.
