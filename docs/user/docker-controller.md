# Run the controller with Docker

The controller image runs the production T3 server and its built web app. It does not run Vite,
does not mount the Docker socket, and does not contain cloud worker or mobile toolchains. Docker
and the host must remain running after clients disconnect.

## Supported first release

This release is opt-in. A normal T3 server does not advertise cloud allocations. The Docker
controller sets `T3CODE_CLOUD_CONTROLLER=1`, which adds the cloud-allocation capability to that
environment. Web and desktop clients show **New cloud thread** only when the connected environment
advertises it.

The supported path packs Linux agents as Firecracker guests on hypervisor hosts
when `T3CODE_CLOUD_HYPERVISOR_FLEET` is configured. Each guest takes CPU, memory,
disk, and profile slots rather than a whole EC2 instance. Codex may use a ChatGPT
login or an OpenAI API key; Claude may use a Claude subscription setup token.
Use a repository whose setup, verification, and development-server commands are
covered by its trusted configuration. Private package registries, private
submodules, other providers, Android/iOS workers, and the native T3 mobile client
are not supported by this release. A phone or tablet may use the responsive web
client for ordinary app previews, but not the shared Agent browser.

Until a Firecracker fleet exists, the controller can still launch one disposable
x86_64 Linux EC2 worker at a time. That stop/snapshot-per-thread path is a
migration fallback. It is not Cursor parity.

The local machine is the controller host. Closing web or desktop does not stop an accepted run,
but stopping Docker, sleeping the host, or losing its network connection interrupts allocation,
finalization, publication, and normal cleanup. The independent AWS expiry cleanup remains a
backstop, not a replacement for the controller.

The same image also runs on an always-on host, where your own computer may be off. That deployment
sets `T3CODE_CLOUD_CONTROLLER_MODE=permanent`, and the cloud dialog stops promising that this
machine has to stay up. Maintainers move an existing controller there with the
[permanent controller runbook](../operations/permanent-controller.md); everything below applies to
both modes unless it says otherwise.

## Prepare the release

1. Build a pinned `linux-web` worker image. Build `linux-web-browser` as well if you need the
   shared Agent browser. Record each AMI ID and image version in
   `infra/cloud-agents/terraform.tfvars`.
