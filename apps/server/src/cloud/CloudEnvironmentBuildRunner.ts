/**
 * Runs one Build: resolve the default refs, clone them, run the environment's
 * `install` to completion, and leave the prepared tree behind as a snapshot a
 * later run boots instead of cloning and installing on its own.
 *
 * The base stage records the base the snapshot was made on rather than packing
 * an image; packing Linux runtimes is CA-44. Because the base is part of the
 * config, and the config is part of the fingerprint, changing it invalidates
 * the snapshot here even though this stage does not build it.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  admitCloudEnvironmentBuild,
  cloudEnvironmentBase,
  type CloudEnvironmentBuild,
  CloudEnvironmentBuildError,
  type CloudEnvironmentBuildGitSetup,
  type CloudEnvironmentBuildId,
  type CloudEnvironmentBuildSnapshot,
  type CloudEnvironmentBuildStage,
  type CloudEnvironmentBuildTimings,
  type CloudEnvironmentBuildTrigger,
  type CloudEnvironmentVersion,
  type CloudRepositoryCommandResult,
  type CloudRunStageTiming,
  injectCloudEnvironmentSecrets,
  missingCloudEnvironmentSecrets,
  NonNegativeInt,
  redactCloudEnvironmentSecretOutput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { CloudEnvironmentBuildCatalog } from "./CloudEnvironmentBuildCatalog.ts";
import {
  cloudEnvironmentBuildFingerprint,
  planCloudEnvironmentBuild,
} from "./cloudEnvironmentBuildPolicy.ts";
import * as CloudGitCredentials from "./CloudGitCredentials.ts";

const MAX_LOG_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_INSTALL_TIMEOUT_SECONDS = 30 * 60;

export interface CloudEnvironmentBuildRunInput {
  readonly buildId: CloudEnvironmentBuildId;
  readonly version: CloudEnvironmentVersion;
  readonly trigger: CloudEnvironmentBuildTrigger;
  /** Agent-requested Builds are draft; a person saving one is what activates it. */
  readonly draft: boolean;
  readonly occurredAt: string;
  /**
   * Values keyed by secret reference. Only Build-only, non-user secrets are
   * injected into `install`. Runtime and user secrets stay off the snapshot.
   */
  readonly secretValues?: Readonly<Record<string, string>>;
  /**
   * Runs once the record exists. A caller that must answer before the Build
   * finishes, such as an RPC, uses this to hand back the running record.
   */
  readonly onStarted?: (build: CloudEnvironmentBuild) => Effect.Effect<void>;
}

export class CloudEnvironmentBuildRunner extends Context.Service<
  CloudEnvironmentBuildRunner,
  {
    readonly run: (
      input: CloudEnvironmentBuildRunInput,
    ) => Effect.Effect<CloudEnvironmentBuild, CloudEnvironmentBuildError>;
    /** Absolute path of a successful Build's prepared tree. */
    readonly snapshotPath: (snapshotId: string) => string;
  }
>()("t3/cloud/CloudEnvironmentBuildRunner") {}

/** Carries the stage so a failure is recorded against the step that failed. */
interface StageFailure {
  readonly stage: CloudEnvironmentBuildStage;
  readonly message: string;
}

/** Timings fill in as stages complete, so the record survives a mid-run failure. */
interface MutableTimings {
  base?: CloudRunStageTiming;
  clone?: CloudRunStageTiming;
  install?: CloudRunStageTiming;
  snapshot?: CloudRunStageTiming;
}

/** `set -e` makes a multi-line `install` stop at its first failing command. */
function installScript(install: string, platform: string): string {
  return platform === "win32" ? `@echo off\r\n${install}\r\n` : `set -e\n${install}\n`;
}

/** Repository names reach the filesystem, so flatten them to one safe segment. */
function workspaceSegment(repository: string): string {
  return repository.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
}

