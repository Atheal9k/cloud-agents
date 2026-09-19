/**
 * Preview leases. A run ends, the guest goes idle, and the idle timer decides
 * when its disk is snapshotted. A person looking at the app is the one case
 * where that timer is wrong, so looking is leased explicitly rather than
 * inferred from a heartbeat: the lease defers release while it is held, every
 * renewal is clamped to a cap fixed when the lease opened, and an explicit
 * stop skips the rest of the idle window entirely.
 */
import {
  CLOUD_SESSION_LEASE_KINDS,
  cloudSessionLease,
  cloudSessionLeaseField,
  type CloudSessionLease,
  type CloudSessionLeaseKind,
  type CloudSessionLeases,
  type RunAllocation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * The leases that keep a guest running. A question waiting on an answer is
 * already covered by the run's own input deadline, so holding one does not buy
 * the conversation extra compute on top of it.
 */
const RUNTIME_HOLDING_KINDS = [
  "app-preview",
  "desktop-viewer",
] as const satisfies ReadonlyArray<CloudSessionLeaseKind>;

function iso(millis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(millis));
}

/** The deadlines a newly opened lease gets. Both are fixed from `openedAt`. */
export function openedLeaseDeadlines(input: {
  readonly openedAt: string;
  readonly leaseSeconds: number;
  readonly maxLeaseSeconds: number;
}): { readonly expiresAt: string; readonly hardExpiresAt: string } {
  const opened = Date.parse(input.openedAt);
  if (!Number.isFinite(opened)) {
    return { expiresAt: input.openedAt, hardExpiresAt: input.openedAt };
  }
  const max = Math.max(1, input.maxLeaseSeconds);
  const term = Math.min(Math.max(1, input.leaseSeconds), max);
  return {
    expiresAt: iso(opened + term * 1_000),
    hardExpiresAt: iso(opened + max * 1_000),
  };
}

/**
 * A heartbeat asks for another term. It gets one, up to the cap the lease was
 * opened with, which is what stops a tab nobody is watching from renewing
 * forever.
 */
export function renewedLeaseExpiry(input: {
  readonly lease: CloudSessionLease;
  readonly renewedAt: string;
  readonly leaseSeconds: number;
}): string | undefined {
  if (input.lease.status !== "held") return undefined;
  const renewed = Date.parse(input.renewedAt);
  const hard = Date.parse(input.lease.hardExpiresAt);
  if (!Number.isFinite(renewed) || !Number.isFinite(hard)) return undefined;
  if (renewed >= hard) return undefined;
  return iso(Math.min(renewed + Math.max(1, input.leaseSeconds) * 1_000, hard));
}

export function isLeaseExpired(input: {
  readonly lease: CloudSessionLease;
  readonly now: string;
}): boolean {
  if (input.lease.status !== "held") return false;
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) return false;
  const expires = Date.parse(input.lease.expiresAt);
  const hard = Date.parse(input.lease.hardExpiresAt);
  const deadline = Math.min(
    Number.isFinite(expires) ? expires : Number.POSITIVE_INFINITY,
    Number.isFinite(hard) ? hard : Number.POSITIVE_INFINITY,
  );
  return Number.isFinite(deadline) && now >= deadline;
}

/**
 * A lease is only good for the runtime it was opened against. Replacing the
 * runtime voids it rather than carrying a stale claim onto a new guest.
 */
export function isLeaseCurrent(input: {
  readonly lease: CloudSessionLease;
  readonly attempt: number;
}): boolean {
  return input.lease.status === "held" && input.lease.attempt === input.attempt;
}

/** Every lease the caller should now release, with the reason to record. */
export function expiredLeases(input: {
  readonly allocation: RunAllocation;
  readonly now: string;
}): ReadonlyArray<{ readonly kind: CloudSessionLeaseKind; readonly reason: string }> {
  const released: Array<{ readonly kind: CloudSessionLeaseKind; readonly reason: string }> = [];
  for (const kind of CLOUD_SESSION_LEASE_KINDS) {
    const lease = cloudSessionLease(input.allocation.leases, kind);
    if (lease.status !== "held") continue;
    if (!isLeaseCurrent({ lease, attempt: input.allocation.attempt })) {
      released.push({ kind, reason: "The runtime this session was opened against was replaced." });
      continue;
    }
    if (!isLeaseExpired({ lease, now: input.now })) continue;
    released.push({
      kind,
      reason:
        Date.parse(input.now) >= Date.parse(lease.hardExpiresAt)
          ? "The session reached the maximum time a lease can be renewed for."
          : "The session lease expired without a heartbeat.",
    });
  }
  return released;
}

/**
 * True while a person is still looking at this runtime. The idle-release timer
 * defers to it, so a settled agent does not lose the app underneath a preview
 * someone has open.
 */
export function holdsRuntime(input: {
  readonly allocation: RunAllocation;
  readonly now: string;
}): boolean {
  if (input.allocation.stopRequestedAt !== undefined) return false;
  return RUNTIME_HOLDING_KINDS.some((kind) => {
    const lease = cloudSessionLease(input.allocation.leases, kind);
    return (
      isLeaseCurrent({ lease, attempt: input.allocation.attempt }) &&
      !isLeaseExpired({ lease, now: input.now })
    );
  });
}

/**
 * How long a settle should wait before releasing the guest. An explicit stop
 * makes it zero: the person closed the session, and the snapshot keeps
 * everything a follow-up would need.
 */
export function settleIdleSeconds(input: {
  readonly allocation: RunAllocation;
  readonly idleReleaseSeconds: number;
}): number {
  return input.allocation.stopRequestedAt === undefined ? input.idleReleaseSeconds : 0;
}

export function withLease(
  leases: CloudSessionLeases,
  kind: CloudSessionLeaseKind,
  lease: CloudSessionLease,
): CloudSessionLeases {
  return { ...leases, [cloudSessionLeaseField(kind)]: lease };
}

/** Releases every lease at once. Used by hibernate, replace, and explicit stop. */
export function releaseAllLeases(input: {
  readonly leases: CloudSessionLeases;
  readonly releasedAt: string;
  readonly reason: string;
}): CloudSessionLeases {
  let next = input.leases;
  for (const kind of CLOUD_SESSION_LEASE_KINDS) {
    if (cloudSessionLease(next, kind).status !== "held") continue;
    next = withLease(next, kind, {
      status: "released",
      releasedAt: input.releasedAt,
      reason: input.reason,
    });
  }
  return next;
}
