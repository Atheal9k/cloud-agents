import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CloudGithubTriggerEvent = Schema.Literals([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "check_run",
]);
export type CloudGithubTriggerEvent = typeof CloudGithubTriggerEvent.Type;

export const CloudGithubTriggerLimits = Schema.Struct({
  maxAttempts: PositiveInt,
  runSeconds: PositiveInt,
  inputWaitSeconds: PositiveInt,
  maxComputeSeconds: PositiveInt,
});
export type CloudGithubTriggerLimits = typeof CloudGithubTriggerLimits.Type;

export const CloudGithubTriggerDefinition = Schema.Struct({
  repository: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  authorizedActors: Schema.Array(TrimmedNonEmptyString),
  events: Schema.Array(CloudGithubTriggerEvent),
  limits: CloudGithubTriggerLimits,
});
export type CloudGithubTriggerDefinition = typeof CloudGithubTriggerDefinition.Type;

export const CloudGithubTriggerStatus = Schema.Literals(["enabled", "disabled", "revoked"]);
export type CloudGithubTriggerStatus = typeof CloudGithubTriggerStatus.Type;

export const CloudGithubTrigger = Schema.Struct({
  id: TrimmedNonEmptyString,
  status: CloudGithubTriggerStatus,
  definition: CloudGithubTriggerDefinition,
  webhookUrl: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudGithubTrigger = typeof CloudGithubTrigger.Type;

export const CloudGithubTriggerCreated = Schema.Struct({
  trigger: CloudGithubTrigger,
  secret: TrimmedNonEmptyString,
});
export type CloudGithubTriggerCreated = typeof CloudGithubTriggerCreated.Type;

export const CloudGithubTriggerSource = Schema.Struct({
  kind: Schema.Literals(["issue", "pull_request"]),
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  baseRevision: TrimmedNonEmptyString,
  actor: TrimmedNonEmptyString,
  event: CloudGithubTriggerEvent,
  action: TrimmedNonEmptyString,
  commentId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudGithubTriggerSource = typeof CloudGithubTriggerSource.Type;

export const CloudGithubTriggerActivityStatus = Schema.Literals([
  "triggered",
  "resolved",
  "unresolved",
  "ignored",
]);
export type CloudGithubTriggerActivityStatus = typeof CloudGithubTriggerActivityStatus.Type;

export const CloudGithubTriggerActivity = Schema.Struct({
  deliveryId: TrimmedNonEmptyString,
  triggerId: TrimmedNonEmptyString,
  source: CloudGithubTriggerSource,
  attempt: NonNegativeInt,
  reservedComputeSeconds: NonNegativeInt,
  status: CloudGithubTriggerActivityStatus,
  message: TrimmedNonEmptyString,
  agentId: Schema.optionalKey(TrimmedNonEmptyString),
  runId: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudGithubTriggerActivity = typeof CloudGithubTriggerActivity.Type;

export const CloudGithubWebhookResult = Schema.Struct({
  status: CloudGithubTriggerActivityStatus,
  reused: Schema.Boolean,
  message: TrimmedNonEmptyString,
  agentId: Schema.optionalKey(TrimmedNonEmptyString),
  runId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudGithubWebhookResult = typeof CloudGithubWebhookResult.Type;
