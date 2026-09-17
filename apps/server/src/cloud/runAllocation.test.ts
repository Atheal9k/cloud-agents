import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  RunAllocationCommand,
  RunWorkerProfile,
  type RunAllocation,
  type RunAllocationEvent,
} from "@t3tools/contracts";

import {
  decideRunAllocationCommand,
  projectRunAllocationEvent,
  replayRunAllocationEvents,
} from "./runAllocation.ts";

const decodeCommand = Schema.decodeSync(RunAllocationCommand);

const target = {
  repository: "t3tools/t3code",
  baseCommit: "afd7667ed",
  branch: "ca-02-add-allocation-contracts",
};
const profile = {
  id: "linux-web",
  os: "linux",
  arch: "x64",
} satisfies typeof RunWorkerProfile.Encoded;
const deadlines = {
  launchBy: "2026-09-17T03:05:00.000Z",
  bootBy: "2026-09-17T03:10:00.000Z",
  registerBy: "2026-09-17T03:15:00.000Z",
  expiresAt: "2026-09-17T05:00:00.000Z",
  cleanupBy: "2026-09-17T05:05:00.000Z",
};
const retryDeadlines = {
  launchBy: "2026-09-17T04:05:00.000Z",
  bootBy: "2026-09-17T04:10:00.000Z",
  registerBy: "2026-09-17T04:15:00.000Z",
  expiresAt: "2026-09-17T06:00:00.000Z",
  cleanupBy: "2026-09-17T06:05:00.000Z",
};
const references = {
  workerId: "worker-1",
  environmentId: "environment-1",
  threadId: "thread-1",
};
const route = {
  httpBaseUrl: "https://worker.example.test/",
  wsBaseUrl: "wss://worker.example.test/",
  accessToken: "worker-access-token",
};

function command(input: typeof RunAllocationCommand.Encoded): RunAllocationCommand {
  return decodeCommand(input);
}

const launch = command({
  type: "allocation.launch",
  commandId: "command-launch",
  allocationId: "allocation-1",
  attempt: 1,
  occurredAt: "2026-09-17T03:00:00.000Z",
  target,
  profile,
  deadlines,
});

function applyAccepted(
  allocation: RunAllocation | undefined,
  nextCommand: RunAllocationCommand,
): { readonly allocation: RunAllocation; readonly event: RunAllocationEvent } {
  const events = decideRunAllocationCommand(allocation, nextCommand);
  expect(events).toHaveLength(1);
  const event = events[0];
  if (event === undefined) throw new Error("Expected an allocation event");
  return { allocation: projectRunAllocationEvent(allocation, event), event };
}

function runningAllocation(): {
  readonly allocation: RunAllocation;
  readonly events: ReadonlyArray<RunAllocationEvent>;
} {
  const commands = [
    launch,
    command({
      type: "allocation.launch-started",
      commandId: "command-launch-started",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:00:01.000Z",
      launchTemplate: { id: "lt-worker", version: 7 },
    }),
    command({
      type: "allocation.instance-launched",
      commandId: "command-instance-launched",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:00:02.000Z",
      instanceId: "i-worker",
    }),
    command({
      type: "allocation.worker-booted",
      commandId: "command-worker-booted",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:00:03.000Z",
    }),
    command({
      type: "allocation.worker-registered",
      commandId: "command-worker-assigned",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:00:04.000Z",
      references,
      route,
    }),
    command({
      type: "allocation.agent-started",
      commandId: "command-agent-started",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:00:05.000Z",
    }),
  ];

  let allocation: RunAllocation | undefined;
  const events: RunAllocationEvent[] = [];
  for (const nextCommand of commands) {
    const applied = applyAccepted(allocation, nextCommand);
    allocation = applied.allocation;
    events.push(applied.event);
  }
  if (allocation === undefined) throw new Error("Expected a running allocation");
  return { allocation, events };
}

