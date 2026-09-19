import {
  CLOUD_AGENT_CI_AUTOFIX_REPAIR_CAP,
  CLOUD_AGENT_SUBSCRIPTION_COALESCE_WINDOW_MS,
  CLOUD_AGENT_SUBSCRIPTION_WAKE_MAX_DAYS,
  type CloudAgentCiAutofixFacts,
  type CloudAgentSubscriptionCreateRequest,
  type CloudAgentSubscriptionKind,
  type CloudAgentSubscriptionTarget,
} from "@t3tools/contracts";

import { validateCloudAgentScheduleTiming } from "./cloudAgentSchedulePolicy.ts";

export type CloudAgentCiAutofixSkipReason =
  | "not_agent_pr"
  | "human_push"
  | "user_follow_up"
  | "pre_existing_base_failure"
  | "repair_cap";

export function subscriptionKindMatchesTarget(
  kind: CloudAgentSubscriptionKind,
  target: CloudAgentSubscriptionTarget,
): boolean {
  return kind === target.type;
}

export function validateCloudAgentSubscriptionRequest(
  request: CloudAgentSubscriptionCreateRequest,
): string | undefined {
  if (!subscriptionKindMatchesTarget(request.kind, request.target)) {
    return "Subscription kind must match the target type.";
  }
  if (
    request.wakeMaxDays !== undefined &&
    request.wakeMaxDays > CLOUD_AGENT_SUBSCRIPTION_WAKE_MAX_DAYS
  ) {
    return `wakeMaxDays may not exceed ${CLOUD_AGENT_SUBSCRIPTION_WAKE_MAX_DAYS}.`;
  }
  if (request.target.type === "loop") {
    const timing = validateCloudAgentScheduleTiming({
      cron: request.target.cron,
      timezone: request.target.timezone,
    });
    if ("message" in timing) return timing.message;
  }
  if (request.target.type === "timer" && Number.isNaN(Date.parse(request.target.runAt))) {
    return "timer runAt must be an ISO timestamp.";
  }
  if (
    (request.kind === "timer" ||
      request.kind === "loop" ||
      request.kind.startsWith("slack") ||
      request.kind.startsWith("linear")) &&
    (request.prompt === undefined || request.prompt.text.trim().length === 0)
  ) {
    return "This subscription kind requires a prompt.";
  }
  return undefined;
}

export function subscriptionWakeDeadlineMs(input: {
  readonly lastActivityAt: string;
  readonly wakeMaxDays?: number | undefined;
}): number | undefined {
  const last = Date.parse(input.lastActivityAt);
  if (!Number.isFinite(last)) return undefined;
  const days = Math.min(
    input.wakeMaxDays ?? CLOUD_AGENT_SUBSCRIPTION_WAKE_MAX_DAYS,
    CLOUD_AGENT_SUBSCRIPTION_WAKE_MAX_DAYS,
  );
  return last + days * 24 * 60 * 60 * 1_000;
}

export function isSubscriptionWakeExpired(input: {
  readonly lastActivityAt: string;
  readonly nowMs: number;
  readonly wakeMaxDays?: number | undefined;
}): boolean {
  const deadline = subscriptionWakeDeadlineMs(input);
  return deadline === undefined || input.nowMs > deadline;
}

export function shouldCoalesceSubscriptionBurst(input: {
  readonly previousAt: string | undefined;
  readonly nowMs: number;
  readonly windowMs?: number | undefined;
}): boolean {
  if (input.previousAt === undefined) return false;
  const previous = Date.parse(input.previousAt);
  if (!Number.isFinite(previous)) return false;
  const window = input.windowMs ?? CLOUD_AGENT_SUBSCRIPTION_COALESCE_WINDOW_MS;
  return input.nowMs - previous >= 0 && input.nowMs - previous <= window;
}

export function evaluateCiAutofix(input: {
  readonly facts: CloudAgentCiAutofixFacts;
  readonly repairCount: number;
  readonly repairCap?: number | undefined;
}): { readonly eligible: true } | { readonly eligible: false; readonly reason: CloudAgentCiAutofixSkipReason } {
  const cap = input.repairCap ?? CLOUD_AGENT_CI_AUTOFIX_REPAIR_CAP;
  if (!input.facts.prCreatedByAgent) return { eligible: false, reason: "not_agent_pr" };
  if (input.facts.pusher === "human") return { eligible: false, reason: "human_push" };
  if (input.facts.explicitUserFollowUp) return { eligible: false, reason: "user_follow_up" };
  if (input.facts.preExistingBaseFailure) {
    return { eligible: false, reason: "pre_existing_base_failure" };
  }
  if (input.repairCount >= cap) return { eligible: false, reason: "repair_cap" };
  return { eligible: true };
}

export function ciAutofixSkipMessage(reason: CloudAgentCiAutofixSkipReason): string {
  switch (reason) {
    case "not_agent_pr":
      return "CI autofix follows only agent-created pull requests.";
    case "human_push":
      return "CI autofix skips human pushes.";
    case "user_follow_up":
      return "CI autofix skips explicit user follow-ups.";
    case "pre_existing_base_failure":
      return "CI autofix skips failures that already existed on the base revision.";
    case "repair_cap":
      return `CI autofix stopped after ${CLOUD_AGENT_CI_AUTOFIX_REPAIR_CAP} repair attempts.`;
  }
}
