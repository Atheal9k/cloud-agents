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
- `POST /v1/agents/{id}/archive` and `POST /v1/agents/{id}/unarchive` (idempotent)
- `DELETE /v1/agents/{id}` — permanent delete
- `GET /v1/me`, `GET /v1/models`, `GET /v1/repositories`

Create accepts agent or plan `mode`, `model` (id plus params), named `env` or `repos`,
ref/PR fields, images (max 5, 15 MB, png/jpeg/gif/webp), `envVars` (max 50; not with
`agentId`), inline MCP servers (max 50; HTTP or stdio), and custom subagents (max 20;
names cannot collide with built-ins; prompts are size-bounded). HTTP MCP credentials,
including OAuth, stay on the controller. stdio MCP runs in the guest. Custom subagents
inherit the parent run's permissions and cannot widen them.

Cloud agents also receive the built-in diagnostics MCP (`environment-info`, snapshot
and Build tools, run transcript/events, and authorized fleet diagnostics). Repository
`.cursor/hooks.json` command hooks run for supported tool, file, and lifecycle events.
Hooks from the operator's home directory are not available in the cloud guest, and
mutating hooks do not run during early read-only environment setup.

## Errors, request IDs, and rate limits

Error bodies are `{ "code", "message" }` with stable codes including `unauthorized`,
`invalid_request`, `agent_id_conflict`, `agent_busy`, `agent_archived`,
`agent_not_found`, `run_not_found`, `run_not_cancellable`, `invalid_last_event_id`,
`stream_expired`, and `rate_limited`.

Every response includes `X-Request-Id` and `X-RateLimit-*` headers. Repositories
are limited to 1 request per minute and 30 per hour per principal. Other routes
allow 60 requests per minute.
