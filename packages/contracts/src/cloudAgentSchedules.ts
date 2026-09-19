import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CloudAgentsApiCreateAgentRequest,
  CloudAgentsApiCreateRunRequest,
  CloudAgentsApiModelSelection,
} from "./cloudAgentsApi.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CloudAgentScheduleStatus = Schema.Literals(["active", "paused"]);
export type CloudAgentScheduleStatus = typeof CloudAgentScheduleStatus.Type;

export const CloudAgentScheduleAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create_agent"),
    request: CloudAgentsApiCreateAgentRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("follow_up"),
    agentId: TrimmedNonEmptyString,
    request: CloudAgentsApiCreateRunRequest,
  }),
]);
export type CloudAgentScheduleAction = typeof CloudAgentScheduleAction.Type;

export const CloudAgentScheduleRefPolicy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("repository_default") }),
  Schema.Struct({ type: Schema.Literal("fixed"), ref: TrimmedNonEmptyString }),
]);
export type CloudAgentScheduleRefPolicy = typeof CloudAgentScheduleRefPolicy.Type;

/** The controller resolves this through the ordinary versioned environment path. */
export const CloudAgentScheduleRecipe = Schema.Struct({ type: Schema.Literal("current") });
export type CloudAgentScheduleRecipe = typeof CloudAgentScheduleRecipe.Type;

export const CloudAgentScheduleProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: CloudAgentsApiModelSelection,
});
export type CloudAgentScheduleProvider = typeof CloudAgentScheduleProvider.Type;

export const CloudAgentSchedulePublication = Schema.Literals([
  "review_only",
  "draft_pr",
  "inherit",
]);
export type CloudAgentSchedulePublication = typeof CloudAgentSchedulePublication.Type;

export const CloudAgentScheduleLimits = Schema.Struct({
  runSeconds: PositiveInt,
  inputWaitSeconds: PositiveInt,
  maxAttempts: PositiveInt,
  retryDelaySeconds: PositiveInt,
});
export type CloudAgentScheduleLimits = typeof CloudAgentScheduleLimits.Type;

export const CloudAgentScheduleMissedRunPolicy = Schema.Literals(["skip", "run_once"]);
export type CloudAgentScheduleMissedRunPolicy = typeof CloudAgentScheduleMissedRunPolicy.Type;

export const CloudAgentScheduleDefinition = Schema.Struct({
  name: TrimmedNonEmptyString,
  cron: TrimmedNonEmptyString,
  timezone: TrimmedNonEmptyString,
  action: CloudAgentScheduleAction,
  refPolicy: CloudAgentScheduleRefPolicy,
  recipe: CloudAgentScheduleRecipe,
  provider: CloudAgentScheduleProvider,
  publication: CloudAgentSchedulePublication,
  limits: CloudAgentScheduleLimits,
  missedRunPolicy: CloudAgentScheduleMissedRunPolicy,
  overlapPolicy: Schema.Literal("skip"),
});
export type CloudAgentScheduleDefinition = typeof CloudAgentScheduleDefinition.Type;

export const CloudAgentScheduleCreateRequest = CloudAgentScheduleDefinition;
export type CloudAgentScheduleCreateRequest = typeof CloudAgentScheduleCreateRequest.Type;

export const CloudAgentSchedule = Schema.Struct({
  id: TrimmedNonEmptyString,
  status: CloudAgentScheduleStatus,
  definition: CloudAgentScheduleDefinition,
  nextRunAt: Schema.optionalKey(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudAgentSchedule = typeof CloudAgentSchedule.Type;

export const CloudAgentScheduleActivityKind = Schema.Literals([
  "triggered",
  "completed",
  "failed",
  "cancelled",
  "missed",
  "skipped_overlap",
  "retry_scheduled",
]);
export type CloudAgentScheduleActivityKind = typeof CloudAgentScheduleActivityKind.Type;

export const CloudAgentScheduleActivity = Schema.Struct({
  id: TrimmedNonEmptyString,
  scheduleId: TrimmedNonEmptyString,
  kind: CloudAgentScheduleActivityKind,
  message: TrimmedNonEmptyString,
  scheduledFor: IsoDateTime,
  agentId: Schema.optionalKey(TrimmedNonEmptyString),
  runId: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type CloudAgentScheduleActivity = typeof CloudAgentScheduleActivity.Type;
