# Jarvis — Failure Modes Matrix

Last chaos-tested: 2026-08-23 (Round 3, v0.4.0) · 39 live failure-injection
checks in `tools/test-chaos.js` (run: `node tools/test-chaos.js`), plus
module-level rows from `test-backup.js`, `test-security.js`, `test-redteam.js`.

Principle: **degrade visibly, never silently; fail secure on actuators, fail
honest on information.** Every row below is a failure we actually induce, not
a hope.

## Priority 1 — failure injection matrix

| Component | Injected failure | Expected degraded behavior | Verified |
|---|---|---|---|
| Hub ↔ cloud LLM (OpenRouter) | `OPENROUTER_BASE` pointed at a dead port at boot | Hub boots and serves; deterministic skills (clock/timers/reminders/etc.) answer normally; unmatched chat gets a calm "cloud brain hiccupped" fallback; `net` offline broadcasts drive the ring's offline state | ✅ B1 |
| LLM returns garbage / truncated JSON / HTTP 500 | mock server emitting each | All three degrade to the calm fallback; process unaffected | ✅ B2 |
| LLM outage clears | mock flipped back to valid mid-run | Brain returns to `cloud` **with no restart** (self-healing) | ✅ B2 |
| Hub ↔ satellite partition | WS client closed mid-session | `satellite.offline` logged + dashboard notify broadcast; commands to it queue (cap 50) instead of erroring | ✅ A17 |
| Satellite re-joins | re-hello with same id | Re-pairs by id, flushes queued commands to the new socket; firmware retries with capped backoff 1 s→30 s (reviewed in `.ino`) | ✅ A17 |
| Calendar service down | network layer refused (poisoned `httpRetry`) | "I couldn't read that ICS feed — check the link." | ✅ A13 |
| Weather API down | poisoned network | "I couldn't get the weather — …" | ✅ A14 |
| Home Assistant down | poisoned network + dead URL against a live hub | "Lock hiccup: …" — **never** claims the action succeeded | ✅ A15 · B5 |
| Vehicle provider | real provider configured but unwired/unreachable | Honest error text; demo car defaults to **locked**; no false "Car locked." | ✅ A16 |
| Financial data | finance skill is local-only (no external API to lose) — store corruption covered by store rows | n/a — by design | ✅ by design |
| GitHub integration | `GH_API_URL` pointed at a dead port mid-run | Reads degrade to the last cached repo/notification list with an explicit "offline cache from <time>" note; writes fail their confirmation prompt honestly ("nothing was changed"); hub, chat and every other skill unaffected; token never in any error | ✅ test-github (outage cache, instant revocation) |
| Disk full (ENOSPC) | `fs.writeFileSync` throwing ENOSPC | `save()` throws a clean error, previous good file **untouched** (atomic rename); debounced saves report via `SecureStore.onError` → event log + dashboard alert | ✅ A1 |
| Data dir dead/read-only at boot | chmod-0555 data dir | Hub boots in **RAM-only degraded mode** with loud console + event-log notices; reads/chat work, writes fail visibly | ✅ degraded-boot smoke (scripted in A-suite history) |
| Memory exhaustion via session flood | 260 network-derived user ids | Sessions cap at 200; idle sessions reaped after 2 h; pending tasks TTL 10 min | ✅ A9 |
| Memory exhaustion via schedule flood | 501 pending-job insertions | Cap 500 live jobs with a visible "schedule is full" error | ✅ A11 |
| Clock skew — backward (NTP rollback) | fake clock rolled past issuance | Verify tokens & liveness challenges become **invalid** — rollback can never extend a token's life | ✅ A6 |
| Clock skew — forward | fake clock +6 min | Tokens age out early (fail-closed), challenges too | ✅ A6 |
| Scheduler after downtime | 120 one-shot jobs all overdue | Each fires **exactly once** — no thundering-herd of stale reminders | ✅ A10 |
| Recurring job across a clock gap | daily alarm 5 s in the past | Fires once, reschedules to the *next* future occurrence (no catch-up loop) | ✅ A10 |
| Power loss mid-write (rename) | injected EBUSY at rename | Old store file still valid; torn tmp swept at next boot | ✅ A5 |
| Power loss mid-write (tmp) | truncated `.tmp` left on disk | Swept at load; last good state loads | ✅ A4 |
| Corrupted store (main only) | garbage over `memory.enc.json` | Auto-recovered from the `.bak` copy; main re-healed; zero data loss | ✅ A2 |
| Corrupted store (main + bak) | garbage over both | Corrupt file **quarantined** to `*.corrupt-<ts>` (forensics preserved), store starts fresh, hub boots — never throws | ✅ A3 |
| Corrupted skill file | skill that throws at `require` | Registry isolates it, logs the error, boots the healthy skills | ✅ A12 |
| STT unavailable (browser) | content assertion on `web/index.html` | `SpeechRecognition` absence/errors surface a user-facing hint; typed input path unaffected | ✅ A18 |
| TTS unavailable (browser) | content assertion | `speechSynthesis` guard → replies stay visual; text-only mode unaffected | ✅ A18 |

