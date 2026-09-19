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
| Provider authentication and resumable provider session                   | Worker provider user     | The provider home under the worker runtime directory, cleared by a stop           |
| Allocation, attempt, deadlines, and worker/environment/thread references | Controller               | AWS tags and controller proof records in CA-01; a durable store from CA-02 onward |
| Retained results                                                         | Controller-owned archive | Read-only after capture; never a live orchestration writer                        |

Only the worker runs the thread's decider, projector, provider adapter, and
checkpoint reactor. The controller may cache summaries or archive a completed
thread, but those copies cannot accept thread commands. A live reconnect uses
the worker's T3 snapshot and `afterSequence` / windowed `turnLimit` cursors.
A hibernated agent is read from the retained transcript and result summary
without waking a guest. The Cloud Agents API SSE log is a bounded derived
projection of those sources, not a second live decider.

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
the launch path. A run records that version and, when a fresh Build exists,
the Build ID; later edits append a new version and never rewrite the pinned
runtime.

CA-10 per-run recipes map onto this model: setup becomes terminating
`install`, the first dev server becomes per-boot `start`, remaining servers
become named terminals, and secret references become environment-variable,
runtime-redacted, or Build-only classes. See
[`cloudEnvironmentFromRecipe`](../../packages/contracts/src/cloudEnvironmentRecipe.ts).

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

Private submodule, LFS, and package-registry destinations are environment
policy. The controller checks each host against the resolved egress mode
before a Build starts and names the host that failed. Optional company-network
overlays (stable egress, Tailscale, Cloudflare Tunnel, PrivateLink) record
cost, trust, and routing; disabling one falls back to public routing plus the
documented controller, SCM, artifact, and Cursor exceptions so runs are not
stranded. See
[`cloudPrivateNetwork`](../../packages/contracts/src/cloudPrivateNetwork.ts).

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
secrets are excluded because they never enter a shared snapshot. User secrets
are excluded even if they were labelled Build-only. A recurring trigger whose
fingerprint matches the active Build is skipped instead of rebuilt, and the
skip refreshes the active Build's `freshAt`. Manual, configuration-change, and
agent-requested triggers always rebuild, because each one means the caller
wants the disk remade.

`install` must terminate. `start` and named terminals run on every runtime boot
with health and logs; they do not re-run `install`. Multi-repo Builds are
rejected before they start when ports collide, a private dependency is not
listed as a repository with a per-repo ref, or a required Build secret is
missing. See
[`CloudEnvironmentRuntimeBoot`](../../apps/server/src/cloud/CloudEnvironmentRuntimeBoot.ts).

Staleness decides what a launch boots. The controller pins the active Build
onto the allocation only when it is fresh, defaulting to 24 hours and
configurable per environment; `0` refreshes every time. A run that boots a
Build then checks out the ref it asked for, so a feature branch starts from the
prepared tree rather than a cold clone. When no fresh Build exists the
allocation carries none and the run prepares for itself, which is the honest
outcome when the refs, config, or secrets may have moved on.

The base stage records the base a snapshot was made on. Linux runtimes pack as
Firecracker guests on hypervisor hosts in a dedicated execution account. Each
guest consumes explicit CPU, memory, disk, and profile slots: CPU may be
oversubscribed within the host's measured ratio, but memory and disk may not,
so one agent cannot OOM a neighbor. A guest gets its own VM, encrypted disk
key, tap network, and cgroup, and cannot read hypervisor credentials, instance
metadata, or sibling disks. See
[`firecrackerPlacement`](../../apps/server/src/cloud/firecrackerPlacement.ts).

Losing a hypervisor reschedules only guests that already have a snapshot.
Active processes are not migrated. The older per-thread `RunInstances` path is
still a migration fallback: it is tagged `ec2-migration-fallback` and is not
Cursor parity. Packing is `cursor-firecracker`. The base is part of the config
and therefore part of the fingerprint, so changing it still invalidates the
snapshot. `install` runs from a generated script file rather than an inline
shell argument, because passing a shell string as one spawn argument is mangled
by Windows quoting, where a quoted command silently exits 0 without running.

Android emulator jobs do not pack on Firecracker. They need `/dev/kvm` inside
the worker, which this fleet does not expose to guests. The `linux-android`
profile launches a nested-virtualization EC2 type on demand, proves KVM before
Gradle, and keeps AVD data on a job-scoped path separate from the environment
Build. See [`cloudLinuxAndroid`](../../packages/contracts/src/cloudLinuxAndroid.ts).

## Idle release

A run ends; the conversation does not. When a turn settles, the controller
flushes the guest and starts an idle-release timer instead of terminating the
worker. A follow-up inside the window reuses the same guest. After it, the
guest is stopped with its disk intact, and a later follow-up starts it again on
a new, fenced attempt. See
[`cloudHibernationPolicy`](../../apps/server/src/cloud/cloudHibernationPolicy.ts).

The flush is what makes the window safe to hold. It runs on the guest, because
only the guest knows where its database, workspace, and provider home are: it
truncates the T3 write-ahead log into the database file and captures the
workspace, including uncommitted and untracked work, at
`refs/t3/cloud-idle/<allocation>/<attempt>`. Each part is reported separately
and `unavailable` is a real answer. The provider home is a runtime directory
that a stop clears, so the flush says so rather than implying the provider
session survives.

That is also why a wake reports two things. The filesystem comes back from the
snapshot; the provider CLI does not resume its native session against it. T3
continues the thread from its own restored database, and the restore record
keeps those two claims apart instead of collapsing them into "restored".

