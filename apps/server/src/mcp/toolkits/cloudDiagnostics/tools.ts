import {
  CloudDiagnosticsError,
  CloudEnvironmentBuild,
  CloudEnvironmentConfig,
  CloudEnvironmentInfo,
  CloudEnvironmentSetupAction,
  CloudEnvironmentSnapshotRecord,
  CloudRunDiagnostics,
  McpCapabilityUnavailableError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as CloudDiagnosticsCatalog from "../../../cloud/CloudDiagnosticsCatalog.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  CloudDiagnosticsCatalog.CloudDiagnosticsCatalog,
];

export const CloudDiagnosticsToolError = Schema.Union([
  McpCapabilityUnavailableError,
  CloudDiagnosticsError,
]);
export type CloudDiagnosticsToolError = typeof CloudDiagnosticsToolError.Type;

const EnvironmentTarget = Schema.Struct({
  environmentId: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "Existing environment ID when known." }),
  ),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "Repository used to resolve the environment." }),
  ),
});

const SnapshotIdInput = Schema.Struct({
  snapshotId: TrimmedNonEmptyString.annotate({
    description: "ID returned by take-environment-snapshot.",
  }),
});

const TriggerBuildInput = Schema.Struct({
  environmentId: Schema.optional(TrimmedNonEmptyString),
  environmentJson: Schema.optional(CloudEnvironmentConfig),
  refs: Schema.optional(Schema.Unknown),
});

const BuildIdInput = Schema.Struct({
  buildId: TrimmedNonEmptyString.annotate({ description: "Environment Build ID." }),
});

const ProposeInput = Schema.Struct({
  environmentJson: CloudEnvironmentConfig,
  buildId: Schema.optional(TrimmedNonEmptyString),
});

const SetupActionsInput = Schema.Struct({
  actions: Schema.Array(CloudEnvironmentSetupAction),
});

const RunTarget = Schema.Struct({
  runId: Schema.optional(TrimmedNonEmptyString),
  agentId: Schema.optional(TrimmedNonEmptyString),
});

const RunIdInput = Schema.Struct({
  runId: TrimmedNonEmptyString,
});

function setupTool<Name extends string, Parameters extends Schema.Top, Success extends Schema.Top>(
  name: Name,
  description: string,
  parameters: Parameters,
  success: Success,
  options: { readonly readonly: boolean; readonly destructive: boolean; readonly title: string },
) {
  return Tool.make(name, {
    description,
    parameters,
    success,
    failure: CloudDiagnosticsToolError,
    dependencies,
  })
    .annotate(Tool.Title, options.title)
    .annotate(Tool.Readonly, options.readonly)
    .annotate(Tool.Destructive, options.destructive)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false);
}

export const EnvironmentInfoTool = setupTool(
  "environment-info",
  "Report the effective Cloud Agent environment for this run: ID, URL, environmentJsonPath, saved config, and active Build.",
  EnvironmentTarget,
  CloudEnvironmentInfo,
  { title: "Environment info", readonly: true, destructive: false },
);

export const TakeSnapshotTool = setupTool(
  "take-environment-snapshot",
  "Snapshot the current VM after local install state is correct. Poll check-environment-snapshot until ready.",
  EnvironmentTarget,
  CloudEnvironmentSnapshotRecord,
  { title: "Take environment snapshot", readonly: false, destructive: false },
);

export const CheckSnapshotTool = setupTool(
  "check-environment-snapshot",
  "Return creating, ready, or failed for a snapshot created by take-environment-snapshot.",
  SnapshotIdInput,
  CloudEnvironmentSnapshotRecord,
  { title: "Check environment snapshot", readonly: true, destructive: false },
);

export const TriggerBuildTool = setupTool(
  "trigger-environment-build",
  "Start a draft environment Build. Passing environmentJson creates and links a personal draft when no environment ID exists. Prefer omitting refs so the Build uses each repository's default revision.",
  TriggerBuildInput,
  CloudEnvironmentBuild,
  { title: "Trigger environment Build", readonly: false, destructive: false },
);

export const ListBuildsTool = setupTool(
  "list-environment-builds",
  "List environment Builds, newest first, including draft agent-requested Builds.",
  EnvironmentTarget,
  Schema.Struct({ builds: Schema.Array(CloudEnvironmentBuild) }),
  { title: "List environment Builds", readonly: true, destructive: false },
);

export const BuildLogsTool = setupTool(
  "environment-build-logs",
  "Return the complete log for one environment Build.",
  BuildIdInput,
  CloudEnvironmentBuild,
  { title: "Environment Build logs", readonly: true, destructive: false },
);

export const ProposeTool = setupTool(
  "propose-environment-json",
  "Propose the final environment.json for the user to review and Save. Pass buildId when a draft Build was tested. A proposal does not save the environment.",
  ProposeInput,
  Schema.Struct({
    proposed: Schema.Literal(true),
    buildId: Schema.optional(TrimmedNonEmptyString),
  }),
  { title: "Propose environment JSON", readonly: false, destructive: false },
);

