import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import {
  evaluateCiAutofix,
  isSubscriptionWakeExpired,
  shouldCoalesceSubscriptionBurst,
  validateCloudAgentSubscriptionRequest,
} from "./cloudAgentSubscriptionPolicy.ts";

describe("cloud agent subscription policy", () => {
  it("rejects mismatched kinds and wake windows above 180 days", () => {
    expect(
      validateCloudAgentSubscriptionRequest({
        kind: "github_pr",
        target: { type: "github_ci", repository: "acme/app", pullRequest: 1 },
      }),
    ).toBe("Subscription kind must match the target type.");
    expect(
      validateCloudAgentSubscriptionRequest({
        kind: "github_pr",
        target: { type: "github_pr", repository: "acme/app", pullRequest: 1 },
        wakeMaxDays: 181,
      }),
    ).toBe("wakeMaxDays may not exceed 180.");
    expect(
      validateCloudAgentSubscriptionRequest({
        kind: "timer",
        target: { type: "timer", runAt: "2026-09-20T00:00:00.000Z" },
      }),
    ).toBe("This subscription kind requires a prompt.");
  });

  it("wakes idle agents for 180 days and coalesces bursts", () => {
    const nowMs = Date.parse("2026-09-19T00:00:00.000Z");
    const windowMs = 180 * 24 * 60 * 60 * 1_000;
    expect(
      isSubscriptionWakeExpired({
        lastActivityAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - windowMs)),
        nowMs,
      }),
    ).toBe(false);
    expect(
      isSubscriptionWakeExpired({
        lastActivityAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - windowMs - 1)),
        nowMs,
      }),
    ).toBe(true);
    expect(
      shouldCoalesceSubscriptionBurst({
        previousAt: "2026-09-19T00:00:00.000Z",
        nowMs: Date.parse("2026-09-19T00:00:30.000Z"),
      }),
    ).toBe(true);
    expect(
      shouldCoalesceSubscriptionBurst({
        previousAt: "2026-09-19T00:00:00.000Z",
        nowMs: Date.parse("2026-09-19T00:00:30.001Z"),
      }),
    ).toBe(false);
  });

  it("autofixes only eligible agent-created PRs", () => {
    const eligible = {
      prCreatedByAgent: true,
      pusher: "agent" as const,
      explicitUserFollowUp: false,
      preExistingBaseFailure: false,
    };
    expect(evaluateCiAutofix({ facts: eligible, repairCount: 9 })).toEqual({ eligible: true });
    expect(evaluateCiAutofix({ facts: { ...eligible, prCreatedByAgent: false }, repairCount: 0 })).toEqual({
      eligible: false,
      reason: "not_agent_pr",
    });
    expect(evaluateCiAutofix({ facts: { ...eligible, pusher: "human" }, repairCount: 0 })).toEqual({
      eligible: false,
      reason: "human_push",
    });
    expect(
      evaluateCiAutofix({ facts: { ...eligible, explicitUserFollowUp: true }, repairCount: 0 }),
    ).toEqual({ eligible: false, reason: "user_follow_up" });
    expect(
      evaluateCiAutofix({ facts: { ...eligible, preExistingBaseFailure: true }, repairCount: 0 }),
    ).toEqual({ eligible: false, reason: "pre_existing_base_failure" });
    expect(evaluateCiAutofix({ facts: eligible, repairCount: 10 })).toEqual({
      eligible: false,
      reason: "repair_cap",
    });
  });
});
