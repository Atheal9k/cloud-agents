// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CLOUD_AUTOMATION_MISSED_RUN_GRACE_MS,
  CloudAgentAutomationDefinition,
  CloudAgentAutomationMemoryWrite,
  CloudAgentsApiPrincipal,
  type CloudAgentAutomation,
  type CloudAgentAutomationActivity,
  type CloudAgentAutomationActivityKind,
  type CloudAgentAutomationCreateRequest,
  type CloudAgentAutomationDeliveryRequest,
  type CloudAgentAutomationMemoryFact,
  type CloudAgentsApiCreateAgentRequest,
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
import { teamIdOf } from "./CloudCollaboration.ts";
import {
  automationPrompt,
  hashAutomationSecret,
  matchingAutomationTrigger,
  nextCloudAgentAutomationAt,
  serviceAccountPrincipalId,
  validateCloudAgentAutomationDefinition,
  validateCloudAgentAutomationMemory,
  verifyAutomationWebhookToken,
} from "./cloudAgentAutomationPolicy.ts";

type AutomationRow = {
  readonly automationId: string;
  readonly principalId: string;
  readonly ownerPrincipalJson: string;
  readonly actorPrincipalJson: string;
  readonly definitionJson: string;
  readonly urlOrigin: string;
  readonly status: "active" | "paused";
  readonly hookId: string | null;
  readonly webhookTokenHash: string | null;
  readonly webhookTokenPrefix: string | null;
  readonly nextRunAt: string | null;
  readonly occurrenceAt: string | null;
  readonly retryCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type ActivityRow = {
  readonly activityId: string;
  readonly automationId: string;
  readonly kind: CloudAgentAutomationActivityKind;
  readonly message: string;
  readonly scheduledFor: string;
  readonly deliveryId: string | null;
  readonly agentId: string | null;
  readonly runId: string | null;
  readonly createdAt: string;
};

type RunRow = {
  readonly automationId: string;
  readonly occurrenceAt: string;
  readonly principalJson: string;
  readonly agentId: string;
  readonly runId: string;
};

type MemoryRow = {
  readonly factId: string;
  readonly name: string;
  readonly text: string;
  readonly sourceJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

const decodeDefinition = Schema.decodeUnknownSync(
  Schema.fromJsonString(CloudAgentAutomationDefinition),
);
const encodeDefinition = Schema.encodeSync(Schema.fromJsonString(CloudAgentAutomationDefinition));
const decodePrincipal = Schema.decodeUnknownSync(Schema.fromJsonString(CloudAgentsApiPrincipal));
const encodePrincipal = Schema.encodeSync(Schema.fromJsonString(CloudAgentsApiPrincipal));
const MemorySource = Schema.Struct({
  agentId: Schema.String,
  runId: Schema.optionalKey(Schema.String),
});
const encodeMemorySource = Schema.encodeSync(Schema.fromJsonString(MemorySource));
const decodeMemorySource = Schema.decodeUnknownSync(Schema.fromJsonString(MemorySource));
const decodeMemoryWrite = Schema.decodeUnknownSync(CloudAgentAutomationMemoryWrite);

export class CloudAgentAutomations extends Context.Service<
  CloudAgentAutomations,
  {
    readonly create: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly definition: CloudAgentAutomationCreateRequest;
      readonly urlOrigin: string;
    }) => Effect.Effect<CloudAgentAutomation, CloudAgentsApiFailure>;
    readonly list: (input: {
      readonly principal: CloudAgentsApiPrincipal;
    }) => Effect.Effect<{ readonly items: ReadonlyArray<CloudAgentAutomation> }, CloudAgentsApiFailure>;
    readonly get: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly automationId: string;
    }) => Effect.Effect<CloudAgentAutomation, CloudAgentsApiFailure>;
    readonly replace: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly automationId: string;
      readonly definition: CloudAgentAutomationCreateRequest;
      readonly urlOrigin: string;
    }) => Effect.Effect<CloudAgentAutomation, CloudAgentsApiFailure>;
    readonly pause: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly automationId: string;
    }) => Effect.Effect<CloudAgentAutomation, CloudAgentsApiFailure>;
    readonly resume: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly automationId: string;
    }) => Effect.Effect<CloudAgentAutomation, CloudAgentsApiFailure>;
    readonly remove: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly automationId: string;
    }) => Effect.Effect<{ readonly id: string }, CloudAgentsApiFailure>;
    readonly deliver: (input: {
      readonly principal?: CloudAgentsApiPrincipal;
      readonly automationId?: string;
      readonly hookId?: string;
      readonly token?: string;
      readonly delivery: CloudAgentAutomationDeliveryRequest;
      readonly urlOrigin: string;
    }) => Effect.Effect<CloudAgentAutomationActivity, CloudAgentsApiFailure>;
    readonly listActivities: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly automationId?: string;
      readonly limit: number;
    }) => Effect.Effect<{ readonly items: ReadonlyArray<CloudAgentAutomationActivity> }, CloudAgentsApiFailure>;
    readonly listMemory: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly automationId: string;
    }) => Effect.Effect<{ readonly items: ReadonlyArray<CloudAgentAutomationMemoryFact> }, CloudAgentsApiFailure>;
    readonly writeMemory: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly automationId: string;
      readonly fact: CloudAgentAutomationMemoryWrite;
    }) => Effect.Effect<CloudAgentAutomationMemoryFact, CloudAgentsApiFailure>;
    readonly deleteMemory: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly automationId: string;
      readonly factId: string;
    }) => Effect.Effect<{ readonly id: string }, CloudAgentsApiFailure>;
    readonly reconcile: (nowMs: number) => Effect.Effect<void>;
  }
