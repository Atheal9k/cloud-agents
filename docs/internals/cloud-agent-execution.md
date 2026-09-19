# Cloud agent execution ownership

Cloud workers run an ordinary T3 environment. The controller allocates the
worker and remembers how to reach it, but it does not proxy provider protocol
messages or project the thread a second time.

This boundary was selected by CA-01 after AWS proofs with T3 0.0.42, Codex
0.154.0, and Claude Code 2.1.273 on Amazon Linux 2023. A controller instance
created a project, thread, and turn through the worker's authenticated
orchestration HTTP API. The one-shot dispatch client then exited. A separate
timer fetched the same thread after the provider turn completed.

The dispatch client exited at `2026-09-17T01:54:57Z`; the retrieval client ran
at `2026-09-17T01:58:03Z`. It read snapshot sequence 23 with a ready Codex
session and no active turn, including the assistant result
`CA-01_UNATTENDED_OK`. The worker still served T3 and held a file containing
the same value at `/work/ca01/ca01-result.txt` (SHA-256
`7dc9ba47f1ac4be9970ea7c70ecf5cf2c71b3990c9f0b52ebfbc5e93c5dfdaee`).

The Claude dispatch client exited at `2026-09-17T02:32:00Z`; its retrieval
client ran at `2026-09-17T02:35:07Z`. Snapshot sequence 54 showed a ready
`claudeAgent` session with no active turn or error and included
`CA-01_CLAUDE_UNATTENDED_OK`. The worker file contained the same value at
`/work/ca01-claude-v4/ca01-claude-result.txt` (SHA-256
`b38f8cacbc83ec94c45d2f9bae2b583e0eddf0c969ac49e129fd22cff21c2c29`).

## Authority

| State                                                                    | Writable authority       | Proof location                                                                    |
| ------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------- |
| Thread events and projections                                            | Worker T3 environment    | The selected T3 base directory's `userdata/state.sqlite`                          |
| Checkout and task files                                                  | Worker T3 environment    | The project workspace, such as `/work/ca01`                                       |
| Provider authentication and resumable provider session                   | Worker provider user     | `/home/cloudagent/.codex` or `/home/cloudagent/.claude`                           |
| Allocation, attempt, deadlines, and worker/environment/thread references | Controller               | AWS tags and controller proof records in CA-01; a durable store from CA-02 onward |
| Retained results                                                         | Controller-owned archive | Read-only after capture; never a live orchestration writer                        |

Only the worker runs the thread's decider, projector, provider adapter, and
checkpoint reactor. The controller may cache summaries or archive a completed
thread, but those copies cannot accept thread commands. A reconnect fetches the
worker's snapshot and resumes its subscriptions instead of replaying commands
through a second controller-side runtime.

## Why the worker uses T3

A smaller execution bridge would still need provider process supervision,
Codex app-server or Claude Agent SDK translation, approvals, questions,
terminal state, event ordering, reconnect cursors, interruption, resume,
checkpoints, and scoped authentication. Those are already coupled by T3's
environment boundary. Building a bridge would create another protocol and
either duplicate that state machine or weaken reconnect behavior.

Running T3 on the worker adds one service and its local database, but requires
no new execution protocol. The controller only needs allocation operations and
an authenticated route to the existing HTTP/WebSocket contracts. This is the
smaller change and preserves one writer per thread.

## Provider qualification

### Codex

Codex supports Linux and headless device-code authentication. Operators create
the account cache on a trusted machine with `codex login --device-auth` and
store the complete `auth.json` in Secrets Manager. A disposable worker restores
the cache into its isolated provider home. Codex refreshes the ChatGPT
credentials, and a root helper writes a changed cache back to the same scoped
secret when the file changes and again during service cleanup. Workers sharing
one cache are serialized so refresh-token rotation has one writer. Expired or
revoked credentials require another login and secret replacement.

For long-lived unattended workers, an API key can instead be supplied through
`codex login --with-api-key` over standard input. API-key use is billed as API
usage and must not be treated as included ChatGPT subscription capacity. The
credential should be injected at provisioning time, kept out of images and
task processes, and rotated through the provider account boundary.

T3 starts and interrupts Codex through the existing app-server adapter. It
stores the Codex continuation cursor with the worker-owned thread and keeps
Codex rollout data under the provider home. A later turn can resume that
persisted session on the same durable worker state. Terminating the worker
without retaining both T3 and Codex state cannot resume an arbitrary live
process; retained results and explicit retry are the recovery boundary.

### Claude

Claude Code supports a long-lived subscription token created by
`claude setup-token`. Operators create it on a trusted machine and store the raw
value in Secrets Manager. Provisioning injects it as
`CLAUDE_CODE_OAUTH_TOKEN`; it is not copied from a desktop credential cache and
does not need writeback from a disposable worker.

T3 runs Claude through its existing Agent SDK adapter. The adapter persists the
Claude session identifier with the worker-owned thread, sends interrupts to the
live SDK session, and supplies the saved identifier when it resumes. The same
durability limit applies as Codex: both T3 state and the provider home must
survive if a later worker process is expected to resume the session.

Claude Agent SDK use draws from a separate monthly Agent SDK credit on
subscription plans. A Console API key uses API billing instead. Long-running
infrastructure must choose and budget one of those modes explicitly.

