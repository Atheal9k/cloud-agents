import * as NodeCrypto from "node:crypto";

import {
  type CloudCommitProvenance,
  CloudRunPublicationError,
  CloudRunPublicationRecord,
  CloudResultManifest,
  type CloudRunPublicationInput,
  type CloudRepositoryVerificationRecord,
  type CloudRunPublicationOutcome,
  type RunAllocation,
  type RunAllocationAttempt,
  type RunAllocationId,
  cloudWorkspaceRepositorySegment,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudCommitSigner from "./CloudCommitSigner.ts";
import * as CloudGitCredentials from "./CloudGitCredentials.ts";
import {
  CLOUD_COMMIT_SIGNING_SERVICE_IDENTITY,
  cloudCommitMessageWithProvenance,
  cloudPullRequestBodyWithProvenance,
  collectCloudCommitProvenance,
  decideCloudCommitSigning,
} from "./cloudCommitSigningPolicy.ts";

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudRunPublicationRecord));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudResultManifest));

export class CloudRunPublication extends Context.Service<
  CloudRunPublication,
  {
    readonly finalize: (
      input: CloudRunPublicationInput,
    ) => Effect.Effect<CloudRunPublicationRecord, CloudRunPublicationError>;
    readonly status: (
      allocationId: RunAllocationId,
      attempt: RunAllocationAttempt,
    ) => Effect.Effect<CloudRunPublicationRecord, CloudRunPublicationError>;
    readonly deletePullRequest: (
      allocationId: RunAllocationId,
      attempt: RunAllocationAttempt,
    ) => Effect.Effect<CloudRunPublicationRecord, CloudRunPublicationError>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<CloudRunPublicationRecord>,
      CloudRunPublicationError
    >;
  }
>()("t3/cloud/CloudRunPublication") {}

interface CloudRunPublicationMakeInput {
  readonly publicationRoot: string;
  readonly resultsRoot?: string;
  readonly readAllocation: (
    allocationId: RunAllocationId,
  ) => Effect.Effect<RunAllocation | undefined, CloudRunPublicationError>;
}

function publicationError(input: {
  readonly reason: CloudRunPublicationError["reason"];
  readonly message: string;
  readonly retryable: boolean;
}): CloudRunPublicationError {
  return new CloudRunPublicationError(input);
}

