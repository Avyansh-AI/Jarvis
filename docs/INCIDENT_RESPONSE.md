# Jarvis — Incident Response Runbook

Keep this pinned next to the hub. TL;DR: **Settings → pull power if unsure —
Jarvis keeps nothing essential in RAM.**

---

## A. A lock/door/vehicle action fired and nobody recognizes it

1. **Contain now**: Settings → Household → enable **Guest mode** (blocks all
   personal/privileged skills instantly), and/or check the locks physically;
   re-lock by hand if needed.
2. **Identify**: Logs → **Security alerts** card. Look for
   `voiceprint.verify` failures followed by a success, or a
   `security.lockdown` entry around the time.
3. **Amber flag**: if you didn't get a lockdown alert and the action went
   through, it succeeded within a **valid 5-minute verify window** — likely a
   household member's voice or a recording. Rotate the voiceprint: Settings →
   **Forget voice**, then re-enroll, or leave verification off.
4. **Procedure after**: rotate `MAX_SECRET` (it rekeys the store — encrypted
   data will be unreadable without a backup+restore), rotate OpenRouter keys if
   you suspect the hub itself was reached remotely.

**What Jarvis does automatically:** 5 failed verifications in 10 min or 8 denied
privileged attempts → 15-minute sensitive-action freeze + dashboard alert +
optional webhook (`MAX_ALERT_WEBHOOK`), all of which is logged.

## B. Hub logs show a spike in failed auth / rate limits (`rate.limited`)

1. The rate limiter is holding — nothing is on fire. Check the source IP in
   Logs → Security alerts entries.
2. If the IP is your own phone/app: it's a buggy client loop; fix or restart it.
3. If unrecognized: **set `MAX_TOKEN` + restart** (everything then requires a
   bearer), consider `SATELLITE_TOKEN` too, and check router firewall/DHCP list.
4. If the hub starts misbehaving after: `bash scripts/backup.sh`, then restart.

## C. A satellite starts sending malformed data / unknown satellites appear

1. Dashboard → Satellites: unknown node = rogue board on your LAN (or a
   flashed legitimate one). Note its reported IP.
2. Set `SATELLITE_TOKEN` on hub + firmware; rogue hellos get rejected and
   logged (`satellite.rejected`).
3. Malformed-but-trusted satellite: yank its power, reflash from this repo —
   commands during dropout are queued (≤50) and delivered on reconnect, nothing
   executes twice.

## D. Suspected secret exposure (key shown in chat, log, screenshot)

1. OpenRouter keys: Settings → OpenRouter Keys → delete the affected index, add
   a fresh key from openrouter.ai (the old one auto-cools anyway).
2. `MAX_SECRET`: change it in `.env`; old encrypted stores won't decrypt —
   either keep a backup (`scripts/backup.sh` first, restore after changing),
   or accept a fresh memory start.
3. Home Assistant token: rotate in HA, paste the new one in Settings → Smart
   Home. Logs are scrubbed of key-shaped strings, but `.env` is your duty.

## E. Hub hung / acting weird mid-conversation

1. The watchdog logs `watchdog.stall`; under `scripts/supervisor.sh` (or
   `MAX_WATCHDOG_EXIT=1`) it restarts itself after 3 consecutive stalls.
2. Manual: `bash scripts/backup.sh` → restart. If it hangs *again at boot*,
   restore: stop hub, `bash scripts/restore.sh backups/<latest>.tar.gz`.
3. Speak to it — if it answers, check Logs → Recent errors for the real
   exception (the UI only ever shows calm generic lines).

## F. Wrong/unexpected behavior after an update

`git reset --hard max-rollback-<ts>` (the tag the updater wrote), restart.
The updater also auto-rolls back when `tools/check.js` fails — if it didn't,
that itself is a bug to report.

---

## Incident severity cheat-sheet

| Signal | Severity | First move |
|---|---|---|
| Unknown satellite / one-off 429s | Low | read Logs → Security alerts |
| Repeated `voiceprint.verify` failures | Medium | same; maybe someone fumbling |
| `security.lockdown` fired | High | verify household voices, rotate voiceprint |
| Lock/vehicle action nobody fired | **Critical** | Section A — all steps, then `MAX_TOKEN` |
| `.env` or keys appear in any output | **Critical** | Section D — rotate everything listed |