describe("cloud allocation transitions", () => {
  it("makes duplicate launch requests idempotent", () => {
    const launched = applyAccepted(undefined, launch);

    expect(decideRunAllocationCommand(launched.allocation, launch)).toEqual([]);
    expect(
      decideRunAllocationCommand(
        launched.allocation,
        command({ ...launch, commandId: "command-second-launch" }),
      ),
    ).toEqual([]);
    expect(projectRunAllocationEvent(launched.allocation, launched.event)).toBe(
      launched.allocation,
    );
  });

  it("lets the first side of a cancellation race decide the agent outcome", () => {
    const cancel = command({
      type: "allocation.cancel",
      commandId: "command-cancel",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:00:04.000Z",
    });
    const succeeded = command({
      type: "allocation.agent-succeeded",
      commandId: "command-agent-succeeded",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:00:05.000Z",
      resultLocation: { uri: "s3://cloud-agent-results/allocation-1" },
    });

    const cancelledFirst = applyAccepted(runningAllocation().allocation, cancel).allocation;
    expect(cancelledFirst.agentOutcome.status).toBe("cancelled");
    expect(cancelledFirst.cleanupState.status).toBe("requested");
    expect(decideRunAllocationCommand(cancelledFirst, succeeded)).toEqual([]);
    expect(decideRunAllocationCommand(cancelledFirst, cancel)).toEqual([]);

    const succeededFirst = applyAccepted(runningAllocation().allocation, succeeded).allocation;
    const cleanupRequested = applyAccepted(succeededFirst, cancel).allocation;
    expect(cleanupRequested.agentOutcome).toEqual({
      status: "succeeded",
      resultLocation: { uri: "s3://cloud-agent-results/allocation-1" },
      completedAt: "2026-09-17T03:00:05.000Z",
    });
    expect(cleanupRequested.cleanupState.status).toBe("requested");
  });

  it("ignores commands from a stale worker attempt", () => {
    let allocation = applyAccepted(undefined, launch).allocation;
    allocation = applyAccepted(
      allocation,
      command({
        type: "allocation.launch-started",
        commandId: "command-launch-started",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:01.000Z",
        launchTemplate: { id: "lt-worker", version: 7 },
      }),
    ).allocation;
    allocation = applyAccepted(
      allocation,
      command({
        type: "allocation.launch-failed",
        commandId: "command-launch-failed",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:02.000Z",
        reason: "instance health check failed",
      }),
    ).allocation;
    allocation = applyAccepted(
      allocation,
      command({
        type: "allocation.cancel",
        commandId: "command-cancel",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:03.000Z",
      }),
    ).allocation;
    allocation = applyAccepted(
      allocation,
      command({
        type: "allocation.cleanup-started",
        commandId: "command-cleanup-started",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:04.000Z",
      }),
    ).allocation;
    allocation = applyAccepted(
      allocation,
      command({
        type: "allocation.cleanup-succeeded",
        commandId: "command-cleanup-succeeded",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:05.000Z",
      }),
    ).allocation;
    allocation = applyAccepted(
      allocation,
      command({
        type: "allocation.retry",
        commandId: "command-retry",
        allocationId: "allocation-1",
        attempt: 1,
        nextAttempt: 2,
        deadlines: retryDeadlines,
        occurredAt: "2026-09-17T03:00:06.000Z",
      }),
    ).allocation;

    expect(allocation.attempt).toBe(2);
    expect(
      decideRunAllocationCommand(
        allocation,
        command({
          type: "allocation.worker-assigned",
          commandId: "command-stale-worker",
          allocationId: "allocation-1",
          attempt: 1,
          occurredAt: "2026-09-17T03:00:07.000Z",
          references,
        }),
      ),
    ).toEqual([]);

    const nextAttempt = applyAccepted(
      allocation,
      command({
        type: "allocation.launch-started",
        commandId: "command-next-launch-started",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-17T03:00:08.000Z",
        launchTemplate: { id: "lt-worker", version: 7 },
      }),
    ).allocation;
    expect(nextAttempt.allocationState.status).toBe("launching");
  });

  it("replays allocation, outcome, preview, and cleanup as separate state", () => {
    const running = runningAllocation();
    let allocation = running.allocation;
    const events = [...running.events];
    const commands = [
      command({
        type: "allocation.preview-published",
        commandId: "command-preview-published",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:04.000Z",
        url: "https://preview.example.test/allocation-1",
      }),
      command({
        type: "allocation.agent-succeeded",
        commandId: "command-agent-succeeded",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:05.000Z",
        resultLocation: { uri: "s3://cloud-agent-results/allocation-1" },
      }),
      command({
        type: "allocation.cancel",
        commandId: "command-cancel",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:06.000Z",
      }),
      command({
        type: "allocation.cleanup-started",
        commandId: "command-cleanup-started",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:07.000Z",
      }),
      command({
        type: "allocation.cleanup-succeeded",
        commandId: "command-cleanup-succeeded",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:08.000Z",
      }),
    ];

    for (const nextCommand of commands) {
      const applied = applyAccepted(allocation, nextCommand);
      allocation = applied.allocation;
      events.push(applied.event);
    }

    expect(replayRunAllocationEvents(events)).toEqual(allocation);
    expect(allocation.allocationState).toEqual({
      status: "ready",
      instanceId: "i-worker",
      references,
      route,
      readyAt: "2026-09-17T03:00:04.000Z",
    });
    expect(allocation.agentOutcome).toEqual({
      status: "succeeded",
      resultLocation: { uri: "s3://cloud-agent-results/allocation-1" },
      completedAt: "2026-09-17T03:00:05.000Z",
    });
    expect(allocation.previewState.status).toBe("unavailable");
    expect(allocation.cleanupState.status).toBe("succeeded");
  });
});
