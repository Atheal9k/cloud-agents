import {
  CLOUD_AGENTS_API_BUILTIN_SUBAGENTS,
  CLOUD_AGENTS_API_DEFAULT_PAGE_LIMIT,
  CLOUD_AGENTS_API_IMAGE_MIME_TYPES,
  CLOUD_AGENTS_API_MAX_ENV_VARS,
  CLOUD_AGENTS_API_MAX_ENV_VAR_NAME_BYTES,
  CLOUD_AGENTS_API_MAX_ENV_VAR_VALUE_BYTES,
  CLOUD_AGENTS_API_MAX_IMAGES,
  CLOUD_AGENTS_API_MAX_IMAGE_BYTES,
  CLOUD_AGENTS_API_MAX_MCP_SERVERS,
  CLOUD_AGENTS_API_MAX_PAGE_LIMIT,
  CLOUD_AGENTS_API_MAX_REPOS,
  CLOUD_AGENTS_API_MAX_SUBAGENTS,
  CLOUD_CUSTOM_SUBAGENT_MAX_PROMPT_BYTES,
  CLOUD_AGENTS_API_NAME_MAX_CHARS,
  CLOUD_AGENTS_API_RATE_LIMIT_PER_MINUTE,
  CLOUD_AGENTS_API_REPOSITORY_RATE_LIMIT_PER_HOUR,
  CLOUD_AGENTS_API_REPOSITORY_RATE_LIMIT_PER_MINUTE,
  CLOUD_AGENTS_API_STREAM_RETENTION_SECONDS,
  type CloudAgentsApiAgent,
  type CloudAgentsApiAgentSummary,
  type CloudAgentsApiAgentUsage,
  type CloudAgentsApiConversationMode,
  type CloudAgentsApiCreateAgentRequest,
  type CloudAgentsApiCreateRunRequest,
  type CloudAgentsApiErrorBody,
  type CloudAgentsApiErrorCode,
  type CloudAgentsApiGit,
  type CloudAgentsApiMe,
  type CloudAgentsApiMcpServer,
  type CloudAgentsApiModel,
  type CloudAgentsApiPrincipal,
  type CloudAgentsApiPrompt,
  type CloudAgentsApiRepoInput,
  type CloudAgentsApiRun,
  type CloudAgentsApiStreamEvent,
  type CloudAgentsApiTokenUsage,
} from "@t3tools/contracts";
import type { CloudAgent, CloudRun, CloudRunStatus } from "@t3tools/contracts";

import { parseCloudRepositoryUrl } from "./cloudCollaborationPolicy.ts";

export class CloudAgentsApiFailure {
  readonly _tag = "CloudAgentsApiFailure";
  readonly code: CloudAgentsApiErrorCode;
  readonly message: string;
  readonly status: number;
  constructor(code: CloudAgentsApiErrorCode, message: string, status: number) {
    this.code = code;
    this.message = message;
    this.status = status;
  }

  toBody(): CloudAgentsApiErrorBody {
    return { code: this.code, message: this.message };
  }
}

export function apiError(
  code: CloudAgentsApiErrorCode,
  message: string,
): CloudAgentsApiFailure {
  return new CloudAgentsApiFailure(code, message, statusForCode(code));
}

export function statusForCode(code: CloudAgentsApiErrorCode): number {
  switch (code) {
    case "unauthorized":
      return 401;
    case "invalid_request":
    case "invalid_last_event_id":
      return 400;
    case "agent_id_conflict":
    case "agent_busy":
    case "agent_archived":
    case "run_not_cancellable":
      return 409;
    case "agent_not_found":
    case "run_not_found":
      return 404;
    case "stream_expired":
      return 410;
    case "rate_limited":
      return 429;
    case "admission_stopped":
    case "spend_limit_exceeded":
    case "self_hosted_disabled":
    case "self_hosted_required":
      return 409;
    case "follow_up_forbidden":
    case "scm_access_denied":
      return 403;
    case "internal_error":
      return 500;
  }
}

export function parseCloudAgentsApiAuthorization(
  authorization: string | undefined,
): string | CloudAgentsApiFailure {
  if (authorization === undefined || authorization.trim().length === 0) {
    return apiError("unauthorized", "Basic or Bearer API key authentication is required.");
  }
  const bearer = /^Bearer\s+(\S+)/i.exec(authorization);
  if (bearer?.[1] !== undefined) return bearer[1];
  const basic = /^Basic\s+(\S+)/i.exec(authorization);
  if (basic?.[1] === undefined) {
    return apiError("unauthorized", "Basic or Bearer API key authentication is required.");
  }
  try {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const token = separator === -1 ? decoded : decoded.slice(0, separator);
    if (token.length === 0) {
      return apiError("unauthorized", "The API key is empty.");
    }
    return token;
  } catch {
    return apiError("unauthorized", "The Basic credential could not be decoded.");
  }
}

