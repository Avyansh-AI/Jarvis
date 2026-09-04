# Jarvis — Security Model

Last reviewed: 2026-08-23 (hardening sprint, Round 2 — v0.3.0)

> **v2 note:** Round 2 closed the Round 1 backlog (kernel sandbox floor, voice
> liveness), then red-teamed the result with 29 live attacks
> (`tools/test-redteam.js`). Successful breaks and their fixes are in §10.

Jarvis is a **personal, self-hosted** assistant: the hub runs on hardware you own
(Pi/PC), binds `0.0.0.0`, and by default trusts whoever can reach the LAN port.
This document says what's protected, how, and what's consciously left open.

---

## 1. Threat model

| Adversary | What they want | Our posture |
|---|---|---|
| **LAN stranger** (rogue device on Wi-Fi, or a compromised satellite/IoT box) | talk to the API, unlock doors, run commands, read memory | Mostly defended (see §2); defense-in-depth improves if you set `MAX_TOKEN` |
| **Malicious/hallucinated LLM output** (prompt injection via skills/web results feeding the model) | invoke dangerous tools, exfiltrate secrets through tool calls | Strong: tool gating, sandboxed execution, no secret-bearing env in children, output never becomes raw SQL/shell |
| **Shoulder-surfer / recording attacker** | replay a voice, bypass voice verification | Weak by design — voice verification is explicitly **best-effort, experimental** (see §4) |
| **Attacker with the disk** | read memory/settings/keys at rest | Strong: AES-256-GCM stores, 0600 perms (cannot stop an attacker with the *running machine's* RAM) |
| **Supply chain** | poisoned update, poisoned model | Medium: ff-only updates + rollback + optional signed-commit gate; model is a pinned GGUF from HF |

**Out of scope:** physical access, OS-level compromise of the hub host,
compromise of OpenRouter/HF themselves, and Wi-Fi-layer attacks (WPA is yours to set).

## 2. Access control & network

- **`MAX_TOKEN`** (env): when set, every `/api/*` and both WS endpoints require
  it as `?token=` or `Authorization: Bearer`. When unset, the hub is LAN-open —
  the boot log now **warns loudly** about this so it can't degrade silently.
- **`SATELLITE_TOKEN`** (env): when set, ESP32 satellites must present it in
  their WS `satellite.hello`; hellos without it are rejected and logged.
  Satellites are already capability-constrained (they can report sensors and ask
  to be spoken through; a compromised one cannot call skills or read data).
- **Rate limiting** (token buckets: per-IP in general, **per-IP+user** for
  voiceprint — brute force targets one voice, and one attacker must not burn
  the whole household's bucket): verify **20/min per voice**, challenge
  **20/min per voice**, enroll/delete **5/hr per voice**, SOS **6/min**,
  vision describe **20/min**, utterances **45/min**, settings/keys mutations
  **30/min**, self-update **3/hr**, generic API 300/min. 429s come with a
  calm message; `rate.limited` events are logged with the source IP. The
  verify limit is looser than Round 1's 5/min *on purpose*: the real teeth
  are liveness + the 5-fail lockdown, and an unreachable-comfort limit only
  DoS'd legitimate owners (found in red team, §10).
- **User identifiers** (from any endpoint) are sanitized (`[\w. ()-]{1,40}`)
  and the profile store is capped at 60 — ids can't be used for log injection
  or store-bloat. Sensor cache is capped (100 sources × 50 keys).
- **WS hardening:** 1 MB frame cap, 2 MB pending-buffer cap, 30 s ping /
  90 s stale reap (dead Wi-Fi peers are dropped, not kept forever).

## 3. Sensitive actions (locks, garage, vehicle, finance)

- **Voice verification is enforced server-side by server-issued tokens only.**
  The one-time `verifyToken` (random 128-bit, 5-minute TTL, single-use, bound to
  a user id) from `/api/voiceprint/verify` is the only way `ctx.verified` goes
  true. *Regression test:* sending `verify: true` in a request body does
  nothing — tested in `tools/test-security.js`.
- Gating is applied to **both** LLM tool calls and deterministic intents, in
  the orchestrator (`_gate`) *and* redundantly inside the high-risk skills:
  smart-home locks/garage (including the `home_control` tool path, fixed this
  sprint), vehicle (whole skill), finance (whole skill).
- **Guest profiles** cannot reach `personalData` skills; **kid profiles** are
  blocked from `dev`/`vehicle`/`apps`; this is enforced in the gate matrix, not
  just hidden in the UI (tested). **User administration is owner-gated** — once
  any voiceprint is enrolled, `POST /api/users` (add user, clear guest/kid
  flags) requires a fresh owner `verifyToken`, so a LAN stranger or cannot
  mint or promote profiles (regression-tested: fake/borrowed tokens → 403).
- **Lockdown freeze is end-to-end.** 5 voice-verify failures in 10 min (or 8
  privileged denials) sets `lockedUntil` for 15 min, logs
  `security.lockdown`, broadcasts a dashboard alert, and fires an optional
  webhook. During the window, verify returns `{locked, retryAfterSec}` and
  *both* the orchestrator gate and smart_home's own lock/garage/home_control
  paths return a calm "frozen" message — an attacker scripting around the
  front gate still hits the freeze inside the skill (Round 2 fix, §10).
- The **dev sandbox** whitelists commands (`ls/cat/head/tail/wc/echo/date/
  uptime/node -e`), runs them with **an empty environment** (no inheritance of
  `OPENROUTER_*`, `MAX_SECRET`, `HA_TOKEN`), jails file args to the repo, and
  times out. Two layers sit beneath the whitelist:
  - **Agent layer:** a static scan rejects dangerous `node -e` scripts before
    spawn; a prelude inside the child blocks network/child-process modules
    (`http…dns`, `child_process`, `worker_threads`, `cluster`, `v8`,
    `inspector`), `import()`, and `process` internals; and a `PROTECTED_RE`
    fence makes `.env`, `data/`, `.master.key` unreadable through **every**
    file-taking skill path (`cat`/`head`/`tail`/`wc`/`ls`/`explain`) — not
    just the script runner (Round 2 red-team break #1, §10).
  - **Kernel layer:** the child additionally spawns with Node's
    `--experimental-permission --allow-fs-read=<repo source dirs>` — the
    kernel itself denies writes everywhere and `spawn()` anywhere
    (`ERR_ACCESS_DENIED`, verified on Node v20.20.2), so a module-guard
    bypass alone no longer escapes.
- Hacking-mode probes (nmap/ping) are restricted to RFC1918/loopback targets
  with pinned flag shapes.

## 4. Voiceprint — honest status

Enrolled features are a 5-dim spectral summary stored in the encrypted memory
store (never raw audio), and since Round 2 verification is **challenge-response
with liveness**: the server issues a random 3-word phrase (60–75 s TTL,
single-use) that the user must actually say — transcript (browser STT) **and**
spectral voiceprint must both pass. A fixed recording of your passphrase fails
because the words change every time; a TTS clone still needs to beat the
voiceprint score. Rate limits are per-user (20 attempts/min), enroll/delete are
5/hr, and **5 failures in 10 min (or 8 privileged denials) freeze sensitive
actions for 15 min** with a dashboard + optional webhook alert.
**It remains best-effort, not a certified biometric** — a live attacker with a
good voice clone speaking phrases on demand could still pass. Treat it as
"keeps households honest," and LMS-grade; see INCIDENT_RESPONSE.md for the
lockdown it triggers automatically when it smells abuse.

## 5. Data at rest

- `memory`, `settings`, `schedule`, all `skill-*` stores: **AES-256-GCM**,
  per-save random salt+IV, key = `scrypt(MAX_SECRET || generated .master.key)`,
  files `0600`, atomic tmp+rename writes.
- Event log (JSONL): raw transcript text is dropped unless transcript logging
  is explicitly enabled; all string fields are truncated to 300 chars and
  anything shaped like an API key (`sk-*`, `ghp-*`, `xox*`, Google/JWT
  prefixes) is scrubbed before writing.
- OpenRouter keys in logs/HTTP responses: index-only in logs, masked
  (`sk-or-v1-012…e392`) in API responses; `settings.public()` redacts anything
  matching `token|key|secret|webhook|pass`; **masked readbacks can't overwrite
  real secrets** (regression-tested).

## 6. Injection & validation

- Settings patches: top-level whitelist (unknown keys dropped + logged),
  `deepMerge` ignores `__proto__`/`constructor`/`prototype` (tested).
- No shell string interpolation anywhere: `spawn`/`spawnSync` get argument
  arrays; the single `cmd /c start` call (Windows app-launch) receives only a
  strictly sanitized app name. Apps names: `[\w .+#@()\-]{2,64}`.
- LLM tool arguments are JSON-schema-typed and re-validated in skills (money
  amounts finite/positive/bounded, temperatures 5–35 °C with **NaN rejected**,
  entity names fuzzy-matched against HA's own state list — Hallucinated device
  names simply miss).
- External URL construction goes through `encodeURIComponent` for user-derived
  parts (weather geocoding, Wikipedia lookups).

## 7. Updates

`scripts/update.sh`: refuses dirty trees, tags a rollback point, ff-only pull,
post-update `tools/check.js` must pass or it auto-rolls back, verifies history
only moved forward. Set `MAX_REQUIRE_SIGNED=1` to additionally require a valid
GPG signature on the update commit (`git verify-commit`). Data/ is never
touched. The update endpoint is off unless `ALLOW_SELF_UPDATE=1` **and** is
rate-limited.

## 8. Privacy defaults

Camera, mic (beyond browser-side STT), location, and transcript logging are
**off until opted in**; vision has a three-way setting (off/local/cloud) with a
one-tap UI opt-in. Vision frames are processed in memory and discarded. Live
indicators: the ring's `listening`/`vision` states, the "CAMERA LIVE" chip,
and the mic chip are always visible when the corresponding sensor is active.

## 9. Known residual risks (not fixed this session)

1. **LAN-open default.** Set `MAX_TOKEN` (and serve over your trusted LAN/VPN).
   When `MAX_TOKEN` is unset, **every `/api/*` route is reachable by any LAN
   client** — including metadata routes such as `/api/learn` (learning-layer
   topics/stats), `/api/github/status`, `/api/status`, `/api/activity` and
   (v1.0.8/v0.11.9) the brain-layer transparency routes `/api/audit/tail`,
   `/api/audit/verify`, `/api/models`, `/api/diagnostics/issues`. They
   expose metadata only (never memory contents, transcripts, or keys), but if
   even that metadata should stay private, set `MAX_TOKEN`. TLS termination for
   the hub is not built in — put it behind a reverse proxy (caddy/nginx) if you
   ever expose it beyond the LAN.
2. **Live voice cloning still passes phrase liveness** (see §4). The
   challenge phrase kills static recordings; a real-time cloner that speaks
   phrases on demand needs a true anti-spoofing stack (e.g., SpeechBrain) —
   a future integration, and a **design-level** flag, not a fix we rushed.
3. **`node -e` sandbox is heuristic above the kernel floor.** The Node
   permission model now denies writes/spawn at the syscall level, but the read
   surface + module blocklist are still pattern-based, and the permission flag
   is experimental (a future Node bump could change its semantics). It stops
   casual/hallucinated exfiltration — for hostile-code workloads, run Jarvis
   inside a container without mounts of `data/` or `.env`.
4. **Rate limits are memory-only** — a hub restart resets buckets, and
   non-voiceprint endpoints are per-IP (a botnet-of-LAN could fan out).
   Adequate for a home hub; not internet-grade.
5. **Ollama model is pulled from Hugging Face over HTTPS without a pinned
   hash.** Pin a SHA in `settings.security` if you want supply-chain certainty
   on the GGUF.
6. **Home Assistant token scope** — Jarvis sends full-privilege HA tokens. Use a
   dedicated HA user with only the needed domains if possible.

## 10. Red Team Findings (Round 2 — 29 live attacks, `tools/test-redteam.js`)

Round 2 attacked the Round 1 build as an adversary: voice-auth bypass
attempts, privileged-skill escalation, secret exfiltration, sandbox breakout,
rate-limit bursts (parallel, not single calls), full input fuzzing of every
skill, and hardware/registry failure simulations. **Three real breaks were
found; all are fixed and regression-tested.**

1. **Secrets readable through the dev skill's *other* arms.** *Found:* the
   `node -e` prelude fenced `.env`/`data/` inside the script runner only —
   `max dev cat .env` (and `explain .env`, `head`, `tail`, `wc`, `ls data/`)
   returned plaintext through the repo jail. *Exposed:* plaintext contents of
   `.env` (cloud API keys, `MAX_SECRET`) and layout of `data/`. *Fix:*
   `PROTECTED_RE` inside `safeJoin` — the single choke point every
   file-taking dev-skill path funnels through — refuses `.env`, `data/`,
   `.master.key`. Regression: six attack variants in the suite.
2. **Lockdown freeze invisible on the most-attacked path.** *Found:* after a
   lockdown the orchestrator gate said "frozen", but smart_home's in-skill
   verify check short-circuited first and returned the normal "please verify"
   prompt for lock/garage/`home_control` — inconsistent, and it leaked gate
   state to a probing attacker. *Exposed:* nothing unlocked (the underlying
   verify check still held — defense in depth worked), but the freeze signal
   never reached the user channel under attack. *Fix:* `ctx.lockSec` is now
   propagated and the skill's own lock/garage/home paths return the frozen
   message themselves.
3. **Per-IP voiceprint rate keys let an attacker starve the owner (or hide
   behind them).** *Found by:* the parallel-burst test
   (`24 × /api/voiceprint/verify` in flight) exhausting the shared per-IP
   bucket and 429ing unrelated subsequent calls — a DoS of the legitimate
   verification flow, and on shared NATs an attacker's attempts and the
   victim's attempts shared one bucket. *Fix:* voiceprint endpoints key by
   `ip|user`; the burst test now passes with throttling confined to the
   attacking identity. Companion change: verify raised 5→20/min because the
   5-fail lockdown is the real brake; the tight cap only hurt owners.

**Verified held (no fix needed):** forged `verifyToken` and `verify:true`
bodies do nothing (gate message returned); stolen verify tokens are
user-bound and a failed-use attempt *does not* destroy the owner's token — by
design only a successful consume burns it; spent challenges reject replays
(single-use, 75 s TTL); a recording missing the phrase fails `spoken`, a
phrase-correct wrong voice fails the score, and a no-challenge verify is 400;
5 failures → locked + frozen everywhere; oversized WS frame (4 MB declared)
→ server close frame and dropped connection; 5000-deep settings object and
`__proto__` patches neither crash nor pollute; NaN/oversize/non-numeric
feature vectors → 400; null/garbage input fuzz across every registered
intent of all 18 skills (3 s watchdog per call) — nothing hangs; satellite
registry flood caps at 64 nodes; `/api/data/wipe` clears memory, sessions,
verify tokens *and* in-flight challenges.

**Test-design corrections** (documented so they can't "regress" the suite):
the WS oversize test first declared 16 KB — under the 4 MB trip line — and
the server had in fact already sent a proper close frame; assertion widened,
behavior was correct. The token-binding test originally assumed theft burns
the token; it does not by design, and the test now asserts the owner token
survives a theft attempt. The lockdown test user must be enrolled first —
unenrolled users return before failure counting, which is *also* correct
behavior.
