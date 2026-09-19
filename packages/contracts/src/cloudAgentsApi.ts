import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CloudAgentStatus, CloudRunStatus } from "./cloudAllocation.ts";
import { CloudCommitProvenance } from "./cloudCommitProvenance.ts";

export const CLOUD_AGENTS_API_PREFIX = "/v1";
export const CLOUD_AGENTS_API_STREAM_RETENTION_SECONDS = 24 * 60 * 60;
/** Ring-buffer cap for the controller's derived run stream. Not a second event store. */
export const CLOUD_AGENTS_API_STREAM_RETENTION_EVENTS = 10_000;
export const CLOUD_AGENTS_API_STREAM_RETENTION_BYTES = 8 * 1024 * 1024;
export const CLOUD_AGENTS_API_STREAM_HEARTBEAT_MS = 15_000;
export const CLOUD_AGENTS_API_HISTORY_PAGE_BYTES = 256 * 1024;
export const CLOUD_AGENTS_API_RESULT_SUMMARY_CHARS = 8 * 1024;
export const CLOUD_AGENTS_API_WORKER_TURN_LIMIT = 20;
export const CLOUD_AGENTS_API_DEFAULT_PAGE_LIMIT = 20;
export const CLOUD_AGENTS_API_MAX_PAGE_LIMIT = 100;
export const CLOUD_AGENTS_API_MAX_IMAGES = 5;
export const CLOUD_AGENTS_API_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const CLOUD_AGENTS_API_MAX_REPOS = 20;
export const CLOUD_AGENTS_API_MAX_ENV_VARS = 50;
export const CLOUD_AGENTS_API_MAX_ENV_VAR_NAME_BYTES = 255;
export const CLOUD_AGENTS_API_MAX_ENV_VAR_VALUE_BYTES = 4096;
export const CLOUD_AGENTS_API_MAX_MCP_SERVERS = 50;
export const CLOUD_AGENTS_API_MAX_SUBAGENTS = 20;
export const CLOUD_AGENTS_API_NAME_MAX_CHARS = 100;
export const CLOUD_AGENTS_API_RATE_LIMIT_PER_MINUTE = 60;
export const CLOUD_AGENTS_API_REPOSITORY_RATE_LIMIT_PER_MINUTE = 1;
export const CLOUD_AGENTS_API_REPOSITORY_RATE_LIMIT_PER_HOUR = 30;

export const CLOUD_AGENTS_API_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export const CLOUD_AGENTS_API_BUILTIN_SUBAGENTS = [
  "explore",
  "debug",
  "shell",
  "computerUse",
] as const;

export const CloudAgentsApiErrorCode = Schema.Literals([
  "unauthorized",
  "invalid_request",
  "agent_id_conflict",
  "agent_busy",
  "agent_archived",
  "agent_not_found",
  "run_not_found",
  "run_not_cancellable",
  "invalid_last_event_id",
  "stream_expired",
  "rate_limited",
  "admission_stopped",
  "spend_limit_exceeded",
  "follow_up_forbidden",
  "scm_access_denied",
  "self_hosted_disabled",
  "self_hosted_required",
  "schedule_not_found",
  "assistant_not_found",
  "internal_error",
]);
export type CloudAgentsApiErrorCode = typeof CloudAgentsApiErrorCode.Type;

export const CloudAgentsApiErrorBody = Schema.Struct({
  code: CloudAgentsApiErrorCode,
  message: TrimmedNonEmptyString,
});
export type CloudAgentsApiErrorBody = typeof CloudAgentsApiErrorBody.Type;

export const CloudAgentsApiKeyKind = Schema.Literals(["user", "service_account"]);
export type CloudAgentsApiKeyKind = typeof CloudAgentsApiKeyKind.Type;

