// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CLOUD_AGENT_CI_AUTOFIX_REPAIR_CAP,
  CLOUD_AGENT_SUBSCRIPTION_COALESCE_WINDOW_MS,
  CLOUD_AGENT_SUBSCRIPTION_MAX_ATTEMPTS,
  CLOUD_AGENT_SUBSCRIPTION_RETRY_DELAY_MS,
  CLOUD_AGENT_SUBSCRIPTION_WAKE_MAX_DAYS,
  CloudAgentsApiPrincipal,
  CloudAgentsApiPrompt,
  CloudAgentSubscriptionTarget,
  type CloudAgentSubscription,
  type CloudAgentSubscriptionCreateRequest,
  type CloudAgentSubscriptionDeliveryRequest,
  type CloudAgentSubscriptionReceipt,
  type CloudAgentSubscriptionReceiptKind,
  type CloudAgentSubscriptionStatus,
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

import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import { CloudAgentsApiFailure, apiError } from "./cloudAgentsApiModel.ts";
import { nextCloudAgentScheduleAt, parseCloudAgentCron } from "./cloudAgentSchedulePolicy.ts";
import { parseCloudRepositoryUrl } from "./cloudCollaborationPolicy.ts";
import {
  ciAutofixSkipMessage,
  evaluateCiAutofix,
  isSubscriptionWakeExpired,
  shouldCoalesceSubscriptionBurst,
  validateCloudAgentSubscriptionRequest,
} from "./cloudAgentSubscriptionPolicy.ts";

type SubscriptionRow = {
  readonly subscriptionId: string;
  readonly principalId: string;
  readonly principalJson: string;
  readonly agentId: string;
  readonly urlOrigin: string;
  readonly kind: CloudAgentSubscription["kind"];
  readonly targetJson: string;
  readonly promptJson: string | null;
  readonly status: CloudAgentSubscriptionStatus;
  readonly disabledReason: string | null;
  readonly coalesceWindowMs: number;
  readonly wakeMaxDays: number;
  readonly repairCount: number;
  readonly nextFireAt: string | null;
  readonly lastDeliveryAt: string | null;
  readonly lastRunId: string | null;
  readonly retryDeliveryId: string | null;
  readonly retryCount: number;
  readonly retryAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt: string | null;
  readonly disabledAt: string | null;
};

type DeliveryRow = {
  readonly subscriptionId: string;
  readonly deliveryId: string;
  readonly status: string;
  readonly acknowledged: number;
  readonly receiptId: string;
  readonly runId: string | null;
  readonly message: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type ReceiptRow = {
  readonly receiptId: string;
  readonly subscriptionId: string;
  readonly deliveryId: string;
  readonly kind: CloudAgentSubscriptionReceiptKind;
  readonly acknowledged: number;
  readonly message: string;
  readonly agentId: string;
  readonly runId: string | null;
  readonly createdAt: string;
};

const decodeTarget = Schema.decodeUnknownSync(Schema.fromJsonString(CloudAgentSubscriptionTarget));
const encodeTarget = Schema.encodeSync(Schema.fromJsonString(CloudAgentSubscriptionTarget));
const decodePrompt = Schema.decodeUnknownSync(Schema.fromJsonString(CloudAgentsApiPrompt));
const encodePrompt = Schema.encodeSync(Schema.fromJsonString(CloudAgentsApiPrompt));
const decodePrincipal = Schema.decodeUnknownSync(Schema.fromJsonString(CloudAgentsApiPrincipal));
const encodePrincipal = Schema.encodeSync(Schema.fromJsonString(CloudAgentsApiPrincipal));

export class CloudAgentSubscriptions extends Context.Service<
  CloudAgentSubscriptions,
  {
    readonly create: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly definition: CloudAgentSubscriptionCreateRequest;
      readonly urlOrigin: string;
    }) => Effect.Effect<CloudAgentSubscription, CloudAgentsApiFailure>;
    readonly list: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly urlOrigin: string;
    }) => Effect.Effect<{ readonly items: ReadonlyArray<CloudAgentSubscription> }, CloudAgentsApiFailure>;
    readonly get: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly subscriptionId: string;
      readonly urlOrigin: string;
    }) => Effect.Effect<CloudAgentSubscription, CloudAgentsApiFailure>;
    readonly remove: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly subscriptionId: string;
      readonly urlOrigin: string;
    }) => Effect.Effect<{ readonly id: string }, CloudAgentsApiFailure>;
    readonly deliver: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly subscriptionId: string;
      readonly urlOrigin: string;
      readonly delivery: CloudAgentSubscriptionDeliveryRequest;
    }) => Effect.Effect<CloudAgentSubscriptionReceipt, CloudAgentsApiFailure>;
    readonly listReceipts: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly subscriptionId: string;
      readonly limit: number;
    }) => Effect.Effect<{ readonly items: ReadonlyArray<CloudAgentSubscriptionReceipt> }, CloudAgentsApiFailure>;
    readonly reconcile: (nowMs: number) => Effect.Effect<void>;
  }