export function principalMe(principal: CloudAgentsApiPrincipal): CloudAgentsApiMe {
  if (principal.kind === "service_account") {
    return { apiKeyName: principal.apiKeyName, createdAt: principal.createdAt };
  }
  return {
    apiKeyName: principal.apiKeyName,
    createdAt: principal.createdAt,
    ...(principal.userId === undefined ? {} : { userId: principal.userId }),
    ...(principal.userEmail === undefined ? {} : { userEmail: principal.userEmail }),
    ...(principal.userFirstName === undefined ? {} : { userFirstName: principal.userFirstName }),
    ...(principal.userLastName === undefined ? {} : { userLastName: principal.userLastName }),
  };
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const IMAGE_MIME = new Set<string>(CLOUD_AGENTS_API_IMAGE_MIME_TYPES);
const BUILTIN_SUBAGENTS = new Set<string>(CLOUD_AGENTS_API_BUILTIN_SUBAGENTS);

function validatePrompt(prompt: CloudAgentsApiPrompt): CloudAgentsApiFailure | undefined {
  const images = prompt.images ?? [];
  if (images.length > CLOUD_AGENTS_API_MAX_IMAGES) {
    return apiError("invalid_request", `A prompt may include at most ${CLOUD_AGENTS_API_MAX_IMAGES} images.`);
  }
  for (const image of images) {
    if ("data" in image) {
      if (!IMAGE_MIME.has(image.mimeType)) {
        return apiError("invalid_request", `Unsupported image MIME type '${image.mimeType}'.`);
      }
      const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
      const size = Math.floor((image.data.length * 3) / 4) - padding;
      if (size > CLOUD_AGENTS_API_MAX_IMAGE_BYTES) {
        return apiError(
          "invalid_request",
          `Each image must be at most ${CLOUD_AGENTS_API_MAX_IMAGE_BYTES} bytes.`,
        );
      }
    } else {
      let parsed: URL;
      try {
        parsed = new URL(image.url);
      } catch {
        return apiError("invalid_request", "Image URLs must be absolute http or https URLs.");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return apiError("invalid_request", "Image URLs must use http or https.");
      }
      if (image.mimeType !== undefined && !IMAGE_MIME.has(image.mimeType)) {
        return apiError("invalid_request", `Unsupported image MIME type '${image.mimeType}'.`);
      }
    }
  }
  return undefined;
}

function validateMcpServers(
  servers: ReadonlyArray<CloudAgentsApiMcpServer> | undefined,
): CloudAgentsApiFailure | undefined {
  if (servers === undefined) return undefined;
  if (servers.length > CLOUD_AGENTS_API_MAX_MCP_SERVERS) {
    return apiError(
      "invalid_request",
      `A request may include at most ${CLOUD_AGENTS_API_MAX_MCP_SERVERS} MCP servers.`,
    );
  }
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) {
      return apiError("invalid_request", `MCP server names must be unique ('${server.name}').`);
    }
    names.add(server.name);
    const type = server.type ?? (server.command !== undefined ? "stdio" : "http");
    if ((type === "http" || type === "sse") && server.url === undefined) {
      return apiError("invalid_request", `MCP server '${server.name}' needs a url.`);
    }
    if (type === "stdio" && server.command === undefined) {
      return apiError("invalid_request", `MCP server '${server.name}' needs a command.`);
    }
    if (server.url !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(server.url);
      } catch {
        return apiError("invalid_request", `MCP server '${server.name}' has an invalid url.`);
      }
      if (parsed.username !== "" || parsed.password !== "") {
        return apiError("invalid_request", `MCP server URLs may not include credentials.`);
      }
    }
  }
  return undefined;
}

