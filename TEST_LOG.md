# Jarvis — Full Regression Test & Fix Loop (TEST_LOG)

**Run:** 2026-08-30 · codebase v0.11.0 → v0.11.1 · 3 complete cycles
**Full pass =** `npm test` (18 suites after Cycle 1; 17 before) + targeted adversarial/seam review + live-hub smoke.
**Verdict:** exit condition met — Cycles 2 and 3 produced **zero new Critical/High** findings, and the one High found (H-001) has a passing regression test in the chain.

## Honesty box — what "tested" means per layer

| Layer | Method |
|---|---|
| Skill logic, trust gates, learning layer, confirm flows, store corruption, injection, rate limits | **Automated** — 386 checks/18 suites incl. fault injection + live mock servers (GitHub, Home Assistant, ICS, Ollama) |
| OpenRouter rotation/402-lean fallback | **Live-verified** against the real API with the owner's keys (limits observed: `Prompt tokens limit exceeded` and `can only afford` shapes) |
| GitHub API | **Simulated** by a faithful mock (request/response shapes, auth header, tar snapshots); NOT exercised against a real PAT — see CONFIDENCE_REPORT |
| Voice I/O (Web Speech API, wake word stream, TTS), camera/vision overlays, ESP32 satellites, Home Assistant devices, Discord bot delivery | **Code-reviewed + regression anchors** — needs hardware/browser (listed in CONFIDENCE_REPORT §manual) |
| "Gemini Live", "Playwright" (from the prompt) | **N/A — never existed in this codebase** (documented adaptations: zero LLM providers beyond OpenRouter/Ollama by constraint; browse skill is a fetch-based SSRF-guarded reader, no browser automation). Not silently skipped — explicitly out of scope-by-design. |

## Coverage map (scope → where it's verified)

| Prompt scope item | Verified by |
|---|---|
| Wake words / false positives | test-features #1 + **seams S7** (stress corpus) |
| OpenRouter fallback + 3-key rotation under rate-limiting | test-keyring, test-lean (13), live v0.9.1 evidence |
| "terminal" sole dashboard path | test-features + **seams S6** |
| Desktop control (apps/desktop skills, jailed files) | test-apps (20), test-security (24), test-redteam (29) |
| Browse skill — untrusted content can't trigger actions | test-injection (12) + github confirm parking (test-github) |
| Screen-read indicator, gesture default-off | test-features + **seams S8** |
| Content creation (PPTX/DOCX/PDF/site opens correctly) | test-features (31: file-signature + structure checks) |
| Smart-home failure behavior | test-chaos B5 (HA down → never claims success), test-injection (mock HA) |
| Interfaces: theme consistency, Jarvis Remote PIN/feed, Task Workspace stall | test-features (theme + remote + **concurrent-voice stall regression**) |
| Briefing, meetings, reminders, attention monitor | test-hl (20), test-apps, test-features |
| Discord/weather/flights/YouTube/search | test-features skills coverage + offline degrade (test-offline 7) |
| Asset swapping | test-features |
| ML personalization layer + "cannot influence security decisions" | test-learn-models (35) + **seams S3/S4/S13** |
| GitHub reads/writes/confirm/audit | test-github (33) + **seams S1/S10/S11** |
| Round-3 failure-injection matrix | test-chaos (39) — re-run green every cycle |
| Round-9 pentest checklist | test-redteam (29) — re-run green every cycle |

## Cycle 1 — baseline + seam exploration (2026-08-30)

**Step 1 — baseline:** `npm test` → **370 checks / 17 suites, 0 failed** (`CHAIN_EXIT=0`, log: /tmp/cycle1.log). No pre-existing failure anywhere.

**Step 2 — seam authoring (Priority-1 overlaps not covered by any suite):** wrote `tools/test-seams.js` (20 checks: confirm-vs-lean-window, confirm-in-hacking-mode, learner fault injection vs gates, dashboard-path scan, wake-word corpus, busy/expired sessions, lockdown+learning, verify-turn scrubbing).

### Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| H-001 | **High** (security/privacy) | Voice-verification attempts (the gate itself instructs *"Say 'verify me' and my passphrase"*) flowed through `handleUtterance` into the learning layer: passphrase words could bump preference topics and, paired with a follow-up correction, persist fragments into the encrypted learning store displayed in the transparency view. Credential material in a store it doesn't belong in. | **FIXED** (below) |
| M-01 | Medium | Parked-confirm slot is single: a second parked write silently replaces the first (fail-closed — never double-executes). | backlog |
| M-02 | Medium | `github_explore` buffers the whole tarball, *then* enforces the 8 MB cap — a huge repo spikes hub RAM (self-DoS, token-scoped to user's own repos). | backlog |
| L-01 | Low | Pre-lean-window, the tool-less degraded brain can answer tool-shaped questions confidently (observed live: "github status" → generic answer) — labeled `brain` tag; sensitive paths still gate. | backlog |
| L-02 | Low | Parked confirms are RAM-only: a hub restart silently drops a pending "are you sure?" (fail-closed; user re-asks). | backlog (document) |
| L-03 | Low | `/api/learn` exposes per-user learning state to any LAN client when `MAX_TOKEN` is unset — consistent with the documented no-auth LAN posture; worth a note. | backlog (document) |

### H-001 — fix + before/after

**Fix** (`hub/orchestrator.js`, `_finish`): verification turns are invisible to the learning layer — no text, no correction context, never seed `lastResolved`.

- **Before:** `node -e` harness → utter `"verify me quarantine zebra fjord 73"` then `"no i meant the bedroom light"` → learning store contained passphrase fragments (topic bump + pending correction `from`). REPRODUCED.
- **After:** same harness → `store.data` contains neither the words nor any correction (suite: **S5**, plus S5b: no pairing). **Pass.**
- **Live (v0.11.1 hub):** `POST /api/utterance "verify me harbor lantern cactus 51"` → `GET /api/learn` grep for those words = **0 hits**; normal turns still produce signals (count 7 ✓). **Pass.**

## Cycle 2 — full pass on fixed code (2026-08-30)

`npm test` (18 suites incl. new seam suite) → **386 checks, 0 failed** (`CHAIN_EXIT=0`, log: /tmp/cycle2.log).
Suite counts: check 44 · hl 20 · apps 20 · keyring PASS · security 24 · offline 7 · backup 8 · redteam 29 · chaos 39 · privacy 20 · injection 12 · physical 15 · systems 15 · features 31 · lean 13 · learn-models 35 · github 33 · **seams 20**.

Adversarial review notes (probes: pre-buffer cap, confirm-slot semantics, RAM-only confirms, verifyToken server-issuance) — 0 new Critical/High; medium/low items moved to backlog.

**New Critical/High this cycle: 0.**

## Cycle 3 — confirmation pass (2026-08-30)

`npm test` → **386 checks, 0 failed** (`CHAIN_EXIT=0`, log: /tmp/cycle3.log). Live-hub smoke on v0.11.1: health 26 skills ✓, github gate ✓, H-001 live regression ✓, learning signals ✓.

**New Critical/High this cycle: 0.**

→ **Exit condition met** (two consecutive clean full passes; H-001 regression pinned in-chain). No bug reappeared across cycles, so no structural-issue escalation was needed.

## Previously fixed bugs — explicit re-verification (Priority 2)

| Old bug | Where pinned | Cycle 1 | 2 | 3 |
|---|---|---|---|---|
| Task Workspace stall (voice-concurrent requests) | test-features "concurrent voice session + requests all progress" | ✅ | ✅ | ✅ |
| Gesture-control auto-launch (default-off) | test-features + seams S8 | ✅ | ✅ | ✅ |
| Screen-read without visible indicator | LS `screenShare` + UI marker (seams S8) | ✅ | ✅ | ✅ |
| Mic in iframe w/o permission / stuck-listening | index.html PP detection + watchdog (seams S9) | ✅ | ✅ | ✅ |
| Round-9 pentest Critical/High set | test-redteam (29) | ✅ | ✅ | ✅ |
| 402 cloud-brain "hiccup" on free tier | test-lean (13) + prior live evidence | ✅ | ✅ | ✅ |
| EADDRINUSE flake (port collision between suites) | test-systems port-poll design; 3 consecutive clean chains | ✅ | ✅ | ✅ |

Fix-by-disabling/narrowing conflicts: **none** — H-001 was fixed by scrubbing one data path, not by disabling verification or learning.

## 2026-09-04 pass — jarvis v1.0.7 / MAX v0.11.8

| Item | Proof | Unit/static | Live on this machine |
|---|---|---|---|
| .env-only OpenRouter keys (jarvis-only policy) | J13–J16, keyring rotation PASS under 429 | ✅ | ✅ (GET metadata-only, POST/DELETE 410, preflight exit(1) names missing var, cloud round-trip pong) |
| F-01 config-check stale key warn (jarvis) | loadKeys-sourced check | ✅ | ✅ fresh boot, zero false warn |
| F-02 .env 644→600 | host fix, keymigrate writes 0600 | ✅ | ✅ stat verified both repos |
| F-03 coral hex in settings.html (jarvis) | J2 palette sweep green; byte-level grep | ✅ | ✅ served page clean |
| F-04 "what is the weather…" → search shadowing | seams S17 real-registry routing (3 checks) | ✅ | ✅ live "what is the weather like" → Ambāla forecast |
| F-05 learning looked dead (accumulation invisible) | learn-models +11 (46 total) | ✅ | ✅ before/after 12-utterance run: emerging clock 5/4·1/2wk, weather 3/4, reminders 2/4; 12 learn.debug events, metadata-only |
| Checkpoint cadence 200→100 (first model version within days) | learn-models cadence checks | ✅ | ✅ guardrails.checkpointEvery=100 live |
| Chaos (failure-injection) re-run after changes | test-chaos | ✅ 39/39 both repos | — |
| Redteam (pentest) re-run after changes | test-redteam | ✅ 29/29 both repos | — |

Full chains: jarvis **447/19**, MAX **423/18** — exit 0, no unexpected FAIL lines.

## 2026-09-04 pass 2 — the brain layer: jarvis v1.0.8 / MAX v0.11.9

| Item | Proof | Unit/static | Live on this machine |
|---|---|---|---|
| Central diagnosis (what broke / cause / fix) every skill+brain routes through | test-diagnose (33) | ✅ | ✅ live dead-cloud turn: "The local model (Ollama) is not answering — Ollama is not installed … or say \"go hacking\"…" as a persistent chat answer, not an error toast |
| Tamper-evident audit log (HMAC chain anchored to .master.key) | test-diagnose audit block | ✅ | ✅ one-bit tamper → `{"ok":false,"brokenAt":6,"why":"content MAC mismatch"}`; 40 records @1200-byte cap verify green; line deletion breaks the link |
| Diagnosed issues → audit, recurrent INFRA issues → memory + proactive mention | test-diagnose recurrence block (RECUR_MIN=3/7d) | ✅ | ✅ all-down ladder run reached "failure #4 … on record" in the spoken diagnosis |
| Audit never writes keys/raw text; dead-disk can't crash it | scrub + mkdtemp/chmod fault injection | ✅ | ✅ fake `sk-or-v1-…` becomes `[key-redacted]` (literal built at runtime so test-physical's repo key audit stays green) |
| MODEL_PRIORITY ladder parse (Gemini = OpenRouter rung, garbage rejected, ollama floor) | test-modelroute ladder block | ✅ | ✅ `/api/models` on a 3-rung ladder showed per-rung down reasons live |
| Confirm-before-degrade, once per outage, per-step consent, decline backdoor-proof | test-modelroute degrade block | ✅ | ✅ live: exact ask string on gemini failure; "yes" replayed the deferred question; chained consent claude→gpt-4o-mini; "no" kept the rung unused |
| Upgrade-back offer exactly once on recovery | test-modelroute recovery block | ✅ 6 checks | ✅ live offer named the recovered top model |
| 3-key OpenRouter rotation stays automatic (separate from rung consent) | test-keyring re-run | ✅ PASS | — |
| Topic-triggered local routing + hub-managed `ollama serve` | test-modelroute topic + localproc blocks (spawn/poll/single-flight/cooldown/ENOENT) | ✅ | ✅ live on :8080 — sensitive topic asked for cloud-consent with the honest reason (no ollama binary here), zero dashboard navigation |
| Outage-triggered automatic local fallback (both brief announcement strings verbatim) | test-modelroute outage block | ✅ | ✅ live dead-OpenRouter run: announce string, then honest combined dead-end when local also couldn't start |
| Brain layer never touches the dashboard ("terminal" stays the only opener) | suite invariant: zero dashboard refs + terminal skill owns auto-nav | ✅ | ✅ |
| Sensitive tools stay verify-gated under local routing; no gate weakened | test-modelroute invariants + redteam 29 + injection 12 + security 24 + seams 28 green | ✅ | — |
| Unified memory + live search, fresher-wins conflict rewrite with provenance | test-diagnose grounding matrix | ✅ | ✅ live harness: stored python 3.11 rewritten to 3.13 after the live check; audit row `memory.grounding.update`; filler ("3.13 now") not a false conflict |
| Transient HTTP errors no longer block brain self-heal (network-only rung-marking) | chaos B2 | ✅ 39/39 both repos | — |
| Chaos (failure-injection) full re-run incl. B1 calm-dead-end invariant | test-chaos | ✅ 39/39 both repos | — |
| Redteam (pentest) re-run after changes | test-redteam | ✅ 29/29 both repos | — |

