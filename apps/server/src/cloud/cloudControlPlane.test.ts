import {
  RunAllocationEvent,
  RunDeadlines,
  RunRepositoryTarget,
  RunRuntimeFlush,
  RunRuntimeSnapshot,
  RunWorkerProfile,
  RunWorkerReferences,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { projectCloudControlPlane } from "./cloudControlPlane.ts";

const decodeEvent = Schema.decodeSync(RunAllocationEvent);
const target = {
  repository: "Atheal9k/cloud-agents",
  baseCommit: "base-revision",
  branch: "cloud/agent-1",
} satisfies typeof RunRepositoryTarget.Encoded;
const profile = {
  id: "linux-web",
  os: "linux",
  arch: "x64",
  instanceType: "t3.medium",
} satisfies typeof RunWorkerProfile.Encoded;
const deadlines = {
  launchBy: "2026-09-19T01:01:00.000Z",
  bootBy: "2026-09-19T01:02:00.000Z",
  registerBy: "2026-09-19T01:03:00.000Z",
  expiresAt: "2026-09-19T02:00:00.000Z",
  cleanupBy: "2026-09-19T02:05:00.000Z",
} satisfies typeof RunDeadlines.Encoded;
const references = {
  workerId: "worker-1",
  environmentId: "environment-1",
  threadId: "thread-1",
} satisfies typeof RunWorkerReferences.Encoded;

describe("cloud control-plane projection", () => {
  it("migrates legacy allocation events into an idle agent and released runtime", () => {
    const events = [
      decodeEvent({
        type: "allocation.requested",
        sequence: 1,
        commandId: "legacy-launch",
        allocationId: "legacy-allocation",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:00.000Z",
        target,
        profile,
        deadlines,
      }),
      decodeEvent({
        type: "allocation.worker-assigned",
        sequence: 2,
        commandId: "legacy-worker",
        allocationId: "legacy-allocation",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:01.000Z",
        references,
      }),
      decodeEvent({
        type: "allocation.agent-started",
        sequence: 3,
        commandId: "legacy-started",
        allocationId: "legacy-allocation",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:02.000Z",
      }),
      decodeEvent({
        type: "allocation.agent-succeeded",
        sequence: 4,
        commandId: "legacy-finished",
        allocationId: "legacy-allocation",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:03.000Z",
        resultLocation: { uri: "s3://results/legacy-allocation" },
      }),
      decodeEvent({
        type: "allocation.cleanup-succeeded",
        sequence: 5,
        commandId: "legacy-cleanup",
        allocationId: "legacy-allocation",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:04.000Z",
      }),
    ];

    const projected = projectCloudControlPlane([events]);

    expect(projected.agents).toEqual([
      expect.objectContaining({
        id: "agent:legacy-allocation",
        allocationId: "legacy-allocation",
        status: "IDLE",
        conversation: { title: "Atheal9k/cloud-agents", runIds: ["run:legacy-allocation:1"] },
      }),
    ]);
    expect(projected.runs).toEqual([
      expect.objectContaining({ id: "run:legacy-allocation:1", status: "FINISHED" }),
    ]);
    expect(projected.runtimeAttempts).toEqual([
      expect.objectContaining({
        id: "runtime:legacy-allocation:1",
        status: "RELEASED",
        runIds: ["run:legacy-allocation:1"],
      }),
    ]);
    expect("runtime" in (projected.agents[0] ?? {})).toBe(false);
  });

  it("keeps follow-up runs on one agent and fences the replaced runtime", () => {
    const events = [
      decodeEvent({
        type: "allocation.requested",
        sequence: 1,
        commandId: "launch",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:00.000Z",
        target,
        control: { agentId: "agent-1", runId: "run-1" },
        profile,
        deadlines,
      }),
      decodeEvent({
        type: "allocation.launch-failed",
        sequence: 2,
        commandId: "launch-failed",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:01.000Z",
        reason: "placement failed",
      }),
      decodeEvent({
        type: "allocation.cancellation-requested",
        sequence: 3,
        commandId: "cancel",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:02.000Z",
      }),
      decodeEvent({
        type: "allocation.cleanup-succeeded",
        sequence: 4,
        commandId: "cleanup",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:03.000Z",
      }),
      decodeEvent({
        type: "allocation.retry-requested",
        sequence: 5,
        commandId: "retry",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-19T01:00:04.000Z",
        deadlines,
      }),
      decodeEvent({
        type: "allocation.worker-assigned",
        sequence: 6,
        commandId: "worker-2",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-19T01:00:05.000Z",
        references,
      }),
      decodeEvent({
        type: "allocation.agent-started",
        sequence: 7,
        commandId: "started",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-19T01:00:06.000Z",
      }),
      decodeEvent({
        type: "allocation.agent-succeeded",
        sequence: 8,
        commandId: "finished",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-19T01:00:07.000Z",
        resultLocation: { uri: "s3://results/run-1" },
      }),
      decodeEvent({
        type: "allocation.follow-up-requested",
        sequence: 9,
        commandId: "follow-up",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-19T01:00:08.000Z",
        runId: "run-2",
        execution: {
          threadId: "thread-1",
          title: "Continue the task",
          selectedRef: "main",
          unansweredRequestSeconds: 900,
          turn: {
            commandId: "follow-up",
            messageId: "follow-up-message",
            prompt: "Continue the task",
            attachments: [],
            modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: "2026-09-19T01:00:08.000Z",
          },
        },
        deadlines,
      }),
    ];

    const projected = projectCloudControlPlane([events]);

    expect(projected.agents[0]).toMatchObject({
      id: "agent-1",
      status: "ACTIVE",
      activeRunId: "run-2",
      conversation: { runIds: ["run-1", "run-2"] },
    });
    expect(projected.runs.map((run) => [run.id, run.status])).toEqual([
      ["run-1", "FINISHED"],
      ["run-2", "CREATING"],
    ]);
    expect(projected.runtimeAttempts.map((runtime) => [runtime.attempt, runtime.status])).toEqual([
      [1, "FENCED"],
      [2, "ACTIVE"],
    ]);
    expect(projected.runtimeAttempts[1]?.runIds).toEqual(["run-1", "run-2"]);
  });

  it("keeps a hibernated runtime restorable and fences it when a follow-up wakes it", () => {
    const flush = {
      userdata: { status: "flushed", detail: "Checkpointed 12 write-ahead log pages." },
      workspace: { status: "flushed", detail: "Captured refs/t3/cloud-idle/allocation-1/1." },
      providerHome: { status: "unavailable", reason: "The provider home is a runtime directory." },
      flushedAt: "2026-09-19T01:30:00.000Z",
    } satisfies typeof RunRuntimeFlush.Encoded;
    const snapshot = {
      instanceId: "i-worker",
      attempt: 1,
      flush,
      capturedAt: "2026-09-19T02:30:00.000Z",
    } satisfies typeof RunRuntimeSnapshot.Encoded;
    const events = [
      decodeEvent({
        type: "allocation.requested",
        sequence: 1,
        commandId: "launch",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:00.000Z",
        target,
        profile,
        deadlines,
        control: { agentId: "agent-1", runId: "run-1" },
      }),
      decodeEvent({
        type: "allocation.worker-assigned",
        sequence: 2,
        commandId: "assign",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:01.000Z",
        references,
      }),
      decodeEvent({
        type: "allocation.agent-started",
        sequence: 3,
        commandId: "start",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-19T01:00:02.000Z",
      }),
      decodeEvent({
        type: "allocation.agent-succeeded",
        sequence: 4,
        commandId: "succeed",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-19T01:30:00.000Z",
        resultLocation: { uri: "t3://environment-1/thread-1" },
      }),
      decodeEvent({
        type: "allocation.went-idle",
        sequence: 5,
        commandId: "idle",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-19T01:30:01.000Z",
        releaseAt: "2026-09-19T02:30:01.000Z",
        flush,
      }),
      decodeEvent({
        type: "allocation.hibernated",
        sequence: 6,
        commandId: "hibernate",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-19T02:30:02.000Z",
        snapshot,
      }),
    ];

    const hibernated = projectCloudControlPlane([events]);

    // The conversation is idle, not finished, and its runtime is stopped with
    // the disk intact rather than released.
    expect(hibernated.agents[0]?.status).toBe("IDLE");
    expect(hibernated.runtimeAttempts).toHaveLength(1);
    expect(hibernated.runtimeAttempts[0]).toMatchObject({
      status: "HIBERNATED",
      snapshot: { instanceId: "i-worker" },
    });

    const woken = projectCloudControlPlane([
      [
        ...events,
        decodeEvent({
          type: "allocation.follow-up-requested",
          sequence: 7,
          commandId: "follow-up",
          allocationId: "allocation-1",
          attempt: 2,
          occurredAt: "2026-09-20T09:00:00.000Z",
          runId: "run-2",
          execution: {
            threadId: "thread-1",
            title: "Cloud task",
            selectedRef: "base-revision",
            unansweredRequestSeconds: 900,
            turn: {
              commandId: "turn-2",
              messageId: "message-2",
              prompt: "Pick this back up",
              attachments: [],
              modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
              runtimeMode: "approval-required",
              interactionMode: "default",
              createdAt: "2026-09-20T09:00:00.000Z",
            },
          },
          deadlines,
          restoreFrom: snapshot,
        }),
      ],
    ]);

    expect(woken.runtimeAttempts.map((runtime) => [runtime.attempt, runtime.status])).toEqual([
      [1, "FENCED"],
      [2, "CREATING"],
    ]);
    expect(woken.agents[0]?.status).toBe("ACTIVE");
    expect(woken.runs.map((run) => run.id)).toEqual(["run-1", "run-2"]);
  });

  it("omits permanently deleted agents from the review catalog", () => {
    const projected = projectCloudControlPlane([
      [
        decodeEvent({
          type: "allocation.requested",
          sequence: 1,
          commandId: "launch",
          allocationId: "allocation-1",
          attempt: 1,
          occurredAt: "2026-09-19T01:00:00.000Z",
          target,
          profile,
          deadlines,
          control: { agentId: "agent-1", runId: "run-1" },
        }),
        decodeEvent({
          type: "allocation.agent-succeeded",
          sequence: 2,
          commandId: "finished",
          allocationId: "allocation-1",
          attempt: 1,
          occurredAt: "2026-09-19T01:00:03.000Z",
          resultLocation: { uri: "/cloud/results/result" },
        }),
        decodeEvent({
          type: "allocation.agent-deleted",
          sequence: 3,
          commandId: "delete",
          allocationId: "allocation-1",
          attempt: 1,
          occurredAt: "2026-09-19T01:00:04.000Z",
        }),
      ],
    ]);

    expect(projected.agents).toEqual([]);
    expect(projected.runs).toEqual([]);
  });
});
