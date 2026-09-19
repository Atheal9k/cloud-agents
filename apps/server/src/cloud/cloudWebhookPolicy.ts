// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CLOUD_WEBHOOK_MAX_ATTEMPTS,
  CLOUD_WEBHOOK_REPLAY_WINDOW_SECONDS,
  CLOUD_WEBHOOK_RETRY_DELAYS_MS,
  CLOUD_WEBHOOK_SIGNATURE_HEADER,
  CLOUD_WEBHOOK_TIMESTAMP_HEADER,
} from "@t3tools/contracts";

export function cloudWebhookSignedPayload(timestampSeconds: number, body: string): string {
  return `${String(timestampSeconds)}.${body}`;
}

export function signCloudWebhook(input: {
  readonly secret: string;
  readonly timestampSeconds: number;
  readonly body: string;
}): string {
  const digest = NodeCrypto.createHmac("sha256", input.secret)
    .update(cloudWebhookSignedPayload(input.timestampSeconds, input.body))
    .digest("hex");
  return `sha256=${digest}`;
}

export function verifyCloudWebhookSignature(input: {
  readonly secret: string;
  readonly timestampSeconds: number;
  readonly body: string;
  readonly signature: string | undefined;
  readonly nowSeconds: number;
  readonly replayWindowSeconds?: number;
}): boolean {
  const windowSeconds = input.replayWindowSeconds ?? CLOUD_WEBHOOK_REPLAY_WINDOW_SECONDS;
  if (!Number.isFinite(input.timestampSeconds) || input.timestampSeconds <= 0) return false;
  if (Math.abs(input.nowSeconds - input.timestampSeconds) > windowSeconds) return false;
  if (input.signature === undefined || !/^sha256=[a-f0-9]{64}$/iu.test(input.signature)) {
    return false;
  }
  const expected = signCloudWebhook({
    secret: input.secret,
    timestampSeconds: input.timestampSeconds,
    body: input.body,
  });
  const actualBytes = Buffer.from(input.signature.toLowerCase(), "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    NodeCrypto.timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function nextCloudWebhookRetryDelayMs(attempt: number): number | undefined {
  if (attempt >= CLOUD_WEBHOOK_MAX_ATTEMPTS) return undefined;
  return CLOUD_WEBHOOK_RETRY_DELAYS_MS[attempt - 1];
}

export function cloudWebhookRequestHeaders(input: {
  readonly signature: string;
  readonly timestampSeconds: number;
  readonly deliveryId: string;
  readonly eventId: string;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    [CLOUD_WEBHOOK_SIGNATURE_HEADER]: input.signature,
    [CLOUD_WEBHOOK_TIMESTAMP_HEADER]: String(input.timestampSeconds),
    "x-t3-delivery-id": input.deliveryId,
    "x-t3-event-id": input.eventId,
  };
}

export function validateCloudWebhookUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Webhook URLs must be absolute http or https URLs.";
  }
  if (parsed.protocol === "https:") return undefined;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
  ) {
    return undefined;
  }
  return "Webhook URLs must use https, or http only for localhost.";
}