Full chains at final versions: jarvis **v1.0.8 all 21 suites green** (51+20+20+PASS+24+7+8+29+39+20+12+15+23+36+15+46+33+38+35+28+23), MAX **v0.11.9 all 20 suites green** (50+20+20+PASS+24+7+8+29+39+20+12+15+23+36+15+46+33+38+35+28) — exit 0, zero FAIL lines.

---

## 2026-09-04 (second pass) — Persona + proactive openers (v1.0.9 / v0.11.10)

| Suite | Checks | Covers |
|---|---|---|
| `test-persona` (**new**) | 38 | register matrix: reassure needs frustrated/urgent + real anchor, encourage needs learner pattern, wit needs tone ≥ 0.55/0.6 + anchor; frustrated-without-anchor → composed (hollow empathy banned structurally); prompt-section honesty/wellbeing/problems-lead rules ride EVERY prompt; reassure prompt quote-cites its anchor; deterministic close is reassure-only + anchored + caller-supplied solid (missing either → silent; wit/encourage never templated); BANNED screen (canonical bait caught, ordinary content not false-flagged); feelings questions intercepted deterministically offline (no LLM improvisation); error paths ship the FULL diagnosis with the close AFTER (accuracy-first), neutral error turns get zero garnish; skill-streak anchoring; bare-orchestrator null-safety; voice ignores assistantName |
| `test-openers` (**new**) | 32 | candidate ranking (imminent event > overdue reminder > live routine; timers excluded); compose names REAL items, empty board → null (anti-open-ended); toggle gates (openers=false, master enabled=false); guest/kid privacy; reminder candidates user-scoped (`job.user`, per-user isolation incl. label-prefix cleanup); explicit-ask incl. honest empty answer + toggle-off fall-through; read-only detail; session-open append once-per-session, parked kind:'opener' with NO tool name, yes/start → read-only detail, no → polite close, unrelated reply drops + processes normally, expiry fail-safe into B-04, single-question rule on verify-gated first turns |

