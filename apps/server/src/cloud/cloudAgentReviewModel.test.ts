import {
  CloudRunResultId,
  type CloudAgent,
  type CloudAgentReview,
  type CloudAllocationSnapshot,
  type CloudArtifactAccessGrant,
  type CloudRun,
  type RunAllocation,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assembleCloudAgentReview,
  inspectRetainedText,
  inspectRuntimeSnapshot,
  inspectSessionAvailability,
} from "./cloudAgentReviewModel.ts";
import { renderCloudAgentReviewPage } from "./cloudAgentReviewPage.ts";

const allocation = {
  id: "allocation-1",
  attempt: 1,
  target: { repository: "acme/web", baseCommit: "abc", branch: "cloud/run" },
  publication: { mode: "review-only" },
  execution: {
    threadId: "thread-1",
    title: "Fix the review page",
    selectedRef: "main",
    unansweredRequestSeconds: 900,
    turn: {
      commandId: "turn-1",
      messageId: "message-1",
      prompt: "Fix it",
      attachments: [],
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-09-19T01:00:00.000Z",
    },
  },
  profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
  deadlines: {
    launchBy: "2026-09-19T01:01:00.000Z",
    bootBy: "2026-09-19T01:02:00.000Z",
    registerBy: "2026-09-19T01:03:00.000Z",
    expiresAt: "2026-09-19T03:00:00.000Z",
    cleanupBy: "2026-09-19T03:05:00.000Z",
  },
  allocationState: { status: "queued" },
  agentOutcome: {
    status: "succeeded",
    resultLocation: { uri: "/cloud/results/a" },
    completedAt: "2026-09-19T02:00:00.000Z",
  },
  previewState: { status: "unavailable" },
  idleState: {
    status: "hibernated",
    hibernatedAt: "2026-09-19T03:00:00.000Z",
    snapshot: {
      instanceId: "i-worker",
      attempt: 1,
      flush: {
        userdata: { status: "flushed", detail: "ok" },
        workspace: { status: "flushed", detail: "ok" },
        providerHome: { status: "unavailable", reason: "tmpfs" },
        flushedAt: "2026-09-19T02:59:00.000Z",
      },
      capturedAt: "2026-09-19T03:00:00.000Z",
    },
  },
  cleanupState: { status: "not-requested" },
  handledCommandIds: ["launch"],
  sequence: 8,
  createdAt: "2026-09-19T01:00:00.000Z",
  updatedAt: "2026-09-19T03:00:00.000Z",
} as unknown as RunAllocation;

const agent = {
  id: "agent-1",
  allocationId: "allocation-1",
  conversation: { title: "Fix the review page", runIds: ["run-1"] },
  repository: "acme/web",
  baseCommit: "abc",
  environmentProfileId: "linux-web",
  branches: ["cloud/run"],
  createdAt: "2026-09-19T01:00:00.000Z",
  updatedAt: "2026-09-19T03:00:00.000Z",
  status: "IDLE",
} as unknown as CloudAgent;

const run = {
  id: "run-1",
  agentId: "agent-1",
  allocationId: "allocation-1",
  branch: "cloud/run",
  status: "FINISHED",
  completedAt: "2026-09-19T02:00:00.000Z",
  resultLocation: { uri: "/cloud/results/a" },
  createdAt: "2026-09-19T01:00:00.000Z",
  updatedAt: "2026-09-19T02:00:00.000Z",
} as unknown as CloudRun;

