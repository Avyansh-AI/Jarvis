# Fresh Run Log — jarvis v1.0.7 / MAX v0.11.8 (2026-09-04)

Real-environment investigation on this machine (Ambāla, Asia/Kolkata): clean
checkout, fresh `.env`, cold start, live probes. Rule in force: nothing is
"fixed" without a test, a log line, or a reproducible live demonstration.

Environment for the fresh run: `/tmp/fresh-jarvis` (byte-copy of the repo at
hunt start), its own `data/`, its own freshly written `.env` (from
`.env.example` + the real keys), port **8122**. The installed hubs stayed up
throughout: Jarvis :8080, MAX :8090 — zero interference observed.

---

## 1) OpenRouter keys → `.env`-only (jarvis-only policy change)

| Requirement | Evidence |
|---|---|
| Key fields removed from desktop settings + remote dashboard | `grep` of `web/settings.html` / `web/dashboard.html`: zero key inputs, zero key-management fetches; settings keys card is now a static note pointing at `.env` (suite: `test-jarvis` J13) |
| Read exclusively from `OPENROUTER_KEY_1/2/3` | `hub/keyring.js` `loadKeys()` reads only `OPENROUTER_KEY_n` (n=1…16, rotation policy caps at 3); `effectiveKeys()` ignores the settings store (J14) |
| One-time migration of old storage | `hub/keymigrate.js` at boot: settings keys + legacy aliases folded into canonical slots (dedup, cap 3), legacy lines commented `# migrated ->`, settings copy purged, file written 0600, idempotent (J15; live: real `.env` now has 3 canonical slots + one commented legacy line) |
| Hard startup check naming the missing variable | partial rotation → `process.exit(1)` with `[config] ✗ OpenRouter rotation incomplete — missing from .env: OPENROUTER_KEY_2 …`; override `JARVIS_ALLOW_KEYLESS=1` boots with a LOUD warning + diag record (J16; boot readiness shows 8th check `cloud brain key rotation`) |
| Rotation re-tested after the change | `test-keyring` **PASS** — simulated 429 on key 1 → rotation `bad-key-1 → good-key-2`, sticky-good-key intact |
| `.env.example` updated | rewritten: `OPENROUTER_KEY_1/2/3` required, `JARVIS_ALLOW_KEYLESS` documented, all other vars annotated |
| Gemini key handling | **N/A — flagged, unchanged:** there is no Gemini key handling anywhere in the codebase. OpenRouter is the only cloud provider; `google/gemini-2.0-flash-001` appears once as an *example model id* in `.env.example` comments. Nothing to migrate. |

Live API proof after the change: `GET /api/keys` returns metadata only
(`{source:'env', model, count:3, slots:[…]}`), POST/DELETE → **410** with .env
guidance; a live cloud round-trip (`cloud-lean`) returned `pong` with the
canonical keys. MAX AI was deliberately untouched by this package.

## 2) Fresh, from-scratch bug hunt (this machine)

Timeline: staged `/tmp/fresh-jarvis` → fresh `.env` → cold start **7/8 boot
checks ok** (only the intentional `MAX_TOKEN`-unset warning) → systematic sweep.

### Findings (all fixed — see BUGS_MASTER.md for the full register)

- **F-01 (fixed):** `config-check.js` false-warned "no OpenRouter keys" with
  canonical keys set (checked legacy aliases only). Now consumes
  `keyring.loadKeys(env)`. Live-verified.
- **F-02 (fixed):** `.env` files were mode **644** (world-readable) on this
  machine → chmod 600 on both repos + fresh tree. (Suite never caught it — it
  tests that `.env` isn't *served*, which held; this was host hygiene.)
- **F-03 (fixed):** one cream/coral hex `#f3c4b6` (chip border in the learning
  transparency view) survived the re-skin inside an **inline JS style string**
  in `web/settings.html` — invisible to the theme.css sweep. Now `var(--line)`.
- **F-04 (fixed, shared):** "what is the weather like / in Paris" routed to the
  **search** skill (Wikipedia summary about the concept of weather!) because
  skills load alphabetically and `search` < `weather`. Live repro:
  `"what is the weather like"` → *"The Weather Makers: … a 2005 book…"*;
  `"weather"` → correct Ambāla forecast. Fix carves only the
  weather-as-forecast idiom out of search's who/what pattern — concept
  questions ("temperature of the sun", "weatherman") still reach search.
  Regression: `test-seams` **S17** against the real registry. Live after-fix:
  `"what is the weather like"` → *"In Ambāla it's 29 degrees with clear sky…"*.

### Verified clean (with evidence)

- **Zero startup errors** on the fresh tree (7/8 readiness; the 1 warn is the
  documented no-auth-LAN posture).
- **Wake matcher (live):** "jarvis / hey jarvis / JARVIS what time" WAKE;
  "max", "hey max", "jarv", "jarvisor" rejected.
- **Re-skin:** served `theme.css` contains the HUD tokens
  (`--hud-900:#02060E … --cyan:#3CE0FF`, scan-line field) and zero cream/coral
  values; all **8 ring states** (standby/listening/thinking/speaking/vision/
  alert/offline/error) styled in CSS **and** wired via `setState()` at runtime.
- **Widgets (live, rendered data):** weather *"28 °C clear sky … Ambāla,
  India"* (after home-city set; before that, honest "no city set"), clock
  *"3:00 AM Friday, September 4"*, devices honest-empty *"no smart home
  configured"*, activity shows real events. (Note: the devices probe path is
  `/api/home/devices` → `{configured:false, devices:[]}` — earlier 404s were
  my wrong probe URLs, not bugs; same for two manifest/icon probes I mistyped.)
