// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CloudAgentsApiPrincipal,
  CloudGithubTriggerDefinition,
  CloudGithubTriggerEvent,
  CloudGithubTriggerSource,
  type CloudGithubTrigger,
  type CloudGithubTriggerActivity,
  type CloudGithubTriggerActivityStatus,
  type CloudGithubTriggerCreated,
  type CloudGithubWebhookResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import { CloudAgentsApiFailure, apiError } from "./cloudAgentsApiModel.ts";
import {
  githubTriggerPrompt,
  githubTriggerSourceKey,
  parseGithubWebhook,
  verifyGithubWebhookSignature,
} from "./cloudGithubTriggerPolicy.ts";
import { parseCloudRepositoryUrl } from "./cloudCollaborationPolicy.ts";

type TriggerRow = {
  readonly triggerId: string;
  readonly principalId: string;
  readonly principalJson: string;
  readonly definitionJson: string;
  readonly urlOrigin: string;
  readonly status: "enabled" | "disabled" | "revoked";
  readonly createdAt: string;
  readonly updatedAt: string;
};

type ActivityRow = {
  readonly triggerId: string;
  readonly deliveryId: string;
  readonly principalId: string;
  readonly sourceKey: string;
  readonly sourceJson: string;
  readonly attempt: number;
  readonly reservedComputeSeconds: number;
  readonly status: CloudGithubTriggerActivityStatus;
  readonly message: string;
  readonly agentId: string | null;
  readonly runId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type BudgetRow = {
  readonly attempts: number;
  readonly reservedComputeSeconds: number;
};

const decodeDefinition = Schema.decodeUnknownSync(
  Schema.fromJsonString(CloudGithubTriggerDefinition),
);
const encodeDefinition = Schema.encodeSync(Schema.fromJsonString(CloudGithubTriggerDefinition));
const decodePrincipal = Schema.decodeUnknownSync(Schema.fromJsonString(CloudAgentsApiPrincipal));
const encodePrincipal = Schema.encodeSync(Schema.fromJsonString(CloudAgentsApiPrincipal));
const decodeSource = Schema.decodeUnknownSync(Schema.fromJsonString(CloudGithubTriggerSource));
const encodeSource = Schema.encodeSync(Schema.fromJsonString(CloudGithubTriggerSource));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownOption(CloudGithubTriggerEvent);

export class CloudGithubTriggers extends Context.Service<
  CloudGithubTriggers,
  {
    readonly create: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly definition: CloudGithubTriggerDefinition;
      readonly urlOrigin: string;
    }) => Effect.Effect<CloudGithubTriggerCreated, CloudAgentsApiFailure>;
    readonly list: (input: {
      readonly principal: CloudAgentsApiPrincipal;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<CloudGithubTrigger> },
      CloudAgentsApiFailure
    >;
    readonly get: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly triggerId: string;
    }) => Effect.Effect<CloudGithubTrigger, CloudAgentsApiFailure>;
    readonly disable: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly triggerId: string;
    }) => Effect.Effect<CloudGithubTrigger, CloudAgentsApiFailure>;
    readonly enable: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly triggerId: string;
    }) => Effect.Effect<CloudGithubTrigger, CloudAgentsApiFailure>;
    readonly remove: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly triggerId: string;
    }) => Effect.Effect<{ readonly id: string }, CloudAgentsApiFailure>;
    readonly listActivities: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly triggerId?: string | undefined;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<CloudGithubTriggerActivity> },
      CloudAgentsApiFailure
    >;
    readonly receive: (input: {
      readonly triggerId: string;
      readonly deliveryId: string;
      readonly event: string;
      readonly signature: string | undefined;
      readonly body: string;
    }) => Effect.Effect<CloudGithubWebhookResult, CloudAgentsApiFailure>;
  }
>()("t3/cloud/CloudGithubTriggers") {}

function persistenceFailure(): CloudAgentsApiFailure {
  return apiError("internal_error", "The GitHub trigger catalog is unavailable.");
}

function missing(triggerId: string): CloudAgentsApiFailure {
  return apiError("invalid_request", `GitHub trigger '${triggerId}' was not found.`);
}

function webhookUrl(row: Pick<TriggerRow, "triggerId" | "urlOrigin">): string {
  return `${row.urlOrigin.replace(/\/+$/u, "")}/v1/integrations/github/webhooks/${row.triggerId}`;
}

