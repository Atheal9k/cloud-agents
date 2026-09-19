/**
 * Bounded warm copies of popular active Builds, plus host count from queue
 * and slot demand. Pool sizing waits on a comparison of warm claim, cold
 * Build restore, and today's EC2 startup.
 */
import {
  DEFAULT_CLOUD_WARM_POOL_BOUNDS,
  MACOS_IOS_WORKER_PROFILE_ID,
  WARM_GUEST_FORBIDDEN_IDENTITY_KEYS,
  type CloudRuntimePlacement,
  type CloudRuntimePlacementFallbackReason,
  type CloudWarmGuest,
  type CloudWarmPoolBounds,
  type CloudWarmPoolCapacityPlan,
  type CloudWarmPoolDecision,
  type CloudWarmPoolInventory,
  type CloudWarmPoolKey,
  type CloudWarmPoolTimings,
  type RunAllocation,
} from "@t3tools/contracts";

export function warmGuestHasForbiddenIdentity(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return WARM_GUEST_FORBIDDEN_IDENTITY_KEYS.some((key) => Object.hasOwn(value, key));
}

export function warmPoolIsWorthKeeping(timings: CloudWarmPoolTimings): boolean {
  return (
    timings.warmClaimMs < timings.coldBuildRestoreMs && timings.warmClaimMs < timings.ec2StartupMs
  );
}

export function warmPoolSupportsProfile(profileId: string): boolean {
  return profileId !== MACOS_IOS_WORKER_PROFILE_ID;
}

export function targetWarmGuests(input: {
  readonly demandQueued: number;
  readonly timings: CloudWarmPoolTimings | undefined;
  readonly bounds?: CloudWarmPoolBounds;
}): number {
  const bounds = input.bounds ?? DEFAULT_CLOUD_WARM_POOL_BOUNDS;
  if (input.timings === undefined || !warmPoolIsWorthKeeping(input.timings)) return 0;
  return Math.min(bounds.maxWarmGuestsPerPool, input.demandQueued);
}

export function desiredHostCount(input: {
  readonly activeSlots: number;
  readonly queued: number;
  readonly warmTarget: number;
  readonly bounds?: CloudWarmPoolBounds;
}): number {
  const bounds = input.bounds ?? DEFAULT_CLOUD_WARM_POOL_BOUNDS;
  const slots =
    Math.max(0, input.activeSlots) + Math.max(0, input.queued) + Math.max(0, input.warmTarget);
  if (slots === 0) return bounds.minHosts;
  const hosts = Math.ceil(slots / bounds.slotsPerHost);
  return Math.min(bounds.maxHosts, Math.max(bounds.minHosts, hosts));
}

export function planWarmPoolCapacity(input: {
  readonly inventories: ReadonlyArray<CloudWarmPoolInventory>;
  readonly timings: CloudWarmPoolTimings | undefined;
  readonly bounds?: CloudWarmPoolBounds;
}): CloudWarmPoolCapacityPlan {
  const bounds = input.bounds ?? DEFAULT_CLOUD_WARM_POOL_BOUNDS;
  const pools: CloudWarmPoolDecision[] = input.inventories.map((inventory) => {
    const target = targetWarmGuests({
      demandQueued: inventory.demand.queued,
      timings: input.timings,
      bounds,
    });
    const available = inventory.warming + inventory.ready;
    const action =
      input.timings === undefined
        ? "hold"
        : available < target
          ? "replenish"
          : available > target
            ? "drain"
            : "hold";
    const reason =
      input.timings === undefined
        ? "Pool size stays at zero until warm claim, cold restore, and EC2 startup are compared."
        : !warmPoolIsWorthKeeping(input.timings)
          ? "Warm claim is not faster than cold Build restore and EC2 startup."
          : action === "replenish"
            ? "Queue demand exceeds ready warm guests for this environment and profile."
            : action === "drain"
              ? "Warm guests above the bounded target are drained; the Build snapshot is kept."
              : "Warm inventory matches the bounded target.";
    return { key: inventory.key, target, action, reason };
  });
  const activeSlots = input.inventories.reduce(
    (sum, inventory) => sum + inventory.demand.activeSlots,
    0,
  );
  const queued = input.inventories.reduce((sum, inventory) => sum + inventory.demand.queued, 0);
  const warmTarget = pools.reduce((sum, pool) => sum + pool.target, 0);
  return {
    ...(input.timings === undefined ? {} : { timings: input.timings }),
    desiredHosts: desiredHostCount({ activeSlots, queued, warmTarget, bounds }),
    pools,
  };
}

