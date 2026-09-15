# Jarvis — Physical & Network Security (Round 6, 2026-08-23 · v0.7.0)

Scope split, per the round constraint: **[DONE]** = implemented + tested this
session (`tools/test-physical.js`, 15 checks). **[RECO]** = documented
recommendation requiring physical access, router admin, or toolchain setup.

## 1. Firmware & boot integrity

- **[DONE] Hub boot integrity**: `scripts/integrity.sh write` snapshots
  SHA-256 for every code file (hub/, web/, tools/, scripts/, satellite/,
  docs/) into `data/integrity.sha256` (0600); `verify` re-checks on demand —
  tested clean-pass and tamper-fail. Wire it into boot by adding to the
  supervisor: `bash scripts/integrity.sh verify || echo "integrity warning"`.
  Truth-in-labeling: this is tamper-*evidence*, not secure boot — an attacker
  with write access can regrow the manifest. Real secure boot on a Pi =
  signed bootloader + read-only rootfs ([RECO] below).
- **[RECO] Headless Pi secure boot**: (1) `raspi-config` → read-only overlay
  for `/` with `data/` on a small rw partition; (2) enable `fsck` on boot
  (`tune2fs -c 1`); (3) optionally UEFI/secure-boot on x86 hubs. These are
  physical-console steps and weren't executed here.
- **[INFO] Satellite OTA**: satellites currently have **no remote OTA update
  path** — firmware changes require USB flashing. That is a *safe default*
  (no remote firmware attack surface) and this round adds none. **Before
  anyone enables OTA (ArduinoOTA/`Update`), it is REQUIRED to:**
  1. sign images (ed25519 via `espota.py`/Arduino signing hooks),
  2. verify the signature on-device before `Update.begin()`
     (`Update.installSignature()` / mbed TLS verify),
  3. serve the image from the hub over the paired channel with a per-node
     nonce to defeat replay.
  Until those three exist, OTA stays off. (Documented in place of a fix that
  cannot be compile-tested in this session.)

## 2. Network segmentation — owner guidance [RECO]

Flat home LANs let any smart-bulb botnet poke Jarvis. Recommended, in order of
effort (any consumer router from ~2020 can do #1):

1. **IoT SSID / guest network** (router UI: "Guest network" or "IoT network",
   enable *client isolation*): put satellites there. Hub goes on the **main
   LAN** *or* the IoT net with a router rule allowing clients→hub:8080.
2. **VLAN** (prosumer gear — UniFi/OPNsense/Mikrotik): `VLAN20-iot` for
   satellites + smart home; `VLAN10-main` for phones/laptops + hub; firewall
   rules: `iot → hub:8080/tcp ALLOW`, `iot → main DROP`, `main → iot DENY
   (established/related ACCEPT)` for command flows, mDNS reflector if you
   rely on discovery.
3. **If your router can't do either**: set `MAX_TOKEN` (hub demands a bearer
   token from everything) and `SATELLITE_TOKEN` — weakens flat-LAN risk to
   "need the token first", which hub-side brute-force controls (rate limits +
   lockdown) make noisy.

## 3. Mutual authentication (hub ↔ satellite) — [DONE]

- Satellite → hub: `SATELLITE_TOKEN` in `satellite.hello` (since R1).
- Hub → satellite (**new**): welcome message carries
  `proof = HMAC_SHA256(SATELLITE_TOKEN, "<id>|<ts>")`; firmware verifies it
  (reference implementation in the sketch via mbed TLS) and **ignores all
  commands from a hub that fails proof** when a token is configured. Open
  mode (no token) is explicit and the hub logs a loud warning about it.
- Timing-safe compare both directions; proof strings are shape-validated
  before compare (tests cover valid/tampered/garbage/no-token cases).

## 4. Attack surface — [DONE] audit results

- Hub process opens **exactly one listening TCP port** (`PORT`, default
  8080) — proven by test against a live process (`ss -ltnp` on the hub pid).
- Everything multiplexes over that port: HTTP API, static PWA, both WS
  endpoints. No debug ports, no second admin listener, no telnet-d of doom.
- Optional extras bound only when configured: none in-hub (Ollama is a
  *separate* program, binds localhost by default — keep it that way; never
  `OLLAMA_HOST=0.0.0.0` without firewalling).
- Hardcoded credentials: none in code (scanned for real-shaped keys across
  hub/web/tools/scripts/satellite); firmware ships `YOUR_WIFI_PASSWORD`
  placeholders; `.env` holds real keys and stays gitignored + 0600.

## 5. Tamper awareness & secure disposal

- **[DONE] Swap detection**: each satellite id is fingerprinted by network
  address (persisted in `sat-fingerprints` store). Same id from a new
  address → `satellite.swap` security event + dashboard alert + optional
  webhook. It alerts, it does **not** block (DHCP churn is normal — false
  blocking would be its own DoS). Tested: same-ip re-hello = silent,
  new-ip = alarm.
- **[RECO] Physical tamper-evidence**: cheap and effective — (1) a dab of
  tamper-evident nail polish/security stickers over enclosure seams, photo it
  after sealing; (2) Pi case screws with security bits; (3) hub in a locked
  comms cabinet if the home has visitors/staff. ESP32s have no tamper
  mesh — treat any unplugged-and-returned satellite as suspect (the swap
  alert fires on its next hello if anything changed its network identity).
- **[DONE] Secure disposal**: `scripts/decommission.sh` (dry-run prints the
  plan; `--yes` executes): destroys `data/` (stores, `.master.key`, event
  log, fingerprints, integrity manifest) and `backups/` (file-overwrite via
  `shred` where available, `rm` fallback, with the honest caveat that
  flash/SD media needs full-medium erasure for certitude). Satellites:
  `esptool.py erase_flash` clears Wi-Fi creds + SAT_TOKEN.
