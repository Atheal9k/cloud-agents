import * as Schema from "effect/Schema";

import {
  CloudAgentId,
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudRunId,
  IsoDateTime,
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
  observedAt: IsoDateTime,
});
export type CloudManagedRuntime = typeof CloudManagedRuntime.Type;