Codex and Claude are qualified for this ownership model. Other providers need
the same Linux, authentication, interruption, resume, and disconnect proof
before cloud execution enables them.

## Route and bootstrap findings

The proof used a private security-group route from controller to worker TCP 3773. The worker accepted no public ingress. The controller obtained a scoped,
two-hour T3 bearer session from an ephemeral secrets entry and used normal T3
HTTP commands; SSM was limited to bootstrap diagnostics and the interactive
provider login. It did not launch, carry, or poll the agent turn.

The Amazon Linux image needed these explicit inputs:

- Node.js 24.13.1, T3 0.0.42, and Codex 0.154.0;
- the `@t3code/t3-linux-x64` optional package;
- `make` and `gcc-c++` when a matching `node-pty` prebuild is unavailable;
- `libatomic` for the packaged T3 executable.

The Claude worker used the same base plus Claude Code 2.1.273. It set
`DISABLE_AUTOUPDATER=1` so the bounded proof kept its pinned CLI version.
T3 identifies the built-in Claude provider as `claudeAgent`, not `claude`.
Controllers must use the instance identifier advertised by the worker rather
than deriving one from the executable name. Bootstrap must also create the
workspace root with ownership for the T3 service user before registering the
project.

Image construction should install and health-check these dependencies before
registration. A healthy worker starts T3 through the service manager without a
controller command.

Worker profiles may later declare operating system, architecture, device, and
preview capabilities. Allocation can match one requested profile without
introducing a general scheduler or changing thread ownership.

Provider references: [Codex CLI](https://developers.openai.com/codex/cli),
[authentication](https://developers.openai.com/codex/auth), and
[CLI resume commands](https://developers.openai.com/codex/cli/reference).
Claude references: [authentication](https://code.claude.com/docs/en/team) and
[CLI resume commands](https://docs.anthropic.com/en/docs/claude-code/cli-usage).

## Environment resolution

A cloud environment is a versioned catalog record, not a recipe carried on an
allocation. Editing one appends an immutable version; restoring one appends
another version that copies a prior config and records `restoredFromVersion`.
An agent pins the version reference it resolved at launch, so later edits never
change a running agent's environment. See
[`CloudEnvironmentCatalog`](../../apps/server/src/cloud/CloudEnvironmentCatalog.ts).

For one repository the catalog resolves in this order, first match wins:

1. a version whose source is the repository's committed config, either
   `.cursor/environment.json` or the T3 equivalent `t3.cloud.json`;
2. a personal saved environment;
3. a team saved environment;
4. the default environment.

The controller performs this lookup itself during `allocation.launch`. A launch
command carries no environment, because the resolved config decides the base
image, runtime user, and egress policy — a client that could supply one could
choose its own sandbox. Committed repository configs therefore reach the
catalog through an authorized save whose source is `repository`, not through
the launch path.

Saving a personal, team, or default environment for a repository that already
has a committed config fails with `repository-environment-exists`. Editing the
committed file, and re-saving the repository-sourced environment from it,
is the only way to change that repository's environment. This keeps one
authority per repository instead of a dashboard copy that silently diverges
from the file in the tree.

The config shape follows Cursor's
[environment schema](https://cursor.com/schemas/environment.schema.json) with
one added rule: exactly one of `build`, `image`, or `snapshot`. A committed
file may carry `$schema` for editor completion; decoding ignores it and T3
never writes it back.

## Builds

A Build is a prepared disk snapshot for one environment version: it resolves
each repository's default ref, clones at those commits, runs `install` to
completion, and leaves the tree behind for later runs to boot. Clone and
dependency installation therefore happen before a run rather than inside it.
See [`CloudEnvironmentBuildRunner`](../../apps/server/src/cloud/CloudEnvironmentBuildRunner.ts).

Activation is the invariant worth protecting. A Build becomes an environment's
`activeBuildId` only when it is both successful and saved, and the pointer
moves in the same transaction that settles the record. A failed, cancelled, or
still-draft Build cannot displace the last active one, and a settle only
applies to the status the caller read, so a late success cannot overwrite a
cancellation. Agent-requested Builds from CA-59 start as drafts: they can be
tested, but a person saving one is what activates it.

Each Build records an inputs fingerprint covering the environment version's
config, its build-time secret references, and the commits it cloned. Runtime
secrets are excluded because they never enter a shared snapshot. A recurring
trigger whose fingerprint matches the active Build is skipped instead of
rebuilt, and the skip refreshes the active Build's `freshAt`. Manual,
configuration-change, and agent-requested triggers always rebuild, because each
one means the caller wants the disk remade.

Staleness decides what a launch boots. The controller pins the active Build
onto the allocation only when it is fresh, defaulting to 24 hours and
configurable per environment; `0` refreshes every time. A run that boots a
Build then checks out the ref it asked for, so a feature branch starts from the
prepared tree rather than a cold clone. When no fresh Build exists the
allocation carries none and the run prepares for itself, which is the honest
outcome when the refs, config, or secrets may have moved on.

The base stage records the base a snapshot was made on rather than packing an
image; packing Linux runtimes is CA-44's work. The base is part of the config
and therefore part of the fingerprint, so changing it still invalidates the
snapshot. `install` runs from a generated script file rather than an inline
shell argument, because passing a shell string as one spawn argument is mangled
by Windows quoting, where a quoted command silently exits 0 without running.
