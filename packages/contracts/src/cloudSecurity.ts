import * as Schema from "effect/Schema";

import {
  CloudAgentId,
  CloudEnvironmentId,
  CloudRunId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Runtime identity tokens are deliberately short-lived; nothing caches them. */
export const CLOUD_RUNTIME_TOKEN_TTL_SECONDS = 300;
/** Allow a little clock drift when verifying, but never more than the TTL. */
export const CLOUD_RUNTIME_TOKEN_CLOCK_SKEW_SECONDS = 30;
export const CLOUD_RUNTIME_IDENTITY_RATE_LIMIT_PER_MINUTE = 60;
export const CLOUD_RUNTIME_IDENTITY_ISSUER = "https://cloud.t3.codes";
export const CLOUD_RUNTIME_IDENTITY_AUDIENCE = "t3-cloud-runtime";
export const CLOUD_RUNTIME_IDENTITY_METADATA_PATH = "/metadata";
export const CLOUD_RUNTIME_IDENTITY_TOKEN_PATH = "/token";
export const CLOUD_RUNTIME_IDENTITY_JWKS_PATH = "/.well-known/jwks.json";
/** A short-lived SCM credential may not outlive the run that asked for it. */
export const CLOUD_SCM_CREDENTIAL_MAX_TTL_SECONDS = 60 * 60;
export const CLOUD_ASSUME_ROLE_MAX_SESSION_SECONDS = 60 * 60;

export const CloudSecretScope = Schema.Literals(["user", "team", "environment"]);
export type CloudSecretScope = typeof CloudSecretScope.Type;

/**
 * `build` values reach the Build and never the runtime, so they cannot leak out
 * of a snapshot. `runtime` and `runtime-redacted` values are injected into the
 * guest on each boot; only the redacted kind is scrubbed from what the agent
 * and the transcript can observe.
 */
export const CloudSecretAvailability = Schema.Literals(["build", "runtime", "runtime-redacted"]);
export type CloudSecretAvailability = typeof CloudSecretAvailability.Type;

export const CloudSecretPhase = Schema.Literals(["build", "runtime"]);
export type CloudSecretPhase = typeof CloudSecretPhase.Type;

const EnvironmentVariableName = Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/));

/**
 * A declaration, never a value. `owner` identifies the user or team the scope
 * belongs to so two people's `user` secrets never collide.
 */
export const CloudSecretDefinition = Schema.Struct({
  name: EnvironmentVariableName,
  reference: TrimmedNonEmptyString,
  scope: CloudSecretScope,
  availability: CloudSecretAvailability,
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  environmentId: Schema.optionalKey(CloudEnvironmentId),
});
export type CloudSecretDefinition = typeof CloudSecretDefinition.Type;

export const CloudSecretBinding = Schema.Struct({
  name: EnvironmentVariableName,
  reference: TrimmedNonEmptyString,
  scope: CloudSecretScope,
  availability: CloudSecretAvailability,
  phase: CloudSecretPhase,
  /** True when the value must be scrubbed from logs, transcripts, and results. */
  redacted: Schema.Boolean,
});
export type CloudSecretBinding = typeof CloudSecretBinding.Type;

export const CloudSecretResolution = Schema.Struct({
  phase: CloudSecretPhase,
  bindings: Schema.Array(CloudSecretBinding),
  /** Names shadowed by a narrower scope, so the UI can explain the winner. */
  shadowed: Schema.Array(Schema.Struct({ name: EnvironmentVariableName, scope: CloudSecretScope })),
});
export type CloudSecretResolution = typeof CloudSecretResolution.Type;

/**
 * The three modes the ticket requires. The Cursor `environment.json` spelling
 * carries four values because it folds parent inheritance into the mode; the
 * resolver splits that back out into `inheritTeamAllowlist`.
 */
export const CloudEgressMode = Schema.Literals([
  "allow_all",
  "default_with_allowlist",
  "allowlist_only",
]);
export type CloudEgressMode = typeof CloudEgressMode.Type;

export const CloudEgressExceptionKind = Schema.Literals([
  "controller",
  "scm",
  "artifact",
  "cursor",
]);
export type CloudEgressExceptionKind = typeof CloudEgressExceptionKind.Type;

/**
 * Destinations a runtime always reaches. They are listed rather than implied so
 * an operator reading a policy can see exactly what an allowlist-only guest can
 * still talk to.
 */
export const CloudEgressException = Schema.Struct({
  kind: CloudEgressExceptionKind,
  host: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
});
export type CloudEgressException = typeof CloudEgressException.Type;

export const CloudEgressPolicyInput = Schema.Struct({
  mode: CloudEgressMode,
  allowlist: Schema.Array(TrimmedNonEmptyString),
  inheritTeamAllowlist: Schema.optionalKey(Schema.Boolean),
  /** Only a team policy may set this; it stops environments widening egress. */
  adminLocked: Schema.optionalKey(Schema.Boolean),
});
export type CloudEgressPolicyInput = typeof CloudEgressPolicyInput.Type;

