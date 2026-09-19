import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CloudAgentsApiPrompt } from "./cloudAgentsApi.ts";

/** Cursor parity: an idle agent can still be woken from a subscription for this long. */
export const CLOUD_AGENT_SUBSCRIPTION_WAKE_MAX_DAYS = 180;
export const CLOUD_AGENT_CI_AUTOFIX_REPAIR_CAP = 10;
export const CLOUD_AGENT_SUBSCRIPTION_COALESCE_WINDOW_MS = 30_000;
export const CLOUD_AGENT_SUBSCRIPTION_RETRY_DELAY_MS = 30_000;
export const CLOUD_AGENT_SUBSCRIPTION_MAX_ATTEMPTS = 5;

export const CloudAgentSubscriptionKind = Schema.Literals([
  "github_pr",
  "github_ci",
  "slack_thread",
  "slack_channel",
  "linear_issue",
  "linear_comment",
  "timer",
  "loop",
]);
export type CloudAgentSubscriptionKind = typeof CloudAgentSubscriptionKind.Type;

export const CloudAgentSubscriptionStatus = Schema.Literals(["active", "cancelled", "disabled"]);
export type CloudAgentSubscriptionStatus = typeof CloudAgentSubscriptionStatus.Type;

export const CloudAgentSubscriptionTarget = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("github_pr"),
    repository: TrimmedNonEmptyString,
    pullRequest: PositiveInt,
  }),
  Schema.Struct({
    type: Schema.Literal("github_ci"),
    repository: TrimmedNonEmptyString,
    pullRequest: PositiveInt,
  }),
  Schema.Struct({
    type: Schema.Literal("slack_thread"),
    channelId: TrimmedNonEmptyString,
    threadTs: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("slack_channel"),
    channelId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("linear_issue"),
    issueId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("linear_comment"),
    issueId: TrimmedNonEmptyString,
    commentId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("timer"),
    runAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("loop"),
    cron: TrimmedNonEmptyString,
    timezone: TrimmedNonEmptyString,
  }),
]);
export type CloudAgentSubscriptionTarget = typeof CloudAgentSubscriptionTarget.Type;

export const CloudAgentSubscriptionCreateRequest = Schema.Struct({
  kind: CloudAgentSubscriptionKind,
  target: CloudAgentSubscriptionTarget,
  prompt: Schema.optionalKey(CloudAgentsApiPrompt),
  coalesceWindowMs: Schema.optionalKey(PositiveInt),
  wakeMaxDays: Schema.optionalKey(PositiveInt),
});
export type CloudAgentSubscriptionCreateRequest = typeof CloudAgentSubscriptionCreateRequest.Type;

export const CloudAgentSubscription = Schema.Struct({
  id: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  status: CloudAgentSubscriptionStatus,
  kind: CloudAgentSubscriptionKind,
  target: CloudAgentSubscriptionTarget,
  prompt: Schema.optionalKey(CloudAgentsApiPrompt),
  coalesceWindowMs: PositiveInt,
  wakeMaxDays: PositiveInt,
  repairCount: NonNegativeInt,
  nextFireAt: Schema.optionalKey(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  cancelledAt: Schema.optionalKey(IsoDateTime),
  disabledAt: Schema.optionalKey(IsoDateTime),
});
export type CloudAgentSubscription = typeof CloudAgentSubscription.Type;

export const CloudAgentCiAutofixFacts = Schema.Struct({
  prCreatedByAgent: Schema.Boolean,
  pusher: Schema.Literals(["agent", "human"]),
  explicitUserFollowUp: Schema.Boolean,
  preExistingBaseFailure: Schema.Boolean,
});
export type CloudAgentCiAutofixFacts = typeof CloudAgentCiAutofixFacts.Type;

export const CloudAgentSubscriptionDeliveryRequest = Schema.Struct({
  deliveryId: TrimmedNonEmptyString,
  prompt: Schema.optionalKey(CloudAgentsApiPrompt),
  occurredAt: Schema.optionalKey(IsoDateTime),
  ci: Schema.optionalKey(CloudAgentCiAutofixFacts),
});
export type CloudAgentSubscriptionDeliveryRequest =
  typeof CloudAgentSubscriptionDeliveryRequest.Type;

export const CloudAgentSubscriptionReceiptKind = Schema.Literals([
  "persisted",
  "coalesced",
  "skipped",
  "retryable",
  "failed",
]);
export type CloudAgentSubscriptionReceiptKind = typeof CloudAgentSubscriptionReceiptKind.Type;

export const CloudAgentSubscriptionReceipt = Schema.Struct({
  id: TrimmedNonEmptyString,
  subscriptionId: TrimmedNonEmptyString,
  deliveryId: TrimmedNonEmptyString,
  kind: CloudAgentSubscriptionReceiptKind,
  acknowledged: Schema.Boolean,
  message: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  runId: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type CloudAgentSubscriptionReceipt = typeof CloudAgentSubscriptionReceipt.Type;
