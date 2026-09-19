import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  acpMcpServersFromSession,
  withAgentDeviceEnvironment,
  type McpProviderSessionConfig,
} from "./McpProviderSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });

  it("proxies extra HTTP MCP servers without copying OAuth into the guest", () => {
    const session: McpProviderSessionConfig = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1/mcp",
      authorizationHeader: "Bearer t3-session",
      capabilities: new Set(["cloud-diagnostics"]),
      guestMcpServers: [
        {
          type: "http",
          name: "docs",
          url: "https://controller.internal/mcp/upstream/docs",
          headers: [{ name: "Authorization", value: "Bearer mcp-session-docs" }],
        },
      ],
    };
    const servers = acpMcpServersFromSession(session);
    expect(servers.map((server) => server.name)).toEqual(["t3-code", "docs"]);
    expect(JSON.stringify(servers)).not.toContain("oauth");
    expect(servers[1]).toMatchObject({
      url: "https://controller.internal/mcp/upstream/docs",
    });
  });
});
