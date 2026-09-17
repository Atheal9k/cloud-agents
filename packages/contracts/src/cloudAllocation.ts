import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RunAllocationAttempt,
  RunAllocationId,
  RunWorkerId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatformArch, ExecutionEnvironmentPlatformOs } from "./environment.ts";

export const RunWorkerDevice = Schema.Literals(["android", "ios"]);
export type RunWorkerDevice = typeof RunWorkerDevice.Type;

export const RunWorkerProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  device: Schema.optionalKey(RunWorkerDevice),
});
export type RunWorkerProfile = typeof RunWorkerProfile.Type;

export const RunRepositoryTarget = Schema.Struct({
  repository: TrimmedNonEmptyString,
  baseCommit: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type RunRepositoryTarget = typeof RunRepositoryTarget.Type;

export const RunDeadlines = Schema.Struct({
  launchBy: IsoDateTime,
  bootBy: IsoDateTime,
  registerBy: IsoDateTime,
  expiresAt: IsoDateTime,
  cleanupBy: IsoDateTime,
});
export type RunDeadlines = typeof RunDeadlines.Type;

export const RunLaunchTemplate = Schema.Struct({
  id: TrimmedNonEmptyString,
  version: PositiveInt,
});
export type RunLaunchTemplate = typeof RunLaunchTemplate.Type;

export const RunLaunchRetry = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), failures: NonNegativeInt }),
  Schema.Struct({
    status: Schema.Literal("waiting"),
    failures: PositiveInt,
    retryAt: IsoDateTime,
    reason: TrimmedNonEmptyString,
  }),
]);
export type RunLaunchRetry = typeof RunLaunchRetry.Type;

export const RunWorkerReferences = Schema.Struct({
  workerId: RunWorkerId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type RunWorkerReferences = typeof RunWorkerReferences.Type;

export const RunResultLocation = Schema.Struct({
  uri: TrimmedNonEmptyString,
});
export type RunResultLocation = typeof RunResultLocation.Type;

export const RunAllocationState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("queued") }),
  Schema.Struct({
    status: Schema.Literal("launching"),
    startedAt: IsoDateTime,
    launchTemplate: RunLaunchTemplate,
    retry: RunLaunchRetry,
  }),
  Schema.Struct({
    status: Schema.Literal("booting"),
    instanceId: TrimmedNonEmptyString,
    launchedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("registering"),
    instanceId: TrimmedNonEmptyString,
    bootedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    instanceId: TrimmedNonEmptyString,
    references: RunWorkerReferences,
    readyAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: TrimmedNonEmptyString,
    failedAt: IsoDateTime,
    instanceId: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type RunAllocationState = typeof RunAllocationState.Type;

export const RunAgentOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("not-started") }),
  Schema.Struct({ status: Schema.Literal("running"), startedAt: IsoDateTime }),
  Schema.Struct({
    status: Schema.Literal("succeeded"),
    resultLocation: RunResultLocation,
    completedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: TrimmedNonEmptyString,
    resultLocation: RunResultLocation,
    completedAt: IsoDateTime,
  }),
  Schema.Struct({ status: Schema.Literal("cancelled"), cancelledAt: IsoDateTime }),
]);
export type RunAgentOutcome = typeof RunAgentOutcome.Type;

export const RunPreviewState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable") }),
  Schema.Struct({
    status: Schema.Literal("available"),
    url: TrimmedNonEmptyString,
    publishedAt: IsoDateTime,
  }),
]);
export type RunPreviewState = typeof RunPreviewState.Type;

export const RunCleanupState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("not-requested") }),
  Schema.Struct({ status: Schema.Literal("requested"), requestedAt: IsoDateTime }),
  Schema.Struct({ status: Schema.Literal("running"), startedAt: IsoDateTime }),
  Schema.Struct({ status: Schema.Literal("succeeded"), completedAt: IsoDateTime }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: TrimmedNonEmptyString,
    failedAt: IsoDateTime,
  }),
]);
export type RunCleanupState = typeof RunCleanupState.Type;

