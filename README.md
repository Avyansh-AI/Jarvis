# Jarvis

A personal AI assistant — voice, text, home, and hardware — wearing the dark
HUD of a certain butler-grade interface: deep navy, a double cyan ring
(crisp white outline + glowing arc), scan-line field, geometric type, and a
modular widget layer around the ring.

> **Fork note:** Jarvis is an independent, separately-versioned re-skin and
> rebrand of the **MAX AI** codebase (Baymax-styled, cream/coral). Everything
> under the hood — skills, security gates, sandboxing, the learning layer —
> is inherited unchanged, at feature parity with MAX AI v0.11.1.
> See **docs/JARVIS.md** for the theme/widget map and the isolation rules
> between the two products.

Built privacy-first: camera, mic, and location ship **off** until you turn
them on, memory is encrypted at rest, and raw transcripts are never logged by
default. Wake word: **"Jarvis"** (plus bare "hey"/"hi"/"hello").

```
┌────────────────────────── Jarvis ──────────────────────────┐
│                                                            │
│   web/ (PWA)            hub/ (Node, zero deps)             │
│   ├─ index.html   WS ─▶ ├─ server.js ── API + WS + static  │
│   ├─ dashboard.html     ├─ orchestrator.js ─ LLM routing   │
│   ├─ settings.html      │    ├─ OpenRouter (cloud)         │
│   ├─ logs.html          │    ├─ Ollama (local fallback)   │
│   └─ sw.js (offline)    │    └─ regex intents (offline)    │
│                         ├─ skills/ ─ drop-in plugins (×26) │
│   satellite/            ├─ scheduler.js ─ timers/alarms    │
│   ├─ esp32/*.ino  WS ─▶ ├─ satellites.js ─ failover queue  │
│   └─ esphome/*.yaml ──▶ ├─ memory.js ─ encrypted facts     │
│        sensors          ├─ secure-store.js ─ AES-256-GCM   │
│                         └─ eventlog.js ─ private analytics │
└────────────────────────────────────────────────────────────┘
```

## Quick start (software only — no hardware needed)

```bash
cd jarvis-ai
cp .env.example .env            # optional but recommended
# add OPENROUTER_API_KEY=sk-or-... to .env for the cloud brain (or run fully local)
node hub/server.js              # or: npm start
```

Open **http://localhost:8080** — tap the ring (Chrome/Edge for speech
recognition) or hit **Type instead** for full text-only operation.

Try:

- “set a timer for 5 minutes” · “wake me at 7 on weekdays”
- “remind me to call Mom tomorrow at 6” · “what reminders do I have?”
- “weather in Ambala” · “tomorrow’s forecast”
- “news” · “who is Ada Lovelace?”
- “take a note: the wifi password is in the kitchen drawer” → “search my notes for wifi”
- “add event Friday 3pm dentist” · “what’s on my calendar?”
- “briefing” · “translate thank you to Hindi” · “be more playful”
- “lock the car” *(asks for voice verification)* · “SOS” *(alert state)*

The hub runs on configurable local time — `Asia/Kolkata` (IST) by default;
change it in Settings → Hub timezone (applies instantly, no restart).

## Voice: wake words, keys, and the "terminal" command

- **Wake words:** "max" is the primary trigger (also "hey/ok/hi/hello max").
  Bare "hey"/"hi"/"hello" also wake Jarvis — but only as short, whole
  utterances, so conversation around you doesn't keep tripping it
  (`web/js/wakeword.js`; matcher is unit-tested).
- **"terminal" / "open terminal"** opens **Jarvis Remote** (the dashboard).
  It's a deterministic local intent (`hub/skills/terminal.js`) that never
  goes through the LLM, and it is the *only* programmatic path to the
  dashboard — no boot auto-launch, no other trigger (regression-tested).
