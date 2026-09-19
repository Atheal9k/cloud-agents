/**
 * Inventory of pre-booted Build copies. Claims are a conditional write so two
 * allocations cannot take the same guest. Eviction never deletes a Build
 * snapshot; obsolete environment versions drain without touching claimed work.
 */
import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentVersionId,
  CloudWarmGuest,
  CloudWarmGuestId,
  CloudWarmPoolError,
  type CloudWarmPoolKey,
  type CloudWarmPoolTimings,
  RunAllocationId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { warmGuestHasForbiddenIdentity } from "./cloudWarmPoolPolicy.ts";

const EmptyRequest = Schema.Struct({});
const GuestRow = Schema.Struct({ value: Schema.fromJsonString(CloudWarmGuest) });
const ChangedRow = Schema.Struct({ changed: Schema.Int });
const TimingKind = Schema.Literals(["cold-build-restore", "warm-claim", "ec2-startup"]);
const TimingRow = Schema.Struct({
  kind: TimingKind,
  durationMs: Schema.Int,
});
const encodeGuest = Schema.encodeSync(Schema.fromJsonString(CloudWarmGuest));
const decodeGuestId = Schema.decodeUnknownEffect(CloudWarmGuestId);

export interface CloudWarmGuestStart {
  readonly id: CloudWarmGuestId;
  readonly key: CloudWarmPoolKey;
  readonly snapshotId: string;
  readonly startedAt: string;
}

export class CloudWarmPoolCatalog extends Context.Service<
  CloudWarmPoolCatalog,
  {
    readonly list: Effect.Effect<ReadonlyArray<CloudWarmGuest>, CloudWarmPoolError>;
    readonly read: (
      guestId: CloudWarmGuestId,
    ) => Effect.Effect<CloudWarmGuest | undefined, CloudWarmPoolError>;
    readonly start: (
      input: CloudWarmGuestStart,
    ) => Effect.Effect<CloudWarmGuest, CloudWarmPoolError>;
    readonly markReady: (input: {
      readonly guestId: CloudWarmGuestId;
      readonly bootTimeMs: number;
      readonly occurredAt: string;
    }) => Effect.Effect<CloudWarmGuest, CloudWarmPoolError>;
    readonly claim: (input: {
      readonly key: CloudWarmPoolKey;
      readonly allocationId: RunAllocationId;
      readonly occurredAt: string;
    }) => Effect.Effect<CloudWarmGuest | undefined, CloudWarmPoolError>;
    readonly drainObsolete: (input: {
      readonly environmentId: CloudEnvironmentId;
      readonly profileId: string;
      readonly versionId: CloudEnvironmentVersionId;
      readonly buildId: CloudEnvironmentBuildId;
      readonly occurredAt: string;
    }) => Effect.Effect<number, CloudWarmPoolError>;
    readonly evictIdle: (input: {
      readonly key: CloudWarmPoolKey;
      readonly keepReady: number;
      readonly occurredAt: string;
    }) => Effect.Effect<number, CloudWarmPoolError>;
    readonly releaseClaim: (input: {
      readonly allocationId: RunAllocationId;
      readonly occurredAt: string;
    }) => Effect.Effect<number, CloudWarmPoolError>;
    readonly recordTiming: (input: {
      readonly kind: typeof TimingKind.Type;
      readonly durationMs: number;
      readonly occurredAt: string;
    }) => Effect.Effect<void, CloudWarmPoolError>;
    readonly timings: Effect.Effect<CloudWarmPoolTimings | undefined, CloudWarmPoolError>;
  }
>()("t3/cloud/CloudWarmPoolCatalog") {}

function poolError(reason: CloudWarmPoolError["reason"], message: string): CloudWarmPoolError {
  return new CloudWarmPoolError({ reason, message });
}

function persistenceError(): CloudWarmPoolError {
  return poolError("persistence-failed", "The cloud warm-pool catalog is unavailable.");
}

function isPoolError(cause: unknown): cause is CloudWarmPoolError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "CloudWarmPoolError"
  );
}