export const make = Effect.fn("CloudEnvironmentBuildRunner.make")(function* (input: {
  readonly buildRoot: string;
  readonly installTimeoutSeconds?: number;
}) {
  const catalog = yield* CloudEnvironmentBuildCatalog;
  const credentials = yield* CloudGitCredentials.CloudGitCredentials;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const mutex = yield* Semaphore.make(1);
  const installTimeoutSeconds = input.installTimeoutSeconds ?? DEFAULT_INSTALL_TIMEOUT_SECONDS;

  const snapshotPath = (snapshotId: string) => path.join(input.buildRoot, snapshotId);
  /** Sibling of the prepared trees, so install scripts never enter a snapshot. */
  const scriptsRoot = path.join(input.buildRoot, ".scripts");

  const stageFailed = (stage: CloudEnvironmentBuildStage, message: string) =>
    Effect.fail<StageFailure>({ stage, message });

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const timing = (startedAt: string, completedAt: string): CloudRunStageTiming => ({
    startedAt,
    completedAt,
    durationMs: NonNegativeInt.make(Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))),
  });

  const resolveGitSetup = Effect.fn("CloudEnvironmentBuildRunner.resolveGitSetup")(function* (
    version: CloudEnvironmentVersion,
    runId: string,
  ): Effect.fn.Return<ReadonlyArray<CloudEnvironmentBuildGitSetup>, StageFailure> {
    const entries: Array<CloudEnvironmentBuildGitSetup> = [];
    for (const repository of version.repositories) {
      const commit = yield* credentials
        .resolveRef({ runId, repository: repository.repository, ref: repository.defaultRef })
        .pipe(
          Effect.mapError((cause): StageFailure => ({
            stage: "clone",
            message: `Could not resolve '${repository.repository}' at '${repository.defaultRef}': ${cause.message}`,
          })),
        );
      entries.push({
        repository: repository.repository,
        defaultRef: repository.defaultRef,
        commit,
      });
    }
    return entries;
  });

  const runGit = Effect.fn("CloudEnvironmentBuildRunner.runGit")(function* (request: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly message: string;
  }): Effect.fn.Return<void, StageFailure> {
    const result = yield* runner
      .run({
        command: "git",
        args: request.args,
        cwd: request.cwd,
        timeout: "2 minutes",
        maxOutputBytes: MAX_LOG_OUTPUT_BYTES,
        outputMode: "truncate",
      })
      .pipe(Effect.mapError((): StageFailure => ({ stage: "clone", message: request.message })));
    if (result.code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* stageFailed("clone", request.message);
    }
  });

  /**
   * Clones every repository as a sibling under the Build directory and pins
   * each to the commit the fingerprint was taken from, so the snapshot and its
   * `gitSetup` cannot disagree.
   */
  const cloneRepositories = Effect.fn("CloudEnvironmentBuildRunner.cloneRepositories")(
    function* (request: {
      readonly buildDirectory: string;
      readonly gitSetup: ReadonlyArray<CloudEnvironmentBuildGitSetup>;
      readonly runId: string;
    }): Effect.fn.Return<void, StageFailure> {
      for (const entry of request.gitSetup) {
        const destination = path.join(request.buildDirectory, workspaceSegment(entry.repository));
        yield* credentials
          .clone({ runId: request.runId, repository: entry.repository, destination })
          .pipe(
            Effect.mapError((cause): StageFailure => ({ stage: "clone", message: cause.message })),
          );
        yield* credentials
          .fetch({
            runId: request.runId,
            repository: entry.repository,
            ref: entry.commit,
            cwd: destination,
          })
          .pipe(
            Effect.mapError((cause): StageFailure => ({ stage: "clone", message: cause.message })),
          );
        yield* runGit({
          cwd: destination,
          args: ["checkout", "--detach", entry.commit],
          message: `Build could not check out '${entry.repository}' at ${entry.commit}.`,
        });
      }
    },
  );

  /**
   * `install` is a shell string in the environment config, so it needs a shell.
   * It runs from a script file rather than an inline argument: passing a shell
   * string as one spawn argument is mangled by Windows' quoting rules, where a
   * quoted command silently exits 0 without running. The primary repository is
   * the working directory; the rest are siblings. The log is recorded whether
   * the command succeeds or fails.
   */
  const runInstall = Effect.fn("CloudEnvironmentBuildRunner.runInstall")(function* (request: {
    readonly buildId: CloudEnvironmentBuildId;
    readonly cwd: string;
    readonly install: string;
    readonly secretEnv: Readonly<Record<string, string>>;
    readonly redact: ReadonlyArray<string>;
    readonly logs: Array<CloudRepositoryCommandResult>;
  }): Effect.fn.Return<void, StageFailure> {
    const startedAt = yield* now;
    const scriptPath = path.join(
      scriptsRoot,
      `${request.buildId}.${platform === "win32" ? "cmd" : "sh"}`,
    );
    yield* fs.makeDirectory(scriptsRoot, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(scriptPath, installScript(request.install, platform))),
      Effect.mapError((): StageFailure => ({
        stage: "install",
        message: "The Build could not write the environment's 'install' script.",
      })),
    );
    const shell =
      platform === "win32"
        ? { command: "cmd.exe", args: ["/d", "/s", "/c", scriptPath] }
        : { command: "/bin/sh", args: [scriptPath] };
    const result = yield* runner
      .run({
        command: shell.command,
        args: shell.args,
        cwd: request.cwd,
        env: { CI: "1", GIT_TERMINAL_PROMPT: "0", ...request.secretEnv },
        timeout: Duration.seconds(installTimeoutSeconds),
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: MAX_LOG_OUTPUT_BYTES,
        outputMode: "truncate",
        truncatedMarker: "\n[output truncated]",
      })
      .pipe(
        Effect.mapError((cause): StageFailure => ({
          stage: "install",
          message:
            cause._tag === "ProcessSpawnError"
              ? "The Build host has no shell to run 'install' with."
              : "The Build could not run the environment's 'install' command.",
        })),
      );
    yield* fs.remove(scriptPath, { force: true }).pipe(Effect.ignore);
    request.logs.push({
      name: "install",
      command: shell.command,
      args: shell.args,
      startedAt,
      completedAt: yield* now,
      exitCode: result.code,
      timedOut: result.timedOut,
      stdout: redactCloudEnvironmentSecretOutput(result.stdout, request.redact),
      stderr: redactCloudEnvironmentSecretOutput(result.stderr, request.redact),
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    });
    if (result.timedOut) {
      return yield* stageFailed(
        "install",
        `The environment's 'install' exceeded ${installTimeoutSeconds} seconds. It must terminate.`,
      );
    }
    if (result.code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* stageFailed(
        "install",
        `The environment's 'install' exited with code ${result.code}.`,
      );
    }
  });

  /**
   * Walks the prepared tree once for both size and identity. The digest covers
   * the file layout, not file contents, which is what a restore needs to notice
   * a partially copied snapshot without rehashing a dependency tree.
   */
  const measureSnapshot = Effect.fn("CloudEnvironmentBuildRunner.measureSnapshot")(function* (
    root: string,
  ): Effect.fn.Return<{ readonly digest: string; readonly sizeBytes: number }, StageFailure> {
    const manifest: Array<string> = [];
    let sizeBytes = 0;
    const walk = Effect.fn("CloudEnvironmentBuildRunner.walk")(function* (
      directory: string,
      prefix: string,
    ): Effect.fn.Return<void, StageFailure> {
      const names = yield* fs.readDirectory(directory).pipe(
        Effect.mapError((): StageFailure => ({
          stage: "snapshot",
          message: "The Build could not read its prepared tree.",
        })),
      );
      for (const name of [...names].sort()) {
        const entryPath = path.join(directory, name);
        const relative = prefix === "" ? name : `${prefix}/${name}`;
        const info = yield* fs.stat(entryPath).pipe(Effect.option);
        if (info._tag === "None") continue;
        if (info.value.type === "Directory") {
          yield* walk(entryPath, relative);
          continue;
        }
        if (info.value.type !== "File") continue;
        const size = Number(info.value.size);
        sizeBytes += size;
        manifest.push(`${relative}:${size}`);
      }
    });
    yield* walk(root, "");
    return {
      digest: NodeCrypto.createHash("sha256").update(manifest.join("\n")).digest("hex"),
      sizeBytes,
    };
  });

  const discard = (directory: string) =>
    fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);

  const prepareTree = Effect.fn("CloudEnvironmentBuildRunner.prepareTree")(function* (request: {
    readonly buildId: CloudEnvironmentBuildId;
    readonly version: CloudEnvironmentVersion;
    readonly gitSetup: ReadonlyArray<CloudEnvironmentBuildGitSetup>;
    readonly runId: string;
    readonly secretEnv: Readonly<Record<string, string>>;
    readonly redact: ReadonlyArray<string>;
    readonly logs: Array<CloudRepositoryCommandResult>;
    readonly timings: MutableTimings;
  }): Effect.fn.Return<CloudEnvironmentBuildSnapshot, StageFailure> {
    const buildDirectory = snapshotPath(request.buildId);

    const baseStartedAt = yield* now;
    yield* discard(buildDirectory);
    yield* fs.makeDirectory(buildDirectory, { recursive: true }).pipe(
      Effect.mapError((): StageFailure => ({
        stage: "base",
        message: "The Build could not create its prepared tree.",
      })),
    );
    request.timings.base = timing(baseStartedAt, yield* now);

    const cloneStartedAt = yield* now;
    yield* cloneRepositories({ buildDirectory, gitSetup: request.gitSetup, runId: request.runId });
    request.timings.clone = timing(cloneStartedAt, yield* now);

    const primary = request.gitSetup[0];
    if (primary === undefined) {
      return yield* stageFailed("clone", "The environment has no repository to prepare.");
    }

    const install = request.version.config.install?.trim();
    if (install !== undefined && install.length > 0) {
      const installStartedAt = yield* now;
      yield* runInstall({
        buildId: request.buildId,
        cwd: path.join(buildDirectory, workspaceSegment(primary.repository)),
        install,
        secretEnv: request.secretEnv,
        redact: request.redact,
        logs: request.logs,
      });
      request.timings.install = timing(installStartedAt, yield* now);
    }

    const snapshotStartedAt = yield* now;
    const measured = yield* measureSnapshot(buildDirectory);
    const snapshotCompletedAt = yield* now;
    request.timings.snapshot = timing(snapshotStartedAt, snapshotCompletedAt);
    return {
      id: request.buildId,
      digest: measured.digest,
      sizeBytes: NonNegativeInt.make(measured.sizeBytes),
      createdAt: snapshotCompletedAt,
    };
  });

  const run: CloudEnvironmentBuildRunner["Service"]["run"] = (request) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const version = request.version;
        const runId = `build:${request.buildId}`;
        const admission = admitCloudEnvironmentBuild({ version });
        if (admission.status === "rejected") {
          return yield* new CloudEnvironmentBuildError({
            reason: "admission-rejected",
            message: admission.message,
          });
        }
        const secretValues = request.secretValues ?? {};
        const injected = injectCloudEnvironmentSecrets({
          phase: "build",
          secrets: version.secretReferences,
          values: secretValues,
        });
        const missing = missingCloudEnvironmentSecrets({
          phase: "build",
          secrets: version.secretReferences,
          values: secretValues,
        });
        if (missing.length > 0) {
          return yield* new CloudEnvironmentBuildError({
            reason: "admission-rejected",
            message: `Build-only secret '${missing[0]!.name}' is unavailable.`,
          });
        }
        const activeBuild = yield* catalog.activeBuild(version.environmentId);

        const resolved = yield* Effect.result(resolveGitSetup(version, runId));
        const gitSetup = Result.isSuccess(resolved) ? resolved.success : [];
        const fingerprint = cloudEnvironmentBuildFingerprint({
          versionId: version.id,
          config: version.config,
          secretReferences: version.secretReferences,
          gitSetup,
        });
        const plan = planCloudEnvironmentBuild({
          trigger: request.trigger,
          fingerprint,
          activeBuild,
        });

        const started = yield* catalog.start({
          buildId: request.buildId,
          version,
          trigger: request.trigger,
          draft: request.draft,
          base: cloudEnvironmentBase(version.config),
          inputsFingerprint: fingerprint,
          startedAt: request.occurredAt,
        });
        if (request.onStarted !== undefined) yield* request.onStarted(started);
        // A reused id means this Build already ran; never settle it twice.
        if (started.outcome.status !== "running") return started;

        if (Result.isFailure(resolved)) {
          return yield* catalog.complete({
            buildId: request.buildId,
            gitSetup,
            logs: [],
            timings: {},
            outcome: {
              status: "failed",
              stage: resolved.failure.stage,
              message: resolved.failure.message,
              completedAt: yield* now,
            },
          });
        }

        if (plan.action === "skip") {
          return yield* catalog.complete({
            buildId: request.buildId,
            gitSetup,
            logs: [],
            timings: {},
            outcome: {
              status: "skipped",
              reusedBuildId: plan.reusedBuildId,
              completedAt: yield* now,
            },
          });
        }

        const logs: Array<CloudRepositoryCommandResult> = [];
        const timings: MutableTimings = {};
        const prepared = yield* Effect.result(
          prepareTree({
            buildId: request.buildId,
            version,
            gitSetup,
            runId,
            secretEnv: injected.env,
            redact: injected.redact,
            logs,
            timings,
          }),
        );
        const completedAt = yield* now;
        if (Result.isFailure(prepared)) {
          yield* discard(snapshotPath(request.buildId));
          return yield* catalog.complete({
            buildId: request.buildId,
            gitSetup,
            logs,
            timings: timings satisfies CloudEnvironmentBuildTimings,
            outcome: {
              status: "failed",
              stage: prepared.failure.stage,
              message: prepared.failure.message,
              completedAt,
            },
          });
        }
        return yield* catalog.complete({
          buildId: request.buildId,
          gitSetup,
          logs,
          timings: timings satisfies CloudEnvironmentBuildTimings,
          outcome: { status: "succeeded", snapshot: prepared.success, completedAt },
        });
      }),
    );

  return CloudEnvironmentBuildRunner.of({ run, snapshotPath });
});

export const layer = Layer.effect(
  CloudEnvironmentBuildRunner,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const buildRoot = yield* Config.string("T3CODE_CLOUD_BUILD_DIR").pipe(
      Config.withDefault(path.join(config.worktreesDir, "cloud-builds")),
    );
    const installTimeoutSeconds = yield* Config.int(
      "T3CODE_CLOUD_BUILD_INSTALL_TIMEOUT_SECONDS",
    ).pipe(Config.withDefault(DEFAULT_INSTALL_TIMEOUT_SECONDS));
    return yield* make({
      buildRoot,
      installTimeoutSeconds: Math.max(1, installTimeoutSeconds),
    });
  }),
);