- **OpenRouter key rotation:** put up to 3 keys in `.env`
  (`OPENROUTER_API_KEY`, `OPENROUTER_API_KEYS` comma-list) or Settings →
  OpenRouter Keys. On a rate-limit/rejection the active key cools down and
  the next one takes over **mid-conversation**; rotations are logged as
  `llm.key.fail` events (index only — key values are never logged). These
  are the only LLM credentials in the system; everything else (Discord bot
  token, HA token, flights key) lives under Settings → **Integrations** as
  plainly-labeled *service credentials*.
- **GitHub integration (v0.11):** repos, files, commits, issues, PRs incl.
  diffs, CI status, notifications → your attention feed — as conversational
  reads. Every write (issue/comment/PR/review/merge/single-file commit) is
  **owner-confirmed every time** and audit-logged; high-risk gated like
  desktop control; fine-grained PAT with minimal scopes (docs/GITHUB.md).
- **Adaptive learning (v0.10):** Jarvis learns your routines, preferences, tone
  and corrections **locally** — five small inspectable models with versioned
  rollbacks, drift guardrails, and a permanent "hands off" rule for
  auth/locks/payments. Everything is visible and editable under Settings →
  **What Jarvis has learned about me**; see `PERSONALIZATION.md`.
- **Brand assets without code changes:** drop `assets/logo.png` and/or
  `assets/background.png` into the repo — every page picks them up
  automatically; delete them and the defaults return (jailed `/assets/`
  route, no code edits).

## Feature modules (all optional, all through the existing dispatcher)

New skills: `desktop` (jailed files; **voice-verify on every call**),
`browse` (SSRF-guarded, read-only, untrusted), `create` (PDF built-in +
docx/pptx via optional python3 libs + websites at `/sites/«slug»/`),
`flights`, `youtube`, `discord`, `terminal`. Plus: **Jarvis Remote** (PIN +
activity feed + home panel), **meeting assistant** (`meeting.html`),
attention monitor (`POST /api/attn`), startup briefing (opt-in), one-shot
screen reading (off by default).

**Free vs. signup (no paid or additional *LLM* key anywhere):** weather
(Open-Meteo), flights-overhead (OpenSky anonymous), YouTube info (oEmbed),
Wikipedia/search — genuinely key-free. Flight **status** needs a free-tier
AviationStack key; Discord needs your own bot token; docx/pptx use optional
OS python packages. All are service credentials, never LLM keys.

## The state machine

The original shell shipped `standby / listening / thinking`; Jarvis extends the
same CSS-variable-driven pattern. Colors stay in-theme; each state is defined
purely as a `--state-color` / `--state-glow` / `--ring-speed` override in
`web/css/theme.css`.

| State | Look | Meaning |
|---|---|---|
| `standby` | coral, slow drift, breathing fill | idle |
| `listening` | coral, fast spin, voice bars | mic open |
| `thinking` | amber, dashed fast spin | hub is reasoning |
| `speaking` | coral-bright, pulsing stroke | TTS playing |
| `vision` | eucalyptus, segmented ring | camera/gesture active |
| `alert` | red, rapid spin + fast dot blink | SOS / urgent proactive |
| `offline` | desaturated, slow stroke | hub or WAN unreachable |
| `error` | rust, brief shake, self-clears | recoverable failure |

`prefers-reduced-motion` is respected everywhere, plus a setting-level
**reduced-motion** and **high-contrast** variant, aria-live status lines on
every screen, and full keyboard/screen-reader-friendly markup.

## Brains, fallbacks, privacy

**Cloud path**: OpenRouter function-calling over the 17 skills. Keys are
managed in **Settings → OpenRouter Keys** (add/remove, live cooldown dots) or
via `.env` (`OPENROUTER_API_KEYS=k1,k2,...`) — UI-managed keys win, `.env` is
the fallback and auto-seeds the first UI add. The hub rotates round-robin with
automatic failover (401/402/403 dead-skip ~30 min, 429/5xx soft-skip ~5 min);
keys are stored encrypted, shown masked (`sk-or-v1-012…e392`), and never logged.
Model override in Settings or via `OPENROUTER_MODEL`.
**Local path**: settings → Brain → “Local only” routes chat through Ollama
WITH the same tool-calling the cloud brain gets. URL/model live in
**Settings → Local Brain (Ollama)** (env overrides: `OLLAMA_URL`, `OLLAMA_MODEL`;
default `http://127.0.0.1:11434` and
`hf.co/huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF:Q4_K_M`).

