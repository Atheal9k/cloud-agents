import { CloudMacHostId, RunAllocationAttempt, RunAllocationId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  finishMacHostJob,
  make,
  occupyMacHost,
  recordAllocatedMacHost,
  requestMacHostRelease,
} from "./CloudMacHostCatalog.ts";

const decodeHostId = Schema.decodeSync(CloudMacHostId);
const decodeAllocationId = Schema.decodeSync(RunAllocationId);
const decodeAttempt = Schema.decodeSync(RunAllocationAttempt);

it.effect("persists Dedicated Host occupancy separately from job cleanup", () =>
  Effect.gen(function* () {
    const catalog = yield* make();
    const allocated = recordAllocatedMacHost({
      id: decodeHostId("host-1"),
      awsHostId: "h-mac",
      region: "us-west-2",
      availabilityZone: "us-west-2a",
      instanceType: "mac2-m2.metal",
      macos: "15.6",
      xcode: "16.4",
      simulatorRuntime: "iOS 18.5",
      allocatedAt: "2026-09-19T00:00:00.000Z",
    });
    yield* catalog.save(allocated);
    const occupied = occupyMacHost({
      host: allocated,
      allocationId: decodeAllocationId("allocation-1"),
      attempt: decodeAttempt(1),
      instanceId: "i-mac",
      occurredAt: "2026-09-19T00:05:00.000Z",
    });
    yield* catalog.save(occupied);
    const afterJob = finishMacHostJob({
      host: occupied,
      occurredAt: "2026-09-19T02:00:00.000Z",
    });
    yield* catalog.save(afterJob);
    const releaseRequested = requestMacHostRelease({
      host: afterJob,
      occurredAt: "2026-09-19T02:01:00.000Z",
    });
    yield* catalog.save(releaseRequested);

    const hosts = yield* catalog.list;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.earliestReleaseAt).toBe("2026-09-20T00:00:00.000Z");
    expect(hosts[0]?.occupiedBy).toBeUndefined();
    expect(hosts[0]?.availability).toBe("release-requested");
    expect(hosts[0]?.releasedAt).toBeUndefined();
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
