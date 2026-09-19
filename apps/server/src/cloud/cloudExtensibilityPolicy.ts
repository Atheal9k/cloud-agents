/**
 * Admit MCP servers, repository hooks, and API custom subagents for a cloud
 * run. Failures stay isolated audit records: one bad server does not drop the
 * rest, and nothing here widens egress or copies HTTP/OAuth secrets into the
 * guest.
 */
import {
  CLOUD_AGENTS_API_BUILTIN_SUBAGENTS,
  CLOUD_AGENTS_API_MAX_MCP_SERVERS,
  CLOUD_AGENTS_API_MAX_SUBAGENTS,
  CLOUD_CUSTOM_SUBAGENT_MAX_DESCRIPTION_BYTES,
  CLOUD_CUSTOM_SUBAGENT_MAX_PROMPT_BYTES,
  CLOUD_HOOK_COMMAND_MAX_BYTES,
  CLOUD_HOOKS_LOCAL_HOME_PATH,
  type CloudAdmittedHook,
  type CloudAdmittedSubagent,
  type CloudAgentsApiCustomSubagent,
  type CloudAgentsApiMcpServer,
  type CloudExtensibilityAdmission,
  type CloudExtensibilityAuditEvent,
  type CloudExtensibilityPolicyInput,
  type CloudExtensibilitySources,
  type CloudGuestMcpServer,
  type CloudHookCommand,
  type CloudHookEvent,
  type CloudMcpControllerSecret,
  type CloudMcpServerSource,
  type CloudMcpTransport,
  type CloudRunId,
  type CloudSubagentPermissionSet,
  type CloudSubagentUsageEvent,
} from "@t3tools/contracts";

import { evaluateCloudEgress } from "./cloudSecurityPolicy.ts";

const BUILTIN_SUBAGENTS = new Set<string>(CLOUD_AGENTS_API_BUILTIN_SUBAGENTS);
const READONLY_HOOK_EVENTS = new Set<CloudHookEvent>(["beforeReadFile"]);

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function audit(
  kind: CloudExtensibilityAuditEvent["kind"],
  target: string,
  message: string,
): CloudExtensibilityAuditEvent {
  return { kind, target, message, isolated: true };
}

function redactSecrets(value: string): string {
  return value
    .replaceAll(/(Bearer\s+)(\S+)/gi, "$1[redacted]")
    .replaceAll(/(authorization["']?\s*[:=]\s*["']?)([^"'\\s]+)/gi, "$1[redacted]");
}

export function redactExtensibilityMessage(message: string): string {
  return redactSecrets(message);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function inferredTransport(server: {
  readonly type?: CloudMcpTransport | undefined;
  readonly command?: string | undefined;
}): CloudMcpTransport {
  return server.type ?? (server.command !== undefined ? "stdio" : "http");
}

function apiMcpSource(server: CloudAgentsApiMcpServer): CloudMcpServerSource {
  return {
    name: server.name,
    scope: "api",
    transport: inferredTransport(server),
    ...(server.url === undefined ? {} : { url: server.url }),
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(server.headers === undefined ? {} : { headers: server.headers }),
    ...(server.env === undefined ? {} : { env: server.env }),
  };
}

function allowlisted(
  server: CloudMcpServerSource,
  allowlist: CloudExtensibilityPolicyInput["mcpServerAllowlist"],
): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((entry) => {
    if (entry.name !== undefined && entry.name !== server.name) return false;
    if (entry.serverUrl !== undefined) {
      return server.url !== undefined && entry.serverUrl === server.url;
    }
    if (entry.command !== undefined) {
      return server.command !== undefined && entry.command === server.command;
    }
    return true;
  });
}

function sessionTokenHeader(serverName: string): string {
  return `Bearer mcp-session-${serverName}`;
}

