import {
  CloudEnvironmentBuildId,
  CloudEnvironmentSaveInput,
  type CloudEnvironmentBuildSnapshot,
  type CloudEnvironmentVersion,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make as makeBuilds } from "./CloudEnvironmentBuildCatalog.ts";
import { make as makeEnvironments } from "./CloudEnvironmentCatalog.ts";

const decodeSave = Schema.decodeSync(CloudEnvironmentSaveInput);

const saveInput = decodeSave({
  environmentId: "environment-web",
  name: "Personal web",
  source: { type: "saved", scope: "personal", owner: "victor" },
  repositories: [{ repository: "acme/web", defaultRef: "main" }],
  config: { image: "node:24-bookworm", install: "pnpm install" },
  secretReferences: [{ name: "NPM_TOKEN", reference: "secret/npm", availability: "build" }],
  occurredAt: "2026-09-19T02:00:00.000Z",
});

function snapshot(id: string): CloudEnvironmentBuildSnapshot {
  return {
    id,
    digest: "a".repeat(64),
    sizeBytes: 4096,
    createdAt: "2026-09-19T02:05:00.000Z",
  };
}

const start = (version: CloudEnvironmentVersion, id: string, draft = false) => ({
  buildId: CloudEnvironmentBuildId.make(id),
  version,
  trigger: "manual" as const,
  draft,
  base: { kind: "image" as const, image: "node:24-bookworm" },
  inputsFingerprint: "b".repeat(64),
  startedAt: "2026-09-19T02:04:00.000Z",
});

/** Environments own the active pointer, so every test needs a real one. */
const setup = Effect.fn("setup")(function* () {
  const environments = yield* makeEnvironments();
  const builds = yield* makeBuilds();
  const environment = yield* environments.save(saveInput);
  return { environments, builds, version: environment.current };
});

