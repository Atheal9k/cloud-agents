import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentSaveInput,
  type CloudGuidedSetupInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { cloudGuidedSetupSaveInput } from "./cloudGuidedSetup.ts";

const environmentId = CloudEnvironmentId.make("environment:primary");
const buildId = CloudEnvironmentBuildId.make("build:primary:1");
const isSaveInput = Schema.is(CloudEnvironmentSaveInput);

function input(overrides: Partial<CloudGuidedSetupInput> = {}): CloudGuidedSetupInput {
  return {
    environmentId,
    buildId,
    name: "Primary",
    scope: "personal",
    owner: "victor",
    repository: "t3tools/t3code",
    defaultRef: "main",
    base: { kind: "image", image: "ubuntu:24.04" },
    install: "pnpm install",
    secretReferences: [],
    occurredAt: "2026-09-19T12:00:00.000Z",
    ...overrides,
  };
}

describe("cloudGuidedSetupSaveInput", () => {
  it("produces a save the environment catalog accepts", () => {
    const save = cloudGuidedSetupSaveInput(input({ expectedVersion: 3 }));

    expect(isSaveInput(save)).toBe(true);
    expect(save).toMatchObject({
      environmentId,
      expectedVersion: 3,
      source: { type: "saved", scope: "personal", owner: "victor" },
      repositories: [{ repository: "t3tools/t3code", defaultRef: "main" }],
      config: { name: "Primary", image: "ubuntu:24.04", install: "pnpm install" },
    });
  });

  it("omits expectedVersion when creating so the catalog is not asked to match a version", () => {
    expect(cloudGuidedSetupSaveInput(input())).not.toHaveProperty("expectedVersion");
  });

  it("chooses a single base, so a dockerfile form never also sends an image", () => {
    const save = cloudGuidedSetupSaveInput(
      input({ base: { kind: "dockerfile", dockerfile: "docker/Dockerfile" } }),
    );

    expect(isSaveInput(save)).toBe(true);
    expect(save.config).toMatchObject({ build: { dockerfile: "docker/Dockerfile" } });
    expect(save.config).not.toHaveProperty("image");
  });

  it("drops blank commands rather than saving an empty install step", () => {
    const save = cloudGuidedSetupSaveInput(input({ install: "   ", start: "" }));

    expect(save.config).not.toHaveProperty("install");
    expect(save.config).not.toHaveProperty("start");
  });

  it("keeps additional repositories on the saved environment version", () => {
    const save = cloudGuidedSetupSaveInput(
      input({
        additionalRepositories: [{ repository: "t3tools/api", defaultRef: "main" }],
      }),
    );

    expect(save.repositories).toEqual([
      { repository: "t3tools/t3code", defaultRef: "main" },
      { repository: "t3tools/api", defaultRef: "main" },
    ]);
  });

  it("keeps network policy, private dependencies, and secret references", () => {
    const save = cloudGuidedSetupSaveInput(
      input({
        egressMode: "network_settings_only",
        egressAllowlist: ["registry.npmjs.org"],
        privateDependencies: [
          {
            id: "npm-private",
            kind: "package-registry",
            destination: "npm.acme.test",
            secretName: "NPM_TOKEN",
          },
        ],
        networkProfile: { kind: "tailscale", enabled: true },
        secretReferences: [{ name: "NPM_TOKEN", reference: "secret/npm", availability: "build" }],
      }),
    );

    expect(save.config).toMatchObject({
      egressMode: "network_settings_only",
      egressAllowlist: ["registry.npmjs.org"],
      privateDependencies: [
        {
          id: "npm-private",
          kind: "package-registry",
          destination: "npm.acme.test",
          secretName: "NPM_TOKEN",
        },
      ],
      networkProfile: { kind: "tailscale", enabled: true },
    });
    expect(save.secretReferences).toEqual([
      { name: "NPM_TOKEN", reference: "secret/npm", availability: "build" },
    ]);
  });

  it("does not require an owner for the default scope", () => {
    const save = cloudGuidedSetupSaveInput(input({ scope: "default", owner: undefined }));

    expect(isSaveInput(save)).toBe(true);
    expect(save.source).toEqual({ type: "saved", scope: "default" });
  });
});