function publicTrigger(row: TriggerRow): CloudGithubTrigger {
  return {
    id: row.triggerId,
    status: row.status,
    definition: decodeDefinition(row.definitionJson),
    webhookUrl: webhookUrl(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicActivity(row: ActivityRow): CloudGithubTriggerActivity {
  return {
    deliveryId: row.deliveryId,
    triggerId: row.triggerId,
    source: decodeSource(row.sourceJson),
    attempt: row.attempt,
    reservedComputeSeconds: row.reservedComputeSeconds,
    status: row.status,
    message: row.message,
    ...(row.agentId === null ? {} : { agentId: row.agentId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function webhookResult(
  activity: CloudGithubTriggerActivity,
  reused: boolean,
): CloudGithubWebhookResult {
  return {
    status: activity.status,
    reused,
    message: activity.message,
    ...(activity.agentId === undefined ? {} : { agentId: activity.agentId }),
    ...(activity.runId === undefined ? {} : { runId: activity.runId }),
  };
}

function secretName(triggerId: string): string {
  return `cloud-github-trigger-${triggerId}`;
}

function validateDefinition(definition: CloudGithubTriggerDefinition): string | undefined {
  const parsed = parseCloudRepositoryUrl(`https://github.com/${definition.repository}`);
  if (
    parsed?.kind !== "github" ||
    parsed.repository.toLowerCase() !== definition.repository.toLowerCase()
  ) {
    return "repository must be a GitHub owner/name pair.";
  }
  if (definition.authorizedActors.length === 0 || definition.authorizedActors.length > 100) {
    return "authorizedActors must contain between 1 and 100 GitHub logins.";
  }
  if (
    new Set(definition.authorizedActors.map((actor) => actor.toLowerCase())).size !==
    definition.authorizedActors.length
  ) {
    return "authorizedActors cannot contain duplicates.";
  }
  if (
    definition.events.length === 0 ||
    new Set(definition.events).size !== definition.events.length
  ) {
    return "events must contain at least one unique GitHub event.";
  }
  if (definition.limits.maxAttempts > 10) return "maxAttempts may not exceed 10.";
  if (definition.limits.runSeconds > 6 * 60 * 60) return "runSeconds may not exceed 21600.";
  if (definition.limits.inputWaitSeconds > 60 * 60) {
    return "inputWaitSeconds may not exceed 3600.";
  }
  if (definition.limits.maxComputeSeconds > 24 * 60 * 60) {
    return "maxComputeSeconds may not exceed 86400.";
  }
  if (definition.limits.maxComputeSeconds < definition.limits.runSeconds) {
    return "maxComputeSeconds must cover at least one run.";
  }
  return undefined;
}

function normalizedDefinition(
  definition: CloudGithubTriggerDefinition,
): CloudGithubTriggerDefinition {
  return {
    ...definition,
    repository: definition.repository.toLowerCase(),
    authorizedActors: definition.authorizedActors.map((actor) => actor.toLowerCase()),
    events: [...definition.events],
    limits: { ...definition.limits },
  };
}

export const make = Effect.fn("CloudGithubTriggers.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const api = yield* CloudAgentsApi.CloudAgentsApi;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const mutex = yield* Semaphore.make(1);

  const readTrigger = (triggerId: string) => sql<TriggerRow>`
    SELECT trigger_id AS "triggerId", principal_id AS "principalId",
           principal_json AS "principalJson", definition_json AS "definitionJson",
           url_origin AS "urlOrigin", status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM cloud_github_triggers
    WHERE trigger_id = ${triggerId}
  `;

  const requireTrigger = Effect.fn("CloudGithubTriggers.requireTrigger")(function* (
    triggerId: string,
  ) {
    const row = (yield* readTrigger(triggerId).pipe(Effect.mapError(persistenceFailure)))[0];
    if (row === undefined) return yield* Effect.fail(missing(triggerId));
    return row;
  });

  const requireOwned = Effect.fn("CloudGithubTriggers.requireOwned")(function* (
    principalId: string,
    triggerId: string,
  ) {
    const row = yield* requireTrigger(triggerId);
    if (row.principalId !== principalId) return yield* Effect.fail(missing(triggerId));
    return row;
  });

  const readActivity = (triggerId: string, deliveryId: string) => sql<ActivityRow>`
    SELECT trigger_id AS "triggerId", delivery_id AS "deliveryId",
           principal_id AS "principalId", source_key AS "sourceKey",
           source_json AS "sourceJson", attempt,
           reserved_compute_seconds AS "reservedComputeSeconds", status, message,
           agent_id AS "agentId", run_id AS "runId",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM cloud_github_trigger_activities
    WHERE trigger_id = ${triggerId} AND delivery_id = ${deliveryId}
  `;

  const requireActivity = Effect.fn("CloudGithubTriggers.requireActivity")(function* (
    triggerId: string,
    deliveryId: string,
  ) {
    const activity = (yield* readActivity(triggerId, deliveryId).pipe(
      Effect.mapError(persistenceFailure),
    ))[0];
    if (activity === undefined) return yield* Effect.fail(persistenceFailure());
    return activity;
  });

  const addActivity = (input: {
    readonly triggerId: string;
    readonly deliveryId: string;
    readonly principalId: string;
    readonly source: CloudGithubTriggerSource;
    readonly attempt: number;
    readonly reservedComputeSeconds: number;
    readonly status: CloudGithubTriggerActivityStatus;
    readonly message: string;
    readonly agentId?: string | undefined;
    readonly runId?: string | undefined;
    readonly now: string;
  }) => sql`
    INSERT INTO cloud_github_trigger_activities (
      trigger_id, delivery_id, principal_id, source_key, source_json, attempt,
      reserved_compute_seconds, status, message, agent_id, run_id, created_at, updated_at
    ) VALUES (
      ${input.triggerId}, ${input.deliveryId}, ${input.principalId},
      ${githubTriggerSourceKey(input.source)}, ${encodeSource(input.source)}, ${input.attempt},
      ${input.reservedComputeSeconds}, ${input.status}, ${input.message},
      ${input.agentId ?? null}, ${input.runId ?? null}, ${input.now}, ${input.now}
    )
  `;

  const create: CloudGithubTriggers["Service"]["create"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const invalid = validateDefinition(input.definition);
        if (invalid !== undefined) return yield* Effect.fail(apiError("invalid_request", invalid));
        const definition = normalizedDefinition(input.definition);
        const agent = yield* api.getAgent({
          principal: input.principal,
          agentId: definition.agentId,
          urlOrigin: input.urlOrigin,
        });
        const configuredRepositories = (agent.repos ?? []).flatMap((repo) => {
          const parsed = parseCloudRepositoryUrl(repo.url);
          return parsed === undefined ? [] : [parsed.repository.toLowerCase()];
        });
        if (!configuredRepositories.includes(definition.repository)) {
          return yield* Effect.fail(
            apiError(
              "scm_access_denied",
              `Agent '${definition.agentId}' is not configured for '${definition.repository}'.`,
            ),
          );
        }

        const triggerId = `github-trigger-${NodeCrypto.randomUUID()}`;
        const secret = NodeCrypto.randomBytes(32).toString("base64url");
        yield* secrets
          .create(secretName(triggerId), Buffer.from(secret, "utf8"))
          .pipe(Effect.mapError(persistenceFailure));
        const now = DateTime.formatIso(yield* DateTime.now);
        const persisted = yield* sql`
          INSERT INTO cloud_github_triggers (
            trigger_id, principal_id, principal_json, definition_json, url_origin,
            status, created_at, updated_at
          ) VALUES (
            ${triggerId}, ${input.principal.principalId}, ${encodePrincipal(input.principal)},
            ${encodeDefinition(definition)}, ${input.urlOrigin}, 'enabled', ${now}, ${now}
          )
        `.pipe(Effect.result);
        if (Result.isFailure(persisted)) {
          yield* secrets.remove(secretName(triggerId)).pipe(Effect.ignore);
          return yield* Effect.fail(persistenceFailure());
        }
        const trigger = publicTrigger(yield* requireOwned(input.principal.principalId, triggerId));
        return { trigger, secret };
      }),
    );

  const list: CloudGithubTriggers["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<TriggerRow>`
        SELECT trigger_id AS "triggerId", principal_id AS "principalId",
               principal_json AS "principalJson", definition_json AS "definitionJson",
               url_origin AS "urlOrigin", status,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM cloud_github_triggers
        WHERE principal_id = ${input.principal.principalId}
        ORDER BY created_at DESC
      `.pipe(Effect.mapError(persistenceFailure));
      return { items: rows.map(publicTrigger) };
    });

  const get: CloudGithubTriggers["Service"]["get"] = (input) =>
    requireOwned(input.principal.principalId, input.triggerId).pipe(Effect.map(publicTrigger));

  const setStatus =
    (status: "enabled" | "disabled"): CloudGithubTriggers["Service"]["disable"] =>
    (input) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* requireOwned(input.principal.principalId, input.triggerId);
          if (existing.status === "revoked") {
            return yield* Effect.fail(
              apiError("invalid_request", "A revoked GitHub trigger cannot be changed."),
            );
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            UPDATE cloud_github_triggers
            SET status = ${status}, updated_at = ${now}
            WHERE trigger_id = ${input.triggerId}
              AND principal_id = ${input.principal.principalId}
          `.pipe(Effect.mapError(persistenceFailure));
          return publicTrigger(yield* requireOwned(input.principal.principalId, input.triggerId));
        }),
      );

  const disable = setStatus("disabled");
  const enable = setStatus("enabled");

  const remove: CloudGithubTriggers["Service"]["remove"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireOwned(input.principal.principalId, input.triggerId);
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE cloud_github_triggers
          SET status = 'revoked', updated_at = ${now}
          WHERE trigger_id = ${input.triggerId}
            AND principal_id = ${input.principal.principalId}
        `.pipe(Effect.mapError(persistenceFailure));
        yield* secrets
          .remove(secretName(input.triggerId))
          .pipe(Effect.mapError(persistenceFailure));
        return { id: input.triggerId };
      }),
    );

  const reconcileActivity = Effect.fn("CloudGithubTriggers.reconcileActivity")(function* (
    principal: CloudAgentsApiPrincipal,
    row: ActivityRow,
  ) {
    if (row.status !== "triggered" || row.agentId === null || row.runId === null) return row;
    const result = yield* api
      .getRun({ principal, agentId: row.agentId, runId: row.runId })
      .pipe(Effect.result);
    const terminal = Result.isFailure(result)
      ? { status: "unresolved" as const, message: `Triggered run ${row.runId} could not be read.` }
      : result.success.status === "FINISHED"
        ? { status: "resolved" as const, message: `Triggered run ${row.runId} finished.` }
        : ["ERROR", "CANCELLED", "EXPIRED"].includes(result.success.status)
          ? {
              status: "unresolved" as const,
              message: `Triggered run ${row.runId} ended with ${result.success.status}.`,
            }
          : undefined;
    if (terminal === undefined) return row;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE cloud_github_trigger_activities
      SET status = ${terminal.status}, message = ${terminal.message}, updated_at = ${now}
      WHERE trigger_id = ${row.triggerId} AND delivery_id = ${row.deliveryId}
    `.pipe(Effect.mapError(persistenceFailure));
    return { ...row, status: terminal.status, message: terminal.message, updatedAt: now };
  });

  const listActivities: CloudGithubTriggers["Service"]["listActivities"] = (input) =>
    Effect.gen(function* () {
      if (input.limit < 1 || input.limit > 100) {
        return yield* Effect.fail(apiError("invalid_request", "limit must be between 1 and 100."));
      }
      if (input.triggerId !== undefined) {
        yield* requireOwned(input.principal.principalId, input.triggerId);
      }
      const rows =
        input.triggerId === undefined
          ? yield* sql<ActivityRow>`
              SELECT trigger_id AS "triggerId", delivery_id AS "deliveryId",
                     principal_id AS "principalId", source_key AS "sourceKey",
                     source_json AS "sourceJson", attempt,
                     reserved_compute_seconds AS "reservedComputeSeconds", status, message,
                     agent_id AS "agentId", run_id AS "runId",
                     created_at AS "createdAt", updated_at AS "updatedAt"
              FROM cloud_github_trigger_activities
              WHERE principal_id = ${input.principal.principalId}
              ORDER BY created_at DESC
              LIMIT ${input.limit}
            `
          : yield* sql<ActivityRow>`
              SELECT trigger_id AS "triggerId", delivery_id AS "deliveryId",
                     principal_id AS "principalId", source_key AS "sourceKey",
                     source_json AS "sourceJson", attempt,
                     reserved_compute_seconds AS "reservedComputeSeconds", status, message,
                     agent_id AS "agentId", run_id AS "runId",
                     created_at AS "createdAt", updated_at AS "updatedAt"
              FROM cloud_github_trigger_activities
              WHERE principal_id = ${input.principal.principalId}
                AND trigger_id = ${input.triggerId}
              ORDER BY created_at DESC
              LIMIT ${input.limit}
            `;
      const reconciled = yield* Effect.forEach(
        rows,
        (row) => reconcileActivity(input.principal, row),
        {
          concurrency: 4,
        },
      );
      return { items: reconciled.map(publicActivity) };
    }).pipe(
      Effect.mapError((error) =>
        error instanceof CloudAgentsApiFailure ? error : persistenceFailure(),
      ),
    );

  const receive: CloudGithubTriggers["Service"]["receive"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        if (input.deliveryId.trim().length === 0) {
          return yield* Effect.fail(apiError("invalid_request", "X-GitHub-Delivery is required."));
        }
        const row = yield* requireTrigger(input.triggerId);
        const secret = yield* secrets
          .get(secretName(input.triggerId))
          .pipe(Effect.mapError(persistenceFailure));
        if (
          Option.isNone(secret) ||
          !verifyGithubWebhookSignature({
            secret: secret.value,
            body: input.body,
            signature: input.signature,
          })
        ) {
          return yield* Effect.fail(apiError("unauthorized", "Invalid GitHub webhook signature."));
        }
        const existing = (yield* readActivity(row.triggerId, input.deliveryId).pipe(
          Effect.mapError(persistenceFailure),
        ))[0];
        if (existing !== undefined) return webhookResult(publicActivity(existing), true);
        if (row.status !== "enabled") {
          return yield* Effect.fail(
            apiError("invalid_request", "This GitHub trigger is disabled."),
          );
        }
        if (input.event === "ping") {
          return {
            status: "ignored",
            reused: false,
            message: "GitHub ping accepted.",
          };
        }
        const event = Option.getOrUndefined(decodeEvent(input.event));
        if (event === undefined) {
          return yield* Effect.fail(
            apiError("invalid_request", `Unsupported GitHub event '${input.event}'.`),
          );
        }
        const payload = Option.getOrUndefined(decodeJson(input.body));
        const parsed = payload === undefined ? undefined : parseGithubWebhook(event, payload);
        if (parsed === undefined) {
          return yield* Effect.fail(apiError("invalid_request", "Invalid GitHub webhook payload."));
        }
        const definition = decodeDefinition(row.definitionJson);
        const now = DateTime.formatIso(yield* DateTime.now);
        const actor = parsed.actor.toLowerCase();
        const ignoreReason =
          parsed.repository.toLowerCase() !== definition.repository
            ? `Repository '${parsed.repository}' is not authorized for this trigger.`
            : event !== "check_run" &&
                (parsed.actorType.toLowerCase() === "bot" || actor.endsWith("[bot]"))
              ? `Bot actor '${parsed.actor}' cannot trigger agent work.`
              : !definition.authorizedActors.includes(actor)
                ? `Actor '${parsed.actor}' is not authorized for this trigger.`
                : !definition.events.includes(event)
                  ? `GitHub event '${event}' is not enabled for this trigger.`
                  : undefined;
        if (ignoreReason !== undefined) {
          yield* addActivity({
            triggerId: row.triggerId,
            deliveryId: input.deliveryId,
            principalId: row.principalId,
            source: parsed.source,
            attempt: 0,
            reservedComputeSeconds: 0,
            status: "ignored",
            message: ignoreReason,
            now,
          }).pipe(Effect.mapError(persistenceFailure));
          const activity = yield* requireActivity(row.triggerId, input.deliveryId);
          return webhookResult(publicActivity(activity), false);
        }
        if (parsed.kind === "ignored") {
          yield* addActivity({
            triggerId: row.triggerId,
            deliveryId: input.deliveryId,
            principalId: row.principalId,
            source: parsed.source,
            attempt: 0,
            reservedComputeSeconds: 0,
            status: "ignored",
            message: parsed.reason,
            now,
          }).pipe(Effect.mapError(persistenceFailure));
          const activity = yield* requireActivity(row.triggerId, input.deliveryId);
          return webhookResult(publicActivity(activity), false);
        }

        const sourceKey = githubTriggerSourceKey(parsed.source);
        const budget = (yield* sql<BudgetRow>`
          SELECT COUNT(*) AS attempts,
                 COALESCE(SUM(reserved_compute_seconds), 0) AS "reservedComputeSeconds"
          FROM cloud_github_trigger_activities
          WHERE trigger_id = ${row.triggerId}
            AND source_key = ${sourceKey}
            AND reserved_compute_seconds > 0
        `.pipe(Effect.mapError(persistenceFailure)))[0] ?? {
          attempts: 0,
          reservedComputeSeconds: 0,
        };
        const attempt = budget.attempts + 1;
        const nextCompute = budget.reservedComputeSeconds + definition.limits.runSeconds;
        const limited =
          attempt > definition.limits.maxAttempts
            ? `Repair attempt limit ${definition.limits.maxAttempts} reached for this issue or pull request.`
            : nextCompute > definition.limits.maxComputeSeconds
              ? `Repair compute limit ${definition.limits.maxComputeSeconds} seconds reached for this issue or pull request.`
              : undefined;
        if (limited !== undefined) {
          yield* addActivity({
            triggerId: row.triggerId,
            deliveryId: input.deliveryId,
            principalId: row.principalId,
            source: parsed.source,
            attempt: budget.attempts,
            reservedComputeSeconds: 0,
            status: "unresolved",
            message: limited,
            now,
          }).pipe(Effect.mapError(persistenceFailure));
          const activity = yield* requireActivity(row.triggerId, input.deliveryId);
          return webhookResult(publicActivity(activity), false);
        }

        const principal = decodePrincipal(row.principalJson);
        const requestId = `github-${NodeCrypto.createHash("sha256")
          .update(`${row.triggerId}:${input.deliveryId}`)
          .digest("hex")
          .slice(0, 24)}`;
        const expectedRunId = `run-${requestId}`;
        const previous = yield* api
          .getRun({ principal, agentId: definition.agentId, runId: expectedRunId })
          .pipe(Effect.result);
        const admitted = Result.isSuccess(previous)
          ? Result.succeed({ run: previous.success })
          : previous.failure.code !== "run_not_found"
            ? Result.fail(previous.failure)
            : yield* api
                .createRun({
                  principal,
                  agentId: definition.agentId,
                  body: {
                    prompt: {
                      text: githubTriggerPrompt({
                        repository: definition.repository,
                        deliveryId: input.deliveryId,
                        source: parsed.source,
                        task: parsed.task,
                      }),
                    },
                  },
                  requestId,
                  selectedRef: parsed.source.baseRevision,
                  limits: {
                    runSeconds: definition.limits.runSeconds,
                    inputWaitSeconds: definition.limits.inputWaitSeconds,
                  },
                })
                .pipe(Effect.result);

        if (Result.isFailure(admitted)) {
          yield* addActivity({
            triggerId: row.triggerId,
            deliveryId: input.deliveryId,
            principalId: row.principalId,
            source: parsed.source,
            attempt: budget.attempts,
            reservedComputeSeconds: 0,
            status: "unresolved",
            message: `GitHub repair could not start: ${admitted.failure.message}`,
            now,
          }).pipe(Effect.mapError(persistenceFailure));
        } else {
          yield* addActivity({
            triggerId: row.triggerId,
            deliveryId: input.deliveryId,
            principalId: row.principalId,
            source: parsed.source,
            attempt,
            reservedComputeSeconds: definition.limits.runSeconds,
            status: "triggered",
            message: `GitHub repair run ${admitted.success.run.id} was admitted at ${parsed.source.baseRevision}.`,
            agentId: definition.agentId,
            runId: admitted.success.run.id,
            now,
          }).pipe(Effect.mapError(persistenceFailure));
        }
        const activity = yield* requireActivity(row.triggerId, input.deliveryId);
        return webhookResult(publicActivity(activity), false);
      }),
    );

  return CloudGithubTriggers.of({
    create,
    list,
    get,
    disable,
    enable,
    remove,
    listActivities,
    receive,
  });
});

export const layer = Layer.effect(CloudGithubTriggers, make());