export const CloudEgressPolicySource = Schema.Literals(["team", "environment", "narrowed"]);
export type CloudEgressPolicySource = typeof CloudEgressPolicySource.Type;

export const CloudEgressPolicy = Schema.Struct({
  mode: CloudEgressMode,
  allowlist: Schema.Array(TrimmedNonEmptyString),
  exceptions: Schema.Array(CloudEgressException),
  adminLocked: Schema.Boolean,
  source: CloudEgressPolicySource,
  /** Set when an admin lock forced a narrower mode than the environment asked for. */
  overriddenMode: Schema.optionalKey(CloudEgressMode),
});
export type CloudEgressPolicy = typeof CloudEgressPolicy.Type;

export const CloudEgressDecision = Schema.Struct({
  host: TrimmedNonEmptyString,
  allowed: Schema.Boolean,
  rule: Schema.Literals(["allow-all", "default-set", "allowlist", "exception", "denied"]),
  reason: TrimmedNonEmptyString,
});
export type CloudEgressDecision = typeof CloudEgressDecision.Type;

export const CloudRuntimeHosting = Schema.Literals(["managed", "self-hosted"]);
export type CloudRuntimeHosting = typeof CloudRuntimeHosting.Type;

export const CloudRuntimeIdentitySubject = Schema.Struct({
  agentId: CloudAgentId,
  ownerId: TrimmedNonEmptyString,
  runId: CloudRunId,
  workspaceId: TrimmedNonEmptyString,
  environmentId: CloudEnvironmentId,
  repositories: Schema.Array(TrimmedNonEmptyString),
  hosting: CloudRuntimeHosting,
});
export type CloudRuntimeIdentitySubject = typeof CloudRuntimeIdentitySubject.Type;

/** The `run` is the ticket's "turn": one submitted turn of an agent. */
export const CloudRuntimeIdentityClaims = Schema.Struct({
  iss: TrimmedNonEmptyString,
  sub: TrimmedNonEmptyString,
  aud: TrimmedNonEmptyString,
  iat: NonNegativeInt,
  exp: NonNegativeInt,
  jti: TrimmedNonEmptyString,
  agent_id: TrimmedNonEmptyString,
  owner_id: TrimmedNonEmptyString,
  run_id: TrimmedNonEmptyString,
  workspace_id: TrimmedNonEmptyString,
  environment_id: TrimmedNonEmptyString,
  repositories: Schema.Array(TrimmedNonEmptyString),
  hosting: CloudRuntimeHosting,
});
export type CloudRuntimeIdentityClaims = typeof CloudRuntimeIdentityClaims.Type;

/** Non-secret facts a guest may read without spending a token request. */
export const CloudRuntimeMetadata = Schema.Struct({
  agentId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  ownerId: TrimmedNonEmptyString,
  workspaceId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  repositories: Schema.Array(TrimmedNonEmptyString),
  hosting: CloudRuntimeHosting,
  issuer: TrimmedNonEmptyString,
  jwksPath: TrimmedNonEmptyString,
  tokenPath: TrimmedNonEmptyString,
  tokenTtlSeconds: PositiveInt,
  egress: CloudEgressPolicy,
  /** Names and availability only. Values never appear in metadata. */
  secrets: Schema.Array(CloudSecretBinding),
});
export type CloudRuntimeMetadata = typeof CloudRuntimeMetadata.Type;

export const CloudRuntimeToken = Schema.Struct({
  token: TrimmedNonEmptyString,
  tokenType: Schema.Literal("Bearer"),
  expiresIn: PositiveInt,
  expiresAt: IsoDateTime,
  claims: CloudRuntimeIdentityClaims,
});
export type CloudRuntimeToken = typeof CloudRuntimeToken.Type;

export const CloudJsonWebKey = Schema.Struct({
  kty: Schema.Literal("OKP"),
  crv: Schema.Literal("Ed25519"),
  x: TrimmedNonEmptyString,
  kid: TrimmedNonEmptyString,
  use: Schema.Literal("sig"),
  alg: Schema.Literal("EdDSA"),
});
export type CloudJsonWebKey = typeof CloudJsonWebKey.Type;

export const CloudJsonWebKeySet = Schema.Struct({ keys: Schema.Array(CloudJsonWebKey) });
export type CloudJsonWebKeySet = typeof CloudJsonWebKeySet.Type;

export const CloudTlsVersion = Schema.Literals(["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"]);
export type CloudTlsVersion = typeof CloudTlsVersion.Type;