- **Dashboard:** links `css/theme.css`, fetches its 7 GET endpoints, all 200.
- **Data isolation:** fresh tree created its own `data/.master.key` (600) and
  `settings.enc.json` (600); `events.jsonl` is plaintext *metadata* by design
  (DATA_MAP row 13) — not a bug.
- **MAX/Jarvis coexistence:** ports 8080/8090/8122 distinct, repos/data/zips
  distinct, only `.env` service credentials intentionally shared. No collision.

## 3) Personalization layer "isn't learning" — diagnosis → fix → proof

**Method (each step from the brief):**

1. **Verbose logging at signal capture.** Added `MAX_DEBUG=1`-gated
   `learn.debug` events (`hub/learn.js`), metadata-only by design (user, skill,
   hour, dow, sentiment, counters — raw text is never logged, audited live:
   utterance words appear in **0** debug lines). Fresh hub restarted with
   `MAX_DEBUG=1`: a 12-utterance conversation produced exactly **12**
   `learn.debug` events — data provably reaches the pipeline during a real
   conversation.
2. **Retention-vs-learning race check.** `_prune()` only filters the raw
   bounded signal ring (2,000-cap, `logRetentionDays`); every aggregate
   (routines, prefs, tone, anomaly, corrections) lives in separate structures
   and is never pruned. **No race.** (Suite check: pruning test still green.)
3. **Model update actually triggered?** Yes — per-utterance in
   `orchestrator._finish` → `learner.signal(…)` → four observers run every
   turn; auto-checkpoint every N signals. Not dead code — pinned by
   `test-learn-models` orchestrator-hook checks.
4. **Transparency view as evidence.** The view was empty in the routine
   section during early use — and that WAS a true signal, just not of a dead
   pipeline: **routine accumulation was never exposed** until a pattern crossed
   the full suggestion guardrails (≥4 repeats in the same hour-bucket × ≥2
   distinct weeks × ≥3× baseline). Plus models showed "v0" until the first
   checkpoint at 200 signals (~week+ of normal use). Looks exactly like
   "not learning."
5. **Minimum-signal threshold.** The suggestion guardrails are the
   anti-overfitting defense — kept intact (tune, don't gut). Tuned only the
   checkpoint cadence 200 → **100**, so the first model version lands within
   days. Suggestions still require 4 hits × 2 weeks × 3× baseline.

**Fix (shipped in lockstep to both repos — the code is shared):**

- `Learner.state()` now exposes **`emerging`**: sub-threshold routine progress
  per user — `{skill, bucket, hour, dow, n, weeks, needed:{hits,weeks}}`,
  top 8, noise floor n≥2, single-occurrence cells hidden, **stopped patterns
  never shown** (no shadow tracking).
- `web/settings.html` learning view renders **"Still learning (live
  progress)"** between the suggestions and the preference profile.
- Checkpoint cadence `CHECKPOINT_EVERY` 200 → **100**.
- `MAX_DEBUG=1` verbose capture logging (kept — it's the diagnostic the brief
  asked to add; off by default so zero production overhead).

**Before/after (fresh hub :8122, identical 12-utterance script —
`POST /api/learn/reset` before each run):**

| Metric (user `proof`) | BEFORE (pre-fix code) | AFTER (v1.0.7 code) |
|---|---|---|
| `signals.total` | 12 | 12 |
| `routines` (suggestions) | `[]` | `[]` — guardrails intact, nothing gutted |
| **`emerging`** | **key absent** | **clock 5/4 repeats · 1/2 weeks · weather 3/4 · reminders 2/4** |
| `prefs.topics` | skill:clock .5, skill:search .3(!), weather .3, … | skill:clock .5, **skill:weather .3** (F-04 fix visible in the data), weather .3, … |
| `tone.proof.signals` | 12 | 12 |
| `corrections` | office light → bedroom light ×1 | same ×1 |
| model versions | all v0 (first checkpoint at 200) | all v0 here (12 < 100); cadence check proves first checkpoint at signal **100** |
| `learn.debug` events | (feature absent) | **12**, one per utterance, metadata-only |

The reproduction script (12 utterances through the real hub):

```bash
for i in 1 2 3 4 5; do POST /api/utterance "what time is it"; done
for i in 1 2 3;    do POST /api/utterance "what is the weather like"; done
for i in 1 2;      do POST /api/utterance "remind me in 5 minutes to stretch"; done
POST /api/utterance "turn on the office light"
POST /api/utterance "no i meant the bedroom light"
GET /api/learn?user=proof
```

**Regression:** `test-learn-models.js` 35 → **46** checks (emerging visibility,
maturity hand-off, per-user scope, stop-list invisibility, debug gating,
metadata-only debug, 100-signal checkpoint) — green in both repos.

## 4) Post-change safety nets (re-run mandate)

- Failure-injection matrix: `test-chaos` — **39/39** green (both repos).
- Pentest checklist: `test-redteam` — **29/29** green (both repos).
- Full chains: jarvis **447 checks / 19 suites**, MAX **423 checks / 18 suites** —
  exit 0 both, zero FAIL lines (excluding the intentional loud-failure
  demonstration inside the integrity check, which asserts itself as `ok`).
