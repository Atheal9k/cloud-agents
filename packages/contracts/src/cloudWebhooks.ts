import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CloudAgentStatus, CloudRunStatus } from "./cloudAllocation.ts";

export const CLOUD_WEBHOOK_SIGNATURE_HEADER = "x-t3-signature";
export const CLOUD_WEBHOOK_TIMESTAMP_HEADER = "x-t3-timestamp";
export const CLOUD_WEBHOOK_DELIVERY_ID_HEADER = "x-t3-delivery-id";
export const CLOUD_WEBHOOK_EVENT_ID_HEADER = "x-t3-event-id";
export const CLOUD_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;
export const CLOUD_WEBHOOK_MAX_ATTEMPTS = 5;
export const CLOUD_WEBHOOK_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export const CloudWebhookEventType = Schema.Literals(["status", "terminal"]);
export type CloudWebhookEventType = typeof CloudWebhookEventType.Type;

export const CloudWebhookDeliveryStatus = Schema.Literals([
  "pending",
  "delivered",
  "failed",
  "dead_letter",
]);
export type CloudWebhookDeliveryStatus = typeof CloudWebhookDeliveryStatus.Type;

export const CloudWebhookCreateRequest = Schema.Struct({
  url: TrimmedNonEmptyString,
  events: Schema.optionalKey(Schema.Array(CloudWebhookEventType)),
  description: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudWebhookCreateRequest = typeof CloudWebhookCreateRequest.Type;

export const CloudWebhookEndpoint = Schema.Struct({
  id: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  events: Schema.Array(CloudWebhookEventType),
  description: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudWebhookEndpoint = typeof CloudWebhookEndpoint.Type;

export const CloudWebhookCreated = Schema.Struct({
  endpoint: CloudWebhookEndpoint,
  secret: TrimmedNonEmptyString,
});
export type CloudWebhookCreated = typeof CloudWebhookCreated.Type;

export const CloudWebhookPayload = Schema.Struct({
  eventId: TrimmedNonEmptyString,
  deliveryId: TrimmedNonEmptyString,
  type: CloudWebhookEventType,
  apiVersion: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  agentId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  agentStatus: Schema.optionalKey(CloudAgentStatus),
  runStatus: CloudRunStatus,
});
export type CloudWebhookPayload = typeof CloudWebhookPayload.Type;

export const CloudWebhookDelivery = Schema.Struct({
  id: TrimmedNonEmptyString,
  endpointId: TrimmedNonEmptyString,
  eventId: TrimmedNonEmptyString,
  type: CloudWebhookEventType,
  status: CloudWebhookDeliveryStatus,
  attempt: PositiveInt,
  httpStatus: Schema.optionalKey(NonNegativeInt),
  lastError: Schema.optionalKey(TrimmedNonEmptyString),
  payload: CloudWebhookPayload,
  nextAttemptAt: Schema.optionalKey(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudWebhookDelivery = typeof CloudWebhookDelivery.Type;
