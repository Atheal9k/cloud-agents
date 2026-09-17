# Run the controller with Docker

The controller image runs the production T3 server and its built web app. It does not run Vite,
does not mount the Docker socket, and does not contain cloud worker or mobile toolchains. Docker
and the host must remain running after clients disconnect.

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
launch workers with the project and worker tags, and terminate workers carrying those tags.

Set two HTTPS routes before launching a worker:

```bash
export T3CODE_CLOUD_CONTROLLER_URL=https://controller.example.com
export T3CODE_CLOUD_WORKER_ROUTE_URL=https://worker.example.com
```

The controller URL must reach this controller from the worker. The worker route must be an
authenticated overlay or outbound tunnel that forwards HTTP and WebSocket traffic to port 3773
on the one active worker. Configure that route in the worker image or tunnel service so it starts
at boot. Do not open port 3773 to the internet or forward it by hand for each allocation. The
controller rejects loopback routes because `localhost` on a browser, controller, and worker names
three different machines.

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

Clone and push use a temporary run directory below the controller's protected state. The Git
remote is supplied by the controller, SSH is forced through `ssh.github.com` on port 443, and the
wrapper accepts only GitHub's pinned Ed25519 host key. No SSH agent is started or passed to task
code. The controller removes the run directory after the operation. Draft PR creation passes the
configured token directly to `gh api`; it does not read a browser or initiating client's GitHub
login. The controller machine and container must stay online until publication finishes.

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

Database migrations may be forward-only. A rollback is safe only when the older image supports
the current schema. Otherwise stop the controller, select the old image, and restore the backup
taken before the update into a new volume. Keep the failed volume until the restored controller
has served its web app and the expected projects and threads appear.

Run `node scripts/verify-docker-controller.mjs` from the repository to build a disposable image
and prove web serving, non-root execution, credential loading, restart persistence, and cold
backup/restore. The script uses unique containers and volumes and removes them when it finishes.
