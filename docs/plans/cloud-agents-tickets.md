# Cloud agents for T3 Code: implementation tickets

Revised 19 September 2026. Planning only. Completed tickets preserve the
working T3-specific foundation. Open and new tickets now target product parity
with Cursor Cloud Agents: durable agents and runs, versioned environments and
Builds, isolated runtimes that hibernate when idle, API and integration
surfaces, security controls, artifacts, computer use, and self-hosted pools.
The intentional differences are the existing local-controller option, T3's
worker-owned live thread state, direct app previews alongside shared desktop
control, and the Android/iOS development-worker profiles. No application code,
AWS deployment, app publication, or issue creation is authorized by this
document.

## Agreed scope

The existing local T3 environment serves the web application and coordinates cloud workers first. The local machine must stay online while it is the controller, but web and desktop clients may disconnect without stopping a worker. After that workflow passes end to end, the same controller can move to a permanent EC2 host with stable remote access and no dependency on the local machine.

The completed local-host release proves one workflow with one provider, one
GitHub repository per run, and one worker at a time:

1. Submit a coding task from the web or desktop.
2. Let the worker continue after the initiating client disconnects, while the local T3 controller remains online.
3. Open the frontend inside the thread and interact with it.
4. Observe the agent's actual browser, take control, and return control.
5. Receive a saved diff, test results, and a draft PR.
6. Recover from a disconnect or restart and stop compute without losing acknowledged results.

That release is the migration base, not the end state. The parity program adds
parallel agents, multi-repository environments, agent and run APIs,
integrations, subscriptions, fleet administration, and optional native-mobile
surfaces without discarding the completed path.

Your own mobile app development is a separate requirement. The next committed delivery adds Android emulators and iOS simulators on appropriate workers, with live display and input inside web/desktop threads. This does not depend on building or publishing the T3 mobile client.

## Architecture and efficiency decisions

### Use local T3 first, then add one permanent entry point

The controller serves the UI, authentication, a small worker-allocation catalog, infrastructure operations, and retained-result access. CA-04A runs that controller in the existing local T3 environment so the cloud workflow can be built and used before another always-on server exists. CA-04C packages that controller and its web application in Docker for local use. CA-04B later runs the same image on EC2 with stable DNS, TLS, durable storage, and service auto-start. Repository code executes on workers, not with either controller host's permissions.

CA-01 must prove the smallest extension of T3's existing environment model before fixing a new execution protocol. The starting candidate is an ordinary T3 environment on a worker, reached through existing typed RPC and subscriptions. Reuse its provider adapters, project/thread ownership, event store, terminal, checkpoints, and permissions.

There must be one writable authority for each live thread. The active runtime
owns T3's decider, projector, provider adapter, checkpoint reactor, workspace,
and provider home. The controller owns the durable agent/run catalog,
environment and Build records, placement, consistent snapshots, artifacts, and
publication. It does not run a second live decider/projector. Hibernate first
flushes a consistent restorable snapshot and fences the old writer; wake
creates exactly one new writer.

This remains a single-controller deployment. Multi-controller consensus and
transparent migration of arbitrary in-flight processes are out of scope.
Firecracker-based packing is the managed-runtime target; Kubernetes is
optional only for self-hosted pools.

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

### SSM is not the agent transport

| Mechanism                                             | Responsibility                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| AWS API/SDK                                           | Allocate, inspect, and terminate worker infrastructure.                                           |
| Versioned image and cloud-init/systemd or launchd     | Start the worker's services automatically.                                                        |
| Existing T3 RPC, subscriptions, and provider adapters | Conversation, tool activity, questions, approvals, terminals, and agent control.                  |
| Authenticated HTTP/WebSocket preview route            | Serve a thread's dev application, including HMR and app WebSockets.                               |
| DCV or another validated display transport            | Show and control the actual worker browser/desktop when requested.                                |
| SSM                                                   | Optional diagnostics, provisioning troubleshooting, and recovery when the normal route is broken. |

Normal agent turns must not call SSM Run Command or poll SSM output. A healthy worker should start from its image and register with T3 without an SSM command launching every session. Installing an SSM agent for recovery does not make it a runtime dependency.

### Use the cheapest suitable preview path

Ordinary frontend previews use an authenticated web proxy. Clicking and typing in that preview does not require a streamed desktop. The direct preview has the viewer's browser state; the remote desktop shows the agent's actual browser state. Make that distinction visible.

DCV is the preferred candidate for shared-session viewing and takeover, subject to CA-34. Start or attach streaming only when a visible viewer or an agent task needs it. Hidden threads disconnect or suspend viewers; no background frame decoding for every open thread. Closing the viewer must not kill an agent that still uses the browser.

