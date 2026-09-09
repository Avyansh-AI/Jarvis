# Jarvis AI — Capabilities From Source Code

This report is based on the executable JavaScript skills, orchestrator, server routes, and model code. It does not rely on the README feature list.

## Conversation and reasoning

Jarvis can:

- Accept text utterances through the web application.
- Maintain per-user sessions.
- Route requests through OpenRouter cloud models or local Ollama.
- Fall back to deterministic offline intents.
- Use LLM tool/function calling.
- Continue multi-turn tasks.
- Detect simple frustration and urgency signals.
- Ask for confirmation before selected actions.
- Treat web pages, search results, notes, and calendar content as untrusted data rather than instructions.

## Offline functions

The deterministic skills include:

- Timers
- Alarms
- Reminders
- Calendar events
- Weather
- Notes
- Translation
- Web and news searches
- Smart-home actions
- Vehicle actions
- SOS
- Application control

## Weather

The weather skill supports:

- Location lookup
- Current conditions
- Forecast retrieval

## Time and scheduling

The code supports:

- Creating timers
- Creating alarms
- Listing scheduled items
- Cancelling scheduled items
- Creating reminders
- Listing reminders
- Recurring scheduling behavior
- Handling overdue scheduled jobs

## Calendar

The calendar skill supports:

- Adding events
- Listing events
- Reading ICS/calendar data
- Handling event titles, dates, and times

## Notes and memory

Jarvis can:

- Save notes
- Search notes
- Store user facts and preferences
- Maintain user sessions
- Store encrypted memory, settings, schedules, and skill data
- Wipe user data through the server API

## Web access

The code supports:

- Web searching
- News lookup
- Fetching web pages
- Summarizing fetched content
- URL validation and SSRF-related restrictions
- Treating fetched page text as untrusted content

This is primarily fetch/read automation, not unrestricted browser automation.

## Smart-home control

The Home Assistant-related code supports:

- Reading Home Assistant state
- Controlling configured devices
- Lock actions
- Garage-related actions
- Re-reading state after an action
- Refusing to claim success when the final state cannot be confirmed

## Vehicle control

The vehicle skill includes:

- Vehicle state/action requests
- Lock-related operations
- Provider-backed or demo behavior
- Conservative failure handling when the provider is unavailable

## Desktop and file operations

The code supports:

- Opening applications
- Closing applications
- Listing applications
- Reading files from a restricted workspace
- Listing restricted workspace files
- Writing/managing files in the permitted workspace
- Running a limited allowlisted command set
- Rejecting shell injection and path traversal patterns

This is not unrestricted remote computer control.

## Content creation

The create skill includes code to:

- Generate PDFs with a built-in zero-dependency Node PDF writer
- Generate DOCX files when `python-docx` is installed
- Generate PPTX files when `python-pptx` is installed
- Fall back to Markdown or HTML when optional Python packages are unavailable
- Generate simple static websites

## GitHub integration

### Read capabilities

Jarvis can:

- List and search repositories
- Read repository files
- List repository directories
- Read commit history
- List issues
- Read issue comments
- List pull requests
- Read pull-request information and diff summaries
- Read GitHub Actions/CI status
- Read GitHub notifications
- Fetch read-only repository snapshots into a jailed workspace

### Write capabilities

After confirmation, the code supports:

- Creating issues
- Commenting on issues or pull requests
- Creating pull requests
- Reviewing pull requests
- Merging pull requests
- Creating or updating one repository file as a commit

## Other integrations

The code includes support for:

- Discord message sending and polling
- Flight-overhead lookup
- Flight status through a configured provider key
- YouTube metadata and summaries
- Translation services
- Home Assistant
- Vehicle providers
- Ollama
- OpenRouter
- Optional emergency webhooks

## Security-research routing

The orchestrator detects security-related subjects and can prefer local Ollama processing.

The code also includes restricted support for:

- Private-network probes
- Allowlisted development commands
- Security-topic routing
- Tool argument validation
- Tool side-effect gates

## Vision and voice edges

The server/orchestrator code includes support for:

- Accepting image data for configured vision models
- Browser wake-word handling
- Browser speech recognition
- Browser speech synthesis
- Listening and speaking UI states

Actual microphone and camera behavior depends on browser permissions and support.

## ESP32 satellite support

The repository includes code for:

- ESP32 satellite WebSocket communication
- Sensor messages
- Reconnect behavior
- Queued commands
- Satellite-related hub handling

Real hardware is required for physical verification.

## Security controls in the code

The implementation includes code for:

- AES-GCM encrypted stores
- Bearer-token checks
- Rate limiting
- Guest and child profile restrictions
- Voice-verification tokens
- Lockdown state handling
- JSON/schema validation for LLM tool arguments
- Prompt-injection boundaries
- Restricted file paths
- Command allowlists
- Secret scrubbing
- Audit logs
- Backup and restore utilities
- GitHub write confirmations

## Current limitations

- Cloud features require valid local OpenRouter credentials.
- External integrations require their services and credentials.
- Browser audio and camera features depend on browser permissions.
- ESP32 functionality requires actual hardware.
- DOCX/PPTX creation requires optional Python packages.
- Home Assistant and vehicle actions require correctly configured providers.
- Some tests still require cleanup before the entire test suite is green.
- The system is not an unrestricted autonomous computer operator.
