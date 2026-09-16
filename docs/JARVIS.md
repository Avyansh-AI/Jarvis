# Jarvis — HUD theme, widget layer & fork map

This document covers everything that makes this repository **Jarvis** rather
than **MAX AI**: the dark HUD theme tokens, the widget layer, the rebrand
rules applied, and the isolation guarantees between the two products.
It is *styling-and-branding documentation only* — no skill logic, security
rule, sandbox, or confirmation behavior differs from upstream v0.11.1.

## 1. Theme token map (`web/css/theme.css`)

Same CSS-variable/state-machine architecture as the Baymax theme, remapped:

| Token (new)            | Value       | Replaces (Baymax) | Used for |
|------------------------|-------------|-------------------|----------|
| `--hud-900`            | `#02060E`   | `--cream-100`     | page edge (near-black) |
| `--hud-800`            | `#04101F`   | `--cream-200`     | deep navy mid |
| `--hud-700`            | `#071C30`   | —                 | navy radial bloom |
| `--cyan`               | `#3CE0FF`   | `--coral`         | standby / listening / primary accent |
| `--cyan-bright`        | `#9DF1FF`   | `--coral-bright`  | glow core, speaking state |
| `--cyan-deep`          | `#16A8CC`   | `--coral-deep`    | borders, focus rings |
| `--amber`/`--amber-bright` | `#FFB443`/`#FFD48C` | (kept names) | thinking state |
| `--teal`               | `#38E6C0`   | `--euca`          | vision state |
| `--red`                | `#FF4D5E`   | `--alert`         | SOS / urgent alert |
| `--rust`               | `#E8915A`   | (kept name)       | recoverable error |
| `--off`                | `#56758C`   | `--ink-dim` usage | offline state (grey-blue) |
| `--ink` / `--ink-dim`  | `#DCEBF5`/`#6E8CA3` | `#5A4E42`/`#B3A28C` | text (variable names kept — pages reference `var(--ink)`) |
| `--card`               | `rgba(8,22,38,.55)` | `rgba(255,255,255,.72)` | dark glass panels |
| `--line`               | `rgba(94,203,255,.22)` | `--cream-300` | hairline borders |

**Background:** `body` carries a radial deep-navy→black gradient;
`.glow-field` paints the slowly drifting horizontal scan-line/wave texture
(`@keyframes scandrift`, pure CSS, no network).

**Ring anatomy (unchanged SVG, new recipe):**
`.ring-outline` = thin crisp near-white outer ellipse (`rgba(231,244,255,.85)`);
`.ring-glow` = thicker luminous cyan arc with the same `drop-shadow()` glow
technique, recolored and given a sharper falloff (6px core + 16px halo vs the
warmer 10px/20px); `.core-fill` breathes as before. All 8 states
(`standby listening thinking speaking vision alert offline error`) are
defined — the state machine was remapped, never redesigned. Motion is
deliberately tighter (standby 6s vs 7s, listening 1.9s, thinking 0.9s,
speak pulse 1.2s).

**Type:** no webfont import (offline-safe). `--font-hud` is a geometric
system stack (`Avenir Next → Futura → Century Gothic → Segoe UI → system-ui`).
The in-ring wordmark "JARVIS" is uppercase with 9px tracking, optically
centered.

**Accessibility:** the `data-contrast="high"` and `data-motion="reduced"`
variants plus `prefers-reduced-motion` were carried over and re-tuned for the
dark palette (stronger outlines, animation-off paths intact).

## 2. Widget layer (`web/js/widgets.js`)

A modular HUD layer around the ring — new relative to upstream's single-ring
focus. Pure additive client code: **no new endpoints, no hub changes.**

| Widget | `data-widget` | Data source (pre-existing) | Refresh |
|--------|---------------|----------------------------|---------|
| Weather | `weather` | `GET /api/weather` | 120 s |
| Date & time | `clock` | fully local (no hub) | 1 s |
| Quick devices | `devices` | `GET /api/home/devices`; toggles via `POST /api/utterance` | 60 s |
| Activity / notifications | `activity` | `GET /api/activity?n=8` | 12 s |

