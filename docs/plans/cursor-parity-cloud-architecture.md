# Cursor-parity cloud architecture

Planning only. This document replaces the current “one EC2 per thread” worker
model with Cursor’s Cloud Agent shape: isolated microVMs, versioned
environments, durable threads, and idle hibernation. It does not authorize
implementation, AWS apply, or ticket creation by itself.

Related current sources:

- [Cloud agent execution ownership](../internals/cloud-agent-execution.md)
- [Cloud agents tickets](./cloud-agents-tickets.md) (first-release scope; several
  items here reverse explicit deferrals in that plan)
- `infra/cloud-agents/` (OpenTofu launch templates, 120-minute worker TTL,
  terminate-on-expiry Lambda)
- `apps/server/src/cloud/` (allocation, `RunInstances`, recipe clone/setup,
  review-grace cleanup)

Cursor references (behavior target, not a license to copy proprietary code):

- [How Cloud Agents work](https://cursor.com/docs/cloud-agent/security)
- [Environment setup](https://cursor.com/docs/cloud-agent/setup)
- [Cloud Agents API statuses](https://cursor.com/docs/cloud-agent/api/endpoints)

## Why the current model is not Cursor

Today a cloud thread is a **live Amazon EC2 instance**.

| Current T3 cloud                                                                             | Cursor Cloud Agents                                                                       |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `CloudWorkerProvider.launch` calls `RunInstances` per allocation                             | Isolated Firecracker microVM per **active** run                                           |
| Default `maxConcurrentWorkers: 1` (`CloudAllocationLimits`)                                  | Many concurrent agents; packing is a fleet problem                                        |
| Worker AMI + cloud-init clone of the selected ref on every boot                              | Base snapshot + `install` baked into an environment **build**; git setup can be `reuse`   |
| On-disk package cache dies with the instance (`/var/cache/t3-worker-dependencies`)           | Environment builds and VM snapshots outlive the guest                                     |
| Hard worker TTL (default 120 minutes) then **terminate**                                     | Turn ends → VM **hibernates**, then recycles on timers; follow-up **refreshes** the timer |
| 15-minute preview grace, then cleanup (`previewGraceSeconds`)                                | Preview and compute are separate; conversation survives idle                              |
| Thread events live on the worker’s T3 SQLite; controller keeps allocation tags + S3 archives | Conversation lives in the control plane; the VM is only runtime workspace                 |
| Retry = new attempt + new EC2 (`allocation.retry-requested`)                                 | Follow-up resumes the same agent; snapshot restore if the guest is gone                   |
| No stop/hibernate path (CA-15 deferred it)                                                   | `IDLE` means the machine **may** be snapshotted or stopped                                |
| Cleanup Lambda terminates expired tagged instances                                           | Live VMs recycle; disk snapshots last ~90 days of inactivity                              |
| Environment setup is a per-run recipe (CA-10)                                                | First-class **Environment** with Dockerfile / snapshot / `install` / `start`              |

The ownership rule from CA-01 stays: **one writable T3 runtime per live
thread**. What changes is that the runtime is no longer synonymous with a
billed EC2 instance that exists for the whole conversation.

## Target object model

Replace “allocation ≈ instance ≈ thread” with four durable objects and one
ephemeral runtime.

```text
Environment ──► EnvironmentBuild (snapshot)
                     │
                     ▼
Agent / Thread (conversation, turns, PR links)
                     │
                     ▼
RuntimeVm (microVM, only while ACTIVE or within hibernate window)
```

### Environment

A named, versioned development image for one or more repositories. Analog of
Cursor’s personal/team environment and `.cursor/environment.json`.

Fields to add (controller catalog, not worker AMI tags):

- `name`, `repos[]`, config source (`repo-file` vs dashboard/db)
- Base strategy: **exactly one of** Dockerfile, explicit image, or snapshot ID
- `install`: idempotent bootstrap after checkout (deps, codegen). Must
  terminate.
- `start`: per-boot services (dev servers). May stay attached.
- `user`, ports, secrets references, egress policy
- `agentCanUpdateSnapshot`

Config precedence (match Cursor):

1. Repo `.cursor/environment.json` (or a T3 equivalent such as `t3.cloud.json`)
   at the selected revision
2. Personal saved environment
3. Team/default environment

Do not combine Dockerfile + snapshot + AMI and hope for precedence. One base.

### Environment build

A completed `install` plus disk snapshot that later runtimes boot from. Analog
of Cursor `bld-YYYYMMDD-…` / `snapshotId`, `gitSetup: reuse`, `warmFork`.

A build records:

- environment version
- git refs used
- install log and outcome
- snapshot ID (EBS snapshot, AMI, or Firecracker snapshot — see compute)
- `gitSetup`: `clone` vs `reuse`
- `warmFork`: `warm` | `cold`

New agents should boot from the latest **succeeded** build of that environment
when the requested ref is compatible. Draft builds never become the default
boot source.

### Agent (cloud thread)

Durable conversation identity in the **controller** database, independent of
whether a VM is running.

States (match Cursor API language):

- `ACTIVE` — a turn is running, waiting on background work, or about to start.
  Keep the guest up.
- `IDLE` — last turn finished; follow-ups accepted. Guest **may** hibernate or
  snapshot.
- `ARCHIVED` — terminal. No new turns. Workspace snapshots may be deleted per
  policy.

A thread is not an EC2 instance ID. `RunWorkerReferences.threadId` remains the
in-VM T3 thread **while the runtime exists**. The controller agent ID is the
stable handle clients subscribe to after the VM is gone.

### Turn

One user-to-agent cycle, including checkpointing and optional publication.
Unchanged T3 meaning. Turns run only on an `ACTIVE` runtime.

### Runtime VM

Ephemeral isolated guest that holds:

- checkout and task files
- live T3 `state.sqlite` for that thread
- provider home (`~/.codex`, `~/.claude`, …)
- terminals, previews, DCV/browser session if that profile needs them

The controller still does **not** become a second decider/projector. While
`ACTIVE`, CA-01 stands. When the guest hibernates, the controller must have
already flushed a consistent archive (T3 snapshot + workspace) so a later
runtime can restore **one writer**.

## Compute: stop packing one EC2 per thread

Cursor packs many Firecracker microVMs on a fleet and walls execution off in a
separate AWS account. Copy that **isolation and packing**, not necessarily
their control plane.

### Recommended topology (personal AWS)

```text
[Clients] ──RPC──► T3 controller (local Docker or one small always-on host)
                      │
                      │ allocate / hibernate / restore
                      ▼
              Execution account (separate AWS account)
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
     Hypervisor   Hypervisor   (optional Mac host)
     (metal or    (metal or
      nested-virt  nested-virt
      instance)    instance)
          │
          ├── Firecracker VM  (thread A, ACTIVE)
          ├── Firecracker VM  (thread B, IDLE → snapshot, guest gone)
          └── Firecracker VM  (environment build job)
```

**Hypervisor hosts** are few, long-lived, and sized for packing (memory first).
**Guests** are many, small (start at ~2–4 vCPU / 8–16 GiB like this Cursor
pod), and exist only for `ACTIVE` plus a short idle window.

Do **not** keep today’s `t3.medium` `RunInstances` per thread as the steady
state. That is the cost problem.

### Isolation requirements (non-negotiable)

- One guest userspace per agent. No shared Linux for two threads.
- Guest cannot reach hypervisor credentials or sibling guests.
- Task cgroup still cannot read instance metadata (keep the CA-07 boundary).
- Execution IAM lives in a dedicated AWS account, distinct from the
  controller’s data plane (Cursor’s split).

### Fallback if Firecracker is not ready

A stopgap that still ends “EC2 per idle thread”:

1. Environment **builds** produce an AMI or EBS snapshot (Packer/OpenTofu
   already bake AMIs; extend that to per-environment snapshots).
2. An `ACTIVE` thread still launches one EC2 from that snapshot.
3. On `IDLE`, **stop** the instance (or snapshot + terminate) instead of
   leaving it running until the 120-minute TTL.
4. Follow-up **starts** the stopped instance or launches from the snapshot.

This is still one EC2 **per active thread**, but idle conversations cost
EBS/snapshot rather than on-demand compute. Treat it as a migration step, not
the end state. Packing on Firecracker is the Cursor match.

Mac Dedicated Hosts stay serial and 24-hour billed (CA-38). Do not apply Linux
microVM packing to EC2 Mac.

## Environment lifecycle (setup)

Replace “cloud-init clones the repo, then CA-10 recipe runs on the disposable
box” with Cursor’s two layers.

### Layer 1 — base

Slow, stable system packages and toolchains.

- Keep Packer images as the **hypervisor / default guest kernel+tools** base
  (Node, T3, Codex, Claude, git, docker-in-guest if needed).
- Put language SDKs that change with the repo in `install`, not in a global
  worker AMI, unless every environment needs them.

### Layer 2 — repository bootstrap

After checkout at the selected revision:

1. **Build job** (not a user-facing thread): clone → run `install` → snapshot.
   Record timings (reuse CA-27’s boot/clone/setup metrics).
2. **Agent boot** from that snapshot with `gitSetup: reuse` when the ref still
   matches. Only fetch/checkout the delta.
3. Run `start` / `terminals` inside the guest. Failure of `start` fails
   environment start, not a half-ready agent.

`install` must be idempotent. With builds enabled, **do not re-run `install`
on every agent boot**. Per-pod work belongs in `start`.

Repo recipes from CA-10 become the environment config:

| CA-10 recipe              | Cursor-parity field                           |
| ------------------------- | --------------------------------------------- |
| mandatory setup commands  | `install`                                     |
| dev-server ports/commands | `start` + `ports`                             |
| verification commands     | build check / optional `verify` after install |
| secret references         | environment secrets, injected at runtime      |

A committed `environment.json` (or `t3.cloud.json`) on the branch wins over
the dashboard copy. Editing config does **not** mutate a running guest.

### Secrets and git

Keep CA-06’s split: task code cannot read publication keys; clone/push uses
the trusted wrapper.

Changes:

- Inject runtime secrets into the **guest**, not the hypervisor.
- Scope bootstrap credentials to the environment build and to the agent, not
  to a 120-minute EC2 lifetime.
- Prefer GitHub App installation tokens (Cursor’s model) over a long-lived
  account SSH key shared across every worker. Keep the existing secret ARN
  path until that App exists; do not widen it.

### Network

Workers today: no public ingress, outbound 443, optional Tailscale Serve.

Add Cursor-like egress modes on the **guest**:

- allow-all (current)
- default set + allowlist
- allowlist only

Apply at the hypervisor or security group **per environment**, not as a global
VPC default that every thread inherits without a record.

## Thread and turn lifecycle

### Launch

1. Client creates or continues an **agent** (controller record).
2. If no compatible EnvironmentBuild exists for the env+ref, enqueue a build.
   Do not hide a 20-minute install inside the first chat turn without a
   visible build state.
3. Place a RuntimeVm from the snapshot (`warm` fork when a warm pool VM
   exists; otherwise `cold` boot from snapshot — Cursor’s `warmFork` field).
4. Restore or create the worker T3 environment. One writer.
5. Start the provider turn through existing adapters (`CloudProviderExecution`).
6. Stream events to clients via the existing worker route (CA-09). The
   controller proxies; it does not replay commands into a second log.

### Follow-up while ACTIVE

Unchanged: second client hits the same worker T3 session (CA-15).

### Idle (the cost save)

When the turn settles (`thread.settled`) and no unanswered approval is
blocking:

1. Mark agent `IDLE`.
2. Flush consistent archive: T3 userdata snapshot, workspace, provider home
   needed for resume (CA-14 already saves transcript/diff; extend it to a
   **restorable disk image**, not only S3 zip/artifacts).
3. Start `idleReleaseTimeout` (pool analog: default **3600s**). Any follow-up
   resets it.
4. On timeout: snapshot if dirty, then **stop or destroy the guest**. Keep the
   hypervisor.
5. Controller retains conversation indefinitely by default (Cursor).
6. Disk snapshots: rolling **90 days** of inactivity; start/resume extends.

Remove or demote:

- `worker_default_ttl_minutes = 120` as the primary lifetime of a
  conversation
- cleanup Lambda that **terminates** any tagged instance past launch+TTL
  without distinguishing `ACTIVE` vs `IDLE` vs environment build hosts
- “review grace then kill compute” as the only idle policy (CA-17 / CA-36
  become snapshot + optional preview lease, not mandatory EC2)

Hard compute caps remain (`maxRunSeconds`) for **a single ACTIVE turn**, not
for the agent’s calendar lifetime.

### Wake

Follow-up on `IDLE`:

1. If guest still up (inside idle window): attach and run the turn.
2. Else restore from snapshot onto a new guest (`gitSetup: reuse` when valid).
3. Fence the previous writer identity before the new guest accepts commands
   (CA-14).
4. If snapshot expired: rebuild environment, seed conversation from
   controller transcript; do **not** claim native provider-session resume.

### Archive / delete

- Archive: hide from dashboard, reject new turns, release claims.
- Delete: transcript + artifacts (API). Snapshots follow the 90-day window
  unless policy says otherwise.
- Unarchive is required (reverse state).

### Publication

Keep controller-owned draft PR (CA-16). Handoff is still a human review of a
draft PR. Publication must work after the guest is hibernated: either publish
before idle snapshot, or wake a short-lived guest for git push only.

## Optimizations Cursor uses that we should copy

### Warm pool

Keep a small number of guests (or hypervisor slots) already booted from the
latest environment build, with checkout in place. First message forks/claims
one (`warmFork: warm`) instead of waiting on `RunInstances` + cloud-init.

Measure before sizing. CA-27 already records cold vs cached timings; add
warm-pool claim time. No large idle EC2 fleet of **full** workers.

### Snapshot-based git reuse

Today every allocation clones in cloud-init. After builds, default to reuse.
`gitSetup: clone` only on ref mismatch, dirty snapshot, or missing repo.

### Dependency cache that outlives the guest

Move CA-27’s cache from the disposable instance disk to:

- the environment snapshot (installed tree from `install`), and
- a shared read-through cache on the hypervisor or S3 for package downloads

Writable `node_modules` stays inside the guest workspace.

### Packing and oversubscribe

Hypervisors oversubscribe CPU; they do not oversubscribe memory enough to
OOM neighbors. Admission becomes **guest slots**, not
`maxConcurrentWorkers: 1`. Start with a configured slot count per host.

### Hibernation vs terminate

Prefer snapshot + destroy guest over EC2 Stop for Firecracker. For the EC2
fallback, Stop is acceptable if root volume is encrypted and tagged to the
agent.

### Control-plane vs data-plane cost

Controller (SQLite, websocket, UI) stays a small always-on process. Almost
all spend should be:

- hypervisor hosts (steady, few)
- guest CPU while `ACTIVE`
- snapshot storage

Not: N × `t3.medium` for N open threads.

### Previews and DCV

Keep CA-25/CA-34: no desktop stream unless a visible viewer needs it. A
hibernated guest has no DCV session. Reopen preview (CA-36) restores a
**new** guest from snapshot without starting a provider turn.

## What stays from the current design

These CA-01–CA-23 decisions remain correct under Cursor parity:

- Worker (guest) owns the live thread decider/projector/provider adapters.
- Controller owns allocation, placement, archives, GitHub publication,
  admission.
- SSM is diagnostics only.
- Authenticated HTTP/WebSocket to the guest; no public guest ingress.
- Clients may disconnect; work continues while the **runtime** is ACTIVE.
- Codex/Claude qualification and credential injection patterns.
- One controller writer for allocation events (`runAllocation.ts`).
- No Kubernetes requirement for the first packing implementation.

## What this plan explicitly reverses

From [cloud-agents-tickets.md](./cloud-agents-tickets.md):

- “No warm Linux fleet is required initially.”
- “Measure cold startup before adding warm pools.”
- “Transparent live-process resume” stays out; **snapshot resume** is in.
- “Sophisticated pause/hibernate behavior are deferred” (CA-15) — this plan
  makes hibernate the default cost control.
- `maxConcurrentWorkers: 1` as a product limit — becomes hypervisor slot
  admission.
- Disposable EC2 as the unit of a thread.
- 120-minute instance TTL as conversation lifetime.
- Cleanup that terminates stopped instances as if they were expired workers
  (`cleanup_expired_workers.py` currently includes `stopping`/`stopped`).

Update that ticket list when implementation starts; do not treat this file as
a second competing backlog. Implementation PRs should be one concern each.

## Contracts and code touchpoints

When implemented, expect changes in:

- `packages/contracts/src/cloudAllocation.ts` — Environment, Build, Agent
  status (`ACTIVE`/`IDLE`/`ARCHIVED`), snapshot IDs, idle deadlines, slot
  limits instead of `maxConcurrentWorkers: 1`
- `apps/server/src/cloud/CloudWorkerProvider.ts` — place/hibernate/restore
  guests; `RunInstances` only for hypervisor scale-out or EC2 fallback
- `apps/server/src/cloud/CloudAllocationReconciler.ts` — idle timers, snapshot
  flush, do not cleanup-on-grace as terminate-only
- `apps/server/src/cloud/CloudRepositoryPreparation.ts` — run on **build
  jobs**, not every agent boot
- `apps/server/src/cloud/CloudRunResults.ts` — restorable disk snapshots
- `infra/cloud-agents/` — hypervisor ASG or hosts; guest networking; snapshot
  bucket/EBS; cleanup that never kills `ACTIVE` guests or hypervisors
- Web/desktop launch UI — environment picker, build status, idle/archived
  badges (command palette + settings, not only new-thread)

Mobile native T3 UI remains deferred (CA-20). Capability-check the new
statuses so old clients degrade cleanly.

## Delivery slices (when authorized)

Order is dependency, not ticket IDs.

1. **Model split** — persist Environment, Build, Agent, RuntimeVm separately
   from `RunAllocation` instance IDs. Agent conversation survives missing
   `instanceId`.
2. **Environment builds** — snapshot after `install`; boot next run from it
   with git reuse. Still allowed to use one EC2 for the build job.
3. **Idle hibernate** — on settle, snapshot and stop/destroy guest; follow-up
   restores. Replace 120-minute TTL as primary policy. Fix cleanup Lambda so
   stopped snapshot volumes are not terminated as expired workers.
4. **Warm pool** — N pre-booted guests per popular environment.
5. **Firecracker packing** — hypervisor hosts in the execution account;
   guests replace per-thread EC2. Nested virt / metal proof first (CA-37
   already cares about KVM).
6. **Egress policies, 90-day snapshot GC, archive/unarchive, GitHub App**.
7. **Preview reopen from snapshot** without a provider turn (CA-36, rewritten
   onto this model).

Android/iOS worker profiles remain separate guests with heavier images; they
participate in the same agent/idle/snapshot state machine but not in dense
packing until measured.

## Acceptance (end state)

A maintainer can:

- Open several cloud threads against one environment without several always-on
  `t3.medium` instances.
- Watch the first run wait on an environment **build**, then later runs start
  from a snapshot with `reuse`.
- Send a follow-up hours later and get a restored workspace, not a blank EC2
  clone, as long as the snapshot is within retention.
- See the agent stay in the dashboard as `IDLE` while AWS shows no running
  guest.
- Archive and unarchive without leaking a billed instance.
- Keep CA-01: only the guest T3 writes thread events while a turn is live.

## Out of scope

- Matching Cursor model quality, pricing, or Firecracker internals we cannot
  see.
- Multi-controller consensus.
- Transparent migration of an in-flight provider process without snapshot.
- Treating this markdown as shipped user documentation (`docs/user/`).
- Implementing the slices in this PR.
