import {
  CloudEnvironmentId,
  CloudEnvironmentSaveInput,
  CloudRunId,
  CLOUD_PARENT_SUBAGENT_PERMISSIONS,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layer as buildCatalogLayer } from "./CloudEnvironmentBuildCatalog.ts";
import { layer as environmentCatalogLayer, CloudEnvironmentCatalog } from "./CloudEnvironmentCatalog.ts";
import { make } from "./CloudDiagnosticsCatalog.ts";
import { admitCloudExtensibility } from "./cloudExtensibilityPolicy.ts";
import { cloudEgressExceptions, resolveCloudEgressPolicy } from "./cloudSecurityPolicy.ts";

const decodeSave = Schema.decodeSync(CloudEnvironmentSaveInput);

const TestLayer = Layer.mergeAll(environmentCatalogLayer, buildCatalogLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect("exposes environment info, draft Builds, snapshots, and isolated usage", () =>
  Effect.gen(function* () {
    const catalog = yield* make();
    const environments = yield* CloudEnvironmentCatalog;
    yield* environments.save(
      decodeSave({
        environmentId: "environment-web",
        name: "Personal web",
        source: { type: "saved", scope: "personal", owner: "victor" },
        repositories: [{ repository: "acme/web", defaultRef: "main" }],
        config: { image: "node:24-bookworm", install: "pnpm i", start: "pnpm dev" },
        secretReferences: [],
        occurredAt: "2026-09-19T12:00:00.000Z",
      }),
    );

    const info = yield* catalog.environmentInfo({ repository: "acme/web" });
    expect(info).toMatchObject({
      environmentId: "environment-web",
      environmentJsonPath: null,
      sourceType: "personal",
      defaultRevision: "main",
    });

    const snapshot = yield* catalog.takeSnapshot({ environmentId: "environment-web" });
    expect(snapshot.status).toBe("creating");
    expect((yield* catalog.checkSnapshot(snapshot.snapshotId)).status).toBe("creating");
    expect(
      (yield* catalog.completeSnapshot(snapshot.snapshotId, { status: "ready" })).status,
    ).toBe("ready");

    const build = yield* catalog.triggerBuild({
      environmentId: "environment-web",
      environmentJson: {
        snapshot: snapshot.snapshotId,
        install: "pnpm i",
        start: "pnpm dev",
      },
      occurredAt: "2026-09-19T12:01:00.000Z",
    });
    expect(build.draft).toBe(true);
    expect(build.trigger).toBe("agent-requested");
    expect(build.outcome.status).toBe("running");
    expect((yield* catalog.listBuilds({ environmentId: "environment-web" })).map((item) => item.id)).toEqual(
      [build.id],
    );
    expect((yield* catalog.buildLogs({ buildId: build.id })).logs).toEqual([]);

    const proposed = yield* catalog.proposeEnvironmentJson({
      environmentId: "environment-web",
      environmentJson: { snapshot: snapshot.snapshotId, install: "pnpm i" },
      buildId: build.id,
    });
    expect(proposed).toEqual({ proposed: true, buildId: build.id });

    const actions = yield* catalog.requestSetupActions({
      actions: [
        {
          type: "add_egress_allowlist_domain",
          domain: "registry.npmjs.org",
          reason: "Packages",
        },
      ],
    });
    expect(actions.accepted).toBe(1);

    const admission = admitCloudExtensibility(
      {
        teamMcp: [],
        personalMcp: [],
        apiMcp: [],
        customSubagents: [{ name: "reviewer", description: "Reviews", prompt: "Review" }],
      },
      {
        disableAllMcpServers: false,
        mcpServerAllowlist: [],
        egress: resolveCloudEgressPolicy({
          environment: { mode: "allow_all", allowlist: [] },
          exceptions: cloudEgressExceptions({
            controllerHost: "controller.internal",
            scmHosts: [],
            artifactHosts: [],
          }),
        }),
        controllerMcpOrigin: "https://controller.internal",
        phase: "runtime",
        parentPermissions: CLOUD_PARENT_SUBAGENT_PERMISSIONS,
      },
    );
    yield* catalog.bindRun({
      agentId: "bc-1",
      runId: CloudRunId.make("run-1"),
      environmentId: CloudEnvironmentId.make("environment-web"),
      admission,
    });
    yield* catalog.recordSubagentUsage({
      runId: CloudRunId.make("run-1"),
      subagentName: "reviewer",
      inputTokens: 2,
      outputTokens: 4,
    });
    expect(yield* catalog.usageForRun("run-1")).toEqual([
      {
        runId: CloudRunId.make("run-1"),
        subagentName: "reviewer",
        inputTokens: 2,
        outputTokens: 4,
      },
    ]);

    const fleet = yield* catalog.fleetDiagnostics({ authorized: false }).pipe(Effect.flip);
    expect(fleet.reason).toBe("unauthorized");
  }).pipe(Effect.provide(TestLayer)),
);
