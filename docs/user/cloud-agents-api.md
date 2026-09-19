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
- `GET /v1/agents/{id}/runs` and `GET /v1/agents/{id}/runs/{runId}`
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

Web, desktop Cloud destination, API, Slack, GitHub/Bitbucket mentions, and Linear create
or follow up through one idempotent path: `POST /v1/integrations/runs` or
`/v1/integrations/{slack,github,bitbucket,linear}`. A repeated `deliveryId` returns the
original agent and run. Connect GitHub, GHES, GitLab, Bitbucket, or Azure DevOps with
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
`scm_access_denied`, `self_hosted_disabled`, and `self_hosted_required`.

Every response includes `X-Request-Id` and `X-RateLimit-*` headers. Repositories
are limited to 1 request per minute and 30 per hour per principal. Other routes
allow 60 requests per minute.
