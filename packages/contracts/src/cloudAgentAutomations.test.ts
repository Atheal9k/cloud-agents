import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CloudAgentAutomation,
  CloudAgentAutomationCreateRequest,
  CloudAgentAutomationDeliveryRequest,
  CloudAgentAutomationMemoryFact,
} from "./cloudAgentAutomations.ts";

const decodeCreate = Schema.decodeUnknownSync(CloudAgentAutomationCreateRequest);
const decodeAutomation = Schema.decodeUnknownSync(CloudAgentAutomation);
const decodeDelivery = Schema.decodeUnknownSync(CloudAgentAutomationDeliveryRequest);
const decodeMemory = Schema.decodeUnknownSync(CloudAgentAutomationMemoryFact);

describe("cloud agent automation contracts", () => {
  it("decodes cron, source-control, Slack, Linear, Sentry, PagerDuty, and webhook triggers", () => {
    const definition = decodeCreate({
      name: "Triage incidents",
      instructions: "Investigate the event and open a draft PR when a fix is clear.",
      triggers: [
        { type: "cron", cron: "0 9 * * 1-5", timezone: "Australia/Sydney" },
        {
          type: "source_control",
          provider: "github",
          events: ["pull_request_opened", "ci_completed"],
          repositories: ["acme/app"],
        },
        { type: "slack", events: ["channel_message"], channelId: "C123", filter: "bug" },
        { type: "linear", events: ["issue_created"] },
        { type: "sentry", events: ["any"] },
        { type: "pagerduty", events: ["incident_triggered"] },
        { type: "webhook" },
      ],
      environment: { type: "cloud", name: "default" },
      repositories: {
        mode: "single",
        repos: [{ url: "https://github.com/acme/app", startingRef: "main" }],
      },
      provider: { instanceId: "codex", model: { id: "default" } },
      tools: {
        createPullRequest: true,
        commentOnPullRequest: true,
        requestReviewers: true,
        sendToSlack: true,
        readSlack: false,
        mcp: true,
        memories: true,
        computerUse: true,
      },
      mcpServers: [{ name: "docs", type: "http", url: "https://mcp.example/docs" }],
      publication: "draft_pr",
      limits: {
        runSeconds: 3_600,
        inputWaitSeconds: 300,
        maxAttempts: 3,
        retryDelaySeconds: 60,
      },
      missedRunPolicy: "skip",
      overlapPolicy: "skip",
      runAs: "service_account",
      hibernateAfterCompletion: true,
    });
    expect(definition.triggers).toHaveLength(7);
    expect(definition.runAs).toBe("service_account");

    expect(
      decodeDelivery({
        deliveryId: "evt-1",
        type: "pagerduty",
        event: "incident_triggered",
        text: "API latency",
      }).type,
    ).toBe("pagerduty");

    expect(
      decodeMemory({
        id: "mem-1",
        name: "MEMORIES.md",
        text: "Incidents after 09:00 local are usually cache stampedes.",
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-19T00:00:00.000Z",
      }).name,
    ).toBe("MEMORIES.md");

    expect(
      decodeAutomation({
        id: "auto-1",
        status: "active",
        definition,
        ownerPrincipalId: "principal:user",
        actorKind: "service_account",
        actorPrincipalId: "principal:automation-sa:team",
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-19T00:00:00.000Z",
      }).actorKind,
    ).toBe("service_account");
  });
});
