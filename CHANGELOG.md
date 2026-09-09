# Changelog

> **Fork provenance:** entries up to and including **v0.11.1** were recorded
> under the original product name **MAX AI**; this fork continues as **Jarvis**
> from v1.0.0 onward. History below the v1.0.0 entry is inherited verbatim.

## v1.0.10 — Self-review regression pass: treat the last three passes as unverified (2026-09-04)

Lockstep across both products (same diffs, both suites run in both repos).
Mandate: review the bugfix (v1.0.7/0.11.8), model-routing (v1.0.8/0.11.9) and
emotion (v1.0.9/0.11.10) passes the way a stranger's PR would be reviewed —
"what could this have broken," not "does the new feature work." Every finding
was reproduced executable-first, then fixed, then pinned in the new shared
suite `tools/test-regress.js` (**43 checks**, zero voice-specific strings).

**What the three passes actually broke (11 product bugs — 7 model-routing,
2 emotion, 2 pre-existing — now all fixed):**

*Model-routing pass:*
- **Sustained-outage nag (R-01).** Declining "switch to the lower model?" was
  remembered for exactly one re-probe race; each 2-minute renewal of the rung's
  down-stamp minted a new outage id and **re-asked on every message**
  (reproduced 8/8 before the fix). The "no" is now remembered per step for the
  session; "switch models" is the explicit re-arm. Verified live on a hub with
  its cloud pointed at a dead port: ask once → quiet wait-state answers →
  re-arm on request (and an accepted degrade now also survives re-probes, R-02).
- **`ollama serve` orphan multiplication (R-03).** A hung never-answering spawn
  let every later trigger spawn another daemon. A still-alive-but-never-ready
  child now blocks re-spawning with an honest kill-and-retry reason; dead
  children never block recovery; running instances are still detected first;
  the wait loop is proven to terminate near its deadline.
- **Personal facts unprotected from web text (R-04).** The fresher-wins
  grounding rule overwrote *"my favorite editor is vim"* from a Wikipedia
  snippet about strangers' editors (the "my" marker was stripped in parsing).
  Possessive/favorite keys are now flagged `personal` and conflicts are refused
  — web text can never be fresher about you than you are.
- **Polluted overwrite values (R-05).** Rewritten facts captured up to 4 tokens
  greedily — *"python version is 3.13.2 and ships with"* was a real stored
  result. Values are now clause/comma/connective-bounded, and the copula parser
  requires whole-word boundaries (no more "prime min·is·ter" key splits).
- **Secrets in user-facing diagnosis lines (R-06).** The generic classifier
  echoed raw `err.message` into chat — a reproduced PAT+key pair surfaced
  verbatim (logs scrubbed; the visible line didn't, and `github_pat_`/`glpat-`
  shapes were missing everywhere). All user-facing diagnosis text is now
  scrubbed; the shared key pattern is widened and separator-aware
  ("skipping a beat", `hf.co/…` model ids stay readable — over-redaction
  counts as a failure and is tested).

*Emotion pass:*
- **Cross-user opener stash (R-07).** One shared stash field could hand user
  A's grounded board (calendar/reminders) to user B when first turns
  interleaved. The stash is now keyed per user; only the owning session may
  consume it (interleave simulated in the suite).
- **Honest-framing adverb gap (R-08).** "Do you *ever* feel sad?" slipped past
  the deterministic honest answer into the LLM. The feelings detector now
  covers ever/sometimes/really/actually plus hurt/lonely predicates; live-
  verified in both products, and "do you feel like pizza / how do you feel
  about the trade" still route normally — no shadowing.

*Pre-existing (found by hunting for swallowed errors):*
- **Silent multi-turn task failure (R-09).** A `continueTask` throw cleared the
  task, logged one line, and silently re-interpreted the user's input as a new
  message. Now: diagnosed, said out loud, persistent chat answer.
- **Nudge on error turns (R-10).** The hacking-mode nudge could ride on top of
  an error message. Gated to clean turns (still fires normally otherwise).
- **Broken favorite-fact storage (R-11).** "My favorite color is teal" stored
  a bare `teal`. The full possessive phrase is stored now (also feeds R-04).
- Cosmetic: the parked-confirm replacement note calls an opener "where to
  start" instead of "the earlier action".

**Harness findings (fixed the same way):** chaos B7's watchdog part-2 could
crash the suite with ESRCH when the fast-exit hub died inside the first freeze
window (observed live on the MAX chain) — guarded; the new suite's fake secrets
are runtime-built because the physical key-scanner rightly rejects quoted
key-shaped literals.

**Previously-fixed items re-verified (all green):** task-workspace progress &
gesture-control default-off (test-features §13/§14); OpenRouter `.env`-only
with no settings UI path (J13/J14 plus the metadata-only `/api/keys` route);
"terminal" as the only dashboard-open path (test-features + a static scan
inside test-regress); the full failure-injection matrix (test-chaos **39/39**)
and pentest checklist (test-redteam **29/29**) in both repos; the learning-
pipeline demonstration re-run live (reset → 3 signals → emerging-routine row);
the tamper-evident audit chain verifies intact after live writes.

**Suites:** new `test-regress` **43/43** in both repos. Full chains re-run end
to end at this exact tree: Jarvis (v1.0.10): **24 suites, 637 checks, zero failures**; MAX (v0.11.11): **23 suites, 613 checks, zero failures**. J12's independent-tree count
moved 23→24 accordingly.

## v1.0.9 — Emotional-expression layer + grounded session-start suggestions (2026-09-04)

Shared-lineage work, shipped in lockstep with MAX AI v0.11.10 (same diffs, both
suites run in both repos; the product VOICE is a deliberate per-repo block like
the four classic branding lines — Jarvis keeps its HUD character, MAX keeps its
warm companion; the emotional infrastructure is otherwise identical).

**1) Emotional-expression layer (`hub/persona.js`) — extends the adaptive tone
model, never parallels it.** The final tone still comes from
`personality.tone` + `Learner.toneFor` drift; the layer adds situational
registers on top — composed (baseline), reassure (calm under pressure),
encourage (quiet acknowledgement), wit (dry, Jarvis / gentle, MAX). Four
structural guarantees, all suite-pinned:
- **Grounded or silent.** Every emotional clause requires a real anchor —
  the user's own words, a stored fact, a learner pattern due this hour-of-week,
  or a diagnosis object. No anchor → composed register → no clause. There is no
  code path that emits emotion without the anchor woven into it.
- **Accuracy first.** Problem statements (diagnoses, security warnings, skill
  failures) ship verbatim and FIRST; the only deterministic artifact is a
  reassure-only CLOSE appended after the facts, and it needs the caller's own
  `solid` ("what still works") — the layer never invents one. Encouragement/wit
  are LLM-prompt-only (a deterministic joke would be template filler — banned).
- **Honest framing.** "Do you have feelings / are you conscious?" is answered
  deterministically, offline, without an LLM ("I'm a program with a consistent
  voice… the remembering is real"), and every system prompt carries the
  style-≠-substance rule, the wellbeing-over-engagement rule, and the
  problems-lead rule. A BANNED-pattern screen kills engagement-bait
  (guilt-tripping, manufactured urgency, neediness) — and the suite feeds the
  canonical bait strings through it.
- **Product voice, not user voice.** Jarvis: precise, confident, understated
  second-in-command (`hub/persona.js` VOICE block + the `_systemPrompt`
  persona line now reads HUD instead of the legacy healthcare line). The layer
  deliberately does not follow the user-editable assistantName.
Suite: `test-persona` **38** — register matrix, prompt-section rules, close
preconditions, error-path integrity (full diagnosis + close ordering, neutral
turns get zero garnish), streak anchoring, bare-orchestrator null-safety.

**2) Proactive "what should we start with" (`hub/openers.js`).** Composed from
REAL sources only: today's calendar events, due/overdue reminders, and
in-progress routine patterns for the current hour-of-week (the personalization
layer reused — no parallel learning). Behaviors, all suite-pinned:
- Grounded-or-silent: names the actual items ("On the board: Team sync at 2:00
  PM and the open reminder 'Q3 doc pass' — start there?"); empty board → null
  (silence, never an open-ended "What would you like to do?"); `explicit ask`
  with an empty board answers honestly ("Board is clear…").
- Delivery: appended once per fresh session on the first CLEAN turn only —
  never stacked on a confirm/verify/locked/task/nudge turn (single-question
  rule, same invariant as the hacking-mode nudge); the explicit-ask patterns
  ("what should we start with", "what now", "what's on today") answer directly.
- Suggestion-only: the parked accept is `kind:'opener'` in the one-shot confirm
  slot with **no tool name** — unexecutable by construction; "yes"/"start"
  surfaces the item's read-only details, "no" closes it, an unrelated reply
  drops it and processes normally, expiry fails safe into the existing
  nothing-waiting path. Guests/kids never receive one (schedule privacy). Reminder candidates
  are **user-scoped** (`job.user`) — one user's open reminders never surface in
  another's opener (caught in live smoke, fixed pre-ship, suite-pinned).
- Toggleable: `Settings → Personality & Proactivity → Session-start
  suggestions` (`proactive.openers`, default on), gated additionally by the
  master proactive opt-in.
Suite: `test-openers` **32** — ranking, toggles, privacy gates, one-shot
mechanics, read-only accept, ambient-drop, expiry, single-question rule.

**Constraints honored:** adaptive tone model + routine learner REUSED (persona
reads `toneFor`/`emergingRoutines`; no parallel personality state); error,
warning, and security surfaces are byte-identical in substance (chaos 39/39,
redteam 29/29, injection 12/12, security 24/24, seams 28/28, modelroute 38/38,
diagnose 33/33 all green); proactive behavior fully respects the existing opt-in
plus its own sub-toggle.

Full `npm test` chain green: **23 suites** — incl. the two new suites above,
check (hub now 53 modules), test-jarvis 23 (J12 count 21 → **23** test files).

## v1.0.8 — The brain-layer pass: self-diagnosing errors, tamper-evident audit, model ladder with confirm-before-degrade, privacy routing, grounded answers (2026-09-04)

Four features from one brief, all sharing five new modules (`hub/audit.js`,
`hub/diagnose.js`, `hub/models.js`, `hub/localproc.js`, `hub/grounding.js`) and
one orchestrator integration. Shipped in lockstep with **MAX AI v0.11.9** (same
diffs; only branding strings differ between the repos). Zero security invariants
touched — re-proven below.

**1) Self-diagnosing, self-explaining error handling**
- Every skill/tool/brain failure now routes through a central Diagnostician
  (`hub/diagnose.js`): 11 scoped rules + a generic fallback produce a concrete
  user-facing line — *what broke / likely cause / what's being done or exactly
  what you must do* (e.g. "your GitHub token looks expired — update it in
  `.env`"). Diagnosed lines land as persistent chat answers, never transient
  error toasts, so the explanation can't vanish from the conversation.
- Every diagnosed issue is written to a new **tamper-evident audit log**
  (`hub/audit.js`): an HMAC-SHA256 hash chain anchored to `data/.master.key`,
  size-capped rotation that re-roots the anchor *before* chaining (proven:
  rotate-then-write keeps `verify()` green across 40 records at a 1200-byte
  cap; a one-bit tamper verifies `ok:false, brokenAt:6 "content MAC mismatch"`;
  deleting a line breaks the link). Secret-shaped strings are scrubbed to
  `[key-redacted]` and raw transcript text is never written. Inspected via
  `GET /api/audit/tail` and `GET /api/audit/verify`; a 9th boot check
  (`audit log (tamper-evident)`) watches it.
- Recurring **infrastructure** issues (never personal preferences — the
  learning layer is untouched) are counted in an encrypted diagnostics store:
  the 3rd occurrence within 7 days graduates to a known issue
  (`GET /api/diagnostics/issues`) and the diagnosis itself starts saying so —
  "failure #N on record" — with the readiness report carrying the fix.
- Dead-disk resilience: a read-only/corrupt data dir can never crash the
  logger or the diagnostician (mkdtemp+chmod fault-injection in the suite).

**2) Automatic best-model selection, with confirm-before-degrade**
- `.env` `MODEL_PRIORITY` is a best→worst ladder of OpenRouter model ids plus
  `ollama:` entries (`hub/models.js`); unset keeps the old behavior
  ([configured cloud model, local floor]). Garbage entries are rejected by
  shape, deduped, capped at 8. Adaptation note, as flagged before: **Gemini is
  not a separate provider here** — `google/gemini-*` ids run through
  OpenRouter with the same keys and rotation; no Gemini key handling exists.
