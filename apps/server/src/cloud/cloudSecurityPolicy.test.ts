import {
  CloudAgentId,
  CloudEnvironmentId,
  CloudRunId,
  type CloudEncryptionPosture,
  type CloudRuntimeIdentitySubject,
  type CloudScmAccessPolicy,
  type CloudSecretDefinition,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cloudEgressExceptions,
  cloudEgressPolicyInputFromConfig,
  cloudRuntimeIdentityClaims,
  evaluateCloudEgress,
  evaluateCloudScmAccess,
  redactCloudSecretValues,
  resolveCloudEgressPolicy,
  resolveCloudSecretBindings,
  verifyCloudEncryptionPosture,
  verifyCloudRuntimeIdentityClaims,
} from "./cloudSecurityPolicy.ts";

const EXCEPTIONS = cloudEgressExceptions({
  controllerHost: "controller.internal",
  scmHosts: ["github.com"],
  artifactHosts: ["artifacts.internal"],
});

function secret(
  overrides: Partial<CloudSecretDefinition> & Pick<CloudSecretDefinition, "name" | "scope">,
): CloudSecretDefinition {
  return {
    reference: `ref/${overrides.name.toLowerCase()}/${overrides.scope}`,
    availability: "runtime",
    ...overrides,
  };
}

describe("cloud secret resolution", () => {
  const definitions: ReadonlyArray<CloudSecretDefinition> = [
    secret({ name: "API_TOKEN", scope: "team", owner: "team-1" }),
    secret({ name: "API_TOKEN", scope: "user", owner: "user-1" }),
    secret({
      name: "API_TOKEN",
      scope: "environment",
      environmentId: CloudEnvironmentId.make("env-1"),
    }),
    secret({ name: "OTHER_USER_ONLY", scope: "user", owner: "user-2" }),
    secret({ name: "REGISTRY_TOKEN", scope: "team", owner: "team-1", availability: "build" }),
    secret({
      name: "DB_PASSWORD",
      scope: "user",
      owner: "user-1",
      availability: "runtime-redacted",
    }),
  ];
  const run = { environmentId: "env-1", userId: "user-1", teamId: "team-1" };

  it("gives the narrowest scope the name and records what it shadowed", () => {
    const resolved = resolveCloudSecretBindings({ definitions, phase: "runtime", ...run });

    expect(resolved.bindings.map((binding) => binding.name)).toEqual(["API_TOKEN", "DB_PASSWORD"]);
    expect(resolved.bindings[0]).toMatchObject({
      scope: "environment",
      reference: "ref/api_token/environment",
    });
    expect(resolved.shadowed).toEqual([
      { name: "API_TOKEN", scope: "team" },
      { name: "API_TOKEN", scope: "user" },
    ]);
  });

  it("keeps build-only values out of the runtime and runtime values out of the Build", () => {
    const build = resolveCloudSecretBindings({ definitions, phase: "build", ...run });
    const runtime = resolveCloudSecretBindings({ definitions, phase: "runtime", ...run });

    expect(build.bindings.map((binding) => binding.name)).toEqual(["REGISTRY_TOKEN"]);
    expect(runtime.bindings.map((binding) => binding.name)).not.toContain("REGISTRY_TOKEN");
  });

  it("marks only runtime-redacted values for scrubbing and never leaks another user's secret", () => {
    const resolved = resolveCloudSecretBindings({ definitions, phase: "runtime", ...run });

    expect(resolved.bindings.find((binding) => binding.name === "DB_PASSWORD")?.redacted).toBe(
      true,
    );
    expect(resolved.bindings.find((binding) => binding.name === "API_TOKEN")?.redacted).toBe(false);
    expect(resolved.bindings.map((binding) => binding.name)).not.toContain("OTHER_USER_ONLY");
  });
});

