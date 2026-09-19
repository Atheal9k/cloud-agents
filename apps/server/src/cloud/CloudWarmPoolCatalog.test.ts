import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentSaveInput,
  CloudEnvironmentVersionId,
  CloudWarmGuestId,
  RunAllocationId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make as makeBuilds } from "./CloudEnvironmentBuildCatalog.ts";
import { make as makeEnvironments } from "./CloudEnvironmentCatalog.ts";
import { make as makeWarmPool } from "./CloudWarmPoolCatalog.ts";

const decodeSave = Schema.decodeSync(CloudEnvironmentSaveInput);
const occurredAt = "2026-09-19T08:00:00.000Z";
const key = {
  environmentId: CloudEnvironmentId.make("environment-web"),
  versionId: CloudEnvironmentVersionId.make("version-1"),
  profileId: "linux-web",
  buildId: CloudEnvironmentBuildId.make("build-1"),
};

const startGuest = (id: string) => ({
  id: CloudWarmGuestId.make(id),
  key,
  snapshotId: "snap-1",
  startedAt: occurredAt,
});

it.effect("claims one ready guest exactly once under concurrent callers", () =>
  Effect.gen(function* () {
    const first = yield* makeWarmPool();
    const second = yield* makeWarmPool();
    yield* first.start(startGuest("guest-1"));
    yield* first.markReady({
      guestId: CloudWarmGuestId.make("guest-1"),
      bootTimeMs: 80,
      occurredAt,
    });

    const [left, right] = yield* Effect.all(
      [
        first.claim({
          key,
          allocationId: RunAllocationId.make("allocation-a"),
          occurredAt,
        }),
        second.claim({
          key,
          allocationId: RunAllocationId.make("allocation-b"),
          occurredAt,
        }),
      ],
      { concurrency: "unbounded" },
    );

    const claimed = [left, right].filter((guest) => guest !== undefined);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe("guest-1");
    expect((yield* first.read(CloudWarmGuestId.make("guest-1")))?.status).toBe("claimed");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("drains obsolete versions without mutating a claimed guest", () =>
  Effect.gen(function* () {
    const pool = yield* makeWarmPool();
    const obsolete = { ...key, versionId: CloudEnvironmentVersionId.make("version-old") };
    yield* pool.start({ ...startGuest("guest-claimed"), key: obsolete });
    yield* pool.markReady({
      guestId: CloudWarmGuestId.make("guest-claimed"),
      bootTimeMs: 80,
      occurredAt,
    });
    yield* pool.claim({
      key: obsolete,
      allocationId: RunAllocationId.make("allocation-live"),
      occurredAt,
    });
    yield* pool.start(startGuest("guest-current"));
    yield* pool.markReady({
      guestId: CloudWarmGuestId.make("guest-current"),
      bootTimeMs: 80,
      occurredAt,
    });
    yield* pool.start({ ...startGuest("guest-obsolete"), key: obsolete });
    yield* pool.markReady({
      guestId: CloudWarmGuestId.make("guest-obsolete"),
      bootTimeMs: 80,
      occurredAt,
    });

    const drained = yield* pool.drainObsolete({
      environmentId: key.environmentId,
      profileId: key.profileId,
      versionId: key.versionId,
      buildId: key.buildId,
      occurredAt: "2026-09-19T08:01:00.000Z",
    });

    expect(drained).toBe(1);
    expect((yield* pool.read(CloudWarmGuestId.make("guest-obsolete")))?.status).toBe("draining");
    const claimed = yield* pool.read(CloudWarmGuestId.make("guest-claimed"));
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.claimedByAllocationId).toBe("allocation-live");
    expect((yield* pool.read(CloudWarmGuestId.make("guest-current")))?.status).toBe("ready");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("scale-to-zero evicts idle guests and leaves the active Build snapshot", () =>
  Effect.gen(function* () {
    const environments = yield* makeEnvironments();
    const builds = yield* makeBuilds();
    const pool = yield* makeWarmPool();
    const environment = yield* environments.save(
      decodeSave({
        environmentId: "environment-web",
        name: "Web",
        source: { type: "saved", scope: "personal", owner: "victor" },
        repositories: [{ repository: "acme/web", defaultRef: "main" }],
        config: { image: "node:24" },
        secretReferences: [],
        occurredAt,
      }),
    );
    yield* builds.start({
      buildId: key.buildId,
      version: environment.current,
      trigger: "manual",
      draft: false,
      base: { kind: "image", image: "node:24" },
      inputsFingerprint: "a".repeat(64),
      startedAt: occurredAt,
    });
    yield* builds.complete({
      buildId: key.buildId,
      gitSetup: [{ repository: "acme/web", defaultRef: "main", commit: "c".repeat(40) }],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: {
          id: "snap-1",
          digest: "d".repeat(64),
          sizeBytes: 1024,
          createdAt: occurredAt,
        },
        completedAt: occurredAt,
      },
    });
    yield* pool.start(startGuest("guest-idle"));
    yield* pool.markReady({
      guestId: CloudWarmGuestId.make("guest-idle"),
      bootTimeMs: 80,
      occurredAt,
    });
    yield* pool.evictIdle({ key, keepReady: 0, occurredAt: "2026-09-19T08:02:00.000Z" });

    expect((yield* pool.read(CloudWarmGuestId.make("guest-idle")))?.status).toBe("evicted");
    expect((yield* builds.activeBuild(environment.id))?.id).toBe("build-1");
    expect((yield* environments.list)[0]?.activeBuildId).toBe("build-1");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
