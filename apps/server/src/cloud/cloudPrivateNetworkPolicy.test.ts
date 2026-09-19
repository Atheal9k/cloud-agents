import { type CloudEgressPolicyInput, disableCloudNetworkProfile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkCloudPrivateDependencies,
  firstFailedCloudPrivateDependency,
} from "./cloudPrivateNetworkPolicy.ts";
import { cloudEgressExceptions, resolveCloudEgressPolicy } from "./cloudSecurityPolicy.ts";

const exceptions = cloudEgressExceptions({
  controllerHost: "controller.internal",
  scmHosts: ["github.com", "ssh.github.com"],
  artifactHosts: ["artifacts.internal"],
});

function policy(input: CloudEgressPolicyInput) {
  return resolveCloudEgressPolicy({ environment: input, exceptions });
}

describe("private dependency checks", () => {
  it("allows a registry on the allowlist and reports the host that is not", () => {
    const checks = checkCloudPrivateDependencies({
      policy: policy({
        mode: "allowlist_only",
        allowlist: ["npm.corp.example"],
      }),
      dependencies: [
        {
          id: "npm",
          kind: "package-registry",
          destination: "https://npm.corp.example/acme",
          secretName: "NPM_TOKEN",
        },
        {
          id: "pypi",
          kind: "package-registry",
          destination: "https://pypi.evil.example",
        },
      ],
    });

    expect(checks[0]).toMatchObject({ status: "ok", host: "npm.corp.example" });
    expect(firstFailedCloudPrivateDependency(checks)).toMatchObject({
      id: "pypi",
      host: "pypi.evil.example",
      status: "failed",
    });
    expect(firstFailedCloudPrivateDependency(checks)?.reason).toContain("pypi.evil.example");
  });

  it("still reaches GitHub and Cursor through documented exceptions", () => {
    const checks = checkCloudPrivateDependencies({
      policy: policy({ mode: "allowlist_only", allowlist: [] }),
      dependencies: [
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
      ],
    });

    expect(checks.every((check) => check.status === "ok")).toBe(true);
    expect(
      resolveCloudEgressPolicy({
        environment: { mode: "allowlist_only", allowlist: [] },
        exceptions,
      }).exceptions.some((entry) => entry.kind === "cursor" && entry.host === "cursor.com"),
    ).toBe(true);
  });

  it("reports a reachable-policy destination that failed its probe", () => {
    const failed = firstFailedCloudPrivateDependency(
      checkCloudPrivateDependencies({
        policy: policy({ mode: "allow_all", allowlist: [] }),
        dependencies: [
          {
            id: "shared",
            kind: "submodule",
            destination: "git@github.com:acme/shared.git",
          },
        ],
        probes: [{ id: "shared", reachable: false, detail: "Permission denied." }],
      }),
    );

    expect(failed?.reason).toContain("github.com");
    expect(failed?.reason).toContain("Permission denied");
  });
});

describe("network profile disable", () => {
  it("falls back to public routing so a dead overlay does not strand a run", () => {
    expect(disableCloudNetworkProfile({ kind: "tailscale" }).kind).toBe("public");
  });
});