describe("secret redaction", () => {
  it("replaces the longest value first so no fragment survives", () => {
    const redacted = redactCloudSecretValues(
      "connect with sk-live-1234 and sk-live-1234-extended",
      [
        { name: "SHORT", value: "sk-live-1234" },
        { name: "LONG", value: "sk-live-1234-extended" },
      ],
    );

    expect(redacted).toBe("connect with [redacted:SHORT] and [redacted:LONG]");
  });

  it("leaves values too short to redact alone", () => {
    expect(redactCloudSecretValues("a b c", [{ name: "TINY", value: "a" }])).toBe("a b c");
  });
});

describe("egress policy", () => {
  it("splits Cursor's parent inheritance out of the mode word", () => {
    expect(
      cloudEgressPolicyInputFromConfig({
        egressMode: "parent_plus_network_settings",
        egressAllowlist: ["api.example.com"],
      }),
    ).toEqual({
      mode: "default_with_allowlist",
      allowlist: ["api.example.com"],
      inheritTeamAllowlist: true,
    });
    expect(cloudEgressPolicyInputFromConfig({})).toEqual({
      mode: "default_with_allowlist",
      allowlist: [],
    });
  });

  it("lets an unlocked environment override and optionally inherit the team allowlist", () => {
    const policy = resolveCloudEgressPolicy({
      team: { mode: "default_with_allowlist", allowlist: ["team.example.com"] },
      environment: {
        mode: "allowlist_only",
        allowlist: ["env.example.com"],
        inheritTeamAllowlist: true,
      },
      exceptions: EXCEPTIONS,
    });

    expect(policy).toMatchObject({
      mode: "allowlist_only",
      allowlist: ["env.example.com", "team.example.com"],
      adminLocked: false,
      source: "environment",
    });
  });

  it("stops a locked team policy being widened, in either the mode or the allowlist", () => {
    const policy = resolveCloudEgressPolicy({
      team: {
        mode: "allowlist_only",
        allowlist: ["team.example.com"],
        adminLocked: true,
      },
      environment: { mode: "allow_all", allowlist: ["team.example.com", "sneaky.example.com"] },
      exceptions: EXCEPTIONS,
    });

    expect(policy).toMatchObject({
      mode: "allowlist_only",
      allowlist: ["team.example.com"],
      adminLocked: true,
      source: "narrowed",
      overriddenMode: "allow_all",
    });
  });

  it("still allows a locked policy to be narrowed further", () => {
    const policy = resolveCloudEgressPolicy({
      team: { mode: "allow_all", allowlist: [], adminLocked: true },
      environment: { mode: "allowlist_only", allowlist: ["env.example.com"] },
      exceptions: EXCEPTIONS,
    });

    expect(policy).toMatchObject({ mode: "allowlist_only", allowlist: ["env.example.com"] });
  });

  it("reaches controller, SCM, and artifact hosts under allowlist-only", () => {
    const policy = resolveCloudEgressPolicy({
      environment: { mode: "allowlist_only", allowlist: ["*.example.com"] },
      exceptions: EXCEPTIONS,
    });

    expect(evaluateCloudEgress({ policy, host: "controller.internal" })).toMatchObject({
      allowed: true,
      rule: "exception",
    });
    expect(evaluateCloudEgress({ policy, host: "github.com" }).allowed).toBe(true);
    expect(evaluateCloudEgress({ policy, host: "api.example.com" })).toMatchObject({
      allowed: true,
      rule: "allowlist",
    });
    expect(evaluateCloudEgress({ policy, host: "registry.npmjs.org" })).toMatchObject({
      allowed: false,
      rule: "denied",
    });
  });

  it("adds the default registry set only in default-plus-allowlist mode", () => {
    const withDefaults = resolveCloudEgressPolicy({
      environment: { mode: "default_with_allowlist", allowlist: [] },
      exceptions: EXCEPTIONS,
    });
    const allowAll = resolveCloudEgressPolicy({
      environment: { mode: "allow_all", allowlist: [] },
      exceptions: EXCEPTIONS,
    });

    expect(evaluateCloudEgress({ policy: withDefaults, host: "registry.npmjs.org" })).toMatchObject(
      { allowed: true, rule: "default-set" },
    );
    expect(evaluateCloudEgress({ policy: withDefaults, host: "evil.example.com" }).allowed).toBe(
      false,
    );
    expect(evaluateCloudEgress({ policy: allowAll, host: "evil.example.com" })).toMatchObject({
      allowed: true,
      rule: "allow-all",
    });
  });
});

