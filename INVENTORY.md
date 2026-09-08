# Jarvis Architecture Inventory

Inventory date: 2026-09-08

This document is based on the current executable source tree, not the historical feature documentation.

## Runtime and entry points

- `package.json` defines a zero-runtime-dependency Node.js application requiring Node 20 or newer.
- `hub/server.js` is the main process. It loads `.env`, encrypted stores, skills, scheduler, memory, diagnostics, audit logging, model routing, and WebSocket handlers, then serves the HTTP API and `web/` static application.
- `npm start` runs `node hub/server.js`.
- `npm test` runs the test programs under `tools/`.
- `scripts/supervisor.sh` is the restart supervisor; backup, restore, integrity, update, and decommission scripts are under `scripts/`.

## Hub architecture

The hub is a CommonJS Node service. `hub/server.js` owns routing, boot diagnostics, API endpoints, static serving, WebSocket attachment, scheduler wiring, attention ingestion, meetings, GitHub disconnect, privacy controls, and system status.

Core modules:

- `hub/orchestrator.js`: deterministic intents, OpenRouter tool-calling, Ollama fallback, trusted/untrusted tool boundaries, confirmation parking, model routing, and response handling.
- `hub/skills/registry.js`: dynamically loads JavaScript skills from `hub/skills/`.
- `hub/keyring.js`, `hub/keymigrate.js`, `hub/env.js`: `.env` loading, canonical `OPENROUTER_KEY_n` slots, and rotation.
- `hub/models.js`, `hub/ollama.js`, `hub/localproc.js`: model ladder and local Ollama support.
- `hub/memory.js`, `hub/secure-store.js`, `hub/skill-data.js`: encrypted persistence, user facts, sessions, and skill stores.
- `hub/scheduler.js`: timers, reminders, alarms, and recurring jobs.
- `hub/diagnose.js`, `hub/diagnostics.js`, `hub/audit.js`, `hub/eventlog.js`: errors, boot status, audit chain, and privacy-conscious event logging.
- `hub/ratelimit.js`, `hub/tokens.js`: rate limits and verification/token handling.
- `hub/ws.js`, `hub/satellites.js`: app/satellite WebSockets and satellite queue/reconnect handling.

## Skills currently loaded

The registry currently loads 23 skills:

`apps`, `browse`, `calendar`, `clock`, `create`, `desktop`, `dev`, `discord`, `finance`, `flights`, `github`, `notes`, `preferences`, `reminders`, `search`, `smart_home`, `sos`, `terminal`, `translate`, `vehicle`, `weather`, `wellness`, and `youtube`.

Skills expose deterministic regex intents for offline behavior and/or JSON-schema tool definitions for LLM function calling. Sensitive, personal-data, child-profile, and side-effect metadata are enforced by the orchestrator and/or skill code.

## Web application

- `web/index.html`: main Jarvis HUD and conversation UI.
- `web/dashboard.html`: Jarvis Remote dashboard.
- `web/settings.html`: settings and privacy controls.
- `web/logs.html`: event/log view.
- `web/meeting.html`: meeting assistant UI.
- `web/vision.html`: vision UI.
- `web/systems.html`: diagnostics/system status UI.
- `web/js/`: wake-word, shared browser helpers, widgets, and media behavior.
- `web/css/theme.css`: HUD theme.
- `web/sw.js` and `web/manifest.webmanifest`: PWA/offline shell.

Browser voice/STT/TTS and camera behavior live at the web edge. The server remains transport-agnostic for those capabilities.

## Satellite architecture

- `hub/satellites.js` manages satellite registration, online/offline events, fingerprints, command queues, and re-pairing.
- `hub/ws.js` exposes the satellite WebSocket path.
- `satellite/esp32/jarvis_satellite/jarvis_satellite.ino` is ESP32 firmware for the satellite side.
- `max-satellite.yaml` is the sensor/ESPHome-related configuration.

Physical hardware behavior is not fully verifiable in this environment.

## Credential and persistence model

- `.env` is ignored and is the source for `OPENROUTER_KEY_1` through `OPENROUTER_KEY_16`, with the first three required by the production boot preflight.
- OpenRouter keys are not intended to be stored in the settings UI.
- Other integration credentials are held by the settings/integration store or environment according to the existing integration implementation.
- Persistent data is encrypted through `hub/secure-store.js`; runtime data belongs under ignored `data/` and generated files under ignored `files/`.
- `.env.example` contains placeholders only.

## Feature status from code

Implemented and locally test-covered: deterministic skills, encrypted stores, scheduler, OpenRouter rotation simulation, Ollama probing/routing logic, smart-home fail-safe behavior, GitHub read/write confirmation logic, sandboxed developer commands, content creation primitives, privacy deletion/export, prompt-injection boundaries, audit/diagnostic reporting, WebSocket handling, backup/restore, and failure injection.

Partially verifiable only: live OpenRouter/GitHub/Home Assistant/Discord/provider calls, real browser microphone/camera behavior, Ollama model execution, Windows/macOS process behavior outside the test abstraction, and physical ESP32 operation.

## Structural judgments

- No new plugin package was introduced because the current extension mechanism is the dynamic skill registry; new capabilities should be added as `hub/skills/*.js` modules.
- No Python or separate service was introduced because this project is Node-only and already contains local-model and tool-execution abstractions.
- No automatic publishing or telemetry mechanism was added.
