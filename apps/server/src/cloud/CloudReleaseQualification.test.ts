import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  CloudProviderUnansweredRequestSeconds,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunAllocationAttempt,
  RunAllocationId,
  RunWorkerId,
  ThreadId,
  type CloudRepositoryRecipe,
  type OrchestrationThreadDetailSnapshot,
  type RunAllocation,
  emptyCloudSessionLeases,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CloudGitCredentials from "./CloudGitCredentials.ts";
import * as CloudProviderExecution from "./CloudProviderExecution.ts";
import * as CloudRepositoryPreparation from "./CloudRepositoryPreparation.ts";
import * as CloudRunPublication from "./CloudRunPublication.ts";
import * as CloudRunResults from "./CloudRunResults.ts";

const NOW = "2026-09-18T00:00:00.000Z";
const DEADLINE = "2099-09-18T00:00:00.000Z";
const ALLOCATION_ID = RunAllocationId.make("allocation-release-qualification");
const ATTEMPT = RunAllocationAttempt.make(1);
const THREAD_ID = ThreadId.make("thread-release-qualification");
const ENVIRONMENT_ID = EnvironmentId.make("environment-release-qualification");

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cloud-release-qualification-config-",
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
    snapshotSequence: 23,
    thread: {
      id: THREAD_ID,
      projectId: ProjectId.make(`cloud:${ALLOCATION_ID}:${ATTEMPT}`),
      title: "Release qualification",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "cloud/release-qualification",
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

it.layer(TestLayer)("cloud release qualification", (it) => {
  it.effect(
    "retains a disconnected private-repository run and publishes its recorded draft PR",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* ProcessRunner.ProcessRunner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-release-" });
        const source = path.join(root, "private-source");
        const remote = path.join(root, "private-remote.git");
        const workspaceRoot = path.join(root, "workspaces");
        const cacheRoot = path.join(root, "dependency-cache");
        const startupTimingsPath = path.join(root, "startup-timings.json");

        const git = Effect.fn("CloudReleaseQualification.git")(function* (
          cwd: string,
          args: ReadonlyArray<string>,
        ) {
          const result = yield* runner.run({ command: "git", args, cwd }).pipe(Effect.orDie);
          assert.equal(result.code, ChildProcessSpawner.ExitCode(0), result.stderr);
          return result.stdout.trim();
        });

        yield* fs.makeDirectory(source, { recursive: true });
        yield* git(source, ["init", "--initial-branch=main"]);
        yield* git(source, ["config", "user.name", "Cloud Release Test"]);
        yield* git(source, ["config", "user.email", "cloud-release@example.test"]);
        yield* fs.writeFileString(path.join(source, "AGENTS.md"), "# Private fixture\n");
        yield* fs.writeFileString(path.join(source, "app.txt"), "before\n");
        yield* fs.writeFileString(path.join(source, "package-lock.json"), "{}\n");
        yield* git(source, ["add", "."]);
        yield* git(source, ["commit", "-m", "base"]);
        const baseCommit = yield* git(source, ["rev-parse", "HEAD"]);
        yield* git(root, ["init", "--bare", remote]);
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "origin", "main"]);

        yield* fs.writeFileString(
          startupTimingsPath,
          '{"imageBoot":{"startedAt":"2026-09-18T00:00:00.000Z","completedAt":"2026-09-18T00:00:12.000Z","durationMs":12000},"serviceStartup":{"startedAt":"2026-09-18T00:00:12.000Z","completedAt":"2026-09-18T00:00:15.000Z","durationMs":3000}}\n',
        );

        let remoteCommit: string | null = null;
        let pullRequest: CloudGitCredentials.CloudGitPullRequest | null = null;
        const credentials = CloudGitCredentials.CloudGitCredentials.of({
          clone: ({ destination }) =>
            git(root, ["clone", "--no-checkout", "--no-tags", "--", remote, destination]).pipe(
              Effect.asVoid,
            ),
          fetch: ({ ref, cwd }) =>
            git(cwd, ["fetch", "--no-tags", "--force", "--", remote, ref]).pipe(Effect.asVoid),
          resolveRef: ({ ref }) =>
            git(root, ["ls-remote", "--", remote, ref]).pipe(
              Effect.map((output) => output.split(/\s+/)[0] ?? ""),
            ),
          readBranch: () => Effect.succeed(remoteCommit),
          findPullRequest: () => Effect.succeed(pullRequest),
          push: ({ branch, cwd }) =>
            Effect.gen(function* () {
              yield* git(cwd, ["push", "--", remote, `HEAD:refs/heads/${branch}`]);
              remoteCommit = yield* git(cwd, ["rev-parse", "HEAD"]);
            }),
          createDraftPullRequest: () =>
            Effect.sync(() => {
              pullRequest = {
                number: 23,
                url: "https://github.com/example/private-repository/pull/23",
              };
              return pullRequest;
            }),
          closePullRequest: () =>
            Effect.sync(() => {
              pullRequest = null;
            }),
          syncPrivateGitDependencies: () => Effect.void,
        });

        const recipe: CloudRepositoryRecipe = {
          version: 1,
          repository: "example/private-repository",
          outputBranchPrefix: "cloud",
          setup: [
            {
              name: "setup",
              command: process.execPath,
              args: ["-e", "require('node:fs').writeFileSync('setup.ok','ready\\n')"],
              timeoutSeconds: 30,
            },
          ],
          devServers: [
            {
              name: "app",
              port: 5173,
              command: {
                name: "serve",
                command: process.execPath,
                args: ["server.mjs"],
                timeoutSeconds: 300,
              },
            },
          ],
          verification: [
            {
              name: "focused-check",
              command: process.execPath,
              args: [
                "-e",
                "const fs=require('node:fs');if(fs.readFileSync('app.txt','utf8')!=='after\\n')process.exit(2);console.log('passed')",
              ],
              timeoutSeconds: 30,
            },
          ],
          secretReferences: [],
        };
        const preparationService = yield* CloudRepositoryPreparation.make({
          workspaceRoot,
          startupTimingsPath,
          dependencyCache: {
            root: cacheRoot,
            maxEntries: 8,
            maxBytes: 1024 * 1024,
            runtime: {
              imageVersion: "qualification-image",
              os: "linux",
              arch: "x64",
              nodeVersion: process.version,
            },
          },
        }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.provideService(CloudGitCredentials.CloudGitCredentials, credentials),
        );
        const preparation = yield* preparationService.prepare({
          allocationId: ALLOCATION_ID,
          attempt: ATTEMPT,
          selectedRef: "main",
          deadline: DEADLINE,
          recipe,
        });
        expect(preparation.resolvedCommit).toBe(baseCommit);
        expect(preparation.dependencyCache?.outcome).toBe("miss");
        expect(preparation.timings?.workerStartup?.imageBoot.durationMs).toBe(12_000);

        // No client participates after admission. The worker-owned task changes its checkout.
        yield* fs.writeFileString(path.join(preparation.workspacePath, "app.txt"), "after\n");
        const verification = yield* preparationService.verify({ preparation, deadline: DEADLINE });
        expect(verification.results).toMatchObject([
          { name: "focused-check", exitCode: 0, timedOut: false },
        ]);

        const allocation: RunAllocation = {
          id: ALLOCATION_ID,
          attempt: ATTEMPT,
          target: {
            repository: recipe.repository,
            baseCommit,
            branch: preparation.outputBranch,
          },
          publication: {
            mode: "automatic-draft-pr",
            baseBranch: "main",
            title: "feat: qualify the cloud release",
            body: "Release qualification result.",
          },
          execution: {
            threadId: THREAD_ID,
            title: "Release qualification",
            selectedRef: "main",
            unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds.make(900),
            turn: {
              commandId: CommandId.make("release-qualification-turn"),
              messageId: MessageId.make("release-qualification-message"),
              prompt: "Change app.txt and run the focused check.",
              attachments: [],
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-sol",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: NOW,
            },
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
            instanceId: "i-release-qualification",
            references: {
              workerId: RunWorkerId.make("worker-release-qualification"),
              environmentId: ENVIRONMENT_ID,
              threadId: THREAD_ID,
            },
            readyAt: NOW,
          },
          agentOutcome: {
            status: "succeeded",
            resultLocation: { uri: "pending-retention" },
            completedAt: NOW,
          },
          previewState: { status: "unavailable" },
          leases: emptyCloudSessionLeases(),
          attemptPurpose: "run",
          idleState: { status: "busy" },
          cleanupState: { status: "requested", requestedAt: NOW },
          handledCommandIds: [],
          sequence: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        const execution = CloudProviderExecution.CloudProviderExecution.of({
          start: () => Effect.die("continuation should not start during qualification"),
          followUp: () => Effect.die("follow-up should not run during qualification"),
          interrupt: () => Effect.die("interrupt should not run during qualification"),
          approve: () => Effect.die("approval should not run during qualification"),
          answer: () => Effect.die("answer should not run during qualification"),
        });
        const results = yield* CloudRunResults.make({
          resultsRoot: path.join(root, "retained"),
          readTranscript: () => Effect.succeed(transcript()),
          readAllocation: () => Effect.succeed(allocation),
        }).pipe(Effect.provideService(CloudProviderExecution.CloudProviderExecution, execution));
        const result = yield* results.capture({
          preparation,
          verification,
          sourceEnvironmentId: ENVIRONMENT_ID,
          sourceThreadId: THREAD_ID,
          hardDeadline: DEADLINE,
          artifacts: [],
        });
        expect((yield* results.status(result.resultId)).status).toBe("retained");
        expect(yield* results.readText(result.resultId, "diff")).toContain("+after");

        const publication = yield* CloudRunPublication.make({
          publicationRoot: path.join(root, "publications"),
          readAllocation: () => Effect.succeed(allocation),
        }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.provideService(CloudGitCredentials.CloudGitCredentials, credentials),
        );
        const published = yield* publication.finalize({ preparation, verification, result });
        expect(published.outcome).toMatchObject({
          status: "published",
          pullRequestNumber: 23,
          pullRequestUrl: "https://github.com/example/private-repository/pull/23",
        });
        expect(published.savedDiffPath).toBe(result.diffDownloadPath);
        expect(remoteCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(yield* git(root, ["--git-dir", remote, "rev-parse", preparation.outputBranch])).toBe(
          remoteCommit,
        );
      }).pipe(TestClock.withLive),
  );
});
