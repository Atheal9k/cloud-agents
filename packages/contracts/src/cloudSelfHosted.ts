import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CloudRuntimeHosting } from "./cloudSecurity.ts";
import { CloudUsageDimension } from "./cloudAccounting.ts";

export const SELF_HOSTED_WORKER_PROFILE_ID = "self-hosted";
export const CLOUD_SELF_HOSTED_API_PREFIX = "/v0/private-workers";
export const CLOUD_SELF_HOSTED_STREAM_CURSOR_TTL_MS = 5 * 60 * 1000;
export const CLOUD_SELF_HOSTED_STREAM_HEARTBEAT_MS = 20_000;
export const CLOUD_SELF_HOSTED_MAX_WORKER_DIRS = 20;
export const CLOUD_SELF_HOSTED_DEFAULT_PAGE_LIMIT = 50;
export const CLOUD_SELF_HOSTED_MAX_PAGE_LIMIT = 100;
export const CLOUD_SELF_HOSTED_DEFAULT_IDLE_RELEASE_SECONDS = 3600;
export const CLOUD_SELF_HOSTED_DEFAULT_PERSONAL_MAX_AGENTS = 8;
export const CLOUD_SELF_HOSTED_TEAM_POOL_MAX_AGENTS = 1;
export const CLOUD_SELF_HOSTED_MAX_WORKERS_PER_USER = 200;
export const CLOUD_SELF_HOSTED_MAX_WORKERS_PER_TEAM = 1000;
export const CLOUD_SELF_HOSTED_MAX_CONCURRENT_STREAMS = 4;

export const CloudSelfHostedPolicyMode = Schema.Literals(["off", "allow", "require"]);
export type CloudSelfHostedPolicyMode = typeof CloudSelfHostedPolicyMode.Type;

export const CloudSelfHostedPoolScope = Schema.Literals(["user", "team"]);
export type CloudSelfHostedPoolScope = typeof CloudSelfHostedPoolScope.Type;

export const CloudSelfHostedWorkerKind = Schema.Literals(["personal", "team_pool"]);
export type CloudSelfHostedWorkerKind = typeof CloudSelfHostedWorkerKind.Type;

export const CloudSelfHostedListScope = Schema.Literals(["all", "team_pool", "personal"]);
export type CloudSelfHostedListScope = typeof CloudSelfHostedListScope.Type;

export const CloudSelfHostedWorkerStatusFilter = Schema.Literals(["all", "in_use", "idle"]);
export type CloudSelfHostedWorkerStatusFilter = typeof CloudSelfHostedWorkerStatusFilter.Type;

export const CloudSelfHostedLabel = Schema.Struct({
  key: TrimmedNonEmptyString,
  value: TrimmedNonEmptyString,
});
export type CloudSelfHostedLabel = typeof CloudSelfHostedLabel.Type;

