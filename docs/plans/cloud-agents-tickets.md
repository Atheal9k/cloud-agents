# Cloud agents for T3 Code: implementation tickets

Revised 17 September 2026. Planning only. This revision makes the existing local T3 environment the first controller host, adds Docker packaging for local and permanent controller hosting, moves permanent hosting behind a proven local workflow, defers the native T3 mobile app, and includes Android emulator and iOS Simulator workers. No application code, AWS deployment, app publication, or issue creation is authorized by this document.

## Agreed scope

The existing local T3 environment serves the web application and coordinates cloud workers first. The local machine must stay online while it is the controller, but web and desktop clients may disconnect without stopping a worker. After that workflow passes end to end, the same controller can move to a permanent EC2 host with stable remote access and no dependency on the local machine.

The first usable local-host release proves one complete workflow with one provider, one GitHub repository per run, and one worker at a time:

1. Submit a coding task from the web or desktop.
2. Let the worker continue after the initiating client disconnects, while the local T3 controller remains online.
3. Open the frontend inside the thread and interact with it.
4. Observe the agent's actual browser, take control, and return control.
5. Receive a saved diff, test results, and a draft PR.
6. Recover from a disconnect or restart and stop compute without losing acknowledged results.

Start with one configured repository and provider account. Additional repositories can use the same configuration format later; repository discovery, settings wizards, a six-provider qualification program, rich fleet administration, schedules, persistent assistants, and native T3 mobile changes are not first-release gates.

Your own mobile app development is a separate requirement. The next committed delivery adds Android emulators and iOS simulators on appropriate workers, with live display and input inside web/desktop threads. This does not depend on building or publishing the T3 mobile client.

## Architecture and efficiency decisions

### Use local T3 first, then add one permanent entry point

The controller serves the UI, authentication, a small worker-allocation catalog, infrastructure operations, and retained-result access. CA-04A runs that controller in the existing local T3 environment so the cloud workflow can be built and used before another always-on server exists. CA-04C packages that controller and its web application in Docker for local use. CA-04B later runs the same image on EC2 with stable DNS, TLS, durable storage, and service auto-start. Repository code executes on workers, not with either controller host's permissions.

CA-01 must prove the smallest extension of T3's existing environment model before fixing a new execution protocol. The starting candidate is an ordinary T3 environment on a worker, reached through existing typed RPC and subscriptions. Reuse its provider adapters, project/thread ownership, event store, terminal, checkpoints, and permissions.

There must be one writable authority for each thread. If the worker is that authority, the active controller host stores allocation records, explicit environment/thread references, and consistent archives. It does not maintain a second live orchestration event log or duplicate the worker's decider/projector. A saved archive is a recovery/read-only artifact, not another active writer. Moving from the local controller to EC2 requires a deliberate cutover with only one writable controller. If a smaller execution bridge is demonstrably preferable, CA-01 must show how it preserves those ownership boundaries before adopting it.

This is a personal single-controller deployment. Multi-controller consensus, a new general-purpose scheduler framework, Kubernetes, and transparent migration of arbitrary running processes are outside the initial scope.

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

A minimal image preinstalls the selected runtime/provider. Add a bounded dependency cache before the first release. Measure cold startup before adding warm pools. No warm Linux fleet is required initially.

### Mobile development needs separate worker profiles

| Profile              | Workload                                                        | Allocation policy                                                                              |
| -------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Linux web worker     | Coding, builds, web preview, browser automation                 | Disposable EC2 worker; default concurrency one.                                                |
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

Existing ticket IDs are preserved except CA-04, which is split into CA-04A and CA-04B. CA-04C adds Docker deployment before CA-06; CA-37 to CA-39 add mobile workers. Order below is intentional; ticket numbering does not indicate priority.

