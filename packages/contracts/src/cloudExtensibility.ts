import * as Schema from "effect/Schema";

import {
  CloudAgentId,
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudRunId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  CLOUD_AGENTS_API_BUILTIN_SUBAGENTS,
  CLOUD_AGENTS_API_MAX_MCP_SERVERS,
  CLOUD_AGENTS_API_MAX_SUBAGENTS,
  CloudAgentsApiCustomSubagent,
  CloudAgentsApiMcpServer,
} from "./cloudAgentsApi.ts";
import { CloudEnvironmentConfig, CloudEnvironmentMcpServer } from "./cloudEnvironment.ts";
import { CloudEgressPolicy } from "./cloudSecurity.ts";

export {
  CLOUD_AGENTS_API_BUILTIN_SUBAGENTS,
  CLOUD_AGENTS_API_MAX_MCP_SERVERS,
  CLOUD_AGENTS_API_MAX_SUBAGENTS,
};

/** Prompt text is bounded so a create request cannot smuggle a second agent. */
export const CLOUD_CUSTOM_SUBAGENT_MAX_PROMPT_BYTES = 32 * 1024;
export const CLOUD_CUSTOM_SUBAGENT_MAX_DESCRIPTION_BYTES = 2 * 1024;
export const CLOUD_HOOK_COMMAND_MAX_BYTES = 8 * 1024;

export const CLOUD_HOOKS_REPOSITORY_PATH = ".cursor/hooks.json";
export const CLOUD_HOOKS_LOCAL_HOME_PATH = "~/.cursor/hooks.json";

export const CloudMcpTransport = Schema.Literals(["http", "sse", "stdio"]);
export type CloudMcpTransport = typeof CloudMcpTransport.Type;

export const CloudMcpScope = Schema.Literals(["team", "personal", "api", "builtin"]);
export type CloudMcpScope = typeof CloudMcpScope.Type;

/**
 * HTTP/SSE credentials, including per-user OAuth, stay on the controller.
 * stdio commands run in the guest and never receive those credentials.
 */
export const CloudMcpCredentialPlacement = Schema.Literals(["controller", "runtime"]);
export type CloudMcpCredentialPlacement = typeof CloudMcpCredentialPlacement.Type;

export const CloudMcpServerSource = Schema.Struct({
  name: TrimmedNonEmptyString,
  scope: CloudMcpScope,
  transport: CloudMcpTransport,
  url: Schema.optionalKey(TrimmedNonEmptyString),
  command: Schema.optionalKey(TrimmedNonEmptyString),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Present when the user completed OAuth for this HTTP server. */
  oauthUserId: Schema.optionalKey(TrimmedNonEmptyString),
  toolAllowlist: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type CloudMcpServerSource = typeof CloudMcpServerSource.Type;

export const CloudGuestMcpServer = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["http", "sse"]),
    name: TrimmedNonEmptyString,
    url: TrimmedNonEmptyString,
    headers: Schema.Array(
      Schema.Struct({ name: TrimmedNonEmptyString, value: TrimmedNonEmptyString }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("stdio"),
    name: TrimmedNonEmptyString,
    command: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
  }),
]);
export type CloudGuestMcpServer = typeof CloudGuestMcpServer.Type;

export const CloudMcpControllerSecret = Schema.Struct({
  serverName: TrimmedNonEmptyString,
  targetUrl: TrimmedNonEmptyString,
  headers: Schema.Record(Schema.String, Schema.String),
  oauthUserId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudMcpControllerSecret = typeof CloudMcpControllerSecret.Type;

export const CloudHookEvent = Schema.Literals([
  "sessionStart",
  "sessionEnd",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "preCompact",
  "stop",
]);
export type CloudHookEvent = typeof CloudHookEvent.Type;

export const CloudHookCommand = Schema.Struct({
  event: CloudHookEvent,
  command: TrimmedNonEmptyString,
  matcher: Schema.optionalKey(TrimmedNonEmptyString),
  timeoutSeconds: Schema.optionalKey(NonNegativeInt),
});
export type CloudHookCommand = typeof CloudHookCommand.Type;

export const CloudHookSource = Schema.Literals(["repository", "local-home"]);
export type CloudHookSource = typeof CloudHookSource.Type;

export const CloudHookPhase = Schema.Literals(["install", "runtime"]);
export type CloudHookPhase = typeof CloudHookPhase.Type;

export const CloudAdmittedHook = Schema.Struct({
  event: CloudHookEvent,
  command: TrimmedNonEmptyString,
  matcher: Schema.optionalKey(TrimmedNonEmptyString),
  timeoutSeconds: Schema.optionalKey(NonNegativeInt),
  source: Schema.Literal("repository"),
  phase: CloudHookPhase,
});
export type CloudAdmittedHook = typeof CloudAdmittedHook.Type;

export const CloudSubagentPermissionSet = Schema.Struct({
  filesystem: Schema.Boolean,
  network: Schema.Boolean,
  secrets: Schema.Boolean,
});
export type CloudSubagentPermissionSet = typeof CloudSubagentPermissionSet.Type;

export const CLOUD_PARENT_SUBAGENT_PERMISSIONS: CloudSubagentPermissionSet = {
  filesystem: true,
  network: true,
  secrets: true,
};

export const CloudAdmittedSubagent = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  model: Schema.optionalKey(TrimmedNonEmptyString),
  permissions: CloudSubagentPermissionSet,
});
export type CloudAdmittedSubagent = typeof CloudAdmittedSubagent.Type;

