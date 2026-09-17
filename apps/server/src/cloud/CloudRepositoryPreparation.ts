// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  CloudRepositoryPreparationError,
  type CloudRepositoryCommand,
  type CloudRepositoryCommandResult,
  type CloudRepositoryPreparationInput,
  type CloudRepositoryPreparationRecord,
  type CloudRepositoryRecipe,
  type CloudRepositoryVerificationRecord,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CloudGitCredentials from "./CloudGitCredentials.ts";

const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const INSTRUCTION_FILE_NAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "copilot-instructions.md",
]);
const RESERVED_SECRET_PREFIXES = ["AWS_", "GH_", "GIT_", "SSH_", "T3CODE_"] as const;

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

function safeTaskEnvironment(): NodeJS.ProcessEnv {
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
  return environment;
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

function gitFailure(stage: "clone" | "checkout", message: string) {
  return preparationError({ reason: "git-failed", stage, message });
}

export const make = Effect.fn("CloudRepositoryPreparation.make")(function* (input: {
  readonly workspaceRoot: string;
}) {
  const credentials = yield* CloudGitCredentials.CloudGitCredentials;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;

  const runGit = Effect.fn("CloudRepositoryPreparation.runGit")(function* (request: {
    readonly stage: "clone" | "checkout";
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
    readonly commands: ReadonlyArray<CloudRepositoryCommand>;
    readonly deadline: string;
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
          env: safeTaskEnvironment(),
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

    const trackedFiles = yield* runGit({
      stage: "checkout",
      cwd: workspacePath,
      args: ["ls-files", "-z"],
      message: "Repository instruction files could not be enumerated.",
    });
    const instructionFiles = trackedFiles
      .split("\0")
      .filter((file) => file.length > 0 && INSTRUCTION_FILE_NAMES.has(path.basename(file)))
      .sort();
    const setupResults = yield* runCommands({
      stage: "setup",
      workspacePath,
      commands: request.recipe.setup,
      deadline: request.deadline,
    });

    return {
      allocationId: request.allocationId,
      attempt: request.attempt,
      repository: request.recipe.repository,
      selectedRef: request.selectedRef,
      resolvedCommit,
      outputBranch: branch,
      workspacePath,
      instructionFiles,
      setupResults,
      devServers: request.recipe.devServers,
      verification: request.recipe.verification,
      permittedSecretReferences: request.recipe.secretReferences,
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
    return yield* make({ workspaceRoot: path.join(config.worktreesDir, "cloud-runs") });
  }),
);