export const make = Effect.fn("CloudWarmPoolCatalog.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);

  const readAll = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: GuestRow,
    execute: () => sql`
      SELECT guest_json AS value
      FROM cloud_warm_guests
      ORDER BY created_at ASC, guest_id ASC
    `,
  });

  const readOne = SqlSchema.findAll({
    Request: Schema.Struct({ guestId: CloudWarmGuestId }),
    Result: GuestRow,
    execute: ({ guestId }) => sql`
      SELECT guest_json AS value
      FROM cloud_warm_guests
      WHERE guest_id = ${guestId}
    `,
  });

  const readChanged = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: ChangedRow,
    execute: () => sql`SELECT changes() AS changed`,
  });

  const readTimings = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: TimingRow,
    execute: () => sql`
      SELECT kind, duration_ms AS "durationMs"
      FROM cloud_warm_pool_timings
    `,
  });

  const persistGuest = Effect.fn("CloudWarmPoolCatalog.persistGuest")(function* (
    guest: CloudWarmGuest,
  ) {
    if (warmGuestHasForbiddenIdentity(guest)) {
      return yield* poolError(
        "invalid-guest",
        "A warm guest cannot carry secrets, a provider session, a branch, or an agent identity.",
      );
    }
    yield* sql`
      INSERT INTO cloud_warm_guests (
        guest_id,
        environment_id,
        version_id,
        profile_id,
        build_id,
        snapshot_id,
        status,
        claimed_by_allocation_id,
        guest_json,
        created_at,
        updated_at
      ) VALUES (
        ${guest.id},
        ${guest.environmentId},
        ${guest.versionId},
        ${guest.profileId},
        ${guest.buildId},
        ${guest.snapshotId},
        ${guest.status},
        ${guest.claimedByAllocationId ?? null},
        ${encodeGuest(guest)},
        ${guest.createdAt},
        ${guest.updatedAt}
      )
      ON CONFLICT(guest_id) DO UPDATE SET
        status = excluded.status,
        claimed_by_allocation_id = excluded.claimed_by_allocation_id,
        guest_json = excluded.guest_json,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(persistenceError));
  });

  const readGuest = Effect.fn("CloudWarmPoolCatalog.readGuest")(function* (
    guestId: CloudWarmGuestId,
  ) {
    const rows = yield* readOne({ guestId }).pipe(Effect.mapError(persistenceError));
    return rows[0]?.value;
  });

  const list = mutex.withPermits(1)(
    readAll({}).pipe(
      Effect.map((rows) => rows.map((row) => row.value)),
      Effect.mapError(persistenceError),
    ),
  );

  const read: CloudWarmPoolCatalog["Service"]["read"] = (guestId) =>
    mutex.withPermits(1)(readGuest(guestId));

  const start: CloudWarmPoolCatalog["Service"]["start"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* readGuest(input.id);
        if (existing !== undefined) return existing;
        const guest: CloudWarmGuest = {
          id: input.id,
          environmentId: input.key.environmentId,
          versionId: input.key.versionId,
          profileId: input.key.profileId,
          buildId: input.key.buildId,
          snapshotId: input.snapshotId,
          status: "warming",
          bootTimeMs: 0,
          createdAt: input.startedAt,
          updatedAt: input.startedAt,
        };
        yield* persistGuest(guest);
        return guest;
      }),
    );

  const markReady: CloudWarmPoolCatalog["Service"]["markReady"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* readGuest(input.guestId);
        if (existing === undefined) {
          return yield* poolError("invalid-guest", `Warm guest '${input.guestId}' does not exist.`);
        }
        if (existing.status === "ready") return existing;
        if (existing.status !== "warming") {
          return yield* poolError(
            "invalid-guest",
            `Warm guest '${input.guestId}' is '${existing.status}' and cannot become ready.`,
          );
        }
        const guest: CloudWarmGuest = {
          ...existing,
          status: "ready",
          bootTimeMs: input.bootTimeMs,
          updatedAt: input.occurredAt,
        };
        yield* persistGuest(guest);
        return guest;
      }),
    );

  const claim: CloudWarmPoolCatalog["Service"]["claim"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const selected = yield* sql<{ readonly guest_id: string }>`
          SELECT guest_id
          FROM cloud_warm_guests
          WHERE environment_id = ${input.key.environmentId}
            AND version_id = ${input.key.versionId}
            AND profile_id = ${input.key.profileId}
            AND build_id = ${input.key.buildId}
            AND status = 'ready'
          ORDER BY created_at ASC, guest_id ASC
          LIMIT 1
        `.pipe(Effect.mapError(persistenceError));
        const guestId = selected[0]?.guest_id;
        if (guestId === undefined) return undefined;
        const decodedId = yield* decodeGuestId(guestId).pipe(Effect.mapError(persistenceError));
        const existing = yield* readGuest(decodedId);
        if (existing === undefined || existing.status !== "ready") return undefined;
        yield* sql`
          UPDATE cloud_warm_guests
          SET status = 'claimed',
              claimed_by_allocation_id = ${input.allocationId},
              updated_at = ${input.occurredAt}
          WHERE guest_id = ${decodedId} AND status = 'ready'
        `.pipe(Effect.mapError(persistenceError));
        const changed = yield* readChanged({}).pipe(Effect.mapError(persistenceError));
        if ((changed[0]?.changed ?? 0) === 0) return undefined;
        const guest: CloudWarmGuest = {
          ...existing,
          status: "claimed",
          claimedByAllocationId: input.allocationId,
          claimedAt: input.occurredAt,
          updatedAt: input.occurredAt,
        };
        yield* persistGuest(guest);
        return guest;
      }).pipe(
        Effect.catch((cause) => Effect.fail(isPoolError(cause) ? cause : persistenceError())),
      ),
    );

  const drainObsolete: CloudWarmPoolCatalog["Service"]["drainObsolete"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* sql`
          UPDATE cloud_warm_guests
          SET status = 'draining',
              updated_at = ${input.occurredAt},
              guest_json = json_set(
                json_set(guest_json, '$.status', 'draining'),
                '$.updatedAt', ${input.occurredAt}
              )
          WHERE environment_id = ${input.environmentId}
            AND profile_id = ${input.profileId}
            AND status IN ('warming', 'ready')
            AND (version_id != ${input.versionId} OR build_id != ${input.buildId})
        `.pipe(Effect.mapError(persistenceError));
        const changed = yield* readChanged({}).pipe(Effect.mapError(persistenceError));
        return changed[0]?.changed ?? 0;
      }),
    );

  const evictIdle: CloudWarmPoolCatalog["Service"]["evictIdle"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const ready = yield* sql<{ readonly guest_id: string }>`
          SELECT guest_id
          FROM cloud_warm_guests
          WHERE environment_id = ${input.key.environmentId}
            AND version_id = ${input.key.versionId}
            AND profile_id = ${input.key.profileId}
            AND build_id = ${input.key.buildId}
            AND status IN ('warming', 'ready', 'draining')
          ORDER BY
            CASE status WHEN 'draining' THEN 0 WHEN 'warming' THEN 1 ELSE 2 END,
            created_at ASC,
            guest_id ASC
        `.pipe(Effect.mapError(persistenceError));
        const keepReady = Math.max(0, input.keepReady);
        const keep = new Set(
          ready.filter((_, index) => index >= ready.length - keepReady).map((row) => row.guest_id),
        );
        const evict = keepReady === 0 ? ready : ready.filter((row) => !keep.has(row.guest_id));
        if (evict.length === 0) return 0;
        yield* Effect.forEach(
          evict,
          (row) => sql`
            UPDATE cloud_warm_guests
            SET status = 'evicted',
                updated_at = ${input.occurredAt},
                guest_json = json_set(
                  json_set(guest_json, '$.status', 'evicted'),
                  '$.updatedAt', ${input.occurredAt}
                )
            WHERE guest_id = ${row.guest_id}
              AND status IN ('warming', 'ready', 'draining')
          `,
          { discard: true },
        ).pipe(Effect.mapError(persistenceError));
        return evict.length;
      }),
    );

  const releaseClaim: CloudWarmPoolCatalog["Service"]["releaseClaim"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* sql`
          UPDATE cloud_warm_guests
          SET status = 'evicted',
              updated_at = ${input.occurredAt},
              guest_json = json_set(
                json_set(guest_json, '$.status', 'evicted'),
                '$.updatedAt', ${input.occurredAt}
              )
          WHERE claimed_by_allocation_id = ${input.allocationId}
            AND status = 'claimed'
        `.pipe(Effect.mapError(persistenceError));
        const changed = yield* readChanged({}).pipe(Effect.mapError(persistenceError));
        return changed[0]?.changed ?? 0;
      }),
    );

  const recordTiming: CloudWarmPoolCatalog["Service"]["recordTiming"] = (input) =>
    mutex.withPermits(1)(
      sql`
        INSERT INTO cloud_warm_pool_timings (kind, duration_ms, recorded_at)
        VALUES (${input.kind}, ${input.durationMs}, ${input.occurredAt})
        ON CONFLICT(kind) DO UPDATE SET
          duration_ms = excluded.duration_ms,
          recorded_at = excluded.recorded_at
      `.pipe(Effect.asVoid, Effect.mapError(persistenceError)),
    );

  const timings = mutex.withPermits(1)(
    Effect.gen(function* () {
      const rows = yield* readTimings({}).pipe(Effect.mapError(persistenceError));
      const byKind = new Map(rows.map((row) => [row.kind, row.durationMs]));
      const coldBuildRestoreMs = byKind.get("cold-build-restore");
      const warmClaimMs = byKind.get("warm-claim");
      const ec2StartupMs = byKind.get("ec2-startup");
      if (
        coldBuildRestoreMs === undefined ||
        warmClaimMs === undefined ||
        ec2StartupMs === undefined
      ) {
        return undefined;
      }
      return { coldBuildRestoreMs, warmClaimMs, ec2StartupMs };
    }),
  );

  return CloudWarmPoolCatalog.of({
    list,
    read,
    start,
    markReady,
    claim,
    drainObsolete,
    evictIdle,
    releaseClaim,
    recordTiming,
    timings,
  });
});

export const layer = Layer.effect(CloudWarmPoolCatalog, make());