export const CloudSelfHostedPool = Schema.Struct({
  scope: CloudSelfHostedPoolScope,
  ownerId: NonNegativeInt,
  poolName: TrimmedNonEmptyString,
  connectedWorkerCount: NonNegativeInt,
  inUseWorkerCount: NonNegativeInt,
  firstSeenAtMs: NonNegativeInt,
  lastSeenAtMs: NonNegativeInt,
  isStale: Schema.Boolean,
  deleted: Schema.Boolean,
  workerReadyTimeoutSeconds: NonNegativeInt,
  repoOwner: Schema.optionalKey(TrimmedNonEmptyString),
  repoName: Schema.optionalKey(TrimmedNonEmptyString),
  repoUrl: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudSelfHostedPool = typeof CloudSelfHostedPool.Type;

export const CloudSelfHostedRegisterPoolRequest = Schema.Struct({
  scope: CloudSelfHostedPoolScope,
  poolName: TrimmedNonEmptyString,
  repoOwner: Schema.optionalKey(TrimmedNonEmptyString),
  repoName: Schema.optionalKey(TrimmedNonEmptyString),
  repoUrl: Schema.optionalKey(TrimmedNonEmptyString),
  workerReadyTimeoutSeconds: Schema.optionalKey(NonNegativeInt),
});
export type CloudSelfHostedRegisterPoolRequest = typeof CloudSelfHostedRegisterPoolRequest.Type;

export const CloudSelfHostedWorker = Schema.Struct({
  workerId: TrimmedNonEmptyString,
  kind: CloudSelfHostedWorkerKind,
  isInUse: Schema.Boolean,
  connected: Schema.Boolean,
  repoOwner: Schema.String,
  repoName: Schema.String,
  workspaceRootPath: TrimmedNonEmptyString,
  workspaceRoots: Schema.Array(TrimmedNonEmptyString),
  connectedAtMs: NonNegativeInt,
  lastSeenAtMs: NonNegativeInt,
  userId: NonNegativeInt,
  labels: Schema.Array(CloudSelfHostedLabel),
  maxAgents: PositiveInt,
  activeAgentIds: Schema.Array(TrimmedNonEmptyString),
  outboundOnly: Schema.Literal(true),
  cloneGitRepos: Schema.Boolean,
  mintGithubToken: Schema.Boolean,
  secretSync: Schema.Boolean,
  identitySocket: Schema.Boolean,
  computerUse: Schema.Boolean,
  managementAddr: Schema.optionalKey(TrimmedNonEmptyString),
  poolName: Schema.optionalKey(TrimmedNonEmptyString),
  repoUrl: Schema.optionalKey(TrimmedNonEmptyString),
  teamId: Schema.optionalKey(NonNegativeInt),
  serviceAccountId: Schema.optionalKey(TrimmedNonEmptyString),
  activeBcId: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudSelfHostedWorker = typeof CloudSelfHostedWorker.Type;

export const CloudSelfHostedConnectWorkerRequest = Schema.Struct({
  workerId: Schema.optionalKey(TrimmedNonEmptyString),
  kind: CloudSelfHostedWorkerKind,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  poolName: Schema.optionalKey(TrimmedNonEmptyString),
  workspaceRoots: Schema.Array(TrimmedNonEmptyString),
  labels: Schema.optionalKey(Schema.Array(CloudSelfHostedLabel)),
  repoOwner: Schema.optionalKey(Schema.String),
  repoName: Schema.optionalKey(Schema.String),
  repoUrl: Schema.optionalKey(TrimmedNonEmptyString),
  maxAgents: Schema.optionalKey(PositiveInt),
  cloneGitRepos: Schema.optionalKey(Schema.Boolean),
  mintGithubToken: Schema.optionalKey(Schema.Boolean),
  secretSync: Schema.optionalKey(Schema.Boolean),
  identitySocket: Schema.optionalKey(Schema.Boolean),
  computerUse: Schema.optionalKey(Schema.Boolean),
  managementAddr: Schema.optionalKey(TrimmedNonEmptyString),
  idleReleaseTimeoutSeconds: Schema.optionalKey(NonNegativeInt),
});
export type CloudSelfHostedConnectWorkerRequest = typeof CloudSelfHostedConnectWorkerRequest.Type;

export const CloudSelfHostedPendingRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  userId: NonNegativeInt,
  createdAtMs: NonNegativeInt,
  labels: Schema.Array(CloudSelfHostedLabel),
  userEmail: Schema.optionalKey(TrimmedNonEmptyString),
  serviceAccountId: Schema.optionalKey(TrimmedNonEmptyString),
  repoOwner: Schema.optionalKey(TrimmedNonEmptyString),
  repoName: Schema.optionalKey(TrimmedNonEmptyString),
  repoUrl: Schema.optionalKey(TrimmedNonEmptyString),
  claimedWorkerId: Schema.optionalKey(TrimmedNonEmptyString),
  wakeTimeoutMs: Schema.optionalKey(NonNegativeInt),
});
export type CloudSelfHostedPendingRequest = typeof CloudSelfHostedPendingRequest.Type;

export const CloudSelfHostedWatchEventType = Schema.Literals([
  "created",
  "claimed",
  "claimed_offline",
  "expired",
  "heartbeat",
]);
export type CloudSelfHostedWatchEventType = typeof CloudSelfHostedWatchEventType.Type;

export const CloudSelfHostedWatchEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  event: CloudSelfHostedWatchEventType,
  data: Schema.Unknown,
  createdAtMs: NonNegativeInt,
});
export type CloudSelfHostedWatchEvent = typeof CloudSelfHostedWatchEvent.Type;

export const CloudSelfHostedErrorCode = Schema.Literals([
  "unauthorized",
  "invalid_request",
  "cursor_expired",
  "claim_conflict",
  "self_hosted_disabled",
  "self_hosted_required",
  "pool_auth_required",
  "worker_busy",
]);
export type CloudSelfHostedErrorCode = typeof CloudSelfHostedErrorCode.Type;