function validateEnvVars(
  envVars: Readonly<Record<string, string>> | undefined,
  agentId: string | undefined,
): CloudAgentsApiFailure | undefined {
  if (envVars === undefined) return undefined;
  if (agentId !== undefined) {
    return apiError("invalid_request", "envVars cannot be combined with a client-supplied agentId.");
  }
  const entries = Object.entries(envVars);
  if (entries.length > CLOUD_AGENTS_API_MAX_ENV_VARS) {
    return apiError(
      "invalid_request",
      `A request may include at most ${CLOUD_AGENTS_API_MAX_ENV_VARS} environment variables.`,
    );
  }
  for (const [name, value] of entries) {
    if (utf8Bytes(name) > CLOUD_AGENTS_API_MAX_ENV_VAR_NAME_BYTES || name.startsWith("CURSOR_")) {
      return apiError(
        "invalid_request",
        "Environment variable names must be at most 255 bytes and cannot start with CURSOR_.",
      );
    }
    if (utf8Bytes(value) > CLOUD_AGENTS_API_MAX_ENV_VAR_VALUE_BYTES) {
      return apiError(
        "invalid_request",
        `Environment variable '${name}' exceeds ${CLOUD_AGENTS_API_MAX_ENV_VAR_VALUE_BYTES} bytes.`,
      );
    }
  }
  return undefined;
}

export function validateCreateAgentRequest(
  request: CloudAgentsApiCreateAgentRequest,
): CloudAgentsApiFailure | undefined {
  const promptError = validatePrompt(request.prompt);
  if (promptError !== undefined) return promptError;
  if (request.name !== undefined && request.name.length > CLOUD_AGENTS_API_NAME_MAX_CHARS) {
    return apiError(
      "invalid_request",
      `Agent names must be at most ${CLOUD_AGENTS_API_NAME_MAX_CHARS} characters.`,
    );
  }
  if (request.repos !== undefined && request.env?.type === "cloud" && request.env.name !== undefined) {
    return apiError(
      "invalid_request",
      "repos is mutually exclusive with a named cloud environment.",
    );
  }
  if (request.repos !== undefined && request.repos.length > CLOUD_AGENTS_API_MAX_REPOS) {
    return apiError(
      "invalid_request",
      `A request may include at most ${CLOUD_AGENTS_API_MAX_REPOS} repositories.`,
    );
  }
  const envVarError = validateEnvVars(request.envVars, request.agentId);
  if (envVarError !== undefined) return envVarError;
  const mcpError = validateMcpServers(request.mcpServers);
  if (mcpError !== undefined) return mcpError;
  const subagents = request.customSubagents ?? [];
  if (subagents.length > CLOUD_AGENTS_API_MAX_SUBAGENTS) {
    return apiError(
      "invalid_request",
      `A request may include at most ${CLOUD_AGENTS_API_MAX_SUBAGENTS} custom subagents.`,
    );
  }
  const names = new Set<string>();
  for (const subagent of subagents) {
    if (BUILTIN_SUBAGENTS.has(subagent.name)) {
      return apiError(
        "invalid_request",
        `Custom subagent '${subagent.name}' collides with a built-in name.`,
      );
    }
    if (names.has(subagent.name)) {
      return apiError("invalid_request", `Custom subagent names must be unique ('${subagent.name}').`);
    }
    names.add(subagent.name);
    if (utf8Bytes(subagent.prompt) > CLOUD_CUSTOM_SUBAGENT_MAX_PROMPT_BYTES) {
      return apiError(
        "invalid_request",
        `Custom subagent '${subagent.name}' exceeds the prompt size bound.`,
      );
    }
  }
  return undefined;
}

export function validateCreateRunRequest(
  request: CloudAgentsApiCreateRunRequest,
): CloudAgentsApiFailure | undefined {
  return validatePrompt(request.prompt) ?? validateMcpServers(request.mcpServers);
}

export function titleFromPrompt(text: string, name?: string): string {
  if (name !== undefined && name.length > 0) return name.slice(0, CLOUD_AGENTS_API_NAME_MAX_CHARS);
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return (firstLine || "Cloud task").slice(0, CLOUD_AGENTS_API_NAME_MAX_CHARS);
}

export function parseRepositoryUrl(
  url: string,
): { ownerName: string; hostPath: string } | undefined {
  const parsed = parseCloudRepositoryUrl(url);
  if (parsed === undefined) return undefined;
  return { ownerName: parsed.repository, hostPath: parsed.hostPath };
}

export function interactionMode(
  mode: CloudAgentsApiConversationMode | undefined,
): "default" | "plan" {
  return mode === "plan" ? "plan" : "default";
}

export function paginateNewestFirst<Item extends { readonly id: string }>(
  items: ReadonlyArray<Item>,
  query: { readonly limit?: number; readonly cursor?: string },
): { items: ReadonlyArray<Item>; nextCursor?: string } {
  const limit = Math.min(
    Math.max(query.limit ?? CLOUD_AGENTS_API_DEFAULT_PAGE_LIMIT, 1),
    CLOUD_AGENTS_API_MAX_PAGE_LIMIT,
  );
  const start =
    query.cursor === undefined ? 0 : items.findIndex((item) => item.id === query.cursor);
  const from = start === -1 ? 0 : query.cursor === undefined ? 0 : start + 1;
  const page = items.slice(from, from + limit);
  const next = items[from + limit];
  return next === undefined ? { items: page } : { items: page, nextCursor: next.id };
}