const snapshot = {
  controller: {
    mode: "local",
    requiresHostOnline: true,
    admission: { status: "open" },
    writability: { status: "writable" },
  },
  limits: {
    maxConcurrentWorkers: 1,
    maxQueueDepth: 8,
    maxRunSeconds: 1000,
    maxInputWaitSeconds: 900,
    previewLeaseSeconds: 900,
    previewLeaseMaxSeconds: 3600,
    idleReleaseSeconds: 3600,
    allowedInstanceTypes: ["t3.medium"],
  },
  workerPriceAssumptions: [],
  spendingControl: "estimate-only",
  allocations: [allocation],
  agents: [agent],
  runs: [run],
  runtimeAttempts: [],
  environments: [],
  builds: [],
  usage: [
    {
      allocationId: "allocation-1",
      attempt: 1,
      calculatedAt: "2026-09-19T03:00:00.000Z",
      elapsedWorkerSeconds: 120,
      deadlines: allocation.deadlines,
      costs: {
        controllerHost: { status: "not-attributed", reason: "local" },
        workerCompute: { status: "unknown", reason: "none" },
        storage: { status: "unknown", reason: "none" },
        provider: { status: "unknown", reason: "none" },
        streamingTransfer: { status: "unknown", reason: "none" },
      },
    },
  ],
} as unknown as CloudAllocationSnapshot;

describe("cloud agent review model", () => {
  it("keeps agent status distinct from run status and live session availability", () => {
    const review = assembleCloudAgentReview({
      agent,
      allocation,
      runs: [run],
      snapshot,
      publication: undefined,
      grant: undefined,
      diff: "diff --git a/a b/a\n",
      verification: '{"ok":true}',
      transcript: "[{}]",
      resultExpired: false,
    });

    expect(review.agentStatus).toBe("IDLE");
    expect(review.latestRun.status).toBe("FINISHED");
    expect(review.previewAvailability).toBe("unavailable");
    expect(review.terminalAvailability).toBe("unavailable");
    expect(review.reviewWakesRuntime).toBe(false);
    expect(review.snapshot.status).toBe("present");
    expect(review.actions.find((action) => action.action === "reopen")?.available).toBe(true);
    expect(review.actions.find((action) => action.action === "archive")?.available).toBe(true);
  });

  it("names binary, oversized, missing, and expired retained files", () => {
    expect(inspectRetainedText({ value: "a\0b", missingReason: "gone" }).status).toBe("binary");
    expect(
      inspectRetainedText({ value: "x".repeat(64 * 1024 + 1), missingReason: "gone" }).status,
    ).toBe("oversized");
    expect(
      inspectRetainedText({ value: undefined, missingReason: "The retained diff has expired." }),
    ).toEqual({
      status: "missing",
      reason: "The retained diff has expired.",
    });
  });

  it("does not treat a hibernated guest as a live preview or terminal", () => {
    const session = inspectSessionAvailability(allocation);
    expect(session.preview).toBe("unavailable");
    expect(session.terminal).toBe("unavailable");
    expect(inspectRuntimeSnapshot(allocation).status).toBe("present");
  });
});

describe("cloud agent review page", () => {
  it("escapes untrusted HTML and never claims to wake compute", () => {
    const review: CloudAgentReview = assembleCloudAgentReview({
      agent: {
        ...agent,
        conversation: { title: "<script>alert(1)</script>", runIds: [run.id] },
      },
      allocation,
      runs: [run],
      snapshot,
      publication: undefined,
      grant: {
        resultId: CloudRunResultId.make("a".repeat(64)),
        token: "x".repeat(43),
        expiresAt: "2026-09-19T04:00:00.000Z",
        entries: [
          {
            fileId: "001-report",
            kind: "artifact",
            name: "report<script>.html",
            mediaType: "text/html",
            url: "/api/cloud/artifacts/token/001-report",
          },
        ],
      } satisfies CloudArtifactAccessGrant,
      diff: "<script>alert('diff')</script>",
      verification: undefined,
      transcript: undefined,
      resultExpired: false,
    });
    const html = renderCloudAgentReviewPage(review);
    expect(html).toContain("does not wake a runtime");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("report&lt;script&gt;.html");
    expect(html).toContain("Untrusted HTML is download-only");
    expect(html).not.toContain("<script>alert");
  });
});
