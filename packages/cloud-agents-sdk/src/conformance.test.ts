// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { CloudAgentsClient, CloudAgentsSdkError } from "./index.ts";
import { parseSse, resumeSse } from "./sse.ts";
import { signWebhook, verifyWebhook } from "./webhooks.ts";

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/conformance.json"),
    "utf8",
  ),
) as {
  readonly apiVersion: string;
  readonly pagination: {
    readonly items: ReadonlyArray<{ readonly id: string }>;
    readonly nextCursor: string;
  };
  readonly sse: ReadonlyArray<string>;
  readonly error: { readonly code: string; readonly message: string };
  readonly webhook: {
    readonly secret: string;
    readonly timestampSeconds: number;
    readonly body: string;
  };
};

describe("cloud agents SDK conformance", () => {
  it("parses pagination, SSE resume, typed errors, and webhook signatures", () => {
    expect(fixture.pagination.nextCursor).toBe("agent-0");
    expect(fixture.pagination.items).toHaveLength(2);

    const events = parseSse(fixture.sse.join(""));
    expect(events.map((event) => event.event)).toEqual(["status", "result"]);
    expect(resumeSse(events, "1000-0").map((event) => event.event)).toEqual(["result"]);

    const signature = signWebhook(fixture.webhook);
    expect(
      verifyWebhook({
        ...fixture.webhook,
        signature,
        nowSeconds: fixture.webhook.timestampSeconds + 5,
      }),
    ).toBe(true);
    expect(
      verifyWebhook({
        ...fixture.webhook,
        signature,
        nowSeconds: fixture.webhook.timestampSeconds + 400,
      }),
    ).toBe(false);
    expect(fixture.error.code).toBe("rate_limited");
  });

  it("retries after Retry-After and sends idempotency keys", async () => {
    const calls: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const client = new CloudAgentsClient({
      baseUrl: "http://controller.test",
      apiKey: "t3ca_test",
      fetch: (async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, headers });
        if (url.endsWith("/v1/agents") && calls.length === 1) {
          return new Response(
            JSON.stringify({ code: "rate_limited", message: "Rate limit exceeded." }),
            {
              status: 429,
              headers: { "retry-after": "2" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            agent: {
              id: "bc-1",
              name: "Agent",
              status: "ACTIVE",
              url: "http://x",
              createdAt: "t",
              updatedAt: "t",
            },
            run: {
              id: "run-1",
              agentId: "bc-1",
              status: "CREATING",
              createdAt: "t",
              updatedAt: "t",
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    try {
      await client.createAgent(
        { prompt: { text: "Add a README" } },
        { idempotencyKey: "create-1" },
      );
      throw new Error("expected rate limit");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAgentsSdkError);
      expect((error as CloudAgentsSdkError).retryAfterSeconds).toBe(2);
    }
    const created = await client.createAgent(
      { prompt: { text: "Add a README" } },
      { idempotencyKey: "create-1" },
    );
    expect(created.agent.id).toBe("bc-1");
    expect(calls[1]?.headers.get("idempotency-key")).toBe("create-1");
    expect(calls[1]?.headers.get("t3-api-version")).toBe(fixture.apiVersion);
  });
});