>()("t3/cloud/CloudAgentAutomations") {}

function withDelivery(
  activity: CloudAgentAutomationActivity,
  delivery: CloudAgentAutomationDeliveryRequest | undefined,
): CloudAgentAutomationActivity {
  if (delivery === undefined) return activity;
  return { ...activity, deliveryId: delivery.deliveryId };
}

function nowIso(nowMs = DateTime.toEpochMillis(DateTime.nowUnsafe())): string {
  return DateTime.formatIso(DateTime.makeUnsafe(nowMs));
}

function persistenceFailure(): CloudAgentsApiFailure {
  return apiError("internal_error", "The cloud automation catalog is unavailable.");
}

function missing(automationId: string): CloudAgentsApiFailure {
  return apiError("automation_not_found", `Automation '${automationId}' was not found.`);
}

function actorPrincipal(
  owner: CloudAgentsApiPrincipal,
  runAs: CloudAgentAutomationCreateRequest["runAs"],
): CloudAgentsApiPrincipal {
  if (runAs === "caller") return owner;
  if (owner.kind === "service_account") return owner;
  const teamId = teamIdOf(owner);
  return {
    principalId: serviceAccountPrincipalId(teamId),
    kind: "service_account",
    apiKeyName: "Automations",
    createdAt: owner.createdAt,
    teamId,
  };
}

