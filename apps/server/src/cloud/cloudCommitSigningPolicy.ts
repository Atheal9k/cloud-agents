/**
 * Pure publication-signing policy. The controller asks these functions whether
 * a caller may use the service key, what provenance a commit may carry, and
 * what to do on retry, rebase, rotation, or signer outage. Nothing here holds
 * a private key or talks to Git.
 */
import {
  DEFAULT_CLOUD_SPEND_PRINCIPAL,
  type CloudCommitProvenance,
  type CloudCommitProviderVerification,
  type CloudCommitSigningBacking,
  type RunAllocation,
} from "@t3tools/contracts";

export const CLOUD_COMMIT_SIGNING_IDENTITY_NAME = "T3 Cloud Controller";
export const CLOUD_COMMIT_SIGNING_IDENTITY_EMAIL = "cloud-controller@t3.codes";
export const CLOUD_COMMIT_SIGNING_SERVICE_IDENTITY = "t3-cloud-controller";

const PROMPT_OR_SECRET = /\b(prompt|password|secret|token|authorization|sk-[a-z0-9]+)\b/i;

export type CloudCommitSignerCaller =
  | {
      readonly kind: "trusted-publication";
      readonly repository: string;
      readonly identity: string;
    }
  | { readonly kind: "task-code" }
  | {
      readonly kind: "arbitrary";
      readonly repository: string;
      readonly identity: string;
    };

export function authorizeCloudCommitSigner(input: {
  readonly caller: CloudCommitSignerCaller;
  readonly allowedRepository: string;
}): { readonly allowed: true } | { readonly allowed: false; readonly message: string } {
  if (input.caller.kind !== "trusted-publication") {
    return {
      allowed: false,
      message: "The commit signer is only available to controller-owned publication.",
    };
  }
  if (input.caller.identity !== CLOUD_COMMIT_SIGNING_SERVICE_IDENTITY) {
    return {
      allowed: false,
      message: "The commit signer refuses identities other than the cloud publication service.",
    };
  }
  if (input.caller.repository !== input.allowedRepository) {
    return {
      allowed: false,
      message: "The commit signer refuses repositories other than the recorded publication target.",
    };
  }
  return { allowed: true };
}

export type CloudCommitSigningDecision =
  | { readonly action: "reuse"; readonly commit: string }
  | { readonly action: "sign" }
  | { readonly action: "resign" }
  | { readonly action: "reject-force-push"; readonly message: string }
  | { readonly action: "retry-outage"; readonly message: string };

export function decideCloudCommitSigning(input: {
  readonly remoteCommit: string | null;
  readonly localCommit: string | null;
  readonly published: boolean;
  readonly existingSignedCommit?: string;
  readonly existingKeyId?: string;
  readonly currentKeyId: string;
  readonly signerAvailable: boolean;
  readonly forcePush?: boolean;
}): CloudCommitSigningDecision {
  if (input.forcePush === true) {
    return {
      action: "reject-force-push",
      message: "Trusted publication never force-pushes a signed branch.",
    };
  }
  if (
    input.remoteCommit !== null &&
    input.localCommit !== null &&
    input.remoteCommit !== input.localCommit
  ) {
    return {
      action: "reject-force-push",
      message:
        "The remote publication branch contains a different commit. The controller will not force push it.",
    };
  }
  if (input.published && input.existingSignedCommit !== undefined) {
    return { action: "reuse", commit: input.existingSignedCommit };
  }
  if (!input.signerAvailable) {
    return {
      action: "retry-outage",
      message: "The commit signer is unavailable. Trusted publication will not push an unsigned commit.",
    };
  }
  if (
    input.existingSignedCommit !== undefined &&
    input.existingKeyId === input.currentKeyId &&
    (input.remoteCommit === null || input.remoteCommit === input.existingSignedCommit)
  ) {
    return { action: "reuse", commit: input.existingSignedCommit };
  }
  if (
    input.existingSignedCommit !== undefined &&
    input.existingKeyId !== undefined &&
    input.existingKeyId !== input.currentKeyId &&
    input.remoteCommit === null
  ) {
    return { action: "resign" };
  }
  if (input.existingSignedCommit !== undefined && input.remoteCommit === input.existingSignedCommit) {
    return { action: "reuse", commit: input.existingSignedCommit };
  }
  return { action: "sign" };
}

