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

Codex was selected as the first cloud provider. The CLI supports Linux and
headless device-code authentication. CA-01 performed a fresh
`codex login --device-auth` as the worker service user rather than copying a
desktop auth cache. The resulting cache belongs to that worker identity; the
CLI is responsible for refreshing ChatGPT credentials while they remain
valid. Expired or revoked credentials require another login.

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

Claude Code supports Linux and browser authentication from remote shells.
CA-01 ran `claude auth login` on the worker and completed the returned browser
flow. Claude stored the refreshable subscription credential at
`/home/cloudagent/.claude/.credentials.json`; no desktop credential cache was
copied.

T3 runs Claude through its existing Agent SDK adapter. The adapter persists the
Claude session identifier with the worker-owned thread, sends interrupts to the
live SDK session, and supplies the saved identifier when it resumes. The same
durability limit applies as Codex: both T3 state and the provider home must
survive if a later worker process is expected to resume the session.

The proof used a Claude Team subscription. Anthropic accounts Agent SDK usage
against a separate monthly Agent SDK credit on subscription plans. A Console
API key uses API billing instead. Long-running infrastructure must choose and
budget one of those modes explicitly.

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
