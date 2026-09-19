import * as Schema from "effect/Schema";

import {
  CloudAgentId,
  CloudRunId,
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  RunAllocationId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  CloudAgent,
  CloudAgentStatus,
  CloudRun,
  CloudRunStatus,
  CloudRunUsage,
  RunIdleState,
  RunPreviewState,
} from "./cloudAllocation.ts";
import { CloudEnvironment, CloudEnvironmentVersionReference } from "./cloudEnvironment.ts";
import {
  CloudRuntimeReopen,
  CloudSessionEdits,
  CloudSessionLeaseKind,
  CloudSessionLeases,
} from "./cloudPreview.ts";
import { CloudEnvironmentBuild } from "./cloudEnvironmentBuild.ts";
import { CloudRunPublicationOutcome } from "./cloudPublication.ts";
import { CloudArtifactEntry } from "./cloudResults.ts";

export const CLOUD_AGENT_REVIEW_PAGE_PREFIX = "/cloud/agents/";
export const CLOUD_AGENT_REVIEW_SHARE_PREFIX = "/cloud/review/";
export const CLOUD_REVIEW_DIFF_PREVIEW_CHARS = 64 * 1024;

export const CloudAgentReviewAction = Schema.Literals([
  "archive",
  "unarchive",
  "cancel",
  /** Restores the snapshot and runs environment `start`. It submits no turn. */
  "reopen",
  /** Ends every session on the guest, snapshots it, and releases it. */
  "stop",
  "delete",
  "delete-pr",
]);
export type CloudAgentReviewAction = typeof CloudAgentReviewAction.Type;

export const CloudAgentReviewInspectInput = Schema.Struct({
  agentId: CloudAgentId,
});
export type CloudAgentReviewInspectInput = typeof CloudAgentReviewInspectInput.Type;

export const CloudAgentReviewActInput = Schema.Struct({
  agentId: CloudAgentId,
  action: CloudAgentReviewAction,
  commandId: CommandId,
  occurredAt: IsoDateTime,
});
export type CloudAgentReviewActInput = typeof CloudAgentReviewActInput.Type;

/** Opening takes a bounded lease; a heartbeat buys another term up to its cap. */
export const CloudAgentReviewLeaseOperation = Schema.Literals(["open", "heartbeat", "release"]);
export type CloudAgentReviewLeaseOperation = typeof CloudAgentReviewLeaseOperation.Type;

export const CloudAgentReviewLeaseInput = Schema.Struct({
  agentId: CloudAgentId,
  kind: CloudSessionLeaseKind,
  operation: CloudAgentReviewLeaseOperation,
  commandId: CommandId,
  occurredAt: IsoDateTime,
});
export type CloudAgentReviewLeaseInput = typeof CloudAgentReviewLeaseInput.Type;

export const CloudAgentReviewShareInput = Schema.Struct({
  agentId: CloudAgentId,
});
export type CloudAgentReviewShareInput = typeof CloudAgentReviewShareInput.Type;

/** Whether live preview/terminal can be opened. Independent of agent and run status. */
export const CloudSessionAvailability = Schema.Literals(["available", "unavailable"]);
export type CloudSessionAvailability = typeof CloudSessionAvailability.Type;

export const CloudDiffInspection = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("text"),
    preview: Schema.String,
    truncated: Schema.Boolean,
    sizeChars: NonNegativeInt,
  }),
  Schema.Struct({ status: Schema.Literal("binary"), reason: TrimmedNonEmptyString }),
  Schema.Struct({
    status: Schema.Literal("oversized"),
    reason: TrimmedNonEmptyString,
    sizeChars: NonNegativeInt,
  }),
  Schema.Struct({ status: Schema.Literal("missing"), reason: TrimmedNonEmptyString }),
]);
export type CloudDiffInspection = typeof CloudDiffInspection.Type;