export const CloudExtensibilityFailureKind = Schema.Literals([
  "mcp-disabled",
  "mcp-not-allowlisted",
  "mcp-egress-denied",
  "mcp-invalid",
  "hook-unavailable",
  "hook-skipped-readonly-setup",
  "hook-invalid",
  "subagent-shadows-builtin",
  "subagent-limit",
  "subagent-invalid",
]);
export type CloudExtensibilityFailureKind = typeof CloudExtensibilityFailureKind.Type;

export const CloudExtensibilityAuditEvent = Schema.Struct({
  kind: CloudExtensibilityFailureKind,
  target: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  isolated: Schema.Literal(true),
});
export type CloudExtensibilityAuditEvent = typeof CloudExtensibilityAuditEvent.Type;

export const CloudExtensibilityAdmission = Schema.Struct({
  guestMcpServers: Schema.Array(CloudGuestMcpServer),
  controllerSecrets: Schema.Array(CloudMcpControllerSecret),
  hooks: Schema.Array(CloudAdmittedHook),
  subagents: Schema.Array(CloudAdmittedSubagent),
  audits: Schema.Array(CloudExtensibilityAuditEvent),
  /** Egress and secret bindings after admission; never wider than the input policy. */
  egressUnchanged: Schema.Boolean,
});
export type CloudExtensibilityAdmission = typeof CloudExtensibilityAdmission.Type;

export const CloudDiagnosticsSetupTool = Schema.Literals([
  "environment-info",
  "take-environment-snapshot",
  "check-environment-snapshot",
  "trigger-environment-build",
  "list-environment-builds",
  "environment-build-logs",
  "propose-environment-json",
  "request-environment-setup-actions",
]);
export type CloudDiagnosticsSetupTool = typeof CloudDiagnosticsSetupTool.Type;

export const CloudDiagnosticsRunTool = Schema.Literals([
  "run-info",
  "run-transcript",
  "run-events",
  "fleet-diagnostics",
]);
export type CloudDiagnosticsRunTool = typeof CloudDiagnosticsRunTool.Type;

export const CLOUD_DIAGNOSTICS_SETUP_TOOLS: ReadonlyArray<CloudDiagnosticsSetupTool> = [
  "environment-info",
  "take-environment-snapshot",
  "check-environment-snapshot",
  "trigger-environment-build",
  "list-environment-builds",
  "environment-build-logs",
  "propose-environment-json",
  "request-environment-setup-actions",
];

export const CLOUD_DIAGNOSTICS_RUN_TOOLS: ReadonlyArray<CloudDiagnosticsRunTool> = [
  "run-info",
  "run-transcript",
  "run-events",
  "fleet-diagnostics",
];