export const CloudEncryptedStore = Schema.Struct({
  encrypted: Schema.Boolean,
  keyId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudEncryptedStore = typeof CloudEncryptedStore.Type;

export const CloudEncryptionPosture = Schema.Struct({
  tlsMinimumVersion: CloudTlsVersion,
  /** CA-44 gives each guest its own disk key; identity ties it to the agent. */
  perAgentDiskKeyId: Schema.optionalKey(TrimmedNonEmptyString),
  snapshots: CloudEncryptedStore,
  artifacts: CloudEncryptedStore,
  customerManagedKeyArn: Schema.optionalKey(TrimmedNonEmptyString),
  /** No prompt, diff, or transcript leaves the environment for model training. */
  privacyMode: Schema.Boolean,
  secretRedaction: Schema.Boolean,
});
export type CloudEncryptionPosture = typeof CloudEncryptionPosture.Type;

export const CloudEncryptionFindingId = Schema.Literals([
  "tls-below-1-2",
  "missing-per-agent-key",
  "unencrypted-snapshots",
  "unencrypted-artifacts",
  "customer-key-unused",
  "privacy-mode-off",
  "redaction-off",
]);
export type CloudEncryptionFindingId = typeof CloudEncryptionFindingId.Type;

export const CloudEncryptionFinding = Schema.Struct({
  id: CloudEncryptionFindingId,
  severity: Schema.Literals(["blocking", "advisory"]),
  message: TrimmedNonEmptyString,
});
export type CloudEncryptionFinding = typeof CloudEncryptionFinding.Type;

export const CloudEncryptionVerification = Schema.Struct({
  ok: Schema.Boolean,
  findings: Schema.Array(CloudEncryptionFinding),
});
export type CloudEncryptionVerification = typeof CloudEncryptionVerification.Type;

export const CloudScmScope = Schema.Literals(["read", "write", "admin"]);
export type CloudScmScope = typeof CloudScmScope.Type;

export const CloudScmAssumeRole = Schema.Struct({
  roleArn: TrimmedNonEmptyString,
  sessionDurationSeconds: PositiveInt,
  externalId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudScmAssumeRole = typeof CloudScmAssumeRole.Type;

/**
 * Protected repositories need an explicit grant even when the triggering user
 * can reach them; blocked repositories are never reachable from a runtime.
 */
export const CloudScmAccessPolicy = Schema.Struct({
  protectedRepositories: Schema.Array(TrimmedNonEmptyString),
  blockedRepositories: Schema.Array(TrimmedNonEmptyString),
  grantedRepositories: Schema.Array(TrimmedNonEmptyString),
  maxScope: CloudScmScope,
  credentialTtlSeconds: PositiveInt,
  assumeRole: Schema.optionalKey(CloudScmAssumeRole),
});
export type CloudScmAccessPolicy = typeof CloudScmAccessPolicy.Type;

export const CloudScmAccessRequest = Schema.Struct({
  repository: TrimmedNonEmptyString,
  scope: CloudScmScope,
  /** What the person who triggered the run can actually do, from the SCM. */
  userRepositories: Schema.Array(TrimmedNonEmptyString),
  userScope: CloudScmScope,
});
export type CloudScmAccessRequest = typeof CloudScmAccessRequest.Type;

export const CloudScmAccessDenialReason = Schema.Literals([
  "blocked",
  "not-granted",
  "outside-user-access",
  "scope-exceeds-user",
  "scope-exceeds-policy",
]);
export type CloudScmAccessDenialReason = typeof CloudScmAccessDenialReason.Type;

export const CloudScmAccessDecision = Schema.Union([
  Schema.Struct({
    allowed: Schema.Literal(true),
    repository: TrimmedNonEmptyString,
    scope: CloudScmScope,
    credentialTtlSeconds: PositiveInt,
    assumeRole: Schema.optionalKey(CloudScmAssumeRole),
  }),
  Schema.Struct({
    allowed: Schema.Literal(false),
    repository: TrimmedNonEmptyString,
    reason: CloudScmAccessDenialReason,
    message: TrimmedNonEmptyString,
  }),
]);
export type CloudScmAccessDecision = typeof CloudScmAccessDecision.Type;

/** What the readiness report shows for one environment's security posture. */
export const CloudSecurityPosture = Schema.Struct({
  environmentId: CloudEnvironmentId,
  egress: CloudEgressPolicy,
  buildSecrets: Schema.Array(CloudSecretBinding),
  runtimeSecrets: Schema.Array(CloudSecretBinding),
  scm: CloudScmAccessPolicy,
});
export type CloudSecurityPosture = typeof CloudSecurityPosture.Type;

/** Encryption is a controller-wide fact; egress and secrets are per environment. */
export const CloudSecurityReport = Schema.Struct({
  encryption: CloudEncryptionVerification,
  environments: Schema.Array(CloudSecurityPosture),
});
export type CloudSecurityReport = typeof CloudSecurityReport.Type;

export class CloudSecurityError extends Schema.TaggedError<CloudSecurityError>()(
  "CloudSecurityError",
  {
    reason: Schema.Literals([
      "identity-unavailable",
      "invalid-token",
      "token-expired",
      "unknown-key",
      "rate-limited",
      "policy-locked",
      "invalid-policy",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
