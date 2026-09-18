# Personal AWS stack

This OpenTofu stack creates the CA-03 infrastructure boundary:

- one permanent Linux controller with a stable Elastic IP and retained encrypted data volume;
- disposable Linux worker launch templates with encrypted root volumes;
- separate controller, worker, and cleanup identities;
- controller-only worker ingress and configurable trusted HTTPS ingress to the controller;
- an encrypted, versioned artifact bucket;
- fixed SSM recovery diagnostics that cannot launch agent jobs; and
- a scheduled cleanup function that terminates expired tagged workers even when the controller is unavailable.

The controller still uses the configurable controller AMI. Workers require the versioned image built from `image/worker.pkr.hcl`; there is no generic Amazon Linux fallback. Normal startup does not call SSM.

## Worker image

Packer 1.16.0 and the Amazon plugin 1.8.2 build the worker AMI. The template requires an exact Amazon Linux 2023 x86_64 source AMI ID. It pins Node.js 24.13.1, T3 0.0.42, Codex 0.154.0, and Claude Code 2.1.273, then records those versions and the installed RPM set in `/opt/t3`.

```powershell
packer init ./image
packer validate -var "source_ami_id=ami-0123456789abcdef0" ./image
packer build `
  -var "source_ami_id=ami-0123456789abcdef0" `
  -var "image_version=0.0.42-ca27.1" `
  ./image
```

The default `linux-web` image has no mobile SDK, X server, browser, or display-stream service. Build the on-demand viewer as a separate profile:

```powershell
packer build `
  -var "source_ami_id=ami-0123456789abcdef0" `
  -var "profile_name=linux-web-browser" `
  -var "image_version=0.0.42-ca35.1" `
  -var "install_desktop_dependencies=true" `
  -var "install_shared_browser=true" `
  ./image
```

The browser image pins Amazon DCV 2025.0-20103 by archive checksum and installs Chromium from the Amazon Linux SPAL repository. Use an AL2023 source release at or after `2023.9.20251117`, when SPAL is available. SPAL packages are outside standard AWS Support coverage. DCV on EC2 does not need a separate license server, and T3 uses the installed DCV web viewer rather than redistributing the Web Client SDK. Review the [Amazon DCV license guidance](https://docs.aws.amazon.com/dcv/latest/adminguide/setting-up-license.html) and [SPAL support policy](https://docs.aws.amazon.com/linux/al2023/ug/spal.html) before publishing an image.

`dcvserver` and its loopback nginx bridge start with the instance, but no desktop session is created at boot. The first provider turn or visible Agent browser panel creates one virtual session for that allocation attempt. Provider-launched Chromium receives that session's `DISPLAY` and `XAUTHORITY`, so automation and the viewer observe the same browser. DCV listens only on `127.0.0.1:8443`; the authenticated T3 route proxies its HTTP and WebSocket traffic, and the worker security group has no DCV ingress. Viewer grants expire after 75 seconds without a visible-panel heartbeat, and a replacement worker cannot resolve a prior attempt's in-memory token.

The Agent browser starts in observe mode. Taking control interrupts an active provider turn before the worker grants keyboard, pointer, touch, scrolling, and clipboard-paste input to the viewer. Returning control revokes input first, then starts a follow-up that tells the agent to inspect the changed browser state. Closing or losing the viewer revokes input without resuming the agent. The viewer works in the web client and the desktop app on the latest three major Chrome, Firefox, Edge, and Safari releases in the [Amazon DCV browser requirements](https://docs.aws.amazon.com/dcv/latest/userguide/requirements.html). Amazon DCV's bundled browser client does not support iOS or Android, so phones should use the direct app preview until a supported mobile transport is added. Direct app previews do not start or require DCV.

To measure contention on an actual browser-profile worker, open the Agent browser panel, start Chromium in the agent workflow, then run `/opt/t3/bin/measure-shared-browser <build command>`. The command emits build exit status, elapsed time, average DCV/Xdcv/Chromium CPU, peak RSS, viewer first-byte latency, and network bytes. Capture an idle baseline and the same build without a visible viewer before accepting a profile size. This repository does not run that billable AWS measurement during offline verification.

The worker service keeps package-manager downloads in `/var/cache/t3-worker-dependencies`. Cache entries are private to the worker user, keyed by the repository, dependency inputs, setup recipe, image version, operating system, and architecture. Installed dependency trees stay in their run workspaces. The server retains at most eight entries and 5 GiB by default. Set `T3CODE_CLOUD_DEPENDENCY_CACHE_MAX_ENTRIES` or `T3CODE_CLOUD_DEPENDENCY_CACHE_MAX_BYTES` in the worker runtime environment to lower those bounds. This does not keep workers warm.

Cloud run records include image boot, service startup, clone, setup, and provider-start timing data. The image writes the boot and service measurements to `/var/lib/t3-worker/startup-timings.json`; run workspaces and provider credentials stay outside the dependency cache.

The image enables `cloud-agent-worker.service` and the root-only `cloud-agent-worker-registration.service`. T3, Codex, Claude Code, and every child process run as `cloudagent` in one systemd cgroup. Provider credentials live under `/run/t3-worker` and Claude Code does not check for automatic updates. The worker unit drops capabilities, blocks EC2 metadata for the cgroup, restricts writable paths, kills the whole cgroup on stop, and clears temporary credentials after success or failure. Its preflight checks the pinned tools and confirms an IMDSv2 token cannot be obtained before T3 starts. The registration unit alone reads the short-lived allocation tags, verifies the local T3 service, and registers its configured HTTPS route. The worker role has no access to the controller's Git or GitHub secrets.

Codex supports either API-key authentication or a ChatGPT account cache; configure exactly one.
`worker_codex_api_key_secret_arn` points to a secret containing the raw OpenAI API key.
`worker_codex_auth_json_secret_arn` points to a secret containing the complete `auth.json` created
by `codex login --device-auth`. A worker restores that file, forces file-backed credential storage,
and writes changes back to the same secret as Codex refreshes them, with service cleanup as a final
fallback. The account-cache policy grants `GetSecretValue` and
`PutSecretValue` only for that ARN. Serialize workers that share one cache to avoid concurrent
refresh-token rotation. API-key use is billed as OpenAI API usage; account login uses the linked
ChatGPT plan.

Claude subscription authentication uses the raw value printed by `claude setup-token`. Store it
in one secret and set `worker_claude_oauth_token_secret_arn` to the full ARN. The worker injects it
as `CLAUDE_CODE_OAUTH_TOKEN`; the task cgroup cannot obtain the worker's AWS role. Replace the
secret before the setup token expires or after it is revoked. In every mode, put only secret ARNs
in OpenTofu inputs. Never put credential values in the image, variable files, tags, or cloud-init.

Copy the AMI ID and matching `image_version` into the selected `worker_profiles` entry before applying OpenTofu. To roll back, restore the prior pair and apply again. OpenTofu creates a new launch-template version for future workers; an active worker keeps the AMI and toolchain it launched with.

## Remote state

OpenTofu is pinned to 1.12.5. The S3 backend uses native lock files, encryption, and tagged state and lock objects. Credentials come from the AWS CLI configuration, never backend arguments or variable files.

Create the retained state bucket once with CloudFormation, then initialize OpenTofu:

```powershell
./scripts/Initialize-RemoteState.ps1 `
  -BucketName "t3-cloud-agents-state-<aws-account-id>-us-west-1"

tofu init -reconfigure "-backend-config=backend.hcl"
```

