import * as Schema from "effect/Schema";

import { CloudAgentId, CloudRunId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CloudCollaborationDefault } from "./cloudAccounting.ts";
import { CloudAgentsApiCreateAgentRequest, CloudAgentsApiPrompt } from "./cloudAgentsApi.ts";
import { CloudScmScope } from "./cloudSecurity.ts";

/** Local controllers are one team until a hosted multi-team catalog exists. */
export const DEFAULT_CLOUD_TEAM_ID = "local-team";

export const CLOUD_AGENT_BRANCH_PREFIX = "cursor/";

export const CloudScmHostKind = Schema.Literals([
  "github",
  "github-enterprise",
  "gitlab",
  "gitlab-self-hosted",
  "bitbucket",
  "azure-devops",
]);
export type CloudScmHostKind = typeof CloudScmHostKind.Type;

export const CloudRunEntryPoint = Schema.Literals([
  "web",
  "desktop",
  "api",
  "slack",
  "github-mention",
  "bitbucket-mention",
  "linear",
]);
export type CloudRunEntryPoint = typeof CloudRunEntryPoint.Type;

/** Admin policy for teammates following up on someone else's agent. */
export const CloudTeamFollowUpPolicy = CloudCollaborationDefault;
export type CloudTeamFollowUpPolicy = typeof CloudTeamFollowUpPolicy.Type;

export const CLOUD_TEAM_FOLLOW_UP_LATERAL_ACCESS_WARNING =
  "Teammate follow-ups can reach repositories and threads the follower did not create. Treat that as lateral access.";

export const CLOUD_TEAM_FOLLOW_UP_SECRET_RISK_WARNING =
  "A follow-up can observe runtime-redacted secrets already bound to the agent. Disable team follow-ups if that is too wide.";

export const CloudBranchBehavior = Schema.Literals([
  "new-cursor-branch",
  "current-branch",
  "starting-ref",
  "continue-pr",
]);
export type CloudBranchBehavior = typeof CloudBranchBehavior.Type;

export const CloudScmConnection = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: CloudScmHostKind,
  displayName: TrimmedNonEmptyString,
  baseUrl: TrimmedNonEmptyString,
  installedRepositories: Schema.Array(TrimmedNonEmptyString),
  connectedAt: IsoDateTime,
});
export type CloudScmConnection = typeof CloudScmConnection.Type;

export const CloudScmConnectionInput = Schema.Struct({
  kind: CloudScmHostKind,
  displayName: TrimmedNonEmptyString,
  baseUrl: TrimmedNonEmptyString,
  installedRepositories: Schema.Array(TrimmedNonEmptyString),
});
export type CloudScmConnectionInput = typeof CloudScmConnectionInput.Type;

export const CloudSharedAgentViewMode = Schema.Literals(["owner", "read-only"]);
export type CloudSharedAgentViewMode = typeof CloudSharedAgentViewMode.Type;

export const CloudIdempotentRunRecord = Schema.Struct({
  entryPoint: CloudRunEntryPoint,
  deliveryId: TrimmedNonEmptyString,
  agentId: CloudAgentId,
  runId: CloudRunId,
  createdAt: IsoDateTime,
});
export type CloudIdempotentRunRecord = typeof CloudIdempotentRunRecord.Type;

export const CloudCollaborationAdmitInput = Schema.Struct({
  entryPoint: CloudRunEntryPoint,
  deliveryId: TrimmedNonEmptyString,
  teamId: TrimmedNonEmptyString,
  actorId: TrimmedNonEmptyString,
  actorKind: Schema.Literals(["user", "service_account"]),
  actorRepositories: Schema.Array(TrimmedNonEmptyString),
  agentId: Schema.optionalKey(TrimmedNonEmptyString),
  prompt: CloudAgentsApiPrompt,
  create: Schema.optionalKey(CloudAgentsApiCreateAgentRequest),
});
export type CloudCollaborationAdmitInput = typeof CloudCollaborationAdmitInput.Type;

export const CloudParsedRepository = Schema.Struct({
  kind: CloudScmHostKind,
  repository: TrimmedNonEmptyString,
  hostPath: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type CloudParsedRepository = typeof CloudParsedRepository.Type;

export const CloudBranchPlan = Schema.Struct({
  behavior: CloudBranchBehavior,
  branch: TrimmedNonEmptyString,
  selectedRef: TrimmedNonEmptyString,
  skipReviewerRequest: Schema.Boolean,
  autoCreatePR: Schema.Boolean,
});
export type CloudBranchPlan = typeof CloudBranchPlan.Type;

export class CloudCollaborationError extends Schema.TaggedError<CloudCollaborationError>()(
  "CloudCollaborationError",
  {
    reason: Schema.Literals([
      "scm-access-denied",
      "follow-up-forbidden",
      "share-forbidden",
      "unknown-connection",
      "invalid-delivery",
      "persistence-failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

export const CloudScmAccessSets = Schema.Struct({
  installRepositories: Schema.Array(TrimmedNonEmptyString),
  principalRepositories: Schema.Array(TrimmedNonEmptyString),
  configuredRepositories: Schema.Array(TrimmedNonEmptyString),
  repository: TrimmedNonEmptyString,
  scope: CloudScmScope,
});
export type CloudScmAccessSets = typeof CloudScmAccessSets.Type;
