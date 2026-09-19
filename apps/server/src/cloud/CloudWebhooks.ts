// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

import {
  CLOUD_AGENTS_API_CONTRACT_VERSION,
  CloudAgentsApiPrincipal,
  type CloudWebhookCreated,
  type CloudWebhookDelivery,
  type CloudWebhookDeliveryStatus,
  type CloudWebhookEndpoint,
  type CloudWebhookEventType,
  CloudWebhookPayload,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CloudAgentsApiFailure, apiError } from "./cloudAgentsApiModel.ts";
import {
  cloudWebhookRequestHeaders,
  nextCloudWebhookRetryDelayMs,
  signCloudWebhook,
  validateCloudWebhookUrl,
} from "./cloudWebhookPolicy.ts";

type EndpointRow = {
  readonly endpointId: string;
  readonly principalId: string;
  readonly url: string;
  readonly secret: string;
  readonly eventsJson: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type DeliveryRow = {
  readonly deliveryId: string;
  readonly endpointId: string;
  readonly principalId: string;
  readonly eventId: string;
  readonly type: CloudWebhookEventType;
  readonly status: CloudWebhookDeliveryStatus;
  readonly attempt: number;
  readonly httpStatus: number | null;
  readonly lastError: string | null;
  readonly payloadJson: string;
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

const decodeEvents = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Literals(["status", "terminal"]))),
);
const encodeEvents = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Literals(["status", "terminal"]))),
);
const encodePayload = Schema.encodeSync(Schema.fromJsonString(CloudWebhookPayload));
const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(CloudWebhookPayload));

export class CloudWebhookTransport extends Context.Service<
  CloudWebhookTransport,
  {
    readonly post: (input: {
      readonly url: string;
      readonly headers: Record<string, string>;
      readonly body: string;
    }) => Effect.Effect<{ readonly status: number }, { readonly message: string }>;
  }
>()("t3/cloud/CloudWebhooks/CloudWebhookTransport") {}

function postWebhook(input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}): Effect.Effect<{ readonly status: number }, { readonly message: string }> {
  return Effect.callback((resume) => {
    const url = new URL(input.url);
    const client = url.protocol === "https:" ? NodeHttps : NodeHttp;
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: input.headers,
      },
      (response) => {
        response.resume();
        resume(Effect.succeed({ status: response.statusCode ?? 0 }));
      },
    );
    request.on("error", (error) => {
      resume(Effect.fail({ message: error.message }));
    });
    request.write(input.body);
    request.end();
    return Effect.sync(() => {
      request.destroy();
    });
  });
}

export const CloudWebhookTransportLive = Layer.succeed(CloudWebhookTransport, {
  post: postWebhook,
});

export class CloudWebhooks extends Context.Service<
  CloudWebhooks,
  {
    readonly create: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly url: string;
      readonly events?: ReadonlyArray<CloudWebhookEventType>;
      readonly description?: string;
    }) => Effect.Effect<CloudWebhookCreated, CloudAgentsApiFailure>;
    readonly list: (input: {
      readonly principal: CloudAgentsApiPrincipal;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<CloudWebhookEndpoint> },
      CloudAgentsApiFailure
    >;
    readonly get: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly endpointId: string;
    }) => Effect.Effect<CloudWebhookEndpoint, CloudAgentsApiFailure>;
    readonly remove: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly endpointId: string;
    }) => Effect.Effect<{ readonly id: string }, CloudAgentsApiFailure>;
    readonly listDeliveries: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly endpointId: string;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<CloudWebhookDelivery> },
      CloudAgentsApiFailure
    >;
    readonly listDeadLetters: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<CloudWebhookDelivery> },
      CloudAgentsApiFailure
    >;
    readonly redeliver: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly deliveryId: string;
    }) => Effect.Effect<CloudWebhookDelivery, CloudAgentsApiFailure>;
    readonly publish: (input: {
      readonly principalId: string;
      readonly type: CloudWebhookEventType;
      readonly agentId: string;
      readonly runId: string;
      readonly runStatus: CloudWebhookPayload["runStatus"];
      readonly agentStatus?: CloudWebhookPayload["agentStatus"];
      readonly nowMs: number;
    }) => Effect.Effect<void>;
    readonly reconcile: (nowMs: number) => Effect.Effect<void>;
  }
>()("t3/cloud/CloudWebhooks") {}

function persistenceFailure(): CloudAgentsApiFailure {
  return apiError("internal_error", "Webhook catalog is unavailable.");
}

function missing(endpointId: string): CloudAgentsApiFailure {
  return apiError("webhook_not_found", `Webhook '${endpointId}' was not found.`);
}

function nowIso(nowMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(nowMs));
}

