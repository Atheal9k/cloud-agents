import {
  CloudMacHost,
  CloudMacHostId,
  macDedicatedHostEarliestReleaseAt,
  type RunAllocationAttempt,
  type RunAllocationId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const EmptyRequest = Schema.Struct({});
const HostRow = Schema.Struct({
  hostId: CloudMacHostId,
  value: Schema.fromJsonString(CloudMacHost),
});
const encodeHost = Schema.encodeSync(Schema.fromJsonString(CloudMacHost));

export class CloudMacHostCatalogError extends Schema.TaggedError<CloudMacHostCatalogError>()(
  "CloudMacHostCatalogError",
  {
    reason: Schema.Literals(["persistence-failed"]),
    message: Schema.String,
  },
) {}

export class CloudMacHostCatalog extends Context.Service<
  CloudMacHostCatalog,
  {
    readonly list: Effect.Effect<ReadonlyArray<CloudMacHost>, CloudMacHostCatalogError>;
    readonly save: (host: CloudMacHost) => Effect.Effect<CloudMacHost, CloudMacHostCatalogError>;
  }
>()("t3/cloud/CloudMacHostCatalog") {}

function persistenceError(): CloudMacHostCatalogError {
  return new CloudMacHostCatalogError({
    reason: "persistence-failed",
    message: "The Mac Dedicated Host catalog is unavailable.",
  });
}

export function occupyMacHost(input: {
  readonly host: CloudMacHost;
  readonly allocationId: RunAllocationId;
  readonly attempt: RunAllocationAttempt;
  readonly instanceId?: string | undefined;
  readonly occurredAt: string;
}): CloudMacHost {
  return {
    ...input.host,
    availability: "occupied",
    occupiedBy: { allocationId: input.allocationId, attempt: input.attempt },
    ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    updatedAt: input.occurredAt,
  };
}

export function finishMacHostJob(input: {
  readonly host: CloudMacHost;
  readonly occurredAt: string;
}): CloudMacHost {
  const { occupiedBy: _occupiedBy, ...rest } = input.host;
  return {
    ...rest,
    availability: input.host.releaseRequestedAt === undefined ? "scrubbing" : "release-requested",
    updatedAt: input.occurredAt,
  };
}

export function markMacHostAvailable(input: {
  readonly host: CloudMacHost;
  readonly occurredAt: string;
}): CloudMacHost {
  return {
    ...input.host,
    availability: input.host.releaseRequestedAt === undefined ? "available" : "release-requested",
    updatedAt: input.occurredAt,
  };
}

export function requestMacHostRelease(input: {
  readonly host: CloudMacHost;
  readonly occurredAt: string;
}): CloudMacHost {
  return {
    ...input.host,
    availability: input.host.occupiedBy === undefined ? "release-requested" : "occupied",
    releaseRequestedAt: input.occurredAt,
    updatedAt: input.occurredAt,
  };
}

export function recordAllocatedMacHost(input: {
  readonly id: CloudMacHostId;
  readonly awsHostId: string;
  readonly region: string;
  readonly availabilityZone: string;
  readonly instanceType: string;
  readonly macos: string;
  readonly xcode: string;
  readonly simulatorRuntime: string;
  readonly allocatedAt: string;
}): CloudMacHost {
  return {
    id: input.id,
    awsHostId: input.awsHostId,
    region: input.region,
    availabilityZone: input.availabilityZone,
    instanceType: input.instanceType,
    macos: input.macos,
    xcode: input.xcode,
    simulatorRuntime: input.simulatorRuntime,
    allocatedAt: input.allocatedAt,
    earliestReleaseAt: macDedicatedHostEarliestReleaseAt(input.allocatedAt),
    availability: "available",
    updatedAt: input.allocatedAt,
  };
}

export const make = Effect.fn("CloudMacHostCatalog.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);

  const readAll = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: HostRow,
    execute: () => sql`
      SELECT host_id AS "hostId", host_json AS value
      FROM cloud_mac_hosts
      ORDER BY updated_at DESC, host_id ASC
    `,
  });

  const listUnlocked = Effect.fn("CloudMacHostCatalog.listUnlocked")(function* () {
    const rows = yield* readAll({}).pipe(Effect.mapError(persistenceError));
    return rows.map((row) => row.value);
  });

  const saveUnlocked = Effect.fn("CloudMacHostCatalog.saveUnlocked")(function* (
    host: CloudMacHost,
  ) {
    yield* sql`
      INSERT INTO cloud_mac_hosts (host_id, host_json, updated_at)
      VALUES (${host.id}, ${encodeHost(host)}, ${host.updatedAt})
      ON CONFLICT(host_id) DO UPDATE SET
        host_json = excluded.host_json,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(persistenceError));
    return host;
  });

  return CloudMacHostCatalog.of({
    list: mutex.withPermits(1)(listUnlocked()),
    save: (host) => mutex.withPermits(1)(saveUnlocked(host)),
  });
});

export const layer = Layer.effect(CloudMacHostCatalog, make());
