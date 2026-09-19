# Cloud Agents API

The controller exposes a versioned Cloud Agents HTTP API at `/v1`. It is shaped like
Cursor's Cloud Agents API: durable agents, per-prompt runs, and an SSE event stream.
It does not expose infrastructure allocation calls.

## Authenticate

Create an API key in the controller database, then send it with Basic or Bearer
authentication.

```bash
curl --request GET \
  --url http://localhost:13773/v1/me \
  -u YOUR_API_KEY:
```

```bash
curl --request GET \
  --url http://localhost:13773/v1/me \
  --header "Authorization: Bearer YOUR_API_KEY"
```

User keys and service-account keys are distinct principals. `/v1/me` reports user
profile fields only for user keys. Each principal sees only the agents it created.

## Endpoints

- `POST /v1/agents` — create an agent and its first run. Caller-supplied `agentId`
  values conflict with `409 agent_id_conflict`.
- `GET /v1/agents` — list bounded agent summaries, newest first. `limit` (default 20, max 100) and
  `cursor` paginate. `nextCursor` is omitted when there is no further page.
- `GET /v1/agents/{id}` — load the durable agent record.
- `POST /v1/agents/{id}/runs` — follow-up run. A live run returns `409 agent_busy`.
- `GET /v1/agents/{id}/runs` and `GET /v1/agents/{id}/runs/{runId}` — run payloads
  include optional `provenance` (agent, run, environment version, Build, base,
  provider/model, principal, and signature) without prompts or secrets.
- `POST /v1/agents/{id}/runs/{runId}/cancel` — terminal cancel. Already-finished runs
  return `409 run_not_cancellable`.
- `GET /v1/agents/{id}/runs/{runId}/stream` — SSE. Events: `status`, `assistant`,
  `thinking`, `tool_call`, `interaction_update`, `heartbeat`, `result`, `error`,
  `done`. Resume with `Last-Event-ID`. The stream is retained for 24 hours, 10,000
  events, or 8 MiB. An expired or dropped cursor returns `410 stream_expired`.
  Live agents reconnect through the worker's T3 cursor; hibernated agents read the
  retained transcript without waking compute. `X-T3-Reconnect-Source` reports
  `worker-cursor` or `controller-transcript`.
- `GET /v1/agents/{id}/runs/{runId}/history?kind=transcript|tool|setup|artifacts`
  — paged history, tool output, setup logs, or artifact names under a 256 KiB
  byte budget. Full payloads stay off the live stream.
- `GET /v1/agents/{id}/usage`
- `GET /v1/usage-report?periodStart=&periodEnd=` — dimensional usage export without prompts or
  secret values, including invoice variance when invoices have been recorded.
- `POST /v1/agents/{id}/archive` and `POST /v1/agents/{id}/unarchive` (idempotent)
- `POST /v1/agents/{id}/subscriptions` — attach a GitHub, Slack, Linear, or timer
  subscription that can wake an idle agent
- `DELETE /v1/agents/{id}` — permanent delete
- `GET /v1/me`, `GET /v1/models`, `GET /v1/repositories`

## Scheduled runs

`POST /v1/schedules` creates a recurring schedule. The body records a five-field
cron expression, an IANA timezone, the prompt, repository ref policy, current
environment recipe policy, Codex model, publication mode, and run and retry
limits. The action must choose one of these forms:

- `create_agent` creates a new durable agent for every occurrence.
- `follow_up` submits a run to the named durable agent. It does not assume the
  agent's runtime is awake. The normal follow-up path wakes or allocates compute,
  and the provider model is recorded as `inherit`.

Manage schedules with `GET /v1/schedules`, `GET|PUT|DELETE /v1/schedules/{id}`,
and `POST /v1/schedules/{id}/pause|resume`. Read durable outcomes from
`GET /v1/schedule-activities`, optionally filtered by `scheduleId`.
Admitted work uses ordinary durable agent threads, so its activity and terminal
state also appear in the web and desktop clients.

