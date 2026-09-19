export const CLOUD_AGENTS_API_CONTRACT_VERSION = "2026-09-19";
export const CLOUD_AGENTS_API_STABILITIES = ["v1", "beta", "preview"] as const;
export type CloudAgentsApiStability = (typeof CLOUD_AGENTS_API_STABILITIES)[number];

export type CloudAgentsApiError = {
  readonly code: string;
  readonly message: string;
};

export class CloudAgentsSdkError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly status: number;
    readonly retryAfterSeconds?: number;
  }) {
    super(input.message);
    this.name = "CloudAgentsSdkError";
    this.code = input.code;
    this.status = input.status;
    if (input.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = input.retryAfterSeconds;
    }
  }
}

export type AgentSummary = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly url: string;
};

export type Agent = AgentSummary & {
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type Run = {
  readonly id: string;
  readonly agentId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type Page<Item> = {
  readonly items: ReadonlyArray<Item>;
  readonly nextCursor?: string;
};

export type StreamEvent = {
  readonly id?: string;
  readonly event: string;
  readonly data: unknown;
};

export type WebhookEndpoint = {
  readonly id: string;
  readonly url: string;
  readonly events: ReadonlyArray<string>;
};
