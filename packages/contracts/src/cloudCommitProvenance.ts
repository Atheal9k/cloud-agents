import * as Schema from "effect/Schema";

import { CloudAgentId, CloudRunId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Git SSH signatures are what GitHub, GitLab, Bitbucket, and Azure DevOps verify. */
export const CloudCommitSignatureFormat = Schema.Literal("ssh");
export type CloudCommitSignatureFormat = typeof CloudCommitSignatureFormat.Type;

export const CloudCommitSignatureAlgorithm = Schema.Literal("ssh-ed25519");
export type CloudCommitSignatureAlgorithm = typeof CloudCommitSignatureAlgorithm.Type;

/**
 * Where the per-service signing key lives. Task code never holds either form.
 * `kms` is a customer-managed KMS wrap; `hsm` is the controller-isolated
 * service key used when no KMS ARN is configured.
 */
export const CloudCommitSigningBacking = Schema.Literals(["kms", "hsm"]);
export type CloudCommitSigningBacking = typeof CloudCommitSigningBacking.Type;

export const CloudCommitSignature = Schema.Struct({
  keyId: TrimmedNonEmptyString,
  algorithm: CloudCommitSignatureAlgorithm,
  format: CloudCommitSignatureFormat,
  fingerprint: TrimmedNonEmptyString,
  backing: CloudCommitSigningBacking,
  signedAt: IsoDateTime,
});
export type CloudCommitSignature = typeof CloudCommitSignature.Type;

/**
 * Attribution for a trusted publication commit. There is no prompt, secret,
 * credential, or raw transcript field by construction.
 */
export const CloudCommitProvenance = Schema.Struct({
  agentId: Schema.optionalKey(CloudAgentId),
  runId: Schema.optionalKey(CloudRunId),
  environmentVersion: Schema.optionalKey(TrimmedNonEmptyString),
  buildId: Schema.optionalKey(TrimmedNonEmptyString),
  baseCommit: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  principal: Schema.Struct({
    kind: Schema.Literals(["user", "team", "service-account"]),
    id: TrimmedNonEmptyString,
  }),
  commit: Schema.optionalKey(TrimmedNonEmptyString),
  signature: Schema.optionalKey(CloudCommitSignature),
});
export type CloudCommitProvenance = typeof CloudCommitProvenance.Type;

export const CloudCommitSigningCallerKind = Schema.Literals([
  "trusted-publication",
  "task-code",
  "arbitrary",
]);
export type CloudCommitSigningCallerKind = typeof CloudCommitSigningCallerKind.Type;

export const CloudCommitProviderVerification = Schema.Struct({
  provider: Schema.Literals(["github", "gitlab", "bitbucket", "azure-devops"]),
  method: Schema.Literal("ssh-commit-signature"),
  publicKey: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
});
export type CloudCommitProviderVerification = typeof CloudCommitProviderVerification.Type;