function publicAutomation(
  row: AutomationRow,
  options?: { readonly webhookToken?: string },
): CloudAgentAutomation {
  const actor = decodePrincipal(row.actorPrincipalJson);
  return {
    id: row.automationId,
    status: row.status,
    definition: decodeDefinition(row.definitionJson),
    ownerPrincipalId: row.principalId,
    actorKind: actor.kind,
    actorPrincipalId: actor.principalId,
    ...(row.hookId === null || row.webhookTokenPrefix === null
      ? {}
      : {
          webhook: {
            hookId: row.hookId,
            url: `${row.urlOrigin}/v1/automation-hooks/${row.hookId}`,
            tokenPrefix: row.webhookTokenPrefix,
          },
        }),
    ...(options?.webhookToken === undefined ? {} : { webhookToken: options.webhookToken }),
    ...(row.nextRunAt === null ? {} : { nextRunAt: row.nextRunAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicActivity(row: ActivityRow): CloudAgentAutomationActivity {
  return {
    id: row.activityId,
    automationId: row.automationId,
    kind: row.kind,
    message: row.message,
    scheduledFor: row.scheduledFor,
    ...(row.deliveryId === null ? {} : { deliveryId: row.deliveryId }),
    ...(row.agentId === null ? {} : { agentId: row.agentId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    createdAt: row.createdAt,
  };
}

function publicMemory(row: MemoryRow): CloudAgentAutomationMemoryFact {
  const source = row.sourceJson === null ? undefined : decodeMemorySource(row.sourceJson);
  return {
    id: row.factId,
    name: row.name,
    text: row.text,
    ...(source === undefined ? {} : { source }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nextRunAt(definition: CloudAgentAutomationDefinition, afterMs: number): string | null {
  return nextCloudAgentAutomationAt({ definition, afterMs }) ?? null;
}

function createAgentRequest(
  definition: CloudAgentAutomationDefinition,
  prompt: { readonly text: string },
  agentId: string,
): CloudAgentsApiCreateAgentRequest {
  const repos = definition.repositories.mode === "none" ? undefined : definition.repositories.repos;
  return {
    prompt,
    agentId,
    model: definition.provider.model,
    autoCreatePR: definition.tools.createPullRequest && definition.publication === "draft_pr",
    skipReviewerRequest: !definition.tools.requestReviewers,
    ...(definition.environment === undefined ? {} : { env: definition.environment }),
    ...(repos === undefined ? {} : { repos }),
    ...(definition.tools.mcp && definition.mcpServers !== undefined
      ? { mcpServers: definition.mcpServers }
      : {}),
  };
}

export const make = Effect.fn("CloudAgentAutomations.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const api = yield* CloudAgentsApi.CloudAgentsApi;
  const mutex = yield* Semaphore.make(1);

  const readOwned = (principalId: string, automationId: string) =>
    sql<AutomationRow>`
      SELECT automation_id AS "automationId", principal_id AS "principalId",
             owner_principal_json AS "ownerPrincipalJson",
             actor_principal_json AS "actorPrincipalJson",
             definition_json AS "definitionJson", url_origin AS "urlOrigin", status,
             hook_id AS "hookId", webhook_token_hash AS "webhookTokenHash",
             webhook_token_prefix AS "webhookTokenPrefix", next_run_at AS "nextRunAt",
             occurrence_at AS "occurrenceAt", retry_count AS "retryCount",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM cloud_agent_automations
      WHERE principal_id = ${principalId} AND automation_id = ${automationId}
    `;

  const readById = (automationId: string) =>
    sql<AutomationRow>`
      SELECT automation_id AS "automationId", principal_id AS "principalId",
             owner_principal_json AS "ownerPrincipalJson",
             actor_principal_json AS "actorPrincipalJson",
             definition_json AS "definitionJson", url_origin AS "urlOrigin", status,
             hook_id AS "hookId", webhook_token_hash AS "webhookTokenHash",
             webhook_token_prefix AS "webhookTokenPrefix", next_run_at AS "nextRunAt",
             occurrence_at AS "occurrenceAt", retry_count AS "retryCount",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM cloud_agent_automations
      WHERE automation_id = ${automationId}
    `;

  const requireOwned = Effect.fn("CloudAgentAutomations.requireOwned")(function* (
    principalId: string,
    automationId: string,
  ) {
    const row = (yield* readOwned(principalId, automationId).pipe(
      Effect.mapError(persistenceFailure),
    ))[0];
    if (row === undefined) return yield* Effect.fail(missing(automationId));
    return row;
  });

  const addActivity = (input: {
    readonly automationId: string;
    readonly principalId: string;
    readonly kind: CloudAgentAutomationActivityKind;
    readonly message: string;
    readonly scheduledFor: string;
    readonly deliveryId?: string;
    readonly agentId?: string;
    readonly runId?: string;
    readonly createdAt: string;
  }) => sql`
    INSERT INTO cloud_agent_automation_activities (
      activity_id, automation_id, principal_id, kind, message, scheduled_for,
      delivery_id, agent_id, run_id, created_at
    ) VALUES (
      ${`activity-${NodeCrypto.randomUUID()}`}, ${input.automationId}, ${input.principalId},
      ${input.kind}, ${input.message}, ${input.scheduledFor},
      ${input.deliveryId ?? null}, ${input.agentId ?? null}, ${input.runId ?? null},
      ${input.createdAt}
    )
  `;

  const loadMemory = (automationId: string) =>
    sql<MemoryRow>`
      SELECT fact_id AS "factId", name, text, source_json AS "sourceJson",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM cloud_agent_automation_memories
      WHERE automation_id = ${automationId}
      ORDER BY updated_at DESC
    `.pipe(Effect.mapError(persistenceFailure));

  const mintWebhook = (definition: CloudAgentAutomationDefinition) => {
    if (!definition.triggers.some((trigger) => trigger.type === "webhook")) {
      return { hookId: null, token: null, tokenHash: null, tokenPrefix: null };
    }
    const token = `t3auto_${NodeCrypto.randomBytes(32).toString("base64url")}`;
    return {
      hookId: `hook-${NodeCrypto.randomUUID()}`,
      token,
      tokenHash: hashAutomationSecret(token),
      tokenPrefix: token.slice(0, 12),
    };
  };

  const create: CloudAgentAutomations["Service"]["create"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const invalid = validateCloudAgentAutomationDefinition(input.definition);
        if (invalid !== undefined) return yield* Effect.fail(apiError("invalid_request", invalid));
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const next = nextRunAt(input.definition, Date.parse(createdAt));
        if (
          input.definition.triggers.some((trigger) => trigger.type === "cron") &&
          next === null
        ) {
          return yield* Effect.fail(
            apiError("invalid_request", "Schedule has no occurrence in the next five years."),
          );
        }
        const automationId = `auto-${NodeCrypto.randomUUID()}`;
        const actor = actorPrincipal(input.principal, input.definition.runAs);
        const webhook = mintWebhook(input.definition);
        yield* sql`
          INSERT INTO cloud_agent_automations (
            automation_id, principal_id, owner_principal_json, actor_principal_json,
            definition_json, url_origin, status, hook_id, webhook_token_hash,
            webhook_token_prefix, next_run_at, created_at, updated_at
          ) VALUES (
            ${automationId}, ${input.principal.principalId}, ${encodePrincipal(input.principal)},
            ${encodePrincipal(actor)}, ${encodeDefinition(input.definition)}, ${input.urlOrigin},
            'active', ${webhook.hookId}, ${webhook.tokenHash}, ${webhook.tokenPrefix}, ${next},
            ${createdAt}, ${createdAt}
          )
        `.pipe(Effect.mapError(persistenceFailure));
        return publicAutomation(yield* requireOwned(input.principal.principalId, automationId), {
          ...(webhook.token === null ? {} : { webhookToken: webhook.token }),
        });
      }),
    );

  const list: CloudAgentAutomations["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<AutomationRow>`
        SELECT automation_id AS "automationId", principal_id AS "principalId",
               owner_principal_json AS "ownerPrincipalJson",
               actor_principal_json AS "actorPrincipalJson",
               definition_json AS "definitionJson", url_origin AS "urlOrigin", status,
               hook_id AS "hookId", webhook_token_hash AS "webhookTokenHash",
               webhook_token_prefix AS "webhookTokenPrefix", next_run_at AS "nextRunAt",
               occurrence_at AS "occurrenceAt", retry_count AS "retryCount",
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM cloud_agent_automations
        WHERE principal_id = ${input.principal.principalId}
        ORDER BY created_at DESC
      `.pipe(Effect.mapError(persistenceFailure));
      return { items: rows.map((row) => publicAutomation(row)) };
    });

  const get: CloudAgentAutomations["Service"]["get"] = (input) =>
    requireOwned(input.principal.principalId, input.automationId).pipe(
      Effect.map((row) => publicAutomation(row)),
    );

  const replace: CloudAgentAutomations["Service"]["replace"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* requireOwned(input.principal.principalId, input.automationId);
        const invalid = validateCloudAgentAutomationDefinition(input.definition);
        if (invalid !== undefined) return yield* Effect.fail(apiError("invalid_request", invalid));
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const next =
          existing.status === "active" ? nextRunAt(input.definition, Date.parse(updatedAt)) : null;
        const actor = actorPrincipal(input.principal, input.definition.runAs);
        const needsWebhook = input.definition.triggers.some((trigger) => trigger.type === "webhook");
        const rotate =
          needsWebhook &&
          (existing.hookId === null ||
            decodeDefinition(existing.definitionJson).runAs !== input.definition.runAs);
        const webhook = rotate
          ? mintWebhook(input.definition)
          : {
              hookId: needsWebhook ? existing.hookId : null,
              token: null,
              tokenHash: needsWebhook ? existing.webhookTokenHash : null,
              tokenPrefix: needsWebhook ? existing.webhookTokenPrefix : null,
            };
        yield* sql`
          UPDATE cloud_agent_automations
          SET definition_json = ${encodeDefinition(input.definition)},
              actor_principal_json = ${encodePrincipal(actor)},
              url_origin = ${input.urlOrigin}, next_run_at = ${next},
              occurrence_at = NULL, retry_count = 0,
              hook_id = ${webhook.hookId}, webhook_token_hash = ${webhook.tokenHash},
              webhook_token_prefix = ${webhook.tokenPrefix}, updated_at = ${updatedAt}
          WHERE principal_id = ${input.principal.principalId}
            AND automation_id = ${input.automationId}
        `.pipe(Effect.mapError(persistenceFailure));
        return publicAutomation(yield* requireOwned(input.principal.principalId, input.automationId), {
          ...(webhook.token === null ? {} : { webhookToken: webhook.token }),
        });
      }),
    );

  const setStatus =
    (target: "active" | "paused"): CloudAgentAutomations["Service"]["pause"] =>
    (input) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* requireOwned(input.principal.principalId, input.automationId);
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          const definition = decodeDefinition(existing.definitionJson);
          const next = target === "active" ? nextRunAt(definition, Date.parse(updatedAt)) : null;
          yield* sql`
            UPDATE cloud_agent_automations
            SET status = ${target}, next_run_at = ${next}, occurrence_at = NULL,
                retry_count = 0, updated_at = ${updatedAt}
            WHERE principal_id = ${input.principal.principalId}
              AND automation_id = ${input.automationId}
          `.pipe(Effect.mapError(persistenceFailure));
          return publicAutomation(
            yield* requireOwned(input.principal.principalId, input.automationId),
          );
        }),
      );

  const remove: CloudAgentAutomations["Service"]["remove"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireOwned(input.principal.principalId, input.automationId);
        yield* sql`
          DELETE FROM cloud_agent_automations
          WHERE principal_id = ${input.principal.principalId}
            AND automation_id = ${input.automationId}
        `.pipe(Effect.mapError(persistenceFailure));
        return { id: input.automationId };
      }),
    );

  const listActivities: CloudAgentAutomations["Service"]["listActivities"] = (input) =>
    Effect.gen(function* () {
      const rows =
        input.automationId === undefined
          ? yield* sql<ActivityRow>`
              SELECT activity_id AS "activityId", automation_id AS "automationId", kind,
                     message, scheduled_for AS "scheduledFor", delivery_id AS "deliveryId",
                     agent_id AS "agentId", run_id AS "runId", created_at AS "createdAt"
              FROM cloud_agent_automation_activities
              WHERE principal_id = ${input.principal.principalId}
              ORDER BY created_at DESC
              LIMIT ${input.limit}
            `
          : yield* sql<ActivityRow>`
              SELECT activity_id AS "activityId", automation_id AS "automationId", kind,
                     message, scheduled_for AS "scheduledFor", delivery_id AS "deliveryId",
                     agent_id AS "agentId", run_id AS "runId", created_at AS "createdAt"
              FROM cloud_agent_automation_activities
              WHERE principal_id = ${input.principal.principalId}
                AND automation_id = ${input.automationId}
              ORDER BY created_at DESC
              LIMIT ${input.limit}
            `;
      return { items: rows.map(publicActivity) };
    }).pipe(Effect.mapError(persistenceFailure));

  const listMemory: CloudAgentAutomations["Service"]["listMemory"] = (input) =>
    Effect.gen(function* () {
      yield* requireOwned(input.principal.principalId, input.automationId);
      return { items: (yield* loadMemory(input.automationId)).map(publicMemory) };
    });

  const writeMemory: CloudAgentAutomations["Service"]["writeMemory"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireOwned(input.principal.principalId, input.automationId);
        const fact = decodeMemoryWrite(input.fact);
        const invalid = validateCloudAgentAutomationMemory(fact);
        if (invalid !== undefined) return yield* Effect.fail(apiError("invalid_request", invalid));
        const now = DateTime.formatIso(yield* DateTime.now);
        const factId = `mem-${NodeCrypto.randomUUID()}`;
        const sourceJson = fact.source === undefined ? null : encodeMemorySource(fact.source);
        yield* sql`
          INSERT INTO cloud_agent_automation_memories (
            fact_id, automation_id, name, text, source_json, created_at, updated_at
          ) VALUES (
            ${factId}, ${input.automationId}, ${fact.name ?? "MEMORIES.md"}, ${fact.text},
            ${sourceJson}, ${now}, ${now}
          )
        `.pipe(Effect.mapError(persistenceFailure));
        const row = (yield* sql<MemoryRow>`
          SELECT fact_id AS "factId", name, text, source_json AS "sourceJson",
                 created_at AS "createdAt", updated_at AS "updatedAt"
          FROM cloud_agent_automation_memories
          WHERE fact_id = ${factId}
        `.pipe(Effect.mapError(persistenceFailure)))[0];
        if (row === undefined) return yield* Effect.fail(persistenceFailure());
        return publicMemory(row);
      }),
    );

  const deleteMemory: CloudAgentAutomations["Service"]["deleteMemory"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireOwned(input.principal.principalId, input.automationId);
        yield* sql`
          DELETE FROM cloud_agent_automation_memories
          WHERE automation_id = ${input.automationId} AND fact_id = ${input.factId}
        `.pipe(Effect.mapError(persistenceFailure));
        return { id: input.factId };
      }),
    );

  const observeRuns = Effect.fn("CloudAgentAutomations.observeRuns")(function* (now: string) {
    const runs = yield* sql<RunRow>`
      SELECT automation_id AS "automationId", occurrence_at AS "occurrenceAt",
             principal_json AS "principalJson", agent_id AS "agentId", run_id AS "runId"
      FROM cloud_agent_automation_runs
      WHERE terminal_status IS NULL
    `.pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      runs,
      (row) =>
        Effect.gen(function* () {
          const result = yield* api
            .getRun({
              principal: decodePrincipal(row.principalJson),
              agentId: row.agentId,
              runId: row.runId,
            })
            .pipe(Effect.result);
          if (Result.isFailure(result)) return;
          const status = result.success.status;
          if (status === "CREATING" || status === "RUNNING") return;
          const kind: CloudAgentAutomationActivityKind =
            status === "FINISHED" ? "completed" : status === "CANCELLED" ? "cancelled" : "failed";
          const automation = (yield* readById(row.automationId).pipe(
            Effect.orElseSucceed(() => []),
          ))[0];
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE cloud_agent_automation_runs
                SET terminal_status = ${status}, updated_at = ${now}
                WHERE automation_id = ${row.automationId} AND occurrence_at = ${row.occurrenceAt}
                  AND terminal_status IS NULL
              `;
              yield* addActivity({
                automationId: row.automationId,
                principalId: automation?.principalId ?? decodePrincipal(row.principalJson).principalId,
                kind,
                message: `Automation run ${row.runId} ended with ${status}.`,
                scheduledFor: row.occurrenceAt,
                agentId: row.agentId,
                runId: row.runId,
                createdAt: now,
              });
            }),
          );
        }).pipe(Effect.ignore),
      { discard: true },
    );
  });

  const advance = (row: AutomationRow, definition: CloudAgentAutomationDefinition, afterMs: number) =>
    sql`
      UPDATE cloud_agent_automations
      SET next_run_at = ${nextRunAt(definition, afterMs)}, occurrence_at = NULL,
          retry_count = 0, updated_at = ${nowIso(afterMs)}
      WHERE automation_id = ${row.automationId}
    `;

  const admit = Effect.fn("CloudAgentAutomations.admit")(function* (input: {
    readonly row: AutomationRow;
    readonly definition: CloudAgentAutomationDefinition;
    readonly occurrenceAt: string;
    readonly nowMs: number;
    readonly delivery: CloudAgentAutomationDeliveryRequest | undefined;
  }) {
    const actor = decodePrincipal(input.row.actorPrincipalJson);
    const pending = (
      yield* sql<RunRow>`
        SELECT automation_id AS "automationId", occurrence_at AS "occurrenceAt",
               principal_json AS "principalJson", agent_id AS "agentId", run_id AS "runId"
        FROM cloud_agent_automation_runs
        WHERE automation_id = ${input.row.automationId} AND terminal_status IS NULL
        LIMIT 1
      `.pipe(Effect.orElseSucceed(() => []))
    )[0];
    if (pending !== undefined) {
      return yield* Effect.fail(apiError("agent_busy", "The automation already has an active run."));
    }
    const memories = (yield* loadMemory(input.row.automationId)).map(publicMemory);
    const prompt = automationPrompt({
      instructions: input.definition.instructions,
      memories: input.definition.tools.memories ? memories : [],
      tools: input.definition.tools,
      ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    });
    const key = NodeCrypto.createHash("sha256")
      .update(`${input.row.automationId}:${input.occurrenceAt}`)
      .digest("hex")
      .slice(0, 24);
    const agentId = `bc-auto-${key}`;
    const limits = {
      runSeconds: input.definition.limits.runSeconds,
      inputWaitSeconds: input.definition.limits.inputWaitSeconds,
    };
    const existing = yield* api
      .getAgent({ principal: actor, agentId, urlOrigin: input.row.urlOrigin })
      .pipe(Effect.result);
    if (Result.isSuccess(existing)) {
      const runId = existing.success.latestRunId;
      if (runId === undefined) {
        return yield* Effect.fail(
          apiError("internal_error", `Automation agent '${agentId}' has no initial run.`),
        );
      }
      return { agentId, run: yield* api.getRun({ principal: actor, agentId, runId }) };
    }
    if (existing.failure.code !== "agent_not_found") return yield* Effect.fail(existing.failure);
    const response = yield* api.createAgent({
      principal: actor,
      urlOrigin: input.row.urlOrigin,
      body: createAgentRequest(input.definition, prompt, agentId),
      limits,
    });
    return { agentId: response.agent.id, run: response.run };
  });

  const finishAdmission = Effect.fn("CloudAgentAutomations.finishAdmission")(function* (input: {
    readonly row: AutomationRow;
    readonly definition: CloudAgentAutomationDefinition;
    readonly occurrenceAt: string;
    readonly nowMs: number;
    readonly delivery: CloudAgentAutomationDeliveryRequest | undefined;
  }) {
    const now = nowIso(input.nowMs);
    const admitted = yield* admit(input).pipe(Effect.result);
    if (Result.isSuccess(admitted)) {
      const agentId = admitted.success.agentId;
      const runId = admitted.success.run.id;
      const activityId = `activity-${NodeCrypto.randomUUID()}`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO cloud_agent_automation_runs (
              automation_id, occurrence_at, delivery_id, principal_id, principal_json,
              agent_id, run_id, created_at, updated_at
            ) VALUES (
              ${input.row.automationId}, ${input.occurrenceAt}, ${input.delivery?.deliveryId ?? null},
              ${input.row.principalId}, ${input.row.actorPrincipalJson},
              ${agentId}, ${runId}, ${now}, ${now}
            )
            ON CONFLICT (automation_id, occurrence_at) DO NOTHING
          `;
          yield* sql`
            INSERT INTO cloud_agent_automation_activities (
              activity_id, automation_id, principal_id, kind, message, scheduled_for,
              delivery_id, agent_id, run_id, created_at
            ) VALUES (
              ${activityId}, ${input.row.automationId}, ${input.row.principalId}, 'triggered',
              ${`Automation run ${runId} was admitted.`}, ${input.occurrenceAt},
              ${input.delivery?.deliveryId ?? null}, ${agentId}, ${runId}, ${now}
            )
          `;
          yield* advance(input.row, input.definition, Math.max(input.nowMs, Date.parse(input.occurrenceAt)));
        }),
      ).pipe(Effect.mapError(persistenceFailure));
      return withDelivery(
        {
          id: activityId,
          automationId: input.row.automationId,
          kind: "triggered",
          message: `Automation run ${runId} was admitted.`,
          scheduledFor: input.occurrenceAt,
          agentId,
          runId,
          createdAt: now,
        },
        input.delivery,
      );
    }

    const failure = admitted.failure;
    if (failure.code === "agent_busy" || failure.code === "spend_limit_exceeded") {
      const kind = failure.code === "agent_busy" ? "skipped_overlap" : "failed";
      const activityId = `activity-${NodeCrypto.randomUUID()}`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO cloud_agent_automation_activities (
              activity_id, automation_id, principal_id, kind, message, scheduled_for,
              delivery_id, created_at
            ) VALUES (
              ${activityId}, ${input.row.automationId}, ${input.row.principalId}, ${kind},
              ${failure.message}, ${input.occurrenceAt}, ${input.delivery?.deliveryId ?? null}, ${now}
            )
          `;
          yield* advance(input.row, input.definition, input.nowMs);
        }),
      ).pipe(Effect.mapError(persistenceFailure));
      return withDelivery(
        {
          id: activityId,
          automationId: input.row.automationId,
          kind,
          message: failure.message,
          scheduledFor: input.occurrenceAt,
          createdAt: now,
        },
        input.delivery,
      );
    }

    const attempt = input.row.retryCount + 1;
    if (attempt < input.definition.limits.maxAttempts) {
      const retryAt = nowIso(input.nowMs + input.definition.limits.retryDelaySeconds * 1_000);
      const activityId = `activity-${NodeCrypto.randomUUID()}`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE cloud_agent_automations
            SET next_run_at = ${retryAt}, occurrence_at = ${input.occurrenceAt},
                retry_count = ${attempt}, updated_at = ${now}
            WHERE automation_id = ${input.row.automationId}
          `;
          yield* sql`
            INSERT INTO cloud_agent_automation_activities (
              activity_id, automation_id, principal_id, kind, message, scheduled_for,
              delivery_id, created_at
            ) VALUES (
              ${activityId}, ${input.row.automationId}, ${input.row.principalId}, 'retry_scheduled',
              ${`Admission failed with ${failure.code}; retry ${attempt + 1} is scheduled.`},
              ${input.occurrenceAt}, ${input.delivery?.deliveryId ?? null}, ${now}
            )
          `;
        }),
      ).pipe(Effect.mapError(persistenceFailure));
      return withDelivery(
        {
          id: activityId,
          automationId: input.row.automationId,
          kind: "retry_scheduled",
          message: `Admission failed with ${failure.code}; retry ${attempt + 1} is scheduled.`,
          scheduledFor: input.occurrenceAt,
          createdAt: now,
        },
        input.delivery,
      );
    }

    const activityId = `activity-${NodeCrypto.randomUUID()}`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* addActivity({
          automationId: input.row.automationId,
          principalId: input.row.principalId,
          kind: "failed",
          message: `Admission stopped after ${attempt} attempts with ${failure.code}.`,
          scheduledFor: input.occurrenceAt,
          ...(input.delivery === undefined ? {} : { deliveryId: input.delivery.deliveryId }),
          createdAt: now,
        });
        yield* advance(input.row, input.definition, input.nowMs);
      }),
    ).pipe(Effect.mapError(persistenceFailure));
    return withDelivery(
      {
        id: activityId,
        automationId: input.row.automationId,
        kind: "failed",
        message: `Admission stopped after ${attempt} attempts with ${failure.code}.`,
        scheduledFor: input.occurrenceAt,
        createdAt: now,
      },
      input.delivery,
    );
  });

  const triggerDue = Effect.fn("CloudAgentAutomations.triggerDue")(function* (
    row: AutomationRow,
    nowMs: number,
  ) {
    const definition = decodeDefinition(row.definitionJson);
    const occurrenceAt = row.occurrenceAt ?? row.nextRunAt;
    if (occurrenceAt === null) return;
    const occurrenceMs = Date.parse(occurrenceAt);
    if (
      row.occurrenceAt === null &&
      definition.missedRunPolicy === "skip" &&
      occurrenceMs < nowMs - CLOUD_AUTOMATION_MISSED_RUN_GRACE_MS
    ) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* addActivity({
            automationId: row.automationId,
            principalId: row.principalId,
            kind: "missed",
            message: "The controller was offline for this occurrence, so the automation skipped it.",
            scheduledFor: occurrenceAt,
            createdAt: nowIso(nowMs),
          });
          yield* advance(row, definition, nowMs);
        }),
      );
      return;
    }
    yield* sql`
      UPDATE cloud_agent_automations
      SET next_run_at = NULL, occurrence_at = ${occurrenceAt}, updated_at = ${nowIso(nowMs)}
      WHERE automation_id = ${row.automationId}
    `;
    yield* finishAdmission({
      row: { ...row, occurrenceAt },
      definition,
      occurrenceAt,
      nowMs,
      delivery: undefined,
    });
  });

  const deliver: CloudAgentAutomations["Service"]["deliver"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const row =
          input.hookId !== undefined
            ? (
                yield* sql<AutomationRow>`
                  SELECT automation_id AS "automationId", principal_id AS "principalId",
                         owner_principal_json AS "ownerPrincipalJson",
                         actor_principal_json AS "actorPrincipalJson",
                         definition_json AS "definitionJson", url_origin AS "urlOrigin", status,
                         hook_id AS "hookId", webhook_token_hash AS "webhookTokenHash",
                         webhook_token_prefix AS "webhookTokenPrefix", next_run_at AS "nextRunAt",
                         occurrence_at AS "occurrenceAt", retry_count AS "retryCount",
                         created_at AS "createdAt", updated_at AS "updatedAt"
                  FROM cloud_agent_automations
                  WHERE hook_id = ${input.hookId}
                `.pipe(Effect.mapError(persistenceFailure))
              )[0]
            : input.automationId === undefined
              ? undefined
              : input.principal === undefined
                ? (yield* readById(input.automationId).pipe(Effect.mapError(persistenceFailure)))[0]
                : yield* requireOwned(input.principal.principalId, input.automationId);
        if (row === undefined) {
          return yield* Effect.fail(missing(input.automationId ?? input.hookId ?? "unknown"));
        }
        if (input.hookId !== undefined) {
          if (
            row.webhookTokenHash === null ||
            input.token === undefined ||
            !verifyAutomationWebhookToken({ tokenHash: row.webhookTokenHash, token: input.token })
          ) {
            return yield* Effect.fail(apiError("unauthorized", "The automation webhook token is invalid."));
          }
        }
        const definition = decodeDefinition(row.definitionJson);
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const now = nowIso(nowMs);
        if (row.status !== "active") {
          return yield* Effect.fail(
            apiError("invalid_request", "Paused automations do not accept deliveries."),
          );
        }
        if (matchingAutomationTrigger(definition, input.delivery) === undefined) {
          const activityId = `activity-${NodeCrypto.randomUUID()}`;
          yield* sql`
            INSERT INTO cloud_agent_automation_activities (
              activity_id, automation_id, principal_id, kind, message, scheduled_for,
              delivery_id, created_at
            ) VALUES (
              ${activityId}, ${row.automationId}, ${row.principalId}, 'skipped_unmatched',
              ${"The delivery did not match an enabled trigger."}, ${now},
              ${input.delivery.deliveryId}, ${now}
            )
          `.pipe(Effect.mapError(persistenceFailure));
          return {
            id: activityId,
            automationId: row.automationId,
            kind: "skipped_unmatched",
            message: "The delivery did not match an enabled trigger.",
            scheduledFor: now,
            deliveryId: input.delivery.deliveryId,
            createdAt: now,
          } satisfies CloudAgentAutomationActivity;
        }
        const existing = (
          yield* sql<ActivityRow>`
            SELECT activity_id AS "activityId", automation_id AS "automationId", kind,
                   message, scheduled_for AS "scheduledFor", delivery_id AS "deliveryId",
                   agent_id AS "agentId", run_id AS "runId", created_at AS "createdAt"
            FROM cloud_agent_automation_activities
            WHERE automation_id = ${row.automationId}
              AND delivery_id = ${input.delivery.deliveryId}
            ORDER BY created_at ASC
            LIMIT 1
          `.pipe(Effect.orElseSucceed(() => []))
        )[0];
        if (existing !== undefined) {
          const published = publicActivity(existing);
          return {
            id: published.id,
            automationId: published.automationId,
            kind: existing.kind === "triggered" ? "deduplicated" : published.kind,
            message:
              existing.kind === "triggered"
                ? `Delivery ${input.delivery.deliveryId} was already admitted.`
                : published.message,
            scheduledFor: published.scheduledFor,
            createdAt: published.createdAt,
            ...(published.deliveryId === undefined ? {} : { deliveryId: published.deliveryId }),
            ...(published.agentId === undefined ? {} : { agentId: published.agentId }),
            ...(published.runId === undefined ? {} : { runId: published.runId }),
          } satisfies CloudAgentAutomationActivity;
        }
        const occurrenceAt = input.delivery.occurredAt ?? now;
        yield* sql`
          UPDATE cloud_agent_automations
          SET occurrence_at = ${occurrenceAt}, updated_at = ${now}
          WHERE automation_id = ${row.automationId}
        `.pipe(Effect.mapError(persistenceFailure));
        return yield* finishAdmission({
          row: { ...row, occurrenceAt },
          definition,
          occurrenceAt,
          nowMs,
          delivery: input.delivery,
        });
      }).pipe(
        Effect.mapError((error) =>
          error instanceof CloudAgentsApiFailure ? error : persistenceFailure(),
        ),
      ),
    );

  const reconcile: CloudAgentAutomations["Service"]["reconcile"] = (nowMs) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const now = nowIso(nowMs);
        yield* observeRuns(now);
        const due = yield* sql<AutomationRow>`
          SELECT automation_id AS "automationId", principal_id AS "principalId",
                 owner_principal_json AS "ownerPrincipalJson",
                 actor_principal_json AS "actorPrincipalJson",
                 definition_json AS "definitionJson", url_origin AS "urlOrigin", status,
                 hook_id AS "hookId", webhook_token_hash AS "webhookTokenHash",
                 webhook_token_prefix AS "webhookTokenPrefix", next_run_at AS "nextRunAt",
                 occurrence_at AS "occurrenceAt", retry_count AS "retryCount",
                 created_at AS "createdAt", updated_at AS "updatedAt"
          FROM cloud_agent_automations
          WHERE status = 'active' AND next_run_at <= ${now}
          ORDER BY next_run_at ASC
        `.pipe(Effect.orElseSucceed(() => []));
        yield* Effect.forEach(due, (row) => triggerDue(row, nowMs).pipe(Effect.ignore), {
          discard: true,
        });
      }),
    );

  const service = CloudAgentAutomations.of({
    create,
    list,
    get,
    replace,
    pause: setStatus("paused"),
    resume: setStatus("active"),
    remove,
    deliver,
    listActivities,
    listMemory,
    writeMemory,
    deleteMemory,
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

export const layer = Layer.effect(CloudAgentAutomations, make());
