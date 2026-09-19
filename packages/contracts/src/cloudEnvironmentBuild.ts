import * as Schema from "effect/Schema";

import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentVersionId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  CloudEnvironmentBase,
  CloudEnvironmentSecretReference,
  cloudEnvironmentSecretScope,
} from "./cloudEnvironment.ts";
import { CloudRepositoryCommandResult, CloudRunStageTiming } from "./cloudRepository.ts";

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/));

/** 24 hours. `0` means every run refreshes the Build before it boots. */
export const DEFAULT_STALE_BUILD_THRESHOLD_SECONDS = 24 * 60 * 60;

export const CloudEnvironmentBuildTrigger = Schema.Literals([
  "manual",
  "recurring",
  "configuration-change",
  "agent-requested",
]);
export type CloudEnvironmentBuildTrigger = typeof CloudEnvironmentBuildTrigger.Type;

export const CloudEnvironmentBuildStage = Schema.Literals(["base", "clone", "install", "snapshot"]);
export type CloudEnvironmentBuildStage = typeof CloudEnvironmentBuildStage.Type;

/** One repository's default ref as it was resolved when the Build cloned it. */
export const CloudEnvironmentBuildGitSetup = Schema.Struct({
  repository: TrimmedNonEmptyString,
  defaultRef: TrimmedNonEmptyString,
  commit: CommitSha,
});
export type CloudEnvironmentBuildGitSetup = typeof CloudEnvironmentBuildGitSetup.Type;

export const CloudEnvironmentBuildSnapshot = Schema.Struct({
  id: TrimmedNonEmptyString,
  digest: Sha256Hex,
  sizeBytes: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type CloudEnvironmentBuildSnapshot = typeof CloudEnvironmentBuildSnapshot.Type;

export const CloudEnvironmentBuildTimings = Schema.Struct({
  base: Schema.optionalKey(CloudRunStageTiming),
  clone: Schema.optionalKey(CloudRunStageTiming),
  install: Schema.optionalKey(CloudRunStageTiming),
  snapshot: Schema.optionalKey(CloudRunStageTiming),
});
export type CloudEnvironmentBuildTimings = typeof CloudEnvironmentBuildTimings.Type;

/**
 * Only a `succeeded` Build carries a snapshot, so nothing can activate a Build
 * that has no disk behind it.
 */
export const CloudEnvironmentBuildOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("running") }),
  Schema.Struct({
    status: Schema.Literal("succeeded"),
    snapshot: CloudEnvironmentBuildSnapshot,
    completedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    stage: CloudEnvironmentBuildStage,
    message: TrimmedNonEmptyString,
    completedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("cancelled"),
    completedAt: IsoDateTime,
  }),
  /** A recurring trigger whose refs, config, and secrets matched the active Build. */
  Schema.Struct({
    status: Schema.Literal("skipped"),
    reusedBuildId: CloudEnvironmentBuildId,
    completedAt: IsoDateTime,
  }),
]);
export type CloudEnvironmentBuildOutcome = typeof CloudEnvironmentBuildOutcome.Type;

export const CloudEnvironmentBuild = Schema.Struct({
  id: CloudEnvironmentBuildId,
  environmentId: CloudEnvironmentId,
  versionId: CloudEnvironmentVersionId,
  version: PositiveInt,
  trigger: CloudEnvironmentBuildTrigger,
  /** Agent-requested Builds stay draft until a person saves them. */
  draft: Schema.Boolean,
  base: CloudEnvironmentBase,
  /**
   * Identifies the refs, config, and build-time secrets this Build was made
   * from. A recurring trigger with a matching fingerprint is skipped.
   */
  inputsFingerprint: Sha256Hex,
  gitSetup: Schema.Array(CloudEnvironmentBuildGitSetup),
  logs: Schema.Array(CloudRepositoryCommandResult),
  timings: CloudEnvironmentBuildTimings,
  outcome: CloudEnvironmentBuildOutcome,
  startedAt: IsoDateTime,
  /**
   * When this Build's contents were last known to match its inputs. Set on
   * success and refreshed by a recurring trigger that skipped a rebuild.
   */
  freshAt: Schema.optionalKey(IsoDateTime),
});
export type CloudEnvironmentBuild = typeof CloudEnvironmentBuild.Type;