/** Cursor MCP names map onto the CA-51 tools without changing arguments. */
export const CLOUD_DIAGNOSTICS_CURSOR_TOOL_NAMES: Readonly<Record<string, string>> = {
  "environment-info": "environment-info",
  "cursor-cloud-environment-info": "environment-info",
  "take-environment-snapshot": "take-environment-snapshot",
  "cursor-cloud-take-environment-snapshot": "take-environment-snapshot",
  "check-environment-snapshot": "check-environment-snapshot",
  "cursor-cloud-check-environment-snapshot": "check-environment-snapshot",
  "trigger-environment-build": "trigger-environment-build",
  "cursor-cloud-trigger-environment-build": "trigger-environment-build",
  "list-environment-builds": "list-environment-builds",
  "cursor-cloud-list-environment-builds": "list-environment-builds",
  "environment-build-logs": "environment-build-logs",
  "cursor-cloud-environment-build-logs": "environment-build-logs",
  "propose-environment-json": "propose-environment-json",
  "cursor-cloud-propose-environment-json": "propose-environment-json",
  "request-environment-setup-actions": "request-environment-setup-actions",
  "cursor-cloud-request-environment-setup-actions": "request-environment-setup-actions",
};

export const CloudEnvironmentSnapshotStatus = Schema.Literals(["creating", "ready", "failed"]);
export type CloudEnvironmentSnapshotStatus = typeof CloudEnvironmentSnapshotStatus.Type;

export const CloudEnvironmentSnapshotRecord = Schema.Struct({
  snapshotId: TrimmedNonEmptyString,
  status: CloudEnvironmentSnapshotStatus,
  createdAt: IsoDateTime,
  environmentId: Schema.optionalKey(CloudEnvironmentId),
  message: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudEnvironmentSnapshotRecord = typeof CloudEnvironmentSnapshotRecord.Type;

export const CloudEnvironmentSetupAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("add_secrets"),
    secrets: Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString,
        optional: Schema.Boolean,
      }),
    ),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("add_egress_allowlist_domain"),
    domain: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("external_action"),
    id: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
    instructions: TrimmedNonEmptyString,
  }),
]);
export type CloudEnvironmentSetupAction = typeof CloudEnvironmentSetupAction.Type;

export const CloudEnvironmentInfo = Schema.Struct({
  environmentId: Schema.optionalKey(CloudEnvironmentId),
  url: Schema.optionalKey(TrimmedNonEmptyString),
  environmentJsonPath: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  sourceType: Schema.optionalKey(TrimmedNonEmptyString),
  activeBuildId: Schema.optionalKey(CloudEnvironmentBuildId),
  defaultRevision: Schema.optionalKey(TrimmedNonEmptyString),
  config: Schema.optionalKey(CloudEnvironmentConfig),
});
export type CloudEnvironmentInfo = typeof CloudEnvironmentInfo.Type;

export const CloudRunDiagnostics = Schema.Struct({
  agentId: CloudAgentId,
  runId: CloudRunId,
  status: TrimmedNonEmptyString,
  repository: Schema.optionalKey(TrimmedNonEmptyString),
  environmentId: Schema.optionalKey(CloudEnvironmentId),
});
export type CloudRunDiagnostics = typeof CloudRunDiagnostics.Type;

export const CloudSubagentUsageEvent = Schema.Struct({
  runId: CloudRunId,
  subagentName: TrimmedNonEmptyString,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
});
export type CloudSubagentUsageEvent = typeof CloudSubagentUsageEvent.Type;

export const CloudExtensibilityPolicyInput = Schema.Struct({
  disableAllMcpServers: Schema.Boolean,
  mcpServerAllowlist: Schema.Array(CloudEnvironmentMcpServer),
  egress: CloudEgressPolicy,
  controllerMcpOrigin: TrimmedNonEmptyString,
  phase: CloudHookPhase,
  parentPermissions: CloudSubagentPermissionSet,
});
export type CloudExtensibilityPolicyInput = typeof CloudExtensibilityPolicyInput.Type;

export class CloudDiagnosticsError extends Schema.TaggedError<CloudDiagnosticsError>()(
  "CloudDiagnosticsError",
  {
    reason: Schema.Literals([
      "unavailable",
      "not-found",
      "unauthorized",
      "invalid-request",
      "persistence-failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

export const CloudExtensibilitySources = Schema.Struct({
  teamMcp: Schema.Array(CloudMcpServerSource),
  personalMcp: Schema.Array(CloudMcpServerSource),
  apiMcp: Schema.Array(CloudAgentsApiMcpServer),
  hooksJson: Schema.optionalKey(Schema.String),
  hooksSource: Schema.optionalKey(CloudHookSource),
  customSubagents: Schema.Array(CloudAgentsApiCustomSubagent),
  requestedSubagentPermissions: Schema.optionalKey(
    Schema.Record(Schema.String, CloudSubagentPermissionSet),
  ),
});
export type CloudExtensibilitySources = typeof CloudExtensibilitySources.Type;