Cron slots use wall-clock time in the recorded timezone. A wall time skipped by
daylight saving does not run. A repeated wall time runs once at its earlier
occurrence. Overlapping follow-ups are skipped because one durable agent accepts
one run at a time. Each schedule chooses whether an occurrence missed by more
than 90 seconds is skipped or run once after restart. Admission retries use the
recorded bounded attempt count and delay.

Schedules run inside the controller process. With a local controller, the host
and Docker engine must be online. `run_once` can admit one missed occurrence when
the controller returns; it does not make a local controller an always-on service.

## Persistent assistants

`POST /v1/assistants` defines a reusable assistant role on top of the durable
agent catalog. The body records instructions, provider, tools, repositories,
named secret access, ordinary run limits, and an opt-in persistence policy for
files and browser state. Memory is always inspectable; files and browser state
default to off, are encrypted per assistant, and are never shared with another
assistant.

The first `POST /v1/assistants/{id}/runs` creates the bound durable agent and
admits a run through the ordinary Cloud Agents path. Later runs follow up that
same agent, keep its history, and use the assistant's recorded limits.

Manage assistants with `GET /v1/assistants`, `GET|PUT|DELETE /v1/assistants/{id}`,
and `POST /v1/assistants/{id}/archive|unarchive|reset`. Inspect, edit, or delete
memory at `/v1/assistants/{id}/memory`. Opted-in files or browser blobs use
`PUT /v1/assistants/{id}/persistence` and `GET /v1/assistants/{id}/persistence/{files|browser}`.

Lifecycle effects:

- `IDLE` keeps subscriptions enabled and retains credentials, snapshots, and memory. No compute is implied.
- Archive rejects new runs, pauses subscriptions, and retains credentials and snapshots.
- Unarchive restores eligibility without waking a runtime.
- Reset clears memory and opted-in files/browser state while keeping run history.
- Delete removes the assistant and bound agent, disables subscriptions, revokes credentials, and leaves snapshots to ordinary policy expiry.

Each writable workspace has one owner: the principal that created the assistant.

## GitHub triggers

`POST /v1/integrations/github/triggers` opts one durable agent into GitHub work.
The request fixes the repository, allowed GitHub actors, event types, and repair
limits. The webhook payload cannot replace those values.

```json
{
  "repository": "acme/app",
  "agentId": "bc-existing-agent",
  "authorizedActors": ["octocat", "github-actions[bot]"],
  "events": ["issues", "pull_request_review", "pull_request_review_comment", "check_run"],
  "limits": {
    "maxAttempts": 3,
    "runSeconds": 3600,
    "inputWaitSeconds": 300,
    "maxComputeSeconds": 7200
  }
}
```

The create response returns a `webhookUrl` and a `secret`. GitHub needs both when
you create the repository webhook. The controller shows the secret only in that
response. Select the configured events and use `application/json` payloads.
Every delivery must include GitHub's `X-Hub-Signature-256`, `X-GitHub-Delivery`,
and `X-GitHub-Event` headers.

For a local CA-04A controller, the webhook URL must use an authenticated route
that GitHub can reach, such as the configured T3 Connect route. The controller
machine must be online when GitHub sends the delivery. Moving the controller to
an always-on host is a separate deployment choice.

Review comments and failed checks run against the exact pull request head SHA
from the delivery. Issue comments attached to pull requests are ignored because
that GitHub payload does not carry the head SHA. Bot-authored comments and
reviews are always ignored, which prevents agent-comment loops. Check-run bots
must be named in `authorizedActors`. A repeated delivery ID returns the recorded
result instead of starting another run.

Use these authenticated controls:

- `GET /v1/integrations/github/triggers`
- `GET /v1/integrations/github/triggers/{id}`
- `POST /v1/integrations/github/triggers/{id}/disable|enable`
- `DELETE /v1/integrations/github/triggers/{id}` to revoke it and remove its secret
- `GET /v1/integrations/github/trigger-activities?triggerId={id}` to read ignored,
  triggered, resolved, and unresolved deliveries

Attempts and worst-case run seconds are reserved per issue or pull request.
Work stops when either configured limit is reached, even when a repair pushes a
new head commit. Failed, cancelled, or expired runs appear as unresolved
activities. Triggers never merge changes automatically.