function verificationPassed(verification: CloudRepositoryVerificationRecord): boolean {
  return verification.results.every((result) => result.exitCode === 0 && !result.timedOut);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const make = Effect.fn("CloudRunPublication.make")(function* (
  input: CloudRunPublicationMakeInput,
) {
  const credentials = yield* CloudGitCredentials.CloudGitCredentials;
  const signer = yield* CloudCommitSigner.CloudCommitSigner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const mutex = yield* Semaphore.make(1);

  const recordPath = (allocationId: RunAllocationId, attempt: RunAllocationAttempt) =>
    path.join(
      input.publicationRoot,
      `${NodeCrypto.createHash("sha256").update(`${allocationId}:${attempt}`).digest("hex")}.json`,
    );

  const writeRecord = Effect.fn("CloudRunPublication.writeRecord")(function* (
    record: CloudRunPublicationRecord,
  ) {
    yield* writeFileStringAtomically({
      filePath: recordPath(record.allocationId, record.attempt),
      contents: json(record),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() =>
        publicationError({
          reason: "persistence-failed",
          message: "The controller could not persist the publication result.",
          retryable: true,
        }),
      ),
    );
    return record;
  });

  const readRecord = Effect.fn("CloudRunPublication.readRecord")(function* (
    allocationId: RunAllocationId,
    attempt: RunAllocationAttempt,
  ) {
    const file = recordPath(allocationId, attempt);
    const exists = yield* fs.exists(file).pipe(
      Effect.mapError(() =>
        publicationError({
          reason: "persistence-failed",
          message: "The controller could not inspect the publication result.",
          retryable: true,
        }),
      ),
    );
    if (!exists) {
      return yield* publicationError({
        reason: "publication-not-found",
        message: "This cloud run has no publication result.",
        retryable: false,
      });
    }
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeRecord),
      Effect.mapError(() =>
        publicationError({
          reason: "persistence-failed",
          message: "The persisted publication result is invalid.",
          retryable: false,
        }),
      ),
    );
  });

  const findRecord = (allocationId: RunAllocationId, attempt: RunAllocationAttempt) =>
    readRecord(allocationId, attempt).pipe(
      Effect.asSome,
      Effect.catchTag("CloudRunPublicationError", (error) =>
        error.reason === "publication-not-found" ? Effect.succeedNone : Effect.fail(error),
      ),
    );

  const git = Effect.fn("CloudRunPublication.git")(function* (request: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
  }) {
    return yield* runner
      .run({
        command: "git",
        args: request.args,
        cwd: request.cwd,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        timeout: "2 minutes",
        maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError(() =>
          publicationError({
            reason: "invalid-workspace",
            message: "The controller could not start trusted Git finalization.",
            retryable: true,
          }),
        ),
      );
  });

  const gitOutput = Effect.fn("CloudRunPublication.gitOutput")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    message: string,
  ) {
    const result = yield* git({ cwd, args });
    if (result.code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* publicationError({
        reason: "invalid-workspace",
        message,
        retryable: false,
      });
    }
    return result.stdout.trim();
  });

  const validateInput = Effect.fn("CloudRunPublication.validateInput")(function* (
    request: CloudRunPublicationInput,
  ) {
    const { preparation, result, verification } = request;
    const allocation = yield* input.readAllocation(preparation.allocationId);
    if (allocation === undefined) {
      return yield* publicationError({
        reason: "allocation-not-found",
        message: "The publication run does not exist in the controller catalog.",
        retryable: false,
      });
    }
    if (allocation.attempt !== preparation.attempt) {
      return yield* publicationError({
        reason: "stale-attempt",
        message: "Publication cannot use a stale worker attempt.",
        retryable: false,
      });
    }
    const recordsMatch =
      verification.allocationId === allocation.id &&
      verification.attempt === allocation.attempt &&
      result.allocationId === allocation.id &&
      result.attempt === allocation.attempt &&
      result.baseCommit === preparation.resolvedCommit &&
      result.outputBranch === preparation.outputBranch;
    const scratch = allocation.target.workspaceKind === "scratch";
    const intentMatches =
      scratch ||
      (allocation.target.repository === preparation.repository &&
        allocation.target.baseCommit === preparation.resolvedCommit &&
        allocation.target.branch === preparation.outputBranch);
    if (!recordsMatch || !intentMatches) {
      return yield* publicationError({
        reason: "recorded-intent-mismatch",
        message:
          "The repository, base commit, branch, verification, and retained result must match the recorded launch intent.",
        retryable: false,
      });
    }
    return allocation;
  });

  const persistProvenance = Effect.fn("CloudRunPublication.persistProvenance")(function* (
    resultId: CloudRunPublicationRecord["resultId"],
    provenance: CloudCommitProvenance,
  ) {
    yield* writeFileStringAtomically({
      filePath: path.join(input.publicationRoot, `${resultId}.provenance.json`),
      contents: json(provenance),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.ignore,
    );
    if (input.resultsRoot === undefined) return;
    const manifestPath = path.join(input.resultsRoot, resultId, "result", "manifest.json");
    const exists = yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return;
    const contents = yield* fs.readFileString(manifestPath).pipe(Effect.option);
    if (Option.isNone(contents)) return;
    const parsed = yield* decodeManifest(contents.value).pipe(Effect.option);
    if (Option.isNone(parsed)) return;
    yield* writeFileStringAtomically({
      filePath: manifestPath,
      contents: json({ ...parsed.value, provenance }),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.ignore,
    );
  });

  const prepareCommit = Effect.fn("CloudRunPublication.prepareCommit")(function* (input: {
    readonly workspacePath: string;
    readonly branch: string;
    readonly baseCommit: string;
    readonly commitMessage: string;
    readonly repository: string;
    readonly allocation: RunAllocation;
    readonly existing?: CloudRunPublicationRecord;
  }) {
    const workspace = yield* fs.realPath(input.workspacePath).pipe(
      Effect.mapError(() =>
        publicationError({
          reason: "invalid-workspace",
          message: "The prepared publication workspace does not exist.",
          retryable: false,
        }),
      ),
    );
    const rootOutput = yield* gitOutput(
      workspace,
      ["rev-parse", "--show-toplevel"],
      "The prepared publication workspace is not a Git repository.",
    );
    const root = yield* fs.realPath(rootOutput).pipe(
      Effect.mapError(() =>
        publicationError({
          reason: "invalid-workspace",
          message: "The publication repository root is unavailable.",
          retryable: false,
        }),
      ),
    );
    if (path.resolve(root) !== path.resolve(workspace)) {
      return yield* publicationError({
        reason: "invalid-workspace",
        message: "Publication must run at the root of the prepared repository.",
        retryable: false,
      });
    }
    const branch = yield* gitOutput(
      workspace,
      ["branch", "--show-current"],
      "The prepared publication branch could not be read.",
    );
    if (branch !== input.branch) {
      return yield* publicationError({
        reason: "recorded-intent-mismatch",
        message: "The workspace branch does not match the recorded publication branch.",
        retryable: false,
      });
    }
    const resolvedBase = yield* gitOutput(
      workspace,
      ["rev-parse", "--verify", `${input.baseCommit}^{commit}`],
      "The recorded publication base commit is not present in the workspace.",
    );
    if (resolvedBase !== input.baseCommit) {
      return yield* publicationError({
        reason: "recorded-intent-mismatch",
        message: "The workspace resolved a different publication base commit.",
        retryable: false,
      });
    }
    const ancestry = yield* git({
      cwd: workspace,
      args: ["merge-base", "--is-ancestor", input.baseCommit, "HEAD"],
    });
    if (ancestry.code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* publicationError({
        reason: "recorded-intent-mismatch",
        message: "The publication branch diverged from its recorded base commit.",
        retryable: false,
      });
    }

    const [status, diff] = yield* Effect.all([
      git({ cwd: workspace, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"] }),
      git({ cwd: workspace, args: ["diff", "--quiet", input.baseCommit, "--", "."] }),
    ]);
    if (status.code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* publicationError({
        reason: "invalid-workspace",
        message: "The controller could not inspect the publication workspace.",
        retryable: true,
      });
    }
    if (
      diff.code !== ChildProcessSpawner.ExitCode(0) &&
      diff.code !== ChildProcessSpawner.ExitCode(1)
    ) {
      return yield* publicationError({
        reason: "invalid-workspace",
        message: "The controller could not compare the publication workspace with its base commit.",
        retryable: true,
      });
    }
    if (status.stdout.length === 0 && diff.code === ChildProcessSpawner.ExitCode(0)) return null;

    const provenance = collectCloudCommitProvenance({
      allocation: input.allocation,
      repository: input.repository,
    });
    const available = yield* signer.available;
    const currentKeyId = yield* signer.keyId.pipe(
      Effect.orElseSucceed(() => "unavailable"),
    );
    const head = yield* gitOutput(
      workspace,
      ["rev-parse", "HEAD"],
      "The publication commit could not be read.",
    );
    const existingCommit =
      input.existing?.provenance?.commit ??
      (input.existing?.outcome !== undefined && "commit" in input.existing.outcome
        ? input.existing.outcome.commit
        : undefined);
    const decision = decideCloudCommitSigning({
      remoteCommit: null,
      localCommit: head,
      published: input.existing?.outcome.status === "published",
      ...(existingCommit === undefined ? {} : { existingSignedCommit: existingCommit }),
      ...(input.existing?.provenance?.signature?.keyId === undefined
        ? {}
        : { existingKeyId: input.existing.provenance.signature.keyId }),
      currentKeyId,
      signerAvailable: available,
    });
    if (decision.action === "retry-outage") {
      return yield* publicationError({
        reason: "invalid-workspace",
        message: decision.message,
        retryable: true,
      });
    }
    if (decision.action === "reuse") {
      return { commit: decision.commit, provenance: { ...provenance, commit: decision.commit } };
    }

    const signed = yield* signer
      .signCommit({
        caller: {
          kind: "trusted-publication",
          repository: input.repository,
          identity: CLOUD_COMMIT_SIGNING_SERVICE_IDENTITY,
        },
        allowedRepository: input.repository,
        cwd: workspace,
        baseCommit: input.baseCommit,
        message: cloudCommitMessageWithProvenance(input.commitMessage, provenance),
        provenance,
      })
      .pipe(Effect.result);
    if (Result.isFailure(signed)) {
      return yield* publicationError({
        reason: "invalid-workspace",
        message: signed.failure.message,
        retryable: signed.failure.retryable,
      });
    }
    if (signed.success === null) return null;
    return {
      commit: signed.success.commit,
      provenance: {
        ...provenance,
        commit: signed.success.commit,
        signature: signed.success.signature,
      },
    };
  });

  const finalizeUnlocked = Effect.fn("CloudRunPublication.finalizeUnlocked")(function* (
    request: CloudRunPublicationInput,
  ) {
    const allocation = yield* validateInput(request);
    const existing = yield* findRecord(allocation.id, allocation.attempt);
    if (Option.isSome(existing) && existing.value.outcome.status === "published") {
      return existing.value;
    }
    const common = {
      allocationId: allocation.id,
      attempt: allocation.attempt,
      repository: allocation.target.repository,
      baseCommit: allocation.target.baseCommit,
      outputBranch: allocation.target.branch,
      intent: allocation.publication,
      verification: request.verification,
      resultId: request.result.resultId,
      savedDiffPath: request.result.diffDownloadPath,
    };
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    if (allocation.target.workspaceKind === "scratch") {
      if (allocation.target.scratchDraft !== undefined) {
        yield* credentials
          .createDraftRepository({
            runId: `${allocation.id}:${allocation.attempt}`,
            name: allocation.target.scratchDraft.name,
            visibility: allocation.target.scratchDraft.visibility,
          })
          .pipe(Effect.ignore);
      }
      return yield* writeRecord({
        ...common,
        outcome: { status: "review-only", completedAt },
      });
    }
    if (allocation.publication.mode === "review-only") {
      return yield* writeRecord({
        ...common,
        outcome: { status: "review-only", completedAt },
      });
    }
    if (!verificationPassed(request.verification)) {
      return yield* writeRecord({
        ...common,
        outcome: { status: "verification-failed", completedAt },
      });
    }
    const additionalPublications: Array<{
      readonly repository: string;
      readonly outcome: CloudRunPublicationOutcome;
      readonly provenance?: CloudCommitProvenance;
    }> = [];
    if (
      allocation.publication.mode === "automatic-draft-pr" &&
      (allocation.target.additionalRepositories ?? []).length > 0
    ) {
      const runId = `${allocation.id}:${allocation.attempt}`;
      for (const extra of allocation.target.additionalRepositories ?? []) {
        const sibling = path.join(
          path.dirname(request.preparation.workspacePath),
          cloudWorkspaceRepositorySegment(extra.repository),
        );
        const exists = yield* fs.exists(sibling).pipe(Effect.orElseSucceed(() => false));
        if (!exists) continue;
        const extraPrepared = yield* prepareCommit({
          workspacePath: sibling,
          branch: extra.branch,
          baseCommit: extra.baseCommit,
          commitMessage: allocation.publication.title,
          repository: extra.repository,
          allocation,
          ...(Option.isSome(existing) ? { existing: existing.value } : {}),
        });
        if (extraPrepared === null) continue;
        const extraBody =
          allocation.publication.mode === "automatic-draft-pr"
            ? cloudPullRequestBodyWithProvenance(
                allocation.publication.body,
                extraPrepared.provenance,
              )
            : "";
        const pushed = yield* credentials
          .push({
            runId,
            repository: extra.repository,
            branch: extra.branch,
            cwd: sibling,
          })
          .pipe(Effect.result);
        if (Result.isFailure(pushed)) {
          additionalPublications.push({
            repository: extra.repository,
            provenance: extraPrepared.provenance,
            outcome: {
              status: pushed.failure.reason === "push-rejected" ? "push-rejected" : "push-failed",
              commit: extraPrepared.commit,
              message: pushed.failure.message,
              failedAt: completedAt,
            },
          });
          continue;
        }
        const created = yield* credentials
          .createDraftPullRequest({
            runId,
            repository: extra.repository,
            base: allocation.publication.baseBranch,
            head: extra.branch,
            title: allocation.publication.title,
            body: extraBody,
            ...(allocation.publication.skipReviewerRequest === true
              ? { skipReviewerRequest: true }
              : {}),
          })
          .pipe(Effect.result);
        additionalPublications.push({
          repository: extra.repository,
          provenance: extraPrepared.provenance,
          outcome: Result.isFailure(created)
            ? {
                status: "pr-creation-failed",
                commit: extraPrepared.commit,
                message: created.failure.message,
                failedAt: completedAt,
              }
            : {
                status: "published",
                commit: extraPrepared.commit,
                pullRequestNumber: created.success.number,
                pullRequestUrl: created.success.url,
                publishedAt: completedAt,
              },
        });
      }
    }
    const recorded = {
      ...common,
      ...(additionalPublications.length === 0 ? {} : { publications: additionalPublications }),
    };
    const prepared = yield* prepareCommit({
      workspacePath: request.preparation.workspacePath,
      branch: allocation.target.branch,
      baseCommit: allocation.target.baseCommit,
      commitMessage:
        allocation.publication.mode === "automatic-draft-pr"
          ? allocation.publication.title
          : "Cloud run changes",
      repository: allocation.target.repository,
      allocation,
      ...(Option.isSome(existing) ? { existing: existing.value } : {}),
    });
    if (prepared === null) {
      return yield* writeRecord({
        ...recorded,
        outcome: { status: "empty-change", completedAt },
      });
    }
    const { commit, provenance } = prepared;
    const recordedWithProvenance = { ...recorded, provenance };

    const runId = `${allocation.id}:${allocation.attempt}`;
    yield* writeRecord({
      ...recordedWithProvenance,
      outcome: { status: "publishing", commit, startedAt: completedAt },
    });

    const remoteResult = yield* credentials
      .readBranch({
        runId,
        repository: allocation.target.repository,
        branch: allocation.target.branch,
      })
      .pipe(Effect.result);
    if (Result.isFailure(remoteResult)) {
      return yield* writeRecord({
        ...recordedWithProvenance,
        outcome: {
          status: "push-failed",
          commit,
          message: remoteResult.failure.message,
          failedAt: DateTime.formatIso(yield* DateTime.now),
        },
      });
    }
    const pullRequestResult = yield* credentials
      .findPullRequest({
        runId,
        repository: allocation.target.repository,
        base: allocation.publication.baseBranch,
        head: allocation.target.branch,
      })
      .pipe(Effect.result);
    if (Result.isFailure(pullRequestResult)) {
      return yield* writeRecord({
        ...recordedWithProvenance,
        outcome: {
          status: "pr-creation-failed",
          commit,
          message: pullRequestResult.failure.message,
          failedAt: DateTime.formatIso(yield* DateTime.now),
        },
      });
    }
    const remoteCommit = remoteResult.success;
    const pullRequest = pullRequestResult.success;
    if (remoteCommit !== null && remoteCommit !== commit) {
      return yield* writeRecord({
        ...recordedWithProvenance,
        outcome: {
          status: "push-rejected",
          commit,
          remoteCommit,
          message:
            "The remote publication branch contains a different commit. The controller will not force push it.",
          failedAt: DateTime.formatIso(yield* DateTime.now),
        },
      });
    }
    const finishPublished = Effect.fn("CloudRunPublication.finishPublished")(function* (
      number: number,
      url: string,
    ) {
      const saved = yield* writeRecord({
        ...recordedWithProvenance,
        outcome: {
          status: "published",
          commit,
          pullRequestNumber: number,
          pullRequestUrl: url,
          publishedAt: DateTime.formatIso(yield* DateTime.now),
        },
      });
      yield* persistProvenance(saved.resultId, provenance);
      return saved;
    });
    if (pullRequest !== null && remoteCommit === commit) {
      return yield* finishPublished(pullRequest.number, pullRequest.url);
    }
    if (remoteCommit === null) {
      const pushed = yield* credentials
        .push({
          runId,
          repository: allocation.target.repository,
          branch: allocation.target.branch,
          cwd: request.preparation.workspacePath,
        })
        .pipe(Effect.result);
      if (Result.isFailure(pushed)) {
        const rejected = pushed.failure.reason === "push-rejected";
        return yield* writeRecord({
          ...recordedWithProvenance,
          outcome: {
            status: rejected ? "push-rejected" : "push-failed",
            commit,
            message: pushed.failure.message,
            failedAt: DateTime.formatIso(yield* DateTime.now),
          },
        });
      }
      if (pullRequest !== null) {
        return yield* finishPublished(pullRequest.number, pullRequest.url);
      }
    }

    const prBody = cloudPullRequestBodyWithProvenance(allocation.publication.body, provenance);
    const created = yield* credentials
      .createDraftPullRequest({
        runId,
        repository: allocation.target.repository,
        base: allocation.publication.baseBranch,
        head: allocation.target.branch,
        title: allocation.publication.title,
        body: prBody,
        ...(allocation.publication.skipReviewerRequest === true
          ? { skipReviewerRequest: true }
          : {}),
      })
      .pipe(Effect.result);
    if (Result.isFailure(created)) {
      return yield* writeRecord({
        ...recordedWithProvenance,
        outcome: {
          status: "pr-creation-failed",
          commit,
          message: created.failure.message,
          failedAt: DateTime.formatIso(yield* DateTime.now),
        },
      });
    }
    return yield* finishPublished(created.success.number, created.success.url);
  });

  const finalize: CloudRunPublication["Service"]["finalize"] = (request) =>
    mutex.withPermits(1)(finalizeUnlocked(request));
  const status: CloudRunPublication["Service"]["status"] = (allocationId, attempt) =>
    mutex.withPermits(1)(readRecord(allocationId, attempt));
  const deletePullRequest: CloudRunPublication["Service"]["deletePullRequest"] = (
    allocationId,
    attempt,
  ) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* readRecord(allocationId, attempt);
        if (record.outcome.status === "pr-deleted") return record;
        if (record.outcome.status !== "published") {
          return yield* publicationError({
            reason: "pr-not-published",
            message: "This cloud run has no published pull request to delete.",
            retryable: false,
          });
        }
        const closed = yield* credentials
          .closePullRequest({
            runId: `${record.allocationId}:${record.attempt}`,
            repository: record.repository,
            number: record.outcome.pullRequestNumber,
          })
          .pipe(Effect.result);
        if (Result.isFailure(closed)) {
          return yield* publicationError({
            reason: "github-failed",
            message: closed.failure.message,
            retryable: closed.failure.reason !== "permission-denied",
          });
        }
        return yield* writeRecord({
          ...record,
          outcome: {
            status: "pr-deleted",
            commit: record.outcome.commit,
            pullRequestNumber: record.outcome.pullRequestNumber,
            deletedAt: DateTime.formatIso(yield* DateTime.now),
          },
        });
      }),
    );

  yield* fs.makeDirectory(input.publicationRoot, { recursive: true });
  const list: CloudRunPublication["Service"]["list"] = () =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const entries = yield* fs.readDirectory(input.publicationRoot).pipe(
          Effect.mapError(() =>
            publicationError({
              reason: "persistence-failed",
              message: "The controller could not list publication results.",
              retryable: true,
            }),
          ),
        );
        const records: Array<CloudRunPublicationRecord> = [];
        for (const entry of entries) {
          if (!entry.endsWith(".json")) continue;
          const contents = yield* fs.readFileString(path.join(input.publicationRoot, entry)).pipe(
            Effect.flatMap(decodeRecord),
            Effect.option,
          );
          if (Option.isSome(contents)) records.push(contents.value);
        }
        return records;
      }),
    );
  return CloudRunPublication.of({ finalize, status, deletePullRequest, list });
});

export const layer = Layer.effect(
  CloudRunPublication,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const allocations = yield* CloudAllocationController.CloudAllocationController;
    return yield* make({
      publicationRoot: path.join(config.stateDir, "cloud-publications"),
      resultsRoot: path.join(config.stateDir, "cloud-results"),
      readAllocation: (allocationId) =>
        allocations.snapshot.pipe(
          Effect.map((snapshot) =>
            snapshot.allocations.find((allocation) => allocation.id === allocationId),
          ),
          Effect.mapError(() =>
            publicationError({
              reason: "persistence-failed",
              message: "The controller could not read the publication launch intent.",
              retryable: true,
            }),
          ),
        ),
    });
  }),
);
