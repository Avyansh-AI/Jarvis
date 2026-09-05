# Jarvis — Current Confidence Report

Date: 2026-09-04

## Local verification result

**PASS:** `npm install --ignore-scripts` completed with 0 dependency vulnerabilities reported.

**PASS:** `npm test` completed with 0 failed assertions. The final run included:

- Source/module loading: 54 modules/skills checked
- Syntax/highlighter checks: 20
- Desktop checks: 20
- Key rotation: 1 full failover/sticky-key scenario
- Security: 24
- Offline behavior: 7
- Backup/restore/corruption: 8
- Red-team: 29
- Chaos/failure injection: 39
- Privacy/data controls: 20
- Prompt injection: 12
- Physical/satellite/integrity checks: 15
- Systems/diagnostics and feature checks
- Seams, model routing, persona, regression, GitHub, and Jarvis checks

## Feature matrix

| Area | Status | Evidence / limitation |
|---|---|---|
| Core module loading | PASS | `tools/check.js`, 54/54 |
| Offline intents | PASS | `tools/test-offline.js` |
| OpenRouter rotation | PASS simulated | `tools/test-keyring.js`; no live provider call |
| Security gates/sandbox | PASS simulated | security, red-team, injection suites |
| Encrypted stores/backups | PASS simulated | backup/chaos suites |
| GitHub integration | PASS mocked | real PAT and repository not used |
| Smart home | PASS mocked | real Home Assistant not used |
| Desktop control | PASS local | OS-specific behavior needs Windows/macOS verification |
| PDF/website creation | PASS local | DOCX/PPTX external packages not guaranteed |
| Browser voice/camera | PARTIAL | browser permissions and hardware not exercised |
| ESP32 satellite | PARTIAL | source/integrity checks only; no physical board |
| Ollama routing | PARTIAL | unreachable/probe logic tested; live model not run |
| Discord/flights/YouTube providers | PARTIAL | configured live services not used |
| LAN authentication | WARNING | `MAX_TOKEN` must be configured; default bind is `0.0.0.0` |

## Remaining real-world verification

1. Run with a fresh `.env` containing three newly generated OpenRouter keys.
2. Set `MAX_TOKEN` and verify authenticated API/WebSocket behavior from a second device.
3. Test the web UI in supported browsers with microphone/camera permissions.
4. Test Home Assistant actuator confirmation against a real device.
5. Test GitHub reads and every write confirmation with a least-scope fine-grained PAT.
6. Run Ollama with a real local model and verify process cleanup after repeated routing triggers.
7. Flash and test the ESP32 satellite hardware.
8. Test Discord, flight-status, and any configured translation provider.

The local confidence level is **HIGH for tested deterministic code and simulated security/failure paths; MEDIUM overall** because external integrations, hardware, browser APIs, and live provider credentials remain outside this pass.
