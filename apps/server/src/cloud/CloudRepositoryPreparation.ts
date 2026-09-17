// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  CloudRepositoryPreparationError,
  CloudRepositoryCommand,
  type CloudRepositoryCommand as CloudRepositoryCommandType,
  type CloudRepositoryCommandResult,
  type CloudRepositoryDependencyCache,
  type CloudRepositoryPreparationInput,
  type CloudRepositoryPreparationRecord,
  type CloudRepositoryRecipe,
  type CloudRepositoryVerificationRecord,
  CloudWorkerStartupTimings,
  IsoDateTime,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CloudGitCredentials from "./CloudGitCredentials.ts";

const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_CACHE_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_CACHE_MAX_ENTRIES = 8;
const CACHE_MANIFEST_FILE = "manifest.json";
const INSTRUCTION_FILE_NAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "copilot-instructions.md",
]);
const RESERVED_SECRET_PREFIXES = ["AWS_", "GH_", "GIT_", "SSH_", "T3CODE_"] as const;
const CACHE_INPUT_FILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "deno.lock",
  "Gemfile.lock",
  "go.sum",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "Pipfile.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "poetry.lock",
  "requirements.txt",
  "uv.lock",
  "yarn.lock",
]);

const CacheInputFile = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const DependencyCacheInputs = Schema.Struct({
  repository: Schema.String,
  recipeVersion: Schema.Literal(1),
  setupHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  inputFiles: Schema.Array(CacheInputFile),
  imageVersion: Schema.String,
  platform: Schema.Struct({
    os: Schema.String,
    arch: Schema.String,
    nodeVersion: Schema.String,
  }),
});
type DependencyCacheInputs = typeof DependencyCacheInputs.Type;
const DependencyCacheManifest = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literals(["building", "ready"]),
  key: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime,
  inputs: DependencyCacheInputs,
});
type DependencyCacheManifest = typeof DependencyCacheManifest.Type;
const decodeCacheManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(DependencyCacheManifest),
);
const encodeCacheInputs = Schema.encodeSync(Schema.fromJsonString(DependencyCacheInputs));
const encodeCacheManifest = Schema.encodeSync(Schema.fromJsonString(DependencyCacheManifest));
const encodeSetupCommands = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(CloudRepositoryCommand)),
);
const decodeWorkerStartupTimings = Schema.decodeUnknownOption(
  Schema.fromJsonString(CloudWorkerStartupTimings),
);

interface DependencyCacheRuntime {
  readonly imageVersion: string;
  readonly os: string;
  readonly arch: string;
  readonly nodeVersion: string;
}

interface DependencyCacheOptions {
  readonly root: string;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly runtime: DependencyCacheRuntime;
}

interface PreparedDependencyCache {
  readonly key: string;
  readonly entryPath: string;
  readonly manifest: DependencyCacheManifest;
  readonly outcome: CloudRepositoryDependencyCache["outcome"];
}

export class CloudRepositoryPreparation extends Context.Service<
  CloudRepositoryPreparation,
  {
    readonly prepare: (
      input: CloudRepositoryPreparationInput,
    ) => Effect.Effect<CloudRepositoryPreparationRecord, CloudRepositoryPreparationError>;
    readonly verify: (input: {
      readonly preparation: CloudRepositoryPreparationRecord;
      readonly deadline: string;
    }) => Effect.Effect<CloudRepositoryVerificationRecord, CloudRepositoryPreparationError>;
  }
>()("t3/cloud/CloudRepositoryPreparation") {}

function preparationError(input: {
  readonly reason: CloudRepositoryPreparationError["reason"];
  readonly stage: CloudRepositoryPreparationError["stage"];
  readonly message: string;
  readonly commandResults?: ReadonlyArray<CloudRepositoryCommandResult>;
}): CloudRepositoryPreparationError {
  return new CloudRepositoryPreparationError({
    reason: input.reason,
    stage: input.stage,
    message: input.message,
    commandResults: input.commandResults ?? [],
  });
}