Stopping the guest and recording its snapshot are separate steps, so a crash
can land between them. The snapshot is written only after AWS reports the guest
stopped, which makes the step idempotent: a controller that restarts mid-release
observes the stopped guest and records the same snapshot. If the guest is gone
instead, the allocation is cleaned up rather than left claiming a snapshot it
cannot restore, and the retained result stays the recovery boundary.

Three rules keep a stopped guest from being read as an expired one:

- The controller's own sweep skips any instance an allocation still holds a
  snapshot for. A hibernated guest carries the attempt it stopped on, which is
  behind the attempt a wake creates, so every staleness rule would otherwise
  match it.
- The AWS backstop skips instances tagged `CloudAgentHibernated`. Its run
  deadline has usually passed, so only the tag separates it from an abandoned
  stopped worker. The controller sets that tag before it stops the guest.
- The guest's own timer stops the instance rather than terminating it. It
  bounds how long a guest may run unattended, not how long the conversation
  lives.

A macos-ios worker is a different cost boundary. The guest can still idle and
hibernate, but the EC2 Mac Dedicated Host stays allocated for at least 24 hours
and is billed separately from the job. Cancelling a two-hour Simulator job does
not release the host. Wake never claims the Simulator process resumed.

A woken guest boots from cloud-init state that ran once, on a different boot.
Provider credentials live in a runtime directory that is empty every time, so
`cloud-agent-worker-credentials.service` materializes them from Secrets Manager
on every boot, preferring the refreshed cache the previous shutdown staged.
Bootstrap runs the same script, so the first boot exercises the path a wake
depends on.

Compute is metered across these transitions by summing the intervals a guest
was running, rather than from launch to cleanup. An open conversation would
otherwise report days of compute it never used.

## MCP servers, hooks, and custom subagents

Cloud runs admit team, personal, and API MCP servers against the environment
allowlist and the CA-49 egress policy. HTTP and SSE credentials, including
per-user OAuth, stay on the controller and the guest only receives a proxied
URL plus a session token. stdio servers execute in the runtime. Failures are
isolated, redacted, and cannot widen egress or secret access. See
[`cloudExtensibilityPolicy`](../../apps/server/src/cloud/cloudExtensibilityPolicy.ts).

Repository `.cursor/hooks.json` command hooks run in the guest for supported
tool, file, and lifecycle events. `~/.cursor/hooks.json` is unavailable in the
guest (there is no operator home). During early read-only environment setup
(`install`), only `beforeReadFile` may run; mutating hooks wait until runtime.

API custom subagents are bounded in count and prompt size, cannot shadow
built-ins (`explore`, `debug`, `shell`, `computerUse`), inherit a permission
set that is never wider than the parent, and emit usage on the run.

The built-in diagnostics MCP is always admitted. T3 names are canonical; the
`cursor-cloud-` prefixes are aliases with the same arguments so the env-setup
skill can call either.

## Retention, archive, and deletion

Live compute, the disk an idle agent left behind, the conversation, and the
retained artifacts each leave on their own terms. Keeping them separate is what
lets an abandoned disk stop costing storage while the conversation it belongs
to stays readable forever. See
[`cloudRetentionPolicy`](../../apps/server/src/cloud/cloudRetentionPolicy.ts)
and [`CloudAgentRetention`](../../apps/server/src/cloud/CloudAgentRetention.ts).

A hibernated disk gets a rolling ninety-day inactivity window, reissued in full
by every successful start or resume rather than extended. The clock is read
from the last start or resume, not from `updatedAt`, because the sweep writes
events itself and would otherwise keep an abandoned agent alive by touching it.
Collecting an expired disk only requests cleanup; the reconciler is still the
one thing that terminates a guest, so a collection pass cannot reach one that
is running or waking. The conversation survives, and a later follow-up places a
fresh runtime instead of restoring a snapshot that no longer exists.

Conversations and runs are kept indefinitely. An administrator can set
`T3CODE_CLOUD_CONVERSATION_RETENTION_DAYS`, where the default `0` means
forever; a cap deletes rather than archives, because an agent an operator can
still read is not a retention limit. Retained artifacts keep their own declared
expiry and are swept on the same pass.

Archive releases the runtime claim along with the stopped guest it was holding.
That is what makes unarchive honest: eligibility comes back without waking
anything, because there is no snapshot left to restore, and the follow-up that
comes next places a new runtime. Archiving and deleting both refuse while a run
is in flight, and both are idempotent.

Permanent delete is the one place this system erases rather than hides. The
delete is recorded first and the guest released before anything is removed, so
a controller that crashes mid-delete finishes it rather than leaving half a
conversation behind. Once cleanup succeeds, the retained results for every
attempt are erased and the agent's event rows are deleted in the same
transaction that writes its tombstone. The rows have to go: the prompt, titles,
and run history live in them, and a delete that only hid the conversation would
not be permanent. The tombstone is all that remains, which is what keeps the
delete idempotent and visible without retaining what it erased.

Two limits are recorded rather than papered over. An immutable disk snapshot
leaves on policy expiry, not on demand, so the tombstone says `policy-expiry`
instead of claiming the disk is gone. Published branches and pull requests are
never touched, because nothing in the delete path talks to a remote. Result
directories are derived from the allocation rather than taken as a path, so a
purge cannot reach another agent's data, and Build snapshots live in their own
root that retention never reads.
