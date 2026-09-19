import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { CloudAgentAutomationCreateRequest } from "@t3tools/contracts";

import {
  automationPrompt,
  matchingAutomationTrigger,
  nextCloudAgentAutomationAt,
  validateCloudAgentAutomationDefinition,
  verifyAutomationWebhookToken,
  hashAutomationSecret,
} from "./cloudAgentAutomationPolicy.ts";

const decode = Schema.decodeUnknownSync(CloudAgentAutomationCreateRequest);

const definition = decode({
  name: "Triage",
  instructions: "Investigate.",
  triggers: [
    { type: "cron", cron: "0 9 * * 1-5", timezone: "Australia/Sydney" },
    {
      type: "source_control",
      provider: "github",
      events: ["pull_request_opened"],
      repositories: ["acme/app"],
    },
    { type: "slack", events: ["channel_message"], filter: "bug" },
    { type: "sentry", events: ["any"] },
    { type: "webhook" },
  ],
  repositories: { mode: "single", repos: [{ url: "https://github.com/acme/app" }] },
  provider: { instanceId: "codex", model: { id: "default" } },
  tools: {
    createPullRequest: true,
    commentOnPullRequest: false,
    requestReviewers: false,
    sendToSlack: false,
    readSlack: false,
    mcp: false,
    memories: true,
    computerUse: true,
  },
  publication: "review_only",
  limits: {
    runSeconds: 3_600,
    inputWaitSeconds: 300,
    maxAttempts: 3,
    retryDelaySeconds: 60,
  },
  missedRunPolicy: "skip",
  overlapPolicy: "skip",
  runAs: "caller",
  hibernateAfterCompletion: true,
});

describe("cloud agent automation policy", () => {
  it("rejects source-control triggers without a repository and inherit publication", () => {
    expect(
      validateCloudAgentAutomationDefinition({
        ...definition,
        repositories: { mode: "none" },
      }),
    ).toMatch(/repository/u);
    expect(
      validateCloudAgentAutomationDefinition({
        ...definition,
        publication: "inherit",
      }),
    ).toMatch(/publication/u);
  });

  it("matches source-control, Slack filters, Sentry any, and private webhooks", () => {
    expect(
      matchingAutomationTrigger(definition, {
        deliveryId: "1",
        type: "source_control",
        provider: "github",
        event: "pull_request_opened",
        repository: "acme/app",
      })?.type,
    ).toBe("source_control");
    expect(
      matchingAutomationTrigger(definition, {
        deliveryId: "2",
        type: "slack",
        event: "channel_message",
        text: "ship it",
      }),
    ).toBeUndefined();
    expect(
      matchingAutomationTrigger(definition, {
        deliveryId: "3",
        type: "slack",
        event: "channel_message",
        text: "production bug",
      })?.type,
    ).toBe("slack");
    expect(
      matchingAutomationTrigger(definition, {
        deliveryId: "4",
        type: "sentry",
        event: "issue_updated",
      })?.type,
    ).toBe("sentry");
    expect(
      matchingAutomationTrigger(definition, {
        deliveryId: "5",
        type: "webhook",
        event: "custom",
      })?.type,
    ).toBe("webhook");
  });

  it("skips missing DST wall times and includes inspectable memories in the prompt", () => {
    const next = nextCloudAgentAutomationAt({
      definition: {
        ...definition,
        triggers: [{ type: "cron", cron: "0 2 * * *", timezone: "Australia/Sydney" }],
      },
      afterMs: Date.parse("2026-04-04T15:00:00.000Z"),
    });
    expect(next).toBeDefined();
    expect(
      automationPrompt({
        instructions: "Investigate.",
        memories: [{ name: "MEMORIES.md", text: "Cache stampedes after 09:00." }],
        tools: definition.tools,
        delivery: {
          deliveryId: "pd-1",
          type: "pagerduty",
          event: "incident_triggered",
          text: "API latency",
        },
      }).text,
    ).toContain("Cache stampedes after 09:00.");
  });

  it("compares webhook tokens in constant time", () => {
    const token = "t3auto_secret";
    expect(
      verifyAutomationWebhookToken({ tokenHash: hashAutomationSecret(token), token }),
    ).toBe(true);
    expect(
      verifyAutomationWebhookToken({
        tokenHash: hashAutomationSecret(token),
        token: "t3auto_other",
      }),
    ).toBe(false);
  });
});
