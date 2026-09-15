# Jarvis — Adaptive Learning & Personalization Layer (v0.10.0)

How Jarvis learns you — locally, inspectably, and with hard guardrails. This document
covers the signal pipeline, the five models, the model registry, the drift
guardrails, and the transparency/control surfaces. Companion docs:
`DATA_MAP.md` (storage), `SECURITY.md` (trust boundaries), `CHANGELOG.md`.

## 0. Principles

- **Local-first, always.** All training data lives in two AES-256-GCM
  `SecureStore`s (`learning`, `learn-models`) on the hub. Nothing derived from
  your behavior is ever sent to a cloud brain. The layer follows the existing
  local-vs-cloud toggles (it works identically with Brain = local) and is
  governed by `privacy.learning` (default on, visible in Settings → Privacy).
- **Metadata-only signals.** A signal is `{ts, user, skill, hour, dow,
  sentiment}`. Raw utterance text is **never** persisted (regression-tested).
- **No black boxes.** Every model is a small, plain-JSON structure you can
  read in Settings → *What Jarvis has learned about me*. No opaque embedding
  blobs, no hidden weights.
- **No fine-tuning of the core LLM.** Everything here sits *around* the brain:
  on tool-call outputs, on the tone descriptor, on the suggestion system.
  The LLM's weights are never touched.
- **Security-critical logic is off-limits, permanently.** Auth checks, lock
  behavior, payment/financial-action gating, sensitive-skill voice
  verification: the learning layer cannot learn to skip, weaken, or pre-answer
  them — "the user always confirms" is never a reason to auto-skip a
  confirmation. Enforced structurally (see §3.4, §3.5).

## 1. Signal pipeline

```
utterance finished (orchestrator _finish)
  └─ signal {ts, user, skill, hour-of-day, day-of-week, sentiment}   (no text)
        ├─ ring buffer, capped at 2,000                       (bounded store)
        ├─ pruned by privacy.logRetentionDays                 (reuse of the existing rule)
        └─ per-signal: update routines · prefs · tone · anomaly models
              └─ every 100 signals: checkpoint all models → versioned registry
```

Ingestion happens only when `privacy.learning !== false`. Corrections are a
second signal type: if the current utterance matches *"no, I meant X" / "I
said X" / "not the X"* within **2 minutes** of Jarvis resolving the previous
turn, a `correction` example `{skill, from, to}` is recorded.

## 2. The five models

### 2.1 Routine/pattern learner
Per user+skill, a 168-cell **hour-of-week occupancy map** (`{n, weeks{}}`).
A cell is surfaced when **all** of:
- `n ≥ 4` (**minimum signal threshold**);
- the repeats span **≥ 2 distinct weeks** (a one-afternoon burst is not a routine);
- the cell's count is **≥ 3×** the user's mean bucket occupancy (**drift guard**:
  routines must stand out against your long-term baseline).

Surfacing = a **suggestion**, never an automatic action. It goes to the
existing proactive-notification system (`learn.suggest` → toast only when
proactive suggestions are opted in) with the pending state visible in the
"What Jarvis has learned" view, where one tap **confirms** (upgrades to a
remembered routine), **dismisses** it, or **stops learning it** (permanent:
the pattern id lands on a stop-list and is never re-suggested).

### 2.2 Preference embedding (inspectable)
Per user, a sparse **topic → weight** dictionary (skills used, plus a few
keyword topics: music, news, weather, coding, finance, home, health).
`+0.1` per reinforcing signal, hard-capped at 1.0, and **weekly ×0.95
decay** so stale interests fade unless reinforced (drift guard).
The full dict is shown verbatim in the UI — readable, one-tap deletable.

### 2.3 Adaptive tone
Sentiment per utterance is mapped to valence (frustrated 0.1 → positive 1.0)
and folded into two EWMAs: `recent` (α=0.15) and `long` (α=0.02, the
long-term baseline). The effective tone used in the system prompt is

```
effectiveTone = clamp(slider ± clamp(recent − long, −0.15, +0.15), 0, 1)
```

…i.e. a **±0.15 hard drift cap around the slider you set**. It only engages
after 20+ signals (min-signal gate). If you sound frustrated for weeks Jarvis
gets a little more clinical/reassuring — noticeably, never drastically, and
the applied drift is displayed live in the UI.