export function collectCloudCommitProvenance(input: {
  readonly allocation: RunAllocation;
  readonly repository: string;
  readonly principal?: CloudCommitProvenance["principal"];
}): CloudCommitProvenance {
  const selection = input.allocation.execution?.turn.modelSelection;
  const environment =
    input.allocation.environment === undefined
      ? undefined
      : `${input.allocation.environment.environmentId}:${input.allocation.environment.version}`;
  return {
    ...(input.allocation.control === undefined
      ? {}
      : { agentId: input.allocation.control.agentId, runId: input.allocation.control.runId }),
    ...(environment === undefined ? {} : { environmentVersion: environment }),
    ...(input.allocation.build === undefined ? {} : { buildId: input.allocation.build.buildId }),
    baseCommit: input.allocation.target.baseCommit,
    repository: input.repository,
    ...(selection === undefined
      ? {}
      : {
          provider: selection.instanceId,
          ...(selection.model === undefined ? {} : { model: selection.model }),
        }),
    principal: input.principal ?? DEFAULT_CLOUD_SPEND_PRINCIPAL,
  };
}

export function cloudCommitMessageWithProvenance(
  title: string,
  provenance: CloudCommitProvenance,
): string {
  const lines = [
    title.trim(),
    "",
    `T3-Cloud-Agent: ${provenance.agentId ?? "none"}`,
    `T3-Cloud-Run: ${provenance.runId ?? "none"}`,
    `T3-Cloud-Environment: ${provenance.environmentVersion ?? "none"}`,
    `T3-Cloud-Build: ${provenance.buildId ?? "none"}`,
    `T3-Cloud-Base: ${provenance.baseCommit}`,
    `T3-Cloud-Provider: ${provenance.provider ?? "none"}`,
    `T3-Cloud-Model: ${provenance.model ?? "none"}`,
    `T3-Cloud-Principal: ${provenance.principal.kind}:${provenance.principal.id}`,
  ];
  const message = `${lines.join("\n")}\n`;
  if (PROMPT_OR_SECRET.test(message)) {
    return `${title.trim()}\n\nT3-Cloud-Base: ${provenance.baseCommit}\n`;
  }
  return message;
}

export function cloudPullRequestBodyWithProvenance(
  body: string,
  provenance: CloudCommitProvenance,
): string {
  const section = [
    "## Provenance",
    "",
    `- Agent: ${provenance.agentId ?? "none"}`,
    `- Run: ${provenance.runId ?? "none"}`,
    `- Environment: ${provenance.environmentVersion ?? "none"}`,
    `- Build: ${provenance.buildId ?? "none"}`,
    `- Base: ${provenance.baseCommit}`,
    `- Provider: ${provenance.provider ?? "none"}`,
    `- Model: ${provenance.model ?? "none"}`,
    `- Principal: ${provenance.principal.kind}:${provenance.principal.id}`,
    provenance.signature === undefined
      ? "- Signature: pending"
      : `- Signature: ${provenance.signature.algorithm} ${provenance.signature.fingerprint} (${provenance.signature.backing})`,
  ].join("\n");
  const combined = body.trim().length === 0 ? section : `${body.trim()}\n\n${section}`;
  return PROMPT_OR_SECRET.test(combined) ? section : combined;
}

export function cloudCommitProviderVerification(input: {
  readonly publicKey: string;
  readonly fingerprint: string;
}): ReadonlyArray<CloudCommitProviderVerification> {
  const providers = ["github", "gitlab", "bitbucket", "azure-devops"] as const;
  return providers.map((provider) => ({
    provider,
    method: "ssh-commit-signature",
    publicKey: input.publicKey,
    fingerprint: input.fingerprint,
  }));
}

export function cloudCommitSigningBacking(kmsKeyArn: string | undefined): CloudCommitSigningBacking {
  return kmsKeyArn !== undefined && kmsKeyArn.trim().length > 0 ? "kms" : "hsm";
}

export function cloudProvenanceAuditSummary(provenance: CloudCommitProvenance): string {
  const summary = `Signed publication commit for ${provenance.repository} (agent ${provenance.agentId ?? "none"}, run ${provenance.runId ?? "none"}).`;
  return PROMPT_OR_SECRET.test(summary)
    ? `Signed publication commit for ${provenance.repository}.`
    : summary;
}
