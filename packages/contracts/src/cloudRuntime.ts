import * as Schema from "effect/Schema";

import {
  CloudAgentId,
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudRunId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RunAllocationAttempt,
  RunAllocationId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const CloudManagedRuntimeProvider = Schema.Literal("daytona");
export type CloudManagedRuntimeProvider = typeof CloudManagedRuntimeProvider.Type;

export const CloudManagedRuntimeLifecycle = Schema.Literals([
  "creating",
  "starting",
  "started",
  "stopping",
  "stopped",
  "archiving",
  "archived",
  "deleting",
  "deleted",
  "error",
  "unknown",
]);
export type CloudManagedRuntimeLifecycle = typeof CloudManagedRuntimeLifecycle.Type;

export const CloudManagedRuntimeIdlePolicy = Schema.Union([
  Schema.Struct({ action: Schema.Literal("stop"), afterMinutes: PositiveInt }),
  Schema.Struct({ action: Schema.Literal("pause"), afterMinutes: PositiveInt }),
]);
export type CloudManagedRuntimeIdlePolicy = typeof CloudManagedRuntimeIdlePolicy.Type;

/** Provider failsafes for a managed environment. Controller timers remain
 * separate because Daytona activity, agent idle, viewer idle, and retention
 * do not mean the same thing. */
export const CloudManagedRuntimePolicy = Schema.Struct({
  idle: CloudManagedRuntimeIdlePolicy,
  archiveAfterMinutes: NonNegativeInt,
  deleteAfterMinutes: NonNegativeInt,
  maxTtlMinutes: PositiveInt,
});
export type CloudManagedRuntimePolicy = typeof CloudManagedRuntimePolicy.Type;

export const DEFAULT_CLOUD_MANAGED_RUNTIME_POLICY = {
  idle: { action: "stop", afterMinutes: 15 },
  archiveAfterMinutes: 24 * 60,
  deleteAfterMinutes: 90 * 24 * 60,
  maxTtlMinutes: 90 * 24 * 60,
} as const satisfies CloudManagedRuntimePolicy;

/**
 * Provider observations persisted with allocation events. The ownership fields
 * let the controller recover a lost create response without treating a
 * generated ID or a requested state as proof that a sandbox is ready.
 */
export const CloudManagedRuntime = Schema.Struct({
  provider: CloudManagedRuntimeProvider,
  runtimeId: TrimmedNonEmptyString,
  region: TrimmedNonEmptyString,
  resourceClass: TrimmedNonEmptyString,
  lifecycleState: CloudManagedRuntimeLifecycle,
  environmentId: Schema.optionalKey(CloudEnvironmentId),
  buildId: Schema.optionalKey(CloudEnvironmentBuildId),
  agentId: CloudAgentId,
  runId: CloudRunId,
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  policy: Schema.optionalKey(CloudManagedRuntimePolicy),
  createdAt: Schema.optionalKey(IsoDateTime),
  lastActivityAt: Schema.optionalKey(IsoDateTime),
  autoDestroyAt: Schema.optionalKey(IsoDateTime),
  observedAt: IsoDateTime,
});
export type CloudManagedRuntime = typeof CloudManagedRuntime.Type;

export const CloudRuntimeCleanupQueueItem = Schema.Struct({
  runtime: CloudManagedRuntime,
  status: Schema.Literals(["pending", "retrying"]),
  attempts: NonNegativeInt,
  firstSeenAt: IsoDateTime,
  updatedAt: IsoDateTime,
  nextRetryAt: IsoDateTime,
  lastError: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudRuntimeCleanupQueueItem = typeof CloudRuntimeCleanupQueueItem.Type;