**Hacking mode** 🐚 — say **“go hacking”** and Jarvis swaps into an authorized
security-research persona (session-scoped, never persisted) for work on **your
own devices, LAN, lab VMs, and CTF/bug-bounty targets**. In hacking mode the
**local uncensored Ollama model answers first** (with full tool use), and the
cloud brain is only the backup if Ollama is down. When you toggle in, Jarvis
checks Ollama and **auto-pulls the model in the background** if it's missing —
say “go hacking” again anytime for live download progress, or ask “local brain
status?”. If Ollama isn't running at all, the reply tells you exactly how to
install/start it (`ollama serve`) instead of failing silently. The Settings →
Local Brain card shows status and has a **Pull model** button with progress.
If you keep poking security topics in normal mode, Jarvis will suggest the mode
once. While active, the dev sandbox additionally unlocks LAN-scoped probes —
`nmap -sn` discovery and `nmap -sV --top-ports ≤100`, plus `ping -c ≤5` —
**private/loopback targets only**; anything else still refuses. Say “stop
hacking” / “exit hacking mode” to stand down. Toggle events land in the
private event log.
**Offline path**: if the WAN drops (checked continuously), the ring shifts to
the muted `offline` look and every skill still works via deterministic intents.

Per-feature local/cloud toggles live in Settings → Privacy. Memory, settings,
schedule, notes, ledger — all AES-256-GCM (`scrypt(MAX_SECRET)`; a generated
`data/.master.key` if unset). EventLog drops any `text` field unless
transcript logging is explicitly enabled. **Owner data controls:** Settings →
"wipe my data" clears memory, stats, sessions, schedules, and the
notes/finance/calendar/vehicle stores (`POST /api/data/wipe`), and "Forget
voice" deletes one enrolled voiceprint. **Security alerts:** the Logs page
shows a live alerts card (`GET /api/alerts`) aggregating lockdowns, verify
failures, rate-limit hits, and satellite drops; set `MAX_ALERT_WEBHOOK` to
get pinged on lockdowns.

**Voice verification** is challenge–response liveness over a best-effort
spectral fingerprint: the server issues a random 3-word phrase (75 s,
single-use) that you must actually say, and *both* the phrase (browser STT)
and the voiceprint score must pass — a recording of your passphrase fails.
5 failures in 10 min (or 8 privileged denials) **freeze sensitive actions for
15 minutes** with a dashboard + optional webhook alert. Gated skills: locks,
garage, vehicle, finance. Enroll/forget in Settings. It is *labeled as
best-effort everywhere and is not a certified security system* — see
`SECURITY.md` §4/§10 for the honest model and red-team results, and
`INCIDENT_RESPONSE.md` for the runbook.

**Profiles**: per-user memory + tone; kid profiles lose dev/vehicle skills;
**guest mode** hides personal memory, calendar, notes, locks, and finance.
Once any voiceprint is enrolled, adding users or clearing guest/kid flags
requires a fresh owner voice verify (server-enforced).

**Backups:** `scripts/backup.sh` makes a timestamped, `0600` tarball of
`data/` (and reminds you `data/.master.key` needs one manual, separate copy);
`scripts/restore.sh` pre-parks current data and restores — the restore path
is exercised by real tests (`tools/test-backup.js`), not just assumed.

## Running on your own PC (not the Pi)

- **Always open `http://localhost:8080`** on the machine running the hub.
  Chrome/Firefox block mic + camera on plain-`http://` network addresses
  (e.g. `http://192.168.x.x:8080`) — `localhost` and `127.0.0.1` count as
  secure, LAN IPs don't. The app detects this and tells you.
- **Mic**: Chrome/Edge only (Web Speech API); Firefox users can type. If the
  mic was previously blocked, click the tune/lock icon → allow Microphone →
  reload. Jarvis now names the exact fix for each browser error.
