// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CloudHandoffError,
  CloudHandoffExecuteResult,
  CloudHandoffTransferId,
  type CloudAgent,
  type CloudAllocationSnapshot,
  type CloudHandoffExecuteInput,
  type CloudHandoffFile,
  type CloudHandoffPreview,
  type CloudHandoffPreviewInput,
  type CloudHandoffSide,
  type CloudRunResultId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudRunResults from "./CloudRunResults.ts";
import {
  classifyTransferFile,
  detectImportConflicts,
  handoffExplanation,
  historyTransfer,
  parseGitStatusLines,
  parsePatchPaths,
  retryDecision,
  selectTransferFiles,
} from "./cloudHandoffPolicy.ts";

const RECORD_FILE = "transfer.json";
const PATCH_FILE = "changes.patch";
const GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

const PersistedTransfer = Schema.Struct({
  transferId: CloudHandoffTransferId,
  status: Schema.Literals(["applying", "applied"]),
  fingerprint: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
});
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedTransfer));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(PersistedTransfer));
const decodeResult = Schema.decodeUnknownEffect(CloudHandoffExecuteResult);
const encodeResult = Schema.encodeSync(CloudHandoffExecuteResult);

export class CloudHandoff extends Context.Service<
  CloudHandoff,
  {
    readonly preview: (
      input: CloudHandoffPreviewInput,
    ) => Effect.Effect<CloudHandoffPreview, CloudHandoffError>;
    readonly execute: (
      input: CloudHandoffExecuteInput,
    ) => Effect.Effect<CloudHandoffExecuteResult, CloudHandoffError>;
  }
>()("t3/cloud/CloudHandoff") {}

function handoffError(
  reason: CloudHandoffError["reason"],
  message: string,
  conflicts?: CloudHandoffError["conflicts"],
): CloudHandoffError {
  return new CloudHandoffError({
    reason,
    message,
    ...(conflicts === undefined ? {} : { conflicts }),
  });
}

function liveRuntime(agent: CloudAgent | undefined) {
  return agent?.status === "ACTIVE" ? agent.runtime : undefined;
}

export interface CloudHandoffMakeInput {
  readonly handoffsRoot: string;
  readonly readSnapshot: Effect.Effect<CloudAllocationSnapshot, CloudHandoffError>;
  readonly readRetainedDiff: (
    resultId: CloudRunResultId,
  ) => Effect.Effect<{ readonly patch: string; readonly transcriptAvailable: boolean } | null>;
}

