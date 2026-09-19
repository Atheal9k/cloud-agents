# Self-hosted machines and team pools

Keep tool execution on your own machines while T3 remains the control plane.
Admins choose the policy in Settings → Cloud Agents → Defaults and policy.

## Start

1. Set **Self-hosted machines** to Allow (users opt in) or Require (every Cloud Agent run uses a worker). Off keeps managed runtimes.
2. Create a service-account API key for team pools. Personal machines use a user API key.
3. Register a pool, then start workers that connect outbound only.

```bash
curl --request POST --url http://localhost:13773/v0/private-workers/pools \
  -u "$T3_API_KEY:" --header 'Content-Type: application/json' \
  --data '{"scope":"team","poolName":"gpu","workerReadyTimeoutSeconds":900}'

curl --request POST --url http://localhost:13773/v0/private-workers/connect \
  -u "$T3_API_KEY:" --header 'Content-Type: application/json' \
  --data '{"kind":"team_pool","poolName":"gpu","workspaceRoots":["/work/app"]}'
```

Workers never open inbound ports. Optional flags on connect: labels, up to 20 workspace roots, `cloneGitRepos` / `mintGithubToken`, `secretSync`, `identitySocket`, `computerUse`, and `managementAddr` for `/healthz`, `/readyz`, and `/metrics`.

## Pools versus personal machines

- Personal machines can run more than one agent when `maxAgents` is set.
- Team pools take one agent per worker. The pool stays registered after the last worker disconnects so you can scale to zero.
- Create an agent with `env: { "type": "pool", "name": "gpu" }` or `env: { "type": "machine" }`.

## Hibernate and restore

`workerReadyTimeoutSeconds` is how long a follow-up waits for the claimed worker to reconnect. Pending list and watch entries include `claimedWorkerId` and `wakeTimeoutMs`. Start that worker id to resume; if the window lapses, a fresh worker may claim the request. `POST /v0/private-workers/{id}/idle-release` is the worker-side idle exit. `POST /v0/private-workers/claims/{id}/release` drops the routing claim without checking whether the process is still connected.

## Watch the queue

List pending requests, keep `streamCursor`, then `GET /v0/private-workers/pending-requests/stream`. Events: `created`, `claimed`, `claimed_offline`, `expired`, `heartbeat`. A `410 cursor_expired` body means relist — cursors last five minutes and are not extended by heartbeats.