| Delivery                           | Tickets                                                                                                                                                    | Required result                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Architecture proof                 | CA-01                                                                                                                                                      | Select one provider and prove T3 reuse, ownership, offline execution, and the basic worker route.                                   |
| Local-hosted web/desktop release   | CA-02, CA-03, CA-04A, CA-04C, CA-06, CA-07, CA-08, CA-09, CA-10, CA-11, CA-14, CA-15, CA-16, CA-17, CA-18, CA-19, CA-23, CA-24, CA-25, CA-27, CA-34, CA-35 | Run the complete single-worker workflow from the local Docker controller. The controller machine must remain online.                |
| Permanent controller deployment    | CA-04B                                                                                                                                                     | Move the proven controller to an always-on EC2 host with stable access, safe state cutover, and no dependency on the local machine. |
| Review and operations improvements | CA-05, CA-12, CA-13, CA-21, CA-33, CA-36                                                                                                                   | Add richer setup, history, review retention/reopen, and remote administration without expanding provider scope.                     |
| Mobile development workers         | CA-37, CA-38, CA-39                                                                                                                                        | Build, boot, view, control, and test your Android/iOS app from web/desktop; no T3 native-app publication.                           |
| Optional product expansion         | CA-26, CA-28, CA-29, CA-30, CA-31, CA-32                                                                                                                   | Add handoff, automation, assistants, additional providers, and private-network/dependency support.                                  |
| Deferred native T3 app work        | CA-20, CA-22                                                                                                                                               | Add native T3 iOS/Android client and push integration only when you choose to maintain and distribute those builds.                 |

Mobile development is committed follow-on scope, not dependent on the optional product expansion or deferred native T3 app work. Run platform feasibility checks early before spending time on simulator UI. Android and iOS can be implemented independently; CA-39 passes separately for each and both must pass before claiming support for both platforms.

The first release must not inherit deferred requirements through dependencies. In particular, it does not require repository discovery, full settings wizards, every provider, native T3 mobile testing/publication, push notification credentials, warm pools, complete historical conversation migration, or transparent live-process resume.

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

Description: Replace the local orchestrator with a small durable allocation queue. First-release concurrency is one worker.

Acceptance criteria:

- Accepted jobs survive controller restart, with a bounded queue and one active allocation lease.
- AWS client tokens and tags identify run attempts; a lost launch response cannot produce duplicate instances on retry.
- Boot/service-registration deadlines are distinct from agent runtime deadlines and have actionable failure states.
- Cancelling before launch creates nothing; cancelling during launch still discovers and cleans up a late-created instance.
- AWS quota/capacity errors use bounded retries. Multi-controller coordination and parallel fleet scheduling are deferred.

### CA-09: Route normal T3 traffic to the worker

Dependencies: CA-02, CA-04A, CA-07, CA-08.

Description: Extend existing environment discovery/connection paths with an authenticated outbound worker route. Keep normal execution in T3's typed RPC and provider runtime.

Acceptance criteria:

- Workers register with short-lived attempt-bound credentials over an approved route. No public worker ingress is needed. Local hosting may use one explicitly configured authenticated ingress or controller-managed tunnel, but it must not require manual forwarding for each worker.
- Existing T3 subscriptions carry conversation/tool events, approvals, terminals, and control; no SSM command-output polling participates in the interaction.
- Reconnect preserves environment identity and uses existing T3 snapshot/subscription behavior. The controller does not become a second writable thread event store.
- Revoked and obsolete workers cannot reconnect as the current attempt. Routing never interprets a controller, worker, or browser localhost endpoint as belonging to a different machine.
- A healthy session continues if SSM is unavailable. Do not change the T3 Connect relay into an application proxy or require access to its production services.

### CA-10: Prepare one repository and a trusted setup recipe

Dependencies: CA-06, CA-07, CA-08.

Description: Make the first configured repository reproducible without building a repository-management product. Start with explicit setup, app-start, and verification commands.

Acceptance criteria:

