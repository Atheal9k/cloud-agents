// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CLOUD_AGENTS_API_MAX_MCP_SERVERS,
  CLOUD_AUTOMATION_INSTRUCTIONS_MAX_BYTES,
  CLOUD_AUTOMATION_MEMORY_MAX_BYTES,
  type CloudAgentAutomationDefinition,
  type CloudAgentAutomationDeliveryRequest,
  type CloudAgentAutomationMemoryWrite,
  type CloudAgentAutomationTrigger,
} from "@t3tools/contracts";

import {
  nextCloudAgentScheduleAt,
  validateCloudAgentScheduleTiming,
  type ParsedCron,
} from "./cloudAgentSchedulePolicy.ts";

export function validateCloudAgentAutomationDefinition(
  definition: CloudAgentAutomationDefinition,
): string | undefined {
  if (definition.triggers.length === 0) return "An automation needs at least one trigger.";
  if (Buffer.byteLength(definition.instructions, "utf8") > CLOUD_AUTOMATION_INSTRUCTIONS_MAX_BYTES) {
    return `Automation instructions must stay within ${CLOUD_AUTOMATION_INSTRUCTIONS_MAX_BYTES} bytes.`;
  }
  if (definition.provider.instanceId !== "codex") {
    return "Cloud automations currently support the qualified Codex provider only.";
  }
  if (definition.publication === "inherit") {
    return "An automation must choose review_only or draft_pr publication.";
  }
  if (definition.limits.maxAttempts > 10) return "Automation retries are limited to 10 attempts.";
  if (definition.limits.retryDelaySeconds > 86_400) {
    return "Automation retry delay may not exceed 86400 seconds.";
  }
  if (definition.tools.mcp) {
    if (definition.mcpServers === undefined || definition.mcpServers.length === 0) {
      return "The MCP tool requires at least one MCP server.";
    }
    if (definition.mcpServers.length > CLOUD_AGENTS_API_MAX_MCP_SERVERS) {
      return `Automations may list at most ${CLOUD_AGENTS_API_MAX_MCP_SERVERS} MCP servers.`;
    }
  } else if (definition.mcpServers !== undefined && definition.mcpServers.length > 0) {
    return "MCP servers require the MCP tool.";
  }
  const sourceControl = definition.triggers.some((trigger) => trigger.type === "source_control");
  if (sourceControl && definition.repositories.mode === "none") {
    return "Source-control triggers require a repository.";
  }
  if (
    definition.tools.createPullRequest &&
    definition.repositories.mode === "none" &&
    definition.publication === "draft_pr"
  ) {
    return "Draft pull requests require a repository.";
  }
  for (const trigger of definition.triggers) {
    const triggerError = validateTrigger(trigger);
    if (triggerError !== undefined) return triggerError;
  }
  return undefined;
}

function validateTrigger(trigger: CloudAgentAutomationTrigger): string | undefined {
  switch (trigger.type) {
    case "cron": {
      const timing = validateCloudAgentScheduleTiming(trigger);
      return "message" in timing ? timing.message : undefined;
    }
    case "source_control":
      return trigger.events.length === 0
        ? "A source-control trigger needs at least one event."
        : undefined;
    case "slack":
      return trigger.events.length === 0 ? "A Slack trigger needs at least one event." : undefined;
    case "linear":
      return trigger.events.length === 0 ? "A Linear trigger needs at least one event." : undefined;
    case "sentry":
      return trigger.events.length === 0 ? "A Sentry trigger needs at least one event." : undefined;
    case "pagerduty":
      return trigger.events.length === 0
        ? "A PagerDuty trigger needs at least one event."
        : undefined;
    case "webhook":
      return undefined;
  }
}

export function validateCloudAgentAutomationMemory(
  fact: CloudAgentAutomationMemoryWrite,
): string | undefined {
  if (Buffer.byteLength(fact.text, "utf8") > CLOUD_AUTOMATION_MEMORY_MAX_BYTES) {
    return `Automation memories must stay within ${CLOUD_AUTOMATION_MEMORY_MAX_BYTES} bytes.`;
  }
}

export function cronTriggersOf(
  definition: CloudAgentAutomationDefinition,
): ReadonlyArray<{ readonly cron: string; readonly timezone: string }> {
  return definition.triggers.flatMap((trigger) =>
    trigger.type === "cron" ? [{ cron: trigger.cron, timezone: trigger.timezone }] : [],
  );
}

export function nextCloudAgentAutomationAt(input: {
  readonly definition: CloudAgentAutomationDefinition;
  readonly afterMs: number;
}): string | undefined {
  let earliest: string | undefined;
  for (const trigger of cronTriggersOf(input.definition)) {
    const timing = validateCloudAgentScheduleTiming(trigger);
    if ("message" in timing) continue;
    const next = nextCloudAgentScheduleAt({
      cron: timing.cron,
      timezone: trigger.timezone,
      afterMs: input.afterMs,
    });
    if (next !== undefined && (earliest === undefined || next < earliest)) earliest = next;
  }
  return earliest;
}

