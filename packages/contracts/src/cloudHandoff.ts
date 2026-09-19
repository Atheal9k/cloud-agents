import * as Schema from "effect/Schema";

import {
  CloudAgentId,
  CloudHandoffTransferId,
  EnvironmentId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const CloudHandoffDirection = Schema.Literals(["local-to-cloud", "cloud-to-local"]);
export type CloudHandoffDirection = typeof CloudHandoffDirection.Type;

/**
 * Wake continues the same cloud agent on its snapshot. A linked continuation
 * copies selected files to a new identity so two writers never share one
 * snapshot.
 */
export const CloudHandoffIntent = Schema.Literals(["wake-same-agent", "linked-continuation"]);
export type CloudHandoffIntent = typeof CloudHandoffIntent.Type;

export const CloudHandoffChangeKind = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "untracked",
  "ignored",
]);
export type CloudHandoffChangeKind = typeof CloudHandoffChangeKind.Type;

export const CloudHandoffExcludeReason = Schema.Literals([
  "credential",
  "gitignored",
  "not-selected",
]);
export type CloudHandoffExcludeReason = typeof CloudHandoffExcludeReason.Type;

export const CloudHandoffFileInclusion = Schema.Literals(["selected", "excluded"]);
export type CloudHandoffFileInclusion = typeof CloudHandoffFileInclusion.Type;

export const CloudHandoffFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  change: CloudHandoffChangeKind,
  inclusion: CloudHandoffFileInclusion,
  excludeReason: Schema.optionalKey(CloudHandoffExcludeReason),
});
export type CloudHandoffFile = typeof CloudHandoffFile.Type;

export const CloudHandoffHistoryTransfer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    description: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("seeded-continuation"),
    description: TrimmedNonEmptyString,
  }),
]);
export type CloudHandoffHistoryTransfer = typeof CloudHandoffHistoryTransfer.Type;

export const CloudHandoffSide = Schema.Struct({
  surface: Schema.Literals(["local", "cloud"]),
  environmentId: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  agentId: Schema.optionalKey(CloudAgentId),
  workspacePath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudHandoffSide = typeof CloudHandoffSide.Type;

export const CloudHandoffConflict = Schema.Struct({
  path: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
});
export type CloudHandoffConflict = typeof CloudHandoffConflict.Type;

export const CloudHandoffConflictPolicy = Schema.Literals(["abort", "skip-conflicting"]);
export type CloudHandoffConflictPolicy = typeof CloudHandoffConflictPolicy.Type;

export const CloudHandoffPreviewInput = Schema.Struct({
  direction: CloudHandoffDirection,
  intent: CloudHandoffIntent,
  localWorkspacePath: TrimmedNonEmptyString,
  sourceEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId,
  sourceThreadId: Schema.optionalKey(ThreadId),
  destinationThreadId: Schema.optionalKey(ThreadId),
  agentId: Schema.optionalKey(CloudAgentId),
  destinationWorkspacePath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudHandoffPreviewInput = typeof CloudHandoffPreviewInput.Type;

export const CloudHandoffPreview = Schema.Struct({
  transferId: CloudHandoffTransferId,
  direction: CloudHandoffDirection,
  intent: CloudHandoffIntent,
  baseCommit: TrimmedNonEmptyString,
  baseBranch: Schema.optionalKey(TrimmedNonEmptyString),
  source: CloudHandoffSide,
  destination: CloudHandoffSide,
  files: Schema.Array(CloudHandoffFile),
  history: CloudHandoffHistoryTransfer,
  snapshotWriter: Schema.Literals(["source", "destination", "none"]),
  explanation: TrimmedNonEmptyString,
});
export type CloudHandoffPreview = typeof CloudHandoffPreview.Type;

export const CloudHandoffExecuteInput = Schema.Struct({
  transferId: CloudHandoffTransferId,
  direction: CloudHandoffDirection,
  intent: CloudHandoffIntent,
  localWorkspacePath: TrimmedNonEmptyString,
  sourceEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId,
  destinationWorkspacePath: TrimmedNonEmptyString,
  selectedPaths: Schema.Array(TrimmedNonEmptyString),
  conflictPolicy: CloudHandoffConflictPolicy,
  sourceThreadId: Schema.optionalKey(ThreadId),
  destinationThreadId: Schema.optionalKey(ThreadId),
  agentId: Schema.optionalKey(CloudAgentId),
});
export type CloudHandoffExecuteInput = typeof CloudHandoffExecuteInput.Type;

export const CloudHandoffExecuteResult = Schema.Struct({
  transferId: CloudHandoffTransferId,
  status: Schema.Literals(["applied", "already-applied", "woke-same-agent"]),
  direction: CloudHandoffDirection,
  intent: CloudHandoffIntent,
  source: CloudHandoffSide,
  destination: CloudHandoffSide,
  appliedPaths: Schema.Array(TrimmedNonEmptyString),
  skippedConflictPaths: Schema.Array(TrimmedNonEmptyString),
  excludedPaths: Schema.Array(TrimmedNonEmptyString),
  history: CloudHandoffHistoryTransfer,
  patchFingerprint: Schema.optionalKey(TrimmedNonEmptyString),
  appliedAt: IsoDateTime,
});
export type CloudHandoffExecuteResult = typeof CloudHandoffExecuteResult.Type;

export class CloudHandoffError extends Schema.TaggedError<CloudHandoffError>()(
  "CloudHandoffError",
  {
    reason: Schema.Literals([
      "invalid-request",
      "workspace-not-found",
      "agent-not-found",
      "snapshot-writer-conflict",
      "dirty-conflict",
      "apply-failed",
      "persistence-failed",
    ]),
    message: TrimmedNonEmptyString,
    conflicts: Schema.optionalKey(Schema.Array(CloudHandoffConflict)),
  },
) {}
