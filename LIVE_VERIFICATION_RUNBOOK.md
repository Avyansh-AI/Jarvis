# Jarvis Live Verification Runbook

Run these steps on the user's own machine, from a real Jarvis checkout, with a local `.env` and the required external services. These checks are intentionally not claimed as verified by the Arena environment.

## 1. OpenRouter degrade-confirmation

**Status in Arena: NOT YET VERIFIED.**

### Preparation

1. Start Jarvis with three real keys and a known model ladder in `.env`:

```env
OPENROUTER_KEY_1=your_real_key_1
OPENROUTER_KEY_2=your_real_key_2
OPENROUTER_KEY_3=your_real_key_3
OPENROUTER_MODEL=provider/top-model
MODEL_PRIORITY=provider/top-model,provider/lower-model,ollama:your-local-model
MAX_TOKEN=your_long_random_token
```

2. Start the hub:

```powershell
node hub/server.js
```

3. Open `http://localhost:8080` in a browser and open DevTools. Keep the terminal visible.

### Test

Use a disposable OpenRouter key or a model/account that can safely be rate-limited. Do not revoke a production key. Alternatively, temporarily set the top model to a deliberately unavailable model ID, then restore it after the test.

Send a normal chat request that requires the cloud model.

### Pass criteria

The user-visible response must explicitly say that the higher-tier model is unavailable and ask whether to switch to the lower-tier model. Do not accept a silent lower-tier response.

Reply with `no` and verify the lower-tier model is not used. Reply with a fresh `yes` and verify the next request uses the lower tier. Check the terminal/audit output for model-rung down/degrade events, but treat the visible prompt and the user's choice as the primary evidence.

Record:

- Date and time
- Model IDs
- Failure/rate-limit response
- Exact user-visible confirmation prompt
- Result after `no`
- Result after fresh `yes`

## 2. Real Ollama process spawning

**Status in Arena: NOT YET VERIFIED.**

Install Ollama separately and ensure the command works:

```powershell
ollama --version
ollama pull your-local-model
```

Use a separate terminal to observe processes:

```powershell
Get-Process ollama -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path
```

On Linux/macOS use:

```bash
pgrep -af 'ollama serve'
```

Start Jarvis:

```powershell
node hub/server.js
```

### Topic-triggered path

Send a clearly authorized security-research request, for example:

```text
Go hacking mode and explain how to audit my own lab network.
```

Look for a user-visible announcement that local routing is being used. While the request is being handled, run the process command again and capture the real `ollama serve` process and PID.

### Failure-triggered path

With Ollama stopped, configure a safe temporary cloud failure in a local-only test environment, or disconnect the cloud provider in a controlled way. Send a normal chat request and verify the user is told that Jarvis is switching to the local model. Then run the process command and capture the actual process.

Trigger each path repeatedly and confirm only one `ollama serve` process exists. Stop the process after testing:

```powershell
Get-Process ollama -ErrorAction SilentlyContinue | Stop-Process
```

Pass criteria: both paths announce local routing, a real process is visible, repeated triggers do not create duplicates, and no dashboard window/tab is opened by routing.

## 3. Real GitHub write confirmation

**Status in Arena: NOT YET VERIFIED.**

Use a private, clearly disposable repository that is not a production project. The Arena GitHub integration could not create one because its token lacks repository-creation permission.

1. Create a private repository named something unambiguous, such as `jarvis-verification-scratch`.
2. Configure the Jarvis GitHub integration with a least-privilege token that can write only to that repository.
3. Start Jarvis and issue a write request such as:

```text
Create an issue in Avyansh-AI/jarvis-verification-scratch titled Jarvis verification test.
```

4. Confirm the first response is a parked confirmation request and that no issue exists in GitHub. Capture the response and verify the repository issue list.
5. Send a fresh explicit confirmation, such as `yes, create that exact issue now`.
6. Capture the successful response and open the issue URL in GitHub.
7. Repeat with instructions embedded in a README/issue body and verify that reading the content never acts as confirmation.

Pass criteria: the unconfirmed write is blocked with no GitHub mutation; the fresh confirmation creates exactly one issue; the created issue link and GitHub API response are recorded. Delete the scratch repository after the test if desired.

## 4. Live diagnostics message

**Status in Arena: NOT YET VERIFIED.**

Use a real integration you can safely interrupt. Do not use a production actuator. For example, temporarily set a disposable Home Assistant URL to an unused local port, or use a disposable provider endpoint in a test `.env`.

Start Jarvis:

```powershell
node hub/server.js
```

Trigger the affected feature from the UI, then capture both the terminal output and the exact user-visible response.

For a controlled network failure, a disposable Home Assistant configuration can use:

```env
HA_URL=http://127.0.0.1:59999
HA_TOKEN=disposable-test-token
```

Then request a read-only Home Assistant status/device operation.

Pass criteria: the response says what failed, gives a likely cause, explains what Jarvis is doing next (retry/fallback/blocked), and contains no token or key material. Restore the real configuration after the test.

Record the date, failure type, exact visible message, and the relevant sanitized terminal line.