- Resolve the selected ref to a commit and create an isolated checkout and unique output branch, recording both on the run.
- A small validated configuration describes mandatory setup, dev-server ports/commands, verification commands, and permitted secret references. Mandatory setup finishes before the agent starts.
- Repository instructions are available. Local credentials, ignored files, and uncommitted work are not silently uploaded.
- Setup and validation retain exit codes/logs and have deadlines. Missing dependencies fail during preparation with an actionable message.
- Task-controlled Git remotes/config cannot change the trusted publication target. Advanced recipe editing, multi-repository discovery, and private submodules are deferred.

### CA-11: Execute the selected provider through T3

Dependencies: CA-01, CA-07, CA-09, CA-10.

Description: Run real multi-turn work through the existing provider adapter, rather than an arbitrary shell command masquerading as an agent session.

Acceptance criteria:

- Prompt, selected model, permissions, and supported attachments start the selected provider using its ordinary T3 session operations.
- Existing normalized messages, tools, questions, approvals, and usage information render without introducing another provider event format.
- Closing all clients does not suspend the run or its completion work.
- Authentication, model availability, and quota failures are distinct. Other providers cannot be selected for cloud execution until qualified.
- Interrupt and follow-up work on the live worker. Native resume is used only when supported; filesystem recovery must not be described as native conversation resume.

### CA-14: Retain results and support explicit recovery

Dependencies: CA-02, CA-04A, CA-10, CA-11.

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

Description: Reuse ordinary T3 controls on the cloud session, with explicit lifecycle behavior when the worker has gone away.

Acceptance criteria:

- A second web/desktop client can send follow-up input, answer questions, and approve or deny supported requests.
- Permission policy is selected before launch. A disconnected owner does not imply approval; unanswered requests have a bounded wait.
- Idempotent cancel stops owned processes, saves available results, and schedules cleanup.
- Retry names a new attempt and its starting point. Uncertain publication is reconciled rather than blindly replayed.
- Terminated sessions offer saved results and explicit continuation. Transparent live-process handoff and sophisticated pause/hibernate behavior are deferred.

### CA-16: Publish a branch and draft PR

Dependencies: CA-06, CA-10, CA-11, CA-14, CA-15.

Description: Complete the first launch-to-PR workflow with a trusted publication step owned by the controller rather than the initiating client.

Acceptance criteria:

- Launch selects review-only or automatic branch plus draft PR publication. No automatic merge is included.
- Validate repository, base, and branch against recorded intent. Privileged Git operations do not run task-controlled hooks or credential configuration.
- Persist test outcomes and distinguish empty change, failed verification, rejected push, and failed PR creation.
- Finalization retries inspect the existing branch and PR first. Remote divergence does not trigger an implicit force push.
- Link the PR and saved diff to the run. Publication succeeds after the initiating UI disconnects as long as the active controller stays online; a publication failure does not erase the work.

### CA-17: Clean up workers independently of clients

Dependencies: CA-03, CA-04A, CA-08, CA-14, CA-15.

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

Description: Keep the personal release bounded without building a billing dashboard.

Acceptance criteria:

- Configure one-worker concurrency, queue length, run/input-wait duration, preview grace period, and allowed instance sizes. Admission rejects invalid requests before allocating compute.
- Show elapsed worker time, shape, deadlines, and a cost estimate with stated assumptions. Unknown provider usage remains unknown.
- Distinguish controller-host costs, worker time, storage, model use, and streaming transfer. A local controller has no attributed EC2 host charge. Billing alerts are not represented as an exact live spending cap.
- Correlate run, attempt, worker, provider, and cleanup diagnostics without routinely logging credentials or complete prompts.
- A stop-admission control leaves running jobs, saved results, and cleanup manageable. Expanded budgets and fleet charts are deferred.

### CA-19: Add cloud launch and control to web and desktop

Dependencies: CA-02, CA-04A, CA-10, CA-15, CA-18.

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

Description: Validate Amazon DCV and embed a view of the agent's actual worker browser/desktop. Reuse a tested simpler transport if DCV cannot satisfy the selected platform.

