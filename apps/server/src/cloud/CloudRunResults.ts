import * as NodeCrypto from "node:crypto";

import {
  CheckpointRef,
  CLOUD_RESULT_MAX_ARTIFACT_BYTES,
  CLOUD_RESULT_MAX_TOTAL_BYTES,
  CLOUD_RESULT_RETENTION_DAYS,
  CloudResultContinuationRecord,
  CloudResultError,
  CloudRepositoryPreparationRecord,
  type CloudResultArtifact,
  type CloudResultCaptureInput,
  type CloudResultContinuationInput,
  CloudResultManifest,
  CloudResultRetentionStatus,
  CloudRunResultId,
  type CloudCommitProvenance,
  type OrchestrationThreadDetailSnapshot,
  type RunAllocation,
  type RunAllocationId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import { projectThreadDetailSnapshot } from "../orchestration/ActivityPayloadProjection.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudProviderExecution from "./CloudProviderExecution.ts";

const STATUS_FILE = "status.json";
const RESULT_DIRECTORY = "result";
const MANIFEST_FILE = "manifest.json";
const PREPARATION_FILE = "preparation.json";
const TRANSCRIPT_FILE = "transcript.json";
const VERIFICATION_FILE = "verification.json";
const DIFF_FILE = "changes.patch";
const WORKSPACE_BUNDLE_FILE = "workspace.bundle";
const CONTINUATION_FILE = "continuation.json";
const ARTIFACT_DIRECTORY = "artifacts";
const MAX_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_VERIFICATION_BYTES = 16 * 1024 * 1024;
const GIT_OUTPUT_BYTES = 256 * 1024;

const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudResultRetentionStatus));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudResultManifest));
const decodePreparation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CloudRepositoryPreparationRecord),
);
const decodeContinuation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CloudResultContinuationRecord),
);
const isCloudResultError = Schema.is(CloudResultError);

type TextResultFile = "diff" | "transcript" | "verification";

export interface CloudResultDownload {
  readonly path: string;
  readonly fileName: string;
  readonly mediaType: string;
}

export class CloudRunResults extends Context.Service<
  CloudRunResults,
  {
    readonly capture: (
      input: CloudResultCaptureInput,
    ) => Effect.Effect<CloudResultManifest, CloudResultError>;
    readonly status: (
      resultId: CloudRunResultId,
    ) => Effect.Effect<CloudResultRetentionStatus, CloudResultError>;
    readonly readText: (
      resultId: CloudRunResultId,
      file: TextResultFile,
    ) => Effect.Effect<string, CloudResultError>;
    readonly readTextPrefix: (
      resultId: CloudRunResultId,
      file: TextResultFile,
      maxChars: number,
    ) => Effect.Effect<
      { readonly text: string; readonly truncated: boolean; readonly sizeChars: number },
      CloudResultError
    >;
    readonly resolveDownload: (
      resultId: CloudRunResultId,
      fileId: string,
    ) => Effect.Effect<CloudResultDownload, CloudResultError>;
    readonly startContinuation: (
      input: CloudResultContinuationInput,
    ) => Effect.Effect<CloudResultContinuationRecord, CloudResultError>;
    /**
     * Removes everything retained for one allocation's attempts: transcript,
     * diff, verification, workspace bundle, and artifacts. Result directories
     * are derived from the allocation, so a purge cannot reach another
     * agent's data even when asked to. Already-absent attempts are a no-op,
     * which keeps a re-run after a crash safe.
     */
    readonly purgeAllocation: (input: {
      readonly allocationId: RunAllocationId;
      readonly attempts: ReadonlyArray<number>;
    }) => Effect.Effect<ReadonlyArray<CloudRunResultId>, CloudResultError>;
    /** Drops every retained result past its declared expiry. */
    readonly purgeExpired: Effect.Effect<ReadonlyArray<CloudRunResultId>, CloudResultError>;
    readonly attachProvenance: (
      resultId: CloudRunResultId,
      provenance: CloudCommitProvenance,
    ) => Effect.Effect<CloudResultManifest, CloudResultError>;
  }
>()("t3/cloud/CloudRunResults") {}

interface CloudRunResultsMakeInput {
  readonly resultsRoot: string;
  readonly readTranscript: (
    threadId: CloudResultCaptureInput["sourceThreadId"],
  ) => Effect.Effect<OrchestrationThreadDetailSnapshot | undefined, CloudResultError>;
  readonly readAllocation: (
    allocationId: CloudResultCaptureInput["preparation"]["allocationId"],
  ) => Effect.Effect<RunAllocation | undefined, CloudResultError>;
}

function resultError(input: {
  readonly reason: CloudResultError["reason"];
  readonly message: string;
  readonly retryable: boolean;
}): CloudResultError {
  return new CloudResultError(input);
}