export const RunAllocation = Schema.Struct({
  id: RunAllocationId,
  attempt: RunAllocationAttempt,
  target: RunRepositoryTarget,
  profile: RunWorkerProfile,
  deadlines: RunDeadlines,
  allocationState: RunAllocationState,
  agentOutcome: RunAgentOutcome,
  previewState: RunPreviewState,
  cleanupState: RunCleanupState,
  handledCommandIds: Schema.Array(CommandId),
  sequence: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RunAllocation = typeof RunAllocation.Type;

const CommandBase = {
  commandId: CommandId,
  allocationId: RunAllocationId,
  occurredAt: IsoDateTime,
};

const AttemptCommandBase = {
  ...CommandBase,
  attempt: RunAllocationAttempt,
};

export const RunAllocationCommand = Schema.Union([
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.launch"),
    target: RunRepositoryTarget,
    profile: RunWorkerProfile,
    deadlines: RunDeadlines,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.launch-started"),
    launchTemplate: RunLaunchTemplate,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.launch-retry-scheduled"),
    failures: PositiveInt,
    retryAt: IsoDateTime,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.instance-launched"),
    instanceId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.worker-booted") }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.worker-assigned"),
    references: RunWorkerReferences,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.launch-failed"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.agent-started") }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.agent-succeeded"),
    resultLocation: RunResultLocation,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.agent-failed"),
    reason: TrimmedNonEmptyString,
    resultLocation: RunResultLocation,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.preview-published"),
    url: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.preview-withdrawn") }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.cancel") }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.cleanup-started") }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.cleanup-succeeded") }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.cleanup-failed"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.retry"),
    nextAttempt: RunAllocationAttempt,
    deadlines: RunDeadlines,
  }),
]);
export type RunAllocationCommand = typeof RunAllocationCommand.Type;

const EventBase = {
  sequence: NonNegativeInt,
  commandId: CommandId,
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  occurredAt: IsoDateTime,
};

export const RunAllocationEvent = Schema.Union([
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.requested"),
    target: RunRepositoryTarget,
    profile: RunWorkerProfile,
    deadlines: RunDeadlines,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.launch-started"),
    launchTemplate: RunLaunchTemplate,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.launch-retry-scheduled"),
    failures: PositiveInt,
    retryAt: IsoDateTime,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.instance-launched"),
    instanceId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.worker-booted") }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.worker-assigned"),
    references: RunWorkerReferences,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.launch-failed"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.agent-started") }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.agent-succeeded"),
    resultLocation: RunResultLocation,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.agent-failed"),
    reason: TrimmedNonEmptyString,
    resultLocation: RunResultLocation,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.preview-published"),
    url: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.preview-withdrawn") }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.cancellation-requested") }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.cleanup-started") }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.cleanup-succeeded") }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.cleanup-failed"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.retry-requested"),
    deadlines: RunDeadlines,
  }),
]);
export type RunAllocationEvent = typeof RunAllocationEvent.Type;

export const CloudAllocationControllerMode = Schema.Literal("local");
export type CloudAllocationControllerMode = typeof CloudAllocationControllerMode.Type;

export const CloudAllocationControllerStatus = Schema.Struct({
  mode: CloudAllocationControllerMode,
  /** A local controller can outlive clients, but not the machine hosting T3. */
  requiresHostOnline: Schema.Literal(true),
});
export type CloudAllocationControllerStatus = typeof CloudAllocationControllerStatus.Type;

export const CloudAllocationSnapshot = Schema.Struct({
  controller: CloudAllocationControllerStatus,
  allocations: Schema.Array(RunAllocation),
});
export type CloudAllocationSnapshot = typeof CloudAllocationSnapshot.Type;

export class CloudAllocationControllerError extends Schema.TaggedError<CloudAllocationControllerError>()(
  "CloudAllocationControllerError",
  {
    reason: Schema.Literals([
      "controller-disabled",
      "allocation-not-found",
      "queue-full",
      "persistence-failed",
      "invalid-persisted-event",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