function safeTaskEnvironment(
  cacheEnvironment?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const inheritedNames = [
    "PATH",
    "Path",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "ComSpec",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ] as const;
  const environment: NodeJS.ProcessEnv = { CI: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (cacheEnvironment !== undefined) Object.assign(environment, cacheEnvironment);
  return environment;
}

function sha256(value: string | Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function stageTiming(startedAt: DateTime.Utc, completedAt: DateTime.Utc) {
  return {
    startedAt: DateTime.formatIso(startedAt),
    completedAt: DateTime.formatIso(completedAt),
    durationMs: Math.max(
      0,
      DateTime.toEpochMillis(completedAt) - DateTime.toEpochMillis(startedAt),
    ),
  };
}

function validateRecipe(recipe: CloudRepositoryRecipe): string | null {
  const prefix = recipe.outputBranchPrefix;
  if (
    prefix.startsWith("/") ||
    prefix.endsWith("/") ||
    prefix.endsWith(".") ||
    prefix.endsWith(".lock") ||
    prefix.includes("..") ||
    prefix.includes("@{") ||
    prefix.includes("//") ||
    prefix.split("/").some((part) => part.startsWith("."))
  ) {
    return `Output branch prefix '${prefix}' is invalid.`;
  }

  const commandNames = new Set<string>();
  for (const command of [
    ...recipe.setup,
    ...recipe.verification,
    ...recipe.devServers.map((server) => server.command),
  ]) {
    if (commandNames.has(command.name)) return `Command name '${command.name}' is duplicated.`;
    commandNames.add(command.name);
  }

  const devServerNames = new Set<string>();
  const ports = new Set<number>();
  for (const server of recipe.devServers) {
    if (devServerNames.has(server.name)) return `Dev server name '${server.name}' is duplicated.`;
    if (ports.has(server.port)) return `Dev server port ${server.port} is duplicated.`;
    devServerNames.add(server.name);
    ports.add(server.port);
  }

  const environmentVariables = new Set<string>();
  const references = new Set<string>();
  for (const secret of recipe.secretReferences) {
    if (RESERVED_SECRET_PREFIXES.some((prefix) => secret.environmentVariable.startsWith(prefix))) {
      return `Secret environment variable '${secret.environmentVariable}' uses a reserved prefix.`;
    }
    if (environmentVariables.has(secret.environmentVariable)) {
      return `Secret environment variable '${secret.environmentVariable}' is duplicated.`;
    }
    if (references.has(secret.reference)) {
      return `Secret reference '${secret.reference}' is duplicated.`;
    }
    environmentVariables.add(secret.environmentVariable);
    references.add(secret.reference);
  }
  return null;
}

function outputBranch(input: CloudRepositoryPreparationInput): string {
  const suffix = NodeCrypto.createHash("sha256")
    .update(`${input.allocationId}:${input.attempt}`)
    .digest("hex")
    .slice(0, 12);
  return `${input.recipe.outputBranchPrefix}/${suffix}`;
}

function workspaceName(input: CloudRepositoryPreparationInput): string {
  return NodeCrypto.createHash("sha256")
    .update(`${input.allocationId}:${input.attempt}`)
    .digest("hex")
    .slice(0, 24);
}

function gitFailure(stage: "clone" | "checkout" | "setup", message: string) {
  return preparationError({ reason: "git-failed", stage, message });
}

export const make = Effect.fn("CloudRepositoryPreparation.make")(function* (input: {
  readonly workspaceRoot: string;
  readonly dependencyCache?: DependencyCacheOptions;
  readonly startupTimingsPath?: string;
}) {
  const credentials = yield* CloudGitCredentials.CloudGitCredentials;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  const cacheMutex = yield* Semaphore.make(1);
  const dependencyCache =
    input.dependencyCache ??
    ({
      root: path.join(path.dirname(input.workspaceRoot), "cloud-dependencies"),
      maxEntries: DEFAULT_CACHE_MAX_ENTRIES,
      maxBytes: DEFAULT_CACHE_MAX_BYTES,
      runtime: {
        imageVersion: "development",
        os: hostPlatform,
        arch: hostArchitecture,
        nodeVersion: process.version,
      },
    } satisfies DependencyCacheOptions);

  const filesystemError = (stage: "clone" | "setup", message: string) =>
    preparationError({ reason: "filesystem-failed", stage, message });

  const readStartupTimings = Effect.fn("CloudRepositoryPreparation.readStartupTimings")(
    function* () {
      if (input.startupTimingsPath === undefined) return undefined;
      return yield* fs.readFileString(input.startupTimingsPath).pipe(
        Effect.map((contents) => Option.getOrUndefined(decodeWorkerStartupTimings(contents))),
        Effect.orElseSucceed(() => undefined),
      );
    },
  );

  const directorySize = Effect.fn("CloudRepositoryPreparation.directorySize")(function* (
    directory: string,
  ): Effect.fn.Return<number, CloudRepositoryPreparationError> {
    const children = yield* fs
      .readDirectory(directory)
      .pipe(
        Effect.mapError(() =>
          filesystemError("setup", "Could not inspect dependency cache usage."),
        ),
      );
    let total = 0;
    for (const child of children) {
      const childPath = path.join(directory, child);
      const info = yield* fs
        .stat(childPath)
        .pipe(
          Effect.mapError(() =>
            filesystemError("setup", "Could not inspect dependency cache usage."),
          ),
        );
      if (info.type === "Directory") total += yield* directorySize(childPath);
      if (info.type === "File") total += Number(info.size);
    }
    return total;
  });

  const readCacheManifest = Effect.fn("CloudRepositoryPreparation.readCacheManifest")(function* (
    entryPath: string,
  ) {
    return yield* fs.readFileString(path.join(entryPath, CACHE_MANIFEST_FILE)).pipe(
      Effect.map((contents) => Option.getOrUndefined(decodeCacheManifest(contents))),
      Effect.orElseSucceed(() => undefined),
    );
  });

  const writeCacheManifest = Effect.fn("CloudRepositoryPreparation.writeCacheManifest")(function* (
    entryPath: string,
    manifest: DependencyCacheManifest,
  ) {
    yield* fs
      .writeFileString(
        path.join(entryPath, CACHE_MANIFEST_FILE),
        `${encodeCacheManifest(manifest)}\n`,
        {
          mode: 0o600,
        },
      )
      .pipe(
        Effect.mapError(() =>
          filesystemError("setup", "Could not write dependency cache metadata."),
        ),
      );
  });

  const makeCacheEntry = Effect.fn("CloudRepositoryPreparation.makeCacheEntry")(function* (input: {
    readonly entryPath: string;
    readonly key: string;
    readonly inputs: DependencyCacheInputs;
    readonly createdAt: string;
  }) {
    yield* fs
      .makeDirectory(input.entryPath, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(() =>
          filesystemError("setup", "Could not create the dependency cache entry."),
        ),
      );
    for (const directory of ["bun", "npm", "pip", "pnpm", "uv", "yarn"]) {
      yield* fs
        .makeDirectory(path.join(input.entryPath, directory), {
          recursive: true,
          mode: 0o700,
        })
        .pipe(
          Effect.mapError(() =>
            filesystemError("setup", "Could not create package-manager cache storage."),
          ),
        );
    }
    const manifest = {
      version: 1,
      state: "building",
      key: input.key,
      createdAt: input.createdAt,
      lastUsedAt: input.createdAt,
      inputs: input.inputs,
    } satisfies DependencyCacheManifest;
    yield* writeCacheManifest(input.entryPath, manifest);
    return manifest;
  });

  const cacheEnvironment = (entryPath: string): Readonly<Record<string, string>> => ({
    BUN_INSTALL_CACHE_DIR: path.join(entryPath, "bun"),
    NPM_CONFIG_CACHE: path.join(entryPath, "npm"),
    NPM_CONFIG_STORE_DIR: path.join(entryPath, "pnpm"),
    PIP_CACHE_DIR: path.join(entryPath, "pip"),
    UV_CACHE_DIR: path.join(entryPath, "uv"),
    YARN_CACHE_FOLDER: path.join(entryPath, "yarn"),
  });

  const sweepCache = Effect.fn("CloudRepositoryPreparation.sweepCache")(function* (
    currentKey: string,
  ) {
    const names = yield* fs
      .readDirectory(dependencyCache.root)
      .pipe(
        Effect.mapError(() =>
          filesystemError("setup", "Could not inspect dependency cache entries."),
        ),
      );
    const entries: Array<{
      readonly key: string;
      readonly entryPath: string;
      readonly lastUsedAt: number;
      readonly sizeBytes: number;
    }> = [];
    let evictedEntries = 0;
    for (const key of names.filter((name) => /^[a-f0-9]{64}$/.test(name))) {
      const entryPath = path.join(dependencyCache.root, key);
      const info = yield* fs.stat(entryPath).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "Directory") continue;
      const manifest = yield* readCacheManifest(entryPath);
      if (manifest === undefined || manifest.key !== key || manifest.state !== "ready") {
        yield* fs
          .remove(entryPath, { recursive: true, force: true })
          .pipe(
            Effect.mapError(() =>
              filesystemError("setup", "Could not remove an invalid dependency cache entry."),
            ),
          );
        evictedEntries += 1;
        continue;
      }
      entries.push({
        key,
        entryPath,
        lastUsedAt: Date.parse(manifest.lastUsedAt),
        sizeBytes: yield* directorySize(entryPath),
      });
    }
    entries.sort((left, right) => {
      if (left.key === currentKey) return 1;
      if (right.key === currentKey) return -1;
      return left.lastUsedAt - right.lastUsedAt || left.key.localeCompare(right.key);
    });
    let totalBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
    while (
      entries.length > dependencyCache.maxEntries ||
      (entries.length > 0 && totalBytes > dependencyCache.maxBytes)
    ) {
      const entry = entries.shift();
      if (entry === undefined) break;
      yield* fs
        .remove(entry.entryPath, { recursive: true, force: true })
        .pipe(
          Effect.mapError(() =>
            filesystemError("setup", "Could not evict an expired dependency cache entry."),
          ),
        );
      totalBytes -= entry.sizeBytes;
      evictedEntries += 1;
    }
    return evictedEntries;
  });

  const runGit = Effect.fn("CloudRepositoryPreparation.runGit")(function* (request: {
    readonly stage: "clone" | "checkout" | "setup";
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly message: string;
  }) {
    const result = yield* runner
      .run({
        command: "git",
        args: request.args,
        cwd: request.cwd,
        timeout: "2 minutes",
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        outputMode: "truncate",
      })
      .pipe(Effect.mapError(() => gitFailure(request.stage, request.message)));
    if (result.code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* gitFailure(request.stage, request.message);
    }
    return result.stdout.trim();
  });

  const runCommands = Effect.fn("CloudRepositoryPreparation.runCommands")(function* (request: {
    readonly stage: "setup" | "verification";
    readonly workspacePath: string;
    readonly commands: ReadonlyArray<CloudRepositoryCommandType>;
    readonly deadline: string;
    readonly environment?: Readonly<Record<string, string>>;
  }) {
    const results: CloudRepositoryCommandResult[] = [];
    for (const command of request.commands) {
      const now = yield* DateTime.now;
      const remainingMillis = Date.parse(request.deadline) - DateTime.toEpochMillis(now);
      if (remainingMillis <= 0) {
        return yield* preparationError({
          reason: "deadline-expired",
          stage: request.stage,
          message: `${request.stage === "setup" ? "Setup" : "Verification"} did not finish before its deadline.`,
          commandResults: results,
        });
      }
      const startedAt = DateTime.formatIso(now);
      const commandResult = yield* runner
        .run({
          command: command.command,
          args: command.args,
          cwd: request.workspacePath,
          env: safeTaskEnvironment(request.environment),
          extendEnv: false,
          timeout: Duration.millis(Math.min(command.timeoutSeconds * 1000, remainingMillis)),
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
          outputMode: "truncate",
          truncatedMarker: "\n[output truncated]",
        })
        .pipe(
          Effect.mapError((cause) =>
            preparationError({
              reason: cause._tag === "ProcessSpawnError" ? "dependency-missing" : "command-failed",
              stage: request.stage,
              message:
                cause._tag === "ProcessSpawnError"
                  ? `Required ${request.stage} command '${command.command}' is unavailable.`
                  : `Could not run ${request.stage} command '${command.name}'.`,
              commandResults: results,
            }),
          ),
        );
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      const result: CloudRepositoryCommandResult = {
        name: command.name,
        command: command.command,
        args: command.args,
        startedAt,
        completedAt,
        exitCode: commandResult.code,
        timedOut: commandResult.timedOut,
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
        stdoutTruncated: commandResult.stdoutTruncated,
        stderrTruncated: commandResult.stderrTruncated,
      };
      results.push(result);
      if (commandResult.timedOut || commandResult.code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* preparationError({
          reason: commandResult.timedOut ? "deadline-expired" : "command-failed",
          stage: request.stage,
          message: commandResult.timedOut
            ? `${request.stage === "setup" ? "Setup" : "Verification"} command '${command.name}' exceeded its deadline.`
            : `${request.stage === "setup" ? "Setup" : "Verification"} command '${command.name}' exited with code ${commandResult.code}.`,
          commandResults: results,
        });
      }
    }
    return results;
  });

  const cacheInputs = Effect.fn("CloudRepositoryPreparation.cacheInputs")(function* (request: {
    readonly workspacePath: string;
    readonly trackedFiles: ReadonlyArray<string>;
    readonly recipe: CloudRepositoryRecipe;
  }) {
    const inputFilePaths = request.trackedFiles
      .filter((file) => CACHE_INPUT_FILE_NAMES.has(path.basename(file)))
      .sort();
    const inputFiles = yield* Effect.forEach(inputFilePaths, (file) =>
      fs.readFile(path.join(request.workspacePath, file)).pipe(
        Effect.map((contents) => ({ path: file, sha256: sha256(contents) })),
        Effect.mapError(() =>
          filesystemError("setup", `Could not read dependency cache input '${file}'.`),
        ),
      ),
    );
    return {
      repository: request.recipe.repository,
      recipeVersion: request.recipe.version,
      setupHash: sha256(encodeSetupCommands(request.recipe.setup)),
      inputFiles,
      imageVersion: dependencyCache.runtime.imageVersion,
      platform: {
        os: dependencyCache.runtime.os,
        arch: dependencyCache.runtime.arch,
        nodeVersion: dependencyCache.runtime.nodeVersion,
      },
    } satisfies DependencyCacheInputs;
  });

  const prepareCache = Effect.fn("CloudRepositoryPreparation.prepareCache")(function* (
    inputs: DependencyCacheInputs,
  ) {
    yield* fs
      .makeDirectory(dependencyCache.root, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(() =>
          filesystemError("setup", "Could not create the dependency cache root."),
        ),
      );
    const key = sha256(encodeCacheInputs(inputs));
    const entryPath = path.join(dependencyCache.root, key);
    const now = DateTime.formatIso(yield* DateTime.now);
    const exists = yield* fs
      .exists(entryPath)
      .pipe(
        Effect.mapError(() => filesystemError("setup", "Could not inspect the dependency cache.")),
      );
    const existing = exists ? yield* readCacheManifest(entryPath) : undefined;
    if (
      existing !== undefined &&
      existing.state === "ready" &&
      existing.key === key &&
      encodeCacheInputs(existing.inputs) === encodeCacheInputs(inputs)
    ) {
      const manifest = { ...existing, lastUsedAt: now } satisfies DependencyCacheManifest;
      yield* writeCacheManifest(entryPath, manifest);
      return { key, entryPath, manifest, outcome: "hit" as const };
    }
    if (exists) {
      yield* fs
        .remove(entryPath, { recursive: true, force: true })
        .pipe(
          Effect.mapError(() =>
            filesystemError("setup", "Could not discard an invalid dependency cache entry."),
          ),
        );
    }
    const manifest = yield* makeCacheEntry({ entryPath, key, inputs, createdAt: now });
    return { key, entryPath, manifest, outcome: "miss" as const };
  });

  const rebuildCache = Effect.fn("CloudRepositoryPreparation.rebuildCache")(function* (cache: {
    readonly key: string;
    readonly entryPath: string;
    readonly manifest: DependencyCacheManifest;
  }) {
    yield* fs
      .remove(cache.entryPath, { recursive: true, force: true })
      .pipe(
        Effect.mapError(() =>
          filesystemError("setup", "Could not discard a failed dependency cache entry."),
        ),
      );
    const now = DateTime.formatIso(yield* DateTime.now);
    const manifest = yield* makeCacheEntry({
      entryPath: cache.entryPath,
      key: cache.key,
      inputs: cache.manifest.inputs,
      createdAt: now,
    });
    return { ...cache, manifest, outcome: "rebuilt" as const };
  });

  const resetWorkspace = Effect.fn("CloudRepositoryPreparation.resetWorkspace")(function* (
    workspacePath: string,
  ) {
    yield* runGit({
      stage: "setup",
      cwd: workspacePath,
      args: ["reset", "--hard", "HEAD"],
      message: "The workspace could not be reset after a cached setup failure.",
    });
    yield* runGit({
      stage: "setup",
      cwd: workspacePath,
      args: ["clean", "-ffdx"],
      message: "The workspace could not be cleaned after a cached setup failure.",
    });
  });

  const finishCache = Effect.fn("CloudRepositoryPreparation.finishCache")(function* (
    cache: PreparedDependencyCache,
  ) {
    const manifest = {
      ...cache.manifest,
      state: "ready",
      lastUsedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies DependencyCacheManifest;
    yield* writeCacheManifest(cache.entryPath, manifest);
    const sizeBytes = yield* directorySize(cache.entryPath);
    const evictedEntries = yield* sweepCache(cache.key);
    return {
      key: cache.key,
      outcome: cache.outcome,
      inputFiles: manifest.inputs.inputFiles.map((file) => file.path),
      imageVersion: manifest.inputs.imageVersion,
      platform: manifest.inputs.platform,
      sizeBytes,
      evictedEntries,
    } satisfies CloudRepositoryDependencyCache;
  });

  const prepare: CloudRepositoryPreparation["Service"]["prepare"] = Effect.fn(
    "CloudRepositoryPreparation.prepare",
  )(function* (request) {
    const invalid = validateRecipe(request.recipe);
    if (invalid !== null) {
      return yield* preparationError({
        reason: "invalid-recipe",
        stage: "setup",
        message: invalid,
      });
    }
    if (Date.parse(request.deadline) <= DateTime.toEpochMillis(yield* DateTime.now)) {
      return yield* preparationError({
        reason: "deadline-expired",
        stage: "clone",
        message: "Repository preparation did not start before its deadline.",
      });
    }
    const cloneStartedAt = yield* DateTime.now;

    const workspacePath = path.join(input.workspaceRoot, workspaceName(request));
    const exists = yield* fs.exists(workspacePath).pipe(
      Effect.mapError(() =>
        preparationError({
          reason: "filesystem-failed",
          stage: "clone",
          message: "Could not inspect the repository workspace root.",
        }),
      ),
    );
    if (exists) {
      return yield* preparationError({
        reason: "workspace-conflict",
        stage: "clone",
        message: "This allocation attempt already has a repository workspace.",
      });
    }
    yield* fs.makeDirectory(input.workspaceRoot, { recursive: true }).pipe(
      Effect.mapError(() =>
        preparationError({
          reason: "filesystem-failed",
          stage: "clone",
          message: "Could not create the repository workspace root.",
        }),
      ),
    );

    const runId = `${request.allocationId}:${request.attempt}`;
    yield* credentials
      .clone({
        runId,
        repository: request.recipe.repository,
        destination: workspacePath,
      })
      .pipe(
        Effect.mapError((cause) =>
          preparationError({
            reason: "credential-failed",
            stage: "clone",
            message: cause.message,
          }),
        ),
      );
    yield* credentials
      .fetch({
        runId,
        repository: request.recipe.repository,
        ref: request.selectedRef,
        cwd: workspacePath,
      })
      .pipe(
        Effect.mapError((cause) =>
          preparationError({
            reason: "credential-failed",
            stage: "clone",
            message: cause.message,
          }),
        ),
      );

    const resolvedCommit = yield* runGit({
      stage: "checkout",
      cwd: workspacePath,
      args: ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
      message: `The selected ref '${request.selectedRef}' did not resolve to a commit.`,
    });
    const branch = outputBranch(request);
    yield* runGit({
      stage: "checkout",
      cwd: workspacePath,
      args: ["check-ref-format", "--branch", branch],
      message: "The configured output branch prefix produced an invalid Git branch.",
    });
    yield* runGit({
      stage: "checkout",
      cwd: workspacePath,
      args: ["checkout", "--detach", resolvedCommit],
      message: "The resolved base commit could not be checked out.",
    });
    yield* runGit({
      stage: "checkout",
      cwd: workspacePath,
      args: ["switch", "-c", branch],
      message: "The isolated output branch could not be created.",
    });
    yield* runGit({
      stage: "checkout",
      cwd: workspacePath,
      args: ["remote", "set-url", "origin", `https://github.com/${request.recipe.repository}.git`],
      message: "The checkout's display remote could not be normalized.",
    });

    const trackedFileOutput = yield* runGit({
      stage: "checkout",
      cwd: workspacePath,
      args: ["ls-files", "-z"],
      message: "Repository instruction files could not be enumerated.",
    });
    const trackedFiles = trackedFileOutput.split("\0").filter((file) => file.length > 0);
    const instructionFiles = trackedFiles
      .filter((file) => INSTRUCTION_FILE_NAMES.has(path.basename(file)))
      .sort();
    const cloneCompletedAt = yield* DateTime.now;
    const setupStartedAt = cloneCompletedAt;
    const cacheInputsValue = yield* cacheInputs({
      workspacePath,
      trackedFiles,
      recipe: request.recipe,
    });
    const setup = yield* cacheMutex.withPermits(1)(
      Effect.gen(function* () {
        let cache: PreparedDependencyCache = yield* prepareCache(cacheInputsValue);
        const firstAttempt = yield* runCommands({
          stage: "setup",
          workspacePath,
          commands: request.recipe.setup,
          deadline: request.deadline,
          environment: cacheEnvironment(cache.entryPath),
        }).pipe(Effect.result);
        let setupResults: ReadonlyArray<CloudRepositoryCommandResult>;
        if (Result.isSuccess(firstAttempt)) {
          setupResults = firstAttempt.success;
        } else if (cache.outcome === "hit" && firstAttempt.failure.reason === "command-failed") {
          yield* resetWorkspace(workspacePath);
          cache = yield* rebuildCache(cache);
          setupResults = yield* runCommands({
            stage: "setup",
            workspacePath,
            commands: request.recipe.setup,
            deadline: request.deadline,
            environment: cacheEnvironment(cache.entryPath),
          });
        } else {
          return yield* firstAttempt.failure;
        }
        const cacheRecord = yield* finishCache(cache);
        return { setupResults, cacheRecord };
      }),
    );
    const setupCompletedAt = yield* DateTime.now;
    const workerStartup = yield* readStartupTimings();

    return {
      allocationId: request.allocationId,
      attempt: request.attempt,
      repository: request.recipe.repository,
      selectedRef: request.selectedRef,
      resolvedCommit,
      outputBranch: branch,
      workspacePath,
      instructionFiles,
      setupResults: setup.setupResults,
      devServers: request.recipe.devServers,
      verification: request.recipe.verification,
      permittedSecretReferences: request.recipe.secretReferences,
      dependencyCache: setup.cacheRecord,
      timings: {
        ...(workerStartup === undefined ? {} : { workerStartup }),
        clone: stageTiming(cloneStartedAt, cloneCompletedAt),
        setup: stageTiming(setupStartedAt, setupCompletedAt),
      },
      preparedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies CloudRepositoryPreparationRecord;
  });

  const verify: CloudRepositoryPreparation["Service"]["verify"] = Effect.fn(
    "CloudRepositoryPreparation.verify",
  )(function* (request) {
    const results = yield* runCommands({
      stage: "verification",
      workspacePath: request.preparation.workspacePath,
      commands: request.preparation.verification,
      deadline: request.deadline,
    });
    return {
      allocationId: request.preparation.allocationId,
      attempt: request.preparation.attempt,
      results,
      completedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies CloudRepositoryVerificationRecord;
  });

  return CloudRepositoryPreparation.of({ prepare, verify });
});

export const layer = Layer.effect(
  CloudRepositoryPreparation,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const hostPlatform = yield* HostProcessPlatform;
    const hostArchitecture = yield* HostProcessArchitecture;
    const cacheRoot = yield* Config.string("T3CODE_CLOUD_DEPENDENCY_CACHE_DIR").pipe(
      Config.withDefault(path.join(config.providerStatusCacheDir, "cloud-dependencies")),
    );
    const maxEntries = yield* Config.int("T3CODE_CLOUD_DEPENDENCY_CACHE_MAX_ENTRIES").pipe(
      Config.withDefault(DEFAULT_CACHE_MAX_ENTRIES),
    );
    const maxBytes = yield* Config.int("T3CODE_CLOUD_DEPENDENCY_CACHE_MAX_BYTES").pipe(
      Config.withDefault(DEFAULT_CACHE_MAX_BYTES),
    );
    const imageVersion = yield* Config.string("T3_WORKER_IMAGE_VERSION").pipe(
      Config.withDefault("development"),
    );
    const startupTimingsPath = yield* Config.string("T3CODE_CLOUD_STARTUP_TIMINGS_PATH").pipe(
      Config.withDefault("/var/lib/t3-worker/startup-timings.json"),
    );
    return yield* make({
      workspaceRoot: path.join(config.worktreesDir, "cloud-runs"),
      startupTimingsPath,
      dependencyCache: {
        root: cacheRoot,
        maxEntries: Math.max(1, maxEntries),
        maxBytes: Math.max(1, maxBytes),
        runtime: {
          imageVersion,
          os: hostPlatform,
          arch: hostArchitecture,
          nodeVersion: process.version,
        },
      },
    });
  }),
);