Voice is fork-branded and pinned: Jarvis `Steady — …`/HUD register text vs MAX
`It's okay — …`/warm register text (the suites share one FORK block, exactly
like the theme checks in test-features).

**Product-behavior decisions (documented, not hidden):**
- `hub/orchestrator.js` `_systemPrompt` persona identity line now reads
  second-in-command for Jarvis (brief item: voice consistency with the HUD
  identity). MAX keeps its healthcare-companion line. This is a deliberate
  brand line alongside the four existing ones.
- Session-start openers land ONLY on the first clean turn of a fresh session
  (confirm/verify/locked/task/nudge turns stay single-question). An opener
  replaces nothing and is replaced loudly by any later parked confirm (the
  existing one-shot slot mechanics, with a kind-aware label).

Full chains: jarvis **23 suites** green (exit 0), MAX **22 suites** green
(exit 0) — same suite set as the brain-layer pass plus the two new suites;
check counts grew to 53/52 hub modules. Smoke on the live mains: feelings
question answered honestly in both voices, explicit opener ask + grounded
board, toggle respected.

---

## Self-review regression pass (2026-09-04) — jarvis v1.0.10 / MAX v0.11.11

Mandate: treat the bugfix, model-routing, and emotion passes as unverified;
re-review diff-by-diff for "what could this have broken," test the suspicious
behaviors under sustained failure, fix everything found, prove every fix.

