import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CloudAgentsApiEnvTarget,
  CloudAgentsApiMcpServer,
  CloudAgentsApiModelSelection,
  CloudAgentsApiRepoInput,
} from "./cloudAgentsApi.ts";
import {
  CloudAgentScheduleLimits,
  CloudAgentScheduleMissedRunPolicy,
  CloudAgentSchedulePublication,
} from "./cloudAgentSchedules.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CLOUD_AUTOMATION_MEMORY_MAX_BYTES = 8 * 1024;
export const CLOUD_AUTOMATION_INSTRUCTIONS_MAX_BYTES = 32 * 1024;
export const CLOUD_AUTOMATION_MISSED_RUN_GRACE_MS = 90_000;

export const CloudAgentAutomationStatus = Schema.Literals(["active", "paused"]);
export type CloudAgentAutomationStatus = typeof CloudAgentAutomationStatus.Type;

export const CloudAgentAutomationRunAs = Schema.Literals(["caller", "service_account"]);
export type CloudAgentAutomationRunAs = typeof CloudAgentAutomationRunAs.Type;

export const CloudAgentAutomationSourceControlProvider = Schema.Literals([
  "github",
  "gitlab",
  "bitbucket",
]);
export type CloudAgentAutomationSourceControlProvider =
  typeof CloudAgentAutomationSourceControlProvider.Type;

export const CloudAgentAutomationSourceControlEvent = Schema.Literals([
  "draft_opened",
  "pull_request_opened",
  "pull_request_pushed",
  "pull_request_merged",
  "push_to_branch",
  "comment_added",
  "pull_request_label_changed",
  "issue_label_changed",
  "ci_completed",
  "issue_comment",
  "pr_review_comment",
  "pr_review_submitted",
  "review_thread_updated",
  "workflow_run_completed",
  "pull_request_approved",
]);
export type CloudAgentAutomationSourceControlEvent =
  typeof CloudAgentAutomationSourceControlEvent.Type;

export const CloudAgentAutomationSlackEvent = Schema.Literals([
  "channel_message",
  "emoji_reaction",
  "channel_created",
]);
export type CloudAgentAutomationSlackEvent = typeof CloudAgentAutomationSlackEvent.Type;

export const CloudAgentAutomationLinearEvent = Schema.Literals([
  "issue_created",
  "status_changed",
  "cycle_ended",
]);
export type CloudAgentAutomationLinearEvent = typeof CloudAgentAutomationLinearEvent.Type;

export const CloudAgentAutomationSentryEvent = Schema.Literals([
  "issue_created",
  "issue_updated",
  "any",
]);
export type CloudAgentAutomationSentryEvent = typeof CloudAgentAutomationSentryEvent.Type;

export const CloudAgentAutomationPagerDutyEvent = Schema.Literals([
  "incident_triggered",
  "incident_acknowledged",
  "incident_resolved",
  "any",
]);
export type CloudAgentAutomationPagerDutyEvent = typeof CloudAgentAutomationPagerDutyEvent.Type;

export const CloudAgentAutomationTrigger = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("cron"),
    cron: TrimmedNonEmptyString,
    timezone: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("source_control"),
    provider: CloudAgentAutomationSourceControlProvider,
    events: Schema.Array(CloudAgentAutomationSourceControlEvent),
    repositories: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  }),
  Schema.Struct({
    type: Schema.Literal("slack"),
    events: Schema.Array(CloudAgentAutomationSlackEvent),
    channelId: Schema.optionalKey(TrimmedNonEmptyString),
    filter: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("linear"),
    events: Schema.Array(CloudAgentAutomationLinearEvent),
  }),
  Schema.Struct({
    type: Schema.Literal("sentry"),
    events: Schema.Array(CloudAgentAutomationSentryEvent),
  }),
  Schema.Struct({
    type: Schema.Literal("pagerduty"),
    events: Schema.Array(CloudAgentAutomationPagerDutyEvent),
  }),
  Schema.Struct({
    type: Schema.Literal("webhook"),
  }),
]);
export type CloudAgentAutomationTrigger = typeof CloudAgentAutomationTrigger.Type;

export const CloudAgentAutomationTools = Schema.Struct({
  createPullRequest: Schema.Boolean,
  commentOnPullRequest: Schema.Boolean,
  requestReviewers: Schema.Boolean,
  sendToSlack: Schema.Boolean,
  readSlack: Schema.Boolean,
  mcp: Schema.Boolean,
  memories: Schema.Boolean,
  computerUse: Schema.Boolean,
});
export type CloudAgentAutomationTools = typeof CloudAgentAutomationTools.Type;

export const CloudAgentAutomationProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: CloudAgentsApiModelSelection,
});
export type CloudAgentAutomationProvider = typeof CloudAgentAutomationProvider.Type;

