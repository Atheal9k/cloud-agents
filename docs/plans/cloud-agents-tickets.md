# Cloud agents for T3 Code: implementation tickets

Revised 21 September 2026. This revision replaces the unfinished
AWS/Firecracker runtime plan with Daytona-managed sandboxes. A local or hosted
T3 server is the controller. Daytona is the execution plane for ordinary
coding work and for Metro when an Expo development build runs on the owner's
physical Android phone. CA-60 through CA-68 now cover that migration and its
release proof.

Completed ticket statuses and PR links remain as implementation history. They
do not prove the new Daytona path or make the old EC2 and emulator work a
release dependency. Do not launch new EC2 or KVM resources for CA-60 through
CA-68. The controller may still run on infrastructure chosen by the owner, but
the controller host does not run repository workloads.

## Agreed scope

T3 may run locally or on a hosted server. It owns the user interface, durable
agent state, policy, and Daytona allocation records. A local controller must
stay online to accept prompts and reconcile work. A hosted controller removes
that dependency. Both modes use the same controller contracts.

The completed local-host release proves one workflow with one provider, one
GitHub repository per run, and one worker at a time:

1. Submit a coding task from web, desktop, or the supported phone client.
2. Let the Daytona sandbox continue after the initiating client disconnects,
   while the selected T3 controller remains online.
3. Open the frontend inside the thread and interact with it.
4. Observe the agent's actual browser, take control, and return control.
5. Receive a saved diff, test results, and a draft PR.
6. Recover from a disconnect or restart and stop compute without losing acknowledged results.

That release is migration history, not the final runtime choice. The parity program adds
parallel agents, multi-repository environments, agent and run APIs,
integrations, subscriptions, fleet administration, and optional native-mobile
surfaces without discarding the completed path.

Android application development uses an installed Expo development build on the
owner's physical phone. Metro runs inside that agent's Daytona sandbox and
publishes an Expo tunnel URL that the development build opens. A separate,
explicitly enrolled phone-side broker provides agent inspection and input. The
Metro tunnel carries JavaScript bundles and Fast Refresh traffic. It does not
grant device control.

## Architecture and efficiency decisions

### Keep the controller portable and use Daytona for execution

The controller serves the UI, authentication, allocation catalog, policy,
retained results, and Daytona integration. CA-04A and CA-04C established the
local packaged controller. CA-04B established the hosted mode. The hosting
provider is not part of the execution contract. Repository code, provider
processes, builds, and Metro run inside Daytona sandboxes, not with controller
host permissions.

CA-01 must prove the smallest extension of T3's existing environment model before fixing a new execution protocol. The starting candidate is an ordinary T3 environment on a worker, reached through existing typed RPC and subscriptions. Reuse its provider adapters, project/thread ownership, event store, terminal, checkpoints, and permissions.

There must be one writable authority for each live thread. The active Daytona sandbox
owns T3's decider, projector, provider adapter, checkpoint reactor, workspace,
and provider home. The controller owns the durable agent/run catalog,
environment and Build records, placement, consistent snapshots, artifacts, and
publication. It does not run a second live decider/projector. Hibernate first
flushes a consistent restorable snapshot and fences the old writer; wake
starts or resumes exactly one new writer.

This remains a single-controller deployment. Multi-controller consensus and
transparent migration of arbitrary in-flight processes are out of scope.
Daytona owns sandbox placement and isolation. T3 must not depend on Daytona's
internal scheduler or hypervisor implementation.

### Match Cursor's object model, not its branding

An **agent** is the durable conversation. A **run** is one submitted turn. An
**environment** is versioned setup policy. A successful **Build** is a prepared
disk snapshot. A **runtime** is an isolated guest used only while a run is
active or within a bounded idle window.

- Agent status: `ACTIVE`, `IDLE`, or `ARCHIVED`.
- Run status: `CREATING`, `RUNNING`, then `FINISHED`, `ERROR`, `CANCELLED`, or
  `EXPIRED`.
- One agent has at most one active run.
- `IDLE` accepts follow-ups without requiring a running VM.
- Environment config precedence: repository file, personal saved environment,
  then team/default environment.
- `install` runs while creating a Build; `start` and named terminals run on
  each runtime boot.

The [Cursor-parity architecture](./cursor-parity-cloud-architecture.md)
contains the rationale and migration topology. This file is the authoritative
implementation backlog.

### Daytona is the execution API, not the thread protocol

| Mechanism                                             | Responsibility                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Daytona SDK/API                                       | Create, start, stop, archive, inspect, snapshot, and delete sandboxes.                                 |
| Daytona image or snapshot                             | Supply repeatable system tools and stable dependencies.                                                |
| Existing T3 RPC, subscriptions, and provider adapters | Conversation, tool activity, questions, approvals, terminals, and agent control.                       |
| Signed Daytona preview URL or T3 authenticated proxy  | Expose a sandbox HTTP service to an authorized viewer.                                                 |
| Expo tunnel                                           | Connect an installed Expo development build to Metro in its Daytona sandbox.                           |
| Enrolled Android device broker                        | Carry narrowly scoped device observations and control commands over an outbound authenticated channel. |

