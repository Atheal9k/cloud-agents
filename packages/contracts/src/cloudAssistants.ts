import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CloudAgentsApiCreateRunRequest, CloudAgentsApiModelSelection } from "./cloudAgentsApi.ts";
import { CloudAgentStatus } from "./cloudAllocation.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CLOUD_ASSISTANT_MEMORY_MAX_BYTES = 8 * 1024;
export const CLOUD_ASSISTANT_PERSISTENCE_MAX_BYTES = 64 * 1024;
export const CLOUD_ASSISTANT_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

export const CLOUD_ASSISTANT_TOOLS = ["explore", "debug", "shell", "computerUse", "mcp"] as const;

export const CloudAssistantTool = Schema.Literals([
  "explore",
  "debug",
  "shell",
  "computerUse",
  "mcp",
]);
export type CloudAssistantTool = typeof CloudAssistantTool.Type;

export const CloudAssistantPersistencePolicy = Schema.Struct({
  files: Schema.Boolean,
  browser: Schema.Boolean,
});
export type CloudAssistantPersistencePolicy = typeof CloudAssistantPersistencePolicy.Type;

export const CloudAssistantSecretAccess = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("none") }),
  Schema.Struct({
    mode: Schema.Literal("named"),
    secretIds: Schema.Array(TrimmedNonEmptyString),
  }),
]);
export type CloudAssistantSecretAccess = typeof CloudAssistantSecretAccess.Type;

export const CloudAssistantProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: CloudAgentsApiModelSelection,
});
export type CloudAssistantProvider = typeof CloudAssistantProvider.Type;

export const CloudAssistantRepository = Schema.Struct({
  url: TrimmedNonEmptyString,
  startingRef: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAssistantRepository = typeof CloudAssistantRepository.Type;

export const CloudAssistantLimits = Schema.Struct({
  runSeconds: PositiveInt,
  inputWaitSeconds: PositiveInt,
});
export type CloudAssistantLimits = typeof CloudAssistantLimits.Type;

export const CloudAssistantDefinition = Schema.Struct({
  name: TrimmedNonEmptyString,
  instructions: TrimmedNonEmptyString,
  provider: CloudAssistantProvider,
  tools: Schema.Array(CloudAssistantTool),
  repositories: Schema.Array(CloudAssistantRepository),
  secretAccess: CloudAssistantSecretAccess,
  persistence: CloudAssistantPersistencePolicy,
  limits: CloudAssistantLimits,
});
export type CloudAssistantDefinition = typeof CloudAssistantDefinition.Type;

export const CloudAssistantCreateRequest = CloudAssistantDefinition;
export type CloudAssistantCreateRequest = typeof CloudAssistantCreateRequest.Type;

export const CloudAssistantMemorySource = Schema.Struct({
  agentId: TrimmedNonEmptyString,
  runId: Schema.optionalKey(TrimmedNonEmptyString),
  quote: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAssistantMemorySource = typeof CloudAssistantMemorySource.Type;

export const CloudAssistantMemoryFact = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  source: CloudAssistantMemorySource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudAssistantMemoryFact = typeof CloudAssistantMemoryFact.Type;

export const CloudAssistantMemoryWrite = Schema.Struct({
  text: TrimmedNonEmptyString,
  source: CloudAssistantMemorySource,
});
export type CloudAssistantMemoryWrite = typeof CloudAssistantMemoryWrite.Type;

export const CloudAssistantPersistenceKind = Schema.Literals(["files", "browser"]);
export type CloudAssistantPersistenceKind = typeof CloudAssistantPersistenceKind.Type;

export const CloudAssistantPersistenceRecord = Schema.Struct({
  kind: CloudAssistantPersistenceKind,
  ciphertext: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type CloudAssistantPersistenceRecord = typeof CloudAssistantPersistenceRecord.Type;

export const CloudAssistantSubscriptionKind = Schema.Literals(["schedule", "github", "generic"]);
export type CloudAssistantSubscriptionKind = typeof CloudAssistantSubscriptionKind.Type;

export const CloudAssistantSubscriptionStatus = Schema.Literals(["enabled", "paused", "disabled"]);
export type CloudAssistantSubscriptionStatus = typeof CloudAssistantSubscriptionStatus.Type;

export const CloudAssistantSubscription = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: CloudAssistantSubscriptionKind,
  status: CloudAssistantSubscriptionStatus,
});
export type CloudAssistantSubscription = typeof CloudAssistantSubscription.Type;

export const CloudAssistantLifecycleAction = Schema.Literals([
  "idle",
  "archive",
  "unarchive",
  "reset",
  "delete",
]);
export type CloudAssistantLifecycleAction = typeof CloudAssistantLifecycleAction.Type;

export const CloudAssistantRunEffect = Schema.Literals([
  "none",
  "reject_new",
  "history_retained",
  "deleted",
]);
export type CloudAssistantRunEffect = typeof CloudAssistantRunEffect.Type;

export const CloudAssistantSnapshotEffect = Schema.Literals(["retained", "policy-expiry"]);
export type CloudAssistantSnapshotEffect = typeof CloudAssistantSnapshotEffect.Type;

export const CloudAssistantCredentialEffect = Schema.Literals(["retained", "revoked"]);
export type CloudAssistantCredentialEffect = typeof CloudAssistantCredentialEffect.Type;

export const CloudAssistantLifecycleEffects = Schema.Struct({
  action: CloudAssistantLifecycleAction,
  runs: CloudAssistantRunEffect,
  subscriptions: CloudAssistantSubscriptionStatus,
  credentials: CloudAssistantCredentialEffect,
  snapshots: CloudAssistantSnapshotEffect,
  memory: Schema.Literals(["retained", "cleared", "deleted"]),
  files: Schema.Literals(["absent", "retained", "cleared", "deleted"]),
  browser: Schema.Literals(["absent", "retained", "cleared", "deleted"]),
});
export type CloudAssistantLifecycleEffects = typeof CloudAssistantLifecycleEffects.Type;

export const CloudAssistant = Schema.Struct({
  id: TrimmedNonEmptyString,
  status: CloudAgentStatus,
  definition: CloudAssistantDefinition,
  workspaceOwner: TrimmedNonEmptyString,
  agentId: Schema.optionalKey(TrimmedNonEmptyString),
  subscriptions: Schema.Array(CloudAssistantSubscription),
  credentials: CloudAssistantCredentialEffect,
  snapshots: CloudAssistantSnapshotEffect,
  lifecycle: CloudAssistantLifecycleEffects,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudAssistant = typeof CloudAssistant.Type;

export const CloudAssistantCreateRunRequest = CloudAgentsApiCreateRunRequest;
export type CloudAssistantCreateRunRequest = typeof CloudAssistantCreateRunRequest.Type;
