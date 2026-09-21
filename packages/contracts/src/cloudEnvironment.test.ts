import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { CloudEnvironmentConfig } from "./cloudEnvironment.ts";

const decode = Schema.decodeUnknownExit(CloudEnvironmentConfig);
const encode = Schema.encodeSync(CloudEnvironmentConfig);

describe("CloudEnvironmentConfig", () => {
  it("accepts the Cursor environment fields with exactly one base", () => {
    const decoded = decode({
      name: "Web development",
      user: "node",
      image: "node:24-bookworm",
      install: "pnpm install",
      start: "pnpm dev",
      repositoryDependencies: ["github.com/acme/api"],
      terminals: [{ name: "tests", command: "pnpm test", description: "Focused tests" }],
      ports: [{ name: "web", port: 5173 }],
      egressMode: "network_settings_only",
      egressAllowlist: ["registry.npmjs.org"],
      privateDependencies: [
        {
          id: "npm",
          kind: "package-registry",
          destination: "registry.npmjs.org",
          secretName: "NPM_TOKEN",
        },
      ],
      networkProfile: { kind: "aws-privatelink" },
      enable_testing: "true",
    });

    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("rejects missing and competing bases", () => {
    expect(Exit.isFailure(decode({ name: "Missing base" }))).toBe(true);
    expect(
      Exit.isFailure(decode({ image: "node:24", snapshot: "snap-1", name: "Competing bases" })),
    ).toBe(true);
  });

  it("validates provider lifecycle failsafes independently from environment commands", () => {
    expect(
      Exit.isSuccess(
        decode({
          image: "node:24",
          runtimeLifecycle: {
            idle: { action: "stop", afterMinutes: 15 },
            archiveAfterMinutes: 1_440,
            deleteAfterMinutes: 129_600,
            maxTtlMinutes: 129_600,
          },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decode({
          image: "node:24",
          runtimeLifecycle: {
            idle: { action: "pause", afterMinutes: 0 },
            archiveAfterMinutes: 60,
            deleteAfterMinutes: 120,
            maxTtlMinutes: 180,
          },
        }),
      ),
    ).toBe(true);
  });

  it("reads a committed file that carries $schema but never writes it back", () => {
    const decoded = decode({
      $schema: "https://cursor.com/schemas/environment.schema.json",
      image: "node:24",
      name: "Node",
    });
    const encoded = encode({ image: "node:24", name: "Node" });

    expect(Exit.isSuccess(decoded)).toBe(true);
    expect(encoded).toEqual({ image: "node:24", name: "Node" });
    expect("$schema" in encoded).toBe(false);
  });

  it("accepts a Dockerfile base but not a half-specified one", () => {
    expect(Exit.isSuccess(decode({ build: { dockerfile: "Dockerfile" } }))).toBe(true);
    expect(
      Exit.isSuccess(decode({ build: { dockerfile: "Dockerfile", dockerfileContents: "FROM x" } })),
    ).toBe(false);
    expect(Exit.isSuccess(decode({ build: {} }))).toBe(false);
  });
});