/** Pinned onto an allocation so a run boots the exact snapshot it resolved. */
export const CloudEnvironmentBuildReference = Schema.Struct({
  buildId: CloudEnvironmentBuildId,
  environmentId: CloudEnvironmentId,
  versionId: CloudEnvironmentVersionId,
  snapshot: CloudEnvironmentBuildSnapshot,
  gitSetup: Schema.Array(CloudEnvironmentBuildGitSetup),
});
export type CloudEnvironmentBuildReference = typeof CloudEnvironmentBuildReference.Type;

export function cloudEnvironmentBuildReference(
  build: CloudEnvironmentBuild,
): CloudEnvironmentBuildReference | undefined {
  if (build.outcome.status !== "succeeded" || build.draft) return undefined;
  return {
    buildId: build.id,
    environmentId: build.environmentId,
    versionId: build.versionId,
    snapshot: build.outcome.snapshot,
    gitSetup: build.gitSetup,
  };
}

/**
 * Build-time material is baked into a shared snapshot, so only secrets marked
 * `build` may reach it. Runtime secrets stay with the run that owns them, and
 * user secrets never enter a shared disk even if they were mislabelled.
 */
export function cloudEnvironmentBuildSecrets(
  secretReferences: ReadonlyArray<CloudEnvironmentSecretReference>,
): ReadonlyArray<CloudEnvironmentSecretReference> {
  return secretReferences.filter(
    (secret) => secret.availability === "build" && cloudEnvironmentSecretScope(secret) !== "user",
  );
}

export const CloudEnvironmentBuildStartInput = Schema.Struct({
  buildId: CloudEnvironmentBuildId,
  environmentId: CloudEnvironmentId,
  trigger: CloudEnvironmentBuildTrigger,
  occurredAt: IsoDateTime,
});
export type CloudEnvironmentBuildStartInput = typeof CloudEnvironmentBuildStartInput.Type;

export const CloudEnvironmentBuildCancelInput = Schema.Struct({
  buildId: CloudEnvironmentBuildId,
  occurredAt: IsoDateTime,
});
export type CloudEnvironmentBuildCancelInput = typeof CloudEnvironmentBuildCancelInput.Type;

/** Saving an agent-requested draft is what lets it activate. */
export const CloudEnvironmentBuildSaveInput = Schema.Struct({
  buildId: CloudEnvironmentBuildId,
  occurredAt: IsoDateTime,
});
export type CloudEnvironmentBuildSaveInput = typeof CloudEnvironmentBuildSaveInput.Type;

/** Repoint an environment at any saved successful Build, including an older one. */
export const CloudEnvironmentBuildActivateInput = Schema.Struct({
  buildId: CloudEnvironmentBuildId,
  occurredAt: IsoDateTime,
});
export type CloudEnvironmentBuildActivateInput = typeof CloudEnvironmentBuildActivateInput.Type;

export const CloudEnvironmentBuildStaleThresholdInput = Schema.Struct({
  environmentId: CloudEnvironmentId,
  staleThresholdSeconds: NonNegativeInt,
  occurredAt: IsoDateTime,
});
export type CloudEnvironmentBuildStaleThresholdInput =
  typeof CloudEnvironmentBuildStaleThresholdInput.Type;

export class CloudEnvironmentBuildError extends Schema.TaggedError<CloudEnvironmentBuildError>()(
  "CloudEnvironmentBuildError",
  {
    reason: Schema.Literals([
      "environment-not-found",
      "build-not-found",
      "build-not-draft",
      "build-not-saved",
      "build-unsuccessful",
      "build-already-settled",
      "build-in-progress",
      "build-failed",
      "admission-rejected",
      "persistence-failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