describe("encryption posture", () => {
  const sound: CloudEncryptionPosture = {
    tlsMinimumVersion: "TLSv1.3",
    perAgentDiskKeyId: "diskkey-host-1-vm-1",
    snapshots: { encrypted: true, keyId: "arn:aws:kms:key/t3" },
    artifacts: { encrypted: true, keyId: "arn:aws:kms:key/t3" },
    privacyMode: true,
    secretRedaction: true,
  };

  it("passes a sound posture with no findings", () => {
    expect(verifyCloudEncryptionPosture(sound)).toEqual({ ok: true, findings: [] });
  });

  it("blocks on TLS below 1.2, shared keys, plaintext stores, and disabled redaction", () => {
    const result = verifyCloudEncryptionPosture({
      tlsMinimumVersion: "TLSv1.1",
      privacyMode: sound.privacyMode,
      snapshots: { encrypted: false },
      artifacts: { encrypted: false },
      secretRedaction: false,
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "tls-below-1-2",
      "missing-per-agent-key",
      "unencrypted-snapshots",
      "unencrypted-artifacts",
      "redaction-off",
    ]);
  });

  it("advises, without blocking, on an unused customer key and Privacy Mode off", () => {
    const result = verifyCloudEncryptionPosture({
      ...sound,
      customerManagedKeyArn: "arn:aws:kms:key/customer",
      privacyMode: false,
    });

    expect(result.ok).toBe(true);
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "customer-key-unused",
      "privacy-mode-off",
    ]);
  });
});

describe("source-control access", () => {
  const policy: CloudScmAccessPolicy = {
    protectedRepositories: ["acme/payments"],
    blockedRepositories: ["acme/secrets-*", "acme/hr"],
    grantedRepositories: [],
    maxScope: "write",
    credentialTtlSeconds: 7_200,
  };
  const userRepositories = ["acme/*"];

  it("never widens access past the triggering user", () => {
    expect(
      evaluateCloudScmAccess({
        policy,
        request: { repository: "other/app", scope: "read", userRepositories, userScope: "write" },
      }),
    ).toMatchObject({ allowed: false, reason: "outside-user-access" });
    expect(
      evaluateCloudScmAccess({
        policy,
        request: { repository: "acme/app", scope: "write", userRepositories, userScope: "read" },
      }),
    ).toMatchObject({ allowed: false, reason: "scope-exceeds-user" });
  });

  it("refuses blocked repositories and protected ones without a grant", () => {
    expect(
      evaluateCloudScmAccess({
        policy,
        request: { repository: "acme/hr", scope: "read", userRepositories, userScope: "admin" },
      }),
    ).toMatchObject({ allowed: false, reason: "blocked" });
    // A prefix pattern has to bite, not just `owner/*`.
    expect(
      evaluateCloudScmAccess({
        policy,
        request: {
          repository: "acme/secrets-vault",
          scope: "read",
          userRepositories,
          userScope: "admin",
        },
      }),
    ).toMatchObject({ allowed: false, reason: "blocked" });
    expect(
      evaluateCloudScmAccess({
        policy,
        request: {
          repository: "acme/payments",
          scope: "read",
          userRepositories,
          userScope: "admin",
        },
      }),
    ).toMatchObject({ allowed: false, reason: "not-granted" });
    expect(
      evaluateCloudScmAccess({
        policy: { ...policy, grantedRepositories: ["acme/payments"] },
        request: {
          repository: "acme/payments",
          scope: "read",
          userRepositories,
          userScope: "admin",
        },
      }),
    ).toMatchObject({ allowed: true, scope: "read" });
  });

  it("clamps the credential and any assumed role to an hour", () => {
    const decision = evaluateCloudScmAccess({
      policy: {
        ...policy,
        assumeRole: {
          roleArn: "arn:aws:iam::1:role/agent",
          sessionDurationSeconds: 43_200,
          externalId: "t3",
        },
      },
      request: { repository: "acme/app", scope: "write", userRepositories, userScope: "write" },
    });

    expect(decision).toMatchObject({
      allowed: true,
      credentialTtlSeconds: 3_600,
      assumeRole: { sessionDurationSeconds: 3_600, externalId: "t3" },
    });
  });

  it("refuses a scope wider than the environment ceiling", () => {
    expect(
      evaluateCloudScmAccess({
        policy,
        request: { repository: "acme/app", scope: "admin", userRepositories, userScope: "admin" },
      }),
    ).toMatchObject({ allowed: false, reason: "scope-exceeds-policy" });
  });
});

