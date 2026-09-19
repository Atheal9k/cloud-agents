import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CloudAgentId,
  CloudHandoffTransferId,
  EnvironmentId,
  RunAllocationId,
  ThreadId,
  type CloudAllocationSnapshot,
  type CloudHandoffExecuteInput,
  type CloudHandoffPreviewInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { make } from "./CloudHandoff.ts";

const NOW_ENV = EnvironmentId.make("environment-local");
const CLOUD_ENV = EnvironmentId.make("environment-cloud");
const AGENT_ID = CloudAgentId.make("agent-handoff");
const ALLOCATION_ID = RunAllocationId.make("allocation-handoff");
const THREAD_ID = ThreadId.make("thread-local");

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cloud-handoff-config-",
});
const ProcessRunnerLayer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));
const TestLayer = Layer.mergeAll(ProcessRunnerLayer, ServerConfigLayer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

function previewInput(
  workspace: string,
  overrides: Partial<CloudHandoffPreviewInput> = {},
): CloudHandoffPreviewInput {
  return {
    direction: "local-to-cloud",
    intent: "linked-continuation",
    localWorkspacePath: workspace,
    sourceEnvironmentId: NOW_ENV,
    destinationEnvironmentId: CLOUD_ENV,
    sourceThreadId: THREAD_ID,
    ...overrides,
  };
}

function executeInput(
  workspace: string,
  destination: string,
  transferId: CloudHandoffTransferId,
  overrides: Partial<CloudHandoffExecuteInput> = {},
): CloudHandoffExecuteInput {
  return {
    transferId,
    direction: "local-to-cloud",
    intent: "linked-continuation",
    localWorkspacePath: workspace,
    sourceEnvironmentId: NOW_ENV,
    destinationEnvironmentId: CLOUD_ENV,
    destinationWorkspacePath: destination,
    selectedPaths: [],
    conflictPolicy: "abort",
    sourceThreadId: THREAD_ID,
    ...overrides,
  };
}

function idleAgentSnapshot(baseCommit: string): CloudAllocationSnapshot {
  return {
    controller: {
      mode: "local",
      requiresHostOnline: true,
      admission: { status: "open" },
    },
    limits: {
      maxConcurrentWorkers: 1,
      maxQueueDepth: 8,
      maxRunSeconds: 60,
      maxInputWaitSeconds: 60,
      previewLeaseSeconds: 60,
      previewLeaseMaxSeconds: 240,
      idleReleaseSeconds: 60,
      conversationRetentionDays: 0,
      allowedInstanceTypes: ["c7i.2xlarge"],
    },
    workerPriceAssumptions: [],
    spendingControl: "estimate-only",
    allocations: [],
    agents: [
      {
        id: AGENT_ID,
        allocationId: ALLOCATION_ID,
        conversation: { title: "Handoff agent", runIds: [] },
        repository: "example/repo",
        baseCommit,
        environmentProfileId: "linux-web",
        branches: ["main"],
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-19T00:00:00.000Z",
        status: "IDLE",
      },
    ],
    usage: [],
  };
}

it.layer(TestLayer)("CloudHandoff", (it) => {
  const fixture = Effect.fn("CloudHandoff.test.fixture")(function* (options?: {
    readonly patch?: string;
    readonly snapshot?: CloudAllocationSnapshot;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-handoff-" });
    const workspace = path.join(root, "workspace");
    const handoffsRoot = path.join(root, "handoffs");
    yield* fs.makeDirectory(workspace, { recursive: true });
    const git = Effect.fn("CloudHandoff.test.git")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
      allowFailure = false,
    ) {
      const result = yield* runner.run({ command: "git", args, cwd }).pipe(Effect.orDie);
      if (!allowFailure) {
        assert.equal(result.code, ChildProcessSpawner.ExitCode(0), result.stderr);
      }
      return result.stdout.trim();
    });
    yield* git(workspace, ["init", "--initial-branch=main"]);
    yield* git(workspace, ["config", "user.name", "Handoff Test"]);
    yield* git(workspace, ["config", "user.email", "handoff@example.test"]);
    yield* fs.writeFileString(path.join(workspace, ".gitignore"), ".env\nignored.log\n");
    yield* fs.writeFileString(path.join(workspace, "README.md"), "hello\n");
    yield* git(workspace, ["add", ".gitignore", "README.md"]);
    yield* git(workspace, ["commit", "-m", "Initial commit"]);
    const baseCommit = yield* git(workspace, ["rev-parse", "HEAD"]);
    const service = yield* make({
      handoffsRoot,
      readSnapshot: Effect.succeed(options?.snapshot ?? idleAgentSnapshot(baseCommit)),
      readRetainedDiff: () =>
        Effect.succeed(
          options?.patch === undefined ? null : { patch: options.patch, transcriptAvailable: true },
        ),
    });
    return { fs, path, git, workspace, root, service, baseCommit };
  });

  it.effect("previews local changes without uploading credentials or ignored files", () =>
    Effect.gen(function* () {
      const { fs, path, workspace, service } = yield* fixture();
      yield* fs.writeFileString(path.join(workspace, "README.md"), "hello world\n");
      yield* fs.writeFileString(path.join(workspace, "src-app.ts"), "export {}\n");
      yield* fs.writeFileString(path.join(workspace, ".env"), "SECRET=1\n");
      yield* fs.writeFileString(path.join(workspace, "ignored.log"), "noise\n");
      const preview = yield* service.preview(previewInput(workspace));
      expect(preview.baseCommit.length).toBeGreaterThan(0);
      expect(preview.destination.workspacePath).toContain("t3-cloud-handoff-");
      expect(preview.files.find((file) => file.path === "README.md")?.inclusion).toBe("selected");
      expect(preview.files.find((file) => file.path === "src-app.ts")?.inclusion).toBe("selected");
      expect(preview.files.find((file) => file.path === ".env")?.inclusion).toBe("excluded");
      expect(preview.files.find((file) => file.path === "ignored.log")?.excludeReason).toBe(
        "gitignored",
      );
      expect(preview.explanation).toContain("new environment identity");
    }),
  );

  it.effect(
    "applies selected local files into a new worktree and retries without duplicating",
    () =>
      Effect.gen(function* () {
        const { fs, path, git, workspace, root, service } = yield* fixture();
        yield* fs.writeFileString(path.join(workspace, "README.md"), "hello cloud\n");
        yield* fs.writeFileString(path.join(workspace, ".env"), "SECRET=1\n");
        const preview = yield* service.preview(previewInput(workspace));
        const destination = path.join(root, "destination");
        const first = yield* service.execute(
          executeInput(workspace, destination, preview.transferId),
        );
        expect(first.status).toBe("applied");
        expect(first.appliedPaths).toContain("README.md");
        expect(first.excludedPaths).toContain(".env");
        expect(yield* fs.readFileString(path.join(destination, "README.md"))).toBe("hello cloud\n");
        expect(yield* fs.exists(path.join(destination, ".env"))).toBe(false);
        const second = yield* service.execute(
          executeInput(workspace, destination, preview.transferId),
        );
        expect(second.status).toBe("already-applied");
        expect(yield* git(destination, ["diff", "--", "README.md"])).toContain("hello cloud");
      }),
  );

  it.effect("imports cloud changes without overwriting dirty local files", () =>
    Effect.gen(function* () {
      const { fs, path, git, workspace, root } = yield* fixture();
      yield* fs.writeFileString(path.join(workspace, "README.md"), "from cloud\n");
      const patch = `${yield* git(workspace, ["diff", "HEAD", "--", "README.md"], true)}\n`;
      yield* git(workspace, ["checkout", "--", "README.md"]);
      const destination = path.join(root, "import");
      yield* git(workspace, ["worktree", "add", destination, "HEAD"]);
      yield* fs.writeFileString(path.join(destination, "README.md"), "already dirty\n");
      const importing = yield* make({
        handoffsRoot: path.join(root, "handoffs-import"),
        readSnapshot: Effect.succeed(
          idleAgentSnapshot(yield* git(workspace, ["rev-parse", "HEAD"])),
        ),
        readRetainedDiff: () => Effect.succeed({ patch, transcriptAvailable: true }),
      });
      const preview = yield* importing.preview(
        previewInput(workspace, {
          direction: "cloud-to-local",
          agentId: AGENT_ID,
          destinationWorkspacePath: destination,
        }),
      );
      const failed = yield* importing
        .execute(
          executeInput(workspace, destination, preview.transferId, {
            direction: "cloud-to-local",
            agentId: AGENT_ID,
          }),
        )
        .pipe(Effect.flip);
      expect(failed.reason).toBe("dirty-conflict");
      expect(failed.conflicts?.map((entry) => entry.path)).toEqual(["README.md"]);
      expect(yield* fs.readFileString(path.join(destination, "README.md"))).toBe("already dirty\n");

      const skipped = yield* importing.execute(
        executeInput(workspace, destination, CloudHandoffTransferId.make("retry-skip"), {
          direction: "cloud-to-local",
          agentId: AGENT_ID,
          conflictPolicy: "skip-conflicting",
        }),
      );
      expect(skipped.skippedConflictPaths).toEqual(["README.md"]);
      expect(yield* fs.readFileString(path.join(destination, "README.md"))).toBe("already dirty\n");
    }),
  );

  it.effect("keeps wake on the same agent instead of creating a second writer", () =>
    Effect.gen(function* () {
      const { workspace, service } = yield* fixture();
      const preview = yield* service.preview(
        previewInput(workspace, { intent: "wake-same-agent", agentId: AGENT_ID }),
      );
      expect(preview.snapshotWriter).toBe("source");
      expect(preview.source.agentId).toBe(AGENT_ID);
      expect(preview.destination.agentId).toBe(AGENT_ID);
      const woke = yield* service.execute(
        executeInput(workspace, workspace, preview.transferId, {
          intent: "wake-same-agent",
          agentId: AGENT_ID,
        }),
      );
      expect(woke.status).toBe("woke-same-agent");
      expect(woke.source.agentId).toBe(woke.destination.agentId);
    }),
  );
});