export const CloudAgentsApiPrincipal = Schema.Struct({
  principalId: TrimmedNonEmptyString,
  kind: CloudAgentsApiKeyKind,
  apiKeyName: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  userId: Schema.optionalKey(NonNegativeInt),
  userEmail: Schema.optionalKey(TrimmedNonEmptyString),
  userFirstName: Schema.optionalKey(TrimmedNonEmptyString),
  userLastName: Schema.optionalKey(TrimmedNonEmptyString),
  teamId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAgentsApiPrincipal = typeof CloudAgentsApiPrincipal.Type;

export const CloudAgentsApiMe = Schema.Struct({
  apiKeyName: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  userId: Schema.optionalKey(NonNegativeInt),
  userEmail: Schema.optionalKey(TrimmedNonEmptyString),
  userFirstName: Schema.optionalKey(TrimmedNonEmptyString),
  userLastName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAgentsApiMe = typeof CloudAgentsApiMe.Type;

export const CloudAgentsApiConversationMode = Schema.Literals(["agent", "plan"]);
export type CloudAgentsApiConversationMode = typeof CloudAgentsApiConversationMode.Type;

export const CloudAgentsApiPromptImage = Schema.Union([
  Schema.Struct({
    data: TrimmedNonEmptyString,
    mimeType: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    url: TrimmedNonEmptyString,
    mimeType: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type CloudAgentsApiPromptImage = typeof CloudAgentsApiPromptImage.Type;

export const CloudAgentsApiPrompt = Schema.Struct({
  text: TrimmedNonEmptyString,
  images: Schema.optionalKey(Schema.Array(CloudAgentsApiPromptImage)),
});
export type CloudAgentsApiPrompt = typeof CloudAgentsApiPrompt.Type;

export const CloudAgentsApiModelParam = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: Schema.String,
});
export type CloudAgentsApiModelParam = typeof CloudAgentsApiModelParam.Type;

export const CloudAgentsApiModelSelection = Schema.Struct({
  id: TrimmedNonEmptyString,
  params: Schema.optionalKey(Schema.Array(CloudAgentsApiModelParam)),
});
export type CloudAgentsApiModelSelection = typeof CloudAgentsApiModelSelection.Type;

export const CloudAgentsApiEnvTarget = Schema.Struct({
  type: Schema.Literals(["cloud", "pool", "machine"]),
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAgentsApiEnvTarget = typeof CloudAgentsApiEnvTarget.Type;

export const CloudAgentsApiRepoInput = Schema.Struct({
  url: TrimmedNonEmptyString,
  startingRef: Schema.optionalKey(TrimmedNonEmptyString),
  prUrl: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAgentsApiRepoInput = typeof CloudAgentsApiRepoInput.Type;

export const CloudAgentsApiMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  type: Schema.optionalKey(Schema.Literals(["http", "sse", "stdio"])),
  url: Schema.optionalKey(TrimmedNonEmptyString),
  command: Schema.optionalKey(TrimmedNonEmptyString),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type CloudAgentsApiMcpServer = typeof CloudAgentsApiMcpServer.Type;

export const CloudAgentsApiCustomSubagent = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  model: Schema.optionalKey(
    Schema.Union([Schema.String, CloudAgentsApiModelSelection, Schema.Literal("inherit")]),
  ),
});
export type CloudAgentsApiCustomSubagent = typeof CloudAgentsApiCustomSubagent.Type;

export const CloudAgentsApiCreateAgentRequest = Schema.Struct({
  prompt: CloudAgentsApiPrompt,
  model: Schema.optionalKey(CloudAgentsApiModelSelection),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  env: Schema.optionalKey(CloudAgentsApiEnvTarget),
  repos: Schema.optionalKey(Schema.Array(CloudAgentsApiRepoInput)),
  scratch: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(TrimmedNonEmptyString),
      visibility: Schema.optionalKey(Schema.Literals(["private", "internal"])),
    }),
  ),
  workOnCurrentBranch: Schema.optionalKey(Schema.Boolean),
  autoCreatePR: Schema.optionalKey(Schema.Boolean),
  skipReviewerRequest: Schema.optionalKey(Schema.Boolean),
  envVars: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  mcpServers: Schema.optionalKey(Schema.Array(CloudAgentsApiMcpServer)),
  customSubagents: Schema.optionalKey(Schema.Array(CloudAgentsApiCustomSubagent)),
  mode: Schema.optionalKey(CloudAgentsApiConversationMode),
  agentId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAgentsApiCreateAgentRequest = typeof CloudAgentsApiCreateAgentRequest.Type;

export const CloudAgentsApiCreateRunRequest = Schema.Struct({
  prompt: CloudAgentsApiPrompt,
  mcpServers: Schema.optionalKey(Schema.Array(CloudAgentsApiMcpServer)),
  mode: Schema.optionalKey(CloudAgentsApiConversationMode),
});
export type CloudAgentsApiCreateRunRequest = typeof CloudAgentsApiCreateRunRequest.Type;

export const CloudAgentsApiGitBranch = Schema.Struct({
  repoUrl: TrimmedNonEmptyString,
  branch: Schema.optionalKey(TrimmedNonEmptyString),
  prUrl: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAgentsApiGitBranch = typeof CloudAgentsApiGitBranch.Type;

export const CloudAgentsApiGit = Schema.Struct({
  branches: Schema.Array(CloudAgentsApiGitBranch),
});
export type CloudAgentsApiGit = typeof CloudAgentsApiGit.Type;

export const CloudAgentsApiAgentSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: CloudAgentStatus,
  env: CloudAgentsApiEnvTarget,
  url: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  latestRunId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAgentsApiAgentSummary = typeof CloudAgentsApiAgentSummary.Type;

export const CloudAgentsApiAgent = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: CloudAgentStatus,
  env: CloudAgentsApiEnvTarget,
  repos: Schema.optionalKey(Schema.Array(CloudAgentsApiRepoInput)),
  workOnCurrentBranch: Schema.optionalKey(Schema.Boolean),
  autoCreatePR: Schema.optionalKey(Schema.Boolean),
  skipReviewerRequest: Schema.optionalKey(Schema.Boolean),
  url: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  latestRunId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAgentsApiAgent = typeof CloudAgentsApiAgent.Type;

export const CloudAgentsApiRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  status: CloudRunStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  durationMs: Schema.optionalKey(NonNegativeInt),
  result: Schema.optionalKey(Schema.String),
  git: Schema.optionalKey(CloudAgentsApiGit),
  provenance: Schema.optionalKey(CloudCommitProvenance),
});
export type CloudAgentsApiRun = typeof CloudAgentsApiRun.Type;

export const CloudAgentsApiCreateAgentResponse = Schema.Struct({
  agent: CloudAgentsApiAgent,
  run: CloudAgentsApiRun,
});
export type CloudAgentsApiCreateAgentResponse = typeof CloudAgentsApiCreateAgentResponse.Type;

export const CloudAgentsApiCreateRunResponse = Schema.Struct({
  run: CloudAgentsApiRun,
});
export type CloudAgentsApiCreateRunResponse = typeof CloudAgentsApiCreateRunResponse.Type;

export const CloudAgentsApiListResponse = <Item extends Schema.Top>(item: Item) =>
  Schema.Struct({
    items: Schema.Array(item),
    nextCursor: Schema.optionalKey(TrimmedNonEmptyString),
  });

export const CloudAgentsApiIdResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type CloudAgentsApiIdResponse = typeof CloudAgentsApiIdResponse.Type;

export const CloudAgentsApiTokenUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
});
export type CloudAgentsApiTokenUsage = typeof CloudAgentsApiTokenUsage.Type;

export const CloudAgentsApiRunUsage = Schema.Struct({
  id: TrimmedNonEmptyString,
  usageUuid: Schema.optionalKey(TrimmedNonEmptyString),
  usage: CloudAgentsApiTokenUsage,
});
export type CloudAgentsApiRunUsage = typeof CloudAgentsApiRunUsage.Type;

export const CloudAgentsApiAgentUsage = Schema.Struct({
  totalUsage: CloudAgentsApiTokenUsage,
  runs: Schema.Array(CloudAgentsApiRunUsage),
});
export type CloudAgentsApiAgentUsage = typeof CloudAgentsApiAgentUsage.Type;

export const CloudAgentsApiModelParameterValue = Schema.Struct({
  value: Schema.String,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAgentsApiModelParameterValue = typeof CloudAgentsApiModelParameterValue.Type;

export const CloudAgentsApiModelParameter = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  values: Schema.Array(CloudAgentsApiModelParameterValue),
});
export type CloudAgentsApiModelParameter = typeof CloudAgentsApiModelParameter.Type;

export const CloudAgentsApiModelVariant = Schema.Struct({
  params: Schema.Array(CloudAgentsApiModelParam),
  displayName: TrimmedNonEmptyString,
  description: Schema.optionalKey(TrimmedNonEmptyString),
  isDefault: Schema.optionalKey(Schema.Boolean),
});
export type CloudAgentsApiModelVariant = typeof CloudAgentsApiModelVariant.Type;

export const CloudAgentsApiModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  description: Schema.optionalKey(TrimmedNonEmptyString),
  aliases: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  parameters: Schema.optionalKey(Schema.Array(CloudAgentsApiModelParameter)),
  variants: Schema.optionalKey(Schema.Array(CloudAgentsApiModelVariant)),
});
export type CloudAgentsApiModel = typeof CloudAgentsApiModel.Type;

export const CloudAgentsApiRepository = Schema.Struct({
  url: TrimmedNonEmptyString,
});
export type CloudAgentsApiRepository = typeof CloudAgentsApiRepository.Type;

export const CloudAgentsApiStreamEventType = Schema.Literals([
  "status",
  "assistant",
  "thinking",
  "tool_call",
  "interaction_update",
  "heartbeat",
  "result",
  "error",
  "done",
]);
export type CloudAgentsApiStreamEventType = typeof CloudAgentsApiStreamEventType.Type;

export const CloudAgentsApiStreamEvent = Schema.Struct({
  id: Schema.optionalKey(TrimmedNonEmptyString),
  event: CloudAgentsApiStreamEventType,
  data: Schema.Unknown,
  createdAtMs: NonNegativeInt,
});
export type CloudAgentsApiStreamEvent = typeof CloudAgentsApiStreamEvent.Type;

/** Live workers resume T3's cursor; hibernated agents stay on the controller archive. */
export const CloudAgentsApiReconnectSource = Schema.Literals([
  "worker-cursor",
  "controller-transcript",
]);
export type CloudAgentsApiReconnectSource = typeof CloudAgentsApiReconnectSource.Type;

export const CloudAgentsApiHistoryKind = Schema.Literals([
  "transcript",
  "tool",
  "setup",
  "artifacts",
]);
export type CloudAgentsApiHistoryKind = typeof CloudAgentsApiHistoryKind.Type;

export const CloudAgentsApiHistoryItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: CloudAgentsApiHistoryKind,
  summary: TrimmedNonEmptyString,
  bytes: NonNegativeInt,
});
export type CloudAgentsApiHistoryItem = typeof CloudAgentsApiHistoryItem.Type;

export const CloudAgentsApiHistoryPage = Schema.Struct({
  items: Schema.Array(CloudAgentsApiHistoryItem),
  nextCursor: Schema.optionalKey(TrimmedNonEmptyString),
  truncated: Schema.Boolean,
  bytes: NonNegativeInt,
});
export type CloudAgentsApiHistoryPage = typeof CloudAgentsApiHistoryPage.Type;

export const CloudAgentsApiCreateKeyRequest = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: CloudAgentsApiKeyKind,
  userEmail: Schema.optionalKey(TrimmedNonEmptyString),
  userFirstName: Schema.optionalKey(TrimmedNonEmptyString),
  userLastName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudAgentsApiCreateKeyRequest = typeof CloudAgentsApiCreateKeyRequest.Type;

export const CloudAgentsApiCreatedKey = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  kind: CloudAgentsApiKeyKind,
  token: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type CloudAgentsApiCreatedKey = typeof CloudAgentsApiCreatedKey.Type;
