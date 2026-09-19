import { describe, expect, it } from "vite-plus/test";

import { CloudHandoffTransferId } from "@t3tools/contracts";

import {
  cloudHandoffExcludeLabel,
  cloudHandoffIntentLabel,
  cloudHandoffResultSummary,
} from "./cloudHandoffPresentation.ts";

describe("cloud handoff presentation", () => {
  it("distinguishes wake from a linked continuation", () => {
    expect(cloudHandoffIntentLabel("wake-same-agent")).toContain("same agent");
    expect(cloudHandoffIntentLabel("linked-continuation")).toContain("linked continuation");
    expect(cloudHandoffExcludeLabel("credential")).toContain("never uploaded");
    expect(
      cloudHandoffResultSummary({
        transferId: CloudHandoffTransferId.make("transfer-1"),
        status: "woke-same-agent",
        direction: "cloud-to-local",
        intent: "wake-same-agent",
        source: {
          surface: "cloud",
          environmentId: "env",
          threadId: null,
        },
        destination: {
          surface: "cloud",
          environmentId: "env",
          threadId: null,
        },
        appliedPaths: [],
        skippedConflictPaths: [],
        excludedPaths: [],
        history: {
          status: "unsupported",
          description: "Provider history cannot be transferred.",
        },
        appliedAt: "2026-09-19T00:00:00.000Z",
      }),
    ).toContain("same cloud agent");
  });
});