function admitOneMcp(
  server: CloudMcpServerSource,
  policy: CloudExtensibilityPolicyInput,
  proxyBase: string,
):
  | {
      readonly guest: CloudGuestMcpServer;
      readonly secret?: CloudMcpControllerSecret;
    }
  | { readonly audit: CloudExtensibilityAuditEvent } {
  if (policy.disableAllMcpServers && server.scope !== "builtin") {
    return {
      audit: audit(
        "mcp-disabled",
        server.name,
        "The environment disables extra MCP servers.",
      ),
    };
  }
  if (server.scope !== "builtin" && !allowlisted(server, policy.mcpServerAllowlist)) {
    return {
      audit: audit(
        "mcp-not-allowlisted",
        server.name,
        "The environment MCP allowlist does not include this server.",
      ),
    };
  }
  if (server.transport === "stdio") {
    if (server.command === undefined || server.command.trim().length === 0) {
      return { audit: audit("mcp-invalid", server.name, "A stdio MCP server needs a command.") };
    }
    return {
      guest: {
        type: "stdio",
        name: server.name,
        command: server.command,
        args: server.args ?? [],
      },
    };
  }
  if (server.url === undefined) {
    return { audit: audit("mcp-invalid", server.name, "An HTTP MCP server needs a url.") };
  }
  let parsed: URL;
  try {
    parsed = new URL(server.url);
  } catch {
    return { audit: audit("mcp-invalid", server.name, "The MCP url is not valid.") };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { audit: audit("mcp-invalid", server.name, "MCP URLs may not include credentials.") };
  }
  const host = hostOf(server.url);
  if (host === undefined) {
    return { audit: audit("mcp-invalid", server.name, "The MCP url is not valid.") };
  }
  if (server.scope !== "builtin") {
    const decision = evaluateCloudEgress({ policy: policy.egress, host });
    if (!decision.allowed) {
      return {
        audit: audit(
          "mcp-egress-denied",
          server.name,
          "The MCP host is not reachable under the current egress policy.",
        ),
      };
    }
  }
  const secret: CloudMcpControllerSecret = {
    serverName: server.name,
    targetUrl: server.url,
    headers: server.headers ?? {},
    ...(server.oauthUserId === undefined ? {} : { oauthUserId: server.oauthUserId }),
  };
  return {
    guest: {
      type: server.transport === "sse" ? "sse" : "http",
      name: server.name,
      url: `${proxyBase.replace(/\/$/u, "")}/mcp/upstream/${encodeURIComponent(server.name)}`,
      headers: [{ name: "Authorization", value: sessionTokenHeader(server.name) }],
    },
    secret,
  };
}