Acceptance criteria:

- Prove browser automation and the streamed view target the same browser/session. Each thread is isolated.
- Validate image/OS support, certificates, authentication, WebSocket routing, and reconnect through the approved external HTTPS route without public worker ingress.
- The viewer embeds in web and desktop. Verify the selected browser matrix and document phone-browser limitations; native T3 mobile WebViews are deferred.
- Stream only for visible viewers or an explicitly required agent workflow. Hidden/disconnected viewers stop decoding/receiving frames, while an active agent browser is allowed to keep running.
- Session access is short-lived and attempt-bound. Replacing a worker invalidates old viewer access.
- Measure CPU, memory, latency, and transfer during build-plus-streaming load before sizing. Validate SDK distribution terms.
- DCV is not required for the direct app preview. A full desktop is not started just because a thread exists.

### CA-35: Enforce human/agent input handoff

Dependencies: CA-15, CA-34.

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

Description: Provide the minimum instructions needed to install, use, recover, and disable the proven workflow.

Acceptance criteria:

- Document local-controller startup, its stay-online requirement, protected initial configuration, selected provider authentication, GitHub access, desktop setup, and the first run.
- Explain direct app preview versus shared-browser control, review timeout, saved results, cancellation, retry, and explicit recovery.
- Include backup/restore, image rollback, credential rotation, stuck-worker cleanup, and teardown with retained-data behavior.
- The release is opt-in and capability-gated. Disabling admission leaves active jobs and results manageable.
- State the supported provider/repository configuration and web/desktop scope; no claim of native T3 mobile or simulator support until the corresponding tickets pass.

## Permanent controller deployment

### CA-04B: Move the proven controller to a permanent T3 host

Dependencies: CA-03, CA-04A, CA-04C, CA-23, CA-24.

Description: Move the controller proven by CA-23 to one always-on EC2 instance using the versioned Docker image and persistent state layout from CA-04C. Keep the local and permanent modes on the same T3 code path.

Acceptance criteria:

- Stable DNS, TLS renewal, service auto-start, and durable T3 identity survive a host reboot. Web and desktop connect to the same host without baked localhost origins.
- A documented cutover stops admission on the local controller, drains or explicitly terminates active work, takes a consistent backup, restores the required controller state, and starts the EC2 controller with only one writable authority. Arbitrary live processes do not migrate.
- Initial repository, provider, AWS, and GitHub settings use protected server configuration and existing remote setup paths. No settings wizard or native app is required.
- Supported provider authentication completes through a validated device-code, remote callback, or explicit protected credential-entry flow. The permanent host never treats its own localhost callback as the viewer's localhost.
- Responsive web access works from another network with the original computer off. The deployment does not require T3's production Clerk, relay, push credentials, or app-store publication.
- A consistent backup/restore and single-host outage procedure are demonstrated. HA, controller replication, and a full admin dashboard remain deferred.
- The local-controller mode remains supported for development and fallback. Switching back also requires an explicit single-writer cutover.

## Review and operations improvements

### CA-05: Add a guided AWS readiness/settings screen

Dependencies: CA-03, CA-04B, CA-19, CA-24.

Description: Replace manual deployment configuration with a useful remote settings workflow after the first run is proven.

Acceptance criteria:

- Show account, region, deployment, image/version, and health without exposing credentials.
- Validate required AWS permissions, image availability, artifact access, and normal worker registration. Diagnose optional SSM recovery separately.
- Settings remain environment-scoped and do not fall back to another server.
- Disconnect stops admission while preserving cleanup and result access; reconnect finds the same catalog.
- Browsers hold only application access credentials, never AWS provisioning keys.

### CA-12: Add reusable repository recipes and secret management

Dependencies: CA-10, CA-19, CA-24.

Description: Extend the first fixed recipe into versioned per-project setup, validation, environment, and secret configuration.

Acceptance criteria:

- New runs record an immutable effective recipe; editing a recipe does not alter a running task.
- Reuse t3.json conventions where appropriate, with explicit synchronous prerequisites before agent startup.
- Protected remote settings accept secret values; events/logs redact known values and retain only references.
- Task-visible application secrets are distinguished from protected infrastructure and Git publication credentials.
- Multiple runtime/port configurations have validation and bounded setup output. Private registries remain CA-32.

### CA-13: Improve large-history reconnect and streaming performance

Dependencies: CA-09, CA-11, CA-19, CA-24.

Description: Measure and improve existing T3 subscriptions for noisy tools and slow clients. Do not introduce a second durable event pipeline merely to support cloud runs.

Acceptance criteria:

- Reconnect recovers from the authoritative environment using existing cursors/snapshots without duplicate messages.
- Lists receive bounded summaries and histories/logs load on demand.
- Slow viewers and large output have bounded buffers/backpressure; SSM output limits do not affect the transcript.
- Stress tests measure data transferred and resource use before and after changes.
- No full-history mirroring to controller orchestration state is added.

### CA-21: Integrate retained results into the full review UI

Dependencies: CA-14, CA-16, CA-19, CA-24.

Description: Expand the basic saved-result page into thread/history/diff review after workers terminate.

Acceptance criteria:

- Web and desktop can inspect transcript, changed files, validation, artifacts, and PR without allocating compute.
- A retained view shows revision/time and does not imply a live terminal or filesystem.
- Binary/oversized diffs, missing artifacts, and expiry are explicit.
- Downloads remain authorized and untrusted HTML cannot execute with T3 application privileges.
- Archive/unarchive, retention deletion, and cancellation are distinct; deleting saved data does not silently delete a PR.

### CA-33: Expand remote administration beyond the first workflow

Dependencies: CA-05, CA-12, CA-18, CA-19, CA-24.

Description: Add richer repository, recipe, provider-account, and worker operations to the web/desktop settings. Basic remote control already ships in CA-04A, CA-04B, and CA-19.

Acceptance criteria:

- Manage configured repositories, recipes, accounts, secret references, limits, and worker diagnostics without the original computer.
- Provider reauthentication uses supported remote flows and never sends the viewer to an unreachable EC2 loopback listener.
- Supported update/restart and cleanup operations display progress, reconnect, and preserve durable identity.
- Device enrollment/revocation works through application authorization; no unrestricted controller shell is exposed to task code.
- Responsive web provides remote administration from another network. Native T3 mobile screens are not required.

### CA-36: Add bounded preview retention and reopen

Dependencies: CA-14, CA-17, CA-18, CA-21, CA-25, CA-34, CA-35.

Description: Extend the first fixed review grace period into explicit preview leases and preview-only recovery.

Acceptance criteria:

- Agent completion, live app availability, and worker cleanup remain separate states.
- A visible lease allows bounded extension and explicit stop. Viewer heartbeats alone cannot keep compute alive indefinitely.
- Expiry saves eligible work and evidence, releases input ownership, revokes routes, and cleans up.
- Reopen restores the saved revision and app on a new worker without starting another provider turn; retries deduplicate and obey admission limits.
- Browser login restoration requires an explicit persistence policy; a fresh session is described honestly.
- Human filesystem edits appear in a new checkpoint/diff without silently rewriting a previously published PR.

## Mobile development workers

These tickets concern the mobile apps you develop. They do not require modifying or publishing the native T3 control app.

### CA-37: Build and launch Android apps in accelerated emulator workers

Dependencies: CA-02, CA-03, CA-07, CA-08, CA-10, CA-14, CA-17, CA-18, CA-27.

Description: Add an Android worker profile that boots an emulator, builds the selected repository's app, installs it, and makes its session available for testing and live control.

Acceptance criteria:

- Validate the selected EC2 region/type, nested-virtualization launch option, Linux KVM access, and emulator acceleration on the actual instance. The web worker's t3.medium is not assumed suitable; reject unsupported configurations before running a costly build.
- Bake compatible JDK, Android SDK/build tools, platform tools, emulator, and a pinned AVD system image into a separate image. Select SDK/API/architecture from project requirements and validate installed package ABI.
- Boot an explicitly owned AVD/serial, wait for device readiness, build a debug/development app, install, and launch it. Expose build progress, logcat, failure diagnostics, and an explicit restart/reset.
- Give each job its own writable emulator data, ports, and app state. Agent testing commands target its exact serial; ADB/gRPC/control endpoints are not public.
- For React Native/Expo projects, configure Metro and emulator connectivity within the worker and rebuild native clients when native inputs change. Expo Go alone is not proof of arbitrary native-module support.
- UI tests or semantic interaction tools can inspect/tap/type in the running app; capture screenshots/video as run artifacts. An interactive human stream is supplied by CA-39.
- Stop only owned emulator/build/app processes, save configured artifacts, and clean the workspace between runs. An emulator crash or failed build leaves an actionable result and no unbounded worker.

### CA-38: Build and launch iOS apps on EC2 Mac workers

Dependencies: CA-02, CA-03, CA-04A, CA-06, CA-08, CA-10, CA-14, CA-17, CA-18, CA-27.

Description: Add a macOS worker profile for native iOS/iPadOS builds and Simulator execution. Keep controller hosting separate from the Mac worker and give the Mac its own host allocation policy.

Acceptance criteria:

- Validate Mac capacity, region, dedicated-host quota, compatible Apple Silicon hardware, macOS, Xcode, simulator runtime, and repository dependencies before admission.
- Provision a versioned Mac environment with the selected provider/T3 runtime and required Xcode/SDK tools. Complete license acceptance and first-launch setup through a documented authorized image-build process.
- Reserve an exact simulator UDID per job, boot it, build for the simulator, install, and launch the app. Retain xcodebuild/test results, simulator logs, screenshots, and video. Native simulator artifacts must match the selected architecture.
- Support the repository's actual build workflow, including native Swift or React Native/Expo with Metro where required. Use the correct native development build after native dependency changes.
- Simulator builds use simulator-compatible signing settings. Device distribution certificates and App Store upload credentials are not required for basic simulator testing; signing/distribution remains separate unless a project explicitly needs it.
- Default to one active job per Mac worker, with isolated checkout, simulator data, credentials, and targeted process cleanup. Reuse the allocated host for queued jobs only after the previous job is cleaned.
- Record dedicated-host allocation time, earliest release time, availability/scrubbing state, and continuing host cost separately from job runtime. Cancelling a two-hour job must not claim that the 24-hour host allocation or charges ended.
- Stop new jobs when release is requested, finish/cancel active work according to policy, and retry host release when eligible. Never apply the disposable Linux worker shutdown policy blindly to the Mac host.
- The provider, simulator, and display route function without a local Mac or the initiating laptop online. Where a desktop session/login is needed, provision and validate it explicitly.

### CA-39: Embed live simulator display and control in each thread

Dependencies: CA-19, CA-25, CA-34, CA-35, CA-37, CA-38.

Description: Extend the thread preview to Android emulator and iOS Simulator sessions. The user can watch the app the agent is testing and take control from web or desktop.

Acceptance criteria:

- The thread selects app web preview, Android device, or iOS device according to its worker profile. Device name, runtime, serial/UDID, build revision, and connection state identify the actual session.
- Stream the exact emulator/simulator targeted by agent tools. Verify changing frames, real taps/clicks, text input, scrolling/swipes, rotation, and supported device buttons; a loaded wrapper or static screenshot does not pass.
- Validate a transport per platform. Reuse CA-34 when appropriate; evaluate a simulator-specific feed such as the repo's serve-sim workflow for iOS. Linux DCV behavior must not be assumed to work unchanged on macOS.
- Keep display/control endpoints local to the worker and expose only authorized capabilities through the thread route. Do not forward a simulator service's general shell endpoint, public ADB, arbitrary filesystem access, or unrelated desktop sessions.
- Reuse the human/agent input lease from CA-35. Agent automation targets exact devices through supported tools; delayed human input cannot reach a different job.
- Stream on demand, suspend hidden viewers, and make build/device startup independent of whether someone is watching. Recordings are explicit bounded artifacts.
- Android and iOS each pass a full build-install-launch-test-takeover-return-cleanup scenario after the initiating client disconnects. Under CA-04A the local controller machine stays online; under CA-04B the original computer may be off. A browser-rendered mobile website does not satisfy native-app testing.
- Run Android/iOS implementation independently as capacity allows. Report each platform's verified status separately; do not label both supported when only one passes.
- Existing T3 native mobile app navigation, stores, push services, and publication are not involved.

## Optional product expansion

### CA-26: Hand work between local and cloud environments

Dependencies: CA-10, CA-14, CA-15, CA-16, CA-21.

Description: Transfer selected local changes to a worker and bring cloud changes into a new local worktree.

Acceptance criteria:

- Show base, destination, selected changes, and excluded files before transfer; never upload credentials/ignored files implicitly.
- Import results without overwriting dirty local files, with explicit conflict handling.
- Keep source/destination threads linked under their own environment identities.
- Transfer provider history only when supported; otherwise seed a clearly described continuation.
- Retry an interrupted transfer without duplicate patch application.

### CA-28: Add API-triggered and scheduled runs

Dependencies: CA-02, CA-08, CA-12, CA-17, CA-18, CA-24.

Description: Run recurring work through the same admission and execution path as interactive tasks.

Acceptance criteria:

- Scoped authenticated APIs support idempotent launch, status, input, and cancel without exposing arbitrary infrastructure operations.
- Schedules record timezone, prompt, ref policy, recipe, provider, publication, and limits.
- Define daylight-saving, overlap, missed-run, and restart behavior.
- Pause/resume/edit/delete actions are available remotely; retries remain bounded.
- Durable web/desktop activity records notify of meaningful outcomes. Native push is optional and not a dependency.

### CA-29: Trigger work from GitHub and address feedback

Dependencies: CA-06, CA-15, CA-16, CA-18, CA-28.

Description: Add opted-in issue/PR triggers and bounded repair of review feedback or failing checks.

Acceptance criteria:

- Validate webhook signatures, delivery IDs, repositories, and authorized trigger actors.
- Retain source issue/comment/PR and base revision; task text cannot widen credentials or permissions.
- Follow-up targets the correct branch head and avoids duplicate delivery or agent-comment loops.
- Bound attempts, time, and compute; report unresolved failures.
- Disable/revoke controls stop new triggers. Automatic merge is separate.

### CA-30: Add persistent assistants

Dependencies: CA-14, CA-15, CA-18, CA-25, CA-28, CA-36.

Description: Add reusable assistant roles and inspectable saved context after the coding and mobile workflows are stable.

Acceptance criteria:

- Each assistant has explicit instructions, provider, tools, repositories, secret access, and persistence policy.
- Memory is inspectable, editable, and deletable; consequential facts can be traced to source context.
- Persistent files/browser state are opt-in, encrypted, and not silently shared between assistants.
- Sleep/wake/reset/delete define their effects on runs, schedules, credentials, and retained state.
- Each writable workspace has one owner and all runs retain the ordinary limits and history.

### CA-31: Qualify additional providers

Dependencies: CA-01, CA-07, CA-11, CA-15, CA-23.

Description: Enable remaining providers individually after the first selected provider works reliably.

Acceptance criteria:

- Codex, Claude, Cursor, Grok, OpenCode, and Antigravity each receive an enabled, unsupported, or blocked status with evidence.
- Every enabled provider passes remote login, execution, streaming, interruption, follow-up, auth/quota failure, and cleanup checks on its advertised worker OS.
- Resume, rollback, model switching, and computer-use capabilities reflect actual adapter support.
- Accounts/instances cannot share mutable credentials or sessions accidentally.
- Unsupported options are rejected before allocation and switching provider does not pretend native history transferred.