CloudFormation retains the state bucket if its stack is deleted. `backend.hcl`, state files, variable files, and saved plans are ignored by Git.

## Configure and plan

Copy `terraform.tfvars.example` to `terraform.tfvars` and change only non-secret deployment settings. Image IDs, instance shapes, disks, CIDRs, TTL, artifact retention, and Linux worker profiles are configurable. Do not place credentials or provider tokens in variables.

For Git publication, add the full Secrets Manager ARNs for the SSH key and GitHub API token to
`controller_credential_secret_arns`. This grants `DescribeSecret` and `GetSecretValue` only to
the controller role. The worker role has no access to either master credential. Configure their
names or ARNs at controller runtime with `T3CODE_CLOUD_GIT_SSH_SECRET_REF` and
`T3CODE_CLOUD_GITHUB_TOKEN_SECRET_REF`; do not put secret values in OpenTofu variables.

Set the applicable provider secret ARNs in `terraform.tfvars`. Codex API-key and Claude setup-token
secrets receive read-only access. A Codex `auth.json` secret receives read/write access so refreshed
account credentials survive worker replacement. If a secret uses a customer-managed KMS key,
grant the worker role `kms:Decrypt` for that key separately; the Codex account-cache path also needs
the KMS permission required to write a new secret version.

The controller starts with no public ingress. CA-04 owns the authenticated application route and TLS setup. Until then, add only a trusted owner CIDR if you need to test port 443.

```powershell
tofu plan
tofu apply
```

The permanent controller has API termination protection. The retained EBS volume and artifact bucket also reject OpenTofu destruction by default. A worker instance launched from a template cannot delete any of those resources.

## Verify

The offline test uses mocked providers. It plans the protected configuration, applies an explicitly disposable configuration, checks ownership and encryption boundaries, and lets `tofu test` destroy the mock resources:

```powershell
tofu test
```

The AWS sandbox check creates billable resources for a few minutes. It uses a separate OpenTofu workspace, uploads a marker to retained storage, launches one worker, expires it through the cleanup Lambda, verifies the controller and marker survived, then destroys the sandbox:

```powershell
./scripts/Test-Sandbox.ps1 `
  -NamePrefix "t3-ca03-sandbox" `
  -ConfirmAwsChanges
```

If teardown fails, the script leaves the workspace in place and prints its name. Inspect that workspace before retrying `tofu destroy` with both protection overrides set for the same sandbox prefix.
