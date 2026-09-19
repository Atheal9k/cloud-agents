import { describe, expect, it } from "vite-plus/test";

import {
  CLOUD_AGENTS_API_STREAM_RETENTION_SECONDS,
  type CloudAgentsApiCreateAgentRequest,
  type CloudAgentsApiStreamEvent,
} from "@t3tools/contracts";

import {
  apiError,
  consumeRateLimit,
  encodeSse,
  modelsFromProviders,
  paginateNewestFirst,
  parseCloudAgentsApiAuthorization,
  principalMe,
  resumeStream,
  statusForCode,
  validateCreateAgentRequest,
} from "./cloudAgentsApiModel.ts";

describe("cloud agents API model", () => {
  it("accepts Basic and Bearer API keys", () => {
    expect(parseCloudAgentsApiAuthorization("Bearer secret-key")).toBe("secret-key");
    expect(parseCloudAgentsApiAuthorization(`Basic ${Buffer.from("secret-key:").toString("base64")}`)).toBe(
      "secret-key",
    );
    expect(parseCloudAgentsApiAuthorization(undefined)).toMatchObject({ code: "unauthorized" });
  });

  it("omits user fields for service accounts", () => {
    expect(
      principalMe({
        principalId: "principal:1",
        kind: "service_account",
        apiKeyName: "CI",
        createdAt: "2026-09-19T00:00:00.000Z",
        userEmail: "hidden@example.com",
      }),
    ).toEqual({ apiKeyName: "CI", createdAt: "2026-09-19T00:00:00.000Z" });
  });

  it("rejects envVars with a caller-provided agent id and colliding subagents", () => {
    const invalid: CloudAgentsApiCreateAgentRequest = {
      prompt: { text: "Work" },
      agentId: "bc-1",
      envVars: { CI: "1" },
    };
    expect(validateCreateAgentRequest(invalid)?.code).toBe("invalid_request");
    expect(
      validateCreateAgentRequest({
        prompt: { text: "Work" },
        customSubagents: [{ name: "reviewer", description: "x", prompt: "y".repeat(40_000) }],
      })?.message,
    ).toContain("prompt size bound");
  });

  it("paginates newest-first without a null nextCursor", () => {
    const page = paginateNewestFirst(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      { limit: 2 },
    );
    expect(page.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe("c");
    expect(paginateNewestFirst([{ id: "a" }, { id: "b" }], { limit: 2 }).nextCursor).toBeUndefined();
  });

  it("resumes SSE from Last-Event-ID and expires old streams", () => {
    const events: CloudAgentsApiStreamEvent[] = [
      { event: "status", data: { status: "RUNNING" }, createdAtMs: 1_000 },
      { id: "1000-1", event: "assistant", data: { text: "Hi" }, createdAtMs: 1_000 },
      { id: "1000-2", event: "thinking", data: { text: "..." }, createdAtMs: 1_000 },
      { id: "1000-3", event: "tool_call", data: { callId: "c1", name: "read_file", status: "running" }, createdAtMs: 1_000 },
      { id: "1000-4", event: "interaction_update", data: { type: "text-delta" }, createdAtMs: 1_000 },
      { id: "1000-5", event: "heartbeat", data: {}, createdAtMs: 1_000 },
      { id: "1000-6", event: "result", data: { status: "FINISHED" }, createdAtMs: 1_000 },
      { id: "1000-7", event: "done", data: {}, createdAtMs: 1_000 },
    ];
    const resumed = resumeStream({ events, lastEventId: "1000-1", nowMs: 2_000 });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.events.map((event) => event.event)).toEqual([
        "thinking",
        "tool_call",
        "interaction_update",
        "heartbeat",
        "result",
        "done",
      ]);
    }
    expect(resumeStream({ events, lastEventId: "missing", nowMs: 2_000 })).toMatchObject({
      ok: false,
      error: { code: "invalid_last_event_id" },
    });
    expect(
      resumeStream({
        events,
        lastEventId: "1000-1",
        nowMs: 1_000 + (CLOUD_AGENTS_API_STREAM_RETENTION_SECONDS + 1) * 1_000,
      }),
    ).toMatchObject({ ok: false, error: { code: "stream_expired" } });
    expect(encodeSse(events[1]!)).toContain("event: assistant");
  });

  it("maps stable error codes and rate-limit remaining", () => {
    expect(statusForCode("agent_busy")).toBe(409);
    expect(statusForCode("stream_expired")).toBe(410);
    expect(statusForCode("subscription_not_found")).toBe(404);
    expect(statusForCode("automation_not_found")).toBe(404);
    expect(apiError("run_not_cancellable", "done").toBody()).toEqual({
      code: "run_not_cancellable",
      message: "done",
    });
    const first = consumeRateLimit({ window: undefined, nowMs: 0, limit: 1, windowMs: 60_000 });
    expect(first.decision.allowed).toBe(true);
    const second = consumeRateLimit({
      window: first.window,
      nowMs: 1,
      limit: 1,
      windowMs: 60_000,
    });
    expect(second.decision.allowed).toBe(false);
    expect(second.decision.remaining).toBe(0);
  });

  it("lists provider models for GET /v1/models", () => {
    expect(
      modelsFromProviders([
        { models: [{ slug: "gpt-5.6-sol", name: "GPT", aliases: ["gpt"] }] },
        { models: [{ slug: "gpt-5.6-sol", name: "Duplicate" }] },
      ]),
    ).toEqual([
      {
        id: "gpt-5.6-sol",
        displayName: "GPT",
        aliases: ["gpt"],
        variants: [{ params: [], displayName: "GPT", isDefault: true }],
      },
    ]);
  });
});
