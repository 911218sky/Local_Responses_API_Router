# Codex Router Dashboard Design System

## 1. Atmosphere & Identity

The dashboard is a compact local operations console: direct, tactile, and easy to scan. Thick outlines and small offset shadows give controls a physical affordance, while the light palette stays soft and the dark palette uses muted green accents. The signature is the shared warm-green status language across both themes.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|-------|-------|
| Page | `--color-page` | `#f3f6f2` | `#151719` | Application background |
| Surface | `--color-surface` | `#fbfcfa` | `#1d2022` | Sidebar, cards, dialogs |
| Panel | `--color-panel` | `#e7eee8` | `#282d30` | Table headers and list rows |
| Input | `--color-input` | `#eef3ef` | `#262b2e` | Inputs and code labels |
| Ink | `--color-ink` | `#28302c` | `#e8ebe5` | Primary text and outlines |
| Muted | `--color-muted` | `#66716b` | `#aeb5b2` | Supporting text |
| Primary | `--color-primary` | `#f5ca7c` | `#9db85c` | Main actions and active nav |
| Success | `--color-success` | `#b8e8c8` | `#4d896a` | Running/enabled states |
| Danger | `--color-danger` | `#f3bcbc` | `#98575d` | Destructive actions and errors |
| Shadow | `--color-shadow` | `rgba(40, 48, 44, 0.16)` | `rgba(0, 0, 0, 0.45)` | Surface depth |

### Rules

- Keep status colors semantic and use the primary accent only for action emphasis.
- Light surfaces use a cool green-gray ramp so the black-heavy dark theme does not become a black-heavy light theme.
- Borders remain visible for scanability, but light-mode borders and shadows use softened ink tokens.

## 3. Typography

### Scale

| Level | Size | Weight | Usage |
|-------|------|--------|-------|
| Page title | 24px | 700 | Topbar heading |
| Section title | 16px | 700 | Panel and section headings |
| Body | 14px | 400 | Default interface text |
| Supporting | 12px | 400-700 | Hints, labels, metadata |
| Mono | 12-14px | 400 | URLs, route identifiers, payloads |

### Font Stack

- Primary: `Noto Sans TC`, `Noto Sans SC`, `Segoe UI`, system sans-serif
- Mono: `ui-monospace`, `SFMono-Regular`, `Consolas`, monospace

## 4. Spacing & Layout

- Base unit: 4px.
- Shell: 224px sticky sidebar on desktop; stacked navigation below 680px.
- Page content: max 1640px, 30px desktop gutters, 18px mobile gutters.
- Control radius: 6px. Panel radius: 8px.
- Physical depth: 3px control shadow and 7px panel shadow.

## 5. Components

### Navigation item

- Structure: icon, label, optional provider count.
- States: transparent default, outlined accent hover/active, visible keyboard focus.
- Accessibility: native button with an active visual state and navigation label.

### Action button

- Structure: optional Lucide icon plus label; icon-only variants require title and `aria-label`.
- States: default, hover, pressed, focus, disabled.
- Accessibility: native button, never emoji icons; copy actions expose success through label and live status.

### Surface and table row

- Structure: bordered surface containing responsive grid rows.
- States: default, empty, error, and horizontal overflow for dense provider data on narrow screens.
- Layout: table owns horizontal scrolling below its minimum readable width.

### Dialog form

- Structure: native dialog with labelled controls and action cluster.
- States: open, closed, validation error, saving/disabled.
- Accessibility: native dialog semantics, labelled fields, inline alert for errors.

## 6. Motion & Interaction

- Button and toggle transitions use 120ms ease-out transforms/colors.
- Press feedback is a small physical offset; no layout properties are animated.
- `prefers-reduced-motion: reduce` collapses transitions to near-zero duration.

## 7. Accessibility & Content

- Keep body text at or above 14px except metadata and icon tooltips.
- Every icon-only control has a localized title and `aria-label`.
- Focus rings use the ink token with a 3px offset.
- Copy feedback is announced through an `aria-live` status region.

## 8. Accepted Debt

- The dense provider table intentionally keeps a 920px minimum width and scrolls horizontally on small screens so URL, status, and action columns remain readable.