>()("t3/cloud/CloudAgentSubscriptions") {}

function persistenceFailure(): CloudAgentsApiFailure {
  return apiError("internal_error", "The cloud subscription catalog is unavailable.");
}

function missing(subscriptionId: string): CloudAgentsApiFailure {
  return apiError("subscription_not_found", `Subscription '${subscriptionId}' was not found.`);
}

function nowIso(nowMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(nowMs));
}

function publicSubscription(row: SubscriptionRow): CloudAgentSubscription {
  return {
    id: row.subscriptionId,
    agentId: row.agentId,
    status: row.status,
    kind: row.kind,
    target: decodeTarget(row.targetJson),
    ...(row.promptJson === null ? {} : { prompt: decodePrompt(row.promptJson) }),
    coalesceWindowMs: row.coalesceWindowMs,
    wakeMaxDays: row.wakeMaxDays,
    repairCount: row.repairCount,
    ...(row.nextFireAt === null ? {} : { nextFireAt: row.nextFireAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.cancelledAt === null ? {} : { cancelledAt: row.cancelledAt }),
    ...(row.disabledAt === null ? {} : { disabledAt: row.disabledAt }),
  };
}

function publicReceipt(row: ReceiptRow): CloudAgentSubscriptionReceipt {
  return {
    id: row.receiptId,
    subscriptionId: row.subscriptionId,
    deliveryId: row.deliveryId,
    kind: row.kind,
    acknowledged: row.acknowledged === 1,
    message: row.message,
    agentId: row.agentId,
    ...(row.runId === null ? {} : { runId: row.runId }),
    createdAt: row.createdAt,
  };
}

function nextFireAt(
  definition: CloudAgentSubscriptionCreateRequest,
  afterMs: number,
): string | null {
  if (definition.target.type === "timer") return definition.target.runAt;
  if (definition.target.type !== "loop") return null;
  const parsed = parseCloudAgentCron(definition.target.cron);
  if (!parsed.ok) return null;
  return (
    nextCloudAgentScheduleAt({
      cron: parsed.cron,
      timezone: definition.target.timezone,
      afterMs,
    }) ?? null
  );
}

function defaultPrompt(
  definition: CloudAgentSubscriptionCreateRequest,
): { text: string } | undefined {
  if (definition.prompt !== undefined) return definition.prompt;
  if (definition.target.type === "github_pr") {
    return {
      text: `Address new activity on pull request #${definition.target.pullRequest} in ${definition.target.repository}.`,
    };
  }
  if (definition.target.type === "github_ci") {
    return {
      text: `Repair failing CI on the agent-created pull request #${definition.target.pullRequest} in ${definition.target.repository}.`,
    };
  }
  return undefined;
}

export const make = Effect.fn("CloudAgentSubscriptions.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const api = yield* CloudAgentsApi.CloudAgentsApi;
  const mutex = yield* Semaphore.make(1);

  const selectOwned = (principalId: string, agentId: string, subscriptionId: string) => sql<SubscriptionRow>`
    SELECT subscription_id AS "subscriptionId", principal_id AS "principalId",
           principal_json AS "principalJson", agent_id AS "agentId",
           url_origin AS "urlOrigin", kind,
           target_json AS "targetJson", prompt_json AS "promptJson", status,
           disabled_reason AS "disabledReason", coalesce_window_ms AS "coalesceWindowMs",
           wake_max_days AS "wakeMaxDays", repair_count AS "repairCount",
           next_fire_at AS "nextFireAt", last_delivery_at AS "lastDeliveryAt",
           last_run_id AS "lastRunId", retry_delivery_id AS "retryDeliveryId",
           retry_count AS "retryCount", retry_at AS "retryAt",
           created_at AS "createdAt", updated_at AS "updatedAt",
           cancelled_at AS "cancelledAt", disabled_at AS "disabledAt"
    FROM cloud_agent_subscriptions
    WHERE principal_id = ${principalId} AND agent_id = ${agentId}
      AND subscription_id = ${subscriptionId}
  `;

  const requireOwned = Effect.fn("CloudAgentSubscriptions.requireOwned")(function* (
    principalId: string,
    agentId: string,
    subscriptionId: string,
  ) {
    const row = (yield* selectOwned(principalId, agentId, subscriptionId).pipe(
      Effect.mapError(persistenceFailure),
    ))[0];
    if (row === undefined) return yield* Effect.fail(missing(subscriptionId));
    return row;
  });

  const addReceipt = (input: {
    readonly subscriptionId: string;
    readonly deliveryId: string;
    readonly kind: CloudAgentSubscriptionReceiptKind;
    readonly acknowledged: boolean;
    readonly message: string;
    readonly agentId: string;
    readonly runId?: string | undefined;
    readonly createdAt: string;
  }) => {
    const receiptId = `receipt-${NodeCrypto.randomUUID()}`;
    return sql`
      INSERT INTO cloud_agent_subscription_receipts (
        receipt_id, subscription_id, delivery_id, kind, acknowledged, message,
        agent_id, run_id, created_at
      ) VALUES (
        ${receiptId}, ${input.subscriptionId}, ${input.deliveryId}, ${input.kind},
        ${input.acknowledged ? 1 : 0}, ${input.message}, ${input.agentId},
        ${input.runId ?? null}, ${input.createdAt}
      )
    `.pipe(
      Effect.mapError(persistenceFailure),
      Effect.as({
        id: receiptId,
        subscriptionId: input.subscriptionId,
        deliveryId: input.deliveryId,
        kind: input.kind,
        acknowledged: input.acknowledged,
        message: input.message,
        agentId: input.agentId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        createdAt: input.createdAt,
      } satisfies CloudAgentSubscriptionReceipt),
    );
  };

  const upsertDelivery = (input: {
    readonly subscriptionId: string;
    readonly deliveryId: string;
    readonly status: string;
    readonly acknowledged: boolean;
    readonly receiptId: string;
    readonly runId?: string | undefined;
    readonly message: string;
    readonly now: string;
  }) => sql`
    INSERT INTO cloud_agent_subscription_deliveries (
      subscription_id, delivery_id, status, acknowledged, receipt_id, run_id,
      message, created_at, updated_at
    ) VALUES (
      ${input.subscriptionId}, ${input.deliveryId}, ${input.status},
      ${input.acknowledged ? 1 : 0}, ${input.receiptId}, ${input.runId ?? null},
      ${input.message}, ${input.now}, ${input.now}
    )
    ON CONFLICT (subscription_id, delivery_id) DO UPDATE SET
      status = excluded.status,
      acknowledged = excluded.acknowledged,
      receipt_id = excluded.receipt_id,
      run_id = excluded.run_id,
      message = excluded.message,
      updated_at = excluded.updated_at
  `.pipe(Effect.mapError(persistenceFailure));

  const syncArchive = Effect.fn("CloudAgentSubscriptions.syncArchive")(function* (
    row: SubscriptionRow,
    urlOrigin: string,
    now: string,
  ) {
    if (row.status === "cancelled") return row;
    const agent = yield* api
      .getAgent({
        principal: decodePrincipal(row.principalJson),
        agentId: row.agentId,
        urlOrigin,
      })
      .pipe(Effect.result);
    if (Result.isFailure(agent)) return row;
    if (agent.success.status === "ARCHIVED" && row.status === "active") {
      yield* sql`
        UPDATE cloud_agent_subscriptions
        SET status = 'disabled', disabled_reason = 'archive', disabled_at = ${now},
            updated_at = ${now}
        WHERE subscription_id = ${row.subscriptionId}
      `.pipe(Effect.mapError(persistenceFailure));
      return yield* requireOwned(row.principalId, row.agentId, row.subscriptionId);
    }
    if (
      agent.success.status !== "ARCHIVED" &&
      row.status === "disabled" &&
      row.disabledReason === "archive"
    ) {
      yield* sql`
        UPDATE cloud_agent_subscriptions
        SET status = 'active', disabled_reason = NULL, disabled_at = NULL, updated_at = ${now}
        WHERE subscription_id = ${row.subscriptionId}
      `.pipe(Effect.mapError(persistenceFailure));
      return yield* requireOwned(row.principalId, row.agentId, row.subscriptionId);
    }
    return row;
  });

  const create: CloudAgentSubscriptions["Service"]["create"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const invalid = validateCloudAgentSubscriptionRequest(input.definition);
        if (invalid !== undefined) return yield* Effect.fail(apiError("invalid_request", invalid));
        const agent = yield* api.getAgent({
          principal: input.principal,
          agentId: input.agentId,
          urlOrigin: input.urlOrigin,
        });
        if (agent.status === "ARCHIVED") {
          return yield* Effect.fail(
            apiError("agent_archived", `Agent '${input.agentId}' is archived.`),
          );
        }
        const target = input.definition.target;
        if (target.type === "github_pr" || target.type === "github_ci") {
          const repositories = (agent.repos ?? []).flatMap((repo) => {
            const parsed = parseCloudRepositoryUrl(repo.url);
            return parsed === undefined ? [] : [parsed.repository.toLowerCase()];
          });
          if (!repositories.includes(target.repository.toLowerCase())) {
            return yield* Effect.fail(
              apiError(
                "scm_access_denied",
                `Agent '${input.agentId}' is not configured for '${target.repository}'.`,
              ),
            );
          }
        }
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const subscriptionId = `sub-${NodeCrypto.randomUUID()}`;
        const prompt = defaultPrompt(input.definition);
        yield* sql`
          INSERT INTO cloud_agent_subscriptions (
            subscription_id, principal_id, principal_json, agent_id, url_origin, kind, target_json,
            prompt_json, status, coalesce_window_ms, wake_max_days, next_fire_at,
            created_at, updated_at
          ) VALUES (
            ${subscriptionId}, ${input.principal.principalId}, ${encodePrincipal(input.principal)},
            ${input.agentId}, ${input.urlOrigin}, ${input.definition.kind}, ${encodeTarget(input.definition.target)},
            ${prompt === undefined ? null : encodePrompt(prompt)}, 'active',
            ${input.definition.coalesceWindowMs ?? CLOUD_AGENT_SUBSCRIPTION_COALESCE_WINDOW_MS},
            ${input.definition.wakeMaxDays ?? CLOUD_AGENT_SUBSCRIPTION_WAKE_MAX_DAYS},
            ${nextFireAt(input.definition, Date.parse(createdAt))},
            ${createdAt}, ${createdAt}
          )
        `.pipe(Effect.mapError(persistenceFailure));
        return publicSubscription(
          yield* requireOwned(input.principal.principalId, input.agentId, subscriptionId),
        );
      }),
    );

  const list: CloudAgentSubscriptions["Service"]["list"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* api.getAgent({
          principal: input.principal,
          agentId: input.agentId,
          urlOrigin: input.urlOrigin,
        });
        const now = DateTime.formatIso(yield* DateTime.now);
        const rows = yield* sql<SubscriptionRow>`
          SELECT subscription_id AS "subscriptionId", principal_id AS "principalId",
                 principal_json AS "principalJson", agent_id AS "agentId",
           url_origin AS "urlOrigin", kind,
                 target_json AS "targetJson", prompt_json AS "promptJson", status,
                 disabled_reason AS "disabledReason", coalesce_window_ms AS "coalesceWindowMs",
                 wake_max_days AS "wakeMaxDays", repair_count AS "repairCount",
                 next_fire_at AS "nextFireAt", last_delivery_at AS "lastDeliveryAt",
                 last_run_id AS "lastRunId", retry_delivery_id AS "retryDeliveryId",
                 retry_count AS "retryCount", retry_at AS "retryAt",
                 created_at AS "createdAt", updated_at AS "updatedAt",
                 cancelled_at AS "cancelledAt", disabled_at AS "disabledAt"
          FROM cloud_agent_subscriptions
          WHERE principal_id = ${input.principal.principalId} AND agent_id = ${input.agentId}
          ORDER BY created_at DESC
        `.pipe(Effect.mapError(persistenceFailure));
        const synced = yield* Effect.forEach(rows, (row) => syncArchive(row, input.urlOrigin, now));
        return { items: synced.map(publicSubscription) };
      }),
    );

  const get: CloudAgentSubscriptions["Service"]["get"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const row = yield* requireOwned(
          input.principal.principalId,
          input.agentId,
          input.subscriptionId,
        );
        return publicSubscription(yield* syncArchive(row, input.urlOrigin, now));
      }),
    );

  const remove: CloudAgentSubscriptions["Service"]["remove"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* requireOwned(
          input.principal.principalId,
          input.agentId,
          input.subscriptionId,
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        if (existing.status !== "cancelled") {
          yield* sql`
            UPDATE cloud_agent_subscriptions
            SET status = 'cancelled', cancelled_at = ${now}, next_fire_at = NULL,
                retry_at = NULL, updated_at = ${now}
            WHERE subscription_id = ${input.subscriptionId}
          `.pipe(Effect.mapError(persistenceFailure));
        }
        return { id: input.subscriptionId };
      }),
    );

  const listReceipts: CloudAgentSubscriptions["Service"]["listReceipts"] = (input) =>
    Effect.gen(function* () {
      yield* requireOwned(input.principal.principalId, input.agentId, input.subscriptionId);
      const rows = yield* sql<ReceiptRow>`
        SELECT receipt_id AS "receiptId", subscription_id AS "subscriptionId",
               delivery_id AS "deliveryId", kind, acknowledged, message,
               agent_id AS "agentId", run_id AS "runId", created_at AS "createdAt"
        FROM cloud_agent_subscription_receipts
        WHERE subscription_id = ${input.subscriptionId}
        ORDER BY created_at DESC
        LIMIT ${input.limit}
      `.pipe(Effect.mapError(persistenceFailure));
      return { items: rows.map(publicReceipt) };
    });

  const admitFollowUp = Effect.fn("CloudAgentSubscriptions.admitFollowUp")(function* (input: {
    readonly row: SubscriptionRow;
    readonly urlOrigin: string;
    readonly deliveryId: string;
    readonly prompt: { readonly text: string };
    readonly nowMs: number;
    readonly incrementRepair: boolean;
  }) {
    const existing = (
      yield* sql<DeliveryRow>`
        SELECT subscription_id AS "subscriptionId", delivery_id AS "deliveryId",
               status, acknowledged, receipt_id AS "receiptId", run_id AS "runId",
               message, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM cloud_agent_subscription_deliveries
        WHERE subscription_id = ${input.row.subscriptionId} AND delivery_id = ${input.deliveryId}
      `.pipe(Effect.mapError(persistenceFailure))
    )[0];
    if (existing !== undefined && existing.status !== "retryable") {
      const receipt = (
        yield* sql<ReceiptRow>`
          SELECT receipt_id AS "receiptId", subscription_id AS "subscriptionId",
                 delivery_id AS "deliveryId", kind, acknowledged, message,
                 agent_id AS "agentId", run_id AS "runId", created_at AS "createdAt"
          FROM cloud_agent_subscription_receipts
          WHERE receipt_id = ${existing.receiptId}
        `.pipe(Effect.mapError(persistenceFailure))
      )[0];
      if (receipt !== undefined) return publicReceipt(receipt);
    }
    const principal = decodePrincipal(input.row.principalJson);
    const agent = yield* api.getAgent({
      principal,
      agentId: input.row.agentId,
      urlOrigin: input.urlOrigin,
    });
    const now = nowIso(input.nowMs);
    if (agent.status === "ARCHIVED") {
      return yield* addReceipt({
        subscriptionId: input.row.subscriptionId,
        deliveryId: input.deliveryId,
        kind: "skipped",
        acknowledged: false,
        message: "Archived agents do not receive subscription wakes.",
        agentId: input.row.agentId,
        createdAt: now,
      });
    }
    if (
      isSubscriptionWakeExpired({
        lastActivityAt: agent.updatedAt,
        nowMs: input.nowMs,
        wakeMaxDays: input.row.wakeMaxDays,
      })
    ) {
      const receipt = yield* addReceipt({
        subscriptionId: input.row.subscriptionId,
        deliveryId: input.deliveryId,
        kind: "skipped",
        acknowledged: false,
        message: `Subscription wake expired after ${input.row.wakeMaxDays} days of inactivity.`,
        agentId: input.row.agentId,
        createdAt: now,
      });
      yield* upsertDelivery({
        subscriptionId: input.row.subscriptionId,
        deliveryId: input.deliveryId,
        status: "skipped",
        acknowledged: false,
        receiptId: receipt.id,
        message: receipt.message,
        now,
      });
      return receipt;
    }
    if (
      agent.status === "ACTIVE" &&
      agent.latestRunId !== undefined &&
      shouldCoalesceSubscriptionBurst({
        previousAt: input.row.lastDeliveryAt ?? agent.updatedAt,
        nowMs: input.nowMs,
        windowMs: input.row.coalesceWindowMs,
      })
    ) {
      const receipt = yield* addReceipt({
        subscriptionId: input.row.subscriptionId,
        deliveryId: input.deliveryId,
        kind: "coalesced",
        acknowledged: true,
        message: "Burst delivery coalesced onto the active run.",
        agentId: input.row.agentId,
        runId: agent.latestRunId,
        createdAt: now,
      });
      yield* upsertDelivery({
        subscriptionId: input.row.subscriptionId,
        deliveryId: input.deliveryId,
        status: "coalesced",
        acknowledged: true,
        receiptId: receipt.id,
        runId: agent.latestRunId,
        message: receipt.message,
        now,
      });
      return receipt;
    }
    if (
      shouldCoalesceSubscriptionBurst({
        previousAt: input.row.lastDeliveryAt ?? undefined,
        nowMs: input.nowMs,
        windowMs: input.row.coalesceWindowMs,
      }) &&
      input.row.lastRunId !== null
    ) {
      const receipt = yield* addReceipt({
        subscriptionId: input.row.subscriptionId,
        deliveryId: input.deliveryId,
        kind: "coalesced",
        acknowledged: true,
        message: "Burst delivery coalesced onto the recent follow-up.",
        agentId: input.row.agentId,
        runId: input.row.lastRunId,
        createdAt: now,
      });
      yield* upsertDelivery({
        subscriptionId: input.row.subscriptionId,
        deliveryId: input.deliveryId,
        status: "coalesced",
        acknowledged: true,
        receiptId: receipt.id,
        runId: input.row.lastRunId,
        message: receipt.message,
        now,
      });
      return receipt;
    }

    const requestId = `subscription-${input.row.subscriptionId}-${input.deliveryId}`;
    const admitted = yield* api
      .createRun({
        principal,
        agentId: input.row.agentId,
        body: { prompt: input.prompt },
        requestId,
      })
      .pipe(Effect.result);

    if (Result.isFailure(admitted)) {
      const failure = admitted.failure;
      if (failure.code === "agent_busy" && agent.latestRunId !== undefined) {
        const receipt = yield* addReceipt({
          subscriptionId: input.row.subscriptionId,
          deliveryId: input.deliveryId,
          kind: "coalesced",
          acknowledged: true,
          message: "The durable agent already had an active run, so this delivery coalesced.",
          agentId: input.row.agentId,
          runId: agent.latestRunId,
          createdAt: now,
        });
        yield* upsertDelivery({
          subscriptionId: input.row.subscriptionId,
          deliveryId: input.deliveryId,
          status: "coalesced",
          acknowledged: true,
          receiptId: receipt.id,
          runId: agent.latestRunId,
          message: receipt.message,
          now,
        });
        return receipt;
      }
      const attempt = input.row.retryCount + 1;
      const retryable = attempt < CLOUD_AGENT_SUBSCRIPTION_MAX_ATTEMPTS;
      const receipt = yield* addReceipt({
        subscriptionId: input.row.subscriptionId,
        deliveryId: input.deliveryId,
        kind: retryable ? "retryable" : "failed",
        acknowledged: false,
        message: retryable
          ? `Wake/placement failed with ${failure.code}; retry ${attempt + 1} is scheduled.`
          : `Wake/placement stopped after ${attempt} attempts with ${failure.code}.`,
        agentId: input.row.agentId,
        createdAt: now,
      });
      yield* upsertDelivery({
        subscriptionId: input.row.subscriptionId,
        deliveryId: input.deliveryId,
        status: retryable ? "retryable" : "failed",
        acknowledged: false,
        receiptId: receipt.id,
        message: receipt.message,
        now,
      });
      yield* sql`
        UPDATE cloud_agent_subscriptions
        SET retry_delivery_id = ${input.deliveryId}, retry_count = ${attempt},
            retry_at = ${retryable ? nowIso(input.nowMs + CLOUD_AGENT_SUBSCRIPTION_RETRY_DELAY_MS) : null},
            updated_at = ${now}
        WHERE subscription_id = ${input.row.subscriptionId}
      `.pipe(Effect.mapError(persistenceFailure));
      return receipt;
    }

    const run = yield* api
      .getRun({ principal, agentId: input.row.agentId, runId: admitted.success.run.id })
      .pipe(Effect.result);
    if (Result.isFailure(run)) {
      const receipt = yield* addReceipt({
        subscriptionId: input.row.subscriptionId,
        deliveryId: input.deliveryId,
        kind: "retryable",
        acknowledged: false,
        message: "The follow-up was not persisted, so the delivery was not acknowledged.",
        agentId: input.row.agentId,
        createdAt: now,
      });
      yield* upsertDelivery({
        subscriptionId: input.row.subscriptionId,
        deliveryId: input.deliveryId,
        status: "retryable",
        acknowledged: false,
        receiptId: receipt.id,
        message: receipt.message,
        now,
      });
      return receipt;
    }

    const receipt = yield* addReceipt({
      subscriptionId: input.row.subscriptionId,
      deliveryId: input.deliveryId,
      kind: "persisted",
      acknowledged: true,
      message: `Follow-up ${run.success.id} was persisted.`,
      agentId: input.row.agentId,
      runId: run.success.id,
      createdAt: now,
    });
    yield* upsertDelivery({
      subscriptionId: input.row.subscriptionId,
      deliveryId: input.deliveryId,
      status: "persisted",
      acknowledged: true,
      receiptId: receipt.id,
      runId: run.success.id,
      message: receipt.message,
      now,
    });
    const next =
      input.row.kind === "loop"
        ? nextFireAt(
            {
              kind: input.row.kind,
              target: decodeTarget(input.row.targetJson),
              ...(input.row.promptJson === null ? {} : { prompt: decodePrompt(input.row.promptJson) }),
            },
            input.nowMs,
          )
        : null;
    yield* sql`
      UPDATE cloud_agent_subscriptions
      SET last_delivery_at = ${now}, last_run_id = ${run.success.id},
          retry_delivery_id = NULL, retry_count = 0, retry_at = NULL,
          next_fire_at = ${input.row.kind === "timer" ? null : next},
          repair_count = ${input.incrementRepair ? input.row.repairCount + 1 : input.row.repairCount},
          updated_at = ${now}
      WHERE subscription_id = ${input.row.subscriptionId}
    `.pipe(Effect.mapError(persistenceFailure));
    return receipt;
  });

  const deliver: CloudAgentSubscriptions["Service"]["deliver"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const now = nowIso(nowMs);
        let row = yield* requireOwned(
          input.principal.principalId,
          input.agentId,
          input.subscriptionId,
        );
        row = yield* syncArchive(row, input.urlOrigin, now);
        const existing = (
          yield* sql<DeliveryRow>`
            SELECT subscription_id AS "subscriptionId", delivery_id AS "deliveryId",
                   status, acknowledged, receipt_id AS "receiptId", run_id AS "runId",
                   message, created_at AS "createdAt", updated_at AS "updatedAt"
            FROM cloud_agent_subscription_deliveries
            WHERE subscription_id = ${row.subscriptionId} AND delivery_id = ${input.delivery.deliveryId}
          `.pipe(Effect.mapError(persistenceFailure))
        )[0];
        if (existing !== undefined && existing.status !== "retryable") {
          const receipt = (
            yield* sql<ReceiptRow>`
              SELECT receipt_id AS "receiptId", subscription_id AS "subscriptionId",
                     delivery_id AS "deliveryId", kind, acknowledged, message,
                     agent_id AS "agentId", run_id AS "runId", created_at AS "createdAt"
              FROM cloud_agent_subscription_receipts
              WHERE receipt_id = ${existing.receiptId}
            `.pipe(Effect.mapError(persistenceFailure))
          )[0];
          if (receipt !== undefined) return publicReceipt(receipt);
        }
        if (row.status === "cancelled") {
          return yield* addReceipt({
            subscriptionId: row.subscriptionId,
            deliveryId: input.delivery.deliveryId,
            kind: "skipped",
            acknowledged: false,
            message: "Cancelled subscriptions do not wake the agent.",
            agentId: row.agentId,
            createdAt: now,
          });
        }
        if (row.status === "disabled") {
          return yield* addReceipt({
            subscriptionId: row.subscriptionId,
            deliveryId: input.delivery.deliveryId,
            kind: "skipped",
            acknowledged: false,
            message: "Disabled subscriptions remain visible but do not wake the agent.",
            agentId: row.agentId,
            createdAt: now,
          });
        }
        if (row.kind === "github_ci") {
          if (input.delivery.ci === undefined) {
            return yield* Effect.fail(
              apiError("invalid_request", "github_ci deliveries require CI eligibility facts."),
            );
          }
          const decision = evaluateCiAutofix({
            facts: input.delivery.ci,
            repairCount: row.repairCount,
            repairCap: CLOUD_AGENT_CI_AUTOFIX_REPAIR_CAP,
          });
          if (!decision.eligible) {
            const receipt = yield* addReceipt({
              subscriptionId: row.subscriptionId,
              deliveryId: input.delivery.deliveryId,
              kind: "skipped",
              acknowledged: false,
              message: ciAutofixSkipMessage(decision.reason),
              agentId: row.agentId,
              createdAt: now,
            });
            yield* upsertDelivery({
              subscriptionId: row.subscriptionId,
              deliveryId: input.delivery.deliveryId,
              status: "skipped",
              acknowledged: false,
              receiptId: receipt.id,
              message: receipt.message,
              now,
            });
            return receipt;
          }
        }
        const prompt =
          input.delivery.prompt ??
          (row.promptJson === null ? undefined : decodePrompt(row.promptJson)) ??
          defaultPrompt({
            kind: row.kind,
            target: decodeTarget(row.targetJson),
          });
        if (prompt === undefined) {
          return yield* Effect.fail(apiError("invalid_request", "Delivery is missing a prompt."));
        }
        return yield* admitFollowUp({
          row,
          urlOrigin: input.urlOrigin,
          deliveryId: input.delivery.deliveryId,
          prompt,
          nowMs: input.delivery.occurredAt ? Date.parse(input.delivery.occurredAt) : nowMs,
          incrementRepair: row.kind === "github_ci",
        });
      }),
    );

  const reconcile: CloudAgentSubscriptions["Service"]["reconcile"] = (nowMs) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const now = nowIso(nowMs);
        const due = yield* sql<SubscriptionRow>`
          SELECT subscription_id AS "subscriptionId", principal_id AS "principalId",
                 principal_json AS "principalJson", agent_id AS "agentId",
           url_origin AS "urlOrigin", kind,
                 target_json AS "targetJson", prompt_json AS "promptJson", status,
                 disabled_reason AS "disabledReason", coalesce_window_ms AS "coalesceWindowMs",
                 wake_max_days AS "wakeMaxDays", repair_count AS "repairCount",
                 next_fire_at AS "nextFireAt", last_delivery_at AS "lastDeliveryAt",
                 last_run_id AS "lastRunId", retry_delivery_id AS "retryDeliveryId",
                 retry_count AS "retryCount", retry_at AS "retryAt",
                 created_at AS "createdAt", updated_at AS "updatedAt",
                 cancelled_at AS "cancelledAt", disabled_at AS "disabledAt"
          FROM cloud_agent_subscriptions
          WHERE status = 'active'
            AND (
              (next_fire_at IS NOT NULL AND next_fire_at <= ${now})
              OR (retry_at IS NOT NULL AND retry_at <= ${now})
            )
          ORDER BY COALESCE(retry_at, next_fire_at) ASC
        `.pipe(Effect.orElseSucceed(() => []));
        yield* Effect.forEach(
          due,
          (row) =>
            Effect.gen(function* () {
              const deliveryId =
                row.retryDeliveryId ??
                `timer:${row.subscriptionId}:${row.nextFireAt ?? now}`;
              const prompt =
                row.promptJson === null ? { text: "Scheduled subscription follow-up." } : decodePrompt(row.promptJson);
              yield* admitFollowUp({
                row,
                urlOrigin: row.urlOrigin,
                deliveryId,
                prompt,
                nowMs,
                incrementRepair: false,
              }).pipe(Effect.ignore);
            }),
          { discard: true },
        );
      }),
    );

  const service = CloudAgentSubscriptions.of({
    create,
    list,
    get,
    remove,
    deliver,
    listReceipts,
    reconcile,
  });

  yield* Effect.forkScoped(
    Effect.sync(() => DateTime.toEpochMillis(DateTime.nowUnsafe())).pipe(
      Effect.flatMap(reconcile),
      Effect.repeat(Schedule.spaced("30 seconds")),
    ),
  );
  return service;
});

export const layer = Layer.effect(CloudAgentSubscriptions, make());