describe("runtime identity claims", () => {
  const subject: CloudRuntimeIdentitySubject = {
    agentId: CloudAgentId.make("agent-1"),
    ownerId: "user-1",
    runId: CloudRunId.make("run-1"),
    workspaceId: "workspace-1",
    environmentId: CloudEnvironmentId.make("env-1"),
    repositories: ["acme/app"],
    hosting: "managed",
  };
  const claims = cloudRuntimeIdentityClaims({
    subject,
    issuer: "https://cloud.t3.codes",
    audience: "t3-cloud-runtime",
    nowSeconds: 1_000_000,
    jti: "jti-1",
  });

  it("carries agent, owner, turn, workspace, repository, and hosting claims for five minutes", () => {
    expect(claims).toMatchObject({
      sub: "agent:agent-1",
      agent_id: "agent-1",
      owner_id: "user-1",
      run_id: "run-1",
      workspace_id: "workspace-1",
      environment_id: "env-1",
      repositories: ["acme/app"],
      hosting: "managed",
    });
    expect(claims.exp - claims.iat).toBe(300);
  });

  it("caps a caller asking for a longer life", () => {
    const stretched = cloudRuntimeIdentityClaims({
      subject,
      issuer: "https://cloud.t3.codes",
      audience: "t3-cloud-runtime",
      nowSeconds: 1_000_000,
      jti: "jti-2",
      ttlSeconds: 86_400,
    });

    expect(stretched.exp - stretched.iat).toBe(300);
  });

  it("rejects a foreign issuer, a foreign audience, and an expired token", () => {
    const verify = (overrides: Parameters<typeof verifyCloudRuntimeIdentityClaims>[0]) =>
      verifyCloudRuntimeIdentityClaims(overrides)?.reason;

    expect(
      verify({
        claims,
        issuer: "https://cloud.t3.codes",
        audience: "t3-cloud-runtime",
        nowSeconds: 1_000_100,
      }),
    ).toBeUndefined();
    expect(
      verify({
        claims,
        issuer: "https://elsewhere",
        audience: "t3-cloud-runtime",
        nowSeconds: 1_000_100,
      }),
    ).toBe("invalid-token");
    expect(
      verify({
        claims,
        issuer: "https://cloud.t3.codes",
        audience: "other",
        nowSeconds: 1_000_100,
      }),
    ).toBe("invalid-token");
    expect(
      verify({
        claims,
        issuer: "https://cloud.t3.codes",
        audience: "t3-cloud-runtime",
        nowSeconds: 1_000_400,
      }),
    ).toBe("token-expired");
  });

  it("rejects a token minted with a longer lifetime than the contract allows", () => {
    expect(
      verifyCloudRuntimeIdentityClaims({
        claims: { ...claims, exp: claims.iat + 86_400 },
        issuer: "https://cloud.t3.codes",
        audience: "t3-cloud-runtime",
        nowSeconds: 1_000_100,
      })?.reason,
    ).toBe("invalid-token");
  });
});
