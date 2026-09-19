import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentSaveInput,
  CLOUD_ENV_SETUP_TURN_HEADER,
  CLOUD_ENV_SETUP_USER_REQUEST,
  selectCloudEnvSetupWorkflow,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layer as buildCatalogLayer } from "./CloudEnvironmentBuildCatalog.ts";
import {
  CloudEnvironmentCatalog,
  layer as environmentCatalogLayer,
} from "./CloudEnvironmentCatalog.ts";
import { CloudEnvironmentBuildCatalog } from "./CloudEnvironmentBuildCatalog.ts";
import { make as makeDiagnostics } from "./CloudDiagnosticsCatalog.ts";
import {
  buildCloudEnvSetupTurn,
  loadCloudEnvSetupSkillPackage,
} from "./cloudEnvSetupSkill.ts";

const decodeSave = Schema.decodeSync(CloudEnvironmentSaveInput);

const TestLayer = Layer.mergeAll(environmentCatalogLayer, buildCatalogLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const snapshot = (id: string) => ({
  id,
  digest: "a".repeat(64),
  sizeBytes: 4096,
  createdAt: "2026-09-19T12:05:00.000Z",
});

it.effect("runs create through Save, pauses on required actions, and keeps a failed draft inactive", () =>
  Effect.gen(function* () {
    const skill = loadCloudEnvSetupSkillPackage();
    const turn = buildCloudEnvSetupTurn({
      skill,
      workflow: "create",
      userPrompt: CLOUD_ENV_SETUP_USER_REQUEST,
    });
    expect(turn.prompt.startsWith(CLOUD_ENV_SETUP_USER_REQUEST)).toBe(true);
    expect(turn.prompt.indexOf(CLOUD_ENV_SETUP_TURN_HEADER)).toBeLessThan(
      turn.prompt.indexOf("# SKILL.md"),
    );
    expect(turn.beforeFirstToolCall.includes("opener")).toBe(true);
    expect(turn.affectsRunningAgent).toBe(false);

    const diagnostics = yield* makeDiagnostics();
    const environments = yield* CloudEnvironmentCatalog;
    const builds = yield* CloudEnvironmentBuildCatalog;

    const greenfield = yield* diagnostics.environmentInfo({ repository: "acme/web" });
    expect(greenfield.environmentId).toBeUndefined();
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: CLOUD_ENV_SETUP_USER_REQUEST,
        environmentInfo: greenfield,
      }),
    ).toBe("create");

    const blocked = yield* diagnostics.requestSetupActions({
      actions: [
        {
          type: "add_secrets",
          secrets: [{ name: "NPM_TOKEN", optional: false }],
          reason: "Private packages",
        },
      ],
    });
    expect(blocked.accepted).toBe(1);
    expect((yield* diagnostics.outstandingSetupActions).length).toBe(1);
    const refused = yield* diagnostics
      .proposeEnvironmentJson({
        environmentJson: { image: "node:24-bookworm", install: "pnpm i" },
      })
      .pipe(Effect.flip);
    expect(refused.reason).toBe("invalid-request");
    expect(yield* diagnostics.readProposal()).toBeUndefined();

    yield* diagnostics.resolveSetupActions();
    expect(yield* diagnostics.outstandingSetupActions).toEqual([]);

    const saved = yield* environments.save(
      decodeSave({
        environmentId: "environment-web",
        name: "Personal web",
        source: { type: "saved", scope: "personal", owner: "victor" },
        repositories: [{ repository: "acme/web", defaultRef: "main" }],
        config: { image: "node:24-bookworm", install: "pnpm i" },
        secretReferences: [],
        occurredAt: "2026-09-19T12:00:00.000Z",
      }),
    );
    const active = yield* builds.start({
      buildId: CloudEnvironmentBuildId.make("build-active"),
      version: saved.current,
      trigger: "manual",
      draft: false,
      base: { kind: "image", image: "node:24-bookworm" },
      inputsFingerprint: "b".repeat(64),
      startedAt: "2026-09-19T12:01:00.000Z",
    });
    yield* builds.complete({
      buildId: active.id,
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: snapshot("build-active"),
        completedAt: "2026-09-19T12:02:00.000Z",
      },
    });

    const creating = yield* diagnostics.takeSnapshot({ environmentId: saved.id });
    expect(creating.status).toBe("creating");
    const ready = yield* diagnostics.completeSnapshot(creating.snapshotId, { status: "ready" });
    expect(ready.status).toBe("ready");

    const failedDraft = yield* diagnostics.triggerBuild({
      environmentId: saved.id,
      environmentJson: { snapshot: ready.snapshotId, install: "pnpm i", start: "pnpm dev" },
      occurredAt: "2026-09-19T12:03:00.000Z",
    });
    expect(failedDraft.draft).toBe(true);
    expect(failedDraft.trigger).toBe("agent-requested");
    yield* builds.complete({
      buildId: failedDraft.id,
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "failed",
        stage: "install",
        message: "install exited 1",
        completedAt: "2026-09-19T12:04:00.000Z",
      },
    });
    expect((yield* environments.list)[0]?.activeBuildId).toBe("build-active");

    const successfulDraft = yield* diagnostics.triggerBuild({
      environmentId: saved.id,
      environmentJson: { snapshot: ready.snapshotId, install: "pnpm i", start: "pnpm dev" },
      occurredAt: "2026-09-19T12:05:00.000Z",
    });
    yield* builds.complete({
      buildId: successfulDraft.id,
      gitSetup: [],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: snapshot("build-draft"),
        completedAt: "2026-09-19T12:06:00.000Z",
      },
    });
    expect((yield* environments.list)[0]?.activeBuildId).toBe("build-active");

    const proposed = yield* diagnostics.proposeEnvironmentJson({
      environmentId: saved.id,
      environmentJson: { snapshot: ready.snapshotId, install: "pnpm i", start: "pnpm dev" },
      buildId: successfulDraft.id,
    });
    expect(proposed).toEqual({ proposed: true, buildId: successfulDraft.id });
    expect(yield* diagnostics.readProposal(saved.id)).toMatchObject({
      buildId: successfulDraft.id,
    });

    const activated = yield* builds.save({
      buildId: successfulDraft.id,
      occurredAt: "2026-09-19T12:07:00.000Z",
    });
    expect(activated.draft).toBe(false);
    expect((yield* environments.list)[0]?.activeBuildId).toBe(successfulDraft.id);

    const afterSave = yield* environments.save(
      decodeSave({
        environmentId: saved.id,
        expectedVersion: (yield* environments.list)[0]?.current.version,
        name: "Personal web",
        source: { type: "saved", scope: "personal", owner: "victor" },
        repositories: [{ repository: "acme/web", defaultRef: "main" }],
        config: { snapshot: ready.snapshotId, install: "pnpm i --frozen-lockfile", start: "pnpm dev" },
        secretReferences: [],
        occurredAt: "2026-09-19T12:08:00.000Z",
      }),
    );
    expect(afterSave.current.version).toBeGreaterThan(saved.current.version);
    expect(afterSave.current.config.install).toBe("pnpm i --frozen-lockfile");
    expect(turn.affectsRunningAgent).toBe(false);
    expect(turn.prompt).toContain("newly started agents");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("routes repository-managed, DB-managed, and migrate flows from environment-info", () =>
  Effect.gen(function* () {
    const diagnostics = yield* makeDiagnostics();
    const environments = yield* CloudEnvironmentCatalog;
    const skill = loadCloudEnvSetupSkillPackage();

    yield* environments.save(
      decodeSave({
        environmentId: "environment-repo",
        name: "Repo web",
        source: {
          type: "repository",
          repository: "acme/web",
          path: ".cursor/environment.json",
          commit: "c".repeat(40),
        },
        repositories: [{ repository: "acme/web", defaultRef: "main" }],
        config: { image: "node:24-bookworm", install: "pnpm i" },
        secretReferences: [],
        occurredAt: "2026-09-19T12:00:00.000Z",
      }),
    );
    yield* environments.save(
      decodeSave({
        environmentId: "environment-personal",
        name: "Personal api",
        source: { type: "saved", scope: "personal", owner: "victor" },
        repositories: [{ repository: "acme/api", defaultRef: "main" }],
        config: { image: "node:24-bookworm", install: "pnpm i" },
        secretReferences: [],
        occurredAt: "2026-09-19T12:01:00.000Z",
      }),
    );

    const repoInfo = yield* diagnostics.environmentInfo({ repository: "acme/web" });
    const dbInfo = yield* diagnostics.environmentInfo({ repository: "acme/api" });
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: "Update the environment install",
        environmentInfo: repoInfo,
      }),
    ).toBe("repo-managed");
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: "Improve the environment start command",
        environmentInfo: dbInfo,
      }),
    ).toBe("db-managed");
    expect(
      selectCloudEnvSetupWorkflow({
        prompt: "Migrate this environment to builds",
        environmentInfo: repoInfo,
      }),
    ).toBe("migrate");

    expect(
      buildCloudEnvSetupTurn({
        skill,
        workflow: "repo-managed",
        userPrompt: "Update the environment",
      }).prompt,
    ).toContain("references/update-repo-managed-environment.md");
    expect(
      buildCloudEnvSetupTurn({
        skill,
        workflow: "db-managed",
        userPrompt: "Update the environment",
      }).prompt,
    ).toContain("references/update-db-managed-environment.md");
    expect(
      buildCloudEnvSetupTurn({
        skill,
        workflow: "migrate",
        userPrompt: "Migrate this environment to builds",
      }).prompt,
    ).toContain("references/migrate-to-builds.md");
  }).pipe(Effect.provide(TestLayer)),
);
