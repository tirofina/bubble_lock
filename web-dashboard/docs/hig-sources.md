# HIG presentation decisions

ROLE: WEB-DASHBOARD. DOC-REV 2.0.0. Retrieved 2026-10-29.

Primary Apple Human Interface Guidelines pages (their `.md` representations
returned HTTP 200 during this lane):

| Source | Applied to this web dashboard |
| --- | --- |
| [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) | Leading information hierarchy, aligned groups, responsive layout, safe-area insets. |
| [Typography](https://developer.apple.com/design/human-interface-guidelines/typography) | System font stack, weight/size hierarchy, readable compact body and secondary text. Native iOS 17pt is a platform default, not a universal web minimum; this dashboard uses 17 CSS px body and 15 CSS px secondary at compact widths. |
| [Color](https://developer.apple.com/design/human-interface-guidelines/color) | Semantic tokens; text accompanies every status color. Selected resources include a visible selection label. |
| [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode) | Respect system appearance without a duplicate theme setting; test both variants. |
| [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | WCAG AA text contrast, 200% text enlargement, visible keyboard focus and explicit labels. |
| [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | At least 44x44 CSS px target, press feedback, one prominent refresh action. The accessibility page lists a smaller platform minimum; this brief deliberately adopts the stricter general button recommendation. |

## Time display

Default to Korea standard time, explicitly labeled `KST`, with `UTC+09:00`
beside the timeline. This Korean-language operations screen is used by Korean
operators. Preserve the original RFC3339 instant, including its source offset,
in the `<time datetime>` and hover title. Retain milliseconds for receipt
comparison. Durations, sorting, receipt hashes and API values do not change.
KST is fixed UTC+09:00; adding nine hours before formatting UTC fields makes
the display independent of the browser's own timezone and handles date rollover.

## Scope

This applies HIG principles to a responsive web operations tool, not native
Apple window chrome or Liquid Glass. Keep read-only behavior, mock labels,
all required data, endpoint contracts and repository tests. Do not add
decorative effects, UI packages or extra dev tooling for this correction.
