import { describe, expect, it } from "@effect/vitest";
import type { CloudScmAccessPolicy } from "@t3tools/contracts";

import {
  admitCloudScratchCapability,
  admitCloudWorkspaceLaunch,
  cloudScratchLaunchTarget,
  cloudWorkspaceLaunchRepositories,
  parseCloudGitDependencyRepository,
} from "./cloudWorkspacePolicy.ts";

const policy: CloudScmAccessPolicy = {
  protectedRepositories: [],
  blockedRepositories: ["acme/secrets"],
  grantedRepositories: [],
  maxScope: "write",
  credentialTtlSeconds: 3_600,
};

const scm = {
  policy,
  request: {
    scope: "write" as const,
    userRepositories: ["acme/web", "acme/api"],
    userScope: "write" as const,
    installRepositories: ["acme/web", "acme/api", "acme/lib"],
    configuredRepositories: ["acme/web", "acme/api"],
  },
};

describe("admitCloudWorkspaceLaunch", () => {
  it("accepts a multi-repo Build whose per-repo refs stay inside the triggering user's intersection", () => {
    expect(
      admitCloudWorkspaceLaunch({
        repositories: [{ repository: "acme/web" }, { repository: "acme/api" }],
        scm,
      }),
    ).toEqual({ status: "accepted", kind: "repositories" });
  });

  it("rejects long-running on multi-repo workspaces until that mode is proven", () => {
    expect(
      admitCloudWorkspaceLaunch({
        repositories: [{ repository: "acme/web" }, { repository: "acme/api" }],
        longRunning: true,
      }),
    ).toMatchObject({ status: "rejected", message: expect.stringContaining("Long-running") });
  });

  it("rejects a submodule or named dependency that would widen scope", () => {
    expect(
      admitCloudWorkspaceLaunch({
        repositories: [{ repository: "acme/web" }, { repository: "acme/api" }],
        discoveredDependencies: [
          { kind: "submodule", repository: "https://github.com/acme/lib.git" },
        ],
        scm,
      }),
    ).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("acme/lib"),
    });
    expect(
      admitCloudWorkspaceLaunch({
        repositories: [{ repository: "acme/web" }],
        discoveredDependencies: [{ kind: "named", repository: "acme/secrets" }],
        scm: {
          policy,
          request: {
            ...scm.request,
            configuredRepositories: ["acme/web", "acme/secrets"],
            userRepositories: ["acme/web"],
          },
        },
      }),
    ).toMatchObject({ status: "rejected" });
  });

  it("starts a no-repository agent in an isolated scratch workspace", () => {
    expect(admitCloudWorkspaceLaunch({ repositories: [] })).toEqual({
      status: "accepted",
      kind: "scratch",
    });
    expect(cloudScratchLaunchTarget().repository).toBe("scratch/workspace");
    expect(cloudWorkspaceLaunchRepositories({ primary: "scratch/workspace" })).toEqual([
      { repository: "scratch/workspace" },
    ]);
  });
});

describe("admitCloudScratchCapability", () => {
  it("gates port forward and Design Mode on the preview boundary, and deploy on a draft repo", () => {
    expect(
      admitCloudScratchCapability({
        kind: "scratch",
        capability: "port-forward",
        draftPublished: false,
        previewAllowed: true,
      }).status,
    ).toBe("accepted");
    expect(
      admitCloudScratchCapability({
        kind: "scratch",
        capability: "design-mode",
        draftPublished: false,
        previewAllowed: false,
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      admitCloudScratchCapability({
        kind: "scratch",
        capability: "deploy",
        draftPublished: false,
        previewAllowed: true,
      }),
    ).toMatchObject({ status: "rejected", message: expect.stringContaining("draft repository") });
    expect(
      admitCloudScratchCapability({
        kind: "scratch",
        capability: "deploy",
        draftPublished: true,
        previewAllowed: true,
      }).status,
    ).toBe("accepted");
  });
});

describe("parseCloudGitDependencyRepository", () => {
  it("reads owner/name from HTTPS and SSH remotes", () => {
    expect(parseCloudGitDependencyRepository("https://github.com/acme/lib.git")).toBe("acme/lib");
    expect(parseCloudGitDependencyRepository("git@github.com:acme/lib.git")).toBe("acme/lib");
  });
});
