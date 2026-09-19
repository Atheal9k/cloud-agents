import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SNAPSHOT_RETENTION_DAYS,
  RunAllocationAttempt,
  type RunAllocation,
  type RunRuntimeFlush,
  type RunRuntimeSnapshot,
} from "@t3tools/contracts";

import {
  conversationLastActiveAt,
  isConversationRetentionExpired,
  isDeletionPurgeReady,
  isSnapshotRetentionExpired,
  snapshotRetentionFrom,
} from "./cloudRetentionPolicy.ts";

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

function allocationWith(patch: Partial<RunAllocation>): RunAllocation {
  return {
    createdAt: "2026-09-17T03:00:00.000Z",
    idleState: { status: "hibernated", hibernatedAt: "2026-09-17T04:00:00.000Z", snapshot },
    agentOutcome: { status: "succeeded", resultLocation: { uri: "t3://environment-1/thread-1" } },
    cleanupState: { status: "not-requested" },
    snapshotRetention: snapshotRetentionFrom({ lastActiveAt: "2026-09-17T03:00:00.000Z" }),
    ...patch,
  } as RunAllocation;
}

describe("snapshotRetentionFrom", () => {
  it("issues the documented ninety-day window from the moment of activity", () => {
    expect(DEFAULT_SNAPSHOT_RETENTION_DAYS).toBe(90);
    expect(snapshotRetentionFrom({ lastActiveAt: "2026-09-17T03:00:00.000Z" })).toEqual({
      lastActiveAt: "2026-09-17T03:00:00.000Z",
      expiresAt: "2026-12-16T03:00:00.000Z",
    });
  });

  it("rolls rather than extends, so a later resume gets a whole fresh window", () => {
    const resumed = snapshotRetentionFrom({
      lastActiveAt: "2026-12-01T03:00:00.000Z",
      retentionDays: 90,
    });

    expect(resumed.expiresAt).toBe("2027-03-01T03:00:00.000Z");
  });
});

describe("isSnapshotRetentionExpired", () => {
  it("collects a hibernated disk once its window has passed", () => {
    const allocation = allocationWith({});

    expect(isSnapshotRetentionExpired({ allocation, now: "2026-12-15T03:00:00.000Z" })).toBe(false);
    expect(isSnapshotRetentionExpired({ allocation, now: "2026-12-16T03:00:00.000Z" })).toBe(true);
  });

  it("leaves running, waking, and deleting agents alone", () => {
    const now = "2027-06-01T03:00:00.000Z";

    expect(
      isSnapshotRetentionExpired({
        allocation: allocationWith({ idleState: { status: "busy" } }),
        now,
      }),
    ).toBe(false);
    expect(
      isSnapshotRetentionExpired({
        allocation: allocationWith({
          idleState: { status: "waking", requestedAt: now, snapshot },
        }),
        now,
      }),
    ).toBe(false);
    expect(
      isSnapshotRetentionExpired({
        allocation: allocationWith({ deletion: { status: "requested", requestedAt: now } }),
        now,
      }),
    ).toBe(false);
  });
});

describe("isConversationRetentionExpired", () => {
  it("keeps conversations forever unless an administrator sets a cap", () => {
    const allocation = allocationWith({});

    expect(isConversationRetentionExpired({ allocation, now: "2030-01-01T00:00:00.000Z" })).toBe(
      false,
    );
    expect(
      isConversationRetentionExpired({
        allocation,
        retentionDays: 0,
        now: "2030-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("measures the cap from the last activity rather than the last write", () => {
    const allocation = allocationWith({ updatedAt: "2027-01-01T00:00:00.000Z" });

    expect(conversationLastActiveAt(allocation)).toBe("2026-09-17T03:00:00.000Z");
    expect(
      isConversationRetentionExpired({
        allocation,
        retentionDays: 30,
        now: "2026-10-17T03:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("never collects a conversation whose run is still in flight", () => {
    expect(
      isConversationRetentionExpired({
        allocation: allocationWith({
          agentOutcome: { status: "running", startedAt: "2026-09-17T03:00:00.000Z" },
        }),
        retentionDays: 1,
        now: "2030-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("isDeletionPurgeReady", () => {
  it("waits for the compute claim to be released before anything is erased", () => {
    const requested = { status: "requested", requestedAt: "2026-09-18T09:00:00.000Z" } as const;

    expect(isDeletionPurgeReady(allocationWith({ deletion: requested }))).toBe(false);
    expect(
      isDeletionPurgeReady(
        allocationWith({
          deletion: requested,
          idleState: { status: "busy" },
          cleanupState: { status: "succeeded", completedAt: "2026-09-18T09:05:00.000Z" },
        }),
      ),
    ).toBe(true);
  });

  it("ignores an agent that was never asked to be deleted", () => {
    expect(
      isDeletionPurgeReady(
        allocationWith({
          idleState: { status: "busy" },
          cleanupState: { status: "succeeded", completedAt: "2026-09-18T09:05:00.000Z" },
        }),
      ),
    ).toBe(false);
  });
});
