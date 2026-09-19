/**
 * Pure security policy for cloud environments and runtimes: which secrets a
 * phase may see, where a guest may talk, what an identity token may claim, and
 * how wide a runtime's source-control access may be. Nothing here performs I/O
 * or holds a secret value, so the same decisions can be replayed in a test, in
 * the readiness report, and on the guest.
 */
import {
  CLOUD_ASSUME_ROLE_MAX_SESSION_SECONDS,
  CLOUD_RUNTIME_TOKEN_CLOCK_SKEW_SECONDS,
  CLOUD_RUNTIME_TOKEN_TTL_SECONDS,
  CLOUD_SCM_CREDENTIAL_MAX_TTL_SECONDS,
  CloudSecurityError,
  type CloudEgressDecision,
  type CloudEgressException,
  type CloudEgressMode,
  type CloudEgressPolicy,
  type CloudEgressPolicyInput,
  type CloudEncryptionFinding,
  type CloudEncryptionPosture,
  type CloudEncryptionVerification,
  type CloudEnvironmentConfig,
  type CloudRuntimeIdentityClaims,
  type CloudRuntimeIdentitySubject,
  type CloudScmAccessDecision,
  type CloudScmAccessPolicy,
  type CloudScmAccessRequest,
  type CloudScmScope,
  type CloudSecretBinding,
  type CloudSecretDefinition,
  type CloudSecretPhase,
  type CloudSecretResolution,
  type CloudSecretScope,
} from "@t3tools/contracts";

/**
 * Reachable in `default_with_allowlist` without anybody listing them. Package
 * ecosystems only: source control and artifacts arrive as explicit exceptions
 * so that an allowlist-only guest still gets them and an operator can see why.
 */
export const CLOUD_DEFAULT_EGRESS_HOSTS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  "crates.io",
  "static.crates.io",
  "deb.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
] as const;

/** A value shorter than this would shred ordinary output if we replaced it. */
export const CLOUD_SECRET_MIN_REDACTION_LENGTH = 4;

const DEFAULT_EGRESS_POLICY_INPUT: CloudEgressPolicyInput = {
  mode: "default_with_allowlist",
  allowlist: [],
};

/**
 * Cursor's `environment.json` folds parent inheritance into the mode word. The
 * three modes the controller reasons about are the ticket's, so inheritance
 * comes back out as its own flag.
 */
export function cloudEgressPolicyInputFromConfig(
  config: Pick<CloudEnvironmentConfig, "egressMode" | "egressAllowlist">,
): CloudEgressPolicyInput {
  const allowlist = config.egressAllowlist ?? [];
  switch (config.egressMode ?? "default_with_network_settings") {
    case "allow_all":
      return { mode: "allow_all", allowlist };
    case "parent_plus_network_settings":
      return { mode: "default_with_allowlist", allowlist, inheritTeamAllowlist: true };
    case "default_with_network_settings":
      return { mode: "default_with_allowlist", allowlist };
    case "network_settings_only":
      return { mode: "allowlist_only", allowlist };
  }
}

export function cloudEgressExceptions(input: {
  readonly controllerHost: string;
  readonly scmHosts: ReadonlyArray<string>;
  readonly artifactHosts: ReadonlyArray<string>;
}): ReadonlyArray<CloudEgressException> {
  return [
    {
      kind: "controller" as const,
      host: input.controllerHost,
      reason: "The runtime reports run state and receives control here.",
    },
    ...input.scmHosts.map((host) => ({
      kind: "scm" as const,
      host,
      reason: "Clone and push run through the trusted credential wrapper.",
    })),
    ...input.artifactHosts.map((host) => ({
      kind: "artifact" as const,
      host,
      reason: "Snapshots, diffs, and artifacts are uploaded here.",
    })),
  ];
}

function egressRank(mode: CloudEgressMode): number {
  switch (mode) {
    case "allowlist_only":
      return 0;
    case "default_with_allowlist":
      return 1;
    case "allow_all":
      return 2;
  }
}