it.effect("activates a saved successful Build and leaves the tree addressable", () =>
  Effect.gen(function* () {
    const { environments, builds, version } = yield* setup();
    yield* builds.start(start(version, "build-1"));
    const settled = yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-1"),
      gitSetup: [{ repository: "acme/web", defaultRef: "main", commit: "c".repeat(40) }],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: snapshot("build-1"),
        completedAt: "2026-09-19T02:05:00.000Z",
      },
    });

    expect(settled.outcome.status).toBe("succeeded");
    expect(settled.freshAt).toBe("2026-09-19T02:05:00.000Z");
    const [environment] = yield* environments.list;
    expect(environment?.activeBuildId).toBe("build-1");
    expect((yield* builds.activeBuild(version.environmentId))?.id).toBe("build-1");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("never lets a failed or cancelled Build replace the last active one", () =>
  Effect.gen(function* () {
    const { environments, builds, version } = yield* setup();
    yield* builds.start(start(version, "build-1"));
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-1"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: snapshot("build-1"),
        completedAt: "2026-09-19T02:05:00.000Z",
      },
    });

    yield* builds.start(start(version, "build-2"));
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-2"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "failed",
        stage: "install",
        message: "The environment's 'install' exited with code 1.",
        completedAt: "2026-09-19T02:07:00.000Z",
      },
    });

    yield* builds.start(start(version, "build-3"));
    yield* builds.cancel({
      buildId: CloudEnvironmentBuildId.make("build-3"),
      occurredAt: "2026-09-19T02:08:00.000Z",
    });

    const [environment] = yield* environments.list;
    expect(environment?.activeBuildId).toBe("build-1");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("keeps an agent-requested draft out of the active slot until it is saved", () =>
  Effect.gen(function* () {
    const { environments, builds, version } = yield* setup();
    yield* builds.start(start(version, "build-1"));
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-1"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: snapshot("build-1"),
        completedAt: "2026-09-19T02:05:00.000Z",
      },
    });

    yield* builds.start(start(version, "build-draft", true));
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-draft"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: snapshot("build-draft"),
        completedAt: "2026-09-19T02:09:00.000Z",
      },
    });
    expect((yield* environments.list)[0]?.activeBuildId).toBe("build-1");

    const saved = yield* builds.save({
      buildId: CloudEnvironmentBuildId.make("build-draft"),
      occurredAt: "2026-09-19T02:10:00.000Z",
    });
    expect(saved.draft).toBe(false);
    expect((yield* environments.list)[0]?.activeBuildId).toBe("build-draft");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("reactivates an older saved successful Build", () =>
  Effect.gen(function* () {
    const { environments, builds, version } = yield* setup();
    yield* builds.start(start(version, "build-1"));
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-1"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: snapshot("build-1"),
        completedAt: "2026-09-19T02:05:00.000Z",
      },
    });
    yield* builds.start(start(version, "build-2"));
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-2"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: snapshot("build-2"),
        completedAt: "2026-09-19T02:06:00.000Z",
      },
    });

    expect((yield* environments.list)[0]?.activeBuildId).toBe("build-2");
    const activated = yield* builds.activate({
      buildId: CloudEnvironmentBuildId.make("build-1"),
      occurredAt: "2026-09-19T02:07:00.000Z",
    });
    expect(activated.id).toBe("build-1");
    expect((yield* environments.list)[0]?.activeBuildId).toBe("build-1");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("refuses to activate a draft or unsuccessful Build", () =>
  Effect.gen(function* () {
    const { builds, version } = yield* setup();
    yield* builds.start(start(version, "build-draft", true));
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-draft"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: snapshot("build-draft"),
        completedAt: "2026-09-19T02:05:00.000Z",
      },
    });
    expect(
      (yield* builds
        .activate({
          buildId: CloudEnvironmentBuildId.make("build-draft"),
          occurredAt: "2026-09-19T02:06:00.000Z",
        })
        .pipe(Effect.flip)).reason,
    ).toBe("build-not-saved");

    yield* builds.start(start(version, "build-failed"));
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-failed"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "failed",
        stage: "install",
        message: "Install failed.",
        completedAt: "2026-09-19T02:07:00.000Z",
      },
    });
    expect(
      (yield* builds
        .activate({
          buildId: CloudEnvironmentBuildId.make("build-failed"),
          occurredAt: "2026-09-19T02:08:00.000Z",
        })
        .pipe(Effect.flip)).reason,
    ).toBe("build-unsuccessful");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("refuses to save a failed draft and leaves the active Build alone", () =>
  Effect.gen(function* () {
    const { environments, builds, version } = yield* setup();
    yield* builds.start(start(version, "build-1"));
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-1"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: snapshot("build-1"),
        completedAt: "2026-09-19T02:05:00.000Z",
      },
    });

    yield* builds.start(start(version, "build-draft", true));
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-draft"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "failed",
        stage: "clone",
        message: "Build could not check out 'acme/web'.",
        completedAt: "2026-09-19T02:09:00.000Z",
      },
    });

    const rejected = yield* builds
      .save({
        buildId: CloudEnvironmentBuildId.make("build-draft"),
        occurredAt: "2026-09-19T02:10:00.000Z",
      })
      .pipe(Effect.flip);
    expect(rejected.reason).toBe("build-unsuccessful");
    expect((yield* environments.list)[0]?.activeBuildId).toBe("build-1");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("a skipped recurring Build reuses the active snapshot and resets its freshness", () =>
  Effect.gen(function* () {
    const { builds, version } = yield* setup();
    yield* builds.start(start(version, "build-1"));
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-1"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: snapshot("build-1"),
        completedAt: "2026-09-19T02:05:00.000Z",
      },
    });

    yield* builds.start({ ...start(version, "build-2"), trigger: "recurring" });
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-2"),
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "skipped",
        reusedBuildId: CloudEnvironmentBuildId.make("build-1"),
        completedAt: "2026-09-20T02:05:00.000Z",
      },
    });

    const active = yield* builds.activeBuild(version.environmentId);
    expect(active?.id).toBe("build-1");
    expect(active?.freshAt).toBe("2026-09-20T02:05:00.000Z");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("settles a Build once, so a late success cannot overwrite a cancellation", () =>
  Effect.gen(function* () {
    const { environments, builds, version } = yield* setup();
    yield* builds.start(start(version, "build-1"));
    yield* builds.cancel({
      buildId: CloudEnvironmentBuildId.make("build-1"),
      occurredAt: "2026-09-19T02:06:00.000Z",
    });

    const rejected = yield* builds
      .complete({
        buildId: CloudEnvironmentBuildId.make("build-1"),
        gitSetup: [],
        logs: [],
        timings: {},
        outcome: {
          status: "succeeded",
          snapshot: snapshot("build-1"),
          completedAt: "2026-09-19T02:07:00.000Z",
        },
      })
      .pipe(Effect.flip);
    expect(rejected.reason).toBe("build-already-settled");
    expect((yield* environments.list)[0]?.activeBuildId).toBeUndefined();
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("stores a per-environment stale threshold, including zero", () =>
  Effect.gen(function* () {
    const { builds, version } = yield* setup();
    expect(yield* builds.staleThresholdSeconds(version.environmentId)).toBeUndefined();
    yield* builds.setStaleThreshold({
      environmentId: version.environmentId,
      staleThresholdSeconds: 0,
      occurredAt: "2026-09-19T02:11:00.000Z",
    });
    expect(yield* builds.staleThresholdSeconds(version.environmentId)).toBe(0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
