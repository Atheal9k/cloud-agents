import * as Schema from "effect/Schema";

import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentVersionId,
  CloudWarmGuestId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RunAllocationId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const CloudWarmFork = Schema.Literals(["warm", "cold"]);
export type CloudWarmFork = typeof CloudWarmFork.Type;

export const CloudRuntimePlacementFallbackReason = Schema.Literals([
  "no-warm-guest",
  "no-fresh-build",
  "dedicated-host",
  "obsolete-version",
  "warm-claim-raced",
  "ec2-startup",
]);
export type CloudRuntimePlacementFallbackReason = typeof CloudRuntimePlacementFallbackReason.Type;

/** Recorded onto an allocation when a runtime is placed. */
export const CloudRuntimePlacement = Schema.Struct({
  warmFork: CloudWarmFork,
  buildId: Schema.optionalKey(CloudEnvironmentBuildId),
  claimLatencyMs: NonNegativeInt,
  bootTimeMs: NonNegativeInt,
  fallbackReason: Schema.optionalKey(CloudRuntimePlacementFallbackReason),
});
export type CloudRuntimePlacement = typeof CloudRuntimePlacement.Type;

export const CloudWarmGuestStatus = Schema.Literals([
  "warming",
  "ready",
  "claimed",
  "draining",
  "evicted",
]);
export type CloudWarmGuestStatus = typeof CloudWarmGuestStatus.Type;

/**
 * A pre-booted copy of an active Build. The schema is the identity: it cannot
 * carry user secrets, a provider session, a branch, or an agent id.
 */
export const CloudWarmGuest = Schema.Struct({
  id: CloudWarmGuestId,
  environmentId: CloudEnvironmentId,
  versionId: CloudEnvironmentVersionId,
  profileId: TrimmedNonEmptyString,
  buildId: CloudEnvironmentBuildId,
  snapshotId: TrimmedNonEmptyString,
  status: CloudWarmGuestStatus,
  bootTimeMs: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  claimedByAllocationId: Schema.optionalKey(RunAllocationId),
  claimedAt: Schema.optionalKey(IsoDateTime),
});
export type CloudWarmGuest = typeof CloudWarmGuest.Type;

export const WARM_GUEST_FORBIDDEN_IDENTITY_KEYS = [
  "secrets",
  "providerSession",
  "branch",
  "agentId",
  "agent",
] as const;

export const CloudWarmPoolKey = Schema.Struct({
  environmentId: CloudEnvironmentId,
  versionId: CloudEnvironmentVersionId,
  profileId: TrimmedNonEmptyString,
  buildId: CloudEnvironmentBuildId,
});
export type CloudWarmPoolKey = typeof CloudWarmPoolKey.Type;

export const CloudWarmPoolDemand = Schema.Struct({
  queued: NonNegativeInt,
  activeSlots: NonNegativeInt,
});
export type CloudWarmPoolDemand = typeof CloudWarmPoolDemand.Type;

export const CloudWarmPoolTimings = Schema.Struct({
  coldBuildRestoreMs: NonNegativeInt,
  warmClaimMs: NonNegativeInt,
  ec2StartupMs: NonNegativeInt,
  daytonaColdCreateMs: Schema.optionalKey(NonNegativeInt),
  daytonaStopStartMs: Schema.optionalKey(NonNegativeInt),
  daytonaArchiveStartMs: Schema.optionalKey(NonNegativeInt),
  daytonaBuildRestoreMs: Schema.optionalKey(NonNegativeInt),
});
export type CloudWarmPoolTimings = typeof CloudWarmPoolTimings.Type;

export const CloudWarmPoolBounds = Schema.Struct({
  maxWarmGuestsPerPool: NonNegativeInt,
  slotsPerHost: PositiveInt,
  minHosts: NonNegativeInt,
  maxHosts: NonNegativeInt,
});
export type CloudWarmPoolBounds = typeof CloudWarmPoolBounds.Type;

export const DEFAULT_CLOUD_WARM_POOL_BOUNDS = {
  maxWarmGuestsPerPool: 2,
  slotsPerHost: 4,
  minHosts: 0,
  maxHosts: 8,
} as const satisfies CloudWarmPoolBounds;

export const CloudWarmPoolInventory = Schema.Struct({
  key: CloudWarmPoolKey,
  snapshotId: TrimmedNonEmptyString,
  demand: CloudWarmPoolDemand,
  warming: NonNegativeInt,
  ready: NonNegativeInt,
  claimed: NonNegativeInt,
  draining: NonNegativeInt,
});
export type CloudWarmPoolInventory = typeof CloudWarmPoolInventory.Type;

export const CloudWarmPoolAction = Schema.Literals(["replenish", "drain", "hold"]);
export type CloudWarmPoolAction = typeof CloudWarmPoolAction.Type;

export const CloudWarmPoolDecision = Schema.Struct({
  key: CloudWarmPoolKey,
  target: NonNegativeInt,
  action: CloudWarmPoolAction,
  reason: TrimmedNonEmptyString,
});
export type CloudWarmPoolDecision = typeof CloudWarmPoolDecision.Type;

export const CloudWarmPoolCapacityPlan = Schema.Struct({
  timings: Schema.optionalKey(CloudWarmPoolTimings),
  desiredHosts: NonNegativeInt,
  pools: Schema.Array(CloudWarmPoolDecision),
});
export type CloudWarmPoolCapacityPlan = typeof CloudWarmPoolCapacityPlan.Type;

export class CloudWarmPoolError extends Schema.TaggedError<CloudWarmPoolError>()(
  "CloudWarmPoolError",
  {
    reason: Schema.Literals(["invalid-guest", "persistence-failed"]),
    message: TrimmedNonEmptyString,
  },
) {}