2. Create the remote OpenTofu state and apply `infra/cloud-agents` as described in its README.
   Set `controller_mode = "local"` so the stack does not create a second controller on EC2, or
   `ec2` with `controller_image_ref` and the tailnet variables for a permanent host.
   Configure at least one provider credential using [Provider subscriptions](#provider-subscriptions).
3. Store the Git SSH key and GitHub API token in Secrets Manager. Set
   `worker_git_ssh_secret_arn` to a repository-scoped read key so worker bootstrap can clone before
   the agent starts. In `ec2` mode, add the publication key and token's full ARNs to
   `controller_credential_secret_arns` for the stack's controller role. In `local` mode,
   the AWS identity mounted into the Docker controller needs read access to those secrets. Give
   the GitHub token pull-request write access only to the repositories you intend to use.
4. Create the protected controller credential directory described under [State and
   credentials](#state-and-credentials). Its AWS identity needs the same scoped worker-allocation
   and secret-read permissions as the controller role. Set `T3CODE_CLOUD_GIT_SSH_SECRET_REF` and
   `T3CODE_CLOUD_GITHUB_TOKEN_SECRET_REF` to the corresponding secret names or ARNs.
5. Configure authenticated HTTPS routes for the controller and each packed guest. For
   Tailscale, set `worker_tailscale_auth_key_secret_arn`, use the controller's tailnet URL for
   `T3CODE_CLOUD_CONTROLLER_URL`, and use a `{workerHostname}` URL template for
   `T3CODE_CLOUD_WORKER_ROUTE_URL`. Do not expose worker port 3773 or DCV port 8443 directly.
6. Build and start the controller, pair the web client, and connect the desktop app to the same
   controller environment. The desktop app is a client here; quitting it does not stop the Docker
   controller.

Before the first paid run, confirm that the controller is healthy, the expected launch template is
the only template tagged for the selected profile, the worker price allowlist names its instance
type, and the AWS expiry cleanup schedule is enabled.

## Provider subscriptions

Create provider credentials on a trusted machine, then store their values in AWS Secrets Manager.
Only secret ARNs belong in `terraform.tfvars`.

For Codex with a ChatGPT plan, set `cli_auth_credentials_store = "file"` in
`~/.codex/config.toml`, run `codex login --device-auth`, then store the complete
`~/.codex/auth.json` file as a secret and set `worker_codex_auth_json_secret_arn`. The file contains
access and refresh tokens. A worker writes refreshed credentials back to that secret, so allow only
one worker at a time to use the cache. To rotate or recover from an
expired or revoked login, authenticate again and replace the secret value. Alternatively, store a
raw OpenAI API key and set `worker_codex_api_key_secret_arn`; do not set both Codex variables.

For Claude, run `claude setup-token`, store the raw token it prints as a secret, and set
`worker_claude_oauth_token_secret_arn`. Setup tokens are long-lived but can expire or be revoked;
run the command again and replace the secret when needed. Codex account login uses the linked
ChatGPT allowance. Claude Agent SDK runs draw from the plan's separate monthly Agent SDK credit.
Codex API keys use OpenAI API billing.

After applying OpenTofu, launch **New cloud thread** and choose the authenticated Codex or Claude
provider and model. If the worker reports an authentication failure, replace the relevant secret,
apply again if its ARN changed, and start a new worker.

## Build and start

Docker Desktop on Windows and Docker Engine with Compose v2 on Linux use the same Compose files.
Build from a clean, pinned commit so the image label and source agree.

On Linux:

```bash
export T3CODE_SOURCE_REVISION="$(git rev-parse HEAD)"
export T3CODE_IMAGE="t3-code-controller:${T3CODE_SOURCE_REVISION}"
docker compose -f compose.yaml -f compose.build.yaml up -d --build --wait
```

In PowerShell:

```powershell
$env:T3CODE_SOURCE_REVISION = git rev-parse HEAD
$env:T3CODE_IMAGE = "t3-code-controller:$env:T3CODE_SOURCE_REVISION"
docker compose -f compose.yaml -f compose.build.yaml up -d --build --wait
```

Open `http://127.0.0.1:3777`. Create a pairing URL without printing it in shared logs:

```bash
docker compose exec controller node /opt/t3/dist/bin.mjs pair --base-dir /var/lib/t3
```

The service binds to loopback by default. Set `T3CODE_BIND_ADDRESS` to a reachable private
address before starting it when another device needs direct access. Put TLS and public access in
front of the controller instead of publishing unencrypted T3 traffic to the internet. Do not set
`VITE_HTTP_URL` or `VITE_WS_URL`; the built client uses the same origin for HTTP and WebSockets.

The cloud queue uses `T3CODE_CLOUD_AWS_REGION` and `T3CODE_CLOUD_PROJECT` to find the worker
launch template created by `infra/cloud-agents`. Their defaults are `us-west-1` and
`t3-cloud-agents`. Set both when your OpenTofu `aws_region` or `name_prefix` differs. The AWS
identity in the credential overlay must be allowed to describe launch templates and instances,
launch workers with the project and worker tags, and stop, start, re-tag, and terminate workers
carrying those tags.

Set `T3CODE_CLOUD_RUNTIME=firecracker` and `T3CODE_CLOUD_HYPERVISOR_FLEET` to a JSON array of
hypervisor hosts to pack guests. Each host lists CPU milliseconds, memory MiB, disk GiB, a CPU
oversubscribe ratio, KVM, and the worker profiles it may run. Placement refuses a guest that would
overcommit memory. `T3CODE_CLOUD_MAX_CONCURRENT_WORKERS` bounds how many guests may occupy compute
at once; raise it to match the fleet. `T3CODE_CLOUD_RUNTIME=ec2-fallback` keeps the older
per-thread `RunInstances` path. Instances launched that way are tagged
`CloudAgentRuntimeParity=ec2-migration-fallback` and must not be reported as Cursor parity.

The personal controller admits `T3CODE_CLOUD_MAX_CONCURRENT_WORKERS` active guests, default 1 for
the EC2 fallback. Configure its waiting queue and time limits with
`T3CODE_CLOUD_MAX_QUEUE_DEPTH`, `T3CODE_CLOUD_MAX_RUN_SECONDS`,
`T3CODE_CLOUD_MAX_INPUT_WAIT_SECONDS`, `T3CODE_CLOUD_PREVIEW_GRACE_SECONDS`, and
`T3CODE_CLOUD_IDLE_RELEASE_SECONDS`. The defaults are 8 waiting jobs, a 3-day run, a 15-minute
unanswered input request, a 15-minute preview grace period, and a 1-hour idle release. Requests
with a longer run or an unapproved instance type fail before a guest is placed.

An idle agent keeps its stopped disk for 90 days, and every start or resume gives it a fresh 90
days. After that the disk is released, and the next follow-up starts the agent on a new worker
instead of restoring it. Conversations and their runs are kept forever unless you set
`T3CODE_CLOUD_CONVERSATION_RETENTION_DAYS`, which permanently deletes an agent that has been
inactive for that many days; the default `0` keeps them indefinitely. Retained results keep their
own 7-day expiry.

Archiving an agent hides it, releases its worker, and stops it accepting new runs. Unarchiving
makes it available again without starting any compute. Deleting an agent is permanent: its
transcript, retained diffs, and artifacts are erased, and its conversation cannot be recovered.
A delete does not remove published branches or pull requests, and a stopped disk still leaves on
its own retention schedule rather than immediately.

`T3CODE_CLOUD_WORKER_PRICES` is a comma-separated allowlist in `instance-type=hourly-usd` form.
For example, `t3.medium=0.0496` allows only `t3.medium` and estimates one worker hour at $0.0496.
Update the value when the region, instance type, operating system, or AWS price changes. The
controller reports compute from this assumption. It reports storage, provider use, and streaming
transfer separately when their costs are unknown. The estimate excludes taxes and discounts and
does not turn an AWS billing alert into a live spending cap. AWS documents current price-list
lookups in its [Price List API guide](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html).

## Cloud agents settings

**Settings → Cloud agents** is the screen for administering the stack the controller talks to. It
shows the controller and execution accounts, the region and project, each hypervisor with its KVM
support and guest/hypervisor image versions, the fleet's slot capacity, every environment with its
active Build and snapshot, the snapshot and conversation retention policy, and whether the
controller is accepting runs. Credentials never reach it: the controller sends account identifiers
and the config it resolved, never an access key or a hypervisor credential path.

Each readiness check runs on its own, so a failing IAM policy does not hide a healthy fleet:

- **Execution IAM** confirms the controller's AWS credentials resolve and match
  `T3CODE_CLOUD_EXECUTION_ACCOUNT_ID` when you set it.
- **KVM and Firecracker support** confirms every configured hypervisor reports KVM. It is skipped
  on the EC2 migration fallback.
- **Image access** resolves a launch template for every worker profile.
- **Snapshot access** confirms snapshots are readable and that every active Build still points at a
  snapshot a run can boot.
- **Artifact storage** writes to the retained-results directory on the controller host.
- **Guest registration** enumerates workers and reports any running guest that lost its
  registration credential.
- **SSM diagnostics** is optional. It stays skipped until you set
  `T3CODE_CLOUD_SSM_DIAGNOSTICS_DOCUMENT`, and a failure there affects recovery debugging only.

Set `T3CODE_CLOUD_CONTROLLER_ACCOUNT_ID` and `T3CODE_CLOUD_EXECUTION_ACCOUNT_ID` to the accounts
OpenTofu reports so the screen can flag credentials pointing at the wrong account.

**New environment** and **Edit and test** save a personal, team, or default environment version and
immediately start a Build that tests it. The Build activates only if it succeeds, so runs keep
booting the last successful Build while a new version is still being proved. A repository-owned
environment is created by the agent-led setup inside its repository, not by this form.

**Default model**, **Default repository**, and **Default ref** prefill a new cloud thread when the
launcher has nothing more specific. Clearing a field removes the default rather than storing a
blank one.

**Stop admission** refuses new runs while leaving active runs, idle snapshots, cleanup, retained
results, and review available. Resume it from the same button. A state fenced by `t3 cloud fence`
stays read-only until `t3 cloud adopt` runs on the owning host.

## Launch a cloud thread

After the controller reports cloud allocation support, open the command palette and choose **New
cloud thread**, or press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> on Windows/Linux and
<kbd>Command</kbd>+<kbd>Option</kbd>+<kbd>N</kbd> on macOS. Choose the repository ref, task,
available provider model, permission policy, worker and time limits, and whether the result stays
review-only or opens a draft pull request. The same dialog is available in locally served web and
desktop clients.

The controller continues provisioning, observing, and cleaning up the run if the client
disconnects. Keep the controller host and Docker running. Reopen the dialog to see recent runs,
stop one, or open a registered worker as an ordinary T3 thread.

For the first run, choose a linked project and a branch, tag, or commit that the controller's Git
credential can read. Projects added from a GitHub repository or Git URL keep that remote and appear
in the cloud thread project picker. New cloud threads default to **Open draft PR**, full access, and
a 3-day run limit. Choose **Review only** when you do not want the worker to publish its changes. The
worker validates that Codex is installed, authenticated, and able to use the selected model before
it starts the turn.

Set two HTTPS routes before launching a worker. This Tailscale example gives every allocation
attempt a distinct MagicDNS name:

```bash
export T3CODE_CLOUD_CONTROLLER_URL=https://controller.your-tailnet.ts.net
export T3CODE_CLOUD_WORKER_ROUTE_URL='https://{workerHostname}.your-tailnet.ts.net'
```

The controller URL must reach this controller from the worker. The worker route must be an
authenticated overlay or outbound tunnel that forwards HTTP and WebSocket traffic to port 3773
on each packed guest. With `worker_tailscale_auth_key_secret_arn` configured, the worker image
joins the tailnet and starts Tailscale Serve before registration. A fixed route remains supported
for other tunnel systems. Do not open port 3773 to the internet or forward it by hand for each
allocation. The controller rejects loopback routes because `localhost` on a browser, controller,
and worker names three different machines.

At launch, the controller signs a credential that names one allocation attempt and expires at its
registration deadline. The root registration unit reads that credential from EC2 instance tags,
waits for the local T3 service, issues a worker bearer session, and registers the route. The
`cloudagent` service and repository processes remain unable to reach instance metadata. Replaced
or expired attempts cannot register again. Normal HTTP and WebSocket traffic then connects to the
worker T3 environment directly; SSM remains a recovery tool and is not part of an active session.

Compose uses `restart: unless-stopped`, a health check, and a 30-second shutdown window. The stop
command waits for the server to close its SQLite connection before stopping the container.

## State and credentials

The named `t3-controller-data` volume is mounted at `/var/lib/t3`. T3 stores its environment
identity, settings, secrets, and SQLite database below `/var/lib/t3/userdata`. The image runs as
uid and gid `10001`, and Docker initializes a new volume with matching ownership.

Keep credentials outside the repository and image. The optional credential overlay mounts one
protected host directory read-only at `/run/t3-credentials`:

```text
credentials/
|-- openai-api-key
|-- anthropic-api-key
`-- aws/
    `-- credentials
```

Set the directory and add the overlay when starting Compose:

```bash
export T3CODE_CREDENTIALS_DIR=/absolute/path/to/credentials
docker compose -f compose.yaml -f compose.credentials.yaml up -d --wait
```

PowerShell accepts a Windows path in `T3CODE_CREDENTIALS_DIR`. The entrypoint reads provider keys
into the server process and points the AWS SDK at the mounted credentials file. It fails when an
explicit `OPENAI_API_KEY_FILE`, `ANTHROPIC_API_KEY_FILE`, or `AWS_SHARED_CREDENTIALS_FILE` is not
readable. Restrict the host directory to the account that runs Docker. Compose environment values
and `docker inspect` are not suitable places for secret values.

### Cloud Git and GitHub credentials

Store the publication SSH key and GitHub API token in AWS Secrets Manager. Give the controller's
AWS identity access to those two secrets, then set references, not values, before starting
Compose:

```bash
export T3CODE_CLOUD_GIT_SSH_SECRET_REF=cloud-agent-victor-key
export T3CODE_CLOUD_GITHUB_TOKEN_SECRET_REF=cloud-agent-github-token
docker compose -f compose.yaml -f compose.credentials.yaml up -d --wait
```

The SSH secret may be a raw, unencrypted OpenSSH private key or a JSON object with exactly one
string field containing that key. JSON escaped newlines and CRLF keys are normalized before use.
The GitHub secret may likewise be a raw token or a one-field JSON object. The controller reads
Secrets Manager for each operation, so rotation applies without rebuilding the image.

Controller-side publication fetches and pushes use a temporary run directory below the protected state. The Git
remote is supplied by the controller, SSH is forced through `ssh.github.com` on port 443, and the
wrapper accepts only GitHub's pinned Ed25519 host key. No SSH agent is started or passed to task
code. The controller removes the run directory after the operation. Draft PR creation passes the
configured token directly to `gh api`; it does not read a browser or initiating client's GitHub
login. The controller machine and container must stay online until publication finishes.

Worker bootstrap separately reads `worker_git_ssh_secret_arn` as root, fetches the assigned ref,
and checks out `/work/repository` on the requested output branch. It removes the key before T3
starts unless `worker_github_token_secret_arn` is configured. That opt-in keeps the SSH key under
the protected worker runtime directory and exposes the scoped GitHub token to the task so `git
push` and `gh pr create` work inside the thread. The agent still cannot reach instance metadata or
read either secret ARN.

Grant the GitHub token `Pull requests: write` for the target repository. If
`cloud-agent-victor-key` is an account SSH key, its Git access is as broad as that account's
repository access even though each run receives only its configured repository operation. A
repository deploy key is narrower when one repository is enough.

The base image deliberately has no provider CLI. Cloud tasks run on workers. To run a provider
inside this controller instead, derive another image that installs a pinned provider CLI, supply
its credentials through the protected mount, and explicitly mount one workspace:

```bash
export T3CODE_WORKSPACE=/absolute/path/to/project
docker compose -f compose.yaml -f compose.workspace.yaml up -d --wait
```

On Linux, the mounted workspace must be writable by uid `10001`. Git, OpenSSH, the AWS CLI, and
the GitHub CLI are already in the controller image. Any provider-specific binary and its runtime
dependencies belong in the derived image, not in the workspace or controller state volume.

### Retained cloud results

The controller stores completed cloud-run captures below `userdata/cloud-results` in the persistent
data volume. Each capture has the authoritative T3 thread transcript, the repository base revision,
a full diff, verification output, a Git workspace checkpoint, and the declared artifact files. Open
the result path returned at finalization to review the diff and verification output or download the
files. The page and every download require an authenticated T3 session with orchestration read
access.

The controller keeps a capture for seven days. One capture may contain at most 64 declared artifacts
and 256 MiB in total. A single artifact may be 64 MiB, while the transcript is limited to 32 MiB and
the diff and verification output to 16 MiB each. A limit failure remains visible but is not retryable
without changing the retained input. Other storage failures are retryable until the worker's hard
compute deadline. Finalization reports success only after the controller atomically commits the
capture to its persistent volume.

The workspace checkpoint includes changed tracked files and non-ignored untracked files. Git-ignored
files, provider profiles, and controller credentials are not copied. Retention also refuses common
credential filenames such as `.env`, `.npmrc`, private keys, and provider authentication files when
they appear in the changed workspace. The transcript and workspace are captured during one bounded
finalization window, not in one cross-filesystem transaction. Changes made after capture starts may
miss one part of the result; the result page records the start and completion times for that window.

Recovery is explicit. Fence the old allocation attempt first, then restore its workspace checkpoint
into a new allocation and start a linked T3 continuation. Recovery does not revive an interrupted
process or claim that an unsupported provider session resumed.

## Preview, review, and run control

An app preview proxies the repository's development server. It uses the viewer's browser session
and does not start desktop streaming. The **Agent browser** shows the Chromium session that Codex
is using on a `linux-web-browser` worker. Opening that panel starts streaming on demand. **Take
control** interrupts the active provider turn before human input is granted. **Return control**
revokes human input first, then starts a follow-up so Codex can inspect the changed browser state.
Closing the panel releases viewer access without stopping a browser that Codex still needs.

After Codex finishes, the agent goes idle. The controller flushes the worker's database,
workspace, and provider home, then starts the idle-release timer, 1 hour by default. A follow-up
inside that window reuses the same worker. After it, the worker is stopped with its disk kept and
the run shows as **Hibernated**; a later follow-up starts it again and reports what came back, so
the filesystem returning does not imply the provider resumed its own session. The preview is
withdrawn on its own grace period, 15 minutes by default, and the hard run deadline still applies
to a run in flight. The controller captures the transcript, diff, verification output, workspace
checkpoint, and declared artifacts. Saved results stay reviewable from **Review cloud agents**
(command palette, `Mod+Alt+R`, or Review on a recent cloud run) and from authorized `/cloud/agents/`
and short-lived `/cloud/review/` links without waking the worker. Agent status (`ACTIVE`, `IDLE`,
`ARCHIVED`) is separate from the latest run status and from whether preview or terminal is live.
Artifact downloads use short-lived authorized URLs; untrusted HTML is download-only. Archive,
unarchive, cancel, wake, pull-request deletion, and permanent delete are separate, access-checked
actions. Results expire after seven days.

**Stop** cancels provider work and requests cleanup. It does not delete an already opened pull
request or a saved result. Retry creates a new allocation attempt after the prior attempt is
fenced; it does not revive the old process. When recovery is needed, use the saved checkpoint and
start a linked continuation. Treat a missing checkpoint or expired result as unrecoverable rather
than silently starting from a different revision.

Admission is separate from the controller capability. The authorized
`cloud.allocations.setAdmission` operation can close admission without disabling the controller.
Fencing is stronger and separate: `t3 cloud fence` marks a stopped controller's state directory so
neither it nor a copy of it writes again, which is how a move to another host keeps exactly one
writable controller. `t3 cloud status` shows the current mode, fence, admission, and anything still
awaiting cleanup; `t3 cloud adopt` clears a fence on the host that should own the state.
Closing admission rejects new launches and retries, persists across controller restarts, and keeps
accepted runs, cancellation, cleanup, and saved results manageable. Reopen admission through the
same operation after maintenance. Removing `T3CODE_CLOUD_CONTROLLER` is a full capability shutdown,
so do that only after every accepted run has reached cleanup and its required results have been
saved.

## Recovery and teardown

Rotate the Codex API key by writing a new value to the same Secrets Manager secret. New workers use
the new value; an active worker keeps its current short-lived Codex profile until cleanup. Rotate
Git SSH and GitHub tokens the same way. The controller reads those secrets for each Git or GitHub
operation, so new operations use the replacement without rebuilding the image. Revoke the old
credential after a review-only run and draft-PR run both succeed with the replacement.

For a stuck worker, first use **Stop** and wait through its cleanup deadline. If cleanup still
fails, list only owned workers and inspect the exact instance IDs before terminating one:

```bash
aws ec2 describe-instances \
  --region "$T3CODE_CLOUD_AWS_REGION" \
  --filters \
    "Name=tag:CloudAgentProject,Values=$T3CODE_CLOUD_PROJECT" \
    "Name=tag:CloudAgentRole,Values=worker" \
    "Name=tag:Ephemeral,Values=true" \
    "Name=instance-state-name,Values=pending,running,stopping,stopped"

aws ec2 terminate-instances \
  --region "$T3CODE_CLOUD_AWS_REGION" \
  --instance-ids i-0123456789abcdef0
```

Never terminate by a process-name or broad tag match. Confirm the allocation ID and attempt tags on
the exact instance first. The scheduled expiry cleanup should also terminate workers after their
tagged deadline when the controller is unavailable.

To disable the release, close admission, let accepted runs finish or stop them, confirm cleanup,
and take a cold controller backup. Then stop Compose. Keeping the named Docker volume preserves
the environment identity, settings, threads, allocation catalog, and unexpired saved results.
`docker compose down` does not remove that volume. Do not add `--volumes` unless you intend to
delete the controller state.

OpenTofu teardown is a separate operation. Worker resources are disposable, but controller data
and retained artifact storage reject destruction by default. Keep `allow_retained_data_destroy`
false for a normal shutdown. Export the data you need before enabling it for a deliberate final
teardown. Removing AWS resources does not delete pull requests already published to GitHub.

## Backup and restore

Use a cold backup. This provides one SQLite writer and captures settings, secrets, identity, and
the database at the same cutover point.

1. Stop the controller and wait for Compose to finish.
2. Archive the named volume with the same image.
3. Start the controller again.

```bash
docker compose stop controller
docker create --name t3-controller-backup \
  -v t3-controller-data:/var/lib/t3 \
  --entrypoint tar "$T3CODE_IMAGE" \
  -C /var/lib/t3 -czf /tmp/t3-controller.tgz .
docker start --attach t3-controller-backup
docker cp t3-controller-backup:/tmp/t3-controller.tgz ./t3-controller.tgz
docker rm t3-controller-backup
docker compose up -d --wait
```

These commands work in bash and PowerShell because `docker cp` avoids host bind-mount ownership
differences. Never copy a live `state.sqlite` by itself. If downtime is not acceptable, use
SQLite's online backup API for the database and separately coordinate the other state files.

To restore, stop the controller, move the current volume aside instead of overwriting it, create
a fresh volume, and unpack the archive:

```bash
docker compose down
docker volume create t3-controller-restored
docker create --name t3-controller-restore \
  -v t3-controller-restored:/var/lib/t3 \
  --entrypoint tar "$T3CODE_IMAGE" \
  -C /var/lib/t3 -xzf /tmp/t3-controller.tgz
docker cp ./t3-controller.tgz t3-controller-restore:/tmp/t3-controller.tgz
docker start --attach t3-controller-restore
docker rm t3-controller-restore
T3CODE_DATA_VOLUME=t3-controller-restored docker compose up -d --wait
```

In PowerShell, set `$env:T3CODE_DATA_VOLUME = "t3-controller-restored"` before the final Compose
command.

To migrate an existing local controller, stop every process using its T3 home, archive the entire
base directory so the archive contains `userdata/`, and restore it into a fresh named volume using
the command above. For example, run `tar -C <T3-home> -czf t3-controller.tgz .` only after the host
server stops. Start only the container after the cutover. Do not run the host server and the
container against copies that represent the same active environment.

## Update, publish, and roll back

Take a cold backup before changing images. Buildx can load one platform locally or publish the
same revision for Linux amd64 and arm64:

```bash
docker buildx build --load \
  --build-arg T3CODE_SOURCE_REVISION="$T3CODE_SOURCE_REVISION" \
  -t "$T3CODE_IMAGE" .

docker buildx build --platform linux/amd64,linux/arm64 --push \
  --build-arg T3CODE_SOURCE_REVISION="$T3CODE_SOURCE_REVISION" \
  -t registry.example.com/t3-controller:"$T3CODE_SOURCE_REVISION" .
```

Set `T3CODE_IMAGE` to an immutable tag or digest, then pull and recreate the controller:

```bash
docker compose pull
docker compose up -d --wait
```

Container recreation keeps the named volume.

Worker images roll back independently. Restore the previous AMI ID and matching `image_version`
for the affected `worker_profiles` entry, review `tofu plan`, and apply it. OpenTofu makes that
launch-template version the default for new allocations. An active worker keeps the AMI and pinned
toolchain it started with; stop it explicitly if it must not finish on the withdrawn image.

Database migrations may be forward-only. A rollback is safe only when the older image supports
the current schema. Otherwise stop the controller, select the old image, and restore the backup
taken before the update into a new volume. Keep the failed volume until the restored controller
has served its web app and the expected projects and threads appear.

Run `node scripts/verify-docker-controller.mjs` from the repository to build a disposable image
and prove web serving, non-root execution, credential loading, restart persistence, and cold
backup/restore. The script uses unique containers and volumes and removes them when it finishes.