export const RequestActionsTool = setupTool(
  "request-environment-setup-actions",
  "Record required user actions that currently block environment setup. Accepts add_secrets, add_egress_allowlist_domain, and external_action. Do not use add_test_login.",
  SetupActionsInput,
  Schema.Struct({ accepted: Schema.Int }),
  { title: "Request environment setup actions", readonly: false, destructive: false },
);

export const RunInfoTool = setupTool(
  "run-info",
  "Return this Cloud Agent run's identity, status, repository, and environment.",
  RunTarget,
  CloudRunDiagnostics,
  { title: "Run info", readonly: true, destructive: false },
);

export const RunTranscriptTool = setupTool(
  "run-transcript",
  "Return the bounded transcript projection for a Cloud Agent run.",
  RunIdInput,
  Schema.Struct({ events: Schema.Array(Schema.Unknown) }),
  { title: "Run transcript", readonly: true, destructive: false },
);

export const RunEventsTool = setupTool(
  "run-events",
  "Return derived run events, including custom subagent usage when recorded.",
  RunIdInput,
  Schema.Struct({ events: Schema.Array(Schema.Unknown) }),
  { title: "Run events", readonly: true, destructive: false },
);

export const FleetDiagnosticsTool = setupTool(
  "fleet-diagnostics",
  "Authorized fleet diagnostics: allocations, Mac hosts, warm guests, and capacity. Requires the cloud-fleet capability.",
  // Empty structs serialize as `anyOf [object, array]`, which is not a valid
  // MCP tool input schema. A record with no possible values encodes as an
  // object that accepts no properties.
  Schema.Record(Schema.String, Schema.Never),
  Schema.Unknown,
  { title: "Fleet diagnostics", readonly: true, destructive: false },
);

const environmentInfoAlias = setupTool(
  "cursor-cloud-environment-info",
  "Report the effective Cloud Agent environment for this run: ID, URL, environmentJsonPath, saved config, and active Build.",
  EnvironmentTarget,
  CloudEnvironmentInfo,
  { title: "Environment info", readonly: true, destructive: false },
);

const takeSnapshotAlias = setupTool(
  "cursor-cloud-take-environment-snapshot",
  "Snapshot the current VM after local install state is correct. Poll check-environment-snapshot until ready.",
  EnvironmentTarget,
  CloudEnvironmentSnapshotRecord,
  { title: "Take environment snapshot", readonly: false, destructive: false },
);

const checkSnapshotAlias = setupTool(
  "cursor-cloud-check-environment-snapshot",
  "Return creating, ready, or failed for a snapshot created by take-environment-snapshot.",
  SnapshotIdInput,
  CloudEnvironmentSnapshotRecord,
  { title: "Check environment snapshot", readonly: true, destructive: false },
);

const triggerBuildAlias = setupTool(
  "cursor-cloud-trigger-environment-build",
  "Start a draft environment Build. Passing environmentJson creates and links a personal draft when no environment ID exists.",
  TriggerBuildInput,
  CloudEnvironmentBuild,
  { title: "Trigger environment Build", readonly: false, destructive: false },
);

const listBuildsAlias = setupTool(
  "cursor-cloud-list-environment-builds",
  "List environment Builds, newest first, including draft agent-requested Builds.",
  EnvironmentTarget,
  Schema.Struct({ builds: Schema.Array(CloudEnvironmentBuild) }),
  { title: "List environment Builds", readonly: true, destructive: false },
);

const buildLogsAlias = setupTool(
  "cursor-cloud-environment-build-logs",
  "Return the complete log for one environment Build.",
  BuildIdInput,
  CloudEnvironmentBuild,
  { title: "Environment Build logs", readonly: true, destructive: false },
);

const proposeAlias = setupTool(
  "cursor-cloud-propose-environment-json",
  "Propose the final environment.json for the user to review and Save. Pass buildId when a draft Build was tested.",
  ProposeInput,
  Schema.Struct({
    proposed: Schema.Literal(true),
    buildId: Schema.optional(TrimmedNonEmptyString),
  }),
  { title: "Propose environment JSON", readonly: false, destructive: false },
);

const requestActionsAlias = setupTool(
  "cursor-cloud-request-environment-setup-actions",
  "Record required user actions that currently block environment setup. Accepts add_secrets, add_egress_allowlist_domain, and external_action.",
  SetupActionsInput,
  Schema.Struct({ accepted: Schema.Int }),
  { title: "Request environment setup actions", readonly: false, destructive: false },
);

export const CloudDiagnosticsToolkit = Toolkit.make(
  EnvironmentInfoTool,
  TakeSnapshotTool,
  CheckSnapshotTool,
  TriggerBuildTool,
  ListBuildsTool,
  BuildLogsTool,
  ProposeTool,
  RequestActionsTool,
  RunInfoTool,
  RunTranscriptTool,
  RunEventsTool,
  FleetDiagnosticsTool,
  environmentInfoAlias,
  takeSnapshotAlias,
  checkSnapshotAlias,
  triggerBuildAlias,
  listBuildsAlias,
  buildLogsAlias,
  proposeAlias,
  requestActionsAlias,
);
