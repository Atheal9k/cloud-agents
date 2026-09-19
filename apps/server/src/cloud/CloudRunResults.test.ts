import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  CloudProviderUnansweredRequestSeconds,
  CloudResultRetentionStatus,
  CloudRunResultId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunAllocationAttempt,
  RunAllocationId,
  RunWorkerId,
  ThreadId,
  type CloudResultCaptureInput,
  type OrchestrationThreadDetailSnapshot,
  type RunAllocation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect } from "vite-plus/test";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CloudProviderExecution from "./CloudProviderExecution.ts";
import { make } from "./CloudRunResults.ts";

const NOW = "2026-09-17T03:00:00.000Z";
const DEADLINE = "2099-09-17T03:00:00.000Z";
const SOURCE_ALLOCATION_ID = RunAllocationId.make("allocation-result-source");
const SOURCE_ATTEMPT = RunAllocationAttempt.make(1);
const SOURCE_THREAD_ID = ThreadId.make("thread-result-source");
const SOURCE_ENVIRONMENT_ID = EnvironmentId.make("environment-result-source");
const encodeRetentionStatus = Schema.encodeSync(Schema.fromJsonString(CloudResultRetentionStatus));

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cloud-results-config-",
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

function transcript(): OrchestrationThreadDetailSnapshot {
  return {
    snapshotSequence: 42,
    thread: {
      id: SOURCE_THREAD_ID,
      projectId: ProjectId.make("cloud:allocation-result-source:1"),
      title: "Retained result",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "cloud/run/result",
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  };
}

function fencedAllocation(baseCommit: string): RunAllocation {
  return {
    id: SOURCE_ALLOCATION_ID,
    attempt: SOURCE_ATTEMPT,
    target: {
      repository: "Atheal9k/cloud-agents",
      baseCommit,
      branch: "cloud/run/result",
    },
    profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
    deadlines: {
      launchBy: DEADLINE,
      bootBy: DEADLINE,
      registerBy: DEADLINE,
      expiresAt: DEADLINE,
      cleanupBy: DEADLINE,
    },
    allocationState: {
      status: "ready",
      instanceId: "i-result-source",
      references: {
        workerId: RunWorkerId.make("worker-result-source"),
        environmentId: SOURCE_ENVIRONMENT_ID,
        threadId: SOURCE_THREAD_ID,
      },
      readyAt: NOW,
    },
    agentOutcome: {
      status: "succeeded",
      resultLocation: { uri: "pending-retention" },
      completedAt: NOW,
    },
    previewState: { status: "unavailable" },
    idleState: { status: "busy" },
    cleanupState: { status: "requested", requestedAt: NOW },
    handledCommandIds: [],
    sequence: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

it.layer(TestLayer)("CloudRunResults", (it) => {
  const fixture = Effect.fn("CloudRunResults.test.fixture")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-results-" });
    const workspace = path.join(root, "workspace");
    const resultsRoot = path.join(root, "retained");
    yield* fs.makeDirectory(workspace, { recursive: true });

    const git = Effect.fn("CloudRunResults.test.git")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
    ) {
      const result = yield* runner.run({ command: "git", args, cwd }).pipe(Effect.orDie);
      assert.equal(result.code, ChildProcessSpawner.ExitCode(0), result.stderr);
      return result.stdout.trim();
    });
    yield* git(workspace, ["init", "--initial-branch=main"]);
    yield* git(workspace, ["config", "user.name", "Cloud Result Test"]);
    yield* git(workspace, ["config", "user.email", "cloud-result@example.test"]);
    yield* fs.writeFileString(path.join(workspace, ".gitignore"), "secret-profile.json\n");
    yield* fs.writeFileString(path.join(workspace, "tracked.txt"), "before\n");
    yield* git(workspace, ["add", "."]);
    yield* git(workspace, ["commit", "-m", "initial"]);
    const baseCommit = yield* git(workspace, ["rev-parse", "HEAD"]);

    yield* fs.writeFileString(path.join(workspace, "tracked.txt"), "after\n");
    yield* fs.writeFileString(path.join(workspace, "untracked.txt"), "eligible\n");
    yield* fs.writeFileString(path.join(workspace, "report.txt"), "tests passed\n");
    yield* fs.writeFileString(path.join(workspace, "secret-profile.json"), "credential\n");

    let executionStarts = 0;
    const execution = CloudProviderExecution.CloudProviderExecution.of({
      start: (request) => {
        executionStarts += 1;
        return Effect.succeed({
          allocationId: request.preparation.allocationId,
          attempt: request.preparation.attempt,
          projectId: ProjectId.make(
            `cloud:${request.preparation.allocationId}:${request.preparation.attempt}`,
          ),
          threadId: request.threadId,
          modelSelection: request.turn.modelSelection,
          runtimeMode: request.turn.runtimeMode,
          interactionMode: request.turn.interactionMode,
          unansweredRequestSeconds: request.unansweredRequestSeconds,
          acceptedSequence: 77,
          startedAt: request.turn.createdAt,
        });
      },
      followUp: () => Effect.die("not used"),
      interrupt: () => Effect.die("not used"),
      approve: () => Effect.die("not used"),
      answer: () => Effect.die("not used"),
    });
    const results = yield* make({
      resultsRoot,
      readTranscript: () => Effect.succeed(transcript()),
      readAllocation: () => Effect.succeed(fencedAllocation(baseCommit)),
    }).pipe(Effect.provideService(CloudProviderExecution.CloudProviderExecution, execution));

    const captureInput: CloudResultCaptureInput = {
      preparation: {
        allocationId: SOURCE_ALLOCATION_ID,
        attempt: SOURCE_ATTEMPT,
        repository: "Atheal9k/cloud-agents",
        selectedRef: "main",
        resolvedCommit: baseCommit,
        outputBranch: "cloud/run/result",
        workspacePath: workspace,
        instructionFiles: ["AGENTS.md"],
        setupResults: [],
        devServers: [],
        verification: [],
        permittedSecretReferences: [],
        preparedAt: NOW,
      },
      verification: {
        allocationId: SOURCE_ALLOCATION_ID,
        attempt: SOURCE_ATTEMPT,
        results: [],
        completedAt: NOW,
      },
      sourceEnvironmentId: SOURCE_ENVIRONMENT_ID,
      sourceThreadId: SOURCE_THREAD_ID,
      hardDeadline: DEADLINE,
      artifacts: [
        { relativePath: "report.txt", name: "focused-tests.txt", mediaType: "text/plain" },
      ],
    };
    return {
      captureInput,
      executionStarts: () => executionStarts,
      fs,
      git,
      path,
      results,
      resultsRoot,
      root,
      workspace,
    } as const;
  });

  describe("capture and recovery", () => {
    it.effect("retains authoritative outputs and starts a fenced linked continuation", () =>
      Effect.gen(function* () {
        const { captureInput, executionStarts, fs, git, path, results, resultsRoot, root } =
          yield* fixture();
        const manifest = yield* results.capture(captureInput);

        expect((yield* results.status(manifest.resultId)).status).toBe("retained");
        yield* fs.writeFileString(
          path.join(resultsRoot, manifest.resultId, "status.json"),
          encodeRetentionStatus({
            status: "retaining",
            resultId: manifest.resultId,
            startedAt: NOW,
            hardDeadline: DEADLINE,
          }),
        );
        expect((yield* results.capture(captureInput)).resultId).toBe(manifest.resultId);
        expect((yield* results.status(manifest.resultId)).status).toBe("retained");
        const diff = yield* results.readText(manifest.resultId, "diff");
        expect(diff).toContain("after");
        expect(diff).toContain("untracked.txt");
        expect(diff).not.toContain("secret-profile.json");
        expect(yield* results.readText(manifest.resultId, "transcript")).toContain(
          SOURCE_THREAD_ID,
        );
        const artifact = yield* results.resolveDownload(
          manifest.resultId,
          manifest.artifacts[0]!.id,
        );
        expect(yield* fs.readFileString(artifact.path)).toBe("tests passed\n");

        const continuationWorkspace = path.join(root, "continuation");
        const continuationInput = {
          resultId: manifest.resultId,
          allocationId: RunAllocationId.make("allocation-result-continuation"),
          attempt: RunAllocationAttempt.make(1),
          destinationWorkspacePath: continuationWorkspace,
          threadId: ThreadId.make("thread-result-continuation"),
          title: "Continue retained result",
          unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds.make(900),
          turn: {
            commandId: CommandId.make("continue-retained-result"),
            messageId: MessageId.make("continue-retained-result-message"),
            prompt: "Continue from the retained checkpoint.",
            attachments: [],
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: NOW,
          },
        } as const;
        const record = yield* results.startContinuation(continuationInput);

        expect(record.sourceThreadId).toBe(SOURCE_THREAD_ID);
        expect(
          (yield* fs.readFileString(path.join(continuationWorkspace, "tracked.txt"))).replaceAll(
            "\r\n",
            "\n",
          ),
        ).toBe("after\n");
        expect(
          (yield* fs.readFileString(path.join(continuationWorkspace, "untracked.txt"))).replaceAll(
            "\r\n",
            "\n",
          ),
        ).toBe("eligible\n");
        expect(yield* fs.exists(path.join(continuationWorkspace, "secret-profile.json"))).toBe(
          false,
        );
        expect(yield* git(continuationWorkspace, ["status", "--short"])).toContain("untracked.txt");
        expect((yield* results.startContinuation(continuationInput)).continuation.threadId).toBe(
          continuationInput.threadId,
        );
        expect(executionStarts()).toBe(1);
      }),
    );

    it.effect("records a non-retryable failure when the compute deadline has passed", () =>
      Effect.gen(function* () {
        const { captureInput, results } = yield* fixture();
        const error = yield* Effect.flip(
          results.capture({ ...captureInput, hardDeadline: "1960-01-01T00:00:00.000Z" }),
        );
        expect(error.reason).toBe("hard-deadline-exceeded");
        const resultId = CloudRunResultId.make(
          NodeCrypto.createHash("sha256")
            .update(`${captureInput.preparation.allocationId}:${captureInput.preparation.attempt}`)
            .digest("hex"),
        );
        const status = yield* results.status(resultId);
        expect(status).toMatchObject({
          status: "failed",
          reason: "hard-deadline-exceeded",
          retryable: false,
        });
      }),
    );

    it.effect("refuses changed credential files before creating the workspace bundle", () =>
      Effect.gen(function* () {
        const { captureInput, fs, path, results, workspace } = yield* fixture();
        yield* fs.writeFileString(path.join(workspace, ".env"), "TOKEN=secret\n");

        const error = yield* Effect.flip(results.capture(captureInput));

        expect(error).toMatchObject({ reason: "invalid-artifact", retryable: true });
        expect(error.message).toContain(".env");
      }),
    );
  });

  describe("permanent deletion", () => {
    it.effect("erases only the agent it was asked to delete", () =>
      Effect.gen(function* () {
        const { captureInput, fs, path, results, resultsRoot } = yield* fixture();
        const manifest = yield* results.capture(captureInput);
        const neighbour = CloudRunResultId.make(
          NodeCrypto.createHash("sha256").update("allocation-neighbour:1").digest("hex"),
        );
        yield* fs.makeDirectory(path.join(resultsRoot, neighbour), { recursive: true });
        yield* fs.writeFileString(path.join(resultsRoot, neighbour, "status.json"), "{}");

        const purged = yield* results.purgeAllocation({
          allocationId: SOURCE_ALLOCATION_ID,
          attempts: [1, 2],
        });

        expect(purged).toEqual([manifest.resultId]);
        expect(yield* fs.exists(path.join(resultsRoot, manifest.resultId))).toBe(false);
        expect(yield* fs.exists(path.join(resultsRoot, neighbour))).toBe(true);
        expect(
          yield* results.purgeAllocation({
            allocationId: SOURCE_ALLOCATION_ID,
            attempts: [1, 2],
          }),
        ).toEqual([]);
      }),
    );
  });
});
