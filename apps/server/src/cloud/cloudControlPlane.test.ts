import {
  RunAllocationEvent,
  RunDeadlines,
  RunRepositoryTarget,
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
});