function poolKeyId(key: CloudWarmPoolKey): string {
  return `${key.environmentId}:${key.versionId}:${key.profileId}:${key.buildId}`;
}

function countsForStatus(guests: ReadonlyArray<CloudWarmGuest>) {
  return {
    warming: guests.filter((guest) => guest.status === "warming").length,
    ready: guests.filter((guest) => guest.status === "ready").length,
    claimed: guests.filter((guest) => guest.status === "claimed").length,
    draining: guests.filter((guest) => guest.status === "draining").length,
  };
}

function occupiesSlot(allocation: RunAllocation): boolean {
  if (allocation.cleanupState.status === "succeeded") return false;
  switch (allocation.allocationState.status) {
    case "launching":
    case "booting":
    case "registering":
    case "ready":
      return true;
    case "queued":
    case "failed":
      return false;
  }
}

export function warmPoolInventories(input: {
  readonly guests: ReadonlyArray<CloudWarmGuest>;
  readonly allocations: ReadonlyArray<RunAllocation>;
}): ReadonlyArray<CloudWarmPoolInventory> {
  const inventories = new Map<
    string,
    {
      key: CloudWarmPoolKey;
      snapshotId: string;
      guests: CloudWarmGuest[];
      queued: number;
      activeSlots: number;
    }
  >();
  const ensure = (key: CloudWarmPoolKey, snapshotId: string) => {
    const id = poolKeyId(key);
    const existing = inventories.get(id);
    if (existing !== undefined) return existing;
    const created = { key, snapshotId, guests: [] as CloudWarmGuest[], queued: 0, activeSlots: 0 };
    inventories.set(id, created);
    return created;
  };

  for (const guest of input.guests) {
    ensure(
      {
        environmentId: guest.environmentId,
        versionId: guest.versionId,
        profileId: guest.profileId,
        buildId: guest.buildId,
      },
      guest.snapshotId,
    ).guests.push(guest);
  }

  for (const allocation of input.allocations) {
    const environment = allocation.environment;
    const build = allocation.build;
    if (
      !warmPoolSupportsProfile(allocation.profile.id) ||
      environment === undefined ||
      build === undefined
    ) {
      continue;
    }
    const pool = ensure(
      {
        environmentId: environment.environmentId,
        versionId: environment.versionId,
        profileId: allocation.profile.id,
        buildId: build.buildId,
      },
      build.snapshot.id,
    );
    if (
      allocation.allocationState.status === "queued" &&
      allocation.cleanupState.status === "not-requested"
    ) {
      pool.queued += 1;
    }
    if (occupiesSlot(allocation)) pool.activeSlots += 1;
  }

  return [...inventories.values()].map((pool) => ({
    key: pool.key,
    snapshotId: pool.snapshotId,
    demand: { queued: pool.queued, activeSlots: pool.activeSlots },
    ...countsForStatus(pool.guests),
  }));
}

export function placementForClaim(input: {
  readonly claimed: CloudWarmGuest | undefined;
  readonly buildId: CloudWarmGuest["buildId"] | undefined;
  readonly claimLatencyMs: number;
  readonly fallbackReason: CloudRuntimePlacementFallbackReason;
}): CloudRuntimePlacement {
  if (input.claimed !== undefined) {
    return {
      warmFork: "warm",
      buildId: input.claimed.buildId,
      claimLatencyMs: input.claimLatencyMs,
      bootTimeMs: input.claimed.bootTimeMs,
    };
  }
  return {
    warmFork: "cold",
    ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
    claimLatencyMs: input.claimLatencyMs,
    bootTimeMs: 0,
    fallbackReason: input.fallbackReason,
  };
}