A minimal base image preinstalls the selected runtime/provider. Environment
Builds install repository dependencies once and snapshot the disk. Warm copies
of active Builds and shared package-download caches are added only after cold
boot, restore, and claim timings are measured.

### Mobile development needs separate worker profiles

| Profile              | Workload                                                        | Allocation policy                                                                              |
| -------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Linux web worker     | Coding, builds, web preview, browser automation                 | Firecracker guest on a packed host; stop/snapshot EC2 fallback during migration.               |
| Linux Android worker | Android SDK, accelerated emulator, native or React Native build | A verified virtualization-capable EC2 type with sufficient memory/storage; allocate on demand. |
| macOS iOS worker     | Xcode, iOS Simulator, Apple-platform builds                     | Compatible EC2 Mac Dedicated Host with bounded queued jobs and a host-level allocation policy. |

The prototype's t3.medium must not be assumed to run an accelerated Android emulator. AWS now supports nested virtualization on selected virtual instance families; CA-37 checks the exact type, region, launch settings, and KVM readiness. [AWS nested virtualization](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html). Android acceleration also depends on the guest image and host architecture. [Android emulator acceleration](https://developer.android.com/studio/run/emulator-acceleration).

iOS Simulator requires macOS and Xcode. Use an appropriate Apple Silicon Mac worker and compatible simulator runtime; it cannot run on the Linux worker. [Apple simulator installation](https://developer.apple.com/documentation/safari-developer-tools/installing-xcode-and-simulators), [Xcode requirements](https://developer.apple.com/xcode/system-requirements).

EC2 Mac bills the Dedicated Host, has a 24-hour minimum allocation, and permits one Mac instance per host. Reuse an allocated Mac for serial, isolated jobs instead of allocating a host per short task. Task cancellation stops the job; it does not imply the host has been released or billing has ended. [EC2 Mac considerations](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html).

Simulator workers do not change the controller's role or require CA-04B. Each profile has explicit capability checks and region selection. If a required Mac or Android type is unavailable in us-west-1, report it and configure a supported region; do not silently provision elsewhere or substitute a web build.

## Existing work to reuse

The reference repo is [Company/cloud-agents](C:/Users/Victor/Desktop/Crypto-Programming/Company/cloud-agents/README.md). Its source provides an OpenTofu EC2 launch template, a local PowerShell orchestrator, SSM execution, temporary Git credentials, and controlled publication. State files, saved plans, secret values, and the live AWS account were not inspected.

| Prototype detail                                                     | Treatment                                                                                                                           |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| us-west-1, Amazon Linux 2023 x86_64, t3.medium, encrypted 30 GiB gp3 | Initial web-worker references, not universal sizing or OS choices. Benchmark the selected workload.                                 |
| Dedicated VPC and public subnet; no worker ingress; outbound TCP 443 | Keep the initial worker boundary. Validate authenticated outbound routes for application and display traffic.                       |
| Existing secret cloud-agent-victor-key                               | Support as a configurable SSH secret reference. Never commit its value or read it during planning.                                  |
| Temporary secrets under /cloud-agents-mvp/jobs/                      | Scope access to a run; the current shared prefix permissions are insufficient for parallel workers.                                 |
| Root-owned SSH agent and controlled Git push                         | Reuse the boundary; repository code must not obtain Git publication credentials.                                                    |
| Local gh login for PR creation                                       | Replace with explicit server-owned GitHub API authentication so the laptop can be offline.                                          |
| Local finally cleanup and 120-minute worker TTL                      | Replace orchestration with cloud-side ownership and cleanup. Keep a bounded web-worker deadline; use a distinct Mac host lifecycle. |
| Local OpenTofu state                                                 | Use encrypted, locked remote state. Do not import state or plan files into source control.                                          |

T3 already has [event-sourced orchestration and checkpoints](C:/Users/Victor/Desktop/Crypto-Programming/Vite/cloud-agents/docs/internals/overview.md), [remote environments](C:/Users/Victor/Desktop/Crypto-Programming/Vite/cloud-agents/docs/internals/remote.md), and [provider adapters](C:/Users/Victor/Desktop/Crypto-Programming/Vite/cloud-agents/docs/internals/providers.md). Cloud placement must respect environment-local project/thread ownership; it is not just another checkout/worktree mode.

[T3 Connect](C:/Users/Victor/Desktop/Crypto-Programming/Vite/cloud-agents/docs/internals/t3-connect.md) is useful reference material but its production identity, tunnels, and native push services are not prerequisites for this personal release. Its relay does not proxy ordinary application traffic.

The repo also has an [iOS simulator streaming workflow](C:/Users/Victor/Desktop/Crypto-Programming/Vite/cloud-agents/.agents/skills/ios-simulator-browser/SKILL.md). Treat it as a starting point to evaluate on a Mac worker, not a production remote-access implementation. Its local stream includes a privileged shell route, so CA-39 must not expose the whole local service through a generic tunnel.

## Delivery order and scope boundaries

Existing ticket IDs and completed statuses are preserved. Open tickets are
rewritten around the parity model. CA-40 onward adds the missing Cursor
surfaces. Order below is intentional; ticket numbering does not indicate
priority.

| Delivery                           | Tickets                                                                                                                                                    | Required result                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Architecture proof                 | CA-01                                                                                                                                                      | Select one provider and prove T3 reuse, ownership, offline execution, and the basic worker route.                    |
| Local-hosted web/desktop release   | CA-02, CA-03, CA-04A, CA-04C, CA-06, CA-07, CA-08, CA-09, CA-10, CA-11, CA-14, CA-15, CA-16, CA-17, CA-18, CA-19, CA-23, CA-24, CA-25, CA-27, CA-34, CA-35 | Run the complete single-worker workflow from the local Docker controller. The controller machine must remain online. |
| Agent/runtime foundation           | CA-40, CA-41, CA-42, CA-59, CA-43, CA-44, CA-45, CA-46                                                                                                     | Split agents/runs from runtimes, create environments with Cursor's setup skills, then pack and hibernate guests.     |
| Permanent controller deployment    | CA-04B                                                                                                                                                     | Move the controller and new catalogs to an always-on host with safe single-writer cutover.                           |
| Review and operations improvements | CA-05, CA-12, CA-13, CA-21, CA-33, CA-36                                                                                                                   | Administer environments, Builds, retained agents, review, and preview restore.                                       |
| Product/API parity                 | CA-47, CA-48, CA-49, CA-50, CA-51, CA-52, CA-53, CA-54, CA-55, CA-56, CA-57, CA-58                                                                         | Match Cursor's API, integrations, collaboration, security, automation, diagnostics, and self-hosted runtime choices. |
| Mobile development workers         | CA-37, CA-38, CA-39                                                                                                                                        | Build, boot, view, control, and test your Android/iOS app from web/desktop; no T3 native-app publication.            |
| Existing product expansion         | CA-26, CA-28, CA-29, CA-30, CA-31, CA-32                                                                                                                   | Align handoff, triggers, durable assistants, providers, and private dependencies with the new agent model.           |
| Deferred native T3 app work        | CA-20, CA-22                                                                                                                                               | Add native T3 iOS/Android client and push integration only when you choose to maintain and distribute those builds.  |

### Dependency-safe implementation waves

The delivery table above groups product outcomes. The table below is the
implementation order for the unfinished tickets. Every dependency for a wave
is completed in an earlier wave. Tickets in the same row may run in parallel
because their primary ownership areas do not overlap. Later waves may be
logically ready sooner, but they stay separate to avoid competing changes to
the agent model, public contracts, server composition, preview state, or the
same client screens.

| Wave | Tickets that may run in parallel | Primary ownership boundary                                                                 |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| 1    | CA-40                            | Durable agent, run, and runtime model.                                                     |
| 2    | CA-41                            | Environment model and config resolution.                                                   |
| 3    | CA-04B, CA-48                    | Controller deployment and host cutover; artifact, computer-use, and desktop-viewing paths. |
| 4    | CA-42                            | Build records, preparation, and activation.                                                |
| 5    | CA-43                            | Runtime snapshot, hibernate, and wake lifecycle.                                           |
| 6    | CA-31, CA-38, CA-46              | Provider adapters; macOS worker infrastructure; retention and deletion services.           |
| 7    | CA-44                            | Linux fleet and Firecracker runtime infrastructure.                                        |
| 8    | CA-21, CA-45                     | Retained-results review UI; fleet capacity and Build pre-warming.                          |
| 9    | CA-05, CA-37, CA-47              | AWS settings UI; Android worker profile; public Cloud Agents API.                          |
| 10   | CA-49                            | Shared secret, identity, encryption, and network policy.                                   |
| 11   | CA-12, CA-13, CA-26              | Environment recipes; event-stream performance; local/cloud handoff.                        |
| 12   | CA-36, CA-51, CA-55              | Preview leases; provider extensibility; usage and audit accounting.                        |
| 13   | CA-32, CA-50                     | Private dependency networking; source-control and collaboration entry points.              |
| 14   | CA-20, CA-56, CA-58              | Native T3 mobile controls; multi-repository environments; self-hosted pools.               |
| 15   | CA-28, CA-39, CA-57, CA-59       | Scheduling; simulator display; commit signing; repository-owned environment setup.         |
| 16   | CA-29, CA-30, CA-33              | GitHub triggers; persistent assistants; remote administration UI.                          |
| 17   | CA-52                            | Subscription wake and CI autofix.                                                          |
| 18   | CA-22, CA-53                     | Native push; generalized automations.                                                      |
| 19   | CA-54                            | Outbound webhooks and typed SDKs.                                                          |

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

Mobile development is committed follow-on scope, not dependent on the optional product expansion or deferred native T3 app work. Run platform feasibility checks early before spending time on simulator UI. Android and iOS can be implemented independently; CA-39 passes separately for each and both must pass before claiming support for both platforms.

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

## Cursor-parity product, API, and security

### CA-47: Expose the Cloud Agents API and event stream

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

## Mobile development workers

These tickets concern the mobile apps you develop. They do not require modifying or publishing the native T3 control app.

### CA-37: Build and launch Android apps in accelerated emulator workers

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

Description: Add reusable assistant roles on top of durable agents rather than
creating a third persistence model.

Acceptance criteria:

- Each assistant has explicit instructions, provider, tools, repositories, secret access, and persistence policy.
- Memory is inspectable, editable, and deletable; consequential facts can be traced to source context.
- Persistent files/browser state are opt-in, encrypted, and not silently shared between assistants.
- `IDLE`, archive/unarchive, reset, and delete define their effects on runs,
  subscriptions, credentials, and retained snapshots.
- Each writable workspace has one owner and all runs retain the ordinary limits and history.

### CA-31: Qualify additional providers

Dependencies: CA-01, CA-07, CA-11, CA-15, CA-23, CA-40, CA-43.

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

### CA-32: Add private dependencies and company-network profiles

Dependencies: CA-03, CA-06, CA-07, CA-12, CA-18, CA-41, CA-42, CA-49.

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

## Deferred native T3 app work

These are lowest-priority optional tickets. They are not prerequisites for any web, desktop, Android-worker, or iOS-worker ticket. No native app publication is included in the current implementation scope.

### CA-20: Add cloud controls to the native T3 mobile client

Dependencies: CA-19, CA-21, CA-25, CA-34, CA-35, CA-36, CA-40, CA-47.

Description: Match Cursor's mobile agent-management surface when the owner
chooses to distribute a compatible T3 iOS app. Android may remain an installable
responsive PWA until a native build is intentionally supported.

Acceptance criteria:

- iOS exposes create, plan/agent mode, follow-up, questions, approval, cancel,
  run status, PR review, artifacts, and remote desktop through shared runtime
  logic. Android PWA covers the supported subset.
- Backgrounding the app does not affect worker execution; reconnect targets the correct environment/thread.
- Live Activities show a bounded number of active agents and deep-link to the
  correct run without leaking prompt or secret content.
- Preview and takeover work through separately verified WebViews/native embedding rather than assuming browser support is sufficient.
- Native distribution, signing, and store access are explicit prerequisites for this optional delivery.
- Until this ticket is selected, responsive web remains the supported phone/tablet route and existing native clients retain compatibility through capability checks.

### CA-22: Add native push and mobile activity integration

Dependencies: CA-20, CA-21, CA-40, CA-52.

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

DCV supports embedded interactive display, while its SDK release notes include mobile-browser support. Those capabilities still need validation for the chosen worker OS, image, tunnel, and client. [DCV SDK](https://docs.aws.amazon.com/dcv/latest/websdkguide/what-is.html), [SDK release notes](https://docs.aws.amazon.com/dcv/latest/websdkguide/doc-history-release-notes.html).

Implementation tickets need focused tests for changed backend behavior and scoped lint/type checks. Reuse real T3 components and wait on receipts/worker drains rather than test sleeps. Use disposable state and authorized isolated AWS resources; never run against the live T3 database.

Web and desktop are the active client targets. Preserve native T3 mobile compatibility at shared contract boundaries, but native UI changes, app-store publication, native push, and full T3 mobile verification are deferred to CA-20/CA-22. This explicit scope takes precedence over generic instructions to build every new UI on every client.

Android/iOS worker verification tests the owner's application inside the remote device. It must prove actual native build, launch, display, input, and cleanup. It is not a substitute for, or dependency on, native T3 app delivery. Run integrated browser/device checks only when authorized during implementation. Do not run repo-wide checks by default or commit this planning document as permanent implementation documentation.
