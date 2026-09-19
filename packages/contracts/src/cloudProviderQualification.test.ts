import { describe, expect, it } from "@effect/vitest";

import {
  admitCloudProviderExecution,
  CLOUD_PROVIDER_DRIVERS,
  CLOUD_PROVIDER_QUALIFICATIONS,
  cloudProviderDriverFromInstanceId,
  cloudProviderHistoryTransfer,
  cloudProviderWorkerHomes,
  isCloudProviderEnabled,
} from "./cloudProviderQualification.ts";

describe("cloud provider qualification", () => {
  it("classifies every built-in driver with proofs and distinct capabilities", () => {
    expect(CLOUD_PROVIDER_DRIVERS).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
      "antigravity",
    ]);
    for (const driver of CLOUD_PROVIDER_DRIVERS) {
      const qualification = CLOUD_PROVIDER_QUALIFICATIONS[driver];
      expect(qualification.driver).toBe(driver);
      expect(["enabled", "unsupported", "blocked"]).toContain(qualification.status);
      expect(qualification.evidence.length).toBeGreaterThan(20);
      expect(qualification.capabilities).toEqual(
        expect.objectContaining({
          filesystemRestore: expect.any(Boolean),
          providerNativeResume: expect.any(Boolean),
          contextTransfer: false,
          modelSwitching: expect.any(Boolean),
          computerUse: expect.any(Boolean),
        }),
      );
    }
    expect(isCloudProviderEnabled("codex")).toBe(true);
    expect(isCloudProviderEnabled("claudeAgent")).toBe(true);
    expect(isCloudProviderEnabled("cursor")).toBe(false);
    expect(isCloudProviderEnabled("grok")).toBe(false);
    expect(isCloudProviderEnabled("opencode")).toBe(false);
    expect(isCloudProviderEnabled("antigravity")).toBe(false);
    expect(CLOUD_PROVIDER_QUALIFICATIONS.opencode.status).toBe("blocked");
  });

  it("admits only enabled default instances before allocation", () => {
    expect(admitCloudProviderExecution({ instanceId: "codex" })).toMatchObject({
      status: "admitted",
      historyTransfer: "native-resume",
    });
    expect(admitCloudProviderExecution({ instanceId: "claudeAgent" }).status).toBe("admitted");
    expect(admitCloudProviderExecution({ instanceId: "cursor" })).toMatchObject({
      status: "rejected",
      message: expect.stringMatching(/unsupported/),
    });
    expect(admitCloudProviderExecution({ instanceId: "grok" }).status).toBe("rejected");
    expect(admitCloudProviderExecution({ instanceId: "opencode" })).toMatchObject({
      status: "rejected",
      message: expect.stringMatching(/blocked/),
    });
    expect(admitCloudProviderExecution({ instanceId: "antigravity" }).status).toBe("rejected");
    expect(admitCloudProviderExecution({ instanceId: "codex_personal" })).toMatchObject({
      status: "rejected",
      message: expect.stringMatching(/not a qualified cloud provider/),
    });
  });

  it("does not pretend native history transferred when the provider changes", () => {
    expect(
      admitCloudProviderExecution({
        instanceId: "claudeAgent",
        previousInstanceId: "codex",
      }),
    ).toMatchObject({
      status: "rejected",
      message: expect.stringMatching(/does not transfer native provider history/),
    });
    expect(
      cloudProviderHistoryTransfer({
        previousInstanceId: "codex",
        nextInstanceId: "claudeAgent",
      }),
    ).toBe("unsupported");
    expect(
      cloudProviderHistoryTransfer({
        previousInstanceId: "codex",
        nextInstanceId: "codex",
      }),
    ).toBe("native-resume");
  });

  it("keeps enabled worker credential homes isolated from each other and from HOME", () => {
    const homes = cloudProviderWorkerHomes();
    expect(homes.map((home) => home.driver).sort()).toEqual(["claudeAgent", "codex"]);
    const paths = homes.map((home) => home.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const home of homes) {
      expect(home.path).toMatch(/^\/run\/t3-worker\/credentials\//);
      expect(home.path).not.toMatch(/\/home\//);
      expect(home.env).not.toBe("HOME");
    }
    expect(cloudProviderDriverFromInstanceId("codex")).toBe("codex");
    expect(cloudProviderDriverFromInstanceId("cursor")).toBe("cursor");
  });

  it("rejects computer use on providers that do not advertise it", () => {
    expect(
      admitCloudProviderExecution({ instanceId: "claudeAgent", computerUse: true }),
    ).toMatchObject({
      status: "rejected",
      message: expect.stringMatching(/computer use/),
    });
    expect(admitCloudProviderExecution({ instanceId: "codex", computerUse: true }).status).toBe(
      "admitted",
    );
  });
});