export const CloudSelfHostedErrorBody = Schema.Struct({
  code: CloudSelfHostedErrorCode,
  message: TrimmedNonEmptyString,
});
export type CloudSelfHostedErrorBody = typeof CloudSelfHostedErrorBody.Type;

export const CloudSelfHostedLaunchDifferenceArea = Schema.Literals([
  "permission",
  "billing",
  "network",
  "artifact",
  "secret",
]);
export type CloudSelfHostedLaunchDifferenceArea = typeof CloudSelfHostedLaunchDifferenceArea.Type;

export const CloudSelfHostedLaunchDifference = Schema.Struct({
  area: CloudSelfHostedLaunchDifferenceArea,
  managed: TrimmedNonEmptyString,
  selfHosted: TrimmedNonEmptyString,
  billedDimensions: Schema.optionalKey(Schema.Array(CloudUsageDimension)),
});
export type CloudSelfHostedLaunchDifference = typeof CloudSelfHostedLaunchDifference.Type;

export const CloudSelfHostedLaunchPreview = Schema.Struct({
  policy: CloudSelfHostedPolicyMode,
  target: Schema.Literals(["cloud", "pool", "machine"]),
  allowed: Schema.Boolean,
  hosting: CloudRuntimeHosting,
  differences: Schema.Array(CloudSelfHostedLaunchDifference),
  denial: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudSelfHostedLaunchPreview = typeof CloudSelfHostedLaunchPreview.Type;

export const CloudSelfHostedManagementPath = Schema.Literals(["/healthz", "/readyz", "/metrics"]);
export type CloudSelfHostedManagementPath = typeof CloudSelfHostedManagementPath.Type;

export function isSelfHostedWorkerProfile(profile: { readonly id: string }): boolean {
  return profile.id === SELF_HOSTED_WORKER_PROFILE_ID;
}

export function admitSelfHostedTarget(input: {
  readonly policy: CloudSelfHostedPolicyMode;
  readonly target: "cloud" | "pool" | "machine";
}): { readonly code: "self_hosted_disabled" | "self_hosted_required"; readonly message: string } | undefined {
  if (input.policy === "off" && input.target !== "cloud") {
    return {
      code: "self_hosted_disabled",
      message:
        "An admin must allow self-hosted machines before a pool or personal worker can run this agent.",
    };
  }
  if (input.policy === "require" && input.target === "cloud") {
    return {
      code: "self_hosted_required",
      message: "This team requires self-hosted machines. Target a pool or personal machine.",
    };
  }
  return undefined;
}

export function selfHostedLaunchPreview(input: {
  readonly policy: CloudSelfHostedPolicyMode;
  readonly target: "cloud" | "pool" | "machine";
}): CloudSelfHostedLaunchPreview {
  const denial = admitSelfHostedTarget(input);
  const hosting = input.target === "cloud" ? "managed" : "self-hosted";
  return {
    policy: input.policy,
    target: input.target,
    allowed: denial === undefined,
    hosting,
    differences: [
      {
        area: "permission",
        managed: "Controller IAM and the triggering user's SCM grants.",
        selfHosted:
          input.target === "machine"
            ? "The machine owner; personal workers may share assignment."
            : "The pool's service account. Team pools take one agent per worker.",
      },
      {
        area: "billing",
        managed: "Model tokens plus guest time, hypervisor allocation, snapshots, and artifacts.",
        selfHosted: "Model tokens and uploaded artifacts. No hypervisor or guest-time charge.",
        billedDimensions:
          input.target === "cloud"
            ? [
                "model-tokens",
                "active-guest-time",
                "hypervisor-allocation",
                "snapshots",
                "artifacts-transfer",
              ]
            : ["model-tokens", "artifacts-transfer"],
      },
      {
        area: "network",
        managed: "Environment egress policy, including allowlists and controller exceptions.",
        selfHosted: "Workers connect outbound only. No inbound ports or public IPs.",
      },
      {
        area: "artifact",
        managed: "Snapshots and artifacts stay on controller-encrypted storage.",
        selfHosted: "Tool output stays on the machine until the worker uploads artifacts.",
      },
      {
        area: "secret",
        managed: "Controller injects Build and runtime secrets into the guest.",
        selfHosted: "Optional clone, token mint, and secret sync. Values never appear in metadata.",
      },
    ],
    ...(denial === undefined ? {} : { denial: denial.message }),
  };
}

export const CloudSelfHostedPolicyModeField = Schema.optionalKey(CloudSelfHostedPolicyMode);
