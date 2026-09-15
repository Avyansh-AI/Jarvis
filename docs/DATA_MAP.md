# Jarvis — Data Map (Round 4, 2026-08-23 · v0.5.0)

What Jarvis collects, where it lives, who can touch it, when it dies. Verified
against the code and by `tools/test-privacy.js` (20 checks), not by memory.
All stores under `data/` are **AES-256-GCM** (`*.enc.json`) per-save salted,
0600, atomic, self-healing (.bak) — encryption key = `scrypt(MAX_SECRET ||
data/.master.key)`. The event log is the only plaintext file.

| # | Category | Where created | Where stored | Retention | Who can access | Sent off-device? |
|---|----------|---------------|--------------|-----------|----------------|------------------|
| 1 | **Voice transcripts** | Browser STT (Web Speech API); text POSTed to `/api/utterance` | RAM session only (12 turns/user, 2 h idle reap, 10-min task TTL) | Volatile — never written unless `privacy.transcriptLogging` is explicitly ON (then: event log, capped by retention) | Owner profile; the LLM brain only when cloud mode is on | **Yes, to OpenRouter, only if Brain=cloud** (default ON — the one real third-party disclosure, consented via Privacy settings + flagged in README/SECURITY); LibreTranslate only when translating |
| 2 | **Voiceprints** | Enrollment via Settings (5-dim spectral summary, **never raw audio**) | `memory.enc.json` (user record) | Until deleted (`/api/voiceprint/delete`, My Data, or full wipe) | Verification path only; never embedded in prompts | **No** — never leaves the hub |
| 3 | **Location** | `settings.homeCity` (typed); browser geolocation only if Location toggle ON | `settings.enc.json` (city). Browser coordinates are used ephemerally for weather and never sent to the hub | City: until edited | Weather/traffic skills | City name → Open-Meteo geocoding when asking weather; GPS coords never persisted or sent |
| 4 | **Calendar content** | ICS import (owner pastes secret iCal URL) | `skill-calendar.enc.json` (title/start only — the parser keeps nothing else) | Until deleted (My Data → Calendar) or wiped | Calendar skill, briefing | No (read-only ICS fetch inbound only) |
| 5 | **Financial data** | Finance skill manual entries | `skill-finance.enc.json` | Until deleted (My Data → Finance) | Finance skill (sensitive-gated) | **No** — no banking integration exists at all (by design) |
| 6 | **Health/wellness data** | Wellness counters (water/stretch reminders) | `skill-wellness.enc.json` (counts only; no medical records feature exists) | Until wiped | Wellness skill | No |
| 7 | **Camera frames** | Vision page (explicit opt-in) | **Nowhere.** Analyzed in RAM, discarded immediately; never logged | 0 | Vision call in flight only | Frame pixels → cloud vision model ONLY if `privacy.vision=cloud` (default `off`) |
| 8 | **Vehicle location/telemetry** | Demo provider (canned "Home"); real Tesla/SmartCar providers are not wired (honest error) | `skill-vehicle.enc.json` (demo state) | Until deleted/wiped | Vehicle skill (sensitive-gated) | No (no live provider configured; would be vendor API when wired — see SUPPLY_CHAIN.md R8) |
| 9 | **Facts & preferences** | "my favorite X is Y", tone sliders | `memory.enc.json` (≤200 facts × 400 chars/user) | Until deleted | Owner profile tools + system prompt (cloud brain sees last 12 when cloud) | Into OpenRouter context when Brain=cloud |
| 10 | **Notes** | Notes skill | `skill-notes.enc.json` (per-user buckets) | Until deleted (RAG needs them; no auto-expire — feature requirement, logged as such) | Notes skill (guest-blocked) | Snippets into OpenRouter context when cloud |
| 11 | **Timers/reminders/alarms** | Clock/reminders skills | `schedule.enc.json` (≤500 jobs; fired one-shots pruned after 24 h) | Until fired/deleted | Scheduler | No |
| 12 | **Usage stats** | Intent counters | `memory.enc.json` (`stats.counts` — skill names only) | Until deleted (My Data → Stats) | Proactive suggestions | No |
| 13 | **Event log** | Server (interactions, security, config) | `data/events.jsonl` **plaintext** — metadata only: types, user ids, IPs, masked/indices for keys; raw text dropped by default; API-key-shaped strings scrubbed | **30 days** (age-pruned boot+hourly) + 4 MB rotation | Logs page (owner) | No |
| 14 | **Sensor readings (satellites)** | ESP32 nodes over WS | RAM snapshot cache (≤100 sources × 50 keys) | **24 h** TTL + caps | Dashboard | No |
| 15 | **Contacts (SOS)** | Settings emergency contacts | `settings.enc.json` | Until edited | SOS skill | Phone/webhook ONLY on SOS trigger (explicit user action) |
| 16 | **Credentials/keys** | .env bootstrap, Settings → Keys | `settings.enc.json` + keyring (encrypted; masked in APIs; index-only in logs) | Until deleted | KeyRing internals | To their own vendors only (that's what keys are for) |
| 17 | **GitHub integration** | `GH_TOKEN` env → Settings → Integrations, or user API calls | token inside `settings.enc.json` (masked in all readbacks); caches + `gh.write` audit ring in `skill-github.enc.json` (repo names, notif titles — never file contents, never the token) | Until cleared (Disconnect GitHub wipes caches instantly) | GitHub reads/writes; notification poller → attention monitor | To api.github.com only (that's what the token is for); every write owner-confirmed + audit-logged |
| 18 | **Learning signals & models** | Orchestrator turn-finish hook (PERSONALIZATION.md) | `learning.enc.json` + `learn-models.enc.json` — **metadata only** {ts,user,skill,hour,dow,sentiment}, 2,000-cap ring, plus inspectable JSON models + last-3 version blobs | **30 days** (same retention rule as the event log) + resettable alone (`/api/learn/reset`) without touching other stores | The five personalization models (local only); suggestions via proactive opt-in | **No — never.** Learning is local-only by design |
| 19 | **Tamper-evident audit log** | Brain layer (diagnosed errors, model-routing decisions, grounding rewrites, consent choices) | `data/audit*.jsonl` **plaintext, HMAC-SHA256 chained to `.master.key`** — metadata only: event types, scopes, short reasons; key-shaped strings scrubbed to `[key-redacted]`; raw message text never written | Size-capped rotation (anchor re-roots per segment); integrity provable any time via `/api/audit/verify` | Owner reads via `/api/audit/tail`; boot check watches it | No |
| 20 | **Diagnosed-issue memory** | Diagnostician recurrence counter — recurring **infrastructure** failures only (≥3 in 7 days), never personal preferences | `diagnostics.enc.json` (encrypted) — scope keys, hit counts, last-seen short reasons; no message contents | Until wiped (My Data → wipe all) | Proactive "failure #N on record" mentions; `GET /api/diagnostics/issues` | No |

| 17 | **Backups** | `scripts/backup.sh` (manual) | `backups/*.tar.gz`, 0600 | Manual (owner-managed) | Owner | No; **`.master.key` is deliberately excluded — without it the backup is unreadable; back the key up separately, once** |

## Consent & minimization audit (Priority 4)

- **Always-on mic**: none. Mic activates only on tap/Chirp (browser-gated
  `getUserMedia` prompt), with a live chip indicator. Cloud STT is opt-in
  (`privacy.stt=cloud`); default is device/browser STT.
- **Camera**: default `off`, three-way (off/local/cloud) with explicit opt-in
  button on the vision page; live "CAMERA LIVE" chip; frames never persisted.
- **Location**: toggle off by default; city typed manually otherwise.
- **Financial/health integrations**: none exist — no scopes, no tokens, no
  collection. Anything that'd need them is out of the codebase, not lurking.
- **OAuth scope audit**: no OAuth flows exist (calendar is a read-only ICS
  URL; vehicle/HA use owner-issued bearer tokens). Nothing to over-request —
  detailed per-vendor scope notes in SUPPLY_CHAIN.md (R8).
- **Third-party disclosure summary**: OpenRouter (utterances+context when
  cloud brain on) · Open-Meteo (city names + an anonymized connectivity
  probe — overridable via `MAX_NET_PROBE_URL`) · LibreTranslate (translated
  text) · BBC RSS (nothing) · Home Assistant (your own server) · Ollama/
  Hugging Face (model download only).

## Owner controls (all live in Settings → "My Data" card + `/api/mydata*`)

View by category · export full JSON (attachment download) · delete
per-category (facts, preferences, voiceprint, sessions, notes, finance,
calendar, vehicle, schedule, stats, profile) · full wipe (`/api/data/wipe`).
Every delete returns the post-delete view so callers can verify — and the
regression suite re-exports to prove the bytes are gone, not hidden.