- Startup and per-turn, the best *available* cloud rung answers automatically.
  Dropping to a **lower cloud rung always asks first** — "X isn't available
  right now (...) — switch to Y (lower capability), or wait/retry?" — exactly
  once per outage (a stable `outageId` keys it; each *new* ladder step is its
  own consent, a step is never re-asked). "yes" remembers the downgrade for
  the whole outage and replays your deferred question on the new model;
  "no" holds — and the unconfirmed lower rung is provably never used as a
  silent backdoor (`test-modelroute`). When the better model recovers, an
  upgrade back is offered once ("top-model is back — say yes to move up").
- The OpenRouter 3-key rotation inside a rung stays fully automatic and
  untouched (`test-keyring` PASS re-run).
- Small print: only true network partitions mark a rung down (a transient
  HTTP 500 / garbage body no longer parks it for 2 minutes) — chaos B2 proves
  the brain self-heals on the very next success. `GET /api/models` exposes the
  ladder, per-rung health and the reason each is blocked.

**3) Topic-triggered & failure-triggered local routing (Ollama)**
- Security-research topics (pentest/exploit/vuln/CVE/malware vocabulary —
  a dedicated detector, the hacking-mode nudge regex is unchanged) are routed
  to the local model with the brief's plain announcement: *"This looks like a
  sensitive topic — switching to local processing for privacy."* The hub
  manages `ollama serve` itself (`hub/localproc.js`: spawn, readiness poll,
  single-flight, cooldown; missing binary → a plain "Ollama is not installed"
  reason, never stack noise).
- If the local model can't start, the turn is **held for explicit consent**
  ("…this topic should stay on this machine for privacy. Continue on the cloud
  anyway, yes or no?") — never silently clouded; a "yes" is session-scoped and
  audited, a "no" keeps it off the cloud and says how to finish setup.
- A genuine cloud outage falls back to the local model automatically with the
  brief's announcement *"OpenRouter isn't responding — switching to the local
  model."* — and when neither brain can serve, one honest combined dead-end
  names both causes ("The cloud brain is unreachable too — both brains are
  offline right now…") and promises the deterministic basics.
- Kept completely separate from the "terminal"/"open terminal" command: the
  brain layer contains zero dashboard references (suite-enforced invariant),
  routing changes are activity-feed status lines, and the terminal skill still
  owns auto-navigation. Sensitive tools stay verify-gated under local routing
  (suite-enforced). No behavioral rule, confirmation gate or sandbox changed.

**4) Unified memory + live search answering**
- Freshness-sensitive questions ("latest/current/today/2026…") gather stored
  memory facts *and* a live wiki search before the brain answers
  (`hub/grounding.js`), and the prompt shows the model both with dates.
- On conflict the fresher source wins and memory is rewritten with provenance
  and an audit row — then the answer *tells you out loud* what it updated.
  Live proof: memory held "python 3.11", the live check said 3.13 → stored
  fact rewritten and the reply carried the correction. (Extractor hardened:
  "3.13 now" vs stored "3.13" is filler, not a false conflict.)

**Live evidence** (beyond the suites): a 3-rung ladder against a dead
OpenRouter produced, in order — diagnosed honest fallback; the exact degrade
ask string; question replay after "yes"; chained consent claude→gpt-4o-mini;
all-down dead-end with recurrence memory ("failure #4 … on record"); an audit
tail that told the whole story; and a tamper test failing verification loudly.

**Regression:** two new suites — `test-diagnose` (33) and `test-modelroute`
(38); `test-physical`'s credential-shape audit tripped on the new audit-scrub
test's fake key literal → the fake key is now built at runtime; `test-features`
provider-hygiene grep kept strict (a code comment reworded); `test-jarvis`
J12 counts 21 test files (19 legacy + this suite + the brain-layer pair);
`test-systems` expects 9 boot checks. **Chain: all 21 suites green** (check.js
51 · hl 20 · apps 20 · keyring PASS · security 24 · offline 7 · backup 8 ·
redteam 29 · chaos 39 · privacy 20 · injection 12 · physical 15 · systems 23 ·
features 36 · lean 15 · learn 46 · diagnose 33 · modelroute 38 · github 35 ·
seams 28 · jarvis 23).

## v1.0.7 — OpenRouter keys are .env-only; fresh-machine sweep; learning transparency fix (2026-09-04)

Three work packages, all with live evidence (see `docs/FRESH_RUN_LOG.md`).

**1) OpenRouter keys: `.env`-only (fork policy change)**
- Settings UI key fields removed from the desktop settings page and confirmed
  absent from the Jarvis Remote dashboard — no UI path can view/add/edit keys.
- `hub/keyring.js` now reads **only** `OPENROUTER_KEY_1/2/3` (up to 16 slots,
  3-key rotation policy), never the settings store or legacy CSV aliases.
- New `hub/keymigrate.js`: first boot folds any old settings-UI keys / legacy
  aliases into canonical `.env` slots (dedup, cap 3, comments the old lines
  `# migrated ->`, purges the settings copy, 0600 perms, idempotent).
- Startup preflight: a missing slot aborts with exit(1) naming the exact
  variable (`OPENROUTER_KEY_2 must be set in .env …`) — never a silent 2-key
  start — unless `JARVIS_ALLOW_KEYLESS=1` is set (loud override warning +
  8th boot check `cloud brain key rotation` shows the posture).
- `/api/keys` is metadata-only (source/model/count/slots); POST/DELETE → 410
  with .env guidance. `.env.example` rewritten. Key rotation re-proven under
  simulated 429s (`test-keyring` PASS). Gemini: N/A — OpenRouter is the only
  cloud provider; no Gemini key handling exists to migrate (flagged, unchanged).
  MAX AI is deliberately untouched by this package (it keeps its own policy).

**2) Fresh, from-scratch bug hunt on this machine** (clean checkout, fresh
`.env`, cold start — findings F-01…F-04; everything else verified clean with
evidence in `docs/FRESH_RUN_LOG.md`):
- **F-01 (fixed):** `config-check.js` warned "no OpenRouter keys" even with
  canonical `OPENROUTER_KEY_n` set — it only looked at legacy aliases.
- **F-02 (fixed):** `.env` files were world-readable (644) → 600 on both repos.
- **F-03 (fixed):** one cream/coral hex (`#f3c4b6`, chip border in the learning
  view) survived the re-skin inside an inline JS style → `var(--line)`.
- **F-04 (fixed, shared):** "what is the weather like / in Paris" routed to
  encyclopedia **search** (alphabetical load order shadowed the weather skill)
  and answered about the *concept* of weather. Search now carves out only the
  weather-as-forecast idiom; concept questions ("temperature of the sun")
  still reach search. Regression: `test-seams` **S17** (real registry, no stubs).
- Re-verified clean: wake matcher (jarvis wakes, 'max'/'jarv' rejected), all 8
  ring states styled + wired, widget layer rendering live (weather/clock/
  devices/activity), dashboard wiring, asset paths, manifest/icons, no
  MAX/Jarvis collisions (ports 8080/8090/8122, separate data dirs).

**3) Personalization "not learning" — root-caused and fixed**
- Diagnosis (verbose `MAX_DEBUG=1` capture + code audit): the pipeline was
  never broken — signals were captured and prefs/tone/corrections accumulated,
  proven live. Two things made it *look* dead: (a) routine accumulation lived
  only in an internal structure that neither `/api/learn` nor the transparency
  view exposed until the 4-hits-×-2-weeks suggestion threshold, so the view
  looked empty for the first weeks; (b) the first model checkpoint fired at
  200 signals (~week+), so every model showed "v0" in normal use.
