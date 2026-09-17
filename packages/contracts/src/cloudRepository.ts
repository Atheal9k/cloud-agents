import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RunAllocationAttempt,
  RunAllocationId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const CommandTimeoutSeconds = PositiveInt.pipe(Schema.check(Schema.isLessThanOrEqualTo(60 * 60)));
const TcpPort = PositiveInt.pipe(Schema.check(Schema.isLessThanOrEqualTo(65_535)));
const EnvironmentVariableName = Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/));

export const CloudRepositoryCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  timeoutSeconds: CommandTimeoutSeconds,
});
export type CloudRepositoryCommand = typeof CloudRepositoryCommand.Type;

export const CloudRepositoryDevServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  port: TcpPort,
  command: CloudRepositoryCommand,
});
export type CloudRepositoryDevServer = typeof CloudRepositoryDevServer.Type;

export const CloudRepositorySecretReference = Schema.Struct({
  environmentVariable: EnvironmentVariableName,
  reference: TrimmedNonEmptyString,
});
export type CloudRepositorySecretReference = typeof CloudRepositorySecretReference.Type;

/**
 * Trusted, controller-owned instructions for one configured repository. Values
 * identify secrets but never contain secret material.
 */
export const CloudRepositoryRecipe = Schema.Struct({
  version: Schema.Literal(1),
  repository: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  outputBranchPrefix: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,199}[A-Za-z0-9])?$/),
  ),
  setup: Schema.Array(CloudRepositoryCommand).pipe(Schema.check(Schema.isMinLength(1))),
  devServers: Schema.Array(CloudRepositoryDevServer).pipe(Schema.check(Schema.isMinLength(1))),
  verification: Schema.Array(CloudRepositoryCommand).pipe(Schema.check(Schema.isMinLength(1))),
  secretReferences: Schema.Array(CloudRepositorySecretReference),
});
export type CloudRepositoryRecipe = typeof CloudRepositoryRecipe.Type;

export const CloudRepositoryCommandResult = Schema.Struct({
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  startedAt: IsoDateTime,
  completedAt: IsoDateTime,
  exitCode: Schema.NullOr(NonNegativeInt),
  timedOut: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});
export type CloudRepositoryCommandResult = typeof CloudRepositoryCommandResult.Type;

export const CloudRunStageTiming = Schema.Struct({
  startedAt: IsoDateTime,
  completedAt: IsoDateTime,
  durationMs: NonNegativeInt,
});
export type CloudRunStageTiming = typeof CloudRunStageTiming.Type;

export const CloudWorkerStartupTimings = Schema.Struct({
  imageBoot: CloudRunStageTiming,
  serviceStartup: CloudRunStageTiming,
});
export type CloudWorkerStartupTimings = typeof CloudWorkerStartupTimings.Type;

export const CloudRepositoryDependencyCache = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  outcome: Schema.Literals(["miss", "hit", "rebuilt"]),
  inputFiles: Schema.Array(TrimmedNonEmptyString),
  imageVersion: TrimmedNonEmptyString,
  platform: Schema.Struct({
    os: TrimmedNonEmptyString,
    arch: TrimmedNonEmptyString,
    nodeVersion: TrimmedNonEmptyString,
  }),
  sizeBytes: NonNegativeInt,
  evictedEntries: NonNegativeInt,
});
export type CloudRepositoryDependencyCache = typeof CloudRepositoryDependencyCache.Type;

export const CloudRepositoryPreparationInput = Schema.Struct({
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  selectedRef: TrimmedNonEmptyString,
  deadline: IsoDateTime,
  recipe: CloudRepositoryRecipe,
});
export type CloudRepositoryPreparationInput = typeof CloudRepositoryPreparationInput.Type;

export const CloudRepositoryPreparationRecord = Schema.Struct({
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  repository: TrimmedNonEmptyString,
  selectedRef: TrimmedNonEmptyString,
  resolvedCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/)),
  outputBranch: TrimmedNonEmptyString,
  workspacePath: TrimmedNonEmptyString,
  instructionFiles: Schema.Array(TrimmedNonEmptyString),
  setupResults: Schema.Array(CloudRepositoryCommandResult),
  devServers: Schema.Array(CloudRepositoryDevServer),
  verification: Schema.Array(CloudRepositoryCommand),
  permittedSecretReferences: Schema.Array(CloudRepositorySecretReference),
  dependencyCache: Schema.optionalKey(CloudRepositoryDependencyCache),
  timings: Schema.optionalKey(
    Schema.Struct({
      workerStartup: Schema.optionalKey(CloudWorkerStartupTimings),
      clone: CloudRunStageTiming,
      setup: CloudRunStageTiming,
    }),
  ),
  preparedAt: IsoDateTime,
});
export type CloudRepositoryPreparationRecord = typeof CloudRepositoryPreparationRecord.Type;

export const CloudRepositoryVerificationRecord = Schema.Struct({
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  results: Schema.Array(CloudRepositoryCommandResult),
  completedAt: IsoDateTime,
});
export type CloudRepositoryVerificationRecord = typeof CloudRepositoryVerificationRecord.Type;

export class CloudRepositoryPreparationError extends Schema.TaggedError<CloudRepositoryPreparationError>()(
  "CloudRepositoryPreparationError",
  {
    reason: Schema.Literals([
      "invalid-recipe",
      "deadline-expired",
      "workspace-conflict",
      "credential-failed",
      "git-failed",
      "dependency-missing",
      "command-failed",
      "filesystem-failed",
    ]),
    stage: Schema.Literals(["clone", "checkout", "setup", "verification"]),
    message: TrimmedNonEmptyString,
    commandResults: Schema.Array(CloudRepositoryCommandResult),
  },
) {}
