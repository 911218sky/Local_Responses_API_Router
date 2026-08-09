# Codex Router Dashboard Design System

## 1. Brief

The Dashboard is a dense local operations console for managing LLM providers,
traffic, and privacy settings. It uses a calm operational style: warm paper in
light mode, charcoal in dark mode, thin graphite boundaries, soft layered
elevation, and a yellow-green status accent. Tactile feedback is reserved for
primary actions and icon controls so the dense data views remain easy to scan.

## 2. Users And Tasks

- Operators check whether the router is running and inspect active requests.
- Operators add or edit providers, then copy the local route.
- Operators review sessions only when detailed logging is enabled.
- Administrators change service behavior and Dashboard credentials.

## 3. Tokens

### Color

| Token | Value | Use |
| --- | --- | --- |
| `--color-page` | `#fdfbf7` | Application background |
| `--color-surface` | `#ffffff` | Main panels and headers |
| `--color-panel` | `#faebd7` | Secondary framed surfaces |
| `--color-input` | `#eff3f8` | Inputs and code areas |
| `--color-ink` | `#1a1a1a` | Text |
| `--color-border` | `#1a1a1a` | Light-mode boundaries |
| `--color-muted` | `#4a4a4a` | Supporting copy |
| `--color-primary` | `#ffcf7a` | Primary actions |
| `--color-success` | `#a8f0c6` | Running and healthy states |
| `--color-danger` | `#ffb4b4` | Errors and destructive actions |
| `--color-warning` | `#ffe9a8` | Warnings and retry states |
| `--color-diff-added` | `#e4f5e7` | Added request fields in the session diff |
| `--color-diff-added-border` | `#87b98d` | Added diff marker boundary |
| `--color-diff-added-ink` | `#235b2d` | Added diff text |
| `--color-diff-removed` | `#f9e6e4` | Removed request fields in the session diff |
| `--color-diff-removed-border` | `#d4a09b` | Removed diff marker boundary |
| `--color-diff-removed-ink` | `#7e2f2b` | Removed diff text |
| `--color-diff-unchanged` | `#eff3f8` | Unchanged request fields in the session diff |
| `--color-on-primary` | `#1a1a1a` | Text on primary controls |
| `--color-on-primary-muted` | `#5a4822` | Supporting text on primary controls |
| `--color-on-success` | `#163b29` | Text on success states |
| `--color-on-danger` | `#5d1717` | Text on danger states |
| `--color-on-warning` | `#4e3b00` | Text on warning states |
| `--color-shadow` | `rgba(26, 26, 26, 0.14)` | Soft panel elevation |

Dark mode uses `#151719` for the page, `#1d2022` for surfaces, `#282d30` for
secondary panels, `#e8ebe5` for text, and `#4f595c` for neutral boundaries.
Primary, success, warning, and danger fills use separate dark-mode ramps with
matching `--color-on-*` foreground tokens, so semantic controls remain legible
without bright neon fills. Control and panel shadows use a translucent black
token so dark surfaces do not acquire bright outlines.

### Type And Space

- Font stack: `Noto Sans TC`, `Noto Sans SC`, `Inter`, `Segoe UI`, system sans-serif.
  The local Traditional and Simplified Chinese font subsets keep interface
  labels readable when a host does not provide a CJK system font.
- Display: 24px / 700; section heading: 16px / 700; body: 14px / 1.45.
- Spacing unit: 4px. Layout gaps use 8px, 12px, 16px, 20px, 24px, or 32px.
- Border: 2px for controls and 3px for primary framed surfaces.
- Radius: 6px for controls, 8px for panels, and 14px for dialog containers.
- Elevation: `var(--shadow-control)` for controls and
  `0 10px 22px var(--color-shadow)` for panels.

## 4. Layout And Responsive Behavior

- Desktop uses a fixed 224px navigation rail and a single scrollable main area.
- The traffic workspace owns its own internal scroll regions on desktop.
- At 1120px, metric and settings grids collapse to two or one columns.
- At 680px, navigation becomes a horizontal rail and all workspace columns
  stack, preserving readable 44px minimum touch targets.

## 5. Reusable Primitives

- `surface`: quiet panel with a 3px boundary, 8px radius, and soft shadow.
- `button`: compact 2px control; primary is yellow, successful is green, danger
  is red. Hover lifts contrast; active moves 1px for tactile feedback.
- `status` and `badge`: compact framed semantic state labels.
- `input`: blue-gray field with an ink border and visible focus outline.
- `toggle`: framed track with a clear ink thumb and green checked state.
- `dialog`: high-elevation surface with an opaque ink backdrop.
- `split-diff`: equal-width request columns with sticky headings; removed values
  use the red ramp, added values use the green ramp, and unchanged rows stay
  visually quiet. Payload cells render only after the request detail is opened.

## 6. Accessibility Constraints

- All interaction states retain a 3:1 or stronger contrast boundary.
- Keyboard focus uses a visible 2px ink outline plus a 3px offset.
- Status is conveyed by text and color.
- Motion is limited to opacity and transform and is disabled for reduced motion.
- Small icon controls keep a 32px visual frame and 44px pointer target through
  surrounding spacing where feasible.

## 7. Localization

- All operational labels are available in Traditional Chinese, Simplified
  Chinese, and English.
- The persistent topbar owns the active page title. Page bodies do not repeat
  that title and use descriptive subsection labels where needed.