## Subscriptions and CI autofix

`POST /v1/agents/{id}/subscriptions` attaches an event source to a durable agent
so it can receive follow-ups while idle. Supported kinds are GitHub pull
requests and CI, Slack threads and channels, Linear issues and comments, and
one-shot timers or looping cron. List and cancel with
`GET|DELETE /v1/agents/{id}/subscriptions/{subscriptionId}`. Deliver an event
with `POST /v1/agents/{id}/subscriptions/{subscriptionId}/events`. Read
persisted outcomes from `GET /v1/agents/{id}/subscriptions/{subscriptionId}/receipts`.

Delivery targets the durable agent, coalesces bursts in a 30-second window, and
is idempotent on `deliveryId`. A successful receipt has `acknowledged: true` only
after the follow-up run is persisted. Failed wake or placement is retryable and
does not acknowledge. Idle agents remain listable and cancellable. Archive
disables subscriptions without deleting their audit receipts; unarchive restores
them. Wake is limited to 180 days of inactivity.

GitHub CI autofix (`kind: "github_ci"`) follows only agent-created pull requests
and skips human pushes, explicit user follow-ups, failures already present on
the base revision, and work after 10 repair attempts.

Self-hosted machines and team pools use the older `/v0/private-workers` paths. See
[Self-hosted machines and team pools](./cloud-agents-self-hosted.md).

Create accepts agent or plan `mode`, `model` (id plus params), named `env` or `repos`,
`scratch` (`name`, `visibility`) for start-from-scratch, ref/PR fields (`startingRef`, `prUrl`, `workOnCurrentBranch`, `autoCreatePR`,
`skipReviewerRequest`), images (max 5, 15 MB, png/jpeg/gif/webp), `envVars` (max 50; not with
`agentId`), inline MCP servers (max 50; HTTP or stdio), and custom subagents (max 20;
names cannot collide with built-ins; prompts are size-bounded). Multiple `repos` prepare
together and can open coordinated PRs. Long-running is not available for multi-repo
environments. HTTP MCP credentials,
including OAuth, stay on the controller. stdio MCP runs in the guest. Custom subagents
inherit the parent run's permissions and cannot widen them. New branches use the `cursor/`
prefix unless the request stays on the current branch, starting ref, or an existing PR.

Web, desktop Cloud destination, API, Slack, Bitbucket mentions, and Linear create
or follow up through one idempotent path: `POST /v1/integrations/runs` or the
matching integration route. GitHub repository webhooks use the trigger flow above.
A repeated `deliveryId` returns the original agent and run. Connect GitHub, GHES,
GitLab, Bitbucket, or Azure DevOps with
`POST /v1/integrations/scm`. Access is the intersection of that installation, the
triggering principal, and the agent's `repos`. Shared `/cloud-agents/{id}` URLs require
same-team membership and the viewer's own SCM access; viewing is read-only unless team
follow-ups are enabled.

Cloud agents also receive the built-in diagnostics MCP (`environment-info`, snapshot
and Build tools, run transcript/events, and authorized fleet diagnostics). Repository
`.cursor/hooks.json` command hooks run for supported tool, file, and lifecycle events.
Hooks from the operator's home directory are not available in the cloud guest, and
mutating hooks do not run during early read-only environment setup.

## Errors, request IDs, and rate limits

Error bodies are `{ "code", "message" }` with stable codes including `unauthorized`,
`invalid_request`, `agent_id_conflict`, `agent_busy`, `agent_archived`,
`agent_not_found`, `run_not_found`, `run_not_cancellable`, `invalid_last_event_id`,
`stream_expired`, `rate_limited`, `spend_limit_exceeded`, `follow_up_forbidden`,
`scm_access_denied`, `self_hosted_disabled`, `self_hosted_required`, `schedule_not_found`,
`assistant_not_found`, and `subscription_not_found`.

Every response includes `X-Request-Id` and `X-RateLimit-*` headers. Repositories
are limited to 1 request per minute and 30 per hour per principal. Other routes
allow 60 requests per minute.