export function emptyTokenUsage(): CloudAgentsApiTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };
}

export function sumTokenUsage(
  usages: ReadonlyArray<CloudAgentsApiTokenUsage>,
): CloudAgentsApiTokenUsage {
  return usages.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
    }),
    emptyTokenUsage(),
  );
}

export function agentUsageFromRuns(
  runs: ReadonlyArray<{ readonly id: string; usage?: CloudAgentsApiTokenUsage; usageUuid?: string }>,
): CloudAgentsApiAgentUsage {
  const items = runs.map((run) => ({
    id: run.id,
    ...(run.usageUuid === undefined ? {} : { usageUuid: run.usageUuid }),
    usage: run.usage ?? emptyTokenUsage(),
  }));
  return { totalUsage: sumTokenUsage(items.map((item) => item.usage)), runs: items };
}

export interface CloudAgentsApiAgentRecord {
  readonly env: CloudAgentsApiAgent["env"];
  readonly repos?: ReadonlyArray<CloudAgentsApiRepoInput>;
  readonly workOnCurrentBranch?: boolean;
  readonly autoCreatePR?: boolean;
  readonly skipReviewerRequest?: boolean;
  readonly urlOrigin: string;
}

export function publicGit(
  agent: CloudAgent,
  repos: ReadonlyArray<CloudAgentsApiRepoInput> | undefined,
  prUrl?: string,
): CloudAgentsApiGit | undefined {
  if (agent.branches.length === 0 && repos === undefined) return undefined;
  const repoUrl =
    repos?.[0] === undefined
      ? `github.com/${agent.repository}`
      : (parseRepositoryUrl(repos[0].url)?.hostPath ?? repos[0].url.replace(/^https?:\/\//u, ""));
  return {
    branches: agent.branches.map((branch) => ({
      repoUrl,
      branch,
      ...(prUrl === undefined ? {} : { prUrl }),
    })),
  };
}

function latestRunId(agent: CloudAgent): string | undefined {
  if (agent.status === "ACTIVE") return agent.activeRunId;
  return agent.conversation.runIds[agent.conversation.runIds.length - 1];
}

export function publicAgent(
  agent: CloudAgent,
  record: CloudAgentsApiAgentRecord,
): CloudAgentsApiAgent {
  const latest = latestRunId(agent);
  return {
    id: agent.id,
    name: agent.conversation.title,
    status: agent.status,
    env: record.env,
    ...(record.repos === undefined ? {} : { repos: [...record.repos] }),
    ...(record.workOnCurrentBranch === undefined
      ? {}
      : { workOnCurrentBranch: record.workOnCurrentBranch }),
    ...(record.autoCreatePR === undefined ? {} : { autoCreatePR: record.autoCreatePR }),
    ...(record.skipReviewerRequest === undefined
      ? {}
      : { skipReviewerRequest: record.skipReviewerRequest }),
    url: `${record.urlOrigin}/cloud-agents/${agent.id}`,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    ...(latest === undefined ? {} : { latestRunId: latest }),
  };
}

export function publicAgentSummary(
  agent: CloudAgent,
  record: CloudAgentsApiAgentRecord,
): CloudAgentsApiAgentSummary {
  const full = publicAgent(agent, record);
  return {
    id: full.id,
    name: full.name,
    status: full.status,
    env: full.env,
    url: full.url,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
    ...(full.latestRunId === undefined ? {} : { latestRunId: full.latestRunId }),
  };
}

const TERMINAL_RUN: ReadonlySet<CloudRunStatus> = new Set([
  "FINISHED",
  "ERROR",
  "CANCELLED",
  "EXPIRED",
]);

export function isTerminalRunStatus(status: CloudRunStatus): boolean {
  return TERMINAL_RUN.has(status);
}

export function isActiveRunStatus(status: CloudRunStatus): boolean {
  return status === "CREATING" || status === "RUNNING";
}

export function publicRun(
  run: CloudRun,
  options: { readonly result?: string; readonly git?: CloudAgentsApiGit } = {},
): CloudAgentsApiRun {
  const completedAt =
    run.status === "FINISHED" ||
    run.status === "ERROR" ||
    run.status === "CANCELLED" ||
    run.status === "EXPIRED"
      ? run.completedAt
      : undefined;
  const durationMs =
    completedAt === undefined ? undefined : Math.max(0, Date.parse(completedAt) - Date.parse(run.createdAt));
  return {
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(durationMs === undefined || !Number.isFinite(durationMs) ? {} : { durationMs }),
    ...(options.result === undefined ? {} : { result: options.result }),
    ...(options.git === undefined ? {} : { git: options.git }),
  };
}

export function encodeSse(event: CloudAgentsApiStreamEvent): string {
  const lines = [
    ...(event.id === undefined ? [] : [`id: ${event.id}`]),
    `event: ${event.event}`,
    `data: ${JSON.stringify(event.data)}`,
    "",
    "",
  ];
  return lines.join("\n");
}

export function streamEventId(createdAtMs: number, index: number): string {
  return `${createdAtMs}-${index}`;
}

export function resumeStream(input: {
  readonly events: ReadonlyArray<CloudAgentsApiStreamEvent>;
  readonly lastEventId: string | undefined;
  readonly nowMs: number;
  readonly retentionSeconds?: number;
}):
  | { readonly ok: true; readonly events: ReadonlyArray<CloudAgentsApiStreamEvent> }
  | { readonly ok: false; readonly error: CloudAgentsApiFailure } {
  const retention = (input.retentionSeconds ?? CLOUD_AGENTS_API_STREAM_RETENTION_SECONDS) * 1000;
  const newest = input.events[input.events.length - 1];
  if (newest !== undefined && input.nowMs - newest.createdAtMs > retention) {
    return { ok: false, error: apiError("stream_expired", "The run event stream has expired.") };
  }
  if (input.lastEventId === undefined) return { ok: true, events: input.events };
  const index = input.events.findIndex((event) => event.id === input.lastEventId);
  if (index === -1) {
    return {
      ok: false,
      error: apiError("invalid_last_event_id", "Last-Event-ID does not belong to this run."),
    };
  }
  return { ok: true, events: input.events.slice(index + 1) };
}

export function modelsFromProviders(
  providers: ReadonlyArray<{
    readonly models?: ReadonlyArray<{
      readonly slug: string;
      readonly name: string;
      readonly aliases?: ReadonlyArray<string> | undefined;
    }>;
  }>,
): ReadonlyArray<CloudAgentsApiModel> {
  const seen = new Set<string>();
  const models: CloudAgentsApiModel[] = [];
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      if (seen.has(model.slug)) continue;
      seen.add(model.slug);
      models.push({
        id: model.slug,
        displayName: model.name,
        ...(model.aliases === undefined || model.aliases.length === 0
          ? {}
          : { aliases: [...model.aliases] }),
        variants: [{ params: [], displayName: model.name, isDefault: true }],
      });
    }
  }
  return models;
}

