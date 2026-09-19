import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CLOUD_AGENT_CI_AUTOFIX_REPAIR_CAP,
  CLOUD_AGENT_SUBSCRIPTION_WAKE_MAX_DAYS,
  CloudAgentSubscription,
  CloudAgentSubscriptionCreateRequest,
  CloudAgentSubscriptionReceipt,
} from "./cloudAgentSubscriptions.ts";

const decodeCreate = Schema.decodeUnknownSync(CloudAgentSubscriptionCreateRequest);
const decodeSubscription = Schema.decodeUnknownSync(CloudAgentSubscription);
const decodeReceipt = Schema.decodeUnknownSync(CloudAgentSubscriptionReceipt);

describe("cloud agent subscription contracts", () => {
  it("decodes GitHub, Slack, Linear, and timer subscription shapes", () => {
    expect(CLOUD_AGENT_SUBSCRIPTION_WAKE_MAX_DAYS).toBe(180);
    expect(CLOUD_AGENT_CI_AUTOFIX_REPAIR_CAP).toBe(10);
    expect(
      decodeCreate({
        kind: "github_ci",
        target: { type: "github_ci", repository: "acme/app", pullRequest: 12 },
      }).kind,
    ).toBe("github_ci");
    expect(
      decodeCreate({
        kind: "slack_thread",
        target: { type: "slack_thread", channelId: "C1", threadTs: "1.2" },
        prompt: { text: "New Slack activity" },
      }).target,
    ).toEqual({ type: "slack_thread", channelId: "C1", threadTs: "1.2" });
    expect(
      decodeCreate({
        kind: "loop",
        target: { type: "loop", cron: "0 9 * * 1-5", timezone: "UTC" },
      }).target.type,
    ).toBe("loop");
    expect(
      decodeSubscription({
        id: "sub-1",
        agentId: "bc-1",
        status: "active",
        kind: "linear_issue",
        target: { type: "linear_issue", issueId: "ENG-1" },
        coalesceWindowMs: 30_000,
        wakeMaxDays: 180,
        repairCount: 0,
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-19T00:00:00.000Z",
      }).status,
    ).toBe("active");
    expect(
      decodeReceipt({
        id: "receipt-1",
        subscriptionId: "sub-1",
        deliveryId: "evt-1",
        kind: "persisted",
        acknowledged: true,
        message: "Follow-up persisted.",
        agentId: "bc-1",
        runId: "run-1",
        createdAt: "2026-09-19T00:00:00.000Z",
      }).acknowledged,
    ).toBe(true);
  });
});