The Daytona sandbox is a remote machine, not a replacement for T3's provider
protocol. T3 records the sandbox ID and lifecycle receipts, while the worker's
T3 runtime remains the only live thread writer. Do not give a browser a Daytona
API key or sandbox-wide preview token. Daytona documents signed preview URLs as
port-bound, expiring, and revocable, unlike its sandbox-wide preview token.
[Daytona preview](https://www.daytona.io/docs/en/preview/).

### Use the cheapest suitable preview path

Ordinary frontend previews use an authenticated web proxy. Clicking and typing in that preview does not require a streamed desktop. The direct preview has the viewer's browser state; the remote desktop shows the agent's actual browser state. Make that distinction visible.

Daytona VNC and Computer Use are the preferred sandbox desktop path. Daytona
VNC provides the human view; Computer Use provides mouse, keyboard, screenshot,
recording, display, and accessibility operations to the agent. Start the
desktop stack only when a viewer or task needs it. Hidden threads disconnect or
suspend viewers, and closing the viewer does not stop the agent.
[Daytona Computer Use](https://www.daytona.io/docs/en/computer-use/),
[VNC access](https://www.daytona.io/docs/en/vnc-access/).

A minimal Daytona image or snapshot preinstalls the selected runtime/provider.
Environment Builds install repository dependencies once and create a tested
snapshot. Daytona preserves a sandbox filesystem across stop/start and archive,
while process state depends on the selected pause or snapshot capability.
[Daytona persistence](https://www.daytona.io/docs/en/persistence/). Warm
sandboxes are added only after cold start and restore timings are measured.

### Physical Android development has two independent connections

| Path            | Purpose                                                                                   | Trust boundary                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Daytona sandbox | Repository, Codex or Claude, backend services, Android tooling, and Metro                 | Controller creates and scopes the sandbox through the Daytona API.                                 |
| Expo tunnel     | JavaScript bundle, assets, development-client deep link, and Fast Refresh                 | The installed development build connects outbound to the tunnel URL.                               |
| Device broker   | Screenshot, UI inspection, tap, type, swipe, launch, log, and approved install operations | The enrolled phone connects outbound to T3 and accepts only consented, capability-scoped commands. |

Expo CLI automatically targets a development build when `expo-dev-client` is
installed, and `--dev-client` can force that target. `--tunnel` publishes Metro
through Expo's ngrok-backed tunnel. Expo warns that tunnel connections can be
slower and can fail intermittently, so the UI must show tunnel health and offer
a restart instead of leaving an indefinite spinner.
[Expo CLI](https://docs.expo.dev/more/expo-cli/),
[development-build workflows](https://docs.expo.dev/develop/development-builds/development-workflows/).

Android wireless debugging is a possible local privilege bridge, but Android
requires explicit device pairing and lets the owner forget a paired workstation
or revoke all debugging authorizations. Never expose its ADB endpoint to the
Internet. Prefer a phone-side broker that keeps the pairing credential on the
device and exports a narrow command API over an authenticated outbound channel.
[Android hardware-device debugging](https://developer.android.com/studio/run/device).

## Existing work to reuse

The reference repo is [Company/cloud-agents](C:/Users/Victor/Desktop/Crypto-Programming/Company/cloud-agents/README.md). Its source provides an older OpenTofu EC2 launch template, local PowerShell orchestration, temporary Git credentials, and controlled publication. Reuse its publication and cleanup lessons, not its compute provider. State files, saved plans, and secret values were not inspected.

| Prototype detail                                                     | Treatment                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| us-west-1, Amazon Linux 2023 x86_64, t3.medium, encrypted 30 GiB gp3 | Historical worker sizing only. Daytona resource classes and regions replace it.                     |
| Dedicated VPC and public subnet; no worker ingress; outbound TCP 443 | Preserve the outbound-only principle in the Daytona and phone-broker connections.                   |
| Existing secret cloud-agent-victor-key                               | Support as a configurable SSH secret reference. Never commit its value or read it during planning.  |
| Temporary secrets under /cloud-agents-mvp/jobs/                      | Scope access to a run; the current shared prefix permissions are insufficient for parallel workers. |
| Root-owned SSH agent and controlled Git push                         | Reuse the boundary; repository code must not obtain Git publication credentials.                    |
| Local gh login for PR creation                                       | Replace with explicit server-owned GitHub API authentication so the laptop can be offline.          |
| Local finally cleanup and 120-minute worker TTL                      | Replace it with Daytona auto-stop/archive/delete policy plus controller reconciliation.             |
| Local OpenTofu state                                                 | Historical only. Daytona sandbox IDs and lifecycle receipts belong in T3's durable catalog.         |

T3 already has [event-sourced orchestration and checkpoints](C:/Users/Victor/Desktop/Crypto-Programming/Vite/cloud-agents/docs/internals/overview.md), [remote environments](C:/Users/Victor/Desktop/Crypto-Programming/Vite/cloud-agents/docs/internals/remote.md), and [provider adapters](C:/Users/Victor/Desktop/Crypto-Programming/Vite/cloud-agents/docs/internals/providers.md). Cloud placement must respect environment-local project/thread ownership; it is not just another checkout/worktree mode.

[T3 Connect](C:/Users/Victor/Desktop/Crypto-Programming/Vite/cloud-agents/docs/internals/t3-connect.md) is useful reference material but its production identity, tunnels, and native push services are not prerequisites for this personal release. Its relay does not proxy ordinary application traffic.

The repo also has an [iOS simulator streaming workflow](C:/Users/Victor/Desktop/Crypto-Programming/Vite/cloud-agents/.agents/skills/ios-simulator-browser/SKILL.md). Treat it as a starting point to evaluate on a Mac worker, not a production remote-access implementation. Its local stream includes a privileged shell route, so CA-39 must not expose the whole local service through a generic tunnel.

## Delivery order and scope boundaries

Existing ticket IDs and completed statuses are preserved. Open tickets are
rewritten around the parity model. CA-40 onward adds the missing Cursor
surfaces. Order below is intentional; ticket numbering does not indicate
priority.

| Delivery                           | Tickets                                                                                                                                                    | Required result                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture proof                 | CA-01                                                                                                                                                      | Select one provider and prove T3 reuse, ownership, offline execution, and the basic worker route.                                     |
| Local-hosted web/desktop release   | CA-02, CA-03, CA-04A, CA-04C, CA-06, CA-07, CA-08, CA-09, CA-10, CA-11, CA-14, CA-15, CA-16, CA-17, CA-18, CA-19, CA-23, CA-24, CA-25, CA-27, CA-34, CA-35 | Run the complete single-worker workflow from the local Docker controller. The controller machine must remain online.                  |
| Agent/runtime foundation           | CA-40, CA-41, CA-42, CA-59, CA-43, CA-44, CA-45, CA-46                                                                                                     | Split agents/runs from runtimes, create environments with Cursor's setup skills, then pack and hibernate guests.                      |
| Daytona execution migration        | CA-60, CA-61, CA-62, CA-63, CA-64, CA-65                                                                                                                   | Replace AWS/Firecracker admission with managed Daytona sandboxes and prove lifecycle, auth, recovery, and cost controls.              |
| Permanent controller deployment    | CA-04B                                                                                                                                                     | Move the controller and new catalogs to an always-on host with safe single-writer cutover.                                            |
| Review and operations improvements | CA-05, CA-12, CA-13, CA-21, CA-33, CA-36                                                                                                                   | Administer environments, Builds, retained agents, review, and preview restore.                                                        |
| Product/API parity                 | CA-47, CA-48, CA-49, CA-50, CA-51, CA-52, CA-53, CA-54, CA-55, CA-56, CA-57, CA-58                                                                         | Match Cursor's API, integrations, collaboration, security, automation, diagnostics, and self-hosted runtime choices.                  |
| Physical Android development       | CA-20, CA-66, CA-67                                                                                                                                        | Run Metro in Daytona, connect the installed Expo development build, and let an explicitly enrolled phone accept scoped agent control. |
| Daytona release gate               | CA-68                                                                                                                                                      | Prove backend work and physical-device Android work from local and hosted controller modes.                                           |
| Historical simulator work          | ~~CA-37~~, ~~CA-38~~, ~~CA-39~~                                                                                                                            | Preserve prior emulator/simulator work without making KVM or EC2 Mac part of the Daytona release.                                     |
| Existing product expansion         | CA-26, CA-28, CA-29, CA-30, CA-32                                                                                                                          | Align handoff, triggers, durable assistants, and private dependencies with the new agent model.                                       |
| Deferred work                      | ~~CA-31~~, CA-22                                                                                                                                           | Add native push integration only when it is needed.                                                                                   |

### Dependency-safe implementation waves

The delivery table above groups product outcomes. The table below preserves
the original implementation waves. Daytona completion takes priority now;
use the sequence following this table before returning to CA-33 or deferred
push work. Tickets in the same row may run in parallel
because their primary ownership areas do not overlap. Later waves may be
logically ready sooner, but they stay separate to avoid competing changes to
the agent model, public contracts, server composition, preview state, or the
same client screens. Struck-through tickets are already done. Waves 20 and 21
hold the deferred tickets; nothing in waves 1 to 19 depends on them, so they
stay last until you choose to pick them up.

| Wave | Tickets that may run in parallel           | Primary ownership boundary                                                                 |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1    | ~~CA-40~~                                  | Durable agent, run, and runtime model.                                                     |
| 2    | ~~CA-41~~                                  | Environment model and config resolution.                                                   |
| 3    | ~~CA-04B~~, ~~CA-48~~                      | Controller deployment and host cutover; artifact, computer-use, and desktop-viewing paths. |
| 4    | ~~CA-42~~                                  | Build records, preparation, and activation.                                                |
| 5    | ~~CA-43~~                                  | Runtime snapshot, hibernate, and wake lifecycle.                                           |
| 6    | ~~CA-38~~, ~~CA-46~~                       | macOS worker infrastructure; retention and deletion services.                              |
| 7    | ~~CA-44~~                                  | Linux fleet and Firecracker runtime infrastructure.                                        |
| 8    | ~~CA-21~~, ~~CA-45~~                       | Retained-results review UI; fleet capacity and Build pre-warming.                          |
| 9    | ~~CA-05~~, ~~CA-37~~, ~~CA-47~~            | AWS settings UI; Android worker profile; public Cloud Agents API.                          |
| 10   | ~~CA-49~~                                  | Shared secret, identity, encryption, and network policy.                                   |
| 11   | ~~CA-12~~, ~~CA-13~~, ~~CA-26~~            | Environment recipes; event-stream performance; local/cloud handoff.                        |
| 12   | ~~CA-36~~, ~~CA-51~~, ~~CA-55~~            | Preview leases; provider extensibility; usage and audit accounting.                        |
| 13   | ~~CA-32~~, ~~CA-50~~                       | Private dependency networking; source-control and collaboration entry points.              |
| 14   | ~~CA-56~~, ~~CA-58~~                       | Multi-repository environments; self-hosted pools.                                          |
| 15   | ~~CA-28~~, ~~CA-39~~, ~~CA-57~~, ~~CA-59~~ | Scheduling; simulator display; commit signing; repository-owned environment setup.         |
| 16   | ~~CA-29~~, ~~CA-30~~, CA-33                | GitHub triggers; persistent assistants; remote administration UI.                          |
| 17   | ~~CA-52~~                                  | Subscription wake and CI autofix.                                                          |
| 18   | ~~CA-53~~                                  | Generalized automations.                                                                   |
| 19   | ~~CA-54~~                                  | Outbound webhooks and typed SDKs.                                                          |
| 20   | ~~CA-31~~                                  | Historical provider-adapter qualification.                                                 |
| 21   | CA-22                                      | Deferred: native push and mobile activity integration.                                     |

Current Daytona completion order:

| Step | Tickets      | Required result                                                                               |
| ---- | ------------ | --------------------------------------------------------------------------------------------- |
| D1   | CA-60        | Replace AWS/Firecracker selection with an explicit Daytona provider boundary.                 |
| D2   | CA-61        | Prove Daytona create, execute, preview, stop, archive, resume, and delete behavior.           |
| D3   | CA-62        | Create repeatable Daytona images/snapshots and connect environment Builds.                    |
| D4   | CA-63        | Run T3 workers inside Daytona with progress, previews, and reliable cancellation.             |
| D5   | CA-64        | Provide Codex/Claude auth and repository-scoped GitHub SSH without snapshotting private keys. |
| D6   | CA-65        | Reconcile failures, idle lifecycle, retention, and measured Daytona cost.                     |
| D7   | CA-66, CA-20 | Connect an Expo development build to Daytona Metro and add Android device-host enrollment.    |
| D8   | CA-67        | Give the agent secure, consented control of the enrolled physical Android phone.              |
| D9   | CA-68        | Verify the complete backend and physical-device Android workflows from both controller modes. |

Within a parallel wave, each ticket owns only the area named in the third
column. Before the wave starts, assign any shared schema, migration,
route-registration, dependency-lock, or server-composition change to one
ticket. Land that common change first and rebase the other tickets before
their parallel work starts. If that cannot be done cleanly, split the wave.
Do not combine adjacent waves merely because the tickets are otherwise
unblocked.

The dependency direction is deliberate. CA-46 and CA-48 provide services that
CA-21 presents in the review UI. CA-47 provides the API that CA-13 tunes.
CA-28 provides the base scheduler that CA-53 generalizes. CA-29 provides the
GitHub trigger behavior that CA-52 uses for subscription wake and CI autofix.
These directions avoid the previous circular dependencies.

Physical Android development is committed scope. It does not require KVM or a
cloud emulator. iOS Simulator work and the earlier remote emulator path remain
separate, optional capabilities. Do not claim that CA-66 provides device control
or that CA-67 provides Metro connectivity. Each path has its own status.

Completed tickets are not reopened merely because their original acceptance
criteria described the old one-EC2-per-thread limit. New parity tickets
supersede those limits explicitly. Exact parity means matching documented
observable behavior, not reproducing Cursor's proprietary implementation or
model quality.

## First usable local-host release

### CA-01: Prove the smallest T3 extension and one remote provider

Dependencies: none.

Status: Done on 17 September 2026. The AWS proof covered both Codex and Claude;
see [Cloud agent execution ownership](../internals/cloud-agent-execution.md).

Description: Select the simplest execution ownership model using T3's existing remote environments and provider adapters. Prove one provider works unattended in AWS before building the feature around it.

Acceptance criteria:

- A bounded proof starts one provider on a worker through T3 and retrieves its output after the initiating client disconnects.
- Record the authoritative location of thread events, workspace, provider session, and allocation state. There is one writer per thread and no second live decider/projector on the controller.
- Compare reusing an ordinary worker T3 environment with a smaller execution bridge. Choose based on actual required changes, reconnect behavior, and operational complexity, without building both.
- Verify the selected provider's Linux support, remote authentication, expiry/refresh behavior, interruption, and supported resume behavior. Other providers remain unsupported for cloud execution until CA-31.
- Prove an authenticated worker connection from the active controller host without a local PowerShell orchestration loop or per-turn SSM commands. Document any API-key cost instead of assuming subscription credentials can be copied.
- Keep native T3 mobile changes outside this proof. Allow later worker profiles to declare OS/architecture/device capabilities without implementing a general scheduler.

### CA-02: Add allocation contracts around existing T3 state

Dependencies: CA-01.

Status: Done on 17 September 2026 in
[PR #2](https://github.com/Atheal9k/cloud-agents/pull/2).

Description: Add only the infrastructure lifecycle and references missing from T3. Existing thread events continue to represent conversation and provider execution.

Acceptance criteria:

- A run allocation records its ID, attempt, repository/base commit, branch, worker/environment/thread references, profile, deadlines, and result location.
- Allocation, agent outcome, preview availability, and cleanup are distinct states. Do not mirror the full thread history into allocation events.
- Launch/control requests are idempotent, and stale worker attempts cannot change current state.
- Existing checkout/worktree behavior and persisted events remain decodable. Capabilities hide unsupported actions on older environments.
- Focused tests cover duplicate launch, cancellation races, stale attempts, and replay of the added allocation state.

### CA-03: Create the minimal personal AWS stack

Dependencies: CA-01.

Status: Done on 17 September 2026 in
[PR #3](https://github.com/Atheal9k/cloud-agents/pull/3).

Description: Adapt the reference OpenTofu source for one permanent Linux host, disposable web workers, retained data, and an authenticated access route.

Acceptance criteria:

- Infrastructure declares separate host/worker identities, encrypted storage, worker launch template, required networking, artifact storage, and an independent cleanup backstop.
- Region, image, instance shape, disk, CIDRs, and TTL are configurable. Initial defaults reference the prototype only where compatible with the measured workload.
- Use encrypted remote OpenTofu state with locking supported by the pinned version. Secret values are absent from source, outputs, and plan artifacts.
- Normal bootstrap uses the image and service manager. Any SSM recovery document is operational support, not a job execution API.
- Sandbox plan/apply/destroy verifies ownership and retention. Worker teardown cannot remove the permanent host or retained records.
- Leave extension points for profile-specific launch configuration; Mac infrastructure and emulator sizing belong to CA-37/CA-38.

### CA-04A: Use the existing local T3 environment as the controller

Dependencies: CA-02, CA-03.

Status: Done on 17 September 2026 in
[PR #4](https://github.com/Atheal9k/cloud-agents/pull/4).

Description: Run cloud allocation and control from the existing local T3 environment before deploying a permanent host. Reuse the same controller contracts and state layout that CA-04B will run on EC2.

Acceptance criteria:

- The existing local T3 server can own allocation records, AWS operations, retained-result references, and worker registrations without an EC2 controller instance.
- Locally served web and the desktop build use the same cloud commands, subscriptions, and capability checks. Cloud execution is not a separate local-only orchestration path.
- Initial repository, provider, and AWS deployment settings use protected controller-side configuration. Browser clients never receive AWS provisioning credentials.
- Supported provider authentication uses an existing local callback, device-code flow, or explicit protected credential entry. Authentication behavior is recorded so CA-04B can replace local callbacks where needed.
- Closing a browser or desktop client does not stop an accepted job. The local T3 process and machine must stay online for allocation, control, finalization, and normal cleanup; the UI states that limitation plainly.
- Controller restart recovers durable intent and acknowledged results from the local T3 state directory. A consistent backup/restore is demonstrated without copying a live SQLite file unsafely.
- No stable public DNS, permanent TLS endpoint, production T3 Connect service, or EC2 controller is required for this ticket. Worker connectivity through NAT or a protected tunnel belongs to CA-09.

### CA-04C: Package the controller for local and permanent Docker deployment

Dependencies: CA-04A.

Status: Done on 17 September 2026.

Description: Add a production Docker image and Compose configuration for the T3 controller and built web application. Run it locally first, then reuse the same versioned image for the permanent EC2 controller in CA-04B. The existing development container remains contributor tooling.

Acceptance criteria:

- A reproducible Dockerfile builds this fork's server and web assets from a pinned revision with the required runtime dependencies. The image runs as a non-root user and serves the built application without a development server.
- A documented Compose command starts the local controller on Windows with Docker Desktop and on Linux, with health checks, graceful shutdown, and a restart policy. Closing the client leaves it running; the host and Docker engine must remain online.
- An explicit persistent volume holds T3 identity, settings, secrets, and SQLite state with working ownership/permissions. Container recreation and image upgrades preserve acknowledged allocations and results. Backup/restore and migration from an existing local controller use a consistent snapshot and a deliberate single-writer cutover; verification uses disposable state.
- AWS and provider credentials arrive through protected runtime configuration or mounted credential files, never image layers or committed Compose values. Validate the selected provider's authentication flow across the container boundary. Add GitHub authentication through the same mechanism in CA-06.
- Web and desktop clients connect to the container as an ordinary T3 environment. Local pairing, HTTP/WebSocket traffic, and configurable remote access work without baked localhost origins. CA-09 validates worker registration and preview routing against this container, including NAT/tunnel access.
- Document explicit workspace mounts and required CLI dependencies for any supported local provider execution. Cloud task execution stays on workers; the controller needs neither a privileged container nor the host Docker socket.
- Versioned image builds support local loading and registry publication for CA-04B. Document update, consistent backup, restore, and rollback procedures, including schema compatibility limits; verify restart and restore with durable controller state.
- CA-04B reuses this image and state layout with host-specific runtime configuration. Linux worker images, Android emulator hosts, and macOS Simulator hosts remain separate concerns in CA-07/CA-37/CA-38. Kubernetes and additional hosting platforms are outside this ticket.

### CA-06: Supply protected Git and GitHub credentials

Dependencies: CA-03, CA-04A, CA-04C.

Status: Done on 17 September 2026.

Description: Reuse the prototype's controlled clone/push boundary and configure GitHub API access on the active controller for draft PR creation.

Acceptance criteria:

- Support a configurable SSH secret reference including cloud-agent-victor-key, with validated raw OpenSSH or the reference's single-field JSON form and correct multiline handling.
- Clone/push uses the trusted wrapper and verified GitHub host keys over port 443. Task code cannot read the key or its SSH agent socket.
- Bootstrap credentials are scoped to the assigned run. Neither the master secret nor another run's secret is readable by the worker task.
- Controller-owned GitHub API authentication creates a PR after the initiating UI closes. It does not depend on that client's gh login. While CA-04A hosts the controller locally, its machine must remain online; CA-04B removes that limitation.
- Permission denial, expiry, revocation, and rotation produce useful errors without logging values. The account-wide scope of an SSH account key is explicit.

### CA-07: Bake a minimal worker image and isolate execution

Dependencies: CA-01, CA-03, CA-06.

Status: Done on 17 September 2026 in [PR #7](https://github.com/Atheal9k/cloud-agents/pull/7).

Description: Preinstall the selected T3 runtime, provider, and common build tools in a versioned image. Avoid downloading the entire toolchain for every run.

Acceptance criteria:

- The image records compatible pinned versions and starts its worker service automatically. Authentication and run-specific values arrive separately from the image.
- Bootstrap performs health checks and reports a concrete failure before starting the agent if a required component is unavailable.
- Repository code runs without root, controller credentials, publication credentials, or access to instance metadata credentials. Verify the actual boundary rather than relying on IMDSv2 alone.
- Process cleanup targets owned services/process groups. Temporary credentials are removed on failure and normal exit.
- The base image has no unused mobile SDK or continuously running desktop stream. Desktop dependencies are enabled in the profile needed by CA-34; emulator/simulator images are separate.
- Image rollback is possible for new runs without changing an active run's toolchain.

### CA-08: Allocate one worker with durable intent

Dependencies: CA-02, CA-03, CA-04A, CA-07.

Status: Done on 17 September 2026 in [PR #8](https://github.com/Atheal9k/cloud-agents/pull/8).

Description: Replace the prototype's local PowerShell orchestration loop with a small durable allocation queue owned by the active T3 controller. For the first release, the queue runs in the local controller from CA-04A/CA-04C. CA-04B later moves the same queue and state to the permanent EC2 controller. First-release concurrency is one worker.

Acceptance criteria:

- Accepted jobs and allocation intent survive a local controller process or container restart. Reconciliation resumes when the controller returns, with a bounded queue and one active allocation lease.
- The browser and desktop client may disconnect after admission, but the local controller host and Docker engine must remain online to launch, reconcile, and finalize work. CA-08 does not require an EC2 controller.
- AWS client tokens and tags identify run attempts; a lost launch response cannot produce duplicate instances on retry.
- Boot/service-registration deadlines are distinct from agent runtime deadlines and have actionable failure states.
- Cancelling before launch creates nothing; cancelling during launch still discovers and cleans up a late-created instance.
- AWS quota/capacity errors use bounded retries. Multi-controller coordination and parallel fleet scheduling are deferred.

### CA-09: Route normal T3 traffic to the worker

Dependencies: CA-02, CA-04A, CA-07, CA-08.

Status: Done on 17 September 2026 in [PR #9](https://github.com/Atheal9k/cloud-agents/pull/9).

Description: Extend existing environment discovery/connection paths with an authenticated outbound worker route. Keep normal execution in T3's typed RPC and provider runtime.

Acceptance criteria:

- Workers register with short-lived attempt-bound credentials over an approved route. No public worker ingress is needed. Local hosting may use one explicitly configured authenticated ingress or controller-managed tunnel, but it must not require manual forwarding for each worker.
- Existing T3 subscriptions carry conversation/tool events, approvals, terminals, and control; no SSM command-output polling participates in the interaction.
- Reconnect preserves environment identity and uses existing T3 snapshot/subscription behavior. The controller does not become a second writable thread event store.
- Revoked and obsolete workers cannot reconnect as the current attempt. Routing never interprets a controller, worker, or browser localhost endpoint as belonging to a different machine.
- A healthy session continues if SSM is unavailable. Do not change the T3 Connect relay into an application proxy or require access to its production services.

### CA-10: Prepare one repository and a trusted setup recipe

Dependencies: CA-06, CA-07, CA-08.

Status: Done on 17 September 2026 in
[PR #10](https://github.com/Atheal9k/cloud-agents/pull/10).

Description: Make the first configured repository reproducible without building a repository-management product. Start with explicit setup, app-start, and verification commands.

Acceptance criteria:

- Resolve the selected ref to a commit and create an isolated checkout and unique output branch, recording both on the run.
- A small validated configuration describes mandatory setup, dev-server ports/commands, verification commands, and permitted secret references. Mandatory setup finishes before the agent starts.
- Repository instructions are available. Local credentials, ignored files, and uncommitted work are not silently uploaded.
- Setup and validation retain exit codes/logs and have deadlines. Missing dependencies fail during preparation with an actionable message.
- Task-controlled Git remotes/config cannot change the trusted publication target. Advanced recipe editing, multi-repository discovery, and private submodules are deferred.

### CA-11: Execute the selected provider through T3

Dependencies: CA-01, CA-07, CA-09, CA-10.

Status: Done on 17 September 2026 in
[PR #11](https://github.com/Atheal9k/cloud-agents/pull/11).

Description: Run real multi-turn work through the existing provider adapter, rather than an arbitrary shell command masquerading as an agent session.

Acceptance criteria:

- Prompt, selected model, permissions, and supported attachments start the selected provider using its ordinary T3 session operations.
- Existing normalized messages, tools, questions, approvals, and usage information render without introducing another provider event format.
- Closing all clients does not suspend the run or its completion work.
- Authentication, model availability, and quota failures are distinct. Other providers cannot be selected for cloud execution until qualified.
- Interrupt and follow-up work on the live worker. Native resume is used only when supported; filesystem recovery must not be described as native conversation resume.

### CA-14: Retain results and support explicit recovery

Dependencies: CA-02, CA-04A, CA-10, CA-11.

Status: Done on 17 September 2026 in
[PR #12](https://github.com/Atheal9k/cloud-agents/pull/12).

Description: Save enough authoritative environment/workspace state to recover interrupted work and review the result after compute ends. Avoid continuous replication of the full domain model.

Acceptance criteria:

- Save the transcript or consistent environment archive, base revision, diff, verification output, and artifact manifest independently of the disposable instance.
- Use the chosen T3 state owner's consistent backup/checkpoint mechanism. A restored environment has a single writer; the previous worker is fenced before reuse of its identity.
- The first release can explicitly restore a saved checkpoint and start a linked continuation. It need not resume arbitrary in-flight processes or unsupported provider sessions.
- Preserve eligible uncommitted/untracked work. Exclude credentials and unrelated profiles; document retention, size limits, and the possible loss window.
- Normal finalization waits for durable acknowledgement. An upload failure becomes visible and retryable but cannot bypass the hard compute limit forever.
- A basic authenticated run result page exposes saved diff/log/artifact downloads. Rich archived-history integration belongs to CA-21.

### CA-15: Provide input, interruption, cancellation, and retry

Dependencies: CA-02, CA-09, CA-11, CA-14.

Status: Done on 17 September 2026 in [PR #13](https://github.com/Atheal9k/cloud-agents/pull/13).

Description: Reuse ordinary T3 controls on the cloud session, with explicit lifecycle behavior when the worker has gone away.

Acceptance criteria:

- A second web/desktop client can send follow-up input, answer questions, and approve or deny supported requests.
- Permission policy is selected before launch. A disconnected owner does not imply approval; unanswered requests have a bounded wait.
- Idempotent cancel stops owned processes, saves available results, and schedules cleanup.
- Retry names a new attempt and its starting point. Uncertain publication is reconciled rather than blindly replayed.
- Terminated sessions offer saved results and explicit continuation. Transparent live-process handoff and sophisticated pause/hibernate behavior are deferred.

### CA-16: Publish a branch and draft PR

Dependencies: CA-06, CA-10, CA-11, CA-14, CA-15.

Status: Done on 17 September 2026 in [PR #14](https://github.com/Atheal9k/cloud-agents/pull/14).

Description: Complete the first launch-to-PR workflow with a trusted publication step owned by the controller rather than the initiating client.

Acceptance criteria:

- Launch selects review-only or automatic branch plus draft PR publication. No automatic merge is included.
- Validate repository, base, and branch against recorded intent. Privileged Git operations do not run task-controlled hooks or credential configuration.
- Persist test outcomes and distinguish empty change, failed verification, rejected push, and failed PR creation.
- Finalization retries inspect the existing branch and PR first. Remote divergence does not trigger an implicit force push.
- Link the PR and saved diff to the run. Publication succeeds after the initiating UI disconnects as long as the active controller stays online; a publication failure does not erase the work.

### CA-17: Clean up workers independently of clients

Dependencies: CA-03, CA-04A, CA-08, CA-14, CA-15.

Status: Done on 17 September 2026 in [PR #15](https://github.com/Atheal9k/cloud-agents/pull/15).

Description: Bound infrastructure lifetime even if bootstrap, the controller, or a client fails.

Acceptance criteria:

- A small reconciler matches tagged resources to attempts and handles abandoned, expired, cancelled, and partially provisioned workers.
- An AWS-side backstop catches a worker whose guest timer never started. Cleanup is idempotent and cannot delete a newer attempt's resources.
- Remove temporary credentials, disposable storage, and preview routes according to their retention policies. Keep cleanup status separate from agent success.
- The active controller host and retained archives are explicitly excluded from worker expiry.
- The first release uses a bounded review grace period before web-worker termination. Rich preview leases/reopen are CA-36; Mac Dedicated Host lifecycle is CA-38.
- Failed deletion stays visible and retryable; requesting termination is not reported as completed cleanup.

### CA-18: Enforce simple limits and expose usage

Dependencies: CA-02, CA-08, CA-17.

Status: Done on 17 September 2026 in
[PR #16](https://github.com/Atheal9k/cloud-agents/pull/16).

Description: Keep the personal release bounded without building a billing dashboard.

Acceptance criteria:

- Configure one-worker concurrency, queue length, run/input-wait duration, preview grace period, and allowed instance sizes. Admission rejects invalid requests before allocating compute.
- Show elapsed worker time, shape, deadlines, and a cost estimate with stated assumptions. Unknown provider usage remains unknown.
- Distinguish controller-host costs, worker time, storage, model use, and streaming transfer. A local controller has no attributed EC2 host charge. Billing alerts are not represented as an exact live spending cap.
- Correlate run, attempt, worker, provider, and cleanup diagnostics without routinely logging credentials or complete prompts.
- A stop-admission control leaves running jobs, saved results, and cleanup manageable. Expanded budgets and fleet charts are deferred.

### CA-19: Add cloud launch and control to web and desktop

Dependencies: CA-02, CA-04A, CA-10, CA-15, CA-18.

Status: Done on 17 September 2026 in [PR #17](https://github.com/Atheal9k/cloud-agents/pull/17).

Description: Expose the one-repository/provider workflow through T3's existing web UI and the owner's desktop build.

Acceptance criteria:

- The user sees the cloud destination and selects task, ref, supported model, limits, and publication policy before launching.
- New-thread UI and relevant command-palette/keybinding actions use the same validation and request identity.
- Provisioning, setup, running, waiting, finalizing, failure, and cleanup states are accurate; a double-submit does not allocate twice.
- Locally served web and the desktop build work against CA-04A without baked origins. The same client configuration can target CA-04B later without a separate cloud-only UI.
- The thread exposes terminal/logs, ordinary app preview, and shared browser view through CA-25/CA-34. Native T3 iOS/Android UI is not part of this ticket.
- Responsive browser access remains possible from phones/tablets; private desktop installation is sufficient, with no app-store publication prerequisite.

### CA-25: Embed ordinary app previews in each frontend thread

Dependencies: CA-09, CA-10, CA-11, CA-19.

Status: Done on 17 September 2026 in [PR #18](https://github.com/Atheal9k/cloud-agents/pull/18).

Description: Use an authenticated web route for ordinary frontend inspection. Viewing and interacting with the app does not start DCV automatically.

Acceptance criteria:

- A frontend thread embeds its running app with real navigation, clicking, typing, scrolling, resizing, reload, and optional open-in-tab.
- Start/restart the configured app, show readiness and build errors, and link to the owned process logs. Bind ports and routes to the exact thread/attempt.
- Proxy HTTP and required WebSockets including HMR through HTTPS without mixed content or client localhost assumptions.
- Preview origins isolate untrusted app content from T3 credentials. Route only approved worker ports, not arbitrary URLs or metadata services.
- The direct preview clearly differs from the agent's actual browser session; use CA-34 for shared browser state and takeover.
- Existing screenshots and validation artifacts can be saved. A screenshot alone does not satisfy interactive preview.

### CA-27: Add basic dependency caching before release

Dependencies: CA-07, CA-10.

Status: Done on 17 September 2026 in [PR #19](https://github.com/Atheal9k/cloud-agents/pull/19).

Description: Measure startup and avoid repeating expensive tool/dependency preparation. This ticket moves out of optional expansion into the first release.

Acceptance criteria:

- Record image boot, service startup, clone, setup, and provider-start timings on a representative cold and cached run.
- Use the versioned runtime image from CA-07 plus a bounded package/dependency cache keyed by repository, lockfiles, OS/architecture, and relevant setup inputs.
- Prefer package-manager caches before sharing writable installed dependency trees. Run workspaces remain separate.
- Credentials, browser state, writable task output, and another run's private data never enter reusable images or caches.
- Invalid entries fall back to clean setup. Cache eviction is bounded, and a toolchain/lockfile change is proven to invalidate the affected entry.
- No warm Linux pool or elaborate machine-snapshot service is required. Add those only if measured startup remains unacceptable.

### CA-34: Add on-demand shared-browser viewing

Dependencies: CA-07, CA-09, CA-18, CA-25.

Status: Done on 18 September 2026 in [PR #20](https://github.com/Atheal9k/cloud-agents/pull/20).

Description: Validate Amazon DCV and embed a view of the agent's actual worker browser/desktop. Reuse a tested simpler transport if DCV cannot satisfy the selected platform.

Acceptance criteria:

- Prove browser automation and the streamed view target the same browser/session. Each thread is isolated.
- Validate image/OS support, certificates, authentication, WebSocket routing, and reconnect through the approved HTTPS route to the active controller without public worker ingress. The first release uses the local-controller ingress or tunnel from CA-09; it does not require CA-04B.
- The viewer embeds in web and desktop. Verify the selected browser matrix and document phone-browser limitations; native T3 mobile WebViews are deferred.
- Stream only for visible viewers or an explicitly required agent workflow. Hidden/disconnected viewers stop decoding/receiving frames, while an active agent browser is allowed to keep running.
- Session access is short-lived and attempt-bound. Replacing a worker invalidates old viewer access.
- Measure CPU, memory, latency, and transfer during build-plus-streaming load before sizing. Validate SDK distribution terms.
- DCV is not required for the direct app preview. A full desktop is not started just because a thread exists.

### CA-35: Enforce human/agent input handoff

Dependencies: CA-15, CA-34.

Status: Done on 18 September 2026 in [PR #21](https://github.com/Atheal9k/cloud-agents/pull/21).

Description: Allow the owner to take control of the shared browser, inspect or log into the app, and return control without competing inputs.

Acceptance criteria:

- Observe, take control, and return control show the current owner. Read-only viewers cannot send input.
- Human takeover waits for conflicting agent browser/computer actions to pause or terminate. Interrupt the turn first when the provider cannot pause those actions separately.
- Server-side input leases allow one owner; simultaneous requests, stale devices, and disconnects cannot produce two controllers or a permanent lock.
- Keyboard, pointer, scrolling, and explicitly permitted clipboard actions work. Phone-browser touch support is verified where offered; native T3 mobile support is deferred.
- Return preserves browser state and tells the agent that a human changed it. Loss of a viewer does not silently authorize resuming a paused consequential action.
- Cancel remains available during takeover. Delayed input cannot reach another thread or a replacement worker.

### CA-23: Prove the small web/desktop release end to end

Dependencies: CA-16, CA-17, CA-18, CA-19, CA-25, CA-27, CA-34, CA-35.

Status: Done on 18 September 2026 in [PR #22](https://github.com/Atheal9k/cloud-agents/pull/22).

Description: Validate the complete first workflow without turning every later capability into a release blocker.

Acceptance criteria:

- With the initiating web/desktop client closed and the local controller still online, one task changes the configured private repository, runs its checks, and produces a linked draft PR and retained results.
- Web and the owner's desktop build show the app preview, observe the actual agent browser, take control, return control, and cancel a run.
- Local controller restart, worker failure, lost launch response, expired auth, failed archive upload, and failed/retried publication have recorded recovery outcomes without unexplained AWS resources.
- Verify bounded idle/compute cleanup and that an ordinary preview or hidden thread does not maintain unnecessary desktop streaming.
- Compare measured cold/cached startup, and verify existing T3 reconnect/state authority rather than a duplicate event replication system.
- Scope backend tests to changed behavior and use receipts/drains rather than sleeps. Native T3 mobile testing, push delivery, all-provider qualification, and simulator workloads are separate tickets.

### CA-24: Document and enable the first personal release

Dependencies: CA-23.

Status: Done on 18 September 2026 in [PR #23](https://github.com/Atheal9k/cloud-agents/pull/23).

Description: Provide the minimum instructions needed to install, use, recover, and disable the proven workflow.

Acceptance criteria:

- Document local-controller startup, its stay-online requirement, protected initial configuration, selected provider authentication, GitHub access, desktop setup, and the first run.
- Explain direct app preview versus shared-browser control, review timeout, saved results, cancellation, retry, and explicit recovery.
- Include backup/restore, image rollback, credential rotation, stuck-worker cleanup, and teardown with retained-data behavior.
- The release is opt-in and capability-gated. Disabling admission leaves active jobs and results manageable.
- State the supported provider/repository configuration and web/desktop scope; no claim of native T3 mobile or simulator support until the corresponding tickets pass.

## Permanent controller deployment

### CA-04B: Move the proven controller to a permanent T3 host

Dependencies: CA-03, CA-04A, CA-04C, CA-23, CA-24, CA-40, CA-41.

Status: Done on 19 September 2026 in
[PR #30](https://github.com/Atheal9k/cloud-agents/pull/30).

Description: Move the proven controller, durable agent/run catalog, and
environment/Build catalog to one always-on host using CA-04C's image. Keep
local and permanent controller modes on one code path; runtimes remain in the
separate execution plane.

Acceptance criteria:

- Stable DNS, TLS renewal, service auto-start, durable identity, agent/run
  records, environment versions, Build records, and artifact references survive
  reboot.
- Cutover stops admission, drains active runs, snapshots idle agents, backs up
  SQLite consistently, fences the old controller, then starts exactly one
  writable controller. In-flight processes do not migrate.
- `CloudAllocationControllerMode` represents local and permanent modes;
  `requiresHostOnline` is accurate in clients and APIs.
- Provider and source-control authentication use remote-safe device, callback,
  or protected credential flows; server loopback is never shown as viewer
  loopback.
- Web/API access works with the original computer off. Local-controller mode
  remains supported through the same contracts.
- Backup, restore, rollback, and outage procedures preserve agent IDs and do
  not wake every idle runtime.

## Review and operations improvements

### CA-05: Add a guided AWS readiness/settings screen

Dependencies: CA-03, CA-04B, CA-19, CA-24, CA-41, CA-42, CA-44.

Status: Done on 19 September 2026 in
[PR #40](https://github.com/Atheal9k/cloud-agents/pull/40).

Description: Replace manual deployment configuration with a readiness workflow
for the controller, execution account, environments, Builds, snapshots, and
runtime fleet.

Acceptance criteria:

- Show controller and execution accounts, regions, guest/hypervisor versions,
  slot capacity, active Build, snapshot policy, and health without credentials.
- Validate IAM, KVM/Firecracker support, image and snapshot access, artifact
  storage, guest registration, and optional SSM diagnostics independently.
- Guided setup can create, test, and activate an environment version without
  replacing the last successful Build on failure. First-time repository
  environment create uses CA-59, not a separate settings-only form.
- Settings expose config source/precedence, secrets, egress, stale-build
  threshold, and default model/repository/ref.
- Stop-admission leaves active runs, idle snapshots, cleanup, and review
  available. Browsers never receive AWS provisioning credentials.

### CA-12: Add reusable repository recipes and secret management

Dependencies: CA-10, CA-19, CA-24, CA-41, CA-42, CA-49.

Status: Done on 19 September 2026 in [PR #43](https://github.com/Atheal9k/cloud-agents/pull/43).

Description: Replace per-run recipes with versioned environments. Map setup to
Build-time `install`, per-runtime services to `start` and named terminals, and
secrets to explicit Build/runtime classes. First-time create follows CA-59.

Acceptance criteria:

- Resolve config in order: repository `.cursor/environment.json` or documented
  T3 equivalent, personal environment, then team/default environment.
- Each run records immutable environment version and Build IDs. Editing config
  never mutates an active runtime.
- `install` is terminating and idempotent; `start` and named terminals run on
  each boot and have visible health/logs.
- Environment-variable, runtime-redacted, and Build-only secret classes have
  distinct injection and redaction. User secrets never enter a shared Build.
- Multi-repo environments validate ports, private dependencies, and per-repo
  refs before Build admission.

### CA-13: Improve large-history reconnect and streaming performance

Dependencies: CA-09, CA-11, CA-19, CA-24, CA-40, CA-47.

Status: Done on 19 September 2026 in [PR #42](https://github.com/Atheal9k/cloud-agents/pull/42).

Description: Preserve T3's authoritative live subscription while adding the
bounded agent/run event stream required by clients and API consumers.

Acceptance criteria:

- Worker reconnect uses T3 cursors while active; hibernated agents read the
  durable transcript and result summary without waking a guest.
- API SSE supports event IDs, `Last-Event-ID`, heartbeats, bounded retention,
  and explicit `410 stream_expired`.
- Lists return bounded summaries; histories, tool output, setup logs, and
  artifacts load on demand with backpressure.
- Resume produces no duplicate messages across worker route, controller
  transcript, and run stream.
- Load tests measure bytes, latency, buffers, and restore cost. No second live
  decider/projector is introduced.

### CA-21: Integrate retained results into the full review UI

Status: Done on 19 September 2026 in [PR #35](https://github.com/Atheal9k/cloud-agents/pull/35).

Dependencies: CA-14, CA-16, CA-19, CA-24, CA-40, CA-43, CA-46, CA-48.

Description: Make the durable agent page useful while its runtime is absent.
Conversation, runs, changes, Build provenance, artifacts, and PRs remain
reviewable without waking compute.

Acceptance criteria:

- Web, desktop, and authorized shared links inspect transcript, run history,
  changes, verification, artifacts, usage, environment/Build, and PR offline.
- `ACTIVE`, `IDLE`, and `ARCHIVED` are distinct from run terminal status and
  from preview/terminal availability.
- Binary/oversized diffs, expired snapshots, missing artifacts, and failed
  Builds are explicit. Review does not wake a runtime.
- Artifact downloads use short-lived authorized URLs; untrusted HTML cannot
  execute with application privileges.
- Archive, unarchive, permanent delete, cancel, wake, and PR deletion are
  separate and access-checked.

### CA-33: Expand remote administration beyond the first workflow

Status: Done on 20 September 2026 in [PR #65](https://github.com/Atheal9k/cloud-agents/pull/65).

Dependencies: CA-05, CA-12, CA-18, CA-19, CA-24, CA-40, CA-41, CA-42, CA-44,
CA-49, CA-55, CA-59.

Description: Administer repositories, environments, Builds, models, secrets,
network policy, agents, runtime capacity, integrations, and spend remotely.

Acceptance criteria:

- Manage environment version history; trigger, inspect, activate, and roll back
  Builds; set recurring/manual Build policy. Starting Setup for a repository
  with no effective environment launches CA-59, not a blank JSON editor.
- Configure default model/context, repository/ref, long-running permission,
  team follow-ups, computer use, Git artifacts, and spend limits.
- Show hypervisor slots, warm inventory, runtime placement, snapshots, queue,
  and cleanup without exposing a general shell.
- Provider/SCM reauthentication is remote-safe. Secret values are write-only;
  changes affect new runtimes and trigger Builds only when appropriate.
- Every mutation is authorized and audited; responsive web works remotely.

### CA-36: Add bounded preview retention and reopen

Status: Done on 19 September 2026 in [PR #49](https://github.com/Atheal9k/cloud-agents/pull/49).

Dependencies: CA-14, CA-17, CA-18, CA-21, CA-25, CA-34, CA-35, CA-43, CA-46.

Description: Replace review-grace-as-worker-lifetime with explicit preview
leases on top of idle snapshot/restore. Reopening a preview wakes a runtime but
does not start a provider run.

Acceptance criteria:

- Agent/run, runtime, app preview, desktop viewer, and input lease have separate
  state and deadlines.
- A visible preview receives a bounded lease. Heartbeats alone cannot keep a
  guest alive indefinitely; explicit stop snapshots then releases it.
- Reopen restores the agent snapshot and runs environment `start` without
  creating a provider run. Placement is idempotent and obeys slot admission.
- Browser/login persistence is explicit and secret-safe; a fresh browser is
  reported honestly.
- Human edits create a checkpoint and diff without rewriting a published PR.
- Route and input tokens are attempt-bound and revoked on hibernate/replace.

## Cursor-parity agent and runtime foundation

These tickets replace the one-allocation/one-EC2 steady state. They supersede
the old deferrals of hibernation, warm pools, and parallel placement without
reopening completed proof tickets.

### CA-40: Split durable agents, runs, and ephemeral runtimes

Status: Done on 19 September 2026 in [PR #27](https://github.com/Atheal9k/cloud-agents/pull/27).

Dependencies: CA-02, CA-08, CA-11, CA-14, CA-15.

Description: Introduce Cursor's observable control-plane model while retaining
T3 as the sole live thread writer.

Acceptance criteria:

- A durable agent has a stable ID, conversation, repository/environment
  provenance, branch set, and status `ACTIVE`, `IDLE`, or `ARCHIVED`.
- Each submitted prompt creates a run with status `CREATING`, `RUNNING`, then
  `FINISHED`, `ERROR`, `CANCELLED`, or `EXPIRED`; one run per agent may be
  active and a conflict returns `agent_busy`.
- Runtime, worker, environment, and thread references may be absent while an
  agent is idle. Clients can list and review it without compute.
- Follow-up creates a run on the same agent; retry is reserved for failed
  placement/publication rather than ordinary conversation continuity.
- Existing allocation events remain decodable and migrate to linked runtime
  attempts. Focused replay/race tests cover duplicate create, cancel, archive,
  and stale runtime fencing.

### CA-41: Add versioned environments and config resolution

Status: Done on 19 September 2026 in [PR #28](https://github.com/Atheal9k/cloud-agents/pull/28).

Dependencies: CA-10, CA-40.

Description: Make environment setup a first-class, versioned resource rather
than a mutable recipe attached to each allocation. First-time create is CA-59.

Acceptance criteria:

- Environments support one or multiple repositories, one base strategy
  (Dockerfile, explicit image, or snapshot), `install`, `start`, named
  terminals, ports, secrets, egress, and runtime user.
- Resolution order is repository `.cursor/environment.json` or documented T3
  equivalent, personal saved environment, then team/default environment.
- Every edit creates an immutable version; active agents retain the version
  they started with. Restore creates a new version pointing to prior config.
- The dashboard exposes source, version history, repositories, owner/scope,
  active Build, and effective policy. Do not create a competing dashboard
  environment when a committed `.cursor/environment.json` already exists.
- Schema matches https://cursor.com/schemas/environment.schema.json. Do not
  write a `$schema` property. Choose exactly one of Dockerfile, image, or
  snapshot.

### CA-42: Build and activate prepared environment snapshots

Status: Done on 19 September 2026 in [PR #31](https://github.com/Atheal9k/cloud-agents/pull/31).

Dependencies: CA-07, CA-27, CA-41.

Description: Add Cursor-like Builds so clone and dependency installation leave
the agent hot path.

Acceptance criteria:

- A Build prepares the base, clones default refs, runs terminating/idempotent
  `install`, records commit SHAs and logs, snapshots disk, then atomically
  becomes active.
- Failed or cancelled Builds never replace the last active Build. Draft Builds
  can be tested but never activate implicitly.
- Triggers include manual, recurring, configuration change, and
  agent-requested. Recurring Builds may be skipped when refs/config/secrets are
  unchanged.
- Build records expose status, trigger, environment version, snapshot, timings,
  `gitSetup`, and logs. User-only runtime secrets never enter shared snapshots.
- Stale-build threshold defaults to 24 hours and may be `0` to always refresh.
  A feature-branch run boots the Build then checks out the requested ref.
- Agent-requested Builds from CA-59 are draft until the user Saves. A failed
  draft never replaces the last active Build.

### CA-59: Run the repository-owned agent-led environment setup

Status: Done on 19 September 2026 in [PR #56](https://github.com/Atheal9k/cloud-agents/pull/56).

Dependencies: CA-41, CA-42, CA-49, CA-51.

Description: Ship and invoke the repository-owned Cloud Agent environment
skill package. The package, not a prompt copy or custom setup wizard, is the
source of truth for agent behavior:

- [Environment setup skill](../../.agents/skills/env-setup/SKILL.md)
- [Create or fully set up an environment](../../.agents/skills/env-setup/references/create-environment.md)
- [Update a repository-managed environment](../../.agents/skills/env-setup/references/update-repo-managed-environment.md)
- [Update a DB-managed environment](../../.agents/skills/env-setup/references/update-db-managed-environment.md)
- [Migrate an environment to builds](../../.agents/skills/env-setup/references/migrate-to-builds.md)

Acceptance criteria:

- Cloud Agents discover `env-setup` and resolve all four references relative
  to its skill directory. Packaging and focused tests fail when the skill or a
  referenced workflow is missing.
- When no effective environment exists, or the user asks to make a repository
  fully usable, the agent loads the skill and the create reference before its
  first tool call. It follows the reference's verbatim opener, exact five-item
  checklist, blocker ordering, local validation, snapshot, draft Build,
  fresh-agent verification, proposal, and Save handoff.
- `environment-info` selects later workflows. Migration intent selects the
  migrate reference first. Otherwise a non-empty `environmentJsonPath` selects
  the repository-managed reference, while a null or absent path selects the
  DB-managed reference. A greenfield repository selects the create reference.
- The environment and Build tools from CA-51 expose every operation named by
  the selected reference. T3 may map Cursor-style tool names to its MCP names,
  but the mapping must preserve arguments, receipts, blocker behavior, and
  draft-versus-saved semantics.
- Web, desktop, Settings, the command palette, and any keybinding entry point
  start the same skill workflow. A dashboard form or duplicated hard-coded
  prompt is not a substitute.
- Focused integration coverage exercises one successful create through Save,
  one required-action pause and resume, one failed draft Build that leaves the
  last successful Build active, and routing for repository-managed,
  DB-managed, and migrate flows. Tests verify that configuration changes affect
  newly started agents and never claim to rebuild or migrate the running agent.

### CA-43: Hibernate idle agents and wake from snapshots

Status: Done on 19 September 2026 in [PR #32](https://github.com/Atheal9k/cloud-agents/pull/32).

Dependencies: CA-14, CA-17, CA-40, CA-42.

Description: Make idle compute release the default cost boundary.

Acceptance criteria:

- When a turn settles with no blocking interaction, mark the agent `IDLE`,
  flush T3 userdata/workspace/provider-home consistently, and start a
  configurable idle-release timer (initial default 3600 seconds).
- Follow-up inside the window resets the timer and reuses the guest. After the
  window, snapshot dirty state and stop/destroy the guest.
- Follow-up after release restores exactly one fenced runtime and resumes T3
  from its snapshot. It reports filesystem restore separately from
  provider-native session resume.
- Active-run deadlines remain hard caps, but the old 120-minute EC2 TTL is not
  the conversation lifetime. Cleanup never terminates a stopped snapshot as an
  expired active worker.
- Crash between settle, snapshot acknowledgement, and guest deletion is
  reconciled without two writers or acknowledged-result loss.

### CA-44: Isolate and pack Linux runtimes on a managed fleet

Status: Done on 19 September 2026 in [PR #34](https://github.com/Atheal9k/cloud-agents/pull/34).

Dependencies: CA-03, CA-07, CA-40, CA-42, CA-43.

Description: Replace per-thread `RunInstances` with Firecracker microVM guests
on a small execution fleet in a separate AWS account.

Acceptance criteria:

- Prove Firecracker on the selected metal/nested-virtualization instance,
  including KVM, guest kernel, networking, block snapshots, console, and
  teardown.
- Each agent has its own VM boundary, encrypted disk/key, userspace, network
  identity, and task cgroup. It cannot read hypervisor credentials, instance
  metadata, or sibling state.
- Placement consumes explicit CPU/memory/disk/profile slots. CPU may be
  oversubscribed within measured limits; memory pressure cannot OOM neighbors.
- Hypervisor loss reschedules only snapshot-safe idle/terminal work; active
  process migration is not claimed.
- The EC2 stop/snapshot-per-active-thread path remains a documented migration
  fallback. It is not reported as final Cursor parity.

### CA-45: Pre-warm active Builds and scale runtime capacity

Dependencies: CA-27, CA-42, CA-44.

Status: Done on 19 September 2026 in
[PR #33](https://github.com/Atheal9k/cloud-agents/pull/33).

Description: Keep bounded warm copies of popular active Builds and scale host
capacity from measured queue and slot demand.

Acceptance criteria:

- Placement records `warmFork: warm|cold`, Build ID, claim latency, boot time,
  and reason for fallback.
- Warm guests contain no user secrets, provider session, branch changes, or
  prior agent identity.
- Pool targets are bounded by environment/profile demand; scale-to-zero and
  eviction never remove the last durable Build snapshot.
- Concurrent claims cannot assign one guest twice. Obsolete environment
  versions drain without mutating active agents.
- Compare cold Build restore, warm claim, and today's EC2 startup before
  choosing pool sizes.

### CA-46: Implement snapshot retention, archive, and deletion

Status: Done on 19 September 2026 in [PR #37](https://github.com/Atheal9k/cloud-agents/pull/37).

Dependencies: CA-40, CA-43.

Description: Separate live compute, disk snapshots, conversation retention,
archive, and permanent deletion.

Acceptance criteria:

- Agent snapshots use rolling 90-day inactivity retention; successful
  start/resume refreshes it. Garbage collection is idempotent and visible.
- Conversation/run state is retained indefinitely by default with a
  configurable administrative cap; artifacts follow their declared policy.
- Archive is idempotent, releases runtime claims, hides the agent, and rejects
  new runs. Unarchive restores eligibility without silently waking compute.
- Permanent delete removes transcript and artifacts irreversibly but does not
  promise on-demand deletion of immutable snapshots before policy expiry.
- Cleanup cannot remove hypervisors, active guests, current Builds, PRs, or
  another agent's data.

## Daytona execution and physical Android development

The earlier Firecracker audit remains useful history, but Firecracker is no
longer the intended managed runtime. These tickets replace the nine open
Firecracker tickets in place. They use Daytona's current sandbox lifecycle:
started, stopped, paused where supported, archived, and deleted. Stopping keeps
the filesystem but clears running process state. Archive moves a stopped
filesystem to object storage. Starting a stopped or archived sandbox restores
it. [Daytona sandboxes](https://www.daytona.io/docs/sandboxes),
[persistence](https://www.daytona.io/docs/en/persistence/).

### CA-60: Replace AWS and Firecracker admission with a Daytona provider

Dependencies: CA-05, CA-40, CA-44, CA-47.

Status: Done on 21 September 2026 in [PR #66](https://github.com/Atheal9k/cloud-agents/pull/66).

Description: Add Daytona as the managed execution provider and remove
Firecracker readiness from the forward launch path without deleting historical
AWS records or test fixtures.

Acceptance criteria:

- Define a provider-neutral runtime interface for create, inspect, start, stop,
  archive, delete, execute, preview, and snapshot operations. The Daytona
  adapter implements it through the official SDK/API.
- Persist Daytona sandbox ID, region, resource class, lifecycle state,
  environment/Build ID, agent ID, run ID, and allocation attempt. Never infer
  readiness from a generated ID or requested state.
- Settings and launch entry points report Daytona authentication, API
  reachability, configured limits, and observed sandbox readiness. Missing or
  invalid credentials fail before a run enters an endless working state.
- Disable AWS/Firecracker admission by default. Existing retained AWS runs stay
  readable and cleanable, but new runs never fall back to EC2 silently.
- The controller keeps the Daytona API key server-side. Web, desktop, mobile,
  worker code, repository commands, and preview URLs never receive it.
- Focused tests cover disabled, unauthenticated, quota/capacity failure, lost
  create response, stale sandbox, and provider outage cases.

Reference: [Daytona TypeScript SDK](https://www.daytona.io/docs/en/typescript-sdk/).

### CA-61: Prove the Daytona sandbox lifecycle and security boundary

Dependencies: CA-60.

Status: Done on 2026-09-21 in [PR #67](https://github.com/Atheal9k/cloud-agents/pull/67).

Description: Run a bounded live proof before connecting production admission.
Measure the real lifecycle and identify which persistence features the selected
Daytona sandbox class supports.

Acceptance criteria:

- Create one private sandbox in the selected Daytona region and resource class.
  Record observed create/start latency, CPU, memory, disk, and current provider
  pricing or quota without hard-coding those values into product logic.
- Execute a command, create a long-running process session, stream its logs, and
  connect through a short-lived Daytona SSH access token. Revoke the token and
  prove reuse fails. Daytona SSH access is access into the sandbox, not GitHub
  repository authentication.
- Serve a test HTTP/WebSocket application through a port-bound signed preview
  URL. Expiry and explicit revocation must remove access. Do not expose the
  sandbox-wide preview token because it also authenticates sensitive toolbox
  ports.
- Stop and start the sandbox and prove that files remain while processes do not.
  Archive and restore it, then delete it. Record the actual state transitions
  and bounded failure results.
- Run an isolation probe that cannot read the controller's Daytona key, another
  sandbox, or controller-local state. Repository code has no Daytona management
  authority.
- Delete every proof resource after collecting redacted evidence, including on
  failure. Report any retained or billable resource rather than hiding it.

References: [Daytona lifecycle](https://www.daytona.io/docs/sandboxes),
[process sessions](https://www.daytona.io/docs/process-code-execution),
[SSH access](https://www.daytona.io/docs/en/ssh-access/), and
[preview URLs](https://www.daytona.io/docs/en/preview/).

### CA-62: Back environment Builds with Daytona images and snapshots

Dependencies: CA-61.

Status: Done on 2026-09-21 in [PR #68](https://github.com/Atheal9k/cloud-agents/pull/68).

Description: Map T3's versioned environment and explicit Save workflow onto
tested Daytona image, snapshot, and sandbox operations.

Acceptance criteria:

- Create a minimal versioned Daytona image or snapshot with the selected T3
  worker runtime, Node, Git, provider CLIs, and repository-independent tools.
  Pin versions and exclude secrets, source-control credentials, provider homes,
  and mutable repository state.
- Build preparation creates an isolated sandbox, checks out the requested ref,
  runs the terminating idempotent `install` phase, and stores logs and immutable
  provenance. Per-start services and named terminals do not run during install.
- Verify a draft Build in a fresh sandbox. Only explicit Save activates it;
  failed or cancelled verification leaves the prior active Build unchanged.
- State exactly what each artifact retains. Cold snapshots retain filesystem
  state, while pause or hot-snapshot behavior is available only when the chosen
  sandbox class supports it. Never claim arbitrary process migration.
- Keep reusable Build content separate from each durable agent's workspace,
  T3 event state, provider session, runtime secrets, and phone pairing state.
- Retention, archive, delete, corrupt/missing snapshot, and concurrent Save
  tests use the real adapter plus focused fakes for deterministic fault cases.

References: [Daytona persistence](https://www.daytona.io/docs/en/persistence/)
and [Sandbox SDK](https://www.daytona.io/docs/en/typescript-sdk/sandbox/).

### CA-63: Run T3 agents inside Daytona with visible progress and cancellation

Dependencies: CA-09, CA-11, CA-15, CA-60, CA-61, CA-62.

Status: Done on 21 September 2026 in
[PR #69](https://github.com/Atheal9k/cloud-agents/pull/69).

Description: Connect the controller's runtime provider to Daytona and run the
existing T3 worker inside each assigned sandbox.

Acceptance criteria:

- Replace simulated launch and stop effects with idempotent Daytona operations.
  Persist command IDs and receipts so a lost response cannot create a second
  sandbox or attach the wrong agent to a reused sandbox.
- Bootstrap the worker with attempt-bound T3 registration and selected
  environment metadata. Successful T3 registration and provider readiness,
  not sandbox creation alone, transition the run to ready.
- Stream allocation, start, checkout, setup, provider, terminal, preview, stop,
  archive, and delete progress with elapsed time and actionable errors. The UI
  always offers cancel while the operation is cancellable.
- Stop works during creation, start, setup, execution, reconnect, and archive.
  The UI distinguishes requested cancellation, provider interruption, sandbox
  stop, and confirmed resource release.
- Use Daytona process sessions for long-running worker and development
  processes. Reconcile observed status rather than assuming a controller-side
  command is still alive.
- Ordinary previews use a short-lived signed Daytona URL or protected T3 proxy.
  Desktop automation uses Daytona VNC and Computer Use on demand.
- A live proof covers a provider turn, terminal, preview, reconnect,
  cancellation, controller restart, and sandbox cleanup.

References: [Daytona process execution](https://www.daytona.io/docs/process-code-execution),
[preview](https://www.daytona.io/docs/en/preview/), and
[Computer Use](https://www.daytona.io/docs/en/computer-use/).

### CA-64: Provide provider login and repository-scoped GitHub SSH

Dependencies: CA-06, CA-49, CA-61, CA-63.

Status: Done on 2026-09-21 in [PR #70](https://github.com/Atheal9k/cloud-agents/pull/70).

Description: Let Codex and Claude authenticate in a Daytona sandbox and let Git
use the owner's required SSH remote without confusing Daytona's inbound SSH
feature with source-control authentication.

Acceptance criteria:

- Codex and Claude each have a documented remote-safe login flow. T3 stores
  protected credentials outside reusable snapshots and injects only the
  minimum per-sandbox state. Logout, expiry, and reauthentication are explicit.
- Provision a per-user or per-sandbox Git SSH identity, or forward a short-lived
  signing/auth agent. Scope it to approved repositories and operations. Never
  bake private keys, sockets, or decrypted credentials into Daytona snapshots.
- Pin and verify GitHub's SSH host keys. Support `git@github.com:` and
  `ssh://git@github.com/` clone, fetch, pull, and push without rewriting to HTTPS.
- Revoke Git credentials and remove transient agent material when the sandbox
  is released. Restored or reassigned sandboxes cannot reuse another identity.
- Tests prove private clone/fetch/push, wrong repository rejection, host-key
  mismatch, expiry during a run, sandbox restore, and cleanup.

Daytona's SSH token grants inbound access to a sandbox. Its documented private
Git helper uses HTTPS username and PAT fields. Neither feature provisions T3's
GitHub SSH identity. [Daytona SSH access](https://www.daytona.io/docs/en/ssh-access/),
[Git operations](https://www.daytona.io/docs/en/git-operations/).

### CA-65: Reconcile Daytona lifecycle, idle cost, and failures

Dependencies: CA-43, CA-45, CA-46, CA-55, CA-63, CA-64.

Status: Done on 21 September 2026 in [PR #71](https://github.com/Atheal9k/cloud-agents/pull/71).

Description: Make durable agents survive controller and Daytona failures while
inactive sandboxes stop consuming running compute.

Acceptance criteria:

- Reconcile controller intent with Daytona's sandbox list after controller
  restart, timeout, duplicate command, and provider outage. Fence stale writers
  and never start a cancelled run during recovery.
- Apply explicit auto-stop or auto-pause, auto-archive, auto-delete, and maximum
  TTL policy per environment. Activity, agent idle, viewer idle, and retention
  timers are different clocks and are displayed accurately.
- Before stop or archive, checkpoint T3 state and provider continuation data.
  After start, recreate per-boot processes, preview links, and expiring
  credentials. Metro, provider CLIs, and terminals do not survive stop.
- Show sandbox running time, storage/retention, transfer, model use, and Daytona
  quota separately. Measure cold create, stop/start, archive/start, and Build
  restore latency before enabling warm sandboxes.
- Cancellation and cleanup can affect only the sandbox owned by that allocation
  attempt. Lost resources appear in an operator queue with a retry.
- Fault tests interrupt create, registration, checkpoint, stop, archive,
  restore, preview renewal, and delete. A live proof confirms retained work,
  one writer, and no orphaned paid sandbox.

Reference: [Daytona sandbox lifecycle](https://www.daytona.io/docs/sandboxes).

### CA-66: Connect an Expo development build to Metro in Daytona

Dependencies: CA-10, CA-14, CA-62, CA-63, CA-65.

Status: Done on 21 September 2026 in [PR #72](https://github.com/Atheal9k/cloud-agents/pull/72).

Description: Run Expo CLI and Metro in the agent's Daytona sandbox, then let an
installed Expo development build on the owner's physical phone connect through
an Expo tunnel.

Acceptance criteria:

- Detect `expo-dev-client` and repository package-manager conventions. Start a
  named Daytona process session with `npx expo start --dev-client --tunnel` or
  the repository's equivalent. Never substitute Expo Go.
- Read the development-client deep link through Expo CLI's supported endpoint
  or structured output, bind it to the run, and present a phone-safe Open button
  plus QR fallback. Do not depend only on terminal decoration parsing.
- Show Metro, tunnel, and development-build compatibility as separate states.
  Display logs, startup time, last client connection, reconnect, restart, and
  stop controls. A failed ngrok tunnel reaches an error with retry.
- JavaScript, TypeScript, and asset changes demonstrate Fast Refresh. Native
  dependency, app config, Gradle, Kotlin, or Java changes report that a new
  development build is required.
- Stopping or archiving the sandbox terminates Metro and invalidates the prior
  link. Wake creates a new process and link, then reconnects the phone.
- The Expo tunnel carries Metro traffic only. It does not expose ADB, capture
  the screen, return UI hierarchy, or permit taps and typing.
- Tests cover stale links, tunnel timeout, port conflict, phone reconnect,
  incompatible development build, Metro restart, sandbox wake, and cancellation.

References: [Expo CLI](https://docs.expo.dev/more/expo-cli/),
[development-build workflows](https://docs.expo.dev/develop/development-builds/development-workflows/),
and [using development builds](https://docs.expo.dev/develop/development-builds/use-development-builds/).

### CA-67: Qualify and implement physical Android device control

Dependencies: CA-20, CA-35, CA-47, CA-49, CA-66.

Status: Open.

Description: Select and implement a phone-side control path that is honest about
Android permissions. A normal companion app does not gain arbitrary ADB, silent
install, logcat, or system-wide automation privileges merely by being enrolled.

Acceptance criteria:

- Prototype and compare three explicit modes before claiming support. Prefer an
  app-scoped test bridge inside the development build when it can expose the
  needed UI tree, screenshots, app actions, and logs. A companion using
  AccessibilityService and MediaProjection needs visible user grants and a
  foreground-service lifecycle. Wireless Debugging/ADB needs one-time Android
  pairing and a private route, and grants much broader shell authority.
- Record which operations each mode can actually perform. Do not promise silent
  APK install, full logcat, secure-window capture, cross-app control, or file
  access unless the selected mode proves the required Android privilege.
- Review Google Play policy and distribution constraints for accessibility,
  screen capture, VPN, and debugging use. If the required broker cannot ship in
  the normal T3 app, use a separately signed developer companion and label it.
- The phone or companion opens an outbound authenticated channel to T3. Raw ADB
  is never public and is never forwarded into Daytona. Any VPN-mediated ADB
  route is private, device-bound, revocable, and unavailable to repository code.
- Bind every command to user, device, app/package, agent, run, expiry, nonce,
  and capability. Require visible session consent and an ongoing Stop control.
  CA-35's exclusive input lease arbitrates human and agent input.
- Support stop, per-controller revocation, forget-all, individual capability
  disablement, and Android's debugging-authorization revocation. Reboot, Wi-Fi
  change, random wireless-debugging port, phone sleep, foreground-service stop,
  controller outage, and permission removal enter explicit disconnected states.
- Reject queued input after lock, app switch, lease expiry, broker restart,
  sandbox replacement, or revocation. Never capture or type into secure fields.
- Tests cover pairing replay, wrong controller, permission denial, network loss,
  duplicate input, revocation, reboot, app switch, and reconnection. An
  authorized real-phone proof must demonstrate the selected mode's supported
  screenshot, inspection, tap, type, reload, and log operations before the UI
  advertises agent control.

Android 11 and later supports wireless debugging after explicit pairing and
lets the owner forget a workstation or revoke debugging authorizations.
[Android hardware-device debugging](https://developer.android.com/studio/run/device).

### CA-68: Prove the complete Daytona and physical-device workflow

Dependencies: CA-60, CA-61, CA-62, CA-63, CA-64, CA-65, CA-66, CA-67.

Status: Open. Release gate for Daytona cloud agents and physical Android control.

Description: Verify the stack from the user's point of view with the same T3
contracts in local-controller and hosted-controller modes.

Acceptance criteria:

- Complete repository selection, Continue, setup with the saved model, visible
  progress, required-secret pause/resume, draft Build, fresh Daytona sandbox
  verification, review, explicit Save, and follow-up from the phone.
- Clone and push a private GitHub repository through its SSH remote. Run Codex
  and Claude login and reauthentication without exposing their session material
  to a reusable snapshot or another sandbox.
- For backend work, run tests, inspect logs, stop, resume, reconnect, cancel,
  retain results, and publish a draft PR. Controller restart and Daytona outage
  produce bounded recovery with no ghost Working state.
- For Android work, start Metro in Daytona, open the development-client link on
  the physical phone, make a visible JavaScript change, observe Fast Refresh,
  then use only the device-control capabilities proven in CA-67. The owner can
  take control back and revoke the session immediately.
- Repeat stop and wake after at least six hours of inactivity. Restore the
  workspace, start new processes and credentials, reconnect the development
  build, and state which on-device app state did not persist.
- Verify cancellation during Daytona creation, setup, provider execution,
  Metro/tunnel startup, device connection, and active control. Reload shows a
  terminal or idle state and a usable composer. Long review pages scroll on
  phone, web, and desktop.
- Retain redacted receipts, sandbox IDs, timings, logs, tests, and usage evidence.
  Delete temporary resources and revoke device, preview, SSH, Git, provider,
  and tunnel access after the proof.
- Do not label the stack ready from mocks, generated IDs, configured flags, or
  Metro connectivity alone. Both ordinary and physical Android workflows must
  pass against live services.

## Cursor-parity product, API, and security

### CA-47: Expose the Cloud Agents API and event stream

Status: Done on 19 September 2026 in
[PR #41](https://github.com/Atheal9k/cloud-agents/pull/41).

Dependencies: CA-40, CA-46.

Description: Add a versioned API shaped like Cursor's Cloud Agents API rather
than exposing infrastructure allocation calls.

Acceptance criteria:

- Basic and Bearer API keys support create/list/get agents, create/list/get
  runs, cancel, usage, archive, unarchive, and delete; service accounts are
  distinct principals.
- Create supports caller-provided agent IDs with `agent_id_conflict`; concurrent
  runs return `agent_busy`; terminal cancellation returns
  `run_not_cancellable`.
- SSE emits `status`, `assistant`, `thinking`, `tool_call`,
  `interaction_update`, `heartbeat`, `result`, `error`, and `done`; supports
  `Last-Event-ID` and explicit expired-stream errors.
- Inputs support agent/plan mode, model/context parameters, environment or
  repository target, ref/PR behavior, images, environment variables, MCP
  servers, and custom subagents with validated limits.
- `/v1/me`, models, repositories, usage, pagination, rate limits, request IDs,
  and stable error codes are documented and contract-tested.

### CA-48: Serve artifacts, computer use, and remote desktop

Status: Done on 19 September 2026 in
[PR #29](https://github.com/Atheal9k/cloud-agents/pull/29).

Dependencies: CA-34, CA-35, CA-40.

Description: Complete Cursor's verification loop while retaining T3's direct
app-preview versus shared-desktop distinction.

Acceptance criteria:

- Agent-scoped artifacts list relative paths and download through short-lived
  authorized URLs; screenshots, videos, logs, and test output can be attached
  to PRs.
- Artifact storage is encrypted, bounded, content-typed, access-checked, and
  available after hibernation. Optional public Git image links require an
  explicit admin policy.
- Computer use controls the same browser/desktop the user can observe and take
  over; existing CA-35 input leases remain authoritative.
- Direct app previews remain cheaper and isolated from the agent browser.
  Hidden viewers stop frames without stopping active automation.
- Artifacts and a walkthrough are part of successful user-visible run
  completion, not a replacement for actual verification.

### CA-49: Add Cursor-equivalent secrets, identity, and network controls

Status: Done on 19 September 2026 in
[PR #45](https://github.com/Atheal9k/cloud-agents/pull/45).

Dependencies: CA-06, CA-07, CA-41, CA-44.

Description: Make security policy part of each environment/runtime rather than
ambient EC2 configuration.

Acceptance criteria:

- Support environment variables, runtime-redacted secrets, and Build-only
  secrets with user/team/environment scope and correct Build/runtime timing.
- Support allow-all, default-plus-allowlist, and allowlist-only egress with
  environment/team inheritance and an admin lock. Controller, SCM, and artifact
  exceptions are explicit.
- Runtime metadata and five-minute OIDC tokens are served over a local Unix
  socket with agent, owner, turn, workspace, repository, and managed/self-hosted
  claims, rate limits, and JWKS verification.
- TLS 1.2+, per-agent encryption keys, encrypted snapshots/artifacts, optional
  customer-managed KMS keys, Privacy Mode, and secret redaction are verified.
- Protected repository scopes, blocklists, short-lived SCM credentials, and
  optional AWS assume-role federation prevent access wider than the triggering
  user.

### CA-50: Match source-control entry points and team collaboration

Status: Done on 19 September 2026 in [PR #50](https://github.com/Atheal9k/cloud-agents/pull/50).

Dependencies: CA-06, CA-16, CA-21, CA-40, CA-47.

Description: Let users create and share agents where they already work while
enforcing team and repository access.

Acceptance criteria:

- Connect GitHub/GHES, GitLab/self-hosted GitLab, Bitbucket Cloud, and Azure
  DevOps incrementally; each agent's access is the intersection of app install,
  triggering principal, and configured repository scope.
- Web, desktop Cloud destination, API, Slack, GitHub/Bitbucket mentions, and
  Linear all create/follow up through one idempotent run path.
- Shared agent URLs require same-team membership and the viewer's own SCM
  access. Viewing is read-only by default.
- Team follow-ups have admin policy: disabled, service accounts only, or all,
  with explicit lateral-access and secret-risk warnings.
- Branch/PR behavior supports new `cursor/...` branches, current branch,
  starting ref, PR continuation, draft PR creation, and reviewer suppression
  without force pushes.

### CA-51: Support MCP servers, hooks, and custom subagents

Status: Done on 19 September 2026 in [PR #48](https://github.com/Atheal9k/cloud-agents/pull/48).

Dependencies: CA-11, CA-41, CA-47, CA-49.

Description: Match the extensibility available to Cursor cloud runs.

Acceptance criteria:

- Team and personal MCP servers support HTTP and stdio transports; OAuth is
  per user, HTTP credentials can stay outside the guest, and stdio executes in
  the runtime.
- The built-in cloud diagnostics MCP exposes run info, transcripts, events,
  environment/Build details, setup logs, and authorized fleet diagnostics, plus
  the CA-59 setup tools: `environment-info`, `take-environment-snapshot`,
  `check-environment-snapshot`, `trigger-environment-build`,
  `list-environment-builds`, `environment-build-logs`,
  `propose-environment-json`, and `request-environment-setup-actions`.
- Repository `.cursor/hooks.json` command hooks cover supported tool/file and
  lifecycle events. Early read-only setup and unavailable local-home hooks are
  documented.
- API custom subagents have bounded count/size, cannot shadow built-ins, inherit
  permissions intentionally, and appear in run events/usage.
- MCP/hook/subagent failures are isolated, redacted, auditable, and never
  silently widen runtime network or secret access.

### CA-52: Wake agents from subscriptions and CI autofix

Status: Done on 19 September 2026 in [PR #60](https://github.com/Atheal9k/cloud-agents/pull/60).

Dependencies: CA-29, CA-40, CA-43, CA-47, CA-50.

Description: Allow an idle durable agent to receive event-driven follow-up
runs without keeping compute online.

Acceptance criteria:

- Subscriptions support GitHub PR/CI, Slack thread/channel, Linear issue/comment,
  and timers/loops with explicit create/list/delete operations.
- Delivery targets the durable agent, coalesces bursts, is idempotent, and may
  wake it for up to the configured maximum (Cursor parity target: 180 days).
- CI autofix follows only eligible agent-created PRs and skips human pushes,
  explicit user follow-ups, pre-existing base failures, and work after the
  configured repair cap (parity target: 10).
- Subscriptions remain visible and cancellable while the agent is idle; archive
  disables them without losing audit history.
- Event receipts replace sleeps/polling in tests. Failed wake/placement is
  retryable and never acknowledges a follow-up that was not persisted.

### CA-53: Add Cursor-like automations

Dependencies: CA-28, CA-47, CA-50, CA-51, CA-52.

Status: Done on 19 September 2026 in [PR #63](https://github.com/Atheal9k/cloud-agents/pull/63).

Description: Generalize schedules and webhook triggers into reusable
automations running as a user or service account.

Acceptance criteria:

- Triggers include cron, source-control events, Slack, Linear, Sentry,
  PagerDuty, and authenticated private webhooks.
- Automations select environment, repositories, model, instructions, tools,
  limits, publication, and run-as principal. Service-account spend and
  permissions remain separate from a user.
- Actions may create/comment on PRs, request reviewers, post to Slack, call
  MCP, use computer control, and update explicit inspectable memories.
- Overlap, missed-run, deduplication, retries, pause/resume/edit/delete, and
  daylight-saving behavior are defined.
- Every execution creates ordinary agent/run records, obeys admission/spend
  policy, and can hibernate after completion.

### CA-54: Publish webhooks and typed SDKs

Dependencies: CA-47, CA-52.

Status: Done on 19 September 2026 in [PR #64](https://github.com/Atheal9k/cloud-agents/pull/64).

Description: Provide supported programmatic clients and outbound lifecycle
events without making consumers poll.

Acceptance criteria:

- Signed webhooks deliver terminal/status events with delivery/event IDs,
  HMAC-SHA256 verification, replay protection, bounded retries, and dead-letter
  visibility.
- TypeScript and Python SDKs cover local and cloud agents through one
  workflow-oriented interface, not a chat-completions API.
- A documented bridge protocol permits additional SDK languages without
  coupling clients to T3 internals.
- Pagination, SSE resume, rate limits/backoff, idempotency keys, and API error
  types are tested in SDK conformance fixtures.
- Versioning distinguishes preview/beta endpoints and preserves supported
  clients during contract evolution.

### CA-55: Add usage, spend limits, and administrative audit

Dependencies: CA-18, CA-40, CA-47, CA-49.

Status: Done on 19 September 2026 in [PR #46](https://github.com/Atheal9k/cloud-agents/pull/46).

Description: Replace a one-instance cost estimate with per-run model,
runtime, storage, artifact, and automation accounting.

Acceptance criteria:

- Usage separates model tokens/context window, active guest time, hypervisor
  allocation, snapshots, artifacts/transfer, previews, and external-provider
  unknowns.
- User/team/service-account spend limits gate admission and follow-up before
  allocating compute; cleanup and result access remain available.
- Defaults for model/context, repository/ref, long-running, computer use,
  summaries, artifacts-to-Git, and collaboration are admin-controlled.
- Audit events cover auth, config, Build activation, agent/run lifecycle,
  snapshot, artifact, SCM publication, secret/policy changes, and admin actions.
- Reports are exportable without full prompts or secret values and reconcile
  estimates against AWS/model invoices.

### CA-56: Add multi-repo environments and start-from-scratch

Status: Done on 19 September 2026 in [PR #55](https://github.com/Atheal9k/cloud-agents/pull/55).

Dependencies: CA-41, CA-42, CA-47, CA-50.

Description: Match Cursor's repository targeting beyond one configured GitHub
checkout.

Acceptance criteria:

- One environment can prepare multiple authorized repositories in one Build,
  preserve per-repo refs/branches, and open coordinated PRs in changed repos.
- Limits and access are validated per repository; dependent repos/submodules
  cannot widen the triggering user's scope.
- Multi-repo incompatibilities are explicit, including no long-running mode
  until the implementation proves it.
- A no-repository agent starts in an isolated workspace and can create a draft
  repository through the chosen T3/Git provider path.
- Port forwarding, Design Mode/visual selection, and optional deployment from
  scratch are capability-gated and use the same artifact/security boundaries.

### CA-57: Sign commits and expose provenance

Status: Done on 19 September 2026 in [PR #57](https://github.com/Atheal9k/cloud-agents/pull/57).

Dependencies: CA-16, CA-40, CA-49, CA-50.

Description: Make agent-authored changes attributable and compatible with
signed-commit protection.

Acceptance criteria:

- Every trusted publication commit is signed with a per-service HSM/KMS-backed
  key and verified by supported Git providers.
- Commit/PR metadata links agent, run, environment version, Build, base,
  provider/model, and triggering principal without leaking prompts or secrets.
- Task code cannot access signing keys or invoke the signer for arbitrary
  repositories/identities.
- Re-sign, rebase, retry, key rotation, and provider outage behavior are
  deterministic and never force-push silently.
- Provenance is available in review UI, API, audit export, and retained
  results.

### CA-58: Offer self-hosted machines and team pools

Status: Done on 19 September 2026 in [PR #51](https://github.com/Atheal9k/cloud-agents/pull/51).

Dependencies: CA-40, CA-47, CA-49, CA-55.

Description: Match Cursor's runtime choice for customers who keep tool
execution on their own machines while T3 retains the agent control plane.

Acceptance criteria:

- Personal machines support multiple agents where configured; team pools use
  one agent per worker by default and retain registration at scale-to-zero.
- Pool APIs list/watch pending work, claim/release by worker ID, emit
  `created`, `claimed`, `claimed_offline`, `expired`, and heartbeat events, and
  recover from expired cursors by relisting.
- Idle release, `workerReadyTimeoutSeconds`, `claimedWorkerId`, and
  `wakeTimeoutMs` support customer-managed hibernate/restore; otherwise a
  follow-up may claim a fresh worker honestly.
- Workers connect outbound only, support labels and bounded repo roots,
  optional clone/token/secret sync, identity socket, health/readiness/metrics,
  and computer use.
- Admins can allow or require self-hosting. Pool and machine permission,
  billing, network, artifact, and secret differences are visible before launch.

## Historical emulator and simulator work

CA-37 through CA-39 record the earlier AWS worker implementation and its merged
PRs. They remain useful as optional remote-emulator work, but they are not the
Android path for the Daytona release. CA-66 and CA-67 replace that everyday
path with a physical Expo development build, Metro in Daytona, and separately
authorized device control.

### CA-37: Build and launch Android apps in accelerated emulator workers

Status: Done on 19 September 2026 in [PR #39](https://github.com/Atheal9k/cloud-agents/pull/39).

Dependencies: CA-02, CA-03, CA-07, CA-10, CA-14, CA-27, CA-40, CA-41,
CA-42, CA-43, CA-44.

Description: Add an Android environment/Build profile that boots an accelerated
emulator inside an isolated runtime, builds the app, and participates in the
same durable-agent and idle-snapshot lifecycle as web runtimes.

Acceptance criteria:

- Validate the selected EC2 region/type, nested-virtualization launch option, Linux KVM access, and emulator acceleration on the actual instance. The web worker's t3.medium is not assumed suitable; reject unsupported configurations before running a costly build.
- Bake compatible JDK, Android SDK/build tools, platform tools, emulator, and a pinned AVD system image into a separate image. Select SDK/API/architecture from project requirements and validate installed package ABI.
- Boot an explicitly owned AVD/serial, wait for device readiness, build a debug/development app, install, and launch it. Expose build progress, logcat, failure diagnostics, and an explicit restart/reset.
- Give each job its own writable emulator data, ports, and app state. Agent testing commands target its exact serial; ADB/gRPC/control endpoints are not public.
- For React Native/Expo projects, configure Metro and emulator connectivity within the worker and rebuild native clients when native inputs change. Expo Go alone is not proof of arbitrary native-module support.
- UI tests or semantic interaction tools can inspect/tap/type in the running app; capture screenshots/video as run artifacts. An interactive human stream is supplied by CA-39.
- Stop only owned emulator/build/app processes and snapshot configured emulator
  state separately from shared Build state. An emulator crash or failed build
  leaves an actionable result and no unbounded host.
- Hibernation proves whether AVD data is restorable; otherwise wake creates a
  new AVD and reports that app/login state did not persist.

### CA-38: Build and launch iOS apps on EC2 Mac workers

Status: Done on 19 September 2026 in [PR #36](https://github.com/Atheal9k/cloud-agents/pull/36).

Dependencies: CA-02, CA-03, CA-04A, CA-06, CA-10, CA-14, CA-27, CA-40,
CA-41, CA-42, CA-43.

Description: Add a macOS environment/Build profile for iOS/iPadOS builds and
Simulator execution. Keep the Mac host policy separate: the durable agent can
idle, but EC2 Mac's 24-hour Dedicated Host economics do not become Linux
microVM rules.

Acceptance criteria:

- Validate Mac capacity, region, dedicated-host quota, compatible Apple Silicon hardware, macOS, Xcode, simulator runtime, and repository dependencies before admission.
- Provision a versioned Mac environment with the selected provider/T3 runtime and required Xcode/SDK tools. Complete license acceptance and first-launch setup through a documented authorized image-build process.
- Reserve an exact simulator UDID per job, boot it, build for the simulator, install, and launch the app. Retain xcodebuild/test results, simulator logs, screenshots, and video. Native simulator artifacts must match the selected architecture.
- Support the repository's actual build workflow, including native Swift or React Native/Expo with Metro where required. Use the correct native development build after native dependency changes.
- Simulator builds use simulator-compatible signing settings. Device distribution certificates and App Store upload credentials are not required for basic simulator testing; signing/distribution remains separate unless a project explicitly needs it.
- Default to one active job per Mac worker, with isolated checkout, simulator data, credentials, and targeted process cleanup. Reuse the allocated host for queued jobs only after the previous job is cleaned.
- Record dedicated-host allocation time, earliest release time, availability/scrubbing state, and continuing host cost separately from job runtime. Cancelling a two-hour job must not claim that the 24-hour host allocation or charges ended.
- Stop new jobs when release is requested, finish/cancel active work according to policy, and retry host release when eligible. Never apply the disposable Linux worker shutdown policy blindly to the Mac host.
- The provider, simulator, and display route do not require a local Mac. Under CA-04A, the local controller machine must remain online even after the initiating client disconnects. CA-04B later allows that machine to be off. Where the Mac worker needs a desktop session or login, provision and validate it explicitly.
- Agent snapshots, simulator data, Xcode caches, and reusable Build layers have
  separate retention. Wake never claims transparent resume if the simulator
  process was not restorable.

### CA-39: Embed live simulator display and control in each thread

Status: Done on 19 September 2026 in [PR #53](https://github.com/Atheal9k/cloud-agents/pull/53).

Dependencies: CA-19, CA-25, CA-34, CA-35, CA-36, CA-37, CA-38, CA-48.

Description: Extend the thread preview to Android emulator and iOS Simulator sessions. The user can watch the app the agent is testing and take control from web or desktop.

Acceptance criteria:

- The thread selects app web preview, Android device, or iOS device according to its worker profile. Device name, runtime, serial/UDID, build revision, and connection state identify the actual session.
- Stream the exact emulator/simulator targeted by agent tools. Verify changing frames, real taps/clicks, text input, scrolling/swipes, rotation, and supported device buttons; a loaded wrapper or static screenshot does not pass.
- Validate a transport per platform. Reuse CA-34 when appropriate; evaluate a simulator-specific feed such as the repo's serve-sim workflow for iOS. Linux DCV behavior must not be assumed to work unchanged on macOS.
- Keep display/control endpoints local to the worker and expose only authorized capabilities through the thread route. Do not forward a simulator service's general shell endpoint, public ADB, arbitrary filesystem access, or unrelated desktop sessions.
- Reuse the human/agent input lease from CA-35. Agent automation targets exact devices through supported tools; delayed human input cannot reach a different job.
- Stream on demand, suspend hidden viewers, and make build/device startup independent of whether someone is watching. Recordings are explicit bounded artifacts.
- Hibernation revokes the display route and input lease. Reopen restores or
  recreates the exact declared device profile without starting a provider run.
- Android and iOS each pass a full build-install-launch-test-takeover-return-cleanup scenario after the initiating client disconnects. Under CA-04A the local controller machine stays online; under CA-04B the original computer may be off. A browser-rendered mobile website does not satisfy native-app testing.
- Run Android/iOS implementation independently as capacity allows. Report each platform's verified status separately; do not label both supported when only one passes.
- Existing T3 native mobile app navigation, stores, push services, and publication are not involved.

## Optional product expansion

### CA-26: Hand work between local and cloud environments

Dependencies: CA-10, CA-14, CA-15, CA-16, CA-21, CA-40, CA-43.

Status: Done on 19 September 2026 in [PR #44](https://github.com/Atheal9k/cloud-agents/pull/44).

Description: Transfer selected local changes into a cloud agent/environment and
bring cloud changes into a new local worktree. Distinguish continuing the same
agent after wake from creating a linked local continuation.

Acceptance criteria:

- Show base, destination, selected changes, and excluded files before transfer; never upload credentials/ignored files implicitly.
- Import results without overwriting dirty local files, with explicit conflict handling.
- Keep source/destination agents and threads linked under their own environment
  identities; never attach two writers to one snapshot.
- Transfer provider history only when supported; otherwise seed a clearly described continuation.
- Retry an interrupted transfer without duplicate patch application.

### CA-28: Add API-triggered and scheduled runs

Dependencies: CA-12, CA-17, CA-18, CA-24, CA-40, CA-47.

Status: Done on 19 September 2026 in [PR #54](https://github.com/Atheal9k/cloud-agents/pull/54).

Description: Run recurring work through the same agent/run admission path as
interactive tasks. This ticket supplies T3-native schedules; CA-53 generalizes
them into Cursor-like automations.

Acceptance criteria:

- Schedules create a new agent or follow up an existing durable agent
  explicitly; they never assume a runtime is already awake.
- Schedules record timezone, prompt, ref policy, recipe, provider, publication, and limits.
- Define daylight-saving, overlap, missed-run, and restart behavior.
- Under CA-04A, schedules run only while the local controller host and Docker engine are online. Missed-run behavior must not imply an always-on service. CA-04B later removes that local-machine dependency.
- Pause/resume/edit/delete actions are available remotely; retries remain bounded.
- Durable web/desktop activity records notify of meaningful outcomes. Native push is optional and not a dependency.

### CA-29: Trigger work from GitHub and address feedback

Status: Done on 19 September 2026 in [PR #58](https://github.com/Atheal9k/cloud-agents/pull/58).

Dependencies: CA-06, CA-15, CA-16, CA-18, CA-28, CA-47, CA-50.

Description: Add opted-in issue/PR triggers and bounded repair of review feedback or failing checks.

Acceptance criteria:

- Validate webhook signatures, delivery IDs, repositories, and authorized trigger actors.
- Under CA-04A, webhook delivery requires the configured authenticated route to the local controller, and the controller machine must be online. CA-04B later provides the always-on endpoint; this ticket does not require it.
- Retain source issue/comment/PR and base revision; task text cannot widen credentials or permissions.
- Follow-up targets the durable agent and correct branch head, wakes it when
  idle, and avoids duplicate delivery or agent-comment loops.
- Bound attempts, time, and compute; report unresolved failures.
- Disable/revoke controls stop new triggers. Automatic merge is separate.

### CA-30: Add persistent assistants

Dependencies: CA-14, CA-15, CA-18, CA-25, CA-28, CA-36, CA-40, CA-46.

Status: Done on 19 September 2026 in [PR #59](https://github.com/Atheal9k/cloud-agents/pull/59).

Description: Add reusable assistant roles on top of durable agents rather than
creating a third persistence model.

Acceptance criteria:

- Each assistant has explicit instructions, provider, tools, repositories, secret access, and persistence policy.
- Memory is inspectable, editable, and deletable; consequential facts can be traced to source context.
- Persistent files/browser state are opt-in, encrypted, and not silently shared between assistants.
- `IDLE`, archive/unarchive, reset, and delete define their effects on runs,
  subscriptions, credentials, and retained snapshots.
- Each writable workspace has one owner and all runs retain the ordinary limits and history.

### CA-32: Add private dependencies and company-network profiles

Dependencies: CA-03, CA-06, CA-07, CA-12, CA-18, CA-41, CA-42, CA-49.

Status: Done on 19 September 2026 in [PR #47](https://github.com/Atheal9k/cloud-agents/pull/47).

Description: Support private dependencies and private connectivity as
environment-scoped policy, with Cursor-like egress modes and explicit routes.

Acceptance criteria:

- Explicitly configure and check private submodule, LFS, and package-registry access.
- Expose only required dependency credentials to setup/task code; retain the protected publication and infrastructure boundary.
- Exclude credentials from logs, caches, commits, and exported workspace state.
- Support allow-all, default-plus-allowlist, and allowlist-only modes with
  inherited/locked team policy. Cursor/controller/SCM endpoints remain
  reachable through documented exceptions.
- Optional stable egress, Tailscale/Cloudflare Tunnel, or AWS PrivateLink
  profiles expose cost, trust, and routing changes.
- Report the failing dependency/destination and support disabling the profile without stranding runs.

## Remaining provider and mobile work

Cloud execution admits Codex and Claude; remaining providers stay classified
until a later enablement. CA-20 is now required for the phone-only workflow.
Push integration remains optional.

### CA-31: Qualify additional providers

Dependencies: CA-01, CA-07, CA-11, CA-15, CA-23, CA-40, CA-43.

Status: Done on 19 September 2026 in
[PR #62](https://github.com/Atheal9k/cloud-agents/pull/62).

Description: Enable remaining providers individually after the first selected provider works reliably.

Acceptance criteria:

- Codex, Claude, Cursor, Grok, OpenCode, and Antigravity each receive an enabled, unsupported, or blocked status with evidence.
- Every enabled provider passes remote login, execution, streaming,
  interruption, idle snapshot/wake, auth/quota failure, and cleanup on its
  advertised runtime.
- Filesystem restore, provider-native resume, context transfer, model
  switching, and computer use are reported as distinct capabilities.
- Accounts/instances cannot share mutable credentials or sessions accidentally.
- Unsupported options are rejected before allocation and switching provider does not pretend native history transferred.

### CA-20: Add phone cloud controls and Android device-host enrollment

Dependencies: CA-19, CA-21, CA-25, CA-34, CA-35, CA-36, CA-40, CA-47, CA-49.

Status: Open. Required by CA-67 and CA-68.

Description: Make the native T3 Android client the phone control center and the
enrollment shell for the device broker selected in CA-67. Keep ordinary cloud
agent management usable when device-host permissions are disabled.

Acceptance criteria:

- Android exposes create, follow-up, questions, approval, cancel, run status,
  PR review, artifacts, Daytona preview, Metro link, and device-control status
  through shared client-runtime logic.
- The user can enroll, rename, inspect, pause, and revoke this phone as a device
  host. Enrollment never turns on screen capture, AccessibilityService, VPN, or
  wireless debugging without the corresponding Android consent flow.
- Backgrounding T3 does not stop a Daytona run. Device control reports Android
  foreground-service and battery restrictions honestly and reconnects to the
  correct controller, environment, thread, and lease.
- Switching between T3 and the development build keeps both app identities
  clear. Metro connection, device online state, permission state, and agent
  input lease use separate indicators and controls.
- The client has an always-visible Stop control during agent input or screen
  capture. Revocation works even when the Daytona sandbox is unreachable.
- Distribution, signing, Google Play policy review, and any separate developer
  companion are explicit prerequisites. iOS control stays out of this ticket.

### CA-22: Add native push and mobile activity integration

Dependencies: CA-20, CA-21, CA-40, CA-52.

Status: Deferred. It cannot start before CA-20.

Description: Extend T3's native notification infrastructure when a distributable personal mobile client exists. Core web/desktop status does not depend on it.

Acceptance criteria:

- Required APNs/FCM, app identifiers, device registration, and service ownership are explicitly configured.
- Completion, failure, approval, subscription wake, and input notifications
  deduplicate across run IDs and reconnects.
- Notifications open the correct live/retained run and exclude secret values or sensitive prompt previews.
- Preferences, revocation, and unavailable delivery are handled without blocking run execution.
- Personal deployments without push continue to expose durable status and results in web/desktop.

## Reference behavior and validation rules

Observable product parity is the target: the same durable agent/run lifecycle,
environment/Build behavior, idle economics, API semantics, entry points,
security controls, collaboration, artifacts, computer use, and self-hosted
choices documented by Cursor as of 19 September 2026. We do not claim access to
or reproduce Cursor's proprietary model, scheduler, or backend implementation.
T3 keeps the intentional differences listed at the top of this plan.

Primary references:

- [Daytona documentation](https://www.daytona.io/docs/)
- [Daytona sandboxes](https://www.daytona.io/docs/sandboxes)
- [Daytona persistence](https://www.daytona.io/docs/en/persistence/)
- [Daytona preview](https://www.daytona.io/docs/en/preview/)
- [Daytona SSH access](https://www.daytona.io/docs/en/ssh-access/)
- [Daytona Git operations](https://www.daytona.io/docs/en/git-operations/)
- [Expo CLI](https://docs.expo.dev/more/expo-cli/)
- [Expo development-build workflows](https://docs.expo.dev/develop/development-builds/development-workflows/)
- [Android hardware-device debugging](https://developer.android.com/studio/run/device)
- [Cloud Agents overview](https://cursor.com/docs/cloud-agent)
- [Capabilities](https://cursor.com/docs/cloud-agent/capabilities)
- [Environment setup](https://cursor.com/docs/cloud-agent/setup)
- [Builds](https://cursor.com/docs/cloud-agent/builds)
- [Security](https://cursor.com/docs/cloud-agent/security)
- [Secrets and network](https://cursor.com/docs/cloud-agent/security-network)
- [Settings](https://cursor.com/docs/cloud-agent/settings)
- [Automations](https://cursor.com/docs/cloud-agent/automations)
- [Self-hosted machines and pools](https://cursor.com/docs/cloud-agent/self-hosted)
- [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)
- [API overview](https://cursor.com/docs/api)

The earlier DCV work remains historical evidence for remote desktop behavior. New
Daytona runs use Daytona VNC and Computer Use where a sandbox desktop is needed;
physical-phone control follows CA-67 instead of a desktop-stream assumption.

Implementation tickets need focused tests for changed backend behavior and
scoped lint/type checks. Reuse real T3 components and wait on receipts/worker
drains rather than test sleeps. Use disposable Daytona sandboxes, test phone
enrollments, and isolated controller state; never run against the live T3
database.

Web and desktop remain supported. CA-20 adds the native Android control surface
needed for the phone-only workflow. iOS control and native push remain deferred
to CA-22 or a later ticket. Shared contract changes must keep every client on an
explicit capability path.

Physical Android verification tests the owner's development build on a real
phone. Metro connectivity is not device-control proof. CA-67 needs explicit
authorization and a real-phone test before T3 advertises agent control. Run
integrated browser/device checks only when authorized during implementation.
Do not run repo-wide checks by default or commit this planning document as
permanent implementation documentation.
