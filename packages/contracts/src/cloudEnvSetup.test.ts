import { describe, expect, it } from "@effect/vitest";

import { CLOUD_DIAGNOSTICS_SETUP_TOOLS } from "./cloudExtensibility.ts";
import {
  CLOUD_ENV_SETUP_REFERENCE_FILES,
  CLOUD_ENV_SETUP_TURN_HEADER,
  CLOUD_ENV_SETUP_USER_REQUEST,
  cloudEnvSetupMappedToolName,
  cloudEnvSetupPromptIntent,
  selectCloudEnvSetupWorkflow,
} from "./cloudEnvSetup.ts";

describe("cloud env-setup workflow routing", () => {
  it("selects create when no effective environment exists", () => {
    expect(selectCloudEnvSetupWorkflow({ prompt: "Fix the flaky test" })).toBe("create");
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: "Fix the flaky test",
        environmentInfo: { environmentJsonPath: null },
      }),
    ).toBe("create");
  });

  it("selects create when the user asks to make a repository fully usable", () => {
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: CLOUD_ENV_SETUP_USER_REQUEST,
        environmentInfo: {
          environmentId: "environment-web",
          environmentJsonPath: ".cursor/environment.json",
        },
      }),
    ).toBe("create");
  });

  it("selects migrate before looking at environmentJsonPath", () => {
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: "Migrate this environment to builds",
        environmentInfo: {
          environmentId: "environment-web",
          environmentJsonPath: ".cursor/environment.json",
        },
      }),
    ).toBe("migrate");
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: "Test whether builds will work for this environment",
        environmentInfo: { environmentId: "environment-web", environmentJsonPath: null },
      }),
    ).toBe("migrate");
  });

  it("selects repository-managed vs DB-managed from environmentJsonPath", () => {
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: "Update the environment install script",
        environmentInfo: {
          environmentId: "environment-web",
          environmentJsonPath: ".cursor/environment.json",
        },
      }),
    ).toBe("repo-managed");
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: "Improve the environment snapshot",
        environmentInfo: { environmentId: "environment-web", environmentJsonPath: null },
      }),
    ).toBe("db-managed");
  });

  it("leaves an ordinary task against an existing environment alone", () => {
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: "Fix the flaky test",
        environmentInfo: { environmentId: "environment-web", environmentJsonPath: null },
      }),
    ).toBeNull();
  });

  it("does not wrap a prompt that already inlined the skill", () => {
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: `${CLOUD_ENV_SETUP_TURN_HEADER}\n${CLOUD_ENV_SETUP_USER_REQUEST}`,
      }),
    ).toBeNull();
  });

  it("maps Cursor-prefixed tool names onto the CA-51 diagnostics tools", () => {
    expect(cloudEnvSetupMappedToolName("cursor-cloud-environment-info")).toBe("environment-info");
    expect(cloudEnvSetupMappedToolName("trigger-environment-build")).toBe(
      "trigger-environment-build",
    );
    expect(CLOUD_DIAGNOSTICS_SETUP_TOOLS).toContain("request-environment-setup-actions");
    expect(Object.values(CLOUD_ENV_SETUP_REFERENCE_FILES)).toHaveLength(4);
  });

  it("classifies prompt intent without substituting a dashboard form", () => {
    expect(cloudEnvSetupPromptIntent(CLOUD_ENV_SETUP_USER_REQUEST)).toBe("create");
    expect(cloudEnvSetupPromptIntent("Please migrate to prebuilt builds")).toBe("migrate");
    expect(cloudEnvSetupPromptIntent("Test whether builds will work for this environment")).toBe(
      "migrate",
    );
    expect(cloudEnvSetupPromptIntent("Update the environment")).toBe("update");
    expect(cloudEnvSetupPromptIntent("Ship the diff")).toBe("none");
  });
});
