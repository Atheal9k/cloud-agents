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

  it("records warm-fork placement on launch", () => {
    const started = applyAccepted(undefined, launch);
    const launching = applyAccepted(
      started.allocation,
      command({
        type: "allocation.launch-started",
        commandId: "command-launch-started",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:01.000Z",
        launchTemplate: { id: "lt-worker", version: 7 },
      }),
    );
    const placed = applyAccepted(
      launching.allocation,
      command({
        type: "allocation.instance-launched",
        commandId: "command-instance-launched",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:02.000Z",
        instanceId: "guest-1",
        placement: {
          warmFork: "warm",
          buildId: "build-1",
          claimLatencyMs: 18,
          bootTimeMs: 90,
        },
      }),
    );

    expect(placed.allocation.placement).toEqual({
      warmFork: "warm",
      buildId: "build-1",
      claimLatencyMs: 18,
      bootTimeMs: 90,
    });
  });

  it("retains the launch publication choice in controller state", () => {
    const automaticLaunch = command({
      type: "allocation.launch",
      commandId: "command-automatic-publication",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:00:00.000Z",
      target,
      profile,
      deadlines,
      publication: {
        mode: "automatic-draft-pr",
        baseBranch: "main",
        title: "feat(cloud): publish a draft PR",
        body: "Controller-owned publication.",
      },
    });
    if (automaticLaunch.type !== "allocation.launch") {
      throw new Error("Expected a launch command");
    }

    const launched = applyAccepted(undefined, automaticLaunch);

    expect(launched.event).toMatchObject({ publication: automaticLaunch.publication });
    expect(launched.allocation.publication).toEqual(automaticLaunch.publication);
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
        startPoint: { type: "base-commit", commit: "base-revision" },
        publication: { status: "not-attempted" },
        occurredAt: "2026-09-17T03:00:06.000Z",
      }),
    ).allocation;

    expect(allocation.attempt).toBe(2);
    expect(allocation.retry).toEqual({
      previousAttempt: 1,
      startPoint: { type: "base-commit", commit: "base-revision" },
      publication: { status: "not-attempted" },
    });
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

