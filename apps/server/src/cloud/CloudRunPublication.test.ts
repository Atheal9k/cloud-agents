import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CloudRunPublicationInput,
  RunAllocation,
  emptyCloudSessionLeases,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as CloudGitCredentials from "./CloudGitCredentials.ts";
import { make } from "./CloudRunPublication.ts";

const NOW = "2026-09-17T05:00:00.000Z";
const RESULT_ID = "1".repeat(64);
const decodeAllocation = Schema.decodeSync(RunAllocation);
const decodeInput = Schema.decodeSync(CloudRunPublicationInput);

function credentialError(reason: CloudGitCredentials.CloudGitCredentialError["reason"]) {
  return new CloudGitCredentials.CloudGitCredentialError({
    reason,
    message: `credential ${reason}`,
  });
}

it.layer(NodeServices.layer)("CloudRunPublication", (it) => {
  const fixture = Effect.fn("CloudRunPublication.test.fixture")(function* (options?: {
    readonly publication?: "review-only" | "automatic-draft-pr";
    readonly verificationFailed?: boolean;
    readonly remoteCommit?: string | null;
    readonly losePrCreationResponse?: boolean;
    readonly workspaceKind?: "scratch";
    readonly scratchDraft?: { readonly name: string; readonly visibility: "private" | "internal" };
    readonly extraRepository?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.make();
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-publication-" });
    const workspace = path.join(root, "workspace");
    const outputBranch = "cloud/run/publication-1";
    const calls: string[] = [];
    const state: {
      remoteCommit: string | null;
      pullRequest: CloudGitCredentials.CloudGitPullRequest | null;
      pushCount: number;
      createCount: number;
    } = {
      remoteCommit: options?.remoteCommit ?? null,
      pullRequest: null,
      pushCount: 0,
      createCount: 0,
    };

    const git = Effect.fn("CloudRunPublication.test.git")(function* (args: ReadonlyArray<string>) {
      const result = yield* runner.run({ command: "git", args, cwd: workspace }).pipe(Effect.orDie);
      expect(result.code).toBe(ChildProcessSpawner.ExitCode(0));
      return result.stdout.trim();
    });

    yield* fs.makeDirectory(workspace, { recursive: true });
    yield* git(["init", "--initial-branch=main"]);
    yield* git(["config", "user.name", "Publication Test"]);
    yield* git(["config", "user.email", "publication@example.test"]);
    yield* fs.writeFileString(path.join(workspace, "tracked.txt"), "base\n");
    yield* git(["add", "tracked.txt"]);
    yield* git(["commit", "-m", "base"]);
    const baseCommit = yield* git(["rev-parse", "HEAD"]);
    yield* git(["switch", "-c", outputBranch]);

    let additionalRepositories:
      | Array<{ repository: string; baseCommit: string; branch: string }>
      | undefined;
    if (options?.extraRepository === true) {
      const extraDir = path.join(root, "acme-api");
      yield* fs.makeDirectory(extraDir, { recursive: true });
      const extraGit = Effect.fn("CloudRunPublication.test.extraGit")(function* (
        args: ReadonlyArray<string>,
      ) {
        const result = yield* runner
          .run({ command: "git", args, cwd: extraDir })
          .pipe(Effect.orDie);
        expect(result.code).toBe(ChildProcessSpawner.ExitCode(0));
        return result.stdout.trim();
      });
      yield* extraGit(["init", "--initial-branch=main"]);
      yield* extraGit(["config", "user.name", "Publication Extra"]);
      yield* extraGit(["config", "user.email", "publication-extra@example.test"]);
      yield* fs.writeFileString(path.join(extraDir, "api.txt"), "base\n");
      yield* extraGit(["add", "api.txt"]);
      yield* extraGit(["commit", "-m", "base"]);
      const extraBase = yield* extraGit(["rev-parse", "HEAD"]);
      yield* extraGit(["switch", "-c", outputBranch]);
      yield* fs.writeFileString(path.join(extraDir, "api.txt"), "changed\n");
      additionalRepositories = [
        { repository: "acme/api", baseCommit: extraBase, branch: outputBranch },
      ];
    }

    const publication =
      options?.publication === "review-only"
        ? ({ mode: "review-only" } as const)
        : ({
            mode: "automatic-draft-pr",
            baseBranch: "main",
            title: "feat(cloud): publish retained work",
            body: "Controller-owned publication.",
          } as const);
    const allocation = decodeAllocation({
      id: "allocation-publication-1",
      attempt: 1,
      target: {
        repository:
          options?.workspaceKind === "scratch" ? "scratch/workspace" : "Atheal9k/cloud-agents",
        baseCommit,
        branch: outputBranch,
        ...(options?.workspaceKind === undefined ? {} : { workspaceKind: options.workspaceKind }),
        ...(options?.scratchDraft === undefined ? {} : { scratchDraft: options.scratchDraft }),
        ...(additionalRepositories === undefined ? {} : { additionalRepositories }),
      },
      publication,
      profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
      deadlines: {
        launchBy: NOW,
        bootBy: NOW,
        registerBy: NOW,
        expiresAt: "2026-09-17T07:00:00.000Z",
        cleanupBy: "2026-09-17T07:05:00.000Z",
      },
      allocationState: { status: "queued" },
      agentOutcome: { status: "not-started" },
      previewState: { status: "unavailable" },
      leases: emptyCloudSessionLeases(),
      attemptPurpose: "run",
      idleState: { status: "busy" },
      cleanupState: { status: "not-requested" },
      handledCommandIds: [],
      sequence: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const request = decodeInput({
      preparation: {
        allocationId: allocation.id,
        attempt: allocation.attempt,
        repository: allocation.target.repository,
        selectedRef: "main",
        resolvedCommit: baseCommit,
        outputBranch,
        workspacePath: workspace,
        instructionFiles: ["AGENTS.md"],
        setupResults: [],
        devServers: [],
        verification: [],
        permittedSecretReferences: [],
        preparedAt: NOW,
      },
      verification: {
        allocationId: allocation.id,
        attempt: allocation.attempt,
        results: [
          {
            name: "focused-test",
            command: "vp",
            args: ["test", "run", "focused.test.ts"],
            startedAt: NOW,
            completedAt: NOW,
            exitCode: options?.verificationFailed === true ? 1 : 0,
            timedOut: false,
            stdout: options?.verificationFailed === true ? "" : "passed\n",
            stderr: options?.verificationFailed === true ? "failed\n" : "",
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        ],
        completedAt: NOW,
      },
      result: {
        version: 1,
        resultId: RESULT_ID,
        allocationId: allocation.id,
        attempt: allocation.attempt,
        sourceEnvironmentId: "environment-publication-1",
        sourceThreadId: "thread-publication-1",
        baseCommit,
        outputBranch,
        checkpointRef: `refs/t3/cloud-results/${RESULT_ID}/workspace`,
        pagePath: `/cloud/results/${RESULT_ID}`,
        diffDownloadPath: `/api/cloud/results/${RESULT_ID}/downloads/diff`,
        transcriptDownloadPath: `/api/cloud/results/${RESULT_ID}/downloads/transcript`,
        verificationDownloadPath: `/api/cloud/results/${RESULT_ID}/downloads/verification`,
        workspaceDownloadPath: `/api/cloud/results/${RESULT_ID}/downloads/workspace`,
        artifacts: [],
        totalSizeBytes: 128,
        captureStartedAt: NOW,
        capturedAt: NOW,
        expiresAt: "2026-09-24T05:00:00.000Z",
      },
    });

    const credentials = CloudGitCredentials.CloudGitCredentials.of({
      clone: () => Effect.die("clone should not run during publication"),
      fetch: () => Effect.die("fetch should not run during publication"),
      resolveRef: () => Effect.die("ref resolution should not run during publication"),
      readBranch: () =>
        Effect.sync(() => {
          calls.push("read-branch");
          return state.remoteCommit;
        }),
      findPullRequest: () =>
        Effect.sync(() => {
          calls.push("find-pr");
          return state.pullRequest;
        }),
      push: (request) =>
        Effect.gen(function* () {
          calls.push(`push:${request.repository}`);
          state.pushCount += 1;
          if (request.repository === allocation.target.repository) {
            state.remoteCommit = yield* git(["rev-parse", "HEAD"]);
          }
        }),
      createDraftPullRequest: (request) =>
        Effect.gen(function* () {
          calls.push(`create-pr:${request.repository}`);
          state.createCount += 1;
          const pullRequest = {
            number: request.repository === "acme/api" ? 7 : 42,
            url: `https://github.com/${request.repository}/pull/${request.repository === "acme/api" ? 7 : 42}`,
          };
          if (request.repository !== "acme/api") {
            state.pullRequest = pullRequest;
          }
          if (options?.losePrCreationResponse === true && request.repository !== "acme/api") {
            return yield* credentialError("github-failed");
          }
          return pullRequest;
        }),
      createDraftRepository: (request) =>
        Effect.sync(() => {
          calls.push(`create-draft:${request.name}:${request.visibility}`);
          return {
            repository: `example/${request.name}`,
            url: `https://github.com/example/${request.name}`,
          };
        }),
      closePullRequest: () =>
        Effect.sync(() => {
          calls.push("close-pr");
          state.pullRequest = null;
        }),
      syncPrivateGitDependencies: () =>
        Effect.die("private git deps should not run during publication"),
    });
    const publicationService = yield* make({
      publicationRoot: path.join(root, "publications"),
      readAllocation: () => Effect.succeed(allocation),
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(CloudGitCredentials.CloudGitCredentials, credentials),
    );

    return { fs, git, path, runner, workspace, request, publicationService, calls, state };
  });

  it.effect("commits saved changes and publishes a draft PR from recorded intent", () =>
    Effect.gen(function* () {
      const { calls, fs, git, path, publicationService, request, workspace } = yield* fixture();
      yield* fs.writeFileString(path.join(workspace, "tracked.txt"), "published\n");

      const record = yield* publicationService.finalize(request);

      expect(record.outcome).toMatchObject({
        status: "published",
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/Atheal9k/cloud-agents/pull/42",
      });
      expect(record.savedDiffPath).toBe(request.result.diffDownloadPath);
      expect(record.verification).toEqual(request.verification);
      expect(calls).toEqual([
        "read-branch",
        "find-pr",
        "push:Atheal9k/cloud-agents",
        "create-pr:Atheal9k/cloud-agents",
      ]);
      expect(yield* git(["log", "-1", "--pretty=%s"])).toBe("feat(cloud): publish retained work");
      expect(
        yield* publicationService.status(
          request.preparation.allocationId,
          request.preparation.attempt,
        ),
      ).toEqual(record);
    }),
  );

  it.effect("closes a published pull request without rewriting the commit", () =>
    Effect.gen(function* () {
      const { calls, fs, git, path, publicationService, request, workspace } = yield* fixture();
      yield* fs.writeFileString(path.join(workspace, "tracked.txt"), "published\n");
      yield* publicationService.finalize(request);
      calls.length = 0;

      const deleted = yield* publicationService.deletePullRequest(
        request.preparation.allocationId,
        request.preparation.attempt,
      );

      expect(deleted.outcome.status).toBe("pr-deleted");
      expect(calls).toEqual(["close-pr"]);
      expect(yield* git(["log", "-1", "--pretty=%s"])).toBe("feat(cloud): publish retained work");
    }),
  );

  it.effect("records review-only, failed verification, and empty-change outcomes", () =>
    Effect.gen(function* () {
      const review = yield* fixture({ publication: "review-only" });
      expect((yield* review.publicationService.finalize(review.request)).outcome.status).toBe(
        "review-only",
      );
      expect(review.calls).toEqual([]);

      const failed = yield* fixture({ verificationFailed: true });
      yield* failed.fs.writeFileString(
        failed.path.join(failed.workspace, "tracked.txt"),
        "unverified\n",
      );
      expect((yield* failed.publicationService.finalize(failed.request)).outcome.status).toBe(
        "verification-failed",
      );
      expect(failed.calls).toEqual([]);

      const empty = yield* fixture();
      expect((yield* empty.publicationService.finalize(empty.request)).outcome.status).toBe(
        "empty-change",
      );
      expect(empty.calls).toEqual([]);
    }),
  );

  it.effect("rejects remote divergence without force pushing", () =>
    Effect.gen(function* () {
      const fixtureValue = yield* fixture({ remoteCommit: "b".repeat(40) });
      yield* fixtureValue.fs.writeFileString(
        fixtureValue.path.join(fixtureValue.workspace, "tracked.txt"),
        "diverged\n",
      );

      const record = yield* fixtureValue.publicationService.finalize(fixtureValue.request);

      expect(record.outcome).toMatchObject({
        status: "push-rejected",
        remoteCommit: "b".repeat(40),
      });
      expect(fixtureValue.state.pushCount).toBe(0);
      expect(fixtureValue.calls).toEqual(["read-branch", "find-pr"]);
    }),
  );

  it.effect("reconciles an existing branch and PR after a lost creation response", () =>
    Effect.gen(function* () {
      const fixtureValue = yield* fixture({ losePrCreationResponse: true });
      yield* fixtureValue.fs.writeFileString(
        fixtureValue.path.join(fixtureValue.workspace, "tracked.txt"),
        "retryable\n",
      );

      const first = yield* fixtureValue.publicationService.finalize(fixtureValue.request);
      expect(first.outcome.status).toBe("pr-creation-failed");

      const second = yield* fixtureValue.publicationService.finalize(fixtureValue.request);
      expect(second.outcome.status).toBe("published");
      expect(fixtureValue.state.pushCount).toBe(1);
      expect(fixtureValue.state.createCount).toBe(1);
      expect(fixtureValue.calls).toEqual([
        "read-branch",
        "find-pr",
        "push:Atheal9k/cloud-agents",
        "create-pr:Atheal9k/cloud-agents",
        "read-branch",
        "find-pr",
      ]);
    }),
  );

  it.effect("opens coordinated extra-repo PRs after committing sibling changes", () =>
    Effect.gen(function* () {
      const context = yield* fixture({ extraRepository: true });
      yield* context.fs.writeFileString(
        context.path.join(context.workspace, "tracked.txt"),
        "published\n",
      );

      const record = yield* context.publicationService.finalize(context.request);
      const extraLog = yield* context.runner
        .run({
          command: "git",
          args: ["log", "-1", "--pretty=%s"],
          cwd: context.path.join(context.path.dirname(context.workspace), "acme-api"),
        })
        .pipe(Effect.orDie);

      expect(record.outcome.status).toBe("published");
      expect(record.publications).toEqual([
        {
          repository: "acme/api",
          outcome: expect.objectContaining({
            status: "published",
            pullRequestNumber: 7,
            pullRequestUrl: "https://github.com/acme/api/pull/7",
          }),
        },
      ]);
      expect(context.calls).toEqual([
        "push:acme/api",
        "create-pr:acme/api",
        "read-branch",
        "find-pr",
        "push:Atheal9k/cloud-agents",
        "create-pr:Atheal9k/cloud-agents",
      ]);
      expect(extraLog.stdout.trim()).toBe("feat(cloud): publish retained work");
    }),
  );

  it.effect("creates a scratch draft repository and keeps publication review-only", () =>
    Effect.gen(function* () {
      const context = yield* fixture({
        workspaceKind: "scratch",
        scratchDraft: { name: "demo-app", visibility: "private" },
      });
      yield* context.fs.writeFileString(
        context.path.join(context.workspace, "tracked.txt"),
        "from scratch\n",
      );

      const record = yield* context.publicationService.finalize(context.request);

      expect(record.outcome.status).toBe("review-only");
      expect(context.calls).toEqual(["create-draft:demo-app:private"]);
      expect(record.publications).toBeUndefined();
    }),
  );
});
