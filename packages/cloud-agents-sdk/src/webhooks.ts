// @effect-diagnostics nodeBuiltinImport:off
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADER = "x-t3-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-t3-timestamp";
export const WEBHOOK_DELIVERY_ID_HEADER = "x-t3-delivery-id";
export const WEBHOOK_EVENT_ID_HEADER = "x-t3-event-id";
export const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

export function signWebhook(input: {
  readonly secret: string;
  readonly timestampSeconds: number;
  readonly body: string;
}): string {
  const digest = createHmac("sha256", input.secret)
    .update(`${String(input.timestampSeconds)}.${input.body}`)
    .digest("hex");
  return `sha256=${digest}`;
}

export function verifyWebhook(input: {
  readonly secret: string;
  readonly timestampSeconds: number;
  readonly body: string;
  readonly signature: string | undefined;
  readonly nowSeconds: number;
  readonly replayWindowSeconds?: number;
}): boolean {
  const windowSeconds = input.replayWindowSeconds ?? WEBHOOK_REPLAY_WINDOW_SECONDS;
  if (!Number.isFinite(input.timestampSeconds) || input.timestampSeconds <= 0) return false;
  if (Math.abs(input.nowSeconds - input.timestampSeconds) > windowSeconds) return false;
  if (input.signature === undefined || !/^sha256=[a-f0-9]{64}$/iu.test(input.signature)) {
    return false;
  }
  const expected = signWebhook(input);
  const actualBytes = Buffer.from(input.signature.toLowerCase(), "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
