import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CLOUD_WEBHOOK_MAX_ATTEMPTS,
  CLOUD_WEBHOOK_RETRY_DELAYS_MS,
  CloudWebhookCreated,
  CloudWebhookPayload,
} from "./cloudWebhooks.ts";

const decodeCreated = Schema.decodeUnknownSync(CloudWebhookCreated);
const decodePayload = Schema.decodeUnknownSync(CloudWebhookPayload);

describe("cloud webhook contracts", () => {
  it("decodes a created endpoint and a signed payload shape", () => {
    expect(
      decodeCreated({
        endpoint: {
          id: "webhook-1",
          url: "https://example.com/hooks",
          events: ["status", "terminal"],
          createdAt: "2026-09-19T00:00:00.000Z",
          updatedAt: "2026-09-19T00:00:00.000Z",
        },
        secret: "whsec_test",
      }).secret,
    ).toBe("whsec_test");
    expect(
      decodePayload({
        eventId: "evt-1",
        deliveryId: "dlv-1",
        type: "terminal",
        apiVersion: "2026-09-19",
        createdAt: "2026-09-19T00:00:00.000Z",
        agentId: "bc-1",
        runId: "run-1",
        runStatus: "FINISHED",
      }).type,
    ).toBe("terminal");
    expect(CLOUD_WEBHOOK_RETRY_DELAYS_MS).toHaveLength(CLOUD_WEBHOOK_MAX_ATTEMPTS);
  });
});