export function parsedCronOrThrow(cron: string, timezone: string): ParsedCron {
  const timing = validateCloudAgentScheduleTiming({ cron, timezone });
  if ("message" in timing) throw new Error(timing.message);
  return timing.cron;
}

export function matchingAutomationTrigger(
  definition: CloudAgentAutomationDefinition,
  delivery: CloudAgentAutomationDeliveryRequest,
): CloudAgentAutomationTrigger | undefined {
  return definition.triggers.find((trigger) => triggerMatches(trigger, definition, delivery));
}

function triggerMatches(
  trigger: CloudAgentAutomationTrigger,
  definition: CloudAgentAutomationDefinition,
  delivery: CloudAgentAutomationDeliveryRequest,
): boolean {
  switch (trigger.type) {
    case "cron":
      return false;
    case "webhook":
      return delivery.type === "webhook";
    case "source_control": {
      if (delivery.type !== "source_control" || delivery.provider !== trigger.provider) {
        return false;
      }
      if (!includesEvent(trigger.events, delivery.event)) return false;
      const scoped = trigger.repositories ?? repositoryNames(definition);
      if (scoped.length === 0) return true;
      return delivery.repository !== undefined && listed(scoped, delivery.repository);
    }
    case "slack": {
      if (delivery.type !== "slack" || !includesEvent(trigger.events, delivery.event)) return false;
      if (trigger.channelId !== undefined && delivery.channelId !== trigger.channelId) return false;
      if (trigger.filter === undefined) return true;
      return (delivery.text ?? "").toLowerCase().includes(trigger.filter.toLowerCase());
    }
    case "linear":
      return delivery.type === "linear" && includesEvent(trigger.events, delivery.event);
    case "sentry":
      return delivery.type === "sentry" && includesEvent(trigger.events, delivery.event);
    case "pagerduty":
      return delivery.type === "pagerduty" && includesEvent(trigger.events, delivery.event);
  }
}

function includesEvent(events: ReadonlyArray<string>, event: string): boolean {
  return events.includes("any") || events.includes(event);
}

function repositoryNames(definition: CloudAgentAutomationDefinition): ReadonlyArray<string> {
  if (definition.repositories.mode === "none") return [];
  return definition.repositories.repos.flatMap((repo) => {
    try {
      const path = new URL(repo.url).pathname.replace(/^\//u, "").replace(/\.git$/u, "");
      return path.length > 0 ? [path] : [];
    } catch {
      return [];
    }
  });
}

function listed(list: ReadonlyArray<string>, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return list.some((entry) => entry.trim().toLowerCase() === normalized);
}

export function automationPrompt(input: {
  readonly instructions: string;
  readonly delivery?: CloudAgentAutomationDeliveryRequest;
  readonly memories: ReadonlyArray<{ readonly name: string; readonly text: string }>;
  readonly tools: CloudAgentAutomationDefinition["tools"];
}): { readonly text: string } {
  const sections = [input.instructions.trim()];
  if (input.delivery !== undefined) {
    const lines = [
      `Trigger: ${input.delivery.type}/${input.delivery.event}`,
      `Delivery: ${input.delivery.deliveryId}`,
    ];
    if (input.delivery.repository !== undefined) {
      lines.push(`Repository: ${input.delivery.repository}`);
    }
    if (input.delivery.text !== undefined && input.delivery.text.length > 0) {
      lines.push(`Event: ${input.delivery.text}`);
    }
    sections.push(lines.join("\n"));
  }
  if (input.tools.memories && input.memories.length > 0) {
    sections.push(
      input.memories
        .map((memory) => `Memory ${memory.name}:\n${memory.text}`)
        .join("\n\n"),
    );
  }
  const enabled = enabledTools(input.tools);
  if (enabled.length > 0) {
    sections.push(`Enabled actions: ${enabled.join(", ")}.`);
  }
  return { text: sections.join("\n\n") };
}

function enabledTools(tools: CloudAgentAutomationDefinition["tools"]): ReadonlyArray<string> {
  const labels: string[] = [];
  if (tools.createPullRequest) labels.push("create pull requests");
  if (tools.commentOnPullRequest) labels.push("comment on pull requests");
  if (tools.requestReviewers) labels.push("request reviewers");
  if (tools.sendToSlack) labels.push("post to Slack");
  if (tools.readSlack) labels.push("read Slack");
  if (tools.mcp) labels.push("call MCP");
  if (tools.memories) labels.push("update inspectable memories");
  if (tools.computerUse) labels.push("use computer control");
  return labels;
}

export function hashAutomationSecret(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

export function verifyAutomationWebhookToken(input: {
  readonly tokenHash: string;
  readonly token: string;
}): boolean {
  const actual = Buffer.from(hashAutomationSecret(input.token), "hex");
  const expected = Buffer.from(input.tokenHash, "hex");
  return actual.length === expected.length && NodeCrypto.timingSafeEqual(actual, expected);
}

export function serviceAccountPrincipalId(teamId: string): string {
  return `principal:automation-sa:${teamId}`;
}