function resultIdFor(allocationId: string, attempt: number): CloudRunResultId {
  return CloudRunResultId.make(
    NodeCrypto.createHash("sha256").update(`${allocationId}:${attempt}`).digest("hex"),
  );
}

/** Lets a reader locate one attempt's retained result without capturing it. */
export function cloudResultIdFor(allocationId: string, attempt: number): CloudRunResultId {
  return resultIdFor(allocationId, attempt);
}

function runDirectory(path: Path.Path, root: string, resultId: CloudRunResultId) {
  return path.join(root, resultId);
}

function resultDirectory(path: Path.Path, root: string, resultId: CloudRunResultId) {
  return path.join(runDirectory(path, root, resultId), RESULT_DIRECTORY);
}

function checkpointRef(resultId: CloudRunResultId): CheckpointRef {
  return CheckpointRef.make(`refs/t3/cloud-results/${resultId}/workspace`);
}

function baseRef(resultId: CloudRunResultId): string {
  return `refs/t3/cloud-results/${resultId}/base`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isInside(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function artifactId(index: number, name: string): string {
  return `${String(index + 1).padStart(3, "0")}-${NodeCrypto.createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, 12)}`;
}

function isSensitiveWorkspacePath(relativePath: string): boolean {
  const name = relativePath.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return (
    name === ".env" ||
    (name.startsWith(".env.") && name !== ".env.example") ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === "credentials" ||
    name === "auth.json" ||
    name === ".claude.json" ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    /\.(?:key|pem|p12|pfx)$/.test(name)
  );
}

export const make = Effect.fn("CloudRunResults.make")(function* (input: CloudRunResultsMakeInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const runner = yield* ProcessRunner.ProcessRunner;
  const executions = yield* CloudProviderExecution.CloudProviderExecution;
  const mutex = yield* Semaphore.make(1);

  const atomicWrite = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const statusPath = (resultId: CloudRunResultId) =>
    path.join(runDirectory(path, input.resultsRoot, resultId), STATUS_FILE);

  const writeStatus = Effect.fn("CloudRunResults.writeStatus")(function* (
    status: CloudResultRetentionStatus,
  ) {
    yield* atomicWrite(
      statusPath(status.status === "retained" ? status.manifest.resultId : status.resultId),
      json(status),
    );
  });

  const readStatus = Effect.fn("CloudRunResults.readStatus")(function* (
    resultId: CloudRunResultId,
  ) {
    const file = statusPath(resultId);
    const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* resultError({
        reason: "result-not-found",
        message: "The retained cloud result does not exist.",
        retryable: false,
      });
    }
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeStatus),
      Effect.mapError(() =>
        resultError({
          reason: "capture-failed",
          message: "The retained cloud result status is unreadable.",
          retryable: true,
        }),
      ),
    );
  });

  const purgeExpired = Effect.fn("CloudRunResults.purgeExpired")(function* () {
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const entries = yield* fs.readDirectory(input.resultsRoot);
    const purged: Array<CloudRunResultId> = [];
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      const directory = path.join(input.resultsRoot, entry);
      const statusContents = yield* fs
        .readFileString(path.join(directory, STATUS_FILE))
        .pipe(Effect.option);
      if (Option.isNone(statusContents)) continue;
      const status = yield* decodeStatus(statusContents.value).pipe(Effect.option);
      if (
        Option.isSome(status) &&
        status.value.status === "retained" &&
        Date.parse(status.value.manifest.expiresAt) <= nowMillis
      ) {
        yield* fs.remove(directory, { recursive: true, force: true });
        purged.push(CloudRunResultId.make(entry));
      }
    }
    return purged as ReadonlyArray<CloudRunResultId>;
  });

  /**
   * Derives each attempt's directory from the allocation rather than taking a
   * path, so the only thing a delete can erase is the agent that asked for it.
   */
  const purgeAllocation: CloudRunResults["Service"]["purgeAllocation"] = (request) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const purged: Array<CloudRunResultId> = [];
        for (const attempt of request.attempts) {
          const resultId = resultIdFor(request.allocationId, attempt);
          const directory = runDirectory(path, input.resultsRoot, resultId);
          const exists = yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false));
          if (!exists) continue;
          yield* fs.remove(directory, { recursive: true, force: true });
          purged.push(resultId);
        }
        return purged as ReadonlyArray<CloudRunResultId>;
      }).pipe(
        Effect.mapError(() =>
          resultError({
            reason: "capture-failed",
            message: "The retained cloud results could not be erased.",
            retryable: true,
          }),
        ),
      ),
    );

  const readManifest = Effect.fn("CloudRunResults.readManifest")(function* (
    resultId: CloudRunResultId,
  ) {
    const file = path.join(resultDirectory(path, input.resultsRoot, resultId), MANIFEST_FILE);
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeManifest),
      Effect.mapError(() =>
        resultError({
          reason: "result-not-found",
          message: "The retained cloud result manifest does not exist.",
          retryable: false,
        }),
      ),
    );
  });

  const runGit = Effect.fn("CloudRunResults.runGit")(function* (request: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly deadlineMillis: number;
    readonly maxOutputBytes?: number;
    readonly outputMode?: "error" | "truncate";
  }) {
    const remaining = request.deadlineMillis - DateTime.toEpochMillis(yield* DateTime.now);
    if (remaining <= 0) {
      return yield* resultError({
        reason: "hard-deadline-exceeded",
        message: "The cloud result could not be retained before the compute deadline.",
        retryable: false,
      });
    }
    const result = yield* runner
      .run({
        command: "git",
        args: request.args,
        cwd: request.cwd,
        timeout: Duration.millis(Math.min(remaining, 2 * 60 * 1000)),
        maxOutputBytes: request.maxOutputBytes ?? GIT_OUTPUT_BYTES,
        outputMode: request.outputMode ?? "truncate",
      })
      .pipe(
        Effect.mapError(() =>
          resultError({
            reason: "capture-failed",
            message: "Git could not create or restore the retained workspace checkpoint.",
            retryable: true,
          }),
        ),
      );
    if (result.code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* resultError({
        reason: "capture-failed",
        message: "Git could not create or restore the retained workspace checkpoint.",
        retryable: true,
      });
    }
    return result.stdout;
  });

  const ensureBeforeDeadline = Effect.fn("CloudRunResults.ensureBeforeDeadline")(function* (
    deadlineMillis: number,
  ) {
    if (DateTime.toEpochMillis(yield* DateTime.now) >= deadlineMillis) {
      return yield* resultError({
        reason: "hard-deadline-exceeded",
        message: "The cloud result could not be retained before the compute deadline.",
        retryable: false,
      });
    }
  });

  const fileSize = Effect.fn("CloudRunResults.fileSize")(function* (filePath: string) {
    const info = yield* fs.stat(filePath).pipe(
      Effect.mapError(() =>
        resultError({
          reason: "capture-failed",
          message: "A retained result file could not be inspected.",
          retryable: true,
        }),
      ),
    );
    const size = Number(info.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      return yield* resultError({
        reason: "size-limit-exceeded",
        message: "A retained result file is too large to record safely.",
        retryable: false,
      });
    }
    return size;
  });

  const writeBoundedText = Effect.fn("CloudRunResults.writeBoundedText")(function* (request: {
    readonly filePath: string;
    readonly contents: string;
    readonly maxBytes: number;
    readonly label: string;
  }) {
    const bytes = Buffer.byteLength(request.contents);
    if (bytes > request.maxBytes) {
      return yield* resultError({
        reason: "size-limit-exceeded",
        message: `${request.label} exceeds its retained-result size limit.`,
        retryable: false,
      });
    }
    yield* fs.writeFileString(request.filePath, request.contents).pipe(
      Effect.mapError(() =>
        resultError({
          reason: "capture-failed",
          message: `${request.label} could not be written to retained storage.`,
          retryable: true,
        }),
      ),
    );
    return bytes;
  });

  const copyArtifacts = Effect.fn("CloudRunResults.copyArtifacts")(function* (request: {
    readonly capture: CloudResultCaptureInput;
    readonly stagingDirectory: string;
  }) {
    const canonicalWorkspace = yield* fs.realPath(request.capture.preparation.workspacePath).pipe(
      Effect.mapError(() =>
        resultError({
          reason: "invalid-artifact",
          message: "The cloud result workspace is unavailable.",
          retryable: false,
        }),
      ),
    );
    const artifactsDirectory = path.join(request.stagingDirectory, ARTIFACT_DIRECTORY);
    yield* fs.makeDirectory(artifactsDirectory, { recursive: true });
    const artifacts: Array<CloudResultArtifact> = [];
    let totalBytes = 0;

    for (const [index, artifact] of request.capture.artifacts.entries()) {
      const requestedPath = path.resolve(canonicalWorkspace, artifact.relativePath);
      const canonicalPath = yield* fs.realPath(requestedPath).pipe(
        Effect.mapError(() =>
          resultError({
            reason: "invalid-artifact",
            message: `Artifact '${artifact.name}' does not exist.`,
            retryable: false,
          }),
        ),
      );
      if (!isInside(path, canonicalWorkspace, canonicalPath)) {
        return yield* resultError({
          reason: "invalid-artifact",
          message: `Artifact '${artifact.name}' is outside the run workspace.`,
          retryable: false,
        });
      }
      const sizeBytes = yield* fileSize(canonicalPath);
      if (sizeBytes > CLOUD_RESULT_MAX_ARTIFACT_BYTES) {
        return yield* resultError({
          reason: "size-limit-exceeded",
          message: `Artifact '${artifact.name}' exceeds the per-file size limit.`,
          retryable: false,
        });
      }
      const id = artifactId(index, artifact.name);
      const destination = path.join(artifactsDirectory, id);
      const bytes = yield* fs.readFile(canonicalPath).pipe(
        Effect.mapError(() =>
          resultError({
            reason: "capture-failed",
            message: `Artifact '${artifact.name}' could not be read.`,
            retryable: true,
          }),
        ),
      );
      yield* fs.writeFile(destination, bytes).pipe(
        Effect.mapError(() =>
          resultError({
            reason: "capture-failed",
            message: `Artifact '${artifact.name}' could not be retained.`,
            retryable: true,
          }),
        ),
      );
      totalBytes += sizeBytes;
      artifacts.push({
        id,
        name: artifact.name,
        relativePath: artifact.relativePath,
        ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
        sizeBytes,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        downloadPath: `/api/cloud/results/${resultIdFor(
          request.capture.preparation.allocationId,
          request.capture.preparation.attempt,
        )}/downloads/${id}`,
      });
    }
    return { artifacts, totalBytes };
  });

  const captureUnlocked = Effect.fn("CloudRunResults.captureUnlocked")(function* (
    captureInput: CloudResultCaptureInput,
  ) {
    const resultId = resultIdFor(
      captureInput.preparation.allocationId,
      captureInput.preparation.attempt,
    );
    const existingResultDirectory = resultDirectory(path, input.resultsRoot, resultId);
    const existing = yield* fs
      .exists(path.join(existingResultDirectory, MANIFEST_FILE))
      .pipe(Effect.orElseSucceed(() => false));
    if (existing) {
      const manifest = yield* readManifest(resultId);
      yield* writeStatus({ status: "retained", manifest });
      return manifest;
    }

    const captureStarted = yield* DateTime.now;
    const captureStartedAt = DateTime.formatIso(captureStarted);
    const deadlineMillis = Date.parse(captureInput.hardDeadline);
    if (
      !Number.isFinite(deadlineMillis) ||
      deadlineMillis <= DateTime.toEpochMillis(captureStarted)
    ) {
      const error = resultError({
        reason: "hard-deadline-exceeded",
        message: "The cloud result could not be retained before the compute deadline.",
        retryable: false,
      });
      yield* fs.makeDirectory(runDirectory(path, input.resultsRoot, resultId), { recursive: true });
      yield* writeStatus({
        status: "failed",
        resultId,
        reason: error.reason,
        message: error.message,
        retryable: error.retryable,
        failedAt: captureStartedAt,
      });
      return yield* error;
    }

    yield* fs.makeDirectory(runDirectory(path, input.resultsRoot, resultId), { recursive: true });
    yield* writeStatus({
      status: "retaining",
      resultId,
      startedAt: captureStartedAt,
      hardDeadline: captureInput.hardDeadline,
    });

    const stagingDirectory = path.join(
      runDirectory(path, input.resultsRoot, resultId),
      `.staging-${NodeCrypto.randomUUID()}`,
    );
    yield* fs.makeDirectory(stagingDirectory, { recursive: true });

    const attemptCapture = Effect.gen(function* () {
      yield* ensureBeforeDeadline(deadlineMillis);
      const transcript = yield* input.readTranscript(captureInput.sourceThreadId).pipe(
        Effect.mapError(() =>
          resultError({
            reason: "capture-failed",
            message: "The authoritative thread transcript could not be read.",
            retryable: true,
          }),
        ),
      );
      if (transcript === undefined) {
        return yield* resultError({
          reason: "thread-not-found",
          message: "The source thread no longer exists in its authoritative environment.",
          retryable: false,
        });
      }

      const workspace = captureInput.preparation.workspacePath;
      const savedCheckpointRef = checkpointRef(resultId);
      const changedPaths = yield* Effect.all(
        [
          runGit({
            cwd: workspace,
            args: ["diff", "--name-only", "-z", captureInput.preparation.resolvedCommit, "--", "."],
            deadlineMillis,
            maxOutputBytes: 2 * 1024 * 1024,
            outputMode: "error",
          }),
          runGit({
            cwd: workspace,
            args: ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
            deadlineMillis,
            maxOutputBytes: 2 * 1024 * 1024,
            outputMode: "error",
          }),
        ],
        { concurrency: "unbounded" },
      );
      const sensitivePath = changedPaths
        .flatMap((output) => output.split("\0"))
        .find((relativePath) => relativePath.length > 0 && isSensitiveWorkspacePath(relativePath));
      if (sensitivePath !== undefined) {
        return yield* resultError({
          reason: "invalid-artifact",
          message: `Sensitive workspace file '${sensitivePath}' must be removed or ignored before retention.`,
          retryable: true,
        });
      }
      yield* checkpoints
        .captureCheckpoint({ cwd: workspace, checkpointRef: savedCheckpointRef })
        .pipe(
          Effect.mapError(() =>
            resultError({
              reason: "capture-failed",
              message: "The workspace checkpoint could not be captured.",
              retryable: true,
            }),
          ),
        );
      yield* runGit({
        cwd: workspace,
        args: ["update-ref", baseRef(resultId), captureInput.preparation.resolvedCommit],
        deadlineMillis,
      });

      const bundlePath = path.join(stagingDirectory, WORKSPACE_BUNDLE_FILE);
      yield* runGit({
        cwd: workspace,
        args: ["bundle", "create", bundlePath, savedCheckpointRef, baseRef(resultId)],
        deadlineMillis,
      });
      const diff = yield* runGit({
        cwd: workspace,
        args: [
          "diff",
          "--binary",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          captureInput.preparation.resolvedCommit,
          savedCheckpointRef,
        ],
        deadlineMillis,
        maxOutputBytes: MAX_DIFF_BYTES,
        outputMode: "error",
      }).pipe(
        Effect.mapError((error) =>
          error.reason === "capture-failed"
            ? resultError({
                reason: "size-limit-exceeded",
                message: "The workspace diff exceeds its retained-result size limit.",
                retryable: false,
              })
            : error,
        ),
      );

      const transcriptBytes = yield* writeBoundedText({
        filePath: path.join(stagingDirectory, TRANSCRIPT_FILE),
        contents: json(transcript),
        maxBytes: MAX_TRANSCRIPT_BYTES,
        label: "Thread transcript",
      });
      const verificationBytes = yield* writeBoundedText({
        filePath: path.join(stagingDirectory, VERIFICATION_FILE),
        contents: json(captureInput.verification),
        maxBytes: MAX_VERIFICATION_BYTES,
        label: "Verification output",
      });
      const diffBytes = yield* writeBoundedText({
        filePath: path.join(stagingDirectory, DIFF_FILE),
        contents: diff,
        maxBytes: MAX_DIFF_BYTES,
        label: "Workspace diff",
      });
      const preparationBytes = yield* writeBoundedText({
        filePath: path.join(stagingDirectory, PREPARATION_FILE),
        contents: json(captureInput.preparation),
        maxBytes: 1024 * 1024,
        label: "Repository preparation record",
      });
      const retainedArtifacts = yield* copyArtifacts({
        capture: captureInput,
        stagingDirectory,
      });
      const bundleBytes = yield* fileSize(bundlePath);
      const captured = yield* DateTime.now;
      const totalSizeBytes =
        transcriptBytes +
        verificationBytes +
        diffBytes +
        preparationBytes +
        bundleBytes +
        retainedArtifacts.totalBytes;
      if (totalSizeBytes > CLOUD_RESULT_MAX_TOTAL_BYTES) {
        return yield* resultError({
          reason: "size-limit-exceeded",
          message: "The retained cloud result exceeds the total size limit.",
          retryable: false,
        });
      }

      const manifest: CloudResultManifest = {
        version: 1,
        resultId,
        allocationId: captureInput.preparation.allocationId,
        attempt: captureInput.preparation.attempt,
        sourceEnvironmentId: captureInput.sourceEnvironmentId,
        sourceThreadId: captureInput.sourceThreadId,
        baseCommit: captureInput.preparation.resolvedCommit,
        outputBranch: captureInput.preparation.outputBranch,
        checkpointRef: savedCheckpointRef,
        pagePath: `/cloud/results/${resultId}`,
        diffDownloadPath: `/api/cloud/results/${resultId}/downloads/diff`,
        transcriptDownloadPath: `/api/cloud/results/${resultId}/downloads/transcript`,
        verificationDownloadPath: `/api/cloud/results/${resultId}/downloads/verification`,
        workspaceDownloadPath: `/api/cloud/results/${resultId}/downloads/workspace`,
        artifacts: retainedArtifacts.artifacts,
        totalSizeBytes,
        captureStartedAt,
        capturedAt: DateTime.formatIso(captured),
        expiresAt: DateTime.formatIso(
          DateTime.add(captured, { days: CLOUD_RESULT_RETENTION_DAYS }),
        ),
      };
      yield* fs.writeFileString(path.join(stagingDirectory, MANIFEST_FILE), json(manifest));
      yield* ensureBeforeDeadline(deadlineMillis);
      yield* fs.rename(stagingDirectory, existingResultDirectory).pipe(
        Effect.mapError(() =>
          resultError({
            reason: "capture-failed",
            message: "The retained cloud result could not be committed atomically.",
            retryable: true,
          }),
        ),
      );
      yield* writeStatus({ status: "retained", manifest });
      return manifest;
    });

    return yield* attemptCapture.pipe(
      Effect.mapError((error) =>
        isCloudResultError(error)
          ? error
          : resultError({
              reason: "capture-failed",
              message: "The cloud result could not be written to retained storage.",
              retryable: true,
            }),
      ),
      Effect.tapError((error) =>
        Effect.gen(function* () {
          yield* fs.remove(stagingDirectory, { recursive: true, force: true }).pipe(Effect.ignore);
          yield* writeStatus({
            status: "failed",
            resultId,
            reason: error.reason,
            message: error.message,
            retryable: error.retryable,
            failedAt: DateTime.formatIso(yield* DateTime.now),
          }).pipe(Effect.ignore);
        }),
      ),
    );
  });

  const capture: CloudRunResults["Service"]["capture"] = (captureInput) =>
    mutex
      .withPermits(1)(purgeExpired().pipe(Effect.andThen(captureUnlocked(captureInput))))
      .pipe(
        Effect.mapError((error) =>
          isCloudResultError(error)
            ? error
            : resultError({
                reason: "capture-failed",
                message: "The cloud result could not be written to retained storage.",
                retryable: true,
              }),
        ),
      );

  const status: CloudRunResults["Service"]["status"] = readStatus;

  const resultFilePath = (resultId: CloudRunResultId, file: TextResultFile) => {
    const fileName =
      file === "diff" ? DIFF_FILE : file === "transcript" ? TRANSCRIPT_FILE : VERIFICATION_FILE;
    return path.join(resultDirectory(path, input.resultsRoot, resultId), fileName);
  };

  const readText: CloudRunResults["Service"]["readText"] = Effect.fn("CloudRunResults.readText")(
    function* (resultId, file) {
      return yield* fs.readFileString(resultFilePath(resultId, file)).pipe(
        Effect.mapError(() =>
          resultError({
            reason: "result-not-found",
            message: "The requested retained result file does not exist.",
            retryable: false,
          }),
        ),
      );
    },
  );

  const readTextPrefix: CloudRunResults["Service"]["readTextPrefix"] = Effect.fn(
    "CloudRunResults.readTextPrefix",
  )(function* (resultId, file, maxChars) {
    const filePath = resultFilePath(resultId, file);
    const info = yield* fs.stat(filePath).pipe(
      Effect.mapError(() =>
        resultError({
          reason: "result-not-found",
          message: "The requested retained result file does not exist.",
          retryable: false,
        }),
      ),
    );
    const sizeChars = Number(info.size);
    const take = Math.min(Math.max(0, sizeChars), Math.max(0, maxChars) + 1);
    const chunk = yield* Effect.scoped(
      fs.open(filePath, { flag: "r" }).pipe(
        Effect.flatMap((handle) => handle.readAlloc(take)),
        Effect.mapError(() =>
          resultError({
            reason: "result-not-found",
            message: "The requested retained result file does not exist.",
            retryable: false,
          }),
        ),
      ),
    );
    const text = Option.match(chunk, {
      onNone: () => "",
      onSome: (bytes) => new TextDecoder().decode(bytes),
    });
    const truncated = sizeChars > maxChars;
    return {
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
      sizeChars,
    };
  });

  const resolveDownload: CloudRunResults["Service"]["resolveDownload"] = Effect.fn(
    "CloudRunResults.resolveDownload",
  )(function* (resultId, fileId) {
    const manifest = yield* readManifest(resultId);
    if (fileId === "diff") {
      return {
        path: path.join(resultDirectory(path, input.resultsRoot, resultId), DIFF_FILE),
        fileName: DIFF_FILE,
        mediaType: "text/x-diff; charset=utf-8",
      };
    }
    if (fileId === "transcript") {
      return {
        path: path.join(resultDirectory(path, input.resultsRoot, resultId), TRANSCRIPT_FILE),
        fileName: TRANSCRIPT_FILE,
        mediaType: "application/json",
      };
    }
    if (fileId === "verification") {
      return {
        path: path.join(resultDirectory(path, input.resultsRoot, resultId), VERIFICATION_FILE),
        fileName: VERIFICATION_FILE,
        mediaType: "application/json",
      };
    }
    if (fileId === "workspace") {
      return {
        path: path.join(resultDirectory(path, input.resultsRoot, resultId), WORKSPACE_BUNDLE_FILE),
        fileName: WORKSPACE_BUNDLE_FILE,
        mediaType: "application/octet-stream",
      };
    }
    const artifact = manifest.artifacts.find((candidate) => candidate.id === fileId);
    if (artifact === undefined) {
      return yield* resultError({
        reason: "result-not-found",
        message: "The requested retained artifact does not exist.",
        retryable: false,
      });
    }
    return {
      path: path.join(
        resultDirectory(path, input.resultsRoot, resultId),
        ARTIFACT_DIRECTORY,
        fileId,
      ),
      fileName: artifact.name,
      mediaType: artifact.mediaType ?? "application/octet-stream",
    };
  });

  const startContinuation: CloudRunResults["Service"]["startContinuation"] = Effect.fn(
    "CloudRunResults.startContinuation",
  )(function* (request) {
    const manifest = yield* readManifest(request.resultId);
    if (request.allocationId === manifest.allocationId && request.attempt <= manifest.attempt) {
      return yield* resultError({
        reason: "attempt-not-fenced",
        message: "A continuation must use a newer allocation attempt or a different allocation.",
        retryable: false,
      });
    }
    const continuationPath = path.join(
      resultDirectory(path, input.resultsRoot, request.resultId),
      CONTINUATION_FILE,
    );
    const existingContinuationContents = yield* fs
      .readFileString(continuationPath)
      .pipe(Effect.option);
    if (Option.isSome(existingContinuationContents)) {
      const existingContinuation = yield* decodeContinuation(
        existingContinuationContents.value,
      ).pipe(
        Effect.mapError(() =>
          resultError({
            reason: "restore-failed",
            message: "The retained continuation record is invalid.",
            retryable: false,
          }),
        ),
      );
      if (
        existingContinuation.continuationAllocationId === request.allocationId &&
        existingContinuation.continuationAttempt === request.attempt &&
        existingContinuation.continuation.threadId === request.threadId &&
        existingContinuation.restoredWorkspacePath === request.destinationWorkspacePath
      ) {
        return existingContinuation;
      }
      return yield* resultError({
        reason: "restore-failed",
        message: "This retained result already has a different linked continuation.",
        retryable: false,
      });
    }
    const sourceAllocation = yield* input.readAllocation(manifest.allocationId).pipe(
      Effect.mapError(() =>
        resultError({
          reason: "restore-failed",
          message: "The controller could not verify the source allocation fence.",
          retryable: true,
        }),
      ),
    );
    const sourceAttemptIsCurrent = sourceAllocation?.attempt === manifest.attempt;
    if (
      sourceAllocation === undefined ||
      (sourceAttemptIsCurrent && sourceAllocation.cleanupState.status === "not-requested")
    ) {
      return yield* resultError({
        reason: "attempt-not-fenced",
        message: "Fence the previous worker attempt before restoring its retained identity.",
        retryable: true,
      });
    }

    const destinationExists = yield* fs
      .exists(request.destinationWorkspacePath)
      .pipe(Effect.orElseSucceed(() => false));
    const restoreMarkerPath = path.join(
      request.destinationWorkspacePath,
      ".git",
      "t3-cloud-result-source",
    );
    const existingRestoreMarker = destinationExists
      ? yield* fs.readFileString(restoreMarkerPath).pipe(Effect.option)
      : Option.none<string>();
    if (
      destinationExists &&
      (Option.isNone(existingRestoreMarker) ||
        existingRestoreMarker.value.trim() !== request.resultId)
    ) {
      return yield* resultError({
        reason: "restore-failed",
        message: "The continuation workspace already exists and belongs to another recovery.",
        retryable: false,
      });
    }

    const deadlineMillis = DateTime.toEpochMillis(
      DateTime.add(yield* DateTime.now, { minutes: 5 }),
    );
    const bundlePath = path.join(
      resultDirectory(path, input.resultsRoot, request.resultId),
      WORKSPACE_BUNDLE_FILE,
    );
    if (!destinationExists) {
      yield* fs.makeDirectory(request.destinationWorkspacePath, { recursive: true }).pipe(
        Effect.mapError(() =>
          resultError({
            reason: "restore-failed",
            message: "The continuation workspace could not be created.",
            retryable: true,
          }),
        ),
      );
      const restore = Effect.gen(function* () {
        yield* runGit({
          cwd: request.destinationWorkspacePath,
          args: ["init"],
          deadlineMillis,
        });
        yield* runGit({
          cwd: request.destinationWorkspacePath,
          args: [
            "fetch",
            bundlePath,
            `${baseRef(request.resultId)}:${baseRef(request.resultId)}`,
            `${manifest.checkpointRef}:${manifest.checkpointRef}`,
          ],
          deadlineMillis,
        });
        yield* runGit({
          cwd: request.destinationWorkspacePath,
          args: ["checkout", "-b", manifest.outputBranch, baseRef(request.resultId)],
          deadlineMillis,
        });
        yield* runGit({
          cwd: request.destinationWorkspacePath,
          args: [
            "restore",
            "--source",
            manifest.checkpointRef,
            "--worktree",
            "--staged",
            "--",
            ".",
          ],
          deadlineMillis,
        });
        yield* runGit({
          cwd: request.destinationWorkspacePath,
          args: ["reset", "--mixed", baseRef(request.resultId)],
          deadlineMillis,
        });
        yield* fs.writeFileString(restoreMarkerPath, `${request.resultId}\n`);
      }).pipe(
        Effect.mapError((error) =>
          isCloudResultError(error) && error.reason === "hard-deadline-exceeded"
            ? error
            : resultError({
                reason: "restore-failed",
                message: "The retained workspace checkpoint could not be restored.",
                retryable: true,
              }),
        ),
      );
      yield* restore.pipe(
        Effect.tapError(() =>
          fs
            .remove(request.destinationWorkspacePath, { recursive: true, force: true })
            .pipe(Effect.ignore),
        ),
      );
    }

    const preparationContents = yield* fs
      .readFileString(
        path.join(resultDirectory(path, input.resultsRoot, request.resultId), PREPARATION_FILE),
      )
      .pipe(
        Effect.mapError(() =>
          resultError({
            reason: "restore-failed",
            message: "The retained repository preparation record is unavailable.",
            retryable: false,
          }),
        ),
      );
    const preparation = yield* decodePreparation(preparationContents).pipe(
      Effect.mapError(() =>
        resultError({
          reason: "restore-failed",
          message: "The retained repository preparation record is invalid.",
          retryable: false,
        }),
      ),
    );
    const continuation = yield* executions
      .start({
        preparation: {
          ...preparation,
          allocationId: request.allocationId,
          attempt: request.attempt,
          workspacePath: request.destinationWorkspacePath,
        },
        threadId: request.threadId,
        title: request.title,
        unansweredRequestSeconds: request.unansweredRequestSeconds,
        turn: request.turn,
      })
      .pipe(
        Effect.mapError(() =>
          resultError({
            reason: "continuation-start-failed",
            message: "The restored continuation could not be started through T3.",
            retryable: true,
          }),
        ),
      );
    const record = {
      resultId: request.resultId,
      sourceAllocationId: manifest.allocationId,
      sourceAttempt: manifest.attempt,
      sourceThreadId: manifest.sourceThreadId,
      continuationAllocationId: request.allocationId,
      continuationAttempt: request.attempt,
      continuation,
      restoredWorkspacePath: request.destinationWorkspacePath,
      startedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies CloudResultContinuationRecord;
    yield* atomicWrite(continuationPath, json(record)).pipe(
      Effect.mapError(() =>
        resultError({
          reason: "restore-failed",
          message: "The continuation started, but its retained link could not be saved.",
          retryable: true,
        }),
      ),
    );
    return record;
  });

  const attachProvenance: CloudRunResults["Service"]["attachProvenance"] = (resultId, provenance) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const status = yield* readStatus(resultId);
        if (status.status !== "retained") {
          return yield* resultError({
            reason: "result-not-found",
            message: "Provenance can only attach to a retained result.",
            retryable: false,
          });
        }
        const manifest = { ...status.manifest, provenance };
        yield* atomicWrite(
          path.join(resultDirectory(path, input.resultsRoot, resultId), MANIFEST_FILE),
          json(manifest),
        ).pipe(
          Effect.mapError(() =>
            resultError({
              reason: "capture-failed",
              message: "The retained provenance record could not be saved.",
              retryable: true,
            }),
          ),
        );
        yield* writeStatus({ status: "retained", manifest });
        return manifest;
      }).pipe(
        Effect.mapError((error) =>
          isCloudResultError(error)
            ? error
            : resultError({
                reason: "capture-failed",
                message: "The retained provenance record could not be saved.",
                retryable: true,
              }),
        ),
      ),
    );

  yield* fs.makeDirectory(input.resultsRoot, { recursive: true });
  yield* purgeExpired().pipe(
    Effect.catch((cause) => Effect.logWarning("Could not purge expired cloud results.", { cause })),
  );
  return CloudRunResults.of({
    capture,
    status,
    readText,
    readTextPrefix,
    resolveDownload,
    startContinuation,
    attachProvenance,
    purgeAllocation,
    purgeExpired: mutex.withPermits(1)(
      purgeExpired().pipe(
        Effect.mapError(() =>
          resultError({
            reason: "capture-failed",
            message: "The expired cloud results could not be swept.",
            retryable: true,
          }),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(
  CloudRunResults,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const snapshots = yield* ProjectionSnapshotQuery;
    const allocations = yield* CloudAllocationController.CloudAllocationController;
    return yield* make({
      resultsRoot: path.join(config.stateDir, "cloud-results"),
      readTranscript: (threadId) =>
        snapshots.getThreadDetailSnapshot(threadId).pipe(
          Effect.map((snapshot) =>
            Option.isSome(snapshot) ? projectThreadDetailSnapshot(snapshot.value, true) : undefined,
          ),
          Effect.mapError(() =>
            resultError({
              reason: "capture-failed",
              message: "The authoritative thread transcript could not be read.",
              retryable: true,
            }),
          ),
        ),
      readAllocation: (allocationId) =>
        allocations.snapshot.pipe(
          Effect.map((snapshot) =>
            snapshot.allocations.find((allocation) => allocation.id === allocationId),
          ),
          Effect.mapError(() =>
            resultError({
              reason: "restore-failed",
              message: "The controller could not verify the source allocation fence.",
              retryable: true,
            }),
          ),
        ),
    });
  }),
);
