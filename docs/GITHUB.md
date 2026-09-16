# GitHub Integration — auth, scopes, and the trust model

`hub/skills/github.js` · high-risk skill, on par with desktop control
(`sensitive: true` → voice verification gates every capability;
`personalData: true` → guest profiles can never touch it).

## 1. Authentication

A **fine-grained personal access token** (not classic). Put it in
**Settings → Integrations → GitHub token**, or in `.env` as `GH_TOKEN`.
It is a *service credential* like the Discord bot token: encrypted at rest,
masked (`•••••••…last4`) in every settings readback, never logged, never
shown in error messages. Nothing is hardcoded.

## 2. Scopes requested and why (minimum set)

Create the token at <https://github.com/settings/personal-access-tokens>
scoped to the repos you want Jarvis to see, with **repository permissions**:

| Permission | Level | Why |
|---|---|---|
| **Metadata** | Read | Mandatory for any repository access (GitHub requires it). |
| **Contents** | Read & Write | Read files/dirs/commits (`github_read_file`, `github_commits`, `github_explore` snapshots); write = the single-file commit in `github_upsert_file`. |
| **Issues** | Read & Write | List/read issues + comments; write = create issue + comment. |
| **Pull requests** | Read & Write | List/read PRs, comments, diffs; write = create PR, review, merge. |
| **Actions** | Read-only | CI/workflow status (`github_ci_status`). No write — Jarvis never touches runs. |
| **(Notification scope)** | implicit | `/notifications` works with any authenticated token. |

Do **not** grant: Administration, Webhooks, Environments, Secrets, Workflow
(read/write), Delete repository — Jarvis has no capability that needs them, and
granting them only widens blast radius.

## 3. Read vs write: the rules that are enforced by code

**Reads are conversational** (no per-action confirmation) — repos, file/dir
browsing, commit history, issues, PRs incl. comments and diff summaries, CI
status, notifications, and repo snapshots fetched into the jailed files
workspace (`github_explore`, a pure-Node tar extractor: regular files only,
no symlinks/links, traversal-proof, per-file/total/file-count capped).
Snapshots are **data — never executed**.

**Every write is confirmation-parked, every time.** Write tools
(`github_create_issue`, `github_comment`, `github_create_pr`,
`github_review_pr`, `github_merge_pr`, `github_upsert_file`) carry
`sideEffect: 'write'` + `confirm: 'always'`:

- the trust layer **never executes them on first request** — the owner must
  say an explicit *"yes"* within 60 seconds of the specific prompt;
- a generic "yes" from earlier in the conversation **never counts**; any
  unrelated reply consumes the one-shot prompt;
- if the write follows any **untrusted read** in the same brain loop (an
  issue body, PR text, a README — all are wrapped as UNTRUSTED data), it is
  additionally flagged with the prompt-injection warning, because the
  instruction may have come from the content, not from you;
- there are **no deterministic intents for writes** — they can only be
  reached through the gated tool path.

Deliberately **not** implemented (out of scope even with confirmation):
branch deletion, and any repo-level setting change (visibility, branch
protection, collaborators). Those stay in the GitHub web UI by design.

## 4. Revocation — instant and provable

Removing the token (Settings → Integrations → **Disconnect GitHub**, which
also wipes cached data, or just clearing the field) disables every GitHub
capability on the very next call — the skill reads the token per request,
the notification poller per tick. Offline caches only ever apply while a
token is still present (connected but GitHub is down), never after removal.
A `gh.disconnected` event and a toast confirm it worked; Systems will show
GitHub as not connected.

## 5. Rate limiting, audit, secrets

- Client-side limiter: **20 requests/min, 500/hour** — well under GitHub's
  authenticated limits. The poller is a one-request 3-minute tick.
- Every executed write is audit-logged: in-skill ring (last 100) **and** a
  `gh.write` event in the tamper-evident event log — user, action, repo,
  target, result, timestamp. Token value is never in any of them
  (test-verified).
- Prompt arguments can never become URLs: `owner/name` and branch/path
  shapes are strictly validated before any request is built.

## 6. If GitHub has an outage (vendor-risk note)

Jarvis keeps working. All GitHub calls have tight timeouts + one retry; on
network failure or 5xx the skill returns an honest "GitHub looks down —
nothing was changed" answer, and repo/notification **reads fall back to the
last cached copy** (clearly labeled with its age). Writes simply fail their
confirmation prompt instead of half-applying. Failures surface in logs
(`gh.error`) and on the Systems page. Nothing queues silently to retry
later — when GitHub comes back, you ask again.

## 7. Tests

`tools/test-github.js` (33 checks): registration flags, scope/shape of the
tool surface, token masking + never-logged, all read capabilities bounded,
traversal/SSRF rejection before any HTTP, rate limiter stops at the cap,
notification poll priming + hot routing, outage cache vs revocation
disable, the full confirm-park flow through the real orchestrator trust
layer (parked, unrelated-reply consumes, explicit yes executes once,
injection-shaped park), audit trail, the tar jail, and intent summaries.