function dedupe(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

/**
 * A team policy with `adminLocked` is a ceiling: an environment may narrow it
 * and may not widen it, in either the mode or the allowlist. Without the lock
 * the environment wins outright, optionally inheriting the team's allowlist.
 */
export function resolveCloudEgressPolicy(input: {
  readonly team?: CloudEgressPolicyInput | undefined;
  readonly environment?: CloudEgressPolicyInput | undefined;
  readonly exceptions: ReadonlyArray<CloudEgressException>;
}): CloudEgressPolicy {
  const team = input.team;
  const environment = input.environment;
  const base = environment ?? team ?? DEFAULT_EGRESS_POLICY_INPUT;
  const locked = team?.adminLocked === true;

  let source: CloudEgressPolicy["source"] = environment === undefined ? "team" : "environment";
  let mode = base.mode;
  let overriddenMode: CloudEgressMode | undefined;
  let allowlist = dedupe(
    environment !== undefined && team !== undefined && environment.inheritTeamAllowlist === true
      ? [...environment.allowlist, ...team.allowlist]
      : base.allowlist,
  );

  if (locked && team !== undefined) {
    if (egressRank(mode) > egressRank(team.mode)) {
      overriddenMode = mode;
      mode = team.mode;
      source = "narrowed";
    }
    if (team.mode !== "allow_all") {
      const ceiling = new Set(team.allowlist);
      const narrowed = allowlist.filter((host) => ceiling.has(host));
      if (narrowed.length !== allowlist.length) source = "narrowed";
      allowlist = narrowed;
    }
  }

  return {
    mode,
    allowlist,
    exceptions: input.exceptions,
    adminLocked: locked,
    source,
    ...(overriddenMode === undefined ? {} : { overriddenMode }),
  };
}

/** Exact host, or a `*.example.com` / `.example.com` suffix. */
export function cloudEgressHostMatches(pattern: string, host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  if (normalizedPattern === normalizedHost) return true;
  const suffix = normalizedPattern.startsWith("*.")
    ? normalizedPattern.slice(1)
    : normalizedPattern.startsWith(".")
      ? normalizedPattern
      : undefined;
  return suffix !== undefined && normalizedHost.endsWith(suffix);
}

export function evaluateCloudEgress(input: {
  readonly policy: CloudEgressPolicy;
  readonly host: string;
}): CloudEgressDecision {
  const host = input.host.trim().toLowerCase();
  const exception = input.policy.exceptions.find((entry) =>
    cloudEgressHostMatches(entry.host, host),
  );
  if (exception !== undefined) {
    return { host, allowed: true, rule: "exception", reason: exception.reason };
  }
  if (input.policy.mode === "allow_all") {
    return { host, allowed: true, rule: "allow-all", reason: "Egress is unrestricted." };
  }
  if (input.policy.allowlist.some((pattern) => cloudEgressHostMatches(pattern, host))) {
    return { host, allowed: true, rule: "allowlist", reason: "The host is on the allowlist." };
  }
  if (
    input.policy.mode === "default_with_allowlist" &&
    CLOUD_DEFAULT_EGRESS_HOSTS.some((pattern) => cloudEgressHostMatches(pattern, host))
  ) {
    return { host, allowed: true, rule: "default-set", reason: "The host is a default registry." };
  }
  return {
    host,
    allowed: false,
    rule: "denied",
    reason:
      input.policy.mode === "allowlist_only"
        ? "Only allowlisted hosts and explicit exceptions are reachable."
        : "The host is on neither the default set nor the allowlist.",
  };
}

function secretScopePriority(scope: CloudSecretScope): number {
  switch (scope) {
    case "environment":
      return 0;
    case "user":
      return 1;
    case "team":
      return 2;
  }
}

function secretAppliesTo(
  definition: CloudSecretDefinition,
  run: {
    readonly environmentId: string;
    readonly userId: string;
    readonly teamId?: string | undefined;
  },
): boolean {
  switch (definition.scope) {
    case "environment":
      return (
        definition.environmentId === undefined || definition.environmentId === run.environmentId
      );
    case "user":
      return definition.owner === run.userId;
    case "team":
      return definition.owner === undefined || definition.owner === run.teamId;
  }
}

/**
 * A Build's disk is shared by every run of the environment, so a user-scoped
 * value never enters one even when it is labelled `build`. That matches what
 * `cloudEnvironmentBuildSecrets` actually injects, so this resolution cannot
 * promise a binding the Build runner then refuses.
 */
function availableInPhase(definition: CloudSecretDefinition, phase: CloudSecretPhase): boolean {
  return phase === "build"
    ? definition.availability === "build" && definition.scope !== "user"
    : definition.availability !== "build";
}

/**
 * Narrowest scope wins: the environment's own value, then the triggering user's,
 * then the team default. Build-only values never appear in a runtime resolution
 * and runtime values never enter a Build, which is what keeps a build secret out
 * of the snapshot an agent later boots.
 */
export function resolveCloudSecretBindings(input: {
  readonly definitions: ReadonlyArray<CloudSecretDefinition>;
  readonly phase: CloudSecretPhase;
  readonly environmentId: string;
  readonly userId: string;
  readonly teamId?: string | undefined;
}): CloudSecretResolution {
  const applicable = input.definitions
    .filter((definition) => secretAppliesTo(definition, input))
    .filter((definition) => availableInPhase(definition, input.phase));

  const winners = new Map<string, CloudSecretDefinition>();
  const shadowed: Array<{ name: string; scope: CloudSecretScope }> = [];
  for (const definition of applicable) {
    const current = winners.get(definition.name);
    if (current === undefined) {
      winners.set(definition.name, definition);
      continue;
    }
    const [winner, loser] =
      secretScopePriority(definition.scope) < secretScopePriority(current.scope)
        ? [definition, current]
        : [current, definition];
    winners.set(definition.name, winner);
    shadowed.push({ name: loser.name, scope: loser.scope });
  }

  const bindings: ReadonlyArray<CloudSecretBinding> = [...winners.values()]
    .map((definition) => ({
      name: definition.name,
      reference: definition.reference,
      scope: definition.scope,
      availability: definition.availability,
      phase: input.phase,
      redacted: definition.availability === "runtime-redacted",
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  return {
    phase: input.phase,
    bindings,
    shadowed: shadowed.sort((left, right) => (left.name < right.name ? -1 : 1)),
  };
}

/**
 * Scrubs resolved secret values out of anything a user or an agent can read.
 * Longest first, so a value that contains a shorter one does not leave a
 * fragment behind.
 */
export function redactCloudSecretValues(
  text: string,
  values: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): string {
  return [...values]
    .filter((entry) => entry.value.length >= CLOUD_SECRET_MIN_REDACTION_LENGTH)
    .sort((left, right) => right.value.length - left.value.length)
    .reduce(
      (redacted, entry) => redacted.split(entry.value).join(`[redacted:${entry.name}]`),
      text,
    );
}

export function verifyCloudEncryptionPosture(
  posture: CloudEncryptionPosture,
): CloudEncryptionVerification {
  const findings: CloudEncryptionFinding[] = [];
  if (posture.tlsMinimumVersion === "TLSv1" || posture.tlsMinimumVersion === "TLSv1.1") {
    findings.push({
      id: "tls-below-1-2",
      severity: "blocking",
      message: `Client and worker transports must negotiate TLS 1.2 or newer; this controller allows ${posture.tlsMinimumVersion}.`,
    });
  }
  if (posture.perAgentDiskKeyId === undefined) {
    findings.push({
      id: "missing-per-agent-key",
      severity: "blocking",
      message: "This runtime has no per-agent disk key, so guests share encryption material.",
    });
  }
  if (!posture.snapshots.encrypted) {
    findings.push({
      id: "unencrypted-snapshots",
      severity: "blocking",
      message: "Environment snapshots are stored without encryption.",
    });
  }
  if (!posture.artifacts.encrypted) {
    findings.push({
      id: "unencrypted-artifacts",
      severity: "blocking",
      message: "Run artifacts are stored without encryption.",
    });
  }
  if (!posture.secretRedaction) {
    findings.push({
      id: "redaction-off",
      severity: "blocking",
      message: "Runtime-redacted secrets would reach transcripts and results unscrubbed.",
    });
  }
  const customerKey = posture.customerManagedKeyArn;
  if (
    customerKey !== undefined &&
    posture.snapshots.keyId !== customerKey &&
    posture.artifacts.keyId !== customerKey
  ) {
    findings.push({
      id: "customer-key-unused",
      severity: "advisory",
      message: "A customer-managed KMS key is configured but neither store uses it.",
    });
  }
  if (!posture.privacyMode) {
    findings.push({
      id: "privacy-mode-off",
      severity: "advisory",
      message: "Privacy Mode is off, so prompts and diffs may leave the environment.",
    });
  }
  return { ok: !findings.some((finding) => finding.severity === "blocking"), findings };
}

function scmScopeRank(scope: CloudScmScope): number {
  switch (scope) {
    case "read":
      return 0;
    case "write":
      return 1;
    case "admin":
      return 2;
  }
}

/**
 * Exact name, or a trailing `*`. That covers `owner/*` for a whole
 * organisation and `owner/prefix-*` for a family of repositories; a blocklist
 * that quietly ignored the second spelling would be worse than none.
 */
function repositoryListed(list: ReadonlyArray<string>, repository: string): boolean {
  const normalized = repository.trim().toLowerCase();
  return list.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (candidate === normalized) return true;
    return candidate.endsWith("*") && normalized.startsWith(candidate.slice(0, -1));
  });
}

/**
 * A runtime never gets access the triggering user does not already have, and a
 * protected repository additionally needs its own grant. Credentials are minted
 * for the policy's TTL, clamped so nothing outlives an hour.
 */
export function evaluateCloudScmAccess(input: {
  readonly policy: CloudScmAccessPolicy;
  readonly request: CloudScmAccessRequest;
}): CloudScmAccessDecision {
  const { policy, request } = input;
  const repository = request.repository;
  const deny = (
    reason: Extract<CloudScmAccessDecision, { allowed: false }>["reason"],
    message: string,
  ): CloudScmAccessDecision => ({ allowed: false, repository, reason, message });

  if (repositoryListed(policy.blockedRepositories, repository)) {
    return deny("blocked", `'${repository}' is on the environment's repository blocklist.`);
  }
  if (!repositoryListed(request.userRepositories, repository)) {
    return deny(
      "outside-user-access",
      `The user who triggered this run cannot reach '${repository}'.`,
    );
  }
  if (
    repositoryListed(policy.protectedRepositories, repository) &&
    !repositoryListed(policy.grantedRepositories, repository)
  ) {
    return deny("not-granted", `'${repository}' is protected and was not granted to this agent.`);
  }
  if (scmScopeRank(request.scope) > scmScopeRank(request.userScope)) {
    return deny(
      "scope-exceeds-user",
      `'${request.scope}' is wider than the triggering user's '${request.userScope}' access.`,
    );
  }
  if (scmScopeRank(request.scope) > scmScopeRank(policy.maxScope)) {
    return deny(
      "scope-exceeds-policy",
      `'${request.scope}' is wider than the environment's '${policy.maxScope}' ceiling.`,
    );
  }

  const credentialTtlSeconds = Math.min(
    policy.credentialTtlSeconds,
    CLOUD_SCM_CREDENTIAL_MAX_TTL_SECONDS,
  );
  const assumeRole = policy.assumeRole;
  return {
    allowed: true,
    repository,
    scope: request.scope,
    credentialTtlSeconds,
    ...(assumeRole === undefined
      ? {}
      : {
          assumeRole: {
            ...assumeRole,
            sessionDurationSeconds: Math.min(
              assumeRole.sessionDurationSeconds,
              credentialTtlSeconds,
              CLOUD_ASSUME_ROLE_MAX_SESSION_SECONDS,
            ),
          },
        }),
  };
}

export function cloudRuntimeIdentityClaims(input: {
  readonly subject: CloudRuntimeIdentitySubject;
  readonly issuer: string;
  readonly audience: string;
  readonly nowSeconds: number;
  readonly jti: string;
  readonly ttlSeconds?: number | undefined;
}): CloudRuntimeIdentityClaims {
  const ttl = Math.min(
    input.ttlSeconds ?? CLOUD_RUNTIME_TOKEN_TTL_SECONDS,
    CLOUD_RUNTIME_TOKEN_TTL_SECONDS,
  );
  const issuedAt = Math.floor(input.nowSeconds);
  return {
    iss: input.issuer,
    sub: `agent:${input.subject.agentId}`,
    aud: input.audience,
    iat: issuedAt,
    exp: issuedAt + ttl,
    jti: input.jti,
    agent_id: input.subject.agentId,
    owner_id: input.subject.ownerId,
    run_id: input.subject.runId,
    workspace_id: input.subject.workspaceId,
    environment_id: input.subject.environmentId,
    repositories: input.subject.repositories,
    hosting: input.subject.hosting,
  };
}

/**
 * Checks the parts a signature cannot: who minted it, who it is for, and that
 * nobody minted a longer-lived token than the contract allows.
 */
export function verifyCloudRuntimeIdentityClaims(input: {
  readonly claims: CloudRuntimeIdentityClaims;
  readonly issuer: string;
  readonly audience: string;
  readonly nowSeconds: number;
}): CloudSecurityError | undefined {
  const { claims } = input;
  if (claims.iss !== input.issuer) {
    return new CloudSecurityError({
      reason: "invalid-token",
      message: `Token issuer '${claims.iss}' is not this controller.`,
    });
  }
  if (claims.aud !== input.audience) {
    return new CloudSecurityError({
      reason: "invalid-token",
      message: `Token audience '${claims.aud}' is not the cloud runtime.`,
    });
  }
  if (claims.exp - claims.iat > CLOUD_RUNTIME_TOKEN_TTL_SECONDS) {
    return new CloudSecurityError({
      reason: "invalid-token",
      message: `Token lifetime exceeds ${CLOUD_RUNTIME_TOKEN_TTL_SECONDS} seconds.`,
    });
  }
  if (input.nowSeconds > claims.exp + CLOUD_RUNTIME_TOKEN_CLOCK_SKEW_SECONDS) {
    return new CloudSecurityError({ reason: "token-expired", message: "The token has expired." });
  }
  if (input.nowSeconds + CLOUD_RUNTIME_TOKEN_CLOCK_SKEW_SECONDS < claims.iat) {
    return new CloudSecurityError({
      reason: "invalid-token",
      message: "The token was issued in the future.",
    });
  }
  return undefined;
}