### 2.4 Correction-based intent re-ranker
Sits **on top of the LLM's tool-calling output** (and the same dispatch path
the local brain uses) — no retraining. When you correct Jarvis twice within the
same skill ("no, I meant the **bedroom** light" after it chose "office
light"), the mapping `{from→to, n}` activates, and later LLM-chosen string
arguments are steered toward what you usually mean (`learn.rerank.applied`
is logged each time). Requires ≥2 corrections within the recent retention
window; corrections must land within 2 minutes of the mistake.
**It refuses to touch any skill marked `sensitive`** — learned steering can
never cross a security gate.

### 2.5 Anomaly/novelty detector
Two lightweight learned baselines per user:
1. **hour-of-week occupancy histogram** (168 buckets) — which hours you ever use;
2. **Welford mean/variance of daily signal counts** — how much you use Jarvis.

A *review flag* is raised when a signal arrives in a **never-before-used
hour-of-week** while the day is **already a ≥3σ outlier** (z > 3 against the
daily baseline) — and only after ≥100 signals across ≥7 days (cold-start
guard). Composite by design: a single 3am timer is novel but not bursty
(no flag); a heavy weekday is bursty but in known hours (no flag); a long
odd-hours session is both (flag). Flags go to the existing security alert
surfaces (`security.anomaly` event → `/api/alerts`, owner toast, logs) as
**review-only** items — the detector **never blocks and never approves
anything**; containment remains exclusively with the human-reviewed layers.

## 3. Guardrails (critical section)

| Guardrail | Value | Where |
|---|---|---|
| Routine min-signal threshold | 4 repeats | `ROUTINE_MIN_HITS` |
| Routine weeks-span (drift) | ≥ 2 distinct weeks | `ROUTINE_MIN_WEEKS` |
| Routine baseline multiplier (drift) | ≥ 3× mean occupancy | `ROUTINE_BASELINE_MULT` |
| Tone drift cap | ±0.15 around slider | `TONE_DRIFT_CAP` |
| Tone min-signal | 20 signals | `toneFor()` |
| Re-ranker min corrections | 2 | `RERANK_MIN` |
| Re-ranker sensitive-skill exclusion | permanent | `applyCorrection()` |
| Anomaly cold-start | 100 signals / 7 days | `ANOMALY_MIN_*` |
| Anomaly z threshold | 3 | `ANOMALY_Z` |
| Signal store bound | 2,000 | `SIGNAL_CAP` |
| Retention | `privacy.logRetentionDays` (30 d default) | `_prune()` |

**Security off-limits, structurally:**
- the learning layer has **no code path** into auth, voice verification,
  lock/unlock, payment/financial approval, or sensitive-skill gating — it
  can only write to its own stores and read-only suggest;
- anomaly output is a flag object with `reviewOnly: true`; blocking and
  approvals live in the existing security code that this layer cannot call;
- the re-ranker checks `skill.sensitive` and returns `null`.

**Drift protection summary:** every learned behavior compares *recent*
against *long-term* (EWMA pair for tone, Welford baseline for anomaly,
baseline-multiplier for routines, decay for preferences), and every
adaptation is hard-capped, so a short noisy burst can't rewire Jarvis's
behavior.

## 4. Model registry & rollback

Every 100 signals, all five models checkpoint into `learn-models` as
immutable versioned JSON blobs `{v, created, metrics, blob}` (last **3**
versions kept per model). The UI shows current versions per model with a
one-tap **Roll back** that restores the previous blob into the live state
(`learn.rollback` is logged). This is deliberately simple: the models *are*
inspectable JSON, so a rollback is just a restore of readable state.

## 5. Transparency & control

- **Settings → What Jarvis has learned about me**: routine suggestions (with
  confidence and state, confirm/dismiss/stop buttons), **Still learning (live
  progress)** — patterns accumulating toward the guardrails, shown as
  `repeats n/4 · weeks w/2` so learning is visible from the second repeat
  instead of looking empty for the first weeks, the preference dict,
  live tone drift, corrections list, anomaly flags, model versions, and the
  guardrail constants themselves.
- **`GET /api/learn`** — full machine-readable state, including the `emerging`
  list (sub-threshold routine progress: `{skill, hour, dow, n, weeks, needed}`).
  Stopped patterns never appear there — "stop learning this" leaves no shadow.
- **Verbose diagnostics** — start the hub with `MAX_DEBUG=1` and every captured
  signal is logged as `learn.debug` (metadata only: user/skill/hour/dow/
  sentiment/counters — raw text is never logged, even in debug mode). Off by
  default; use it to watch the pipeline live during a conversation.
- **`POST /api/learn/feedback` `{id, action: confirm|dismiss|stop}`**
- **`POST /api/learn/forget` `{kind: pref|correction|suggestion|anomaly, key, user}`**
- **`POST /api/learn/rollback` `{model}`**
- **`POST /api/learn/reset`** — wipes **only** the learning layer (signals,
  all five models, version history, stop-list). Facts, notes, settings,
  memories are untouched — and conversely, `/api/data/wipe` clears those
  without being merged into this action. Independently resettable, as
  required.
- **`privacy.learning` toggle** (Settings → Privacy) — off ⇒ zero capture.

## 6. What this layer deliberately does NOT do

- No cloud training, no third-party analytics, no cross-user federation.
- No automatic automation: confirmed routines become *remembered suggestions*
  you can turn into scheduled jobs yourself; nothing self-executes.
- No raw transcript or content storage (tested: a unique utterance string is
  asserted absent from the store).
- No LLM weight changes, no new models downloaded, no new dependencies.

Tests: `tools/test-learn-models.js` (46 checks) — pipeline hygiene, all five
models at and below their thresholds, drift clamps, sensitive-skill
exclusion, cold-start guards, checkpoint/rollback, reset isolation, toggle
off, and the orchestrator hook contract.

## 7. How the persona + openers layers consume this (v1.0.9 / v0.11.10)

The emotional-expression layer (`hub/persona.js`) and the proactive "where to
start" suggestions (`hub/openers.js`) are READ-ONLY consumers of this layer —
they add no parallel personality state:

- **Tone** still comes from `settings.personality.tone` ± `Learner.toneFor`
  drift-capped adaptation. Persona only maps that tone into situational
  registers (composed / reassure / encourage / wit).
- **Anchors** for encouragement and wit come from `emergingRoutines()` (a
  pattern due this hour-of-week), stored memory facts, or the user's own words
  — never invented. No anchor → no emotional clause (grounded-or-silent).
- **Openers** rank today's calendar, due reminders, and emerging routines at
  the current hour. They are suggestions only (`kind:'opener'` carries no tool),
  gated by `proactive.enabled` AND the new `proactive.openers` sub-toggle
  (Settings → Personality & Proactivity), and guests/kids never receive them.
- The "stop learning this" and master opt-out switches apply unchanged —
  openers/persona surface nothing the learner has forgotten.
