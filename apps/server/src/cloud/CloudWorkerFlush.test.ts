import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunAllocationAttempt,
  RunAllocationId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vite-plus/test";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { cloudIdleCheckpointRef, flushCloudRuntimeState } from "./CloudWorkerFlush.ts";

const NOW = "2026-09-17T03:00:00.000Z";
const ALLOCATION_ID = RunAllocationId.make("allocation-flush");
const ATTEMPT = RunAllocationAttempt.make(1);
const THREAD_ID = ThreadId.make("thread-flush");
const PROJECT_ID = ProjectId.make("cloud:allocation-flush:1");

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cloud-flush-config-",
});
const VcsProcessLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessLayer));
const CheckpointLayer = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverLayer),
  Layer.provideMerge(NodeServices.layer),
);
const ProcessRunnerLayer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));
const TestLayer = Layer.mergeAll(CheckpointLayer, ProcessRunnerLayer).pipe(
  Layer.provideMerge(VcsProcessLayer),
  Layer.provideMerge(VcsDriverLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function readModel(workspaceRoot: string): OrchestrationReadModel {
  return {
    snapshotSequence: 7,
    projects: [
      {
        id: PROJECT_ID,
        title: "Cloud workspace",
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Settled turn",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "cloud/run/flush",
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
      },
    ],
    updatedAt: NOW,
  } as unknown as OrchestrationReadModel;
}

function projectionLayer(workspaceRoot: string) {
  return Layer.succeed(
    ProjectionSnapshotQuery,
    ProjectionSnapshotQuery.of({
      getCommandReadModel: () => Effect.succeed(readModel(workspaceRoot)),
    } as unknown as (typeof ProjectionSnapshotQuery)["Service"]),
  );
}

it.layer(TestLayer)("cloud runtime flush", (it) => {
  it.effect(
    "captures the settled workspace, truncates the log, and reports a tmpfs provider home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* ProcessRunner.ProcessRunner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-flush-" });
        const workspace = path.join(root, "repository");
        yield* fs.makeDirectory(workspace, { recursive: true });

        const git = Effect.fn("flushTest.git")(function* (args: ReadonlyArray<string>) {
          const result = yield* runner
            .run({ command: "git", args, cwd: workspace })
            .pipe(Effect.orDie);
          assert.equal(result.code, ChildProcessSpawner.ExitCode(0), result.stderr);
          return result.stdout.trim();
        });
        yield* git(["init", "--initial-branch=main"]);
        yield* git(["config", "user.name", "Cloud Flush Test"]);
        yield* git(["config", "user.email", "cloud-flush@example.test"]);
        yield* fs.writeFileString(path.join(workspace, "tracked.txt"), "committed\n");
        yield* git(["add", "."]);
        yield* git(["commit", "-m", "initial"]);
        // The turn left work the agent has not committed. A flush that does not
        // keep this would lose the turn when the guest is stopped.
        yield* fs.writeFileString(path.join(workspace, "tracked.txt"), "settled edit\n");
        yield* fs.writeFileString(path.join(workspace, "untracked.txt"), "new file\n");

        const flush = yield* Effect.gen(function* () {
          // Leave committed pages in the write-ahead log so the checkpoint has
          // real work to move into the database file.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO cloud_allocation_events (
              allocation_id, sequence, command_id, attempt, occurred_at, event_json
            ) VALUES (${ALLOCATION_ID}, 1, 'command-flush', 1, ${NOW}, '{}')
          `;
          return yield* flushCloudRuntimeState({
            allocationId: ALLOCATION_ID,
            attempt: ATTEMPT,
            threadId: THREAD_ID,
          });
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              projectionLayer(workspace),
              Layer.succeed(HostProcessEnvironment, {
                CODEX_HOME: "/run/t3-worker/credentials/codex",
                CLAUDE_CONFIG_DIR: "/run/t3-worker/credentials/claude",
              }),
              makeSqlitePersistenceLive(path.join(root, "userdata", "state.sqlite")),
            ),
          ),
        );

        expect(flush.userdata).toMatchObject({ status: "flushed" });
        expect(flush.userdata.status === "flushed" ? flush.userdata.detail : "").toMatch(
          /Truncated the T3 database write-ahead log/,
        );
        expect(flush.workspace.status).toBe("flushed");
        // The provider home cannot survive a stop, and the report says so
        // rather than implying the provider session will come back.
        expect(flush.providerHome).toMatchObject({ status: "unavailable" });

        const checkpointRef = cloudIdleCheckpointRef({
          allocationId: ALLOCATION_ID,
          attempt: ATTEMPT,
        });
        const files = yield* git(["ls-tree", "--name-only", "-r", checkpointRef]);
        expect(
          files
            .split("\n")
            .map((line) => line.trim())
            .sort(),
        ).toEqual(["tracked.txt", "untracked.txt"]);
        const captured = yield* git(["show", `${checkpointRef}:tracked.txt`]);
        expect(captured).toBe("settled edit");
      }),
  );

  it.effect("reports a workspace it cannot capture instead of claiming a flush", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-flush-bare-" });
      const workspace = path.join(root, "not-a-repository");
      yield* fs.makeDirectory(workspace, { recursive: true });

      const flush = yield* flushCloudRuntimeState({
        allocationId: ALLOCATION_ID,
        attempt: ATTEMPT,
        threadId: THREAD_ID,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            projectionLayer(workspace),
            Layer.succeed(HostProcessEnvironment, {
              CODEX_HOME: path.join(root, "codex-home"),
            }),
            makeSqlitePersistenceLive(path.join(root, "userdata", "state.sqlite")),
          ),
        ),
      );

      expect(flush.workspace.status).toBe("unavailable");
      expect(flush.userdata.status).toBe("flushed");
      // A provider home on the durable volume is a different answer from one
      // in a runtime directory, and the wake report depends on the difference.
      expect(flush.providerHome.status).toBe("flushed");
    }),
  );
});
