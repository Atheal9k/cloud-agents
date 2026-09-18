import { describe, expect, it } from "vite-plus/test";
import type { CloudAllocationLimits } from "@t3tools/contracts";
import {
  buildCloudRunLaunchCommand,
  cloudRunDisplayState,
  reconcileCloudRunLaunchInstanceType,
  type CloudRunLaunchDraft,
} from "./cloudRunLaunch";

const limits: CloudAllocationLimits = {
  maxConcurrentWorkers: 1,
  maxQueueDepth: 4,
  maxRunSeconds: 7_200,
  maxInputWaitSeconds: 900,
  previewGraceSeconds: 900,
  allowedInstanceTypes: ["t3.medium"],
};

const draft: CloudRunLaunchDraft = {
  repository: "Atheal9k/cloud-agents",
  selectedRef: "main",
  task: "Fix the flaky test",
  providerInstanceId: "codex",
  model: "gpt-5.6-sol",
  runtimeMode: "approval-required",
  runMinutes: "60",
  inputWaitMinutes: "15",
  instanceType: "t3.medium",
  publication: "automatic-draft-pr",
  baseBranch: "main",
};

describe("cloud run launch", () => {
  it("selects an allowed worker when controller limits arrive after the draft", () => {
    const pendingDraft = { ...draft, instanceType: "" };
    const reconciled = reconcileCloudRunLaunchInstanceType(pendingDraft, limits);

    expect(reconciled.instanceType).toBe("t3.medium");
    expect(reconcileCloudRunLaunchInstanceType(reconciled, limits)).toBe(reconciled);
  });

  it("builds one durable request identity with the selected task policy", () => {
    const result = buildCloudRunLaunchCommand({
      draft,
      limits,
      now: new Date("2026-09-17T10:00:00.000Z"),
      requestId: "request-19",
    });

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.command.type !== "allocation.launch") return;
    expect(result.command).toMatchObject({
      commandId: "cloud-launch:request-19",
      allocationId: "request-19",
      target: { repository: "Atheal9k/cloud-agents", baseCommit: "main" },
      publication: { mode: "automatic-draft-pr", baseBranch: "main" },
      execution: {
        threadId: "thread-request-19-1",
        selectedRef: "main",
        unansweredRequestSeconds: 900,
        turn: {
          commandId: "cloud-launch:request-19",
          prompt: "Fix the flaky test",
          modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        },
      },
    });
  });

  it("rejects limits before dispatch", () => {
    expect(
      buildCloudRunLaunchCommand({
        draft: { ...draft, runMinutes: "121" },
        limits,
        now: new Date("2026-09-17T10:00:00.000Z"),
        requestId: "request-19",
      }),
    ).toEqual({ status: "invalid", message: "Run time must be between 1 and 120 minutes." });
  });

  const displayCases: ReadonlyArray<
    readonly [
      "queued" | "registering" | "ready",
      "not-started" | "running" | "succeeded",
      "not-requested" | "running" | "succeeded",
      "provisioning" | "setup" | "waiting" | "running" | "finalizing" | "cleanup" | "complete",
    ]
  > = [
    ["queued", "not-started", "not-requested", "provisioning"],
    ["registering", "not-started", "not-requested", "setup"],
    ["ready", "not-started", "not-requested", "waiting"],
    ["ready", "running", "not-requested", "running"],
    ["ready", "succeeded", "not-requested", "finalizing"],
    ["ready", "succeeded", "running", "cleanup"],
    ["ready", "succeeded", "succeeded", "complete"],
  ];

  it.each(displayCases)(
    "maps %s/%s/%s to %s",
    (allocationState, agentOutcome, cleanupState, expected) => {
      expect(
        cloudRunDisplayState({
          allocationState: { status: allocationState },
          agentOutcome: { status: agentOutcome },
          cleanupState: { status: cleanupState },
        }),
      ).toBe(expected);
    },
  );

  it("keeps a run visibly failed while cleanup proceeds", () => {
    expect(
      cloudRunDisplayState({
        allocationState: { status: "ready" },
        agentOutcome: { status: "failed" },
        cleanupState: { status: "running" },
      }),
    ).toBe("failed");
  });
});
