# Cloud agent security controls

Security policy belongs to an environment and to the runtime it boots, not to the
machine underneath. An environment states what it needs; the controller states
the ceiling an administrator will not let an environment exceed.

## Secrets

A secret is declared by name and reference. Values never travel through the
controller's reports, the runtime metadata endpoint, or a Build snapshot listing.

Each declaration has a scope and an availability:

| Scope         | Applies to                                             |
| ------------- | ------------------------------------------------------ |
| `environment` | Only runs of that environment. The default.            |
| `user`        | Runs triggered by the named user.                      |
| `team`        | Every run in the team, unless something narrower wins. |

| Availability       | Visible during                                       |
| ------------------ | ---------------------------------------------------- |
| `build`            | The Build only. Never present on a booted runtime.   |
| `runtime`          | Each runtime boot. Never baked into a snapshot.      |
| `runtime-redacted` | The same, and scrubbed from transcripts and results. |

When two scopes declare the same name, the narrowest wins: environment, then
user, then team. The readiness screen reports which one won.

## Egress

An environment chooses one of three modes in `environment.json`:

- `allow_all` — unrestricted.
- `default_with_network_settings` (or `parent_plus_network_settings`) — a small
  default set of package registries plus the environment's allowlist. The
  `parent_` spelling also inherits the team allowlist.
- `network_settings_only` — the allowlist and nothing else.

The controller's own destinations are always reachable and are listed explicitly
on every resolved policy so an allowlist-only runtime is never mysterious: the
controller itself, the source-control hosts, and the artifact store.

Set a team ceiling with `T3CODE_CLOUD_EGRESS_MODE` and
`T3CODE_CLOUD_EGRESS_ALLOWLIST`. Setting `T3CODE_CLOUD_EGRESS_ADMIN_LOCK=true`
makes it a lock: an environment may narrow the mode or the allowlist and may not
widen either. A narrowed policy reports `source: narrowed` with the mode it
overrode.

## Runtime identity

Each runtime gets a local Unix socket (a named pipe on Windows) that only its own
user can open. Nothing on it is reachable over the network.

- `GET /metadata` — agent, run, owner, workspace, environment, repositories,
  managed or self-hosted hosting, the resolved egress policy, and the names of
  the secrets that are bound. No values.
- `GET` or `POST /token` — an EdDSA OIDC token carrying those same claims, valid
  for five minutes. Limited to 60 requests a minute.
- `GET /.well-known/jwks.json` — the key set that verifies the token.

## Encryption and Privacy Mode

Client and worker transports require TLS 1.2 or newer. Snapshots and artifacts
are encrypted at rest; set `T3CODE_CLOUD_KMS_KEY_ARN` to use your own KMS key.
Every Firecracker guest has its own disk key, so one runtime cannot read another
one's disk; the EC2 fallback has no per-guest key and the readiness screen says
so. `T3CODE_CLOUD_PRIVACY_MODE=true` keeps prompts and diffs inside the
environment.

## Repository access

A run never gets access wider than the person who triggered it. On top of that:

- `T3CODE_CLOUD_SCM_BLOCKED_REPOSITORIES` — never reachable from a runtime.
- `T3CODE_CLOUD_SCM_PROTECTED_REPOSITORIES` — reachable only when the
  environment declares the repository. Both accept a trailing `*`, so
  `owner/*` and `owner/prefix-*` both work.
- `T3CODE_CLOUD_SCM_MAX_SCOPE` — `read`, `write`, or `admin`. Defaults to `write`.
- `T3CODE_CLOUD_SCM_CREDENTIAL_TTL_SECONDS` — clamped to one hour.
- `T3CODE_CLOUD_SCM_ASSUME_ROLE_ARN` and
  `T3CODE_CLOUD_SCM_ASSUME_ROLE_EXTERNAL_ID` — optional AWS federation. The
  session is clamped to the credential's lifetime.

A run that fails any of these is refused before a worker is launched, so a
blocked repository is never cloned.
