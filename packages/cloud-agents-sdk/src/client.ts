// @effect-diagnostics globalFetch:off
import { CLOUD_AGENTS_API_CONTRACT_VERSION, type CloudAgentsApiStability } from "./types.ts";
import {
  CloudAgentsSdkError,
  type Agent,
  type Page,
  type Run,
  type WebhookEndpoint,
} from "./types.ts";
import { parseSse, resumeSse } from "./sse.ts";

export type CloudAgentsClientOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly stability?: CloudAgentsApiStability;
  readonly fetch?: typeof fetch;
};

export class CloudAgentsClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly stability: CloudAgentsApiStability;
  readonly fetchImpl: typeof fetch;

  constructor(options: CloudAgentsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.apiKey = options.apiKey;
    this.stability = options.stability ?? "v1";
    this.fetchImpl = options.fetch ?? fetch;
  }

  async me(): Promise<unknown> {
    return this.request("GET", "/me");
  }

  async createAgent(
    body: { readonly prompt: { readonly text: string } },
    options?: { readonly idempotencyKey?: string },
  ): Promise<{ readonly agent: Agent; readonly run: Run }> {
    return this.request("POST", "/agents", body, options?.idempotencyKey);
  }

  async listAgents(query?: {
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<Page<Agent>> {
    const params = new URLSearchParams();
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    if (query?.cursor !== undefined) params.set("cursor", query.cursor);
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    return this.request("GET", `/agents${suffix}`);
  }

  async getAgent(agentId: string): Promise<Agent> {
    return this.request("GET", `/agents/${agentId}`);
  }

  async createRun(
    agentId: string,
    body: { readonly prompt: { readonly text: string } },
    options?: { readonly idempotencyKey?: string },
  ): Promise<{ readonly run: Run }> {
    return this.request("POST", `/agents/${agentId}/runs`, body, options?.idempotencyKey);
  }

  async getRun(agentId: string, runId: string): Promise<Run> {
    return this.request("GET", `/agents/${agentId}/runs/${runId}`);
  }

  async cancelRun(agentId: string, runId: string): Promise<{ readonly id: string }> {
    return this.request("POST", `/agents/${agentId}/runs/${runId}/cancel`);
  }

  async streamRun(
    agentId: string,
    runId: string,
    options?: { readonly lastEventId?: string },
  ): Promise<ReturnType<typeof parseSse>> {
    const headers: Record<string, string> = this.headers();
    if (options?.lastEventId !== undefined) headers["last-event-id"] = options.lastEventId;
    const response = await this.fetchImpl(this.url(`/agents/${agentId}/runs/${runId}/stream`), {
      headers,
    });
    const text = await response.text();
    if (!response.ok) this.throwError(response.status, text, response.headers);
    const events = parseSse(text);
    return resumeSse(events, options?.lastEventId);
  }

  async createWebhook(body: {
    readonly url: string;
    readonly events?: ReadonlyArray<"status" | "terminal">;
  }): Promise<{ readonly endpoint: WebhookEndpoint; readonly secret: string }> {
    return this.request("POST", "/webhooks", body);
  }

  async listWebhooks(): Promise<Page<WebhookEndpoint>> {
    return this.request("GET", "/webhooks");
  }

  async listDeadLetters(): Promise<Page<unknown>> {
    return this.request("GET", "/webhooks/dead-letters");
  }

  private url(path: string): string {
    return `${this.baseUrl}/${this.stability}${path}`;
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      "t3-api-version": CLOUD_AGENTS_API_CONTRACT_VERSION,
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: this.headers(idempotencyKey),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "1");
      throw new CloudAgentsSdkError({
        code: "rate_limited",
        message: "Rate limit exceeded.",
        status: 429,
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 1,
      });
    }
    if (!response.ok) this.throwError(response.status, text, response.headers);
    return text.length === 0 ? (undefined as T) : (JSON.parse(text) as T);
  }

  private throwError(status: number, text: string, _headers: Headers): never {
    let code = "internal_error";
    let message = text;
    try {
      const parsed = JSON.parse(text) as { code?: string; message?: string };
      if (typeof parsed.code === "string") code = parsed.code;
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      // Keep the raw body when the server did not return a typed error.
    }
    throw new CloudAgentsSdkError({ code, message, status });
  }
}