## Priority 2 — fail-safe actuator audit

| Path | Failure | Contract | Verified |
|---|---|---|---|
| Door lock (intent + `home_lock` tool) | HA down / command ACKed but state never changes (jammed deadbolt) | State is **re-read after every command**; success is claimed only when HA reports the target state, otherwise *"can't confirm … please check it physically — treating it as NOT unlocked"* + `actuator.unconfirmed` event | ✅ B4 · B5 |
| Garage (intent + `home_control` tool) | same | Same confirm-then-claim contract | ✅ B4/B5 pattern + red-team gating |
| Lock/garage auth | verify service down, forged/expired tokens, lockdown active | Gate stays closed (fail-secure), frozen message during lockdown | ✅ red-team 29/29 re-run |
| Vehicle | provider error | Honest failure; demo defaults locked | ✅ A16 |
| Security lockdown | SIGKILL power cut *during* lockdown | Freeze is persisted **synchronously**; still locked after restart — a crash can't lift a lockdown | ✅ B3 |

## Priority 3 — self-healing

| Capability | Mechanism | Verified |
|---|---|---|
| Hub crash → unattended restart | `scripts/supervisor.sh` run-loop with capped exponential backoff (5-restarts/min circuit breaker) — chaos-proven with a deliberately crashing server: ≥3 boots in 3.5 s | ✅ B6 |
| Wedged event loop | watchdog logs `watchdog.stall`; a single hard freeze is detected and recovers **without** restart (correct — transient hitches shouldn't bounce the hub); sustained starvation (3 consecutive late beats) exits for supervisor handoff under `MAX_WATCHDOG_EXIT=1`. Injected with real `SIGSTOP` freezes — no HTTP trigger needed. Tunables: `MAX_WATCHDOG_BEAT_MS`/`MAX_WATCHDOG_LAG_MS`/`MAX_WATCHDOG_STALLS` | ✅ B7 |
| Satellite drop → re-pair | offline event + capped command queue + flush on re-hello; firmware backoff | ✅ A17 |
| Stale in-flight state | sessions: 200-cap + 2 h idle reaper; multi-turn tasks: 10 min TTL; verify tokens 5 min; liveness challenges 75 s — everything expires, nothing waits forever | ✅ A9 + A6 |
| Corrupt stores | `.bak` recovery → quarantine → fresh boot (in that order) | ✅ A2/A3 |
| LLM key death | ring rotation w/ hard/soft cooldowns | ✅ test-keyring |

**How to re-run everything:** `npm test` (9 suites, 183 checks —
module checks, backup/restore, security, red-team, chaos).

## 2026-09-04 verification update

The full local failure suite completed successfully after correcting the flattened source-tree paths and the key-rotation fixture's unauthenticated connectivity probe. Chaos coverage passed for cloud outage, malformed/500 responses, satellite loss, service outages, disk-full writes, corrupted stores, scheduler recovery, lockdown persistence, and watchdog behavior. External hardware/provider behavior remains unverified.