export const make = Effect.fn("CloudHandoff.make")(function* (input: CloudHandoffMakeInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const mutex = yield* Semaphore.make(1);
  const records = yield* Ref.make(new Map<string, typeof PersistedTransfer.Type>());

  const atomicWrite = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  yield* fs
    .makeDirectory(input.handoffsRoot, { recursive: true })
    .pipe(
      Effect.mapError(() =>
        handoffError("persistence-failed", "The handoff catalog directory could not be created."),
      ),
    );

  const runGit = Effect.fn("CloudHandoff.runGit")(function* (request: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly allowFailure?: boolean;
  }) {
    const result = yield* runner
      .run({
        command: "git",
        args: request.args,
        cwd: request.cwd,
        timeout: Duration.minutes(2),
        maxOutputBytes: GIT_OUTPUT_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError(() =>
          handoffError("apply-failed", "Git could not inspect or apply the handoff."),
        ),
      );
    if (result.code !== ChildProcessSpawner.ExitCode(0) && request.allowFailure !== true) {
      return yield* handoffError(
        "apply-failed",
        result.stderr.trim() || result.stdout.trim() || "Git refused the handoff command.",
      );
    }
    return result.stdout;
  });

  const requireWorkspace = Effect.fn("CloudHandoff.requireWorkspace")(function* (
    workspace: string,
  ) {
    const exists = yield* fs.exists(workspace).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* handoffError(
        "workspace-not-found",
        "The local workspace for this handoff does not exist.",
      );
    }
    return workspace;
  });

  const headCommit = Effect.fn("CloudHandoff.headCommit")(function* (workspace: string) {
    const commit = (yield* runGit({ cwd: workspace, args: ["rev-parse", "HEAD"] })).trim();
    const branch = (yield* runGit({
      cwd: workspace,
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      allowFailure: true,
    })).trim();
    return {
      commit,
      branch: branch.length === 0 || branch === "HEAD" ? undefined : branch,
    };
  });

  const listWorkspaceFiles = Effect.fn("CloudHandoff.listWorkspaceFiles")(function* (
    workspace: string,
  ) {
    const stdout = yield* runGit({
      cwd: workspace,
      args: ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
      allowFailure: true,
    });
    return parseGitStatusLines(stdout).map(classifyTransferFile);
  });

  const dirtyPaths = Effect.fn("CloudHandoff.dirtyPaths")(function* (workspace: string) {
    const stdout = yield* runGit({
      cwd: workspace,
      args: ["status", "--porcelain=v1", "--untracked-files=all"],
      allowFailure: true,
    });
    return parseGitStatusLines(stdout)
      .filter((file) => !file.gitIgnored)
      .map((file) => file.path);
  });

  const locateAgent = Effect.fn("CloudHandoff.locateAgent")(function* (
    agentId: CloudHandoffPreviewInput["agentId"],
  ) {
    if (agentId === undefined) return undefined;
    const snapshot = yield* input.readSnapshot;
    return snapshot.agents?.find((agent) => agent.id === agentId);
  });

  const retainedForAgent = Effect.fn("CloudHandoff.retainedForAgent")(function* (
    agent: CloudAgent,
  ) {
    const snapshot = yield* input.readSnapshot;
    const allocation = snapshot.allocations.find((entry) => entry.id === agent.allocationId);
    const attempt = allocation?.attempt ?? 1;
    return yield* input.readRetainedDiff(
      CloudRunResults.cloudResultIdFor(agent.allocationId, attempt),
    );
  });

  const transferDirectory = (transferId: CloudHandoffTransferId) =>
    path.join(input.handoffsRoot, transferId);

  const readRecord = Effect.fn("CloudHandoff.readRecord")(function* (
    transferId: CloudHandoffTransferId,
  ) {
    const cached = (yield* Ref.get(records)).get(transferId);
    if (cached !== undefined) return cached;
    const contents = yield* fs
      .readFileString(path.join(transferDirectory(transferId), RECORD_FILE))
      .pipe(Effect.option);
    if (contents._tag === "None") return undefined;
    const decoded = yield* decodeRecord(contents.value).pipe(
      Effect.mapError(() =>
        handoffError("persistence-failed", "The stored handoff record is invalid."),
      ),
    );
    yield* Ref.update(records, (current) => new Map(current).set(transferId, decoded));
    return decoded;
  });

  const writeRecord = Effect.fn("CloudHandoff.writeRecord")(function* (
    record: typeof PersistedTransfer.Type,
  ) {
    yield* Ref.update(records, (current) => new Map(current).set(record.transferId, record));
    yield* atomicWrite(
      path.join(transferDirectory(record.transferId), RECORD_FILE),
      encodeRecord(record),
    ).pipe(
      Effect.mapError(() =>
        handoffError("persistence-failed", "The handoff record could not be saved."),
      ),
    );
  });

  const cloudFilesFromPatch = (patch: string): ReadonlyArray<CloudHandoffFile> =>
    parsePatchPaths(patch).map((relativePath) =>
      classifyTransferFile({
        path: relativePath,
        change: "modified",
        gitIgnored: false,
      }),
    );

  const preview = Effect.fn("CloudHandoff.preview")(function* (request: CloudHandoffPreviewInput) {
    const workspace = yield* requireWorkspace(request.localWorkspacePath);
    const localHead = yield* headCommit(workspace);
    const agent = yield* locateAgent(request.agentId);
    if (request.intent === "wake-same-agent" || request.direction === "cloud-to-local") {
      if (agent === undefined) {
        return yield* handoffError(
          "agent-not-found",
          "A cloud agent is required to wake or import cloud changes.",
        );
      }
    }
    const retained = agent === undefined ? null : yield* retainedForAgent(agent);
    const files =
      request.direction === "local-to-cloud"
        ? yield* listWorkspaceFiles(workspace)
        : cloudFilesFromPatch(retained?.patch ?? "");
    const transferId = CloudHandoffTransferId.make(NodeCrypto.randomUUID());
    const defaultDestination =
      request.destinationWorkspacePath ??
      path.join(path.dirname(workspace), `t3-cloud-handoff-${transferId.slice(0, 8)}`);
    const source: CloudHandoffSide =
      request.intent === "wake-same-agent" || request.direction === "cloud-to-local"
        ? {
            surface: "cloud",
            environmentId: agent?.environment?.environmentId ?? request.sourceEnvironmentId,
            threadId: liveRuntime(agent)?.threadId ?? request.sourceThreadId ?? null,
            ...(agent === undefined ? {} : { agentId: agent.id }),
          }
        : {
            surface: "local",
            environmentId: request.sourceEnvironmentId,
            threadId: request.sourceThreadId ?? null,
            workspacePath: workspace,
          };
    const destination: CloudHandoffSide =
      request.intent === "wake-same-agent"
        ? {
            surface: "cloud",
            environmentId: agent?.environment?.environmentId ?? request.destinationEnvironmentId,
            threadId: liveRuntime(agent)?.threadId ?? request.destinationThreadId ?? null,
            ...(agent === undefined ? {} : { agentId: agent.id }),
          }
        : request.direction === "cloud-to-local"
          ? {
              surface: "local",
              environmentId: request.destinationEnvironmentId,
              threadId: request.destinationThreadId ?? null,
              workspacePath: defaultDestination,
            }
          : {
              surface: "cloud",
              environmentId: agent?.environment?.environmentId ?? request.destinationEnvironmentId,
              threadId: request.destinationThreadId ?? null,
              workspacePath: defaultDestination,
              ...(agent === undefined ? {} : { agentId: agent.id }),
            };
    return {
      transferId,
      direction: request.direction,
      intent: request.intent,
      baseCommit:
        request.direction === "cloud-to-local"
          ? (agent?.baseCommit ?? localHead.commit)
          : localHead.commit,
      ...(request.direction === "cloud-to-local"
        ? agent?.branches[0] === undefined
          ? {}
          : { baseBranch: agent.branches[0] }
        : localHead.branch === undefined
          ? {}
          : { baseBranch: localHead.branch }),
      source,
      destination,
      files,
      history: historyTransfer({ transcriptAvailable: retained?.transcriptAvailable === true }),
      snapshotWriter: request.intent === "wake-same-agent" ? "source" : "destination",
      explanation: handoffExplanation(request.intent),
    } satisfies CloudHandoffPreview;
  });

  const buildLocalPatch = Effect.fn("CloudHandoff.buildLocalPatch")(function* (request: {
    readonly workspace: string;
    readonly selected: ReadonlyArray<CloudHandoffFile>;
  }) {
    const chunks: string[] = [];
    for (const file of request.selected) {
      const args =
        file.change === "untracked" || file.change === "ignored"
          ? ["diff", "--binary", "--no-color", "--no-index", "--", "/dev/null", file.path]
          : ["diff", "--binary", "--no-color", "HEAD", "--", file.path];
      const diff = yield* runGit({
        cwd: request.workspace,
        args,
        allowFailure: true,
      });
      if (diff.trim().length > 0) chunks.push(diff.endsWith("\n") ? diff : `${diff}\n`);
    }
    return chunks.join("");
  });

  const ensureDestination = Effect.fn("CloudHandoff.ensureDestination")(function* (request: {
    readonly sourceWorkspace: string;
    readonly destinationWorkspace: string;
    readonly baseCommit: string;
    readonly branchName: string;
  }) {
    const exists = yield* fs
      .exists(request.destinationWorkspace)
      .pipe(Effect.orElseSucceed(() => false));
    if (exists) return;
    yield* runGit({
      cwd: request.sourceWorkspace,
      args: [
        "worktree",
        "add",
        "-b",
        request.branchName,
        request.destinationWorkspace,
        request.baseCommit,
      ],
    });
  });

  const applyPatch = Effect.fn("CloudHandoff.applyPatch")(function* (request: {
    readonly destinationWorkspace: string;
    readonly patch: string;
    readonly excludePaths?: ReadonlyArray<string>;
  }) {
    if (request.patch.trim().length === 0) return;
    const excludeArgs = (request.excludePaths ?? []).flatMap((relativePath) => [
      "--exclude",
      relativePath,
    ]);
    const result = yield* runner
      .run({
        command: "git",
        args: ["apply", "--whitespace=nowarn", ...excludeArgs, "--"],
        cwd: request.destinationWorkspace,
        stdin: request.patch,
        timeout: Duration.minutes(2),
        maxOutputBytes: GIT_OUTPUT_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError(() =>
          handoffError("apply-failed", "Git could not apply the selected handoff patch."),
        ),
      );
    if (result.code !== ChildProcessSpawner.ExitCode(0)) {
      const alreadyApplied = yield* runner
        .run({
          command: "git",
          args: ["apply", "--reverse", "--check", "--"],
          cwd: request.destinationWorkspace,
          stdin: request.patch,
          timeout: Duration.seconds(30),
          maxOutputBytes: GIT_OUTPUT_BYTES,
          outputMode: "truncate",
        })
        .pipe(Effect.orElseSucceed(() => ({ code: ChildProcessSpawner.ExitCode(1) })));
      if (alreadyApplied.code === ChildProcessSpawner.ExitCode(0)) return;
      return yield* handoffError(
        "apply-failed",
        result.stderr.trim() || "The selected changes could not be applied.",
      );
    }
  });

  const execute = Effect.fn("CloudHandoff.execute")(function* (request: CloudHandoffExecuteInput) {
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const workspace = yield* requireWorkspace(request.localWorkspacePath);
        const localHead = yield* headCommit(workspace);
        const agent = yield* locateAgent(request.agentId);
        if (request.intent === "wake-same-agent") {
          if (agent === undefined) {
            return yield* handoffError("agent-not-found", "A cloud agent is required to wake.");
          }
          if (agent.status === "ACTIVE" && liveRuntime(agent) !== undefined) {
            return yield* handoffError(
              "snapshot-writer-conflict",
              "This agent already has a live writer on its snapshot. Wait for it to settle instead of attaching another.",
            );
          }
          const side: CloudHandoffSide = {
            surface: "cloud",
            environmentId: agent.environment?.environmentId ?? request.destinationEnvironmentId,
            threadId: liveRuntime(agent)?.threadId ?? request.destinationThreadId ?? null,
            agentId: agent.id,
          };
          const result: CloudHandoffExecuteResult = {
            transferId: request.transferId,
            status: "woke-same-agent",
            direction: request.direction,
            intent: request.intent,
            source: side,
            destination: side,
            appliedPaths: [],
            skippedConflictPaths: [],
            excludedPaths: [],
            history: historyTransfer({ transcriptAvailable: false }),
            appliedAt: DateTime.formatIso(yield* DateTime.now),
          };
          yield* writeRecord({
            transferId: request.transferId,
            status: "applied",
            result: encodeResult(result),
          });
          return result;
        }

        const retained = agent === undefined ? null : yield* retainedForAgent(agent);
        const classified =
          request.direction === "local-to-cloud"
            ? yield* listWorkspaceFiles(workspace)
            : cloudFilesFromPatch(retained?.patch ?? "");
        const selectedSet = selectTransferFiles(classified, request.selectedPaths);
        const incomingPaths = selectedSet.selected.map((file) => file.path);
        yield* fs
          .makeDirectory(transferDirectory(request.transferId), { recursive: true })
          .pipe(
            Effect.mapError(() =>
              handoffError(
                "persistence-failed",
                "The handoff transfer directory could not be created.",
              ),
            ),
          );

        const patch =
          request.direction === "local-to-cloud"
            ? yield* buildLocalPatch({ workspace, selected: selectedSet.selected })
            : (retained?.patch ?? "");
        const fingerprint = NodeCrypto.createHash("sha256").update(patch).digest("hex");
        const existing = yield* readRecord(request.transferId);
        const retry = retryDecision({
          existingFingerprint: existing?.fingerprint,
          incomingFingerprint: fingerprint,
          existingStatus: existing?.status,
        });
        if (retry === "already-applied") {
          if (existing?.result !== undefined) {
            const stored = yield* decodeResult(existing.result).pipe(
              Effect.mapError(() =>
                handoffError("persistence-failed", "The stored handoff result is invalid."),
              ),
            );
            return { ...stored, status: "already-applied" as const };
          }
          return yield* handoffError(
            "persistence-failed",
            "This transfer was already applied, but its stored result is missing.",
          );
        }

        const baseCommit =
          request.direction === "cloud-to-local"
            ? (agent?.baseCommit ?? localHead.commit)
            : localHead.commit;
        yield* ensureDestination({
          sourceWorkspace: workspace,
          destinationWorkspace: request.destinationWorkspacePath,
          baseCommit,
          branchName: `t3-cloud-handoff-${request.transferId.slice(0, 8)}`,
        });
        const destinationDirty = yield* dirtyPaths(request.destinationWorkspacePath);
        const conflicts = detectImportConflicts({
          dirtyLocalPaths: destinationDirty,
          incomingPaths,
        });
        if (conflicts.length > 0 && request.conflictPolicy === "abort") {
          return yield* handoffError(
            "dirty-conflict",
            "Import refused to overwrite dirty local files.",
            conflicts,
          );
        }
        const skipped = new Set(
          request.conflictPolicy === "skip-conflicting" ? conflicts.map((entry) => entry.path) : [],
        );
        const appliedFiles = selectedSet.selected.filter((file) => !skipped.has(file.path));

        yield* writeRecord({
          transferId: request.transferId,
          status: "applying",
          fingerprint,
        });
        yield* atomicWrite(
          path.join(transferDirectory(request.transferId), PATCH_FILE),
          patch,
        ).pipe(
          Effect.mapError(() =>
            handoffError("persistence-failed", "The handoff patch could not be saved."),
          ),
        );
        const applyPatchContents =
          request.direction === "cloud-to-local"
            ? patch
            : yield* buildLocalPatch({ workspace, selected: appliedFiles });
        if (appliedFiles.length > 0) {
          yield* applyPatch({
            destinationWorkspace: request.destinationWorkspacePath,
            patch: applyPatchContents,
            excludePaths: [...skipped],
          });
          if (request.direction === "cloud-to-local") {
            const incoming = parsePatchPaths(applyPatchContents);
            const keep = new Set(appliedFiles.map((file) => file.path));
            for (const relativePath of incoming) {
              if (keep.has(relativePath)) continue;
              yield* runGit({
                cwd: request.destinationWorkspacePath,
                args: ["checkout", "HEAD", "--", relativePath],
                allowFailure: true,
              });
              yield* runGit({
                cwd: request.destinationWorkspacePath,
                args: ["clean", "-f", "--", relativePath],
                allowFailure: true,
              });
            }
          }
        }

        const source: CloudHandoffSide =
          request.direction === "local-to-cloud"
            ? {
                surface: "local",
                environmentId: request.sourceEnvironmentId,
                threadId: request.sourceThreadId ?? null,
                workspacePath: workspace,
              }
            : {
                surface: "cloud",
                environmentId: agent?.environment?.environmentId ?? request.sourceEnvironmentId,
                threadId: liveRuntime(agent)?.threadId ?? request.sourceThreadId ?? null,
                ...(agent === undefined ? {} : { agentId: agent.id }),
              };
        const destination: CloudHandoffSide =
          request.direction === "cloud-to-local"
            ? {
                surface: "local",
                environmentId: request.destinationEnvironmentId,
                threadId: request.destinationThreadId ?? null,
                workspacePath: request.destinationWorkspacePath,
              }
            : {
                surface: "cloud",
                environmentId:
                  agent?.environment?.environmentId ?? request.destinationEnvironmentId,
                threadId: request.destinationThreadId ?? null,
                workspacePath: request.destinationWorkspacePath,
                ...(agent === undefined ? {} : { agentId: agent.id }),
              };
        const result: CloudHandoffExecuteResult = {
          transferId: request.transferId,
          status: "applied",
          direction: request.direction,
          intent: request.intent,
          source,
          destination,
          appliedPaths: appliedFiles.map((file) => file.path),
          skippedConflictPaths: [...skipped],
          excludedPaths: selectedSet.excluded.map((file) => file.path),
          history: historyTransfer({ transcriptAvailable: retained?.transcriptAvailable === true }),
          patchFingerprint: fingerprint,
          appliedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* writeRecord({
          transferId: request.transferId,
          status: "applied",
          fingerprint,
          result: encodeResult(result),
        });
        return result;
      }),
    );
  });

  return CloudHandoff.of({ preview, execute });
});

export const layer = Layer.effect(
  CloudHandoff,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const allocations = yield* CloudAllocationController.CloudAllocationController;
    const results = yield* CloudRunResults.CloudRunResults;
    return yield* make({
      handoffsRoot: path.join(config.stateDir, "cloud-handoffs"),
      readSnapshot: allocations.snapshot.pipe(
        Effect.mapError(() =>
          handoffError("persistence-failed", "The cloud allocation catalog is unavailable."),
        ),
      ),
      readRetainedDiff: (resultId) =>
        results.status(resultId).pipe(
          Effect.flatMap((status) =>
            status.status === "retained"
              ? Effect.gen(function* () {
                  const patch = yield* results.readText(resultId, "diff");
                  const transcript = yield* results
                    .readText(resultId, "transcript")
                    .pipe(Effect.orElseSucceed(() => ""));
                  return {
                    patch,
                    transcriptAvailable: transcript.trim().length > 0,
                  };
                })
              : Effect.succeed(null),
          ),
          Effect.orElseSucceed(() => null),
        ),
    });
  }),
);
