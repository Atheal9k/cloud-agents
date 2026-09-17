# Personal AWS stack

This OpenTofu stack creates the CA-03 infrastructure boundary:

- one permanent Linux controller with a stable Elastic IP and retained encrypted data volume;
- disposable Linux worker launch templates with encrypted root volumes;
- separate controller, worker, and cleanup identities;
- controller-only worker ingress and configurable trusted HTTPS ingress to the controller;
- an encrypted, versioned artifact bucket;
- fixed SSM recovery diagnostics that cannot launch agent jobs; and
- a scheduled cleanup function that terminates expired tagged workers even when the controller is unavailable.

The default Amazon Linux images do not contain T3 binaries. Cloud-init installs systemd units that start `/opt/t3/bin/t3-controller` or `/opt/t3/bin/cloud-agent-worker` when a later image ticket supplies those executables. Normal startup does not call SSM.

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
