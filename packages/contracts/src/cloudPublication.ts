import * as Schema from "effect/Schema";

import {
  CloudRunResultId,
  IsoDateTime,
  RunAllocationAttempt,
  RunAllocationId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RunPublicationIntent } from "./cloudAllocation.ts";
import {
  CloudRepositoryPreparationRecord,
  CloudRepositoryVerificationRecord,
} from "./cloudRepository.ts";
import { CloudResultManifest } from "./cloudResults.ts";

export const CloudRunPublicationInput = Schema.Struct({
  preparation: CloudRepositoryPreparationRecord,
  verification: CloudRepositoryVerificationRecord,
  result: CloudResultManifest,
});
export type CloudRunPublicationInput = typeof CloudRunPublicationInput.Type;

export const CloudRunPublicationOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("review-only"),
    completedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("empty-change"),
    completedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("verification-failed"),
    completedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("publishing"),
    commit: TrimmedNonEmptyString,
    startedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("push-rejected"),
    commit: TrimmedNonEmptyString,
    remoteCommit: Schema.optionalKey(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    failedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("push-failed"),
    commit: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    failedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("pr-creation-failed"),
    commit: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    failedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("published"),
    commit: TrimmedNonEmptyString,
    pullRequestNumber: Schema.Int,
    pullRequestUrl: TrimmedNonEmptyString,
    publishedAt: IsoDateTime,
  }),
]);
export type CloudRunPublicationOutcome = typeof CloudRunPublicationOutcome.Type;

export const CloudRunPublicationRecord = Schema.Struct({
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  repository: TrimmedNonEmptyString,
  baseCommit: TrimmedNonEmptyString,
  outputBranch: TrimmedNonEmptyString,
  intent: RunPublicationIntent,
  verification: CloudRepositoryVerificationRecord,
  resultId: CloudRunResultId,
  savedDiffPath: TrimmedNonEmptyString,
  outcome: CloudRunPublicationOutcome,
});
export type CloudRunPublicationRecord = typeof CloudRunPublicationRecord.Type;

export class CloudRunPublicationError extends Schema.TaggedError<CloudRunPublicationError>()(
  "CloudRunPublicationError",
  {
    reason: Schema.Literals([
      "allocation-not-found",
      "stale-attempt",
      "recorded-intent-mismatch",
      "invalid-workspace",
      "publication-not-found",
      "persistence-failed",
    ]),
    message: TrimmedNonEmptyString,
    retryable: Schema.Boolean,
  },
) {}