export interface RateLimitWindow {
  readonly count: number;
  readonly resetAtMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
}

export function consumeRateLimit(input: {
  readonly window: RateLimitWindow | undefined;
  readonly nowMs: number;
  readonly limit: number;
  readonly windowMs: number;
}): { readonly window: RateLimitWindow; readonly decision: RateLimitDecision } {
  const active =
    input.window !== undefined && input.nowMs < input.window.resetAtMs
      ? input.window
      : { count: 0, resetAtMs: input.nowMs + input.windowMs };
  const count = active.count + 1;
  const window = { count, resetAtMs: active.resetAtMs };
  const remaining = Math.max(0, input.limit - count);
  return {
    window,
    decision: {
      allowed: count <= input.limit,
      limit: input.limit,
      remaining,
      resetAtMs: window.resetAtMs,
    },
  };
}

export function defaultMinuteLimit(nowMs: number, window?: RateLimitWindow) {
  return consumeRateLimit({
    window,
    nowMs,
    limit: CLOUD_AGENTS_API_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });
}

export function repositoryMinuteLimit(nowMs: number, window?: RateLimitWindow) {
  return consumeRateLimit({
    window,
    nowMs,
    limit: CLOUD_AGENTS_API_REPOSITORY_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });
}

export function repositoryHourLimit(nowMs: number, window?: RateLimitWindow) {
  return consumeRateLimit({
    window,
    nowMs,
    limit: CLOUD_AGENTS_API_REPOSITORY_RATE_LIMIT_PER_HOUR,
    windowMs: 60 * 60_000,
  });
}

export function parseLimitParam(value: string | null): number | CloudAgentsApiFailure {
  if (value === null || value.length === 0) return CLOUD_AGENTS_API_DEFAULT_PAGE_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return apiError("invalid_request", "limit must be a positive integer.");
  }
  return Math.min(parsed, CLOUD_AGENTS_API_MAX_PAGE_LIMIT);
}

export function parseBooleanParam(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return value === "true" || value === "1";
}
