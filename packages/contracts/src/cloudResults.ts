import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  CloudRunResultId,
  EnvironmentId,
  RunAllocationAttempt,
  RunAllocationId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  CloudProviderExecutionRecord,
  CloudProviderTurnInput,
  CloudProviderUnansweredRequestSeconds,
} from "./cloudExecution.ts";
import { CloudCommitProvenance } from "./cloudCommitProvenance.ts";
import {
  CloudRepositoryPreparationRecord,
  CloudRepositoryVerificationRecord,
} from "./cloudRepository.ts";

export const CLOUD_RESULT_RETENTION_DAYS = 7;
export const CLOUD_RESULT_MAX_ARTIFACTS = 64;
export const CLOUD_RESULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const CLOUD_RESULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

// A download token authorizes read access to one retained result's files for a
// short window. Downloads carry the token instead of an environment session, so
// a granted URL can be handed to an embed, a viewer, or a PR attachment step
// without leaking session credentials. Re-grant to extend access.
export const CLOUD_ARTIFACT_ACCESS_TTL_SECONDS = 300;

export const CloudResultArtifactRequest = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  mediaType: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudResultArtifactRequest = typeof CloudResultArtifactRequest.Type;

export const CloudResultCaptureInput = Schema.Struct({
  preparation: CloudRepositoryPreparationRecord,
  verification: CloudRepositoryVerificationRecord,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  hardDeadline: IsoDateTime,
  artifacts: Schema.Array(CloudResultArtifactRequest).pipe(
    Schema.check(Schema.isMaxLength(CLOUD_RESULT_MAX_ARTIFACTS)),
  ),
});
export type CloudResultCaptureInput = typeof CloudResultCaptureInput.Type;

export const CloudResultArtifact = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  // The path the artifact occupied inside the run workspace. Optional so older
  // persisted manifests, captured before relative paths were retained, still
  // decode.
  relativePath: Schema.optionalKey(TrimmedNonEmptyString),
  mediaType: Schema.optionalKey(TrimmedNonEmptyString),
  sizeBytes: NonNegativeInt,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  downloadPath: TrimmedNonEmptyString,
});
export type CloudResultArtifact = typeof CloudResultArtifact.Type;

export const CloudResultManifest = Schema.Struct({
  version: Schema.Literal(1),
  resultId: CloudRunResultId,
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  baseCommit: TrimmedNonEmptyString,
  outputBranch: TrimmedNonEmptyString,
  checkpointRef: TrimmedNonEmptyString,
  pagePath: TrimmedNonEmptyString,
  diffDownloadPath: TrimmedNonEmptyString,
  transcriptDownloadPath: TrimmedNonEmptyString,
  verificationDownloadPath: TrimmedNonEmptyString,
  workspaceDownloadPath: TrimmedNonEmptyString,
  artifacts: Schema.Array(CloudResultArtifact),
  provenance: Schema.optionalKey(CloudCommitProvenance),
  totalSizeBytes: NonNegativeInt,
  captureStartedAt: IsoDateTime,
  capturedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type CloudResultManifest = typeof CloudResultManifest.Type;

export const CloudArtifactAccessInput = Schema.Struct({
  resultId: CloudRunResultId,
});
export type CloudArtifactAccessInput = typeof CloudArtifactAccessInput.Type;

export const CloudArtifactEntryKind = Schema.Literals([
  "diff",
  "transcript",
  "verification",
  "workspace",
  "artifact",
]);
export type CloudArtifactEntryKind = typeof CloudArtifactEntryKind.Type;

export const CloudArtifactEntry = Schema.Struct({
  fileId: TrimmedNonEmptyString,
  kind: CloudArtifactEntryKind,
  name: TrimmedNonEmptyString,
  relativePath: Schema.optionalKey(TrimmedNonEmptyString),
  mediaType: Schema.optionalKey(TrimmedNonEmptyString),
  sizeBytes: Schema.optionalKey(NonNegativeInt),
  // A short-lived authorized URL. It carries the grant token, so it downloads
  // without an environment session for the token's lifetime.
  url: TrimmedNonEmptyString,
});
export type CloudArtifactEntry = typeof CloudArtifactEntry.Type;

export const CloudArtifactAccessGrant = Schema.Struct({
  resultId: CloudRunResultId,
  token: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  entries: Schema.Array(CloudArtifactEntry),
});
export type CloudArtifactAccessGrant = typeof CloudArtifactAccessGrant.Type;

export const CloudResultRetentionStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("retaining"),
    resultId: CloudRunResultId,
    startedAt: IsoDateTime,
    hardDeadline: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("retained"),
    manifest: CloudResultManifest,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    resultId: CloudRunResultId,
    reason: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    retryable: Schema.Boolean,
    failedAt: IsoDateTime,
  }),
]);
export type CloudResultRetentionStatus = typeof CloudResultRetentionStatus.Type;

export const CloudResultContinuationInput = Schema.Struct({
  resultId: CloudRunResultId,
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  destinationWorkspacePath: TrimmedNonEmptyString,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds,
  turn: CloudProviderTurnInput,
});
export type CloudResultContinuationInput = typeof CloudResultContinuationInput.Type;

export const CloudResultContinuationRecord = Schema.Struct({
  resultId: CloudRunResultId,
  sourceAllocationId: RunAllocationId,
  sourceAttempt: RunAllocationAttempt,
  sourceThreadId: ThreadId,
  continuationAllocationId: RunAllocationId,
  continuationAttempt: RunAllocationAttempt,
  continuation: CloudProviderExecutionRecord,
  restoredWorkspacePath: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
});
export type CloudResultContinuationRecord = typeof CloudResultContinuationRecord.Type;

export class CloudResultError extends Schema.TaggedError<CloudResultError>()("CloudResultError", {
  reason: Schema.Literals([
    "result-not-found",
    "thread-not-found",
    "attempt-not-fenced",
    "invalid-artifact",
    "size-limit-exceeded",
    "hard-deadline-exceeded",
    "capture-failed",
    "restore-failed",
    "continuation-start-failed",
  ]),
  message: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
}) {}
