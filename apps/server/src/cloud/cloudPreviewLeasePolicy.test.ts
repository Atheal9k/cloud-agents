import { emptyCloudSessionLeases, type RunAllocation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  expiredLeases,
  holdsRuntime,
  isLeaseExpired,
  openedLeaseDeadlines,
  releaseAllLeases,
  renewedLeaseExpiry,
  settleIdleSeconds,
  withLease,
} from "./cloudPreviewLeasePolicy.ts";

const openedAt = "2026-09-17T03:00:00.000Z";

function heldLease(input: {
  readonly attempt?: number;
  readonly expiresAt?: string;
  readonly hardExpiresAt?: string;
}) {
  return {
    status: "held",
    attempt: (input.attempt ?? 1) as RunAllocation["attempt"],
    openedAt,
    heartbeatAt: openedAt,
    expiresAt: input.expiresAt ?? "2026-09-17T03:15:00.000Z",
    hardExpiresAt: input.hardExpiresAt ?? "2026-09-17T07:00:00.000Z",
  } as const;
}

function allocationWith(input: {
  readonly leases: RunAllocation["leases"];
  readonly attempt?: number;
  readonly stopRequestedAt?: string;
}): RunAllocation {
  return {
    attempt: (input.attempt ?? 1) as RunAllocation["attempt"],
    leases: input.leases,
    ...(input.stopRequestedAt === undefined ? {} : { stopRequestedAt: input.stopRequestedAt }),
  } as RunAllocation;
}

describe("preview lease policy", () => {
  it("fixes both deadlines from the moment the lease opened", () => {
    expect(
      openedLeaseDeadlines({ openedAt, leaseSeconds: 900, maxLeaseSeconds: 4 * 60 * 60 }),
    ).toEqual({ expiresAt: "2026-09-17T03:15:00.000Z", hardExpiresAt: "2026-09-17T07:00:00.000Z" });
  });

  it("never opens a lease past its own cap", () => {
    expect(openedLeaseDeadlines({ openedAt, leaseSeconds: 9_000, maxLeaseSeconds: 600 })).toEqual({
      expiresAt: "2026-09-17T03:10:00.000Z",
      hardExpiresAt: "2026-09-17T03:10:00.000Z",
    });
  });

  it("lets a heartbeat buy another term, but only up to the cap", () => {
    const lease = heldLease({});

    expect(
      renewedLeaseExpiry({ lease, renewedAt: "2026-09-17T03:10:00.000Z", leaseSeconds: 900 }),
    ).toBe("2026-09-17T03:25:00.000Z");
    expect(
      renewedLeaseExpiry({ lease, renewedAt: "2026-09-17T06:50:00.000Z", leaseSeconds: 900 }),
    ).toBe("2026-09-17T07:00:00.000Z");
    // At the cap there is nothing left to buy, which is the difference between
    // a lease and a heartbeat that never ends.
    expect(
      renewedLeaseExpiry({ lease, renewedAt: "2026-09-17T07:00:00.000Z", leaseSeconds: 900 }),
    ).toBeUndefined();
  });

  it("expires on whichever deadline comes first", () => {
    const lease = heldLease({});

    expect(isLeaseExpired({ lease, now: "2026-09-17T03:14:59.000Z" })).toBe(false);
    expect(isLeaseExpired({ lease, now: "2026-09-17T03:15:00.000Z" })).toBe(true);
    expect(
      isLeaseExpired({
        lease: heldLease({ expiresAt: "2026-09-17T09:00:00.000Z" }),
        now: "2026-09-17T07:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("reports why each lease is being released", () => {
    const leases = withLease(
      withLease(emptyCloudSessionLeases(), "app-preview", heldLease({})),
      "desktop-viewer",
      heldLease({
        attempt: 1,
        expiresAt: "2026-09-17T09:00:00.000Z",
        hardExpiresAt: "2026-09-17T03:18:00.000Z",
      }),
    );

    expect(
      expiredLeases({ allocation: allocationWith({ leases }), now: "2026-09-17T03:20:00.000Z" }),
    ).toEqual([
      { kind: "app-preview", reason: "The session lease expired without a heartbeat." },
      {
        kind: "desktop-viewer",
        reason: "The session reached the maximum time a lease can be renewed for.",
      },
    ]);
  });

  it("voids a lease whose runtime was replaced", () => {
    const leases = withLease(emptyCloudSessionLeases(), "app-preview", heldLease({ attempt: 1 }));
    const allocation = allocationWith({ leases, attempt: 2 });

    expect(expiredLeases({ allocation, now: "2026-09-17T03:01:00.000Z" })).toEqual([
      {
        kind: "app-preview",
        reason: "The runtime this session was opened against was replaced.",
      },
    ]);
    expect(holdsRuntime({ allocation, now: "2026-09-17T03:01:00.000Z" })).toBe(false);
  });

  it("holds the runtime only while somebody is actually looking", () => {
    const watching = allocationWith({
      leases: withLease(emptyCloudSessionLeases(), "app-preview", heldLease({})),
    });
    expect(holdsRuntime({ allocation: watching, now: "2026-09-17T03:10:00.000Z" })).toBe(true);
    expect(holdsRuntime({ allocation: watching, now: "2026-09-17T03:20:00.000Z" })).toBe(false);

    // A question waiting on an answer has the run's own input deadline. It is
    // not extra compute on top of it.
    const answering = allocationWith({
      leases: withLease(emptyCloudSessionLeases(), "input", heldLease({})),
    });
    expect(holdsRuntime({ allocation: answering, now: "2026-09-17T03:10:00.000Z" })).toBe(false);
  });

  it("stops holding the runtime the moment a stop is requested", () => {
    const stopping = allocationWith({
      leases: withLease(emptyCloudSessionLeases(), "app-preview", heldLease({})),
      stopRequestedAt: "2026-09-17T03:05:00.000Z",
    });

    expect(holdsRuntime({ allocation: stopping, now: "2026-09-17T03:06:00.000Z" })).toBe(false);
    expect(settleIdleSeconds({ allocation: stopping, idleReleaseSeconds: 3_600 })).toBe(0);
    expect(
      settleIdleSeconds({
        allocation: allocationWith({ leases: emptyCloudSessionLeases() }),
        idleReleaseSeconds: 3_600,
      }),
    ).toBe(3_600);
  });

  it("releases every held lease at once", () => {
    const leases = withLease(
      withLease(emptyCloudSessionLeases(), "app-preview", heldLease({})),
      "input",
      heldLease({}),
    );

    const released = releaseAllLeases({
      leases,
      releasedAt: "2026-09-17T03:20:00.000Z",
      reason: "The person stopped this session.",
    });

    expect(released.appPreview).toEqual({
      status: "released",
      releasedAt: "2026-09-17T03:20:00.000Z",
      reason: "The person stopped this session.",
    });
    expect(released.input.status).toBe("released");
    expect(released.desktopViewer).toEqual({ status: "released" });
  });
});
