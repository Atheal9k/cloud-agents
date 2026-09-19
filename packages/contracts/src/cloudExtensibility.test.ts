import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CLOUD_DIAGNOSTICS_CURSOR_TOOL_NAMES,
  CLOUD_DIAGNOSTICS_SETUP_TOOLS,
  CloudEnvironmentSetupAction,
  CloudGuestMcpServer,
} from "./cloudExtensibility.ts";

describe("cloud extensibility contracts", () => {
  it("maps every CA-51 setup tool from the Cursor MCP names", () => {
    for (const tool of CLOUD_DIAGNOSTICS_SETUP_TOOLS) {
      expect(CLOUD_DIAGNOSTICS_CURSOR_TOOL_NAMES[tool]).toBe(tool);
      expect(CLOUD_DIAGNOSTICS_CURSOR_TOOL_NAMES[`cursor-cloud-${tool}`]).toBe(tool);
    }
  });

  it("keeps HTTP guest MCP free of OAuth header bags", () => {
    const guest = Schema.decodeUnknownSync(CloudGuestMcpServer)({
      type: "http",
      name: "docs",
      url: "https://controller.example/mcp/upstream/docs",
      headers: [{ name: "Authorization", value: "Bearer session" }],
    });
    expect(guest.type).toBe("http");
  });

  it("accepts the three setup-action kinds the env-setup skill requests", () => {
    const decode = Schema.decodeUnknownSync(CloudEnvironmentSetupAction);
    expect(
      decode({
        type: "add_secrets",
        secrets: [{ name: "NPM_TOKEN", optional: false }],
        reason: "Install",
      }).type,
    ).toBe("add_secrets");
    expect(
      decode({
        type: "add_egress_allowlist_domain",
        domain: "registry.npmjs.org",
        reason: "Packages",
      }).type,
    ).toBe("add_egress_allowlist_domain");
    expect(
      decode({
        type: "external_action",
        id: "oauth",
        title: "Create OAuth app",
        instructions: "Add the callback URL.",
      }).type,
    ).toBe("external_action");
  });
});