**Method, honestly:** both chains started green (baseline re-runs exit 0 — no
decay between sessions). The diff-aware read produced 11 product findings, all
reproduced with executable tests/scripts BEFORE any fix: sustained-outage
re-ask simulation (8/8 messages re-asked), consent-revocation static trace,
orphan-spawn state machine walk, memory-corruption runs (personal fact
replaced by a Wikipedia opinion; "3.13.2 and ships with" stored verbatim),
a live secret-leak line (PAT + OpenRouter key visible in chat text), the
cross-user stash window, a feelings-regex miss ("do you ever feel sad"), the
silent task-failure fall-through, and the unreachable-ternary favorite bug.

**New suite `tools/test-regress.js` (43 checks, fork-safe)** pins every fix:
RG-1 sustained-outage consent memory (5), RG-2 localproc daemon discipline (6),
RG-3 grounding memory integrity (6), RG-4 secret-surface scrubbing incl.
no-over-redaction (4), RG-5 errors stay loud & plainly first (6), RG-6 openers
suggest-only / toggle-honest / user-isolated (10), RG-7 honest framing (3),
RG-8 remember-intent (2), plus the static brain-layer↔dashboard separation
scan (1). Converted two mid-run discoveries into fixes the same way:
test-chaos B7 ESRCH harness race (guarded, both repos), key-scanner trip on
suite literals (fake secrets now runtime-built).

**Live demonstrations (running hubs, this build):**
- Sustained outage (jarvis hub, cloud pointed at a dead port, 2-rung ladder):
  M2 asks once → M3 "no" → M4/M5 quiet wait-state answers with NO re-ask →
  M6 "switch models" → M7 re-armed ask → M8 "yes" → deferred retry diagnosed →
  M9 total-outage dead-end names both brains + recurrence memory ("failure #3
  … pattern on record").
- Openers: per-user boards proven again post-fix (rg-aaa sees only "water the
  orchids", rg-ccc only "call the dentist"; MAX hub: warm-voice vitamins
  opener + read-only accept). Toggle loop via `/api/settings`: OFF → fresh
  session with a pending reminder stays silent + explicit "what should we
  start with" falls through to normal routing; back ON → opener returns.
- Feelings: "do you ever feel sad when I leave?" → deterministic honest
  answer in both voices (jarvis: "…the calm is design", MAX: "…the warmth is
  in how I'm designed to speak") — the exact phrasing class that previously
  fell through to the LLM.
- Learning pipeline re-demo (per mandate step 3): `/api/learn/reset` → 3
  reminder utterances → state shows 3 signals + an emerging-routine row
  (reminders, correct hour/dow bucket, n=3 toward 4 hits/2 weeks).
- Audit chain: `/api/audit/verify` → ok, 8 lines, after all live writes.
- Previously-fixed items re-verified green inside the chains: task-workspace
  progress + gesture default-off (test-features §13/§14), keys `.env`-only &
  no settings-UI key path (J13/J14), terminal-is-the-only-dashboard-path
  (test-features + static scan), chaos failure matrix (39/39 bot repos) and
  redteam pentest (29/29 both).

Full chains at the final tree: jarvis **24 suites, 637 checks, zero FAIL,
exit 0** (`/tmp`-capture retained during session); MAX **23 suites, 613
checks, zero FAIL, exit 0**. Versions bumped: jarvis 1.0.9→1.0.10,
MAX 0.11.10→0.11.11; J12's independent-tree count 23→24.