Security properties (inherited, deliberately preserved):

- Device taps route through the **full voice pipeline** — voice-gated devices
  (locks/garage) still demand verification and the widget says so in place.
- The activity widget reuses the **sanitized, transcript-free** feed used by
  Jarvis Remote. Events that usually need the owner (`attention`,
  `security.*`, `sos.triggered`, `injection.guard`, `llm.key.fail`) get a
  `needs you` chip. Parked voice confirmations live in hub RAM only
  (`BUG_BACKLOG L-02`) and therefore appear in the feed once resolved, not
  while parked — an honest limitation, not hidden.
- Widgets talk only to the four read endpoints + `/api/utterance`;
  pinned by `test-jarvis.js` J5.
- Polling pauses while the tab is hidden (`visibilitychange`).

Layout: `index.html` pins four `.hud-widget` panels to the corners around
the ring (`tl weather · tr clock · br devices · bl activity`, the latter
clearing the SOS fab). Under 900 px they flow into a two/one-column grid
below the stage so the ring is never crowded. The dock's **HUD** toggle
(`body.widgets-hidden`, persisted) hides/shows the whole layer — designed to
be easy to dismiss; the ring stays the visual focus.

On **Jarvis Remote** the same HUD panel style renders its existing cards
(weather, clock hero, home devices, activity feed) — same data, same look,
no duplicated machinery. Rearrangement beyond the corners/grid (drag layout)
is out of scope for this pass.

## 3. Rebrand rules applied

| Area | Before (MAX AI) | After (Jarvis) |
|------|------------------|----------------|
| Product name | MAX AI / MAX | Jarvis / JARVIS (wordmark) |
| Wake word | `max`, `hey max`, … | `jarvis`, `hey jarvis`, `ok jarvis`, mid-sentence `jarvis`; bare `hey/hi/hello` catch-alls kept; **`max` retired** |
| Dashboard | Max Remote | **Jarvis Remote** |
| Assistant default | `assistantName: 'Max'` | `assistantName: 'Jarvis'` (+ orchestrator fallbacks, `x-title`, service user-agents, docs) |
| Persona toggle | opt-in "Jarvis mode" | **on by default** (still switchable in Settings) |
| PWA | `MAX AI`, cream theme | `Jarvis`, `#04101F` theme, new cyan icons, `jarvis-shell-v1` SW cache |
| Satellite | `max_satellite` / `max-satellite` | `jarvis_satellite` / `jarvis-satellite` |

**Intentionally NOT rebranded** (internal, invisible to users; renaming would
be pure churn across every page and the test base): the `window.MAX` JS
namespace (`MAX.get`, `MAX.LS`, …), `MAX_*` environment constants
(`MAX_DATA_DIR`, `MAX_SECRET`, `MAX_TOKEN`, `MAX_FILES_ROOT`, …), the
`.bubble.max` CSS class, and inherited CHANGELOG history ≤ v0.11.1
(provenance note at the top of `CHANGELOG.md`).

**Test adaptations** (same check counts, labels marked `[fork]`):
`test-features.js` wake table + inverted theme pin; `test-seams.js` S7
corpus translated to `jarvis` (retired-`max` is a pinned negative);
`test-physical.js` firmware path. New: `test-jarvis.js` (16 checks, J1–J12).

## 4. Isolation between MAX AI and Jarvis

- Separate project directories (`max-ai/`, `jarvis-ai/`), separate default
  data dirs (`<repo>/data/`), separate zips, independent versions, different
  wake words. **No shared mutable state, no cross-writes.**
- Run side-by-side: `node hub/server.js` in each repo with a different
  `PORT` (upstream dev convention here: MAX AI on 8080, Jarvis on 8090).
  Each hub binds its own `data/`, `files/`, `backups/` under its own repo.
- The two trees share **only** the same `.env` *service credentials*
  (OpenRouter keys etc.) — both agents belong to the same owner; each stores
  its own encrypted memory with its own master key.
- Upstream flow: changes land in whichever product they belong to; nothing in
  this fork writes into `max-ai/` and nothing in MAX AI reads `jarvis-ai/`.