function publicEndpoint(row: EndpointRow): CloudWebhookEndpoint {
  return {
    id: row.endpointId,
    url: row.url,
    events: decodeEvents(row.eventsJson),
    ...(row.description === null ? {} : { description: row.description }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicDelivery(row: DeliveryRow): CloudWebhookDelivery {
  const payload = decodePayload(row.payloadJson);
  return {
    id: row.deliveryId,
    endpointId: row.endpointId,
    eventId: row.eventId,
    type: row.type,
    status: row.status,
    attempt: row.attempt,
    ...(row.httpStatus === null ? {} : { httpStatus: row.httpStatus }),
    ...(row.lastError === null ? {} : { lastError: row.lastError }),
    payload,
    ...(row.nextAttemptAt === null ? {} : { nextAttemptAt: row.nextAttemptAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const make = Effect.fn("CloudWebhooks.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const transport = yield* CloudWebhookTransport;
  const mutex = yield* Semaphore.make(1);

  const readOwned = (principalId: string, endpointId: string) =>
    sql<EndpointRow>`
      SELECT endpoint_id AS "endpointId", principal_id AS "principalId", url, secret,
             events_json AS "eventsJson", description, created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM cloud_webhook_endpoints
      WHERE principal_id = ${principalId} AND endpoint_id = ${endpointId}
    `;

  const requireOwned = Effect.fn("CloudWebhooks.requireOwned")(function* (
    principalId: string,
    endpointId: string,
  ) {
    const row = (yield* readOwned(principalId, endpointId).pipe(
      Effect.mapError(persistenceFailure),
    ))[0];
    if (row === undefined) return yield* Effect.fail(missing(endpointId));
    return row;
  });

  const readDelivery = (principalId: string, deliveryId: string) =>
    sql<DeliveryRow>`
      SELECT delivery_id AS "deliveryId", endpoint_id AS "endpointId",
             principal_id AS "principalId", event_id AS "eventId", type, status,
             attempt, http_status AS "httpStatus", last_error AS "lastError",
             payload_json AS "payloadJson", next_attempt_at AS "nextAttemptAt",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM cloud_webhook_deliveries
      WHERE principal_id = ${principalId} AND delivery_id = ${deliveryId}
    `;

  const attemptDelivery = Effect.fn("CloudWebhooks.attemptDelivery")(function* (
    row: DeliveryRow,
    nowMs: number,
  ) {
    const endpoint = (yield* sql<EndpointRow>`
      SELECT endpoint_id AS "endpointId", principal_id AS "principalId", url, secret,
             events_json AS "eventsJson", description, created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM cloud_webhook_endpoints
      WHERE endpoint_id = ${row.endpointId}
    `.pipe(Effect.orElseSucceed(() => [])))[0];
    if (endpoint === undefined) {
      yield* sql`
        UPDATE cloud_webhook_deliveries
        SET status = 'dead_letter', last_error = 'Endpoint removed.', updated_at = ${nowIso(nowMs)}
        WHERE delivery_id = ${row.deliveryId}
      `.pipe(Effect.ignore);
      return;
    }
    const timestampSeconds = Math.floor(nowMs / 1000);
    const signature = signCloudWebhook({
      secret: endpoint.secret,
      timestampSeconds,
      body: row.payloadJson,
    });
    const headers = cloudWebhookRequestHeaders({
      signature,
      timestampSeconds,
      deliveryId: row.deliveryId,
      eventId: row.eventId,
    });
    const result = yield* transport
      .post({ url: endpoint.url, headers, body: row.payloadJson })
      .pipe(Effect.result);
    const attempt = row.attempt;
    const updatedAt = nowIso(nowMs);
    if (Result.isSuccess(result) && result.success.status >= 200 && result.success.status < 300) {
      yield* sql`
        UPDATE cloud_webhook_deliveries
        SET status = 'delivered', attempt = ${attempt}, http_status = ${result.success.status},
            last_error = NULL, next_attempt_at = NULL, updated_at = ${updatedAt}
        WHERE delivery_id = ${row.deliveryId}
      `.pipe(Effect.ignore);
      return;
    }
    const message = Result.isSuccess(result)
      ? `HTTP ${String(result.success.status)}`
      : result.failure.message;
    const httpStatus = Result.isSuccess(result) ? result.success.status : null;
    const delay = nextCloudWebhookRetryDelayMs(attempt);
    if (delay === undefined) {
      yield* sql`
        UPDATE cloud_webhook_deliveries
        SET status = 'dead_letter', attempt = ${attempt}, http_status = ${httpStatus},
            last_error = ${message}, next_attempt_at = NULL, updated_at = ${updatedAt}
        WHERE delivery_id = ${row.deliveryId}
      `.pipe(Effect.ignore);
      return;
    }
    yield* sql`
      UPDATE cloud_webhook_deliveries
      SET status = 'failed', attempt = ${attempt + 1}, http_status = ${httpStatus},
          last_error = ${message}, next_attempt_at = ${nowIso(nowMs + delay)},
          updated_at = ${updatedAt}
      WHERE delivery_id = ${row.deliveryId}
    `.pipe(Effect.ignore);
  });

  const create: CloudWebhooks["Service"]["create"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const invalid = validateCloudWebhookUrl(input.url);
        if (invalid !== undefined) return yield* Effect.fail(apiError("invalid_request", invalid));
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const endpointId = `webhook-${NodeCrypto.randomUUID()}`;
        const secret = `whsec_${NodeCrypto.randomBytes(24).toString("hex")}`;
        const events =
          input.events === undefined || input.events.length === 0
            ? (["status", "terminal"] as const)
            : input.events;
        yield* sql`
          INSERT INTO cloud_webhook_endpoints (
            endpoint_id, principal_id, url, secret, events_json, description, created_at, updated_at
          ) VALUES (
            ${endpointId}, ${input.principal.principalId}, ${input.url}, ${secret},
            ${encodeEvents([...events])}, ${input.description ?? null}, ${createdAt}, ${createdAt}
          )
        `.pipe(Effect.mapError(persistenceFailure));
        const row = yield* requireOwned(input.principal.principalId, endpointId);
        return { endpoint: publicEndpoint(row), secret };
      }),
    );

  const list: CloudWebhooks["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<EndpointRow>`
        SELECT endpoint_id AS "endpointId", principal_id AS "principalId", url, secret,
               events_json AS "eventsJson", description, created_at AS "createdAt",
               updated_at AS "updatedAt"
        FROM cloud_webhook_endpoints
        WHERE principal_id = ${input.principal.principalId}
        ORDER BY created_at DESC
      `.pipe(Effect.mapError(persistenceFailure));
      return { items: rows.map(publicEndpoint) };
    });

  const get: CloudWebhooks["Service"]["get"] = (input) =>
    Effect.gen(function* () {
      const row = yield* requireOwned(input.principal.principalId, input.endpointId);
      return publicEndpoint(row);
    });

  const remove: CloudWebhooks["Service"]["remove"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireOwned(input.principal.principalId, input.endpointId);
        yield* sql`
          DELETE FROM cloud_webhook_endpoints
          WHERE principal_id = ${input.principal.principalId} AND endpoint_id = ${input.endpointId}
        `.pipe(Effect.mapError(persistenceFailure));
        return { id: input.endpointId };
      }),
    );

  const listDeliveries: CloudWebhooks["Service"]["listDeliveries"] = (input) =>
    Effect.gen(function* () {
      yield* requireOwned(input.principal.principalId, input.endpointId);
      const rows = yield* sql<DeliveryRow>`
        SELECT delivery_id AS "deliveryId", endpoint_id AS "endpointId",
               principal_id AS "principalId", event_id AS "eventId", type, status,
               attempt, http_status AS "httpStatus", last_error AS "lastError",
               payload_json AS "payloadJson", next_attempt_at AS "nextAttemptAt",
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM cloud_webhook_deliveries
        WHERE principal_id = ${input.principal.principalId} AND endpoint_id = ${input.endpointId}
        ORDER BY created_at DESC
        LIMIT ${input.limit}
      `.pipe(Effect.mapError(persistenceFailure));
      return { items: rows.map(publicDelivery) };
    });

  const listDeadLetters: CloudWebhooks["Service"]["listDeadLetters"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<DeliveryRow>`
        SELECT delivery_id AS "deliveryId", endpoint_id AS "endpointId",
               principal_id AS "principalId", event_id AS "eventId", type, status,
               attempt, http_status AS "httpStatus", last_error AS "lastError",
               payload_json AS "payloadJson", next_attempt_at AS "nextAttemptAt",
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM cloud_webhook_deliveries
        WHERE principal_id = ${input.principal.principalId} AND status = 'dead_letter'
        ORDER BY updated_at DESC
        LIMIT ${input.limit}
      `.pipe(Effect.mapError(persistenceFailure));
      return { items: rows.map(publicDelivery) };
    });

  const redeliver: CloudWebhooks["Service"]["redeliver"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const row = (yield* readDelivery(input.principal.principalId, input.deliveryId).pipe(
          Effect.mapError(persistenceFailure),
        ))[0];
        if (row === undefined) {
          return yield* Effect.fail(
            apiError("webhook_not_found", `Delivery '${input.deliveryId}' was not found.`),
          );
        }
        const nowMs = DateTime.toEpochMillis(DateTime.nowUnsafe());
        yield* sql`
          UPDATE cloud_webhook_deliveries
          SET status = 'pending', attempt = 1, next_attempt_at = ${nowIso(nowMs)},
              last_error = NULL, updated_at = ${nowIso(nowMs)}
          WHERE delivery_id = ${row.deliveryId}
        `.pipe(Effect.mapError(persistenceFailure));
        const pending = {
          ...row,
          status: "pending" as const,
          attempt: 1,
          nextAttemptAt: nowIso(nowMs),
        };
        yield* attemptDelivery(pending, nowMs);
        const refreshed = (yield* readDelivery(input.principal.principalId, input.deliveryId).pipe(
          Effect.mapError(persistenceFailure),
        ))[0];
        return publicDelivery(refreshed ?? pending);
      }),
    );

  const publish: CloudWebhooks["Service"]["publish"] = (input) =>
    mutex
      .withPermits(1)(
        Effect.gen(function* () {
          const endpoints = yield* sql<EndpointRow>`
          SELECT endpoint_id AS "endpointId", principal_id AS "principalId", url, secret,
                 events_json AS "eventsJson", description, created_at AS "createdAt",
                 updated_at AS "updatedAt"
          FROM cloud_webhook_endpoints
          WHERE principal_id = ${input.principalId}
        `.pipe(Effect.orElseSucceed(() => []));
          if (endpoints.length === 0) return;
          const createdAt = nowIso(input.nowMs);
          const eventId = `evt-${NodeCrypto.randomUUID()}`;
          for (const endpoint of endpoints) {
            const subscribed = decodeEvents(endpoint.eventsJson);
            if (!subscribed.includes(input.type)) continue;
            const deliveryId = `dlv-${NodeCrypto.randomUUID()}`;
            const payload: CloudWebhookPayload = {
              eventId,
              deliveryId,
              type: input.type,
              apiVersion: CLOUD_AGENTS_API_CONTRACT_VERSION,
              createdAt,
              agentId: input.agentId,
              runId: input.runId,
              runStatus: input.runStatus,
              ...(input.agentStatus === undefined ? {} : { agentStatus: input.agentStatus }),
            };
            const payloadJson = encodePayload(payload);
            yield* sql`
            INSERT INTO cloud_webhook_deliveries (
              delivery_id, endpoint_id, principal_id, event_id, type, status, attempt,
              payload_json, next_attempt_at, created_at, updated_at
            ) VALUES (
              ${deliveryId}, ${endpoint.endpointId}, ${input.principalId}, ${eventId},
              ${input.type}, 'pending', 1, ${payloadJson}, ${createdAt}, ${createdAt}, ${createdAt}
            )
          `.pipe(Effect.ignore);
            yield* attemptDelivery(
              {
                deliveryId,
                endpointId: endpoint.endpointId,
                principalId: input.principalId,
                eventId,
                type: input.type,
                status: "pending",
                attempt: 1,
                httpStatus: null,
                lastError: null,
                payloadJson,
                nextAttemptAt: createdAt,
                createdAt,
                updatedAt: createdAt,
              },
              input.nowMs,
            );
          }
        }),
      )
      .pipe(Effect.ignore);

  const reconcile: CloudWebhooks["Service"]["reconcile"] = (nowMs) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const due = yield* sql<DeliveryRow>`
          SELECT delivery_id AS "deliveryId", endpoint_id AS "endpointId",
                 principal_id AS "principalId", event_id AS "eventId", type, status,
                 attempt, http_status AS "httpStatus", last_error AS "lastError",
                 payload_json AS "payloadJson", next_attempt_at AS "nextAttemptAt",
                 created_at AS "createdAt", updated_at AS "updatedAt"
          FROM cloud_webhook_deliveries
          WHERE status IN ('pending', 'failed')
            AND next_attempt_at IS NOT NULL
            AND next_attempt_at <= ${nowIso(nowMs)}
          ORDER BY next_attempt_at ASC
        `.pipe(Effect.orElseSucceed(() => []));
        yield* Effect.forEach(due, (row) => attemptDelivery(row, nowMs), { discard: true });
      }),
    );

  yield* Effect.forkScoped(
    Effect.sync(() => DateTime.toEpochMillis(DateTime.nowUnsafe())).pipe(
      Effect.flatMap(reconcile),
      Effect.repeat(Schedule.spaced("30 seconds")),
    ),
  );

  return CloudWebhooks.of({
    create,
    list,
    get,
    remove,
    listDeliveries,
    listDeadLetters,
    redeliver,
    publish,
    reconcile,
  });
});

export const layer = Layer.effect(CloudWebhooks, make());
