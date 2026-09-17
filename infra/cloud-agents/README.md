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
  -var "image_version=0.0.42-ca07.2" `
  ./image
```

The default `linux-web` image has no mobile SDK, X server, or display-stream service. To prepare the dormant desktop library layer for the CA-34 shared-browser profile, build a separate image with `profile_name=linux-web-browser` and `install_desktop_dependencies=true`. This installs Xvfb and browser runtime libraries but does not install or start a streaming service.

The image enables `cloud-agent-worker.service`. T3, Codex, Claude Code, and every child process run as `cloudagent` in one systemd cgroup. Claude Code uses `/run/t3-worker/credentials/claude` and does not check for automatic updates. The unit drops capabilities, blocks EC2 metadata for the cgroup, restricts writable paths, kills the whole cgroup on stop, and clears `/run/t3-worker/credentials` after success or failure. Its preflight checks the pinned tools and confirms an IMDSv2 token cannot be obtained before T3 starts. The worker role has no access to the controller's Git or GitHub secrets.

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
