import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { RunAllocationCommand, type CloudAllocationLimits } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildCloudAgentLaunchCommand } from "./cloudAgents.ts";

const limits: CloudAllocationLimits = {
  maxConcurrentWorkers: 1,
  maxQueueDepth: 1,
  maxRunSeconds: 3_600,
  maxInputWaitSeconds: 900,
  allowedInstanceTypes: ["daytona:small"],
  idleReleaseSeconds: 3_600,
  conversationRetentionDays: 0,
  previewLeaseSeconds: 300,
  previewLeaseMaxSeconds: 1_800,
};

const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-22T00:00:00.000Z"));
const decodeCommand = Schema.decodeSync(RunAllocationCommand);

describe("mobile cloud agent commands", () => {
  it("builds a schema-valid launch with a draft PR and bounded deadlines", () => {
    const result = buildCloudAgentLaunchCommand({
      repository: "Atheal9k/cloud-agents",
      selectedRef: "main",
      task: "Add phone controls",
      providerInstanceId: "codex",
      model: "gpt-5.6-sol",
      limits,
      now,
      requestId: "request-1",
    });
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(decodeCommand(result.command)).toMatchObject({
      type: "allocation.launch",
      target: {
        repository: "Atheal9k/cloud-agents",
        baseCommit: "main",
        branch: "cursor/request-1",
      },
      publication: { mode: "automatic-draft-pr", baseBranch: "main" },
      profile: { id: "linux-web", instanceType: "daytona:small" },
    });
  });

  it("rejects missing repositories and unsupported providers before dispatch", () => {
    expect(
      buildCloudAgentLaunchCommand({
        repository: "",
        selectedRef: "main",
        task: "Task",
        providerInstanceId: "codex",
        model: "gpt-5.6-sol",
        limits,
        now,
        requestId: "request-1",
      }),
    ).toEqual({ status: "invalid", message: "Choose a source-control repository." });

    expect(
      buildCloudAgentLaunchCommand({
        repository: "Atheal9k/cloud-agents",
        selectedRef: "main",
        task: "Task",
        providerInstanceId: "grok",
        model: "grok-code",
        limits,
        now,
        requestId: "request-1",
      }),
    ).toMatchObject({ status: "invalid" });
  });
});