export const CloudSnapshotInspection = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("present"),
    instanceId: TrimmedNonEmptyString,
    capturedAt: IsoDateTime,
  }),
  Schema.Struct({ status: Schema.Literal("idle-guest"), releaseAt: IsoDateTime }),
  Schema.Struct({ status: Schema.Literal("expired"), reason: TrimmedNonEmptyString }),
  Schema.Struct({ status: Schema.Literal("missing"), reason: TrimmedNonEmptyString }),
]);
export type CloudSnapshotInspection = typeof CloudSnapshotInspection.Type;

export const CloudArtifactInspection = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    entry: CloudArtifactEntry,
    htmlUntrusted: Schema.Boolean,
  }),
  Schema.Struct({
    status: Schema.Literal("missing"),
    name: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  }),
]);
export type CloudArtifactInspection = typeof CloudArtifactInspection.Type;

export const CloudBuildInspection = Schema.Union([
  Schema.Struct({ status: Schema.Literal("none"), reason: TrimmedNonEmptyString }),
  Schema.Struct({
    status: Schema.Literal("present"),
    build: CloudEnvironmentBuild,
    failed: Schema.Boolean,
  }),
]);
export type CloudBuildInspection = typeof CloudBuildInspection.Type;

export const CloudPublicationInspection = Schema.Union([
  Schema.Struct({ status: Schema.Literal("none"), reason: TrimmedNonEmptyString }),
  Schema.Struct({
    status: Schema.Literal("present"),
    outcome: CloudRunPublicationOutcome,
    pullRequestUrl: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type CloudPublicationInspection = typeof CloudPublicationInspection.Type;

export const CloudAgentReviewActionAvailability = Schema.Struct({
  action: CloudAgentReviewAction,
  available: Schema.Boolean,
  blockedReason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAgentReviewActionAvailability = typeof CloudAgentReviewActionAvailability.Type;

export const CloudAgentReviewRun = Schema.Struct({
  run: CloudRun,
  terminalStatus: CloudRunStatus,
});
export type CloudAgentReviewRun = typeof CloudAgentReviewRun.Type;

export const CloudAgentReview = Schema.Struct({
  agent: CloudAgent,
  agentStatus: CloudAgentStatus,
  latestRun: CloudRun,
  runs: Schema.Array(CloudAgentReviewRun),
  allocationId: RunAllocationId,
  previewAvailability: CloudSessionAvailability,
  terminalAvailability: CloudSessionAvailability,
  previewState: RunPreviewState,
  /** What is held open right now, each with its own deadline. */
  leases: CloudSessionLeases,
  /** Present once the agent has been reopened for viewing. */
  reopen: Schema.optionalKey(CloudRuntimeReopen),
  /** What the person changed by hand during the last reopened session. */
  sessionEdits: Schema.optionalKey(CloudSessionEdits),
  idleState: RunIdleState,
  usage: Schema.optionalKey(CloudRunUsage),
  environment: Schema.optionalKey(CloudEnvironment),
  environmentReference: Schema.optionalKey(CloudEnvironmentVersionReference),
  build: CloudBuildInspection,
  snapshot: CloudSnapshotInspection,
  diff: CloudDiffInspection,
  verification: CloudDiffInspection,
  transcript: CloudDiffInspection,
  artifacts: Schema.Array(CloudArtifactInspection),
  publication: CloudPublicationInspection,
  pagePath: TrimmedNonEmptyString,
  /** False by construction: assembling this document never starts compute. */
  reviewWakesRuntime: Schema.Literal(false),
  actions: Schema.Array(CloudAgentReviewActionAvailability),
});
export type CloudAgentReview = typeof CloudAgentReview.Type;

export const CloudAgentReviewShareGrant = Schema.Struct({
  agentId: CloudAgentId,
  token: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  url: TrimmedNonEmptyString,
});
export type CloudAgentReviewShareGrant = typeof CloudAgentReviewShareGrant.Type;

export class CloudAgentReviewError extends Schema.TaggedError<CloudAgentReviewError>()(
  "CloudAgentReviewError",
  {
    reason: Schema.Literals([
      "agent-not-found",
      "agent_busy",
      "agent-archived",
      "agent-deleted",
      "snapshot-unavailable",
      "lease-unavailable",
      "publication-not-found",
      "github-failed",
      "controller-failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
