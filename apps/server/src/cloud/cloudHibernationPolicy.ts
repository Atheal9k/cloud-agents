import {
  DEFAULT_IDLE_RELEASE_SECONDS,
  type RunAllocation,
  type RunRuntimeSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * When a settled agent's guest is released. The timer runs from the settle,
 * not from the launch, so a follow-up that resets `settledAt` also buys the
 * guest another full window.
 */
export function idleReleaseAt(input: {
  readonly settledAt: string;
  readonly idleReleaseSeconds?: number | undefined;
}): string {
  const seconds = input.idleReleaseSeconds ?? DEFAULT_IDLE_RELEASE_SECONDS;
  const settled = Date.parse(input.settledAt);
  if (!Number.isFinite(settled)) return input.settledAt;
  return DateTime.formatIso(DateTime.makeUnsafe(settled + Math.max(0, seconds) * 1_000));
}

/**
 * A turn that is waiting on a person has not settled: the worker still reports
 * it running, so an agent blocked on input never reaches this state and never
 * loses its guest underneath the question.
 */
export function hasAgentSettled(allocation: RunAllocation): boolean {
  return (
    allocation.agentOutcome.status === "succeeded" || allocation.agentOutcome.status === "failed"
  );
}

/** True once a settled agent has held its guest for the whole idle window. */
export function isIdleReleaseDue(input: {
  readonly allocation: RunAllocation;
  readonly now: string;
}): boolean {
  const idle = input.allocation.idleState;
  if (idle.status !== "idle") return false;
  const releaseAt = Date.parse(idle.releaseAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(releaseAt) || !Number.isFinite(now)) return false;
  return now >= releaseAt;
}

/**
 * The run deadline is a hard cap on a run, not on the conversation. An agent
 * holding an idle or hibernated guest is governed by the idle timer instead,
 * so an open thread no longer dies when the worker lifetime its first run
 * asked for runs out.
 */
export function runDeadlineApplies(allocation: RunAllocation): boolean {
  return allocation.idleState.status === "busy" || allocation.idleState.status === "waking";
}

/**
 * The stopped guest an allocation still owns. Cleanup must leave it alone: it
 * is a snapshot waiting to be woken, not an expired worker.
 */
export function retainedRuntimeSnapshot(allocation: RunAllocation): RunRuntimeSnapshot | undefined {
  const idle = allocation.idleState;
  return idle.status === "hibernated" || idle.status === "waking" ? idle.snapshot : undefined;
}
