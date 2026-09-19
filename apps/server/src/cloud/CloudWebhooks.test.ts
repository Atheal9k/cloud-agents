import { CloudAgentsApiPrincipal, CloudWebhookPayload } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudWebhooks from "./CloudWebhooks.ts";

const decodePosted = Schema.decodeUnknownSync(Schema.fromJsonString(CloudWebhookPayload));
const principal = Schema.decodeSync(CloudAgentsApiPrincipal)({
  principalId: "principal-webhooks",
  kind: "service_account",
  apiKeyName: "Hooks",
  createdAt: "2026-09-19T00:00:00.000Z",
});

class WebhookPosts extends Context.Service<
  WebhookPosts,
  Ref.Ref<ReadonlyArray<{ readonly url: string; readonly body: string }>>
>()("t3/cloud/CloudWebhooks.test/WebhookPosts") {}

class WebhookFailures extends Context.Service<WebhookFailures, Ref.Ref<number>>()(
  "t3/cloud/CloudWebhooks.test/WebhookFailures",
) {}

const recordingTransport = Layer.effect(
  CloudWebhooks.CloudWebhookTransport,
  Effect.gen(function* () {
    const posts = yield* WebhookPosts;
    return CloudWebhooks.CloudWebhookTransport.of({
      post: (input) =>
        Ref.update(posts, (current) => [...current, { url: input.url, body: input.body }]).pipe(
          Effect.as({ status: 200 }),
        ),
    });
  }),
);

const failingTransport = Layer.effect(
  CloudWebhooks.CloudWebhookTransport,
  Effect.gen(function* () {
    const remaining = yield* WebhookFailures;
    return CloudWebhooks.CloudWebhookTransport.of({
      post: () =>
        Ref.get(remaining).pipe(
          Effect.flatMap((left) =>
            left > 0
              ? Ref.set(remaining, left - 1).pipe(
                  Effect.flatMap(() => Effect.fail({ message: "temporary" })),
                )
              : Effect.succeed({ status: 200 }),
          ),
        ),
    });
  }),
);

it.effect("creates signed webhook endpoints and delivers status events", () =>
  Effect.gen(function* () {
    const posts = yield* WebhookPosts;
    const webhooks = yield* CloudWebhooks.CloudWebhooks;
    const created = yield* webhooks.create({
      principal,
      url: "http://127.0.0.1:9999/hook",
      events: ["status", "terminal"],
    });
    expect(created.secret.startsWith("whsec_")).toBe(true);
    expect(created.endpoint.url).toBe("http://127.0.0.1:9999/hook");

    yield* webhooks.publish({
      principalId: principal.principalId,
      type: "status",
      agentId: "bc-1",
      runId: "run-1",
      runStatus: "CREATING",
      nowMs: Date.parse("2026-09-19T00:00:00.000Z"),
    });
    const posted = yield* Ref.get(posts);
    expect(posted).toHaveLength(1);
    expect(decodePosted(posted[0]!.body)).toMatchObject({
      type: "status",
      agentId: "bc-1",
      runId: "run-1",
      runStatus: "CREATING",
    });
    const deliveries = yield* webhooks.listDeliveries({
      principal,
      endpointId: created.endpoint.id,
      limit: 20,
    });
    expect(deliveries.items[0]?.status).toBe("delivered");
  }).pipe(
    Effect.provide(
      CloudWebhooks.layer.pipe(
        Layer.provide(recordingTransport),
        Layer.provideMerge(
          Layer.effect(
            WebhookPosts,
            Ref.make<ReadonlyArray<{ readonly url: string; readonly body: string }>>([]),
          ),
        ),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);

it.effect("retries failed deliveries then exposes dead letters and redelivery", () =>
  Effect.gen(function* () {
    const remaining = yield* WebhookFailures;
    const webhooks = yield* CloudWebhooks.CloudWebhooks;
    const created = yield* webhooks.create({
      principal,
      url: "http://127.0.0.1:9999/hook",
    });
    const start = Date.parse("2026-09-19T00:00:00.000Z");
    yield* webhooks.publish({
      principalId: principal.principalId,
      type: "terminal",
      agentId: "bc-2",
      runId: "run-2",
      runStatus: "CANCELLED",
      nowMs: start,
    });
    for (let offset = 1_000; offset <= 32_000; offset *= 2) {
      yield* webhooks.reconcile(start + offset);
    }
    const dead = yield* webhooks.listDeadLetters({ principal, limit: 20 });
    expect(dead.items).toHaveLength(1);
    expect(dead.items[0]?.status).toBe("dead_letter");
    expect(dead.items[0]?.attempt).toBe(5);

    yield* Ref.set(remaining, 0);
    const replayed = yield* webhooks.redeliver({
      principal,
      deliveryId: dead.items[0]!.id,
    });
    expect(replayed.status).toBe("delivered");
  }).pipe(
    Effect.provide(
      CloudWebhooks.layer.pipe(
        Layer.provide(failingTransport),
        Layer.provideMerge(Layer.effect(WebhookFailures, Ref.make(20))),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);