const HOOK_EVENTS = new Set<CloudHookEvent>([
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

function asHookCommands(event: CloudHookEvent, value: unknown): ReadonlyArray<CloudHookCommand> {
  const entries = Array.isArray(value) ? value : [value];
  const commands: CloudHookCommand[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      commands.push({ event, command: entry });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { command?: unknown; matcher?: unknown; timeout?: unknown };
    if (typeof record.command !== "string" || record.command.trim().length === 0) continue;
    commands.push({
      event,
      command: record.command,
      ...(typeof record.matcher === "string" ? { matcher: record.matcher } : {}),
      ...(typeof record.timeout === "number" && Number.isFinite(record.timeout)
        ? { timeoutSeconds: Math.max(0, Math.trunc(record.timeout)) }
        : {}),
    });
  }
  return commands;
}

export function parseCursorHooksJson(
  raw: string,
): { readonly hooks: ReadonlyArray<CloudHookCommand> } | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { error: "hooks.json is not valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { error: "hooks.json must be an object." };
  }
  const hooksValue = (parsed as { hooks?: unknown }).hooks ?? parsed;
  if (hooksValue === null || typeof hooksValue !== "object" || Array.isArray(hooksValue)) {
    return { error: "hooks.json is missing a hooks object." };
  }
  const hooks: CloudHookCommand[] = [];
  for (const [event, value] of Object.entries(hooksValue)) {
    if (!HOOK_EVENTS.has(event as CloudHookEvent)) continue;
    hooks.push(...asHookCommands(event as CloudHookEvent, value));
  }
  return { hooks };
}

function admitHooks(
  sources: CloudExtensibilitySources,
  policy: CloudExtensibilityPolicyInput,
): {
  readonly hooks: ReadonlyArray<CloudAdmittedHook>;
  readonly audits: ReadonlyArray<CloudExtensibilityAuditEvent>;
} {
  if (sources.hooksSource === "local-home") {
    return {
      hooks: [],
      audits: [
        audit(
          "hook-unavailable",
          CLOUD_HOOKS_LOCAL_HOME_PATH,
          "Cloud runtimes do not load hooks from the operator's local home directory.",
        ),
      ],
    };
  }
  if (sources.hooksJson === undefined) return { hooks: [], audits: [] };
  const parsed = parseCursorHooksJson(sources.hooksJson);
  if ("error" in parsed) {
    return { hooks: [], audits: [audit("hook-invalid", ".cursor/hooks.json", parsed.error)] };
  }
  const hooks: CloudAdmittedHook[] = [];
  const audits: CloudExtensibilityAuditEvent[] = [];
  for (const hook of parsed.hooks) {
    if (utf8Bytes(hook.command) > CLOUD_HOOK_COMMAND_MAX_BYTES) {
      audits.push(audit("hook-invalid", hook.event, "The hook command exceeds the size bound."));
      continue;
    }
    if (policy.phase === "install" && !READONLY_HOOK_EVENTS.has(hook.event)) {
      audits.push(
        audit(
          "hook-skipped-readonly-setup",
          hook.event,
          "Early environment setup is read-only for hooks; mutating command hooks wait until runtime.",
        ),
      );
      continue;
    }
    hooks.push({
      event: hook.event,
      command: hook.command,
      ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
      ...(hook.timeoutSeconds === undefined ? {} : { timeoutSeconds: hook.timeoutSeconds }),
      source: "repository",
      phase: policy.phase,
    });
  }
  return { hooks, audits };
}

export function inheritSubagentPermissions(
  parent: CloudSubagentPermissionSet,
  requested: CloudSubagentPermissionSet | undefined,
): CloudSubagentPermissionSet {
  if (requested === undefined) return parent;
  return {
    filesystem: parent.filesystem && requested.filesystem,
    network: parent.network && requested.network,
    secrets: parent.secrets && requested.secrets,
  };
}

function admitSubagents(
  sources: CloudExtensibilitySources,
  policy: CloudExtensibilityPolicyInput,
): {
  readonly subagents: ReadonlyArray<CloudAdmittedSubagent>;
  readonly audits: ReadonlyArray<CloudExtensibilityAuditEvent>;
} {
  const audits: CloudExtensibilityAuditEvent[] = [];
  if (sources.customSubagents.length > CLOUD_AGENTS_API_MAX_SUBAGENTS) {
    return {
      subagents: [],
      audits: [
        audit(
          "subagent-limit",
          "customSubagents",
          `A request may include at most ${CLOUD_AGENTS_API_MAX_SUBAGENTS} custom subagents.`,
        ),
      ],
    };
  }
  const names = new Set<string>();
  const subagents: CloudAdmittedSubagent[] = [];
  for (const subagent of sources.customSubagents) {
    if (BUILTIN_SUBAGENTS.has(subagent.name)) {
      audits.push(
        audit(
          "subagent-shadows-builtin",
          subagent.name,
          "Custom subagents cannot shadow a built-in name.",
        ),
      );
      continue;
    }
    if (names.has(subagent.name)) {
      audits.push(audit("subagent-invalid", subagent.name, "Custom subagent names must be unique."));
      continue;
    }
    if (utf8Bytes(subagent.prompt) > CLOUD_CUSTOM_SUBAGENT_MAX_PROMPT_BYTES) {
      audits.push(audit("subagent-limit", subagent.name, "The subagent prompt exceeds the size bound."));
      continue;
    }
    if (utf8Bytes(subagent.description) > CLOUD_CUSTOM_SUBAGENT_MAX_DESCRIPTION_BYTES) {
      audits.push(
        audit("subagent-limit", subagent.name, "The subagent description exceeds the size bound."),
      );
      continue;
    }
    names.add(subagent.name);
    const requested = sources.requestedSubagentPermissions?.[subagent.name];
    const model =
      subagent.model === undefined
        ? undefined
        : typeof subagent.model === "string"
          ? subagent.model
          : subagent.model.id;
    subagents.push({
      name: subagent.name,
      description: subagent.description,
      prompt: subagent.prompt,
      ...(model === undefined ? {} : { model }),
      permissions: inheritSubagentPermissions(policy.parentPermissions, requested),
    });
  }
  return { subagents, audits };
}

const BUILTIN_DIAGNOSTICS: CloudMcpServerSource = {
  name: "t3-cloud-diagnostics",
  scope: "builtin",
  transport: "http",
  url: "http://127.0.0.1/mcp",
};

export function admitCloudExtensibility(
  sources: CloudExtensibilitySources,
  policy: CloudExtensibilityPolicyInput,
): CloudExtensibilityAdmission {
  const audits: CloudExtensibilityAuditEvent[] = [];
  const guestMcpServers: CloudGuestMcpServer[] = [];
  const controllerSecrets: CloudMcpControllerSecret[] = [];
  const combined: CloudMcpServerSource[] = [
    { ...BUILTIN_DIAGNOSTICS, url: `${policy.controllerMcpOrigin.replace(/\/$/u, "")}/mcp` },
    ...sources.teamMcp,
    ...sources.personalMcp,
    ...sources.apiMcp.map(apiMcpSource),
  ];
  if (combined.length - 1 > CLOUD_AGENTS_API_MAX_MCP_SERVERS) {
    audits.push(
      audit(
        "mcp-invalid",
        "mcpServers",
        `A request may include at most ${CLOUD_AGENTS_API_MAX_MCP_SERVERS} MCP servers.`,
      ),
    );
  } else {
    const seen = new Set<string>();
    for (const server of combined) {
      if (seen.has(server.name)) {
        audits.push(audit("mcp-invalid", server.name, "MCP server names must be unique."));
        continue;
      }
      seen.add(server.name);
      const result = admitOneMcp(server, policy, policy.controllerMcpOrigin);
      if ("audit" in result) {
        audits.push(result.audit);
        continue;
      }
      guestMcpServers.push(result.guest);
      if (result.secret !== undefined && (Object.keys(result.secret.headers).length > 0 || result.secret.oauthUserId !== undefined)) {
        controllerSecrets.push(result.secret);
      }
    }
  }
  const hooks = admitHooks(sources, policy);
  const subagents = admitSubagents(sources, policy);
  return {
    guestMcpServers,
    controllerSecrets,
    hooks: hooks.hooks,
    subagents: subagents.subagents,
    audits: [...audits, ...hooks.audits, ...subagents.audits].map((event) => ({
      ...event,
      message: redactExtensibilityMessage(event.message),
    })),
    egressUnchanged: true,
  };
}

export function subagentUsageEvent(input: {
  readonly runId: CloudRunId;
  readonly subagent: CloudAdmittedSubagent;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}): CloudSubagentUsageEvent {
  return {
    runId: input.runId,
    subagentName: input.subagent.name,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
  };
}
