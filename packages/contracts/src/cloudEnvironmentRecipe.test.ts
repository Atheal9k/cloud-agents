import { describe, expect, it } from "@effect/vitest";

import {
  admitCloudEnvironmentBuild,
  cloudEnvironmentFromRecipe,
  cloudEnvironmentRuntimeServices,
  flattenCloudEnvironmentTerminals,
  injectCloudEnvironmentSecrets,
  missingCloudEnvironmentSecrets,
  redactCloudEnvironmentSecretOutput,
  cloudEnvironmentSecretValidationMessage,
} from "./cloudEnvironmentRecipe.ts";
import { cloudEnvironmentBuildSecrets } from "./cloudEnvironmentBuild.ts";
import type { CloudRepositoryRecipe } from "./cloudRepository.ts";

const recipe: CloudRepositoryRecipe = {
  version: 1,
  repository: "acme/web",
  outputBranchPrefix: "t3",
  setup: [
    { name: "install", command: "pnpm", args: ["install"], timeoutSeconds: 600 },
    { name: "codegen", command: "pnpm", args: ["gen"], timeoutSeconds: 120 },
  ],
  devServers: [
    {
      name: "web",
      port: 5173,
      command: { name: "dev", command: "pnpm", args: ["dev"], timeoutSeconds: 30 },
    },
    {
      name: "api",
      port: 13773,
      command: { name: "api", command: "pnpm", args: ["api"], timeoutSeconds: 30 },
    },
  ],
  verification: [{ name: "test", command: "pnpm", args: ["test"], timeoutSeconds: 300 }],
  secretReferences: [{ environmentVariable: "SENTRY_DSN", reference: "secret/sentry" }],
};

const secrets = [
  { name: "NPM_TOKEN", reference: "secret/npm", availability: "build" as const },
  { name: "SENTRY_DSN", reference: "secret/sentry", availability: "runtime" as const },
  {
    name: "SESSION_KEY",
    reference: "secret/session",
    availability: "runtime-redacted" as const,
  },
  {
    name: "USER_TOKEN",
    reference: "secret/user",
    availability: "build" as const,
    scope: "user" as const,
  },
];

describe("cloudEnvironmentFromRecipe", () => {
  it("maps setup to install and per-run servers to start, terminals, and ports", () => {
    const mapped = cloudEnvironmentFromRecipe({ recipe, image: "node:24-bookworm" });

    expect(mapped.config.install).toBe("pnpm install\npnpm gen");
    expect(mapped.config.start).toBe("pnpm dev");
    expect(mapped.config.terminals).toEqual([{ name: "api", command: "pnpm api" }]);
    expect(mapped.config.ports).toEqual([
      { name: "web", port: 5173 },
      { name: "api", port: 13773 },
    ]);
    expect(mapped.secretReferences).toEqual([
      { name: "SENTRY_DSN", reference: "secret/sentry", availability: "runtime" },
    ]);
    expect(cloudEnvironmentRuntimeServices(mapped.config).map((service) => service.name)).toEqual([
      "start",
      "api",
    ]);
  });
});

describe("cloud environment secret classes", () => {
  it("injects Build-only secrets at Build time and keeps user secrets out", () => {
    const values = {
      "secret/npm": "npm-secret",
      "secret/sentry": "dsn-secret",
      "secret/session": "session-secret",
      "secret/user": "user-secret",
    };
    const build = injectCloudEnvironmentSecrets({
      phase: "build",
      secrets,
      values,
    });
    const runtime = injectCloudEnvironmentSecrets({
      phase: "runtime",
      secrets,
      values,
    });

    expect(build.env).toEqual({ NPM_TOKEN: "npm-secret" });
    expect(build.redact).toEqual(["npm-secret"]);
    expect(cloudEnvironmentBuildSecrets(secrets).map((secret) => secret.name)).toEqual([
      "NPM_TOKEN",
    ]);
    expect(runtime.env).toEqual({
      SENTRY_DSN: "dsn-secret",
      SESSION_KEY: "session-secret",
    });
    expect(runtime.redact).toEqual(["session-secret"]);
    expect(
      redactCloudEnvironmentSecretOutput("token=session-secret dsn=dsn-secret", runtime.redact),
    ).toBe("token=[redacted] dsn=dsn-secret");
    expect(cloudEnvironmentSecretValidationMessage(secrets)).toContain("User secret 'USER_TOKEN'");
    expect(
      missingCloudEnvironmentSecrets({
        phase: "build",
        secrets: secrets.filter((secret) => secret.name !== "USER_TOKEN"),
        values: {},
      }).map((secret) => secret.name),
    ).toEqual(["NPM_TOKEN"]);
  });
});

describe("admitCloudEnvironmentBuild", () => {
  const version = {
    repositories: [
      { repository: "acme/web", defaultRef: "main" },
      { repository: "acme/api", defaultRef: "main" },
    ],
    config: {
      image: "node:24",
      repositoryDependencies: ["acme/api"],
      ports: [
        { name: "web", port: 5173 },
        { name: "api", port: 13773 },
      ],
    },
    secretReferences: [
      { name: "NPM_TOKEN", reference: "secret/npm", availability: "build" as const },
    ],
  };

  it("accepts a multi-repo environment whose ports, deps, and refs are named", () => {
    expect(
      admitCloudEnvironmentBuild({
        version,
        gitSetup: [
          { repository: "acme/web", defaultRef: "main", commit: "a".repeat(40) },
          { repository: "acme/api", defaultRef: "main", commit: "b".repeat(40) },
        ],
      }),
    ).toEqual({ status: "accepted" });
  });

  it("rejects colliding ports, unnamed private deps, and missing per-repo commits", () => {
    expect(
      admitCloudEnvironmentBuild({
        version: {
          ...version,
          config: { ...version.config, ports: [{ port: 5173 }, { name: "dup", port: 5173 }] },
        },
      }).status,
    ).toBe("rejected");
    expect(
      admitCloudEnvironmentBuild({
        version: {
          ...version,
          config: { ...version.config, repositoryDependencies: ["acme/private-lib"] },
        },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      admitCloudEnvironmentBuild({
        version,
        gitSetup: [{ repository: "acme/web", defaultRef: "main", commit: "a".repeat(40) }],
      }),
    ).toMatchObject({ status: "rejected" });
  });
});

describe("flattenCloudEnvironmentTerminals", () => {
  it("flattens nested terminal groups", () => {
    expect(
      flattenCloudEnvironmentTerminals([
        { name: "one", command: "echo one" },
        [{ name: "two", command: "echo two" }],
      ]).map((terminal) => terminal.name),
    ).toEqual(["one", "two"]);
  });
});
