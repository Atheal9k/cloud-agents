import {
  DEFAULT_CONVERSATION_RETENTION_DAYS,
  DEFAULT_SNAPSHOT_RETENTION_DAYS,
  type RunAllocation,
  type RunSnapshotRetention,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const DAY_MILLIS = 24 * 60 * 60 * 1_000;

function addDays(from: string, days: number): string {
  const start = Date.parse(from);
  if (!Number.isFinite(start)) return from;
  return DateTime.formatIso(DateTime.makeUnsafe(start + Math.max(0, days) * DAY_MILLIS));
}

function hasPassed(deadline: string, now: string): boolean {
  const at = Date.parse(deadline);
  const current = Date.parse(now);
  return Number.isFinite(at) && Number.isFinite(current) && current >= at;
}

/**
 * The inactivity window an agent's disk gets from one successful start or
 * resume. It is rolling: every later start or resume issues a fresh window
 * from that moment rather than extending the original one.
 */
export function snapshotRetentionFrom(input: {
  readonly lastActiveAt: string;
  readonly retentionDays?: number | undefined;
}): RunSnapshotRetention {
  return {
    lastActiveAt: input.lastActiveAt,
    expiresAt: addDays(input.lastActiveAt, input.retentionDays ?? DEFAULT_SNAPSHOT_RETENTION_DAYS),
  };
}

/**
 * True once a stopped guest has gone unused for the whole window. Only a
 * hibernated agent qualifies, so garbage collection can never reach a guest
 * that is running or waking.
 */
export function isSnapshotRetentionExpired(input: {
  readonly allocation: RunAllocation;
  readonly now: string;
}): boolean {
  const { allocation } = input;
  if (allocation.idleState.status !== "hibernated") return false;
  if (allocation.deletion !== undefined) return false;
  const retention = allocation.snapshotRetention;
  if (retention === undefined) return false;
  return hasPassed(retention.expiresAt, input.now);
}

/**
 * When this conversation last did work. Garbage collection reads activity
 * rather than `updatedAt`, so its own sweeps cannot keep an abandoned agent
 * alive by touching it.
 */
export function conversationLastActiveAt(allocation: RunAllocation): string {
  return allocation.snapshotRetention?.lastActiveAt ?? allocation.createdAt;
}

/** A run in flight is never collected, whatever the administrative cap says. */
function hasActiveRun(allocation: RunAllocation): boolean {
  return (
    allocation.agentOutcome.status === "not-started" || allocation.agentOutcome.status === "running"
  );
}

/**
 * Conversations and runs are kept indefinitely unless an administrator sets a
 * cap, which `0` disables. The cap deletes; it does not archive, because an
 * archived agent the operator can still read is not a retention limit.
 */
export function isConversationRetentionExpired(input: {
  readonly allocation: RunAllocation;
  readonly retentionDays?: number | undefined;
  readonly now: string;
}): boolean {
  const days = input.retentionDays ?? DEFAULT_CONVERSATION_RETENTION_DAYS;
  if (days <= 0) return false;
  if (input.allocation.deletion !== undefined) return false;
  if (hasActiveRun(input.allocation)) return false;
  return hasPassed(addDays(conversationLastActiveAt(input.allocation), days), input.now);
}

/**
 * A delete erases data only once the agent holds no compute. Waiting for
 * cleanup is what stops a purge racing a guest that is still writing, and
 * leaves the reconciler as the only thing that terminates workers.
 */
export function isDeletionPurgeReady(allocation: RunAllocation): boolean {
  return (
    allocation.deletion?.status === "requested" &&
    allocation.cleanupState.status === "succeeded" &&
    allocation.idleState.status !== "hibernated" &&
    allocation.idleState.status !== "waking"
  );
}
