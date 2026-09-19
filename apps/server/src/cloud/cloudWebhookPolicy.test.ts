import { expect, it } from "vite-plus/test";

import { CLOUD_WEBHOOK_MAX_ATTEMPTS, CLOUD_WEBHOOK_RETRY_DELAYS_MS } from "@t3tools/contracts";

import {
  nextCloudWebhookRetryDelayMs,
  signCloudWebhook,
  validateCloudWebhookUrl,
  verifyCloudWebhookSignature,
} from "./cloudWebhookPolicy.ts";

it("signs HMAC-SHA256 payloads and rejects replayed or forged deliveries", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ eventId: "evt-1" });
  const signature = signCloudWebhook({ secret, timestampSeconds: 1_000, body });
  expect(
    verifyCloudWebhookSignature({
      secret,
      timestampSeconds: 1_000,
      body,
      signature,
      nowSeconds: 1_010,
    }),
  ).toBe(true);
  expect(
    verifyCloudWebhookSignature({
      secret,
      timestampSeconds: 1_000,
      body,
      signature,
      nowSeconds: 1_000 + 301,
    }),
  ).toBe(false);
  expect(
    verifyCloudWebhookSignature({
      secret,
      timestampSeconds: 1_000,
      body,
      signature: "sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      nowSeconds: 1_010,
    }),
  ).toBe(false);
});

it("bounds retries then stops, and rejects remote http webhook URLs", () => {
  expect(nextCloudWebhookRetryDelayMs(1)).toBe(CLOUD_WEBHOOK_RETRY_DELAYS_MS[0]);
  expect(nextCloudWebhookRetryDelayMs(CLOUD_WEBHOOK_MAX_ATTEMPTS)).toBeUndefined();
  expect(validateCloudWebhookUrl("https://hooks.example.com/t3")).toBeUndefined();
  expect(validateCloudWebhookUrl("http://127.0.0.1:8080/hook")).toBeUndefined();
  expect(validateCloudWebhookUrl("http://evil.example/hook")).toMatch(/https/u);
});
