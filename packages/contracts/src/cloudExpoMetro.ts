import * as Schema from "effect/Schema";

import {
  CloudAgentId,
  CloudRunId,
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  RunAllocationAttempt,
  RunAllocationId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const CloudExpoPlatform = Schema.Literals(["android", "ios"]);
export type CloudExpoPlatform = typeof CloudExpoPlatform.Type;

export const CloudExpoPackageManager = Schema.Literals(["bun", "npm", "pnpm", "yarn"]);
export type CloudExpoPackageManager = typeof CloudExpoPackageManager.Type;

export const CloudExpoMetroIntent = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("enabled"),
    runId: CloudRunId,
    platform: CloudExpoPlatform,
    requestedAt: IsoDateTime,
  }),
  Schema.Struct({ status: Schema.Literal("disabled"), stoppedAt: IsoDateTime }),
]);
export type CloudExpoMetroIntent = typeof CloudExpoMetroIntent.Type;

export const CloudExpoProject = Schema.Struct({
  root: TrimmedNonEmptyString,
  packageManager: CloudExpoPackageManager,
});
export type CloudExpoProject = typeof CloudExpoProject.Type;

export const CloudExpoDevelopmentBuildCompatibility = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("compatible"),
    fastRefreshPaths: Schema.Array(TrimmedNonEmptyString),
    detail: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("rebuild-required"),
    nativePaths: Schema.Array(TrimmedNonEmptyString),
    fastRefreshPaths: Schema.Array(TrimmedNonEmptyString),
    detail: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    detail: TrimmedNonEmptyString,
  }),
]);
export type CloudExpoDevelopmentBuildCompatibility =
  typeof CloudExpoDevelopmentBuildCompatibility.Type;

const CloudExpoMetroStopped = Schema.Struct({ status: Schema.Literal("stopped") });
const CloudExpoMetroStarting = Schema.Struct({
  status: Schema.Literal("starting"),
  startedAt: IsoDateTime,
});
const CloudExpoMetroRunning = Schema.Struct({
  status: Schema.Literal("running"),
  startedAt: IsoDateTime,
  startupMs: NonNegativeInt,
  lastClientConnectionAt: Schema.optionalKey(IsoDateTime),
});
const CloudExpoMetroFailed = Schema.Struct({
  status: Schema.Literal("error"),
  reason: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
});

const CloudExpoTunnelUnavailable = Schema.Struct({ status: Schema.Literal("unavailable") });
const CloudExpoTunnelConnecting = Schema.Struct({ status: Schema.Literal("connecting") });
const CloudExpoTunnelReady = Schema.Struct({
  status: Schema.Literal("ready"),
  deepLink: TrimmedNonEmptyString,
  scheme: TrimmedNonEmptyString,
  appId: Schema.optionalKey(TrimmedNonEmptyString),
  issuedAt: IsoDateTime,
});
const CloudExpoTunnelFailed = Schema.Struct({
  status: Schema.Literal("error"),
  reason: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
});

export const CloudExpoMetroSession = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("stopped"),
    metro: CloudExpoMetroStopped,
    tunnel: CloudExpoTunnelUnavailable,
    logs: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("starting"),
    metro: CloudExpoMetroStarting,
    tunnel: CloudExpoTunnelConnecting,
    logs: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    metro: CloudExpoMetroRunning,
    tunnel: CloudExpoTunnelReady,
    logs: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("metro-error"),
    metro: CloudExpoMetroFailed,
    tunnel: CloudExpoTunnelUnavailable,
    logs: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("tunnel-error"),
    metro: CloudExpoMetroRunning,
    tunnel: CloudExpoTunnelFailed,
    logs: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("startup-error"),
    metro: CloudExpoMetroFailed,
    tunnel: CloudExpoTunnelFailed,
    logs: Schema.String,
  }),
]);
export type CloudExpoMetroSession = typeof CloudExpoMetroSession.Type;

const CloudExpoMetroStatusBase = {
  agentId: CloudAgentId,
  allocationId: RunAllocationId,
  runId: CloudRunId,
  attempt: RunAllocationAttempt,
};

export const CloudExpoMetroStatus = Schema.Union([
  Schema.Struct({
    ...CloudExpoMetroStatusBase,
    status: Schema.Literal("unavailable"),
    reasonCode: Schema.Literals(["runtime-unavailable", "not-expo-development-client"]),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...CloudExpoMetroStatusBase,
    status: Schema.Literal("available"),
    platform: Schema.optionalKey(CloudExpoPlatform),
    project: CloudExpoProject,
    compatibility: CloudExpoDevelopmentBuildCompatibility,
    session: CloudExpoMetroSession,
  }),
]);
export type CloudExpoMetroStatus = typeof CloudExpoMetroStatus.Type;

export const CloudExpoMetroInspectInput = Schema.Struct({ agentId: CloudAgentId });
export type CloudExpoMetroInspectInput = typeof CloudExpoMetroInspectInput.Type;

const CloudExpoMetroControlBase = {
  agentId: CloudAgentId,
  commandId: CommandId,
  occurredAt: IsoDateTime,
};

export const CloudExpoMetroControlInput = Schema.Union([
  Schema.Struct({
    ...CloudExpoMetroControlBase,
    action: Schema.Literals(["start", "restart"]),
    platform: CloudExpoPlatform,
  }),
  Schema.Struct({ ...CloudExpoMetroControlBase, action: Schema.Literal("stop") }),
]);
export type CloudExpoMetroControlInput = typeof CloudExpoMetroControlInput.Type;

export class CloudExpoMetroError extends Schema.TaggedError<CloudExpoMetroError>()(
  "CloudExpoMetroError",
  {
    reason: Schema.Literals([
      "agent-not-found",
      "allocation-not-found",
      "runtime-unavailable",
      "controller-failed",
      "provider-failed",
      "invalid-project",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
