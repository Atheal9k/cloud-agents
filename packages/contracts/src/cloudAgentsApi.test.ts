import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CloudAgentsApiCreateAgentRequest,
  CloudAgentsApiErrorBody,
  CloudAgentsApiMe,
  CloudAgentsApiStreamEvent,
} from "./cloudAgentsApi.ts";

const decodeCreate = Schema.decodeUnknownSync(CloudAgentsApiCreateAgentRequest);
const decodeError = Schema.decodeUnknownSync(CloudAgentsApiErrorBody);
const decodeMe = Schema.decodeUnknownSync(CloudAgentsApiMe);
const decodeStream = Schema.decodeUnknownSync(CloudAgentsApiStreamEvent);

describe("cloud agents API contracts", () => {
  it("decodes create, me, stream, and stable error codes", () => {
    expect(
      decodeCreate({
        prompt: { text: "Add a README" },
        agentId: "bc-00000000-0000-0000-0000-000000000001",
        mode: "plan",
        model: { id: "gpt-5.6-sol", params: [{ id: "fast", value: "true" }] },
        repos: [{ url: "https://github.com/acme/app", startingRef: "main" }],
        envVars: { CI: "1" },
        mcpServers: [{ name: "docs", type: "http", url: "https://example.com/mcp" }],
        customSubagents: [{ name: "reviewer", description: "Reviews", prompt: "Review the diff" }],
      }).prompt.text,
    ).toBe("Add a README");

    expect(decodeError({ code: "agent_busy", message: "Wait for the active run." }).code).toBe(
      "agent_busy",
    );
    expect(decodeMe({ apiKeyName: "CI", createdAt: "2026-09-19T00:00:00.000Z" }).userId).toBe(
      undefined,
    );
    expect(
      decodeStream({
        id: "1713033000000-0",
        event: "heartbeat",
        data: {},
        createdAtMs: 1_713_033_000_000,
      }).event,
    ).toBe("heartbeat");
  });
});