### CA-32: Add private dependencies and company-network profiles

Dependencies: CA-03, CA-06, CA-07, CA-10, CA-12, CA-18.

Description: Support private submodules, packages, and restricted network egress when required by additional repositories.

Acceptance criteria:

- Explicitly configure and check private submodule, LFS, and package-registry access.
- Expose only required dependency credentials to setup/task code; retain the protected publication and infrastructure boundary.
- Exclude credentials from logs, caches, commits, and exported workspace state.
- An optional stable-egress profile supports organization IP restrictions, with its cost and networking changes visible.
- Report the failing dependency/destination and support disabling the profile without stranding runs.

## Deferred native T3 app work

These are lowest-priority optional tickets. They are not prerequisites for any web, desktop, Android-worker, or iOS-worker ticket. No native app publication is included in the current implementation scope.

### CA-20: Add cloud controls to the native T3 mobile client

Dependencies: CA-19, CA-21, CA-25, CA-34, CA-35, CA-36.

Description: Port the proven web/desktop experience into T3's React Native client only when the owner chooses to maintain and distribute a compatible mobile build.

Acceptance criteria:

- iOS/Android native navigation exposes launch, follow-up, questions, approval, cancel, retry, and review through shared client-runtime logic.
- Backgrounding the app does not affect worker execution; reconnect targets the correct environment/thread.
- Preview and takeover work through separately verified WebViews/native embedding rather than assuming browser support is sufficient.
- Native distribution, signing, and store access are explicit prerequisites for this optional delivery.
- Until this ticket is selected, responsive web remains the supported phone/tablet route and existing native clients retain compatibility through capability checks.

### CA-22: Add native push and mobile activity integration

Dependencies: CA-20, CA-21.

Description: Extend T3's native notification infrastructure when a distributable personal mobile client exists. Core web/desktop status does not depend on it.

Acceptance criteria:

- Required APNs/FCM, app identifiers, device registration, and service ownership are explicitly configured.
- Completion, failure, approval, and input notifications deduplicate across reconnects and attempts.
- Notifications open the correct live/retained run and exclude secret values or sensitive prompt previews.
- Preferences, revocation, and unavailable delivery are handled without blocking run execution.
- Personal deployments without push continue to expose durable status and results in web/desktop.

## Reference behavior and validation rules

Cursor's cloud workflows inform the task-to-PR experience, saved setup, and takeover goals; this plan does not promise identical model quality or performance. [Cursor capabilities](https://cursor.com/docs/cloud-agent/capabilities), [environment setup](https://cursor.com/docs/cloud-agent/setup).

DCV supports embedded interactive display, while its SDK release notes include mobile-browser support. Those capabilities still need validation for the chosen worker OS, image, tunnel, and client. [DCV SDK](https://docs.aws.amazon.com/dcv/latest/websdkguide/what-is.html), [SDK release notes](https://docs.aws.amazon.com/dcv/latest/websdkguide/doc-history-release-notes.html).

Implementation tickets need focused tests for changed backend behavior and scoped lint/type checks. Reuse real T3 components and wait on receipts/worker drains rather than test sleeps. Use disposable state and authorized isolated AWS resources; never run against the live T3 database.

Web and desktop are the active client targets. Preserve native T3 mobile compatibility at shared contract boundaries, but native UI changes, app-store publication, native push, and full T3 mobile verification are deferred to CA-20/CA-22. This explicit scope takes precedence over generic instructions to build every new UI on every client.

Android/iOS worker verification tests the owner's application inside the remote device. It must prove actual native build, launch, display, input, and cleanup. It is not a substitute for, or dependency on, native T3 app delivery. Run integrated browser/device checks only when authorized during implementation. Do not run repo-wide checks by default or commit this planning document as permanent implementation documentation.
