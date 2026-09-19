import { describe, expect, it } from "vite-plus/test";

import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentVersionId,
  CloudWarmGuestId,
  RunAllocationId,
} from "@t3tools/contracts";

import {
  planWarmPoolCapacity,
  placementForClaim,
  targetWarmGuests,
  warmGuestHasForbiddenIdentity,
  warmPoolInventories,
  warmPoolIsWorthKeeping,
  warmPoolSupportsProfile,
} from "./cloudWarmPoolPolicy.ts";

const timings = {
  coldBuildRestoreMs: 8_000,
  warmClaimMs: 120,
  ec2StartupMs: 45_000,
};

const key = {
  environmentId: CloudEnvironmentId.make("environment-web"),
  versionId: CloudEnvironmentVersionId.make("version-1"),
  profileId: "linux-web",
  buildId: CloudEnvironmentBuildId.make("build-1"),
};

describe("cloudWarmPoolPolicy", () => {
  it("keeps dedicated-host Mac profiles out of the Firecracker warm pool", () => {
    expect(warmPoolSupportsProfile("linux-web")).toBe(true);
    expect(warmPoolSupportsProfile("macos-ios")).toBe(false);
  });

  it("holds existing guests until timings are compared", () => {
    const plan = planWarmPoolCapacity({
      timings: undefined,
      inventories: [
        {
          key,
          snapshotId: "snap-1",
          demand: { queued: 3, activeSlots: 0 },
          warming: 0,
          ready: 1,
          claimed: 0,
          draining: 0,
        },
      ],
    });
    expect(plan.desiredHosts).toBe(1);
    expect(plan.pools[0]).toMatchObject({ target: 0, action: "hold" });
  });

  it("keeps pool size at zero until a warm claim is faster than restore and EC2", () => {
    expect(targetWarmGuests({ demandQueued: 4, timings: undefined })).toBe(0);
    expect(
      warmPoolIsWorthKeeping({
        coldBuildRestoreMs: 100,
        warmClaimMs: 200,
        ec2StartupMs: 45_000,
      }),
    ).toBe(false);
    expect(targetWarmGuests({ demandQueued: 4, timings })).toBe(2);
  });

  it("plans scale-to-zero without touching a Build snapshot", () => {
    const plan = planWarmPoolCapacity({
      timings,
      inventories: [
        {
          key,
          snapshotId: "snap-1",
          demand: { queued: 0, activeSlots: 0 },
          warming: 0,
          ready: 2,
          claimed: 0,
          draining: 0,
        },
      ],
    });

    expect(plan.desiredHosts).toBe(0);
    expect(plan.pools[0]).toMatchObject({ target: 0, action: "drain" });
    expect(plan.pools[0]?.reason).toContain("Build snapshot is kept");
  });

  it("records warm placement from a claimed guest and cold fallback otherwise", () => {
    expect(
      placementForClaim({
        claimed: {
          id: CloudWarmGuestId.make("guest-1"),
          environmentId: CloudEnvironmentId.make("environment-web"),
          versionId: CloudEnvironmentVersionId.make("version-1"),
          profileId: "linux-web",
          buildId: CloudEnvironmentBuildId.make("build-1"),
          snapshotId: "snap-1",
          status: "claimed",
          bootTimeMs: 90,
          createdAt: "2026-09-19T08:00:00.000Z",
          updatedAt: "2026-09-19T08:00:01.000Z",
          claimedByAllocationId: RunAllocationId.make("allocation-1"),
          claimedAt: "2026-09-19T08:00:01.000Z",
        },
        buildId: CloudEnvironmentBuildId.make("build-1"),
        claimLatencyMs: 12,
        fallbackReason: "no-warm-guest",
      }),
    ).toEqual({
      warmFork: "warm",
      buildId: "build-1",
      claimLatencyMs: 12,
      bootTimeMs: 90,
    });
    expect(
      placementForClaim({
        claimed: undefined,
        buildId: undefined,
        claimLatencyMs: 5,
        fallbackReason: "no-fresh-build",
      }),
    ).toMatchObject({ warmFork: "cold", fallbackReason: "no-fresh-build" });
  });

  it("rejects secrets, sessions, branches, and agent identity on warm guests", () => {
    expect(warmGuestHasForbiddenIdentity({ id: "guest-1" })).toBe(false);
    expect(warmGuestHasForbiddenIdentity({ id: "guest-1", secrets: { token: "x" } })).toBe(true);
    expect(warmGuestHasForbiddenIdentity({ id: "guest-1", providerSession: "sess" })).toBe(true);
    expect(warmGuestHasForbiddenIdentity({ id: "guest-1", branch: "feature" })).toBe(true);
    expect(warmGuestHasForbiddenIdentity({ id: "guest-1", agentId: "agent-1" })).toBe(true);
  });

  it("counts queue demand per environment and profile without merging claimed work", () => {
    const inventories = warmPoolInventories({
      guests: [
        {
          id: CloudWarmGuestId.make("guest-1"),
          environmentId: CloudEnvironmentId.make("environment-web"),
          versionId: CloudEnvironmentVersionId.make("version-1"),
          profileId: "linux-web",
          buildId: CloudEnvironmentBuildId.make("build-1"),
          snapshotId: "snap-1",
          status: "ready",
          bootTimeMs: 80,
          createdAt: "2026-09-19T08:00:00.000Z",
          updatedAt: "2026-09-19T08:00:00.000Z",
        },
      ],
      allocations: [],
    });
    expect(inventories).toEqual([
      {
        key,
        snapshotId: "snap-1",
        demand: { queued: 0, activeSlots: 0 },
        warming: 0,
        ready: 1,
        claimed: 0,
        draining: 0,
      },
    ]);
  });
});
