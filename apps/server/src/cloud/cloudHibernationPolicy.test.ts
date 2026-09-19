import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_IDLE_RELEASE_SECONDS,
  RunAllocationAttempt,
  type RunAllocation,
  type RunIdleState,
  type RunRuntimeFlush,
  type RunRuntimeSnapshot,
} from "@t3tools/contracts";

import {
  hasAgentSettled,
  idleReleaseAt,
  isIdleReleaseDue,
  retainedRuntimeSnapshot,
  runDeadlineApplies,
} from "./cloudHibernationPolicy.ts";

const flush: RunRuntimeFlush = {
  userdata: { status: "flushed", detail: "Checkpointed 12 write-ahead log pages." },
  workspace: { status: "flushed", detail: "Captured refs/t3/cloud-idle/allocation-1/1." },
  providerHome: { status: "unavailable", reason: "The provider home is a runtime directory." },
  flushedAt: "2026-09-17T03:00:00.000Z",
};

const snapshot: RunRuntimeSnapshot = {
  instanceId: "i-worker",
  attempt: RunAllocationAttempt.make(1),
  flush,
  capturedAt: "2026-09-17T04:00:00.000Z",
};

function allocationWith(input: {
  readonly idleState: RunIdleState;
  readonly agentOutcome?: RunAllocation["agentOutcome"];
}): RunAllocation {
  return {
    idleState: input.idleState,
    agentOutcome: input.agentOutcome ?? { status: "not-started" },
  } as RunAllocation;
}

describe("idleReleaseAt", () => {
  it("defaults to the documented one-hour window", () => {
    expect(DEFAULT_IDLE_RELEASE_SECONDS).toBe(3_600);
    expect(idleReleaseAt({ settledAt: "2026-09-17T03:00:00.000Z" })).toBe(
      "2026-09-17T04:00:00.000Z",
    );
  });

  it("runs the timer from the settle so a follow-up buys another full window", () => {
    const first = idleReleaseAt({ settledAt: "2026-09-17T03:00:00.000Z", idleReleaseSeconds: 900 });
    const second = idleReleaseAt({
      settledAt: "2026-09-17T03:10:00.000Z",
      idleReleaseSeconds: 900,
    });

    expect(first).toBe("2026-09-17T03:15:00.000Z");
    expect(second).toBe("2026-09-17T03:25:00.000Z");
  });

  it("releases immediately when the window is zero", () => {
    expect(idleReleaseAt({ settledAt: "2026-09-17T03:00:00.000Z", idleReleaseSeconds: 0 })).toBe(
      "2026-09-17T03:00:00.000Z",
    );
  });
});

describe("isIdleReleaseDue", () => {
  const idle = allocationWith({
    idleState: {
      status: "idle",
      settledAt: "2026-09-17T03:00:00.000Z",
      releaseAt: "2026-09-17T04:00:00.000Z",
      flush,
    },
  });

  it("keeps the guest inside the window and releases it on the boundary", () => {
    expect(isIdleReleaseDue({ allocation: idle, now: "2026-09-17T03:59:59.999Z" })).toBe(false);
    expect(isIdleReleaseDue({ allocation: idle, now: "2026-09-17T04:00:00.000Z" })).toBe(true);
  });

  it("never releases an allocation that is not idle", () => {
    const busy = allocationWith({ idleState: { status: "busy" } });
    const hibernated = allocationWith({
      idleState: { status: "hibernated", hibernatedAt: "2026-09-17T04:00:00.000Z", snapshot },
    });

    expect(isIdleReleaseDue({ allocation: busy, now: "2027-01-01T00:00:00.000Z" })).toBe(false);
    expect(isIdleReleaseDue({ allocation: hibernated, now: "2027-01-01T00:00:00.000Z" })).toBe(
      false,
    );
  });
});

describe("runDeadlineApplies", () => {
  it("caps a run in flight and a wake, but not an agent holding a released guest", () => {
    expect(runDeadlineApplies(allocationWith({ idleState: { status: "busy" } }))).toBe(true);
    expect(
      runDeadlineApplies(
        allocationWith({
          idleState: { status: "waking", requestedAt: "2026-09-17T05:00:00.000Z", snapshot },
        }),
      ),
    ).toBe(true);
    expect(
      runDeadlineApplies(
        allocationWith({
          idleState: {
            status: "idle",
            settledAt: "2026-09-17T03:00:00.000Z",
            releaseAt: "2026-09-17T04:00:00.000Z",
            flush,
          },
        }),
      ),
    ).toBe(false);
    expect(
      runDeadlineApplies(
        allocationWith({
          idleState: { status: "hibernated", hibernatedAt: "2026-09-17T04:00:00.000Z", snapshot },
        }),
      ),
    ).toBe(false);
  });
});

describe("retainedRuntimeSnapshot", () => {
  it("protects the stopped guest a hibernated or waking allocation still owns", () => {
    expect(
      retainedRuntimeSnapshot(
        allocationWith({
          idleState: { status: "hibernated", hibernatedAt: "2026-09-17T04:00:00.000Z", snapshot },
        }),
      )?.instanceId,
    ).toBe("i-worker");
    expect(
      retainedRuntimeSnapshot(
        allocationWith({
          idleState: { status: "waking", requestedAt: "2026-09-17T05:00:00.000Z", snapshot },
        }),
      )?.instanceId,
    ).toBe("i-worker");
    expect(retainedRuntimeSnapshot(allocationWith({ idleState: { status: "busy" } }))).toBe(
      undefined,
    );
  });
});

describe("hasAgentSettled", () => {
  it("settles on a finished turn but never while one is still running", () => {
    expect(
      hasAgentSettled(
        allocationWith({
          idleState: { status: "busy" },
          agentOutcome: {
            status: "succeeded",
            resultLocation: { uri: "t3://environment-1/thread-1" },
            completedAt: "2026-09-17T03:00:00.000Z",
          },
        }),
      ),
    ).toBe(true);
    expect(
      hasAgentSettled(
        allocationWith({
          idleState: { status: "busy" },
          agentOutcome: { status: "running", startedAt: "2026-09-17T03:00:00.000Z" },
        }),
      ),
    ).toBe(false);
  });
});