export const CloudAgentAutomationRepositories = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("none") }),
  Schema.Struct({
    mode: Schema.Literals(["single", "multi"]),
    repos: Schema.Array(CloudAgentsApiRepoInput),
  }),
]);
export type CloudAgentAutomationRepositories = typeof CloudAgentAutomationRepositories.Type;

export const CloudAgentAutomationDefinition = Schema.Struct({
  name: TrimmedNonEmptyString,
  instructions: TrimmedNonEmptyString,
  triggers: Schema.Array(CloudAgentAutomationTrigger),
  environment: Schema.optionalKey(CloudAgentsApiEnvTarget),
  repositories: CloudAgentAutomationRepositories,
  provider: CloudAgentAutomationProvider,
  tools: CloudAgentAutomationTools,
  mcpServers: Schema.optionalKey(Schema.Array(CloudAgentsApiMcpServer)),
  publication: CloudAgentSchedulePublication,
  limits: CloudAgentScheduleLimits,
  missedRunPolicy: CloudAgentScheduleMissedRunPolicy,
  overlapPolicy: Schema.Literal("skip"),
  runAs: CloudAgentAutomationRunAs,
  hibernateAfterCompletion: Schema.Boolean,
});
export type CloudAgentAutomationDefinition = typeof CloudAgentAutomationDefinition.Type;

export const CloudAgentAutomationCreateRequest = CloudAgentAutomationDefinition;
export type CloudAgentAutomationCreateRequest = typeof CloudAgentAutomationCreateRequest.Type;

export const CloudAgentAutomationWebhook = Schema.Struct({
  hookId: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  tokenPrefix: TrimmedNonEmptyString,
});
export type CloudAgentAutomationWebhook = typeof CloudAgentAutomationWebhook.Type;

export const CloudAgentAutomation = Schema.Struct({
  id: TrimmedNonEmptyString,
  status: CloudAgentAutomationStatus,
  definition: CloudAgentAutomationDefinition,
  ownerPrincipalId: TrimmedNonEmptyString,
  actorKind: Schema.Literals(["user", "service_account"]),
  actorPrincipalId: TrimmedNonEmptyString,
  webhook: Schema.optionalKey(CloudAgentAutomationWebhook),
  webhookToken: Schema.optionalKey(TrimmedNonEmptyString),
  nextRunAt: Schema.optionalKey(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudAgentAutomation = typeof CloudAgentAutomation.Type;

export const CloudAgentAutomationActivityKind = Schema.Literals([
  "triggered",
  "completed",
  "failed",
  "cancelled",
  "missed",
  "skipped_overlap",
  "skipped_unmatched",
  "retry_scheduled",
  "deduplicated",
]);
export type CloudAgentAutomationActivityKind = typeof CloudAgentAutomationActivityKind.Type;

export const CloudAgentAutomationActivity = Schema.Struct({
  id: TrimmedNonEmptyString,
  automationId: TrimmedNonEmptyString,
  kind: CloudAgentAutomationActivityKind,
  message: TrimmedNonEmptyString,
  scheduledFor: IsoDateTime,
  deliveryId: Schema.optionalKey(TrimmedNonEmptyString),
  agentId: Schema.optionalKey(TrimmedNonEmptyString),
  runId: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type CloudAgentAutomationActivity = typeof CloudAgentAutomationActivity.Type;

export const CloudAgentAutomationDeliveryRequest = Schema.Struct({
  deliveryId: TrimmedNonEmptyString,
  type: Schema.Literals([
    "source_control",
    "slack",
    "linear",
    "sentry",
    "pagerduty",
    "webhook",
  ]),
  event: TrimmedNonEmptyString,
  text: Schema.optionalKey(TrimmedNonEmptyString),
  repository: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(CloudAgentAutomationSourceControlProvider),
  channelId: Schema.optionalKey(TrimmedNonEmptyString),
  occurredAt: Schema.optionalKey(IsoDateTime),
});
export type CloudAgentAutomationDeliveryRequest = typeof CloudAgentAutomationDeliveryRequest.Type;

export const CloudAgentAutomationMemoryFact = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  source: Schema.optionalKey(
    Schema.Struct({
      agentId: TrimmedNonEmptyString,
      runId: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudAgentAutomationMemoryFact = typeof CloudAgentAutomationMemoryFact.Type;

export const CloudAgentAutomationMemoryWrite = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  text: TrimmedNonEmptyString,
  source: Schema.optionalKey(
    Schema.Struct({
      agentId: TrimmedNonEmptyString,
      runId: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
});
export type CloudAgentAutomationMemoryWrite = typeof CloudAgentAutomationMemoryWrite.Type;
