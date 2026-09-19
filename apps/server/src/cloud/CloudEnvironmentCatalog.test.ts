import {
  CloudEnvironmentResolutionInput,
  CloudEnvironmentRestoreInput,
  CloudEnvironmentSaveInput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make } from "./CloudEnvironmentCatalog.ts";

const decodeSave = Schema.decodeSync(CloudEnvironmentSaveInput);
const decodeRestore = Schema.decodeSync(CloudEnvironmentRestoreInput);
const decodeResolution = Schema.decodeSync(CloudEnvironmentResolutionInput);

const personal = decodeSave({
  environmentId: "environment-personal",
  name: "Personal web",
  source: { type: "saved", scope: "personal", owner: "victor" },
  repositories: [{ repository: "acme/web", defaultRef: "main" }],
  config: {
    image: "node:24-bookworm",
    user: "node",
    install: "pnpm install",
    start: "pnpm dev",
    terminals: [{ name: "tests", command: "pnpm test" }],
    ports: [{ name: "web", port: 5173 }],
    egressMode: "network_settings_only",
    egressAllowlist: ["registry.npmjs.org"],
  },
  secretReferences: [{ name: "NPM_TOKEN", reference: "secret/npm", availability: "build" }],
  occurredAt: "2026-09-19T02:00:00.000Z",
});

it.effect("creates immutable versions and restores by appending another version", () =>
  Effect.gen(function* () {
    const catalog = yield* make();
    const first = yield* catalog.save(personal);
    const second = yield* catalog.save(
      decodeSave({
        ...personal,
        expectedVersion: 1,
        config: { ...personal.config, image: "node:24.8-bookworm" },
        occurredAt: "2026-09-19T02:01:00.000Z",
      }),
    );
    const restored = yield* catalog.restore(
      decodeRestore({
        environmentId: personal.environmentId,
        expectedVersion: 2,
        restoreVersion: 1,
        occurredAt: "2026-09-19T02:02:00.000Z",
      }),
    );

    expect(first.current.version).toBe(1);
    expect(second.history.map((version) => version.base)).toEqual([
      { kind: "image", image: "node:24.8-bookworm" },
      { kind: "image", image: "node:24-bookworm" },
    ]);
    expect(restored.current.version).toBe(3);
    expect(restored.current).toMatchObject({
      restoredFromVersion: 1,
      config: { image: "node:24-bookworm" },
    });
    expect(restored.history.map((version) => version.version)).toEqual([3, 2, 1]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("resolves repository, then personal, then team, then default", () =>
  Effect.gen(function* () {
    const catalog = yield* make();
    yield* catalog.save(
      decodeSave({
        ...personal,
        environmentId: "environment-default",
        source: { type: "saved", scope: "default" },
      }),
    );
    const onlyDefault = yield* catalog.resolve(decodeResolution({ repository: "acme/web" }));
    yield* catalog.save(
      decodeSave({
        ...personal,
        environmentId: "environment-team",
        source: { type: "saved", scope: "team", owner: "acme" },
      }),
    );
    const throughTeam = yield* catalog.resolve(decodeResolution({ repository: "acme/web" }));
    yield* catalog.save(personal);
    const throughPersonal = yield* catalog.resolve(decodeResolution({ repository: "acme/web" }));
    yield* catalog.save(
      decodeSave({
        ...personal,
        environmentId: "environment-repository",
        source: {
          type: "repository",
          repository: "acme/web",
          path: ".cursor/environment.json",
          commit: "abc123",
        },
      }),
    );
    const throughRepository = yield* catalog.resolve(decodeResolution({ repository: "acme/web" }));

    expect(onlyDefault?.version.source).toMatchObject({ scope: "default" });
    expect(throughTeam?.version.source).toMatchObject({ scope: "team" });
    expect(throughPersonal?.version.source).toMatchObject({ scope: "personal" });
    expect(throughRepository?.version.source).toMatchObject({
      type: "repository",
      path: ".cursor/environment.json",
    });
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("resolves nothing for a repository no environment covers", () =>
  Effect.gen(function* () {
    const catalog = yield* make();
    yield* catalog.save(personal);

    expect(yield* catalog.resolve(decodeResolution({ repository: "acme/other" }))).toBeNull();
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("refuses a saved environment that would shadow a committed repository config", () =>
  Effect.gen(function* () {
    const catalog = yield* make();
    yield* catalog.save(
      decodeSave({
        ...personal,
        environmentId: "environment-repository",
        source: {
          type: "repository",
          repository: "acme/web",
          path: ".cursor/environment.json",
          commit: "abc123",
        },
      }),
    );
    const error = yield* catalog.save(personal).pipe(Effect.flip);
    const editedInPlace = yield* catalog.save(
      decodeSave({
        ...personal,
        environmentId: "environment-repository",
        expectedVersion: 1,
        source: {
          type: "repository",
          repository: "acme/web",
          path: ".cursor/environment.json",
          commit: "def456",
        },
      }),
    );

    expect(error.reason).toBe("repository-environment-exists");
    expect(error.message).toContain(".cursor/environment.json");
    expect(editedInPlace.current.version).toBe(2);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rejects stale edits", () =>
  Effect.gen(function* () {
    const catalog = yield* make();
    yield* catalog.save(personal);
    const error = yield* catalog
      .save(decodeSave({ ...personal, expectedVersion: 2 }))
      .pipe(Effect.flip);

    expect(error.reason).toBe("version-conflict");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
