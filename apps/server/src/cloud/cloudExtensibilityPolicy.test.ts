import { describe, expect, it } from "vite-plus/test";

import {
  CLOUD_PARENT_SUBAGENT_PERMISSIONS,
  CloudRunId,
  type CloudExtensibilityPolicyInput,
} from "@t3tools/contracts";

import { cloudEgressExceptions, resolveCloudEgressPolicy } from "./cloudSecurityPolicy.ts";
import {
  admitCloudExtensibility,
  inheritSubagentPermissions,
  parseCursorHooksJson,
  redactExtensibilityMessage,
  subagentUsageEvent,
} from "./cloudExtensibilityPolicy.ts";

const exceptions = cloudEgressExceptions({
  controllerHost: "controller.internal",
  scmHosts: ["github.com"],
  artifactHosts: ["artifacts.internal"],
});

function policy(
  overrides: Partial<CloudExtensibilityPolicyInput> = {},
): CloudExtensibilityPolicyInput {
  return {
    disableAllMcpServers: false,
    mcpServerAllowlist: [],
    egress: resolveCloudEgressPolicy({
      environment: { mode: "allowlist_only", allowlist: ["mcp.example.com"] },
      exceptions,
    }),
    controllerMcpOrigin: "https://controller.internal",
    phase: "runtime",
    parentPermissions: CLOUD_PARENT_SUBAGENT_PERMISSIONS,
    ...overrides,
  };
}