- **Vision**: off by default (privacy). The Vision page shows a one-tap
  **Enable vision** button; camera errors now spell out the cause
  (blocked / busy / missing / insecure-context).
- **Apps skill** 🖥 — “open Chrome”, “close VS Code”, “what apps are running”
  work on Windows (`start`/`taskkill`/`tasklist`), macOS (`open -a`/AppleScript
  quit), and Linux (`which`+detach/`pkill`/`ps`). Names are sanitized (no
  shell injection possible), friendly aliases included (chrome, code, notepad,
  terminal, files, calculator, spotify, vlc, discord, …); smart-home words
  (“open the garage”) are left to the home skill.

## Hardware

- **Hub**: Raspberry Pi 4/5 running this service; kiosk display at
  `/dashboard.html` ([docs/HARDWARE.md](docs/HARDWARE.md) for parts, wiring,
  kiosk, enclosure notes).
- **Satellites**: ESP32 sketch at `satellite/esp32/jarvis_satellite/` (INMP441 +
  MAX98357A + DHT22 + PIR/mmWave, WS client, reconnect/backoff, hub-announced
  dropouts, per-node command queueing on the hub). An ESPHome variant for the
  sensor-only subset is at `satellite/esphome/jarvis-satellite.yaml`.
- **Presence/vision**: dedicated **Vision page** (`/vision.html`) — live feed with a
  live-privacy chip, one-tap "Look", natural questions ("what's on my desk?"),
  and a watch mode that only analyzes on **scene change**. Frames are sent to
  your OpenRouter vision model when Settings → Privacy → Vision = *cloud*,
  analyzed in memory and discarded; *local* mode limits Jarvis to motion/brightness
  sensing until an on-device model is wired in. Gesture shortcuts work on-device:
  → volume up, ← volume down, ↑ look, ↓ stop. API: `POST /api/vision/describe`
  (gated by privacy mode; frames never hit disk or logs).

## API (selection)

`GET/POST /api/ollama/status` · `POST /api/ollama/pull` — local-brain state and
model download control (used by Settings → Local Brain and “go hacking”).

`GET /api/health` · `POST /api/utterance {text,user,verifyToken}` ·
`GET/POST /api/settings` · `GET /api/skills` · `GET/DELETE /api/schedule` ·
`POST /api/schedule/snooze` · `GET /api/memory?user=` ·
`GET /api/voiceprint/challenge?user=` ·
`POST /api/voiceprint/{enroll,verify,delete}` · `POST /api/users` (owner-gated
once enrolled) · `GET /api/alerts?hours=` · `POST /api/data/wipe` ·
`GET /api/sensors` (POST to ingest) ·
`GET /api/satellites` · `GET /api/logs/summary?hours=` · `POST /api/sos` ·
`GET /api/proactive` · `POST /api/system/update` (needs `ALLOW_SELF_UPDATE=1`) ·
`GET /api/audit/tail` · `GET /api/audit/verify` · `GET /api/models` ·
`GET /api/diagnostics/issues` (brain-layer transparency, metadata only)

WS: `/ws/app` (UI), `/ws/satellite` (ESP32 nodes). Set `MAX_TOKEN` to require
auth from every client. With no `MAX_TOKEN`, every `/api/*` route — including
metadata routes like `/api/learn`, `/api/github/status`, `/api/status`,
`/api/activity` and the brain-layer transparency routes `/api/audit/tail`,
`/api/audit/verify`, `/api/models`, `/api/diagnostics/issues` — is readable
by any LAN client (metadata only: no memory contents, transcripts, or keys).

## Adding a skill

Drop a file in `hub/skills/` — it registers automatically, shows up in
Settings, and joins both routing layers (regex intents + LLM tools).
Full guide: [docs/ADDING_A_SKILL.md](docs/ADDING_A_SKILL.md).

## Self-update

`ALLOW_SELF_UPDATE=1` + git checkout → `POST /api/system/update` runs
`scripts/update.sh`: tags a `max-rollback-*` point, fast-forward pulls,
re-checks every module, auto-rolls-back on failure. `data/` is never touched.