- Fix: `/api/learn` state now exposes `emerging` — live sub-threshold progress
  `{skill, hour, dow, n, weeks, needed}` — and the settings view renders a
  **"Still learning (live progress)"** list. Checkpoint cadence 200 → **100**
  (first auto-checkpoint within days; anti-overfitting guardrails untouched:
  routine suggestions still need 4 hits × 2 weeks × 3× baseline). Stopped
  patterns never appear in `emerging` — "stop learning this" leaves no shadow.
- Verbose capture logging added behind `MAX_DEBUG=1` (`learn.debug` events,
  metadata-only — raw text is never logged, even in debug mode).
- Before/after on a fresh hub: same 12-utterance conversation — before:
  `routines: []`, no `emerging` key, models v0; after: three patterns visible
  with progress (clock 5/4 · 1/2 wk, weather 3/4, reminders 2/4), suggestions
  still correctly empty. Regression: `test-learn-models` +11 checks (46 total).

Suite totals: **447 checks across 19 suites** (was 433) — incl. re-run
failure-injection (chaos 39) and pentest (redteam 29).

## v1.0.6 — B-11/B-12 reminder-intent fixes; B-13 design flag (fresh BUGS_MASTER re-sweep) (2026-09-03)

Lockstep with MAX AI v0.11.7 — same fixes, same diffs, both suites. The fresh
re-consolidation surfaced three un-logged items, all in the reminders skill:

- **B-11 (fixed):** time-clause-first phrasing ("remind me in 2 minutes to stretch")
  dropped the task and re-asked "what", swallowing the next utterance as the label.
  Regression: `test-features` #14b (3 checks).
- **B-12 (fixed):** "clear all my reminders" answered with the list instead of
  clearing — the list intent's generic `/\bmy reminders\b/` catch-all shadowed the
  imperative (registry matches intents in order). Clear now stands above list.
  Found live during this pass's clean cold start. Regression: `test-features` #14b
  (2 checks).
- **B-13 (flagged unresolved — design boundary, not forced):** reminder list/clear
  operate on the device-global schedule while saying "my reminders" — device-global
  is the documented DATA_MAP posture (guests already gated out of personalData
  skills); per-user scoping vs. wording is a multi-user decision for a dedicated
  identity session. Logged in BUGS_MASTER.md.

B-01…B-05 remain fixed and pinned (v1.0.5); firmware TODO (B-10) remains flagged
unresolved by deliberate deferral.

Suite totals: **425 checks across 19 suites** (was 420).

## v1.0.5 — BUGS_MASTER pass: every known bug consolidated, fixed, regression-pinned (2026-09-03)

Lockstep with MAX AI v0.11.6 — same fixes, same diffs, both suites (per the fork
isolation rule). New `BUGS_MASTER.md` consolidates every open item: `BUG_BACKLOG.md`
(M-01/M-02, L-01/L-02/L-03), `TEST_LOG.md`, the Round-9 pentest lineage, the
"breaks after new keys" debug pass, and a full TODO/FIXME/XXX/HACK grep (one
firmware item — **flagged unresolved** with reason, not force-fixed).

### Fixed (each with a passing regression test)

- **B-01 (M-01)**: parked-confirm overwrite speaks — `_parkConfirm()` announces the
  replacement ("That replaces my earlier question about X — it's cancelled…");
  fail-closed preserved. `test-seams` S14.
- **B-02 (M-02)**: `github_explore` enforces the 8 MB cap while **streaming**
  (header pre-refusal + mid-download abort) — no more whole-tarball RAM spike.
  `test-github` #16/#17.
- **B-03 (L-01)**: lean brain can no longer fake competence — hardened lean system
  prompt (no claimed actions/live data) **and** the 402-discovery turn now routes
  deterministic questions ("what time is it") to the gated local intent layer
  instead of the tool-less model guessing. `test-lean` #13/#14.
- **B-04 (L-02)**: bare yes/no with nothing parked (restart clears parked prompts —
  RAM-only is deliberate) gets an explicit answer instead of a hallucinated meaning.
  `test-seams` S15.
- **B-05 (L-03)**: SECURITY.md §9 + README now explicitly document the LAN-readable
  metadata posture when `MAX_TOKEN` is unset. `test-seams` S16 pins the docs.

Suite totals: **420 checks across 19 suites** (was 411). Round-3 failure-injection
matrix (`test-chaos`, 39) and Round-9 pentest checklist (`test-redteam`, 29) re-run
green; clean-environment cold start re-verified end-to-end.

## v1.0.4 — Dead-page fix: unguarded widget mount + incomplete app-shell cache (2026-09-02)

User-reported: main page loaded with four **empty widget boxes** and nothing
responding. Proven reproduction of the chain:

1. The hub process was dead (sandbox between-session kill), so the browser
   loaded the page from the **service-worker cache** (that's by design).
2. `js/widgets.js` was **missing from the SW asset list** — and the user had
   never cached it from a prior working visit, so the script tag failed.
3. `index.html` then ran `MAX.widgets.mountAll()` **unguarded** → TypeError
   → the entire inline page script died at that line: widgets stayed empty,
   the need-banner never initialized, dock buttons wired after that line went
   dead. Exactly the reported state. (Widgets themselves are healthy —
   verified populating live against the hub in simulation.)

### Fixed

- `index.html`: the widget mount is **failure-isolated** — guarded existence
  check + try/catch; if the layer is absent the HUD box layer and its dock
  button are hidden instead of leaving ghost boxes. The page now fully
  functions with zero widget JS.
- `web/sw.js`: `jarvis-shell-v1` → **`jarvis-shell-v2`**; asset list completed
  (`js/widgets.js`, `js/wakeword.js`, `systems/vision/meeting.html`).
- 1 new check in `tools/test-systems.js`.

Suite totals: **411 checks across 19 suites** (was 410).

## v1.0.3 — Voice picker regression fix (2026-08-31)

User-reported bug: Settings → Voice & Speech → speaking-voice dropdown
rendered completely empty (zero options).

### Root cause

Two latent defects, both in shared lineage:

1. `common.js` `loadVoices()` referenced a bare `speechSynthesis` — in any
   browser/WebView without the Speech Synthesis API that is a ReferenceError.
2. `settings.html` `fillVoices()` read `MAX.voices` **before** appending the
   "Auto" default option, so the throw left the select with **zero options**.
   (Separately, Chrome can also load its voice list late and never fire
   `voiceschanged`, so an initially-empty list could stick forever.)

### Fixed

- `loadVoices()` is now absence-safe (`'speechSynthesis' in window`).
- `fillVoices()` appends the default option first, reads voices defensively,
  shows an explanatory disabled option instead of a blank list ("No device
  voices installed…" / "This browser has no speech synthesis…"), and polls
  briefly (10 × 400 ms) so Chrome's late voice list self-heals.
- Behaviorally proven for all three scenarios (getter throws / empty list /
  voices present) — the select has ≥ 1 option in every path.
- 2 new checks in `tools/test-systems.js`.

Suite totals: **410 checks across 19 suites** (was 408).

## v1.0.2 — Problem visibility: the UI now says WHY something isn't working (2026-08-31)

Follow-up to v1.0.1 lineage. The boot report and `/api/diagnostics` made failures
visible to a terminal user — but the *app* still went quiet. Now the truth in
`/api/status` reaches the surface the user is actually looking at.

### Added

- **Need banner on the main page** — a slim pinned banner (under the topbar)
  that appears the moment the hub reports `blocked`/`warn` needs, showing the
  problem *and its fix* plus a Systems shortcut; dismissible per state, it
  re-arms when the problem set changes; polls `/api/status` every 30 s and on
  every reconnect. When the hub is unreachable it becomes the offline banner
  ("Hub offline — the server process isn't running … restart it"), so a dead
  preview never reads as a mysteriously broken app again.
- **Lean-credit window surfaced**: `/api/status` now carries `lean
  { active, kind, until, minutesLeft }` and a `brain.lean` needs row while
  the OpenRouter credit ceiling is throttling full-size prompts — the banner
  and the Systems page both explain that skills still answer locally and that
  full mode auto-resumes.
- **Boot diagnostics card on the Systems page** (reads the v1.0.1 lineage
  `/api/diagnostics` report).
- 3 new checks in `tools/test-systems.js`.

Suite totals: **408 checks across 19 suites** (was 405).

## v1.0.1 — Startup diagnostics + MAX_DEBUG loud-failure mode (2026-08-31)

Same debugging pass and outcome as MAX AI v0.11.2 (shared lineage shipped in
lockstep): **no startup bug** — terminal cold start is clean on this fork
(copied paths resolve relative to `jarvis-ai/`, no cross-references to the
original project's config or data; the two hubs coexist on separate ports),
all 3 OpenRouter keys verified standalone (HTTP 200 + live completion;
earlier 402s were free-tier budget exhaustion, handled by the lean cascade).

### Added

- **`hub/diagnostics.js`** + boot `[boot] ✓/⚠/✗` readiness report,
  **`GET /api/diagnostics`** (masked), and **`MAX_DEBUG=1`** loud-failure
  mode — see the v0.11.2 entry in the inherited history below for the full
  investigation narrative.
- 2 new checks in `tools/test-systems.js`.

Suite totals: **405 checks across 19 suites** (was 402).

## v1.0.0 — Jarvis fork: HUD re-skin + widget layer + full rebrand (2026-08-31)

**A re-skin and rebrand, not a rebuild.** The entire codebase was copied from
MAX AI v0.11.1 into this independent project (`jarvis-ai/`) — every skill,
security rule, sandbox, confirmation gate, and the learning layer with all
its guardrails carries over **unchanged**. The original MAX AI project was
not touched and continues to build and run exactly as before (verified: full
suite green in both trees on the same day). Evidence: both hubs run
side-by-side on different ports against different data directories.

### Changed (rebrand — user-visible)

- **Product name: Jarvis** everywhere — app title, page titles, wordmarks,
  UI labels, docs, config defaults (`assistantName: 'Jarvis'`, orchestrator
  fallbacks, OpenRouter `x-title`, GitHub/browse/youtube user-agents,
  `made by` stamp in generated documents).
- **Wake word: "Jarvis"** is the primary trigger (`jarvis`, `hey jarvis`,
  `ok jarvis`, mid-sentence name — same tuning philosophy as upstream).
  Generic `hey`/`hi`/`hello` catch-alls kept. `"max"` is **retired** in this
  fork and no longer wakes it; MAX AI keeps "Max" — the two products are
  independent from here on.
- **Dashboard renamed "Jarvis Remote"** (title, nav label, PIN lock screen).
- **Jarvis persona is the default voice** (greeting + status-aware lines);
  the Settings toggle remains to turn it off.
- PWA manifest, both icons, and the service-worker shell cache rebranded
  (`jarvis-shell-v1`); manifest theme/background colors now navy.

### Changed (visual theme — styling only, zero logic change)

- **`web/css/theme.css` rewritten as a dark HUD theme** on the *same*
  CSS-variable/state-machine architecture: identical class names, identical
  ring SVG anatomy, identical 8-state machine (standby / listening / thinking
  / speaking / vision / alert / offline / error) — remapped to a new palette:
  cyan for normal states, amber for thinking, teal for vision, red for
  `alert`, desaturated grey-blue for `offline`, rust for `error`.
- **Background:** deep navy-to-black radial gradient with a slowly drifting
  horizontal scan-line/wave texture (`.glow-field`, network-free).
- **Ring:** double ring — thin crisp near-white outer outline + thicker
  glowing bright-cyan inner arc, same drop-shadow glow technique recolored
  with a sharper falloff; breathing/rotating motion kept with tighter timing.
- **Wordmark:** "JARVIS" centered in the ring, uppercase, wide letter-spacing,
  geometric system sans stack (no webfont — offline-safe by design).
- Pages, cards, forms, toasts, chat, code blocks all re-tinted to the HUD
  palette (translucent dark glass, thin cyan borders, no harsh shadows).
- High-contrast and reduced-motion accessibility variants carried over and
  re-tuned for the dark theme.

### Added

- **HUD widget layer** (new relative to the upstream single-ring focus):
  - `web/js/widgets.js` — shared, zero-dependency module; mounts on any page.
  - Four widget kinds: **weather** (current + short outlook), **date/time**
    (fully local), **quick devices** (at-a-glance on/off with tap-to-toggle —
    taps still route through the full voice pipeline so voice-gated devices
    stay gated), **activity/notifications** (reuses the Jarvis Remote
    activity-feed data; `needs you` chip on attention/security events).
  - Panels: translucent dark glass, thin glowing cyan border, arranged
    *around* the ring (four corners on wide screens; tidy grid below the
    ring on mobile). The ring stays the visual focus.
  - All widgets can be **hidden with one dock toggle** (persisted).
  - On Jarvis Remote the same HUD panel style renders its existing cards
    (weather / clock hero / home devices / activity feed) — same data, same
    look, no duplication.
- **`tools/test-jarvis.js`** (16 checks, J1–J12) — pins the fork invariants:
  wake identity, theme tokens, ring anatomy, widget markup + endpoint purity,
  branding sweep, config defaults, PWA assets, package identity, provenance
  honesty, complete independent tree.
- **`docs/JARVIS.md`** — theme token map, widget layer documentation, fork
  adaptations, and isolation rules between the two products.
- **`web/js/widgets.js` → 19 suites in `npm test`** (chain updated).

### Fork adaptations of inherited tests (documented, same check counts)

- `test-features.js`: wake table now pins `"jarvis"` phrases; theme pin
  inverted from "must stay cream/coral" to "must be HUD cyan/navy, cream
  tokens gone" (the old pin's whole point was theme integrity — preserved).
- `test-seams.js` S7: stress corpus translated to `jarvis` (must-wake,
  negatives incl. retired `"max"`, deliberate mid-sentence tuning).
- `test-physical.js`: firmware path updated for the renamed satellite
  (`jarvis_satellite/jarvis_satellite.ino`).

### Intentionally NOT rebranded (internal/technical surface)

- `window.MAX` JS namespace and `MAX_*` env constants (`MAX_DATA_DIR`,
  `MAX_SECRET`, `MAX_TOKEN`, `MAX_FILES_ROOT`, ...) — internal identifiers;
  renaming would zero-gain churn across every page and the whole test base.
- `addBubble('max', …)` / `.bubble.max` CSS class — internal hook.
- Historical CHANGELOG entries ≤ v0.11.1 (provenance note at top).

### Isolation between the two products

- Separate directories, separate `data/` (default `<repo>/data`), separate
  zips, independent versions and wake words. No shared mutable state; the
  only shared inputs are the same `.env` service credentials (both products
  are the same owner's assistant — documented in docs/JARVIS.md).

Suite totals after this release: **402 checks across 19 suites** (386
inherited, all passing + 16 new fork-invariant checks).

## v0.11.1 — Full Regression Loop: seam suite + credential-scrub fix (2026-08-30)

Theme: *test everything → log everything → fix Critical/High → retest* —
process + evidence in **`TEST_LOG.md`**, remaining Medium/Low in
**`BUG_BACKLOG.md`**. **386 checks across 18 suites, all green** (20 new
cross-feature seam checks).

### Added

- **`tools/test-seams.js`** (20 checks) — deliberately targets feature
  *overlaps* that single-feature suites can't see: parked GitHub writes vs
  lean-window routing vs hacking mode vs busy/expired sessions; learning-
  layer fault injection against security gates; dashboard single-path
  guarantee; wake-word false-positive corpus; and quick re-verification
  anchors for historically fixed bugs (Task Workspace stall, gesture
  default-off, mic/embed hardening).

### Fixed

- **H-001 (High, security/privacy)** — a voice-verification attempt said
  aloud per the gate's own instruction (*"Say 'verify me' and my
  passphrase"*) flowed through `handleUtterance` into the learning layer:
  passphrase words could bump preference topics, the utterance became
  correction context (`lastResolved`), and a follow-up "no, I meant X"
  could persist fragments into the encrypted learning store shown in the
  transparency view. Fixed: verification turns are now **invisible** to
  learning — no text, no context, and they never seed a later correction
  (`tools/test-seams.js` S5 pins this).

### Confirmed still-fixed (regression anchors re-run)

Task Workspace stall under concurrent voice (test-features) · gesture-
control default-off (test-features + S8) · screen-read visibility indicator
(S8) · mic/embed Permissions-Policy handling + stuck-listening watchdog
(S9) · Round-3 failure-injection matrix (test-chaos 39) · Round-9 pentest
checklist (test-redteam 29) — all green in both cycles.

---

## v0.11.0 — GitHub Integration: broad reads, narrow always-confirmed writes (2026-08-28)

Theme: *GitHub becomes a first-class tool module — high-risk gated on par
with desktop control.* Docs: **`docs/GITHUB.md`** (scopes + trust model +
outage behavior). **365 checks across 17 suites, all green** (33 new).

> Spec adaptation note: the prompt's `name / canHandle(intent) /
> execute(params)` interface maps to this codebase's established skill
> interface (`intents` / `tools`, registry auto-load) — same contract, local
> names, like every prior round.

### Added

- **`hub/skills/github.js`** — `sensitive: true` (voice-verify gates
  everything) + `personalData: true` (guests never). Zero dependencies
  (global fetch, `zlib`, hand-rolled tar walker).
- **Broad reads** (`sideEffect:'read'` → outputs wrap UNTRUSTED): repos
  list/search (incl. private), file read + directory browse, commit
  history, issues + comments, PRs incl. diff summaries, CI/Actions status
  for a repo or a specific PR, and the notification feed. All responses
  field-bounded so a giant body can't flood the brain's context.
- **Narrow writes** (`sideEffect:'write'` + **new trust-layer flag
  `confirm:'always'`**): create issue, comment, create/review/merge PR,
  single-file commit (≤60 KB). Every write **parks for an explicit in-the-
  moment "yes"** — even without any untrusted read (new behavior; the
  classic write-after-untrusted-read parking is unchanged and still uses
  the injection wording). One-shot: "yes" from earlier never counts.
  **No deterministic intents for writes exist at all.**
- Deliberately **not** implemented: branch deletion and any repo-level
  setting change (visibility, branch protection, collaborators) — GitHub
  web UI only, by design.
- **Developer-assistant tie-in**: `github_explore` fetches a repo snapshot
  tarball into the **jailed files workspace** (`files/github/<owner>/<repo>`)
  — a pure-Node tar extractor that accepts regular files only (no
  symlinks/links/devices), rejects `..`/absolute paths, and caps files,
  per-file size and total bytes. Snapshots are data: **never executed** —
  so "code found in a fetched repo" trivially has no access to secrets,
  other skills, or anything outside the jail.
- **Notification poller → attention monitor** (3-min tick, first poll
  primes silently so connecting never spams): mentions, review requests and
  CI activity route through the shared `ingestAttention` scoring (hot
  reasons +1) into the existing proactive-notification system.
- **Auth**: fine-grained PAT in Settings → Integrations (`ghToken`, `GH_TOKEN`
  env fallback) — masked by the settings redactor, never logged (test-proven).
  **Instant revocation**: `/api/github/disconnect` clears the token + caches
  (`gh.disconnected` event + toast); the skill reads the token per request so
  clearing it anywhere disables everything on the next call. Offline caches
  apply **only while connected** — never after revocation.
- **Client-side rate limiter**: 20 req/min + 500 req/h — far under GitHub's
  own limits; poller is a single request per tick.
- **Audit**: every executed write → in-skill ring (last 100) + `gh.write`
  tamper-evident event (user, action, repo, target, result).
- **Outage degrade** (vendor-risk note in FAILURE_MODES.md): honest
  "GitHub looks down — nothing was changed" + cached reads labeled with
  age; hub and all other skills unaffected.
- Routes: `GET /api/github/status` (connected-as, rate budget, cache sizes)
  and `POST /api/github/disconnect`. Settings → Integrations gains the GitHub
  token field, live status line and one-tap **Disconnect GitHub**.
- `tools/test-github.js` — 33 checks: load/flags, scope-minimal tool shape,
  token never logged + masked, all reads, traversal/SSRF rejection *before*
  HTTP, rate-limit cap, poll prime + hot routing, outage cache vs instant
  revocation, the full park→confirm flow through the real orchestrator
  (parked / unrelated reply consumes / explicit yes executes exactly once /
  injection-shaped park), audit trail, tar-jail, intents.

### Changed

- `registry.tool()` threads each tool's `confirm` flag to the dispatcher;
  `_dispatchTool` parks writes with `confirm:'always'` even with no
  untrusted read, with owner-facing wording distinct from the injection
  warning (hardening change — nothing loosened).
- `/api/attn` ingest refactored into a shared `ingestAttention()` used by
  the route and the GitHub notifier (response shape unchanged).

---

## v0.10.0 — Adaptive Learning & Personalization Layer (2026-08-28)

Theme: *MAX learns you — locally, inspectably, and never inside the trust
boundary.* Full design doc: **`PERSONALIZATION.md`**. **332 checks across 16
suites, all green** (35 new learning checks; all previous suites re-run).

### Added

- **Signal pipeline** (`hub/learn.js`, `Learner` wired in `server.js`,
  hooked in orchestrator `_finish`): every finished turn emits a
  metadata-only signal `{ts, user, skill, hour, dow, sentiment}` into a
  bounded 2,000-entry ring pruned by the existing `logRetentionDays`
  retention rule. **Raw utterance text is never persisted** (regression-
  tested with a canary string). Capture stops entirely when the new
  `privacy.learning` toggle is off.
- **Five models**, all small local JSON, zero dependencies, no LLM
  fine-tuning:
  - **Routine learner** — hour-of-week occupancy per user+skill; surfaces a
    *pending suggestion* (never an action) only after ≥4 repeats across ≥2
    weeks and ≥3× the user's baseline occupancy. Suggestions ride the
    existing proactive-notification opt-in with confirm / dismiss /
    **stop learning this** lifecycle (stop is permanent).
  - **Preference profile** — inspectable `topic → weight` dict (skill +
    keyword topics), capped at 1.0, weekly ×0.95 decay.
  - **Adaptive tone** — recent-vs-long-term sentiment EWMAs nudge the tone
    slider by **at most ±0.15** (hard drift cap), after 20+ signals; wired
    into the cloud system prompt via `learner.toneFor`.
  - **Correction-based re-ranker** — "no, I meant the bedroom light" twice
    within 2 minutes of the mistake learns `{from→to}` and steers later
    LLM-chosen tool arguments (`learn.rerank.applied` logged); **refuses
    sensitive skills permanently**.
  - **Anomaly detector** — hour-of-week histogram + Welford daily-rate
    baseline; a never-before-seen hour during a ≥3σ day raises a
    **review-only** flag into the existing security alert system
    (`security.anomaly` → `/api/alerts` + owner toast). It can neither
    block nor approve — ever.
- **Model registry & versioning** — all five models auto-checkpoint every
  200 signals (last 3 versions kept per model); one-tap rollback per model
  (`POST /api/learn/rollback`, `learn.rollback` event).
- **"What MAX has learned about me"** — new Settings card: routines with
  confidence + state + confirm/dismiss/stop, preference chips with per-item
  Forget, live tone drift, corrections with Forget, anomaly flags with
  Clear, model versions with Roll back, the guardrail constants, and a
  **learning-layer-only Reset** (`POST /api/learn/reset`) that leaves facts,
  notes, settings and memories untouched (and vice versa).
- APIs: `GET /api/learn`, `POST /api/learn/feedback|forget|rollback|reset`;
  `privacy.learning` toggle in Settings → Privacy.
- `tools/test-learn-models.js` — 35 checks covering pipeline hygiene, every
  model at AND below its threshold, drift clamps, sensitive-skill exclusion,
  cold-start guards, checkpoint/rollback, reset isolation, the toggle, and
  the orchestrator hook contract.

### Guardrails documented (per the build spec — critical, not skipped)

Routines ≥4 repeats / ≥2 weeks / ≥3× baseline · tone ±0.15 hard cap ·
re-rank 2-correction minimum + sensitive-skill exclusion · anomaly 100-
signal/7-day cold-start + z>3 composite + review-only flags · auth, locks,
payments permanently off-limits (structurally — the layer has no code path
into them). Full table in `PERSONALIZATION.md` §3.

---

## v0.9.1 — Lean Cloud Brain: fixes "cloud brain hiccuped" on free-tier OpenRouter (2026-08-28)

Theme: *the cloud brain degrades gracefully to a lean profile when an
OpenRouter account is credit/token-limited, instead of hiccuping on every
chat turn.* **296 checks across 15 suites, all green.**

### Root cause (evidence-based)

The user's repeated complaint — *"when I say something it says my cloud
brain hiccuped while vision works fine"* — traced to free-tier OpenRouter
account limits, not a MAX bug per se: vision/describe calls are tiny and
pass, while the full chat payload (system prompt + 25 tool schemas +
history ≈ 2,290 prompt tokens) exceeds the account's remaining balance and
every attempt returns **402**. Verified with live probes: tiny prompts →
200; full chat payload → 402. Max never showed the real reason until now.

### Added

- **Token-limit parser** (`tokenLimitDetail` in `hub/orchestrator.js`):
  understands **both** 402 shapes seen live —
  `Prompt tokens limit exceeded: <needed> > <limit>` *and*
  `...requested up to <N> tokens, but can only afford <M>` (credits nearly
  exhausted; this second shape was discovered during live verification with
  the account at ~300 tokens of remaining balance).
- **Lean retry cascade** (`_llm`): on a credit-limit 402 the cloud brain
  retries **in the same turn** as `cloud-lean` — no tool catalog, no
  history, short safety-keeping system prompt — and, if even the output
  budget doesn't fit, once more with `max_tokens` clamped to what the
  account says it can afford (`min(150, afford-10)`). Bounded to 3 hops,
  never an infinite loop.
- **30-minute lean window**: after the first 402, turns start lean directly
  (no doomed full-size round-trip each turn); any full-size success clears
  the window (credit topped up). While the window is active, **deterministic
  skill intents run locally first** — the tool-less lean chat brain used to
  swallow commands like "what time is it"; now the real clock/timer/smart-
  home skills answer them and only true chat reaches the lean LLM.
- **Honest, specific fallback messages**: if even the clamped lean request
  can't fit, the user hears the real reason and the fix — *"…just about out
  of credit — it could only afford 298 tokens for a reply. Add credit at
  openrouter.ai/settings/credits (or set Settings → Cloud model to a free
  one)…"* — instead of a generic hiccup. Same for the prompt-cap shape.
- `llm.lean` event (kind: prompt | max_tokens | clamp) in the event log
  (key-scrubbed as always), so Systems/logs can show what happened.
- **`tools/test-lean.js`** (12 checks): parser both shapes, same-turn lean
  retry, no tool catalog in lean, lean window + clearing, clamp math,
  double-failure honesty, end-to-end via mocked `_chat`.
- Status/systems wording updated to cover both credit-cap shapes.

### Fixed

- Test-infra flake: `test-systems.js` moved to port 8117 with a free-port
  pre-bind poll (was colliding with `test-injection.js`'s mock server on
  8112 → intermittent `EADDRINUSE` chain failures).

---

## v0.9.0 — Feature Pass: Voice, Control, Creation, Home, Interfaces, Productivity, Extras (2026-08-25)

Theme: *Jarvis-grade features as tool/skill modules on the existing brain —
zero new npm dependencies, zero new LLM providers, every Round 1–6 hardening
measure preserved.* **284 checks across 14 suites, all green** (incl. the
Round-3 chaos injections and all pentest suites re-run after this pass).

This spec referenced a different codebase state in places; adaptations are
listed at the end honestly rather than silently faked.

### Added

- **Wake words** — shared matcher (`web/js/wakeword.js`, Node-testable):
  "max" primary (with hey/ok/hi/hello prefixes), plus bare "hey"/"hi"/"hello"
  as catch-all triggers **only as short full utterances** — the false-positive
  tuning is in the matcher table, tested.
- **"terminal" / "open terminal"** (`hub/skills/terminal.js`, priority 10):
  deterministic intent, never touches the LLM, returns the dashboard-open
  action — the **only** programmatic dashboard-open in the codebase (nav
  links removed; self-link on the page kept; boot auto-launch: none). Three
  dedicated regression checks.
- **Desktop skill** — high-risk file management under a jailed root
  (`MAX_FILES_ROOT`, default `files/`): `sensitive: true` (every call,
  including reads, requires fresh voice verification — the strictest gate in
  the system), traversal/symlink-escape defense, size caps, no execution.
- **Browse skill** — read-only page fetching: SSRF-guarded (http(s) public
  hosts only), HTML→text, declared `sideEffect:'read'` so output is wrapped
  untrusted and Round-5 rules make page content incapable of triggering
  actions. Zero-dep (fetches; docs note the optional Playwright adapter).
- **Create skill** — real files on request: **PDF via a built-in pure-Node
  writer** (zero dep), Word `.docx` via python-docx when present (Markdown
  fallback), `.pptx` via python-pptx when present (self-contained HTML deck
  fallback), static websites served at `/sites/<slug>/` (jailed, HTML-only).
- **Flights skill** — "flights overhead ‹city›" (OpenSky, **no key**) and
  "flight status XY123" (AviationStack **free-tier** key, optional).
- **YouTube skill** — video info (public oEmbed, no key) + best-effort
  caption scrape grounded summaries through the existing brain.
- **Discord bridge** — send via REST; inbound 60 s REST poll of the
  configured channel → app-socket notify. Bot token lives in
  `integrations.discordToken` — a **service credential**, masked in settings
  readbacks, never logged, never near the LLM keyring.
- **Attention monitor** — `POST /api/attn` ingest for email/message/webhook
  bridges; keyword scoring; surfaces only when **proactive notifications are
  opted in** (tested both ways); `GET /api/attn` list (last 50).
- **Meeting assistant** — `meeting.html` (browser-side STT capture, lines
  only leave the device on explicit Save) + meeting store + one-tap
  "notes + action items" via the existing brain.
- **Startup briefing** — opt-in (Settings): first connect of the day asks
  for the daily briefing through the existing briefing skill.
- **Max Remote** — dashboard retitled/rebranded; **server-side PIN gate**
  (`features.remotePass`, masked; `POST /api/remote/unlock`, timing-safe,
  6/min); **live activity feed** (`/api/activity` — sanitized, transcript-
  free "what MAX is doing"); **Home panel** (`/api/home/devices` inventory;
  taps route through the full voice pipeline so locks/garage stay gated).
- **Screen reading** — one-shot screen describe on the Vision page; off by
  default (Settings), display capture always released immediately, ring's
  `vision` state marks activity.
- **Drop-in brand assets** — `assets/logo.png` / `assets/background.png`
  auto-applied on every page (served by a jailed route); defaults silently
  used when absent (404 fallback).

### Adaptations (spec ↔ this codebase)

- **"Brahma" dark skin / "re-skin to Baymax"**: this codebase has only ever
  shipped the cream/coral Baymax theme — verified, and a test asserts no
  Brahma strings anywhere. Nothing to remove.
- **"Task Workspace 8 % bug"**: no Task Workspace feature exists here; the
  reported class of bug (concurrent voice session stalling task progress) is
  covered by a new regression test (session + concurrent requests all
  complete; hub stays healthy).
- **"Gesture hijack bug"**: no cursor-control code has ever existed here;
  the regression test asserts gesture/screen flags default OFF and no
  mouse-control code exists anywhere.
- **Gemini Live**: not configured in this deployment and would be a **new
  LLM provider** — held back per the "tools update, not LLM update"
  constraint (design-level flag; the OpenRouter 3-key rotation + browser
  STT/TTS pipeline already covers primary/fallback voice).
- **Playwright**: would break the zero-dependency rule on Pi; browse ships
  with the guarded zero-dep reader and documents the adapter point.
- **Mouse/keyboard OS control**: deliberately **not** implemented — it needs
  native deps and is the single worst capability to bolt on; documented as
  design-level (app open/close already exists; files go through the jailed
  desktop skill).

## v0.8.0 — Jarvis Mode & the Systems Blocker Layer (2026-08-25)

Theme: *feel like Jarvis — and always know exactly what's blocking what.*
New `GET /api/status`, new `web/systems.html`, opt-in Jarvis persona.
**245 checks across 13 suites, all green.** No existing behavior changed:
the persona is opt-in (default off); every other addition is a new page,
a new endpoint, or a new navigation link.

### The blocker layer (the point of the release)

- **`GET /api/status`** — one honest machine-readable answer: brains
  (cloud key count + last rejection status, e.g. 402 = out of credit;
  local Ollama probed live with a 600 ms bound), security posture
  (MAX_TOKEN/satellite token/alert webhook/lockdown state/enrollment),
  satellites, backups, privacy — plus `needs[]`: a prioritized blocker list
  (`blocked`/`warn`/`info`), each with a human `what` and `fix`. Payload is
  tested to contain no secret-shaped material.
- **`web/systems.html` ("Systems")** — Jarvis-style readout page grading
  **16 capabilities** ✓/⚠/✗ with the *reason* and the *fix* each: hub link,
  realtime WS probe, secure context, embedded-preview sensor block, mic
  (permission policy state), speech recognition, wake word, cloud brain,
  local brain, camera, voice output (TTS voices), notifications, voice
  verification (+active freezes), satellites, backups, API guard. Verdict
  header ("All systems nominal." / "N systems need attention."), hub-reported
  blockers card, auto-refresh every 30 s. Linked from every page's nav.

### Jarvis persona (opt-in — Settings → Jarvis mode)

- Time-of-day first greeting each session ("Good evening."), spoken, and
  **status-aware**: if `/api/status` reports blockers, MAX says how many
  systems need attention and offers an "Open Systems" toast (deep link).
- Status lines take Jarvis phrasing ("At your service.", "Working on it…").
  Pure client-side (localStorage), per-device, no server change; turning it
  off restores the exact previous lines.

### Tests — `tools/test-systems.js` (15 checks)

Status shape, each blocker class firing (no-keys/token/backup), Ollama
probe honesty (unreachable ≠ guessed), enrollment flip visible, secret-free
payload, systems.html script parses + rows exist, Jarvis hooks present, and
index/settings inline scripts still parse after the edits.

## v0.7.2 — Patch: stuck-listening + lost-reply fixes (2026-08-25)

User-visible: speech could capture nothing with the ring stuck on
"listening…" forever, or a request could vanish with no reply.

- **Stuck listening fixed.** Chrome doesn't guarantee `onend` after
  `onerror`, and a dead speech service or silent/muted input device can sit
  in "listening" with zero events indefinitely. The recognizer now always
  resets the UI on error, bails out after **12 s of total silence** with a
  "check the mic isn't muted / right input selected, or type instead" toast,
  and a synchronous `start()` throw resets state and says why.
- **Wake-word/mic conflict fixed.** Tapping the ring while wake-word mode was
  on started a second recognizer fighting `wakeRec` for the mic (silence,
  aborted); the wake recognizer is now parked first and resumes afterward.
- **Lost replies fixed.** Utterances sent over a half-open WebSocket could be
  swallowed with no response; if no reply arrives within **15 s** the client
  retries once over HTTP (`"No reply heard — retrying…"`), and a failed
  `ws.send` falls through to HTTP immediately.

## v0.7.1 — Patch: embedded-preview mic/camera guidance (2026-08-25)

User-visible: tapping the mic (or enabling the camera) **inside an embedded
preview iframe** used to fail with a misleading "click the lock icon → allow"
hint — but iframes without a microphone/camera permission grant can't even
show that prompt, so the button looked dead.

- The app now detects the case (`iframe` + Permissions-Policy denies
  `microphone`/`camera`) and says the actual fix: *"This embedded preview has
  no microphone permission — open MAX in its own browser tab,"* with an
  **"Open full tab ↗"** toast action. Applied to push-to-talk, wake word,
  the voice-verify drawer (mic + liveness capture), and the vision page.
  No behavior change in normal tabs; no server changes.

## v0.7.0 — Round 6: Physical & Network Security (2026-08-23)

Theme: *harden against physical + network-level attack.* New
`tools/test-physical.js` (**15 checks**) and `NETWORK_SECURITY.md`
(segmentation guidance, mutual-auth design, attack-surface audit; marks
implemented vs. physical-world recommendations). Suite total: **230**.

### Implemented + tested

- **Mutual hub↔satellite auth**: satellites already proved themselves with
  `SATELLITE_TOKEN`; now the hub proves itself back — the `satellite.welcome`
  carries `proof = HMAC_SHA256(token, id|ts)` (timing-safe verify), and the
  ESP32 firmware (reference implementation, mbed TLS) **ignores commands from
  any hub that can't prove the token**. Open mode (no token) stays explicit +
  loudly logged.
- **Satellite swap/tamper visibility**: per-id network fingerprints persist
  in a new encrypted store; a familiar id arriving from a new address fires
  `satellite.swap` → dashboard alert + optional webhook (alert, not block —
  DHCP churn must not become a self-DoS).
- **Boot integrity manifest**: `scripts/integrity.sh write|verify` — SHA-256
  over all code files; tamper test proves a one-byte change fails loudly.
- **Attack surface audit, proven**: the hub process listens on exactly one
  port (test scans the pid's sockets); no hardcoded real-shaped credentials
  anywhere (automated scan in the suite).
- **Secure disposal**: `scripts/decommission.sh` — dry-run shows the plan,
  `--yes` destroys `data/` + `backups/` (with the honest flash-media caveat
  and `esptool.py erase_flash` instructions for satellites).
- Firmware hygiene: split `HUB_TOKEN` (endpoint auth, MAX_TOKEN) from
  `SAT_TOKEN` (pairing + hub proof) — the docs had conflated them.

### Documented (needs router/hands-on hardware) — in NETWORK_SECURITY.md

IoT-VLAN/guest-network segmentation recipes; Pi read-only-rootfs secure boot;
satellite OTA stays **off by default** with the exact signing recipe required
before enabling; physical tamper-evidence notes.

## v0.6.0 — Round 5: Adversarial AI & Prompt Injection (2026-08-23)

Theme: *MAX's brain reads untrusted content — keep that content from driving
the body.* New `tools/test-injection.js` (**12 checks** against a mock,
manipulated LLM + tripwire Home Assistant) and `PROMPT_INJECTION_TESTS.md`.
Suite total: **215**.

### Structural changes (not prompt-wishing)

- **Trusted/untrusted channel separation** (`orchestrator._dispatchTool`,
  shared by cloud + local brains): read-tool outputs enter the transcript as
  `<<<UNTRUSTED_DATA>>>` and flip the loop's `sawUntrusted` flag. Any **write**
  tool call after that is **parked** (`pendingConfirm`, 60 s, one-shot) — it
  executes only if the owner says "yes" on the trusted channel; "no" or an
  unrelated reply drops it. Sensitive tools remain voice-gated regardless;
  untrusted text can never mint `ctx.verified` (unchanged invariant, re-tested).
- **Intent/argument validation**: every LLM tool call is schema-validated
  before a skill sees it — required params, types, enums; hallucinated keys
  stripped; unknown tool names rejected as `unknown tool`. Violations log
  `injection.guard` events.
- **In-skill auth gates now end the turn**: tools returning `{verify}` /
  `{locked}` (smart_home's internal lock gates) surface as user-facing gate
  messages instead of being fed back to the model as JSON to narrate.
- Defense-in-depth: system prompt marks tool-result text as data, never
  instructions (supplement only; the boundary is code).

### Real behavior changes (user-visible)

- "Read my note and do what it says"-style flows now produce: *"something in
  content I fetched is asking me to X — do YOU want me to? Say yes or no."*
  Legitimate read-then-write flows gain one confirmation step; tool-free
  chat, direct commands, and offline intents are unchanged.

## v0.5.0 — Round 4: Privacy & Data Governance (2026-08-23)

Theme: *map every piece of personal data, minimize it, give the owner real
control.* New `DATA_MAP.md` (17 categories: created/stored/retention/access/
leaves-device) and `tools/test-privacy.js` (**20 checks**). Suite total: **203**.

### New owner controls

- **"My Data" view** — `GET /api/mydata?user=` returns every category with
  counts and items; Settings gets a **"My Data" card** listing them live.
- **Export** — `GET /api/mydata/export?user=` downloads the full JSON copy as
  an attachment (`privacy.export` audit event).
- **Per-category delete** — `POST /api/mydata/delete {user, category}` for
  facts, preferences, voiceprint, sessions, notes, finance, calendar, vehicle,
  schedule, stats, plus whole-profile. Deletes are real store surgery with
  immediate save; the response includes the post-delete view, and the test
  suite **re-exports to prove the bytes are gone** (not hidden from the UI).
  Visible confirmation via dashboard alert + `privacy.delete` audit event.

### Retention cuts (Priority 2)

- **Event log now ages out**: entries older than `privacy.logRetentionDays`
  (default **30**) are pruned at boot and hourly, on top of the existing 4 MB
  rotation. Previously logs lived forever-enough (size cap only).
- **Sensor snapshots expire**: satellite readings older than
  `privacy.sensorTtlHours` (default 24) are dropped hourly (they were
  count-capped but immortal before).
- Confirmed no-ops: camera frames never touch disk; raw audio never leaves
  the browser; transcripts stay RAM-only (12 turns / 2 h) unless transcript
  logging is explicitly enabled; schedule one-shots already prune 24 h after
  firing. Notes/facts keep no auto-expiry by design (RAG/personalization
  require them) — they are owner-deletable per category, which is the control
  that matters; documented in DATA_MAP.md.

### Consent posture (verified, documented in DATA_MAP.md)

Mic is tap-to-talk (no always-listener), camera three-way default-off,
location toggle off, transcript logging off. **No financial or health
integrations exist at all** — no tokens, no scopes, no dormant collection.
Calendar is a read-only ICS URL; no OAuth flows anywhere.

## v0.4.0 — Hardening Sprint, Round 3: Chaos Engineering (2026-08-23)

Theme: *break everything on purpose; verify the system degrades gracefully and
visibly instead of catastrophically.* New `tools/test-chaos.js` — **39 live
failure-injection checks** (boots real hubs, SIGKILLs them mid-flight, freezes
the event loop with SIGSTOP, poisons the network layer, fills disks, rolls
clocks). Suite total: **183 checks across 9 suites**. Full matrix:
`FAILURE_MODES.md`.

### Failure modes now handled (were silent or fatal)

- **Corrupt stores self-heal.** Every `SecureStore` save now also maintains a
  `.bak` copy: a garbled main file is recovered from it (zero data loss,
  regression-tested), and only when *both* are unreadable does the store
  quarantine the wreckage to `*.corrupt-<ts>` (evidence preserved, never
  silently overwritten) and start fresh so the hub always boots. Torn `.tmp`
  files from crash-interrupted writes are swept at load.
- **Dead/full disk at boot → RAM-only degraded mode.** Previously an
  unwritable `data/` dir killed the hub *at boot* (found by chaos test — the
  very first dead-disk injection hung/crashed startup via EventLog's
  unguarded mkdir). Now: loud console + event-log notices, chat keeps working,
  writes fail visibly with a clean `EDEGRADED`. EventLog itself falls back to
  console-only logging.
- **Disk-full during operation is now visible:** `SecureStore.onError` (wired
  in the server) turns failed debounced saves into `store.save.fail` events +
  a dashboard alert instead of a stray console line.
- **Actuators confirm or stay silent (fail-safe).** Locks and the garage now
  **re-read real device state after every command** and only claim success
  when Home Assistant reports it. A jammed lock whose command was ACKed now
  gets *"I can't confirm … please check it physically — treating it as NOT
  unlocked"* plus an `actuator.unconfirmed` event. "Unlocked" is never claimed
  on ambiguous state — the exact fail-open pattern this round exists to kill.
- **Security lockdowns survive power cuts.** The freeze stamp is now persisted
  *synchronously* and re-checked after restart (previously in-memory only —
  the Round 2 leftover). Chaos test: SIGKILL the hub the instant the lockdown
  response lands → still locked after reboot. **A crash can no longer lift a
  lockdown.**
- **Clock skew fails closed.** Verify tokens + liveness challenges moved to
  `hub/tokens.js` with an issuance window: an NTP rollback past issuance makes
  tokens invalid (rollback can never extend a token's life), and forward jumps
  just expire them early.
- **Stale-state hygiene (nothing waits forever):** sessions are capped at 200
  with a 2 h idle reaper; multi-turn `pendingTask`s now carry a 10-minute TTL
  (a walk-away task used to hijack your next utterance days later); the
  scheduler refuses a 501st live job; `/api/health` exposes `sessions` and
  `pendingTasks` gauges for leak-watching.
- **Downtime ≠ reminder storm:** 120 overdue one-shot jobs fire exactly once
  each (tested), recurring jobs reschedule forward — no catch-up loops.

### Verified already-safe (regression-locked, no fix needed)

- Dead cloud at boot: deterministic skills unaffected, calm fallback; garbage/
  truncated/500 LLM replies → same fallback; brain re-joins `cloud` mode the
  moment the outage clears, no restart.
- Calendar/weather/smart-home/vehicle integrations under a poisoned network
  layer: honest messages, zero crashes, zero false success claims.
- Satellite partition: offline event + queued commands flush on re-pair;
  firmware reconnect backoff re-reviewed.
- Corrupt skill file: registry isolates it and boots the 17 healthy skills.
- Crash-loop supervision: `supervisor.sh` restarted a deliberately crashing
  hub ≥3× in 3.5 s with capped backoff (`MAX_SERVER_CMD` now parametrizes the
  supervised command for exactly this kind of test).
- **Event-loop wedging, injected for real:** `SIGSTOP` freezes prove the
  watchdog logs `watchdog.stall` and recovers from a one-off freeze *without*
  restarting, while sustained starvation (3 consecutive late beats) exits for
  the supervisor when `MAX_WATCHDOG_EXIT=1`. New tunables:
  `MAX_WATCHDOG_BEAT_MS` / `MAX_WATCHDOG_LAG_MS` / `MAX_WATCHDOG_STALLS`
  (defaults unchanged: 5 s / 10 s / 3). Was the last code-review-only row.
- Net-probe URL is overridable (`MAX_NET_PROBE_URL`) so private-WAN hubs and
  test rigs don't depend on reaching open-meteo to decide "online".
- STT/TTS absence in the browser: guarded code paths confirmed (typed input
  and visual replies keep working).

### Migration notes

- **No breaking changes.** `hub/tokens.js` internalizes verify-token and
  challenge storage (same wire behavior; all 53 security + red-team checks
  pass unchanged). The only intentional behavior change: success messages for
  locks/garage now end in "— confirmed", and ambiguous actuator outcomes say
  so loudly instead of bluffing success.

## v0.3.0 — Hardening Sprint, Round 2: Red Team & Depth (2026-08-23)

Closed Round 1's residual-risk backlog, then red-teamed the Round 1 fixes with
**29 live attacks** (`tools/test-redteam.js` — three real breaks found and
fixed, all regression-tested; full findings in `SECURITY.md` §10). Suite now:
**34 module checks · 24 security · 7 offline · 7 backup/restore · 29 red team ·
20 highlight · 20 apps · keyring rotation — 142 green checks**, plus a real
load test (`tools/load.js`).

### Security

- **Voice liveness (challenge–response).** `/api/voiceprint/verify` now
  requires a fresh server-issued challenge (`GET /api/voiceprint/challenge` —
  random 3-word phrase, 75 s TTL, single-use, consumed even on failed
  attempts) *and* the spoken phrase (≥2 of 3 words, browser STT) in addition
  to the spectral voiceprint score. A static recording of your passphrase no
  longer verifies — the words change every time. The web verify drawer now
  shows the phrase, listens for it, and handles locked/phrase-mismatch/no-
  enroll states. *(User-visible change — see Migration notes.)*
- **Lockdown & freeze, end-to-end:** 5 verify failures in 10 min (or 8
  privileged denials) freeze sensitive actions for 15 min — verify returns
  `{locked, retryAfterSec}` and **both** the orchestrator gate *and*
  smart_home's own lock/garage/`home_control` paths return a calm "frozen"
  message. Dashboard alert + optional `MAX_ALERT_WEBHOOK` ping
  (`security.lockdown` event). **Red-team fix #2:** previously the skill's
  internal checks returned the normal "please verify" prompt during a
  lockdown — nothing opened, but the freeze never surfaced.
- **Secret-file fence in the dev skill (red-team fix #1):** `cat`/`head`/
  `tail`/`wc`/`ls`/`explain` of `.env`, `data/`, `.master.key` are refused at
  the `safeJoin` choke point — Round 1 had only fenced them inside the
  `node -e` runner.
- **Kernel sandbox floor for `node -e`:** scripts now additionally spawn with
  Node's `--experimental-permission --allow-fs-read=<repo source dirs>` — the
  kernel denies writes everywhere and `spawn()` anywhere
  (`ERR_ACCESS_DENIED`, verified on v20.20.2), even if the agent-layer module
  guard is bypassed.
- **User administration is owner-gated:** once any voiceprint is enrolled,
  `POST /api/users` (add user, clear guest/kid flags) requires a fresh owner
  `verifyToken` → guests/strangers can't mint or promote profiles (fake and
  borrowed tokens → 403, tested).
- **Per-IP+user voiceprint rate keys (red-team fix #3):** verify/challenge
  buckets key by `ip|user`, so a parallel brute-force burst (24 in flight is
  the test) is throttled without starving other voices on the same LAN/NAT.
  Verify limit raised 5/min → 20/min — the 5-fail lockdown is the real brake.
- **Sandbox/skill hardening additions:** satellite registry capped at 64
  nodes; settings `deepMerge` depth-guarded at 32 (5000-deep object no longer
  risks the stack); `memory.addFact` strips control chars and caps facts at
  400 chars; voiceprint `delete` endpoint added.
- **Owner data controls (data minimization):** `POST /api/data/wipe` clears
  memory/facts/prefs, usage stats, sessions, verify tokens, in-flight
  challenges, scheduled jobs, and notes/finance/calendar/vehicle stores —
  while keeping settings and the event log. Settings page gets a real
  "wipe my data" switch and a per-user **"Forget voice"** button;
  `GET /api/memory` lets the owner view exactly what's stored.
- **Security alerting & runbook:** `GET /api/alerts?hours=` aggregates
  lockdowns, denials, verify failures, rate-limit hits, satellite
  rejects/disconnects, watchdog stalls, and SOS events (with a `firing`
  flag); logs page shows a "Security alerts" card. New
  **`INCIDENT_RESPONSE.md`** with concrete auto-actions and a manual runbook.

### Robustness

- **Backup & disaster recovery with a tested restore:** `scripts/backup.sh`
  (timestamped `.tar.gz`, chmod 600, explicitly excludes and warns about
  `data/.master.key` — back that up separately, once) and
  `scripts/restore.sh` (pre-parks current data, restores, re-encrypts key
  idempotently guarded). `tools/test-backup.js` proves a full
  backup→wipe→restore roundtrip plus torn-tmp dir, corrupt store, and
  wrong-key scenarios (7/7).
- WebSocket/utterance paths confirm Oversize-frame close behavior, depth
  bombs, `__proto__` API patches, NaN/oversize feature vectors, and garbage
  input fuzz across **every registered intent of all 18 skills** — nothing
  hangs (3 s watchdog per call).

### Performance (real numbers, `tools/load.js`)

- **Hot-path persistence debounce:** `SecureStore.saveSoon()` (250 ms
  coalescing + `beforeExit` flush registry) is now used by memory's
  ensure-user/add-fact/set-pref/count-intent paths; scheduler/key/voiceprint/
  settings saves stay immediate.
- Measured on this hub: utterance loop **26 req/s (p50 1144 ms, p95 1885 ms)
  → 62 req/s (p50 489 ms, p95 779 ms)**; sequential same-client p50 ~1–2 ms.
  Voice-verify, challenge, and dispatch numbers are printed by the same tool.

### Code quality / docs

- `SECURITY.md` v2: updated model + **§10 Red Team Findings** (what broke,
  what it exposed, the fix, the regression test) and refreshed residual risks.
- New `INCIDENT_RESPONSE.md`, `tools/test-redteam.js`, `tools/test-backup.js`,
  `tools/load.js`; `test-security.js` verify-limit case updated to the new
  per-user limit (25 calls, ≥4×429).
- Zero dependencies still; everything runs as-is on the Pi.

### Migration notes (breaking-ish, all server-side)

- **`POST /api/voiceprint/verify` now requires `{user, features, challengeId,
  spoken}`** — old clients posting only `{user, features}` get `400`. The
  bundled web UI is updated; third-party clients must fetch a challenge and
  include the spoken phrase first.
- Client-sent `verify: true` remains ignored (since v0.2.0) — no change.
- **`POST /api/users` returns 403 without `ownerToken`** once any voiceprint
  exists. Single-owner fresh installs are unaffected until first enrollment.
- The Settings "wipe" switch now calls `/api/data/wipe` (broader than the old
  behavior — it also clears sessions, schedules, and the four skill stores).
- Rate-limit keys for voiceprint endpoints changed shape (`ip|user`) —
  observability dashboards filtering on key format should adjust.

## v0.2.0 — Autonomous Hardening & Improvement Sprint (2026-08-23)

Full audit-and-hardening pass over hub, skills, firmware, and docs.
41 automated tests added/extended this session; total suite: **34 module
checks + 20 highlight + 20 apps + keyring rotation + 24 security + 7 offline**.

### Security

- **Closed a critical auth bypass**: `/api/utterance` (HTTP and WS) accepted a
  client-supplied `verify: true` as proof of voice verification — any LAN
  client could unlock doors. Verification now requires a server-issued,
  single-use, 5-minute `verifyToken` only. *(User-visible change: clients that
  relied on the flag are now asked to verify — intended, and regression-tested.)*
- **Closed a sandbox escape in dev mode**: `node -e` could `require('http')`
  or read `.env`. It now runs under a hardening prelude — network/child-process
  module blocklist (static scan + runtime loader guard), `import()` and
  `process.binding/dlopen` blocked, `.env`/`data/`/`.master.key` unreadable —
  and the full command tail is treated as the script (previously truncated at
  the first space).
- **Rate limiting** (`hub/ratelimit.js`): per-IP token buckets —
  voiceprint verify 5/min, enroll 5/hr, SOS 6/min, vision 20/min,
  utterance 45/min, settings/keys 30/min, system update 3/hr, API 300/min.
- **`home_control` garage bypass closed**: the tool path opened garage covers
  without the verification the intent path required; thermostat tool now
  validates 5–35 °C including NaN (found by new tests).
- **Prototype-pollution guard** in settings `deepMerge` (`__proto__`,
  `constructor`, `prototype` keys skipped).
- **Masked-readback protection**: a patch echoing masked secrets (single value
  *or array*) can no longer overwrite the real stored values.
- **Settings patch whitelist**: unknown top-level keys are dropped and logged.
- **Input bounding**: user ids sanitized (`[\w. ()-]{1,40}`, default fallback),
  profile store capped at 60 users, sensor cache capped at 100 sources × 50
  keys with typed values, vision question bounded to 300 chars, finance amounts
  finite/positive/≤10 M, `spend_summary` days clamped 1–366, satellite ids
  sanitized, voiceprint features shape-checked.
- **WS hardening**: 1 MB frame cap, 2 MB accumulation cap, 30 s ping with a
  90 s stale-client reaper.
- **Log hygiene**: string fields truncated to 300 chars; key-shaped values
  (`sk-*`, `ghp-*`, `xox*`, Google/JWT prefixes) scrubbed; satellite log
  messages bounded transitively via same path.
- **API hygiene**: internal error text no longer reaches clients (500s return
  a calm generic line; details stay in the private log).
- **Boot config validation** (`hub/config-check.js`): loud warnings for
  missing `MAX_TOKEN`, invalid timezone, partial Home Assistant config, cloud
  brain without keys, vision-cloud without keys, contacts-without-webhook, and
  self-update enabled without auth.
- **Satellite authentication**: optional `SATELLITE_TOKEN` — hellos carrying
  the wrong/absent token are rejected and logged; stray pre-hello sockets are
  closed after 10 s. Firmware sends the token when configured.
- **Secure update option**: `MAX_REQUIRE_SIGNED=1` requires a valid GPG
  signature on the update commit; post-pull fast-forward sanity check added.
- New regression suite: `tools/test-security.js` (24 tests, incl. the
  verify-bypass, sandbox escape, gate matrix, pollution guards, rate limit,
  transcript hygiene).
- `SECURITY.md` added: threat model, coverage, residual risks.

### Robustness

- **Offline fallback is now test-covered**, not assumed: `tools/test-offline.js`
  boots a hub with no keys/Ollama and proves timers, clock, notes, skill
  listing, graceful weather failure, calm gibberish fallback, and hub health.
- **Retry/backoff** (`net.httpRetry`) adopted by Home Assistant, weather,
  search/news, and calendar ICS fetches (2 retries, linear backoff; SOS
  deliberately stays single-shot and fast to avoid delays in an emergency).
- **Watchdog**: event-loop stall detector logs `watchdog.stall` (exits for
  supervised restart after 3 consecutive stalls when `MAX_WATCHDOG_EXIT=1`);
  `scripts/supervisor.sh` provides capped-backoff restarts (5/min circuit
  breaker); `npm run start:supervised` added.
- **Memory-store write safety** re-verified: atomic tmp+rename on every
  SecureStore save; session state is RAM-only as designed.

### Performance & polish

- No new dependencies (still zero — supply-chain surface unchanged).
- Theme sweep: all pages confirmed on the Baymax palette/vars; no drift.
- A11y: Ollama status line is now `role="status"`/`aria-live`; new controls
  carry labels; sensitive-action 429/error text rewritten in calm tone.
- `package.json` → v0.2.0, `npm test` runs the full suite.

### Code quality

- `hub/ratelimit.js`, `hub/config-check.js` extracted as focused modules.
- Field-limits docs (`SECURITY.md`, README local-run section) and honest
  comments where behavior is non-obvious (prelude, gate matrix, masked-readback).
- Satellite firmware (`max_satellite.ino`) hello handshake documents/sends the
  optional auth token — wire format is backward-compatible (older hubs ignore
  the field; older satellites work when no token is configured).

### Migration notes

- If any custom client sends `verify: true` to unlock sensitive actions, move
  it to the voiceprint flow (`POST /api/voiceprint/verify` → pass returned
  `token` as `verifyToken` with the action).
- Older satellites continue to work; to enforce satellite auth, set
  `SATELLITE_TOKEN` on the hub *and* the firmware `HUB_TOKEN` (already plumbed
  into the WS URL and now the hello payload).

## 2026-09-04 — verification and runtime-layout repair

- Restored the executable tree layout expected by runtime imports and tests.
- Fixed `.env` resolution for the root-level project layout.
- Fixed allowlisted developer commands failing to locate `node` because the child environment had no `PATH`; secrets remain excluded.
- Corrected the key-rotation regression fixture so connectivity probes are not counted as LLM requests.
- Registered the preferences skill and repaired satellite/web asset paths.
- Full local `npm test` pass: 23 suites/check groups passed with 0 failed assertions.

## 2026-09-08 — Step 2 identity and credential hardening

- Added placeholder OpenRouter-key rejection so copied `.env.example` values cannot masquerade as configured credentials.
- Removed residual `max.*` browser persistence namespaces in favor of `jarvis.*`.
- Added regressions for credential placeholders and Jarvis browser-state identity.
