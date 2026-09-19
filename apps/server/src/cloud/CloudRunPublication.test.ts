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
        repository: "Atheal9k/cloud-agents",
        baseCommit,
        branch: outputBranch,
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
      push: () =>
        Effect.gen(function* () {
          calls.push("push");
          state.pushCount += 1;
          state.remoteCommit = yield* git(["rev-parse", "HEAD"]);
        }),
      createDraftPullRequest: () =>
        Effect.gen(function* () {
          calls.push("create-pr");
          state.createCount += 1;
          const pullRequest = {
            number: 42,
            url: "https://github.com/Atheal9k/cloud-agents/pull/42",
          };
          state.pullRequest = pullRequest;
          if (options?.losePrCreationResponse === true) {
            return yield* credentialError("github-failed");
          }
          return pullRequest;
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

    return { fs, git, path, workspace, request, publicationService, calls, state };
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
      expect(calls).toEqual(["read-branch", "find-pr", "push", "create-pr"]);
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
        "push",
        "create-pr",
        "read-branch",
        "find-pr",
      ]);
    }),
  );
});