describe("cloud extensibility policy", () => {
  it("keeps HTTP OAuth on the controller and runs stdio in the guest", () => {
    const admitted = admitCloudExtensibility(
      {
        teamMcp: [
          {
            name: "docs",
            scope: "team",
            transport: "http",
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "Bearer oauth-user-token" },
            oauthUserId: "user-1",
          },
        ],
        personalMcp: [],
        apiMcp: [{ name: "lint", type: "stdio", command: "mcp-lint", args: ["--stdio"] }],
        customSubagents: [],
      },
      policy(),
    );

    const docs = admitted.guestMcpServers.find((server) => server.name === "docs");
    const lint = admitted.guestMcpServers.find((server) => server.name === "lint");
    expect(docs).toMatchObject({
      type: "http",
      url: "https://controller.internal/mcp/upstream/docs",
    });
    expect(docs && "headers" in docs ? docs.headers[0]?.value : undefined).not.toContain(
      "oauth-user-token",
    );
    expect(admitted.controllerSecrets).toEqual([
      expect.objectContaining({
        serverName: "docs",
        targetUrl: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer oauth-user-token" },
        oauthUserId: "user-1",
      }),
    ]);
    expect(lint).toEqual({
      type: "stdio",
      name: "lint",
      command: "mcp-lint",
      args: ["--stdio"],
    });
    expect(admitted.guestMcpServers.some((server) => server.name === "t3-cloud-diagnostics")).toBe(
      true,
    );
    expect(admitted.egressUnchanged).toBe(true);
    expect(admitted.audits).toEqual([]);
  });

  it("isolates MCP failures without widening egress or leaking secrets", () => {
    const admitted = admitCloudExtensibility(
      {
        teamMcp: [
          {
            name: "blocked",
            scope: "team",
            transport: "http",
            url: "https://evil.example/mcp",
            headers: { Authorization: "Bearer super-secret" },
          },
          {
            name: "ok",
            scope: "team",
            transport: "http",
            url: "https://mcp.example.com/mcp",
          },
        ],
        personalMcp: [],
        apiMcp: [],
        customSubagents: [],
      },
      policy({
        mcpServerAllowlist: [
          { name: "blocked", serverUrl: "https://evil.example/mcp" },
          { name: "ok", serverUrl: "https://mcp.example.com/mcp" },
        ],
      }),
    );

    expect(admitted.guestMcpServers.map((server) => server.name)).toEqual([
      "t3-cloud-diagnostics",
      "ok",
    ]);
    expect(admitted.audits).toEqual([
      expect.objectContaining({
        kind: "mcp-egress-denied",
        target: "blocked",
        isolated: true,
      }),
    ]);
    expect(JSON.stringify(admitted.audits)).not.toContain("super-secret");
    expect(admitted.egressUnchanged).toBe(true);
  });

  it("disables extra MCP servers while keeping diagnostics", () => {
    const admitted = admitCloudExtensibility(
      {
        teamMcp: [
          {
            name: "docs",
            scope: "team",
            transport: "http",
            url: "https://mcp.example.com/mcp",
          },
        ],
        personalMcp: [],
        apiMcp: [],
        customSubagents: [],
      },
      policy({ disableAllMcpServers: true }),
    );
    expect(admitted.guestMcpServers.map((server) => server.name)).toEqual(["t3-cloud-diagnostics"]);
    expect(admitted.audits[0]?.kind).toBe("mcp-disabled");
  });

  it("skips local-home hooks and mutating hooks during read-only setup", () => {
    const home = admitCloudExtensibility(
      {
        teamMcp: [],
        personalMcp: [],
        apiMcp: [],
        customSubagents: [],
        hooksSource: "local-home",
        hooksJson: '{"hooks":{"stop":[{"command":"echo hi"}]}}',
      },
      policy(),
    );
    expect(home.hooks).toEqual([]);
    expect(home.audits[0]).toMatchObject({ kind: "hook-unavailable", isolated: true });

    const setup = admitCloudExtensibility(
      {
        teamMcp: [],
        personalMcp: [],
        apiMcp: [],
        customSubagents: [],
        hooksSource: "repository",
        hooksJson: JSON.stringify({
          hooks: {
            afterFileEdit: [{ command: "fmt" }],
            beforeReadFile: [{ command: "audit-read" }],
          },
        }),
      },
      policy({ phase: "install" }),
    );
    expect(setup.hooks).toEqual([
      expect.objectContaining({ event: "beforeReadFile", command: "audit-read", phase: "install" }),
    ]);
    expect(setup.audits).toEqual([
      expect.objectContaining({
        kind: "hook-skipped-readonly-setup",
        target: "afterFileEdit",
      }),
    ]);
  });

  it("parses repository command hooks and admits them at runtime", () => {
    const parsed = parseCursorHooksJson(
      JSON.stringify({
        version: 1,
        hooks: {
          beforeShellExecution: [{ command: "policy-check", matcher: "rm *" }],
          stop: "notify-done",
        },
      }),
    );
    expect("hooks" in parsed && parsed.hooks).toEqual([
      { event: "beforeShellExecution", command: "policy-check", matcher: "rm *" },
      { event: "stop", command: "notify-done" },
    ]);
    const admitted = admitCloudExtensibility(
      {
        teamMcp: [],
        personalMcp: [],
        apiMcp: [],
        customSubagents: [],
        hooksSource: "repository",
        hooksJson: JSON.stringify({
          hooks: { stop: [{ command: "notify-done" }] },
        }),
      },
      policy(),
    );
    expect(admitted.hooks).toEqual([
      expect.objectContaining({ event: "stop", source: "repository", phase: "runtime" }),
    ]);
  });

  it("rejects shadowed built-ins and never widens inherited permissions", () => {
    const admitted = admitCloudExtensibility(
      {
        teamMcp: [],
        personalMcp: [],
        apiMcp: [],
        customSubagents: [
          { name: "explore", description: "no", prompt: "no" },
          { name: "reviewer", description: "Reviews diffs", prompt: "Review carefully." },
        ],
        requestedSubagentPermissions: {
          reviewer: { filesystem: true, network: true, secrets: true },
        },
      },
      policy({
        parentPermissions: { filesystem: true, network: false, secrets: false },
      }),
    );
    expect(admitted.subagents).toEqual([
      {
        name: "reviewer",
        description: "Reviews diffs",
        prompt: "Review carefully.",
        permissions: { filesystem: true, network: false, secrets: false },
      },
    ]);
    expect(admitted.audits[0]?.kind).toBe("subagent-shadows-builtin");
    expect(
      inheritSubagentPermissions(
        { filesystem: true, network: false, secrets: true },
        { filesystem: true, network: true, secrets: false },
      ),
    ).toEqual({ filesystem: true, network: false, secrets: false });
    expect(
      subagentUsageEvent({
        runId: CloudRunId.make("run-1"),
        subagent: admitted.subagents[0]!,
        inputTokens: 3,
        outputTokens: 5,
      }),
    ).toEqual({
      runId: CloudRunId.make("run-1"),
      subagentName: "reviewer",
      inputTokens: 3,
      outputTokens: 5,
    });
  });

  it("redacts bearer tokens in isolated failure messages", () => {
    expect(redactExtensibilityMessage("Authorization: Bearer abc.def")).toContain("[redacted]");
    expect(redactExtensibilityMessage("Authorization: Bearer abc.def")).not.toContain("abc.def");
  });
});