describe("cloud allocation hibernation", () => {
  const flush = {
    userdata: { status: "flushed", detail: "Checkpointed 12 write-ahead log pages." },
    workspace: { status: "flushed", detail: "Captured refs/t3/cloud-idle/allocation-1/1." },
    providerHome: { status: "unavailable", reason: "The provider home is a runtime directory." },
    flushedAt: "2026-09-17T03:10:00.000Z",
  } as const;

  const followUpTurn = {
    threadId: "thread-1",
    title: "Cloud task",
    selectedRef: "afd7667ed",
    unansweredRequestSeconds: 900,
    turn: {
      commandId: "turn-2",
      messageId: "message-2",
      prompt: "Pick this back up",
      attachments: [],
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-09-18T09:00:00.000Z",
    },
  } as const;

  function settledAllocation(): RunAllocation {
    return applyAccepted(
      runningAllocation().allocation,
      command({
        type: "allocation.agent-succeeded",
        commandId: "command-agent-succeeded",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:10:00.000Z",
        resultLocation: { uri: "t3://environment-1/thread-1" },
      }),
    ).allocation;
  }

  function idleAllocation(): RunAllocation {
    return applyAccepted(
      settledAllocation(),
      command({
        type: "allocation.idle",
        commandId: "command-idle",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:10:01.000Z",
        releaseAt: "2026-09-17T04:10:01.000Z",
        flush,
      }),
    ).allocation;
  }

  function hibernatedAllocation(): RunAllocation {
    return applyAccepted(
      idleAllocation(),
      command({
        type: "allocation.hibernate",
        commandId: "command-hibernate",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T04:10:02.000Z",
        snapshot: {
          instanceId: "i-worker",
          attempt: 1,
          flush,
          capturedAt: "2026-09-17T04:10:02.000Z",
        },
      }),
    ).allocation;
  }

  it("records the flush and the release deadline when a settled turn goes idle", () => {
    const idle = idleAllocation();

    expect(idle.idleState).toEqual({
      status: "idle",
      settledAt: "2026-09-17T03:10:01.000Z",
      releaseAt: "2026-09-17T04:10:01.000Z",
      flush,
    });
    expect(idle.agentOutcome.status).toBe("succeeded");
  });

  it("refuses to idle a turn that is still running", () => {
    expect(
      decideRunAllocationCommand(
        runningAllocation().allocation,
        command({
          type: "allocation.idle",
          commandId: "command-idle-early",
          allocationId: "allocation-1",
          attempt: 1,
          occurredAt: "2026-09-17T03:05:00.000Z",
          releaseAt: "2026-09-17T04:05:00.000Z",
          flush,
        }),
      ),
    ).toEqual([]);
  });

  it("drops the worker route when the guest stops so nothing dials it", () => {
    const hibernated = hibernatedAllocation();

    expect(hibernated.idleState).toMatchObject({
      status: "hibernated",
      snapshot: { instanceId: "i-worker" },
    });
    expect(hibernated.allocationState).toEqual({
      status: "ready",
      instanceId: "i-worker",
      references,
      readyAt: "2026-09-17T03:00:04.000Z",
    });
  });

  it("reuses the guest for a follow-up inside the idle window", () => {
    const followedUp = applyAccepted(
      idleAllocation(),
      command({
        type: "allocation.follow-up",
        commandId: "command-follow-up",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:20:00.000Z",
        runId: "run-2",
        execution: followUpTurn,
        deadlines: retryDeadlines,
      }),
    ).allocation;

    expect(followedUp.attempt).toBe(1);
    expect(followedUp.idleState).toEqual({ status: "busy" });
    expect(followedUp.allocationState.status).toBe("ready");
  });

  it("wakes a hibernated guest on one new attempt that restores its snapshot", () => {
    const woken = applyAccepted(
      hibernatedAllocation(),
      command({
        type: "allocation.follow-up",
        commandId: "command-follow-up-after-release",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-18T09:00:00.000Z",
        runId: "run-2",
        execution: followUpTurn,
        deadlines: retryDeadlines,
      }),
    ).allocation;

    expect(woken.attempt).toBe(2);
    expect(woken.allocationState).toEqual({ status: "queued" });
    expect(woken.idleState).toMatchObject({
      status: "waking",
      snapshot: { instanceId: "i-worker", attempt: 1 },
    });

    const wakeCommands = [
      command({
        type: "allocation.launch-started",
        commandId: "command-wake-launch-started",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-18T09:00:01.000Z",
        launchTemplate: { id: "lt-worker", version: 7 },
      }),
      command({
        type: "allocation.instance-launched",
        commandId: "command-wake-instance-launched",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-18T09:00:02.000Z",
        instanceId: "i-worker",
      }),
      command({
        type: "allocation.worker-booted",
        commandId: "command-wake-worker-booted",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-18T09:00:03.000Z",
      }),
      command({
        type: "allocation.worker-registered",
        commandId: "command-wake-worker-registered",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-18T09:00:04.000Z",
        references,
        route,
      }),
      command({
        type: "allocation.runtime-restored",
        commandId: "command-wake-restored",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-18T09:00:05.000Z",
        restore: {
          filesystem: { status: "resumed", detail: "Restored the guest disk from its snapshot." },
          providerSession: {
            status: "not-resumed",
            reason: "The provider home is a runtime directory.",
          },
          restoredAt: "2026-09-18T09:00:05.000Z",
        },
      }),
    ];
    let restored = woken;
    for (const nextCommand of wakeCommands) {
      restored = applyAccepted(restored, nextCommand).allocation;
    }

    // The two halves of a wake are reported separately: the disk came back,
    // the native provider session did not.
    expect(restored.idleState).toMatchObject({
      status: "busy",
      restore: {
        filesystem: { status: "resumed" },
        providerSession: { status: "not-resumed" },
      },
    });
    expect(restored.allocationState.status).toBe("ready");
  });

  it("stops holding a snapshot once cleanup is requested", () => {
    const cancelled = applyAccepted(
      hibernatedAllocation(),
      command({
        type: "allocation.cancel",
        commandId: "command-cancel-hibernated",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-18T09:00:00.000Z",
      }),
    ).allocation;

    expect(cancelled.idleState).toEqual({ status: "busy" });
    expect(cancelled.cleanupState.status).toBe("requested");
    expect(cancelled.agentOutcome.status).toBe("succeeded");
  });
});
