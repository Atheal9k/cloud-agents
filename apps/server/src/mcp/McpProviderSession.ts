import type {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  CloudGuestMcpServer,
} from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Extra MCP servers admitted for a cloud run. HTTP entries are already
   * proxied; they must not carry the user's OAuth token.
   */
  readonly guestMcpServers?: ReadonlyArray<CloudGuestMcpServer>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

/** t3-code plus admitted guest servers, still in the guest/CloudGuest shape. */
export function guestMcpServersFromSession(
  session: McpProviderSessionConfig | undefined,
): ReadonlyArray<CloudGuestMcpServer> {
  if (session === undefined) return [];
  return [
    {
      type: "http",
      name: "t3-code",
      url: session.endpoint,
      headers: [{ name: "Authorization", value: session.authorizationHeader }],
    },
    ...(session.guestMcpServers ?? []).filter((server) => server.name !== "t3-code"),
  ];
}

/**
 * ACP `McpServer` objects. stdio has no `type` field and requires `env`.
 * HTTP credentials here are the proxied session headers, never OAuth.
 */
export function acpProtocolMcpServersFromSession(
  session: McpProviderSessionConfig | undefined,
): ReadonlyArray<
  | {
      readonly type: "http" | "sse";
      readonly name: string;
      readonly url: string;
      readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    }
  | {
      readonly name: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    }
> {
  return guestMcpServersFromSession(session).map((server) =>
    server.type === "stdio"
      ? { name: server.name, command: server.command, args: server.args, env: [] }
      : {
          type: server.type,
          name: server.name,
          url: server.url,
          headers: server.headers,
        },
  );
}

export const acpMcpServersFromSession = guestMcpServersFromSession;

export function claudeMcpServersFromSession(
  session: McpProviderSessionConfig,
): Record<
  string,
  | { readonly type: "http" | "sse"; readonly url: string; readonly headers: Record<string, string> }
  | { readonly type: "stdio"; readonly command: string; readonly args: string[] }
> {
  const servers: Record<
    string,
    | { readonly type: "http" | "sse"; readonly url: string; readonly headers: Record<string, string> }
    | { readonly type: "stdio"; readonly command: string; readonly args: string[] }
  > = {};
  for (const extra of guestMcpServersFromSession(session)) {
    if (extra.type === "stdio") {
      servers[extra.name] = { type: "stdio", command: extra.command, args: [...extra.args] };
    } else {
      servers[extra.name] = {
        type: extra.type,
        url: extra.url,
        headers: Object.fromEntries(extra.headers.map((header) => [header.name, header.value])),
      };
    }
  }
  return servers;
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
