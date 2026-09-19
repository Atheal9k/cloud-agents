import { describe, expect, it } from "@effect/vitest";

import {
  cloudNetworkProfileDetails,
  cloudPrivateDependencyHost,
  cloudPrivateGitDependencyKinds,
  disableCloudNetworkProfile,
  isCloudCredentialExportPath,
  isCloudProtectedSecretName,
  resolveCloudNetworkProfile,
} from "./cloudPrivateNetwork.ts";
import {
  admitCloudEnvironmentBuild,
  injectCloudPrivateDependencySecrets,
} from "./cloudEnvironmentRecipe.ts";

describe("cloud private dependency hosts", () => {
  it("reads hosts from URLs, scp git remotes, and bare registries", () => {
    expect(cloudPrivateDependencyHost("https://npm.corp.example/acme")).toBe("npm.corp.example");
    expect(cloudPrivateDependencyHost("git@github.com:acme/lib.git")).toBe("github.com");
    expect(cloudPrivateDependencyHost("ssh://git@ssh.github.com:443/acme/lib.git")).toBe(
      "ssh.github.com",
    );
    expect(cloudPrivateDependencyHost("registry.npmjs.org")).toBe("registry.npmjs.org");
    expect(cloudPrivateDependencyHost("   ")).toBeUndefined();
  });
});

describe("cloud network profiles", () => {
  it("exposes cost, trust, and routing for each overlay", () => {
    expect(cloudNetworkProfileDetails({ kind: "tailscale" })).toMatchObject({
      kind: "tailscale",
      enabled: true,
      costClass: "subscription",
    });
    expect(cloudNetworkProfileDetails({ kind: "aws-privatelink" }).routing).toContain(
      "PrivateLink",
    );
  });

  it("disables an overlay without stranding on public routing", () => {
    const disabled = disableCloudNetworkProfile({ kind: "cloudflare-tunnel" });
    expect(disabled).toMatchObject({
      kind: "public",
      enabled: false,
      disabledFrom: "cloudflare-tunnel",
      costClass: "included",
    });
  });

  it("lets a locked team overlay clamp a more open environment choice", () => {
    const resolved = resolveCloudNetworkProfile({
      environment: { kind: "public" },
      team: { kind: "aws-privatelink" },
      teamLocked: true,
    });
    expect(resolved.kind).toBe("aws-privatelink");
  });

  it("still allows the operator to turn a locked overlay off", () => {
    const resolved = resolveCloudNetworkProfile({
      environment: { kind: "tailscale", enabled: false },
      team: { kind: "tailscale" },
      teamLocked: true,
    });
    expect(resolved).toMatchObject({ kind: "public", enabled: false, disabledFrom: "tailscale" });
  });
});

describe("credential boundaries", () => {
  it("keeps publication prefixes and credential files out of task state", () => {
    expect(isCloudProtectedSecretName("GH_TOKEN")).toBe(true);
    expect(isCloudProtectedSecretName("NPM_TOKEN")).toBe(false);
    expect(isCloudCredentialExportPath("workspace/.npmrc")).toBe(true);
    expect(isCloudCredentialExportPath(".ssh/id_ed25519")).toBe(true);
    expect(isCloudCredentialExportPath("src/index.ts")).toBe(false);
  });

  it("injects only the secrets a private dependency named", () => {
    const injected = injectCloudPrivateDependencySecrets({
      phase: "build",
      secrets: [
        { name: "NPM_TOKEN", reference: "secret/npm", availability: "build" },
        { name: "OTHER_TOKEN", reference: "secret/other", availability: "build" },
        { name: "GH_TOKEN", reference: "secret/gh", availability: "build" },
      ],
      privateDependencies: [
        {
          id: "npm",
          kind: "package-registry",
          destination: "npm.corp.example",
          secretName: "NPM_TOKEN",
        },
      ],
      values: {
        "secret/npm": "npm-secret-value",
        "secret/other": "other-secret-value",
        "secret/gh": "ghp_should-not-leak",
      },
    });

    expect(injected.env).toEqual({ NPM_TOKEN: "npm-secret-value" });
    expect(injected.redact).toEqual(["npm-secret-value"]);
  });
});

describe("private dependency admission", () => {
  const version = {
    repositories: [
      { repository: "acme/web", defaultRef: "main" },
      { repository: "acme/api", defaultRef: "main" },
    ],
    config: {
      image: "node:24-bookworm",
      ports: [{ name: "web", port: 5173 }],
      repositoryDependencies: ["acme/api"],
    },
    secretReferences: [
      { name: "NPM_TOKEN", reference: "secret/npm", availability: "build" as const },
    ],
  };

  it("accepts named submodule, LFS, and registry access", () => {
    expect(
      admitCloudEnvironmentBuild({
        version: {
          ...version,
          config: {
            ...version.config,
            privateDependencies: [
              {
                id: "shared",
                kind: "submodule",
                destination: "git@github.com:acme/shared.git",
              },
              {
                id: "assets",
                kind: "lfs",
                destination: "https://github.com/acme/web.git",
              },
              {
                id: "npm",
                kind: "package-registry",
                destination: "https://npm.corp.example",
                secretName: "NPM_TOKEN",
              },
            ],
          },
        },
      }),
    ).toEqual({ status: "accepted" });
    expect(
      cloudPrivateGitDependencyKinds([
        { id: "shared", kind: "submodule", destination: "github.com" },
        { id: "assets", kind: "lfs", destination: "github.com" },
        { id: "npm", kind: "package-registry", destination: "npm.corp.example" },
      ]),
    ).toEqual(["submodule", "lfs"]);
  });

  it("rejects a registry secret that is not declared or that uses a protected name", () => {
    const missing = admitCloudEnvironmentBuild({
      version: {
        ...version,
        config: {
          ...version.config,
          privateDependencies: [
            {
              id: "npm",
              kind: "package-registry",
              destination: "npm.corp.example",
              secretName: "MISSING_TOKEN",
            },
          ],
        },
      },
    });
    const protectedName = admitCloudEnvironmentBuild({
      version: {
        ...version,
        secretReferences: [{ name: "GH_TOKEN", reference: "secret/gh", availability: "build" }],
        config: {
          ...version.config,
          privateDependencies: [
            {
              id: "npm",
              kind: "package-registry",
              destination: "npm.corp.example",
              secretName: "GH_TOKEN",
            },
          ],
        },
      },
    });

    expect(missing).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("MISSING_TOKEN"),
    });
    expect(protectedName).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("protected secret"),
    });
  });
});