## Tests

`npm test` runs the full suite — **284 checks across 14 suites**, all
offline (temp data dirs, mocked LLM/HA, simulated satellites):
`check` (smoke) + `test-hl`, `test-apps`, `test-keyring`, `test-security`
(auth/gates/redaction), `test-offline`, `test-backup` (real restore),
`test-redteam` (29 live attacks), `test-chaos` (39 failure injections),
`test-privacy` (governance APIs), `test-injection` (hostile LLM),
`test-physical` (mutual auth, integrity, attack surface), `test-systems`
(blocker layer) and `test-features` (v0.9.0 feature pass + regressions).
`tools/load.js` and `tools/test-scale.js` are manual performance harnesses.

## Project status vs. the master spec

- ✅ Core loop (wake-phrase fallback, streaming STT partials, pluggable LLM +
  Ollama, TTS w/ swappable voices, encrypted memory, multi-turn tasks)
- ✅ Skills ×18 incl. reminders/timers/alarms, calendar+ICS, search/news,
  Home Assistant (locks gated behind voice verify), media bridge, translate,
  briefing, notes RAG-lite, app launcher, dev sandbox, wellness, finance,
  vehicle (demo/Tesla/SmartCar), SOS, system, preferences
- ✅ Extended state machine, settings/dashboard/logs, PWA (installable,
  offline shell, SOS shortcut), high-contrast/reduced-motion/text-only modes
- ✅ Satellite firmware + sensor ingest + failover queueing + dropout notices
- ✅ Private analytics, self-update with rollback, challenge-response voice
  verify with lockdown (experimental), profiles/guest/parental controls
- ✅ Hardened, red-teamed & chaos-tested (**230 green checks across 12
  suites** incl. 29 live attacks + 39 failure injections), self-healing
  stores (.bak recovery, quarantine, RAM-only degraded mode), fail-safe
  actuators (confirm-or-silence), backup + tested restore, security
  alerting, owner data wipe, `SECURITY.md` v2 + `INCIDENT_RESPONSE.md` +
  `FAILURE_MODES.md`, measured 62 req/s on the loop
- ✅ Data governance: `DATA_MAP.md`, per-category view/export/delete APIs,
  log/sensor retention pruning, privacy settings surfaced in the UI
- ✅ Prompt-injection containment: untrusted tool output quarantined from
  write actions (parked until owner confirms on the trusted channel),
  schema-validated tool args, `PROMPT_INJECTION_TESTS.md` + 12 adversarial
  checks against a hostile mock LLM
- ✅ Physical & network layer: mutual hub↔satellite proof (HMAC), satellite
  swap/tamper alerting, boot-integrity manifest, audited single-port attack
  surface, `scripts/decommission.sh` secure disposal, `NETWORK_SECURITY.md`
- ✅ Jarvis mode (opt-in): time-of-day greeting that *says how many systems
  need attention*, Jarvis-phrased status lines — nothing changes unless you
  flip it on in Settings
- ✅ Systems blocker layer: `GET /api/status` + a Systems page grading 16
  capabilities ✓/⚠/✗, each with the exact blocker and fix (out-of-credit
  cloud keys, mic denied, embedded-preview sensor block, missing backups,
  LAN-open API, lockdown freezes…) — "why doesn't X work" has a page now
- ✅ v0.9.0 feature pass: wake words + tuned bare greetings, "terminal"
  dashboard command (only path, regression-tested), jailed desktop skill
  (strictest auth), guarded browse, file creation (PDF built-in), flights/
  YouTube/Discord/attention modules, Jarvis Remote (PIN + feed + home panel),
  meeting assistant, startup briefing, screen-reading (opt-in), drop-in
  `assets/` branding — 31 new checks, hardening suites all re-run green
- 🔶 Deliverable noted, not software: 3D-printable enclosure (spec in
  docs/HARDWARE.md); face recognition + cloud Piper/ElevenLabs paths are
  opt-in stubs behind clear UI labels

MIT licensed. Be kind to your hubs.
