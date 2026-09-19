// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CloudAgentScheduleDefinition,
  CloudAgentsApiPrincipal,
  type CloudAgentSchedule,
  type CloudAgentScheduleActivity,
  type CloudAgentScheduleActivityKind,
  type CloudAgentScheduleCreateRequest,
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
import {
  nextCloudAgentScheduleAt,
  validateCloudAgentScheduleTiming,
  type ParsedCron,
} from "./cloudAgentSchedulePolicy.ts";

type ScheduleRow = {
  readonly scheduleId: string;
  readonly principalId: string;
  readonly principalJson: string;
  readonly definitionJson: string;
  readonly urlOrigin: string;
  readonly status: "active" | "paused";
  readonly nextRunAt: string | null;
  readonly occurrenceAt: string | null;
  readonly retryCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type ActivityRow = {
  readonly activityId: string;
  readonly scheduleId: string;
  readonly kind: CloudAgentScheduleActivityKind;
  readonly message: string;
  readonly scheduledFor: string;
  readonly agentId: string | null;
  readonly runId: string | null;
  readonly createdAt: string;
};

type RunRow = {
  readonly scheduleId: string;
  readonly occurrenceAt: string;
  readonly principalId: string;
  readonly principalJson: string;
  readonly agentId: string;
  readonly runId: string;
};

const decodeDefinition = Schema.decodeUnknownSync(
  Schema.fromJsonString(CloudAgentScheduleDefinition),
);
const encodeDefinition = Schema.encodeSync(Schema.fromJsonString(CloudAgentScheduleDefinition));
const decodePrincipal = Schema.decodeUnknownSync(Schema.fromJsonString(CloudAgentsApiPrincipal));
const encodePrincipal = Schema.encodeSync(Schema.fromJsonString(CloudAgentsApiPrincipal));

export interface CloudAgentSchedulesPage<Item> {
  readonly items: ReadonlyArray<Item>;
}

export class CloudAgentSchedules extends Context.Service<
  CloudAgentSchedules,
  {
    readonly create: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly definition: CloudAgentScheduleCreateRequest;
      readonly urlOrigin: string;
    }) => Effect.Effect<CloudAgentSchedule, CloudAgentsApiFailure>;
    readonly list: (input: {
      readonly principal: CloudAgentsApiPrincipal;
    }) => Effect.Effect<CloudAgentSchedulesPage<CloudAgentSchedule>, CloudAgentsApiFailure>;
    readonly get: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly scheduleId: string;
    }) => Effect.Effect<CloudAgentSchedule, CloudAgentsApiFailure>;
    readonly replace: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly scheduleId: string;
      readonly definition: CloudAgentScheduleCreateRequest;
      readonly urlOrigin: string;
    }) => Effect.Effect<CloudAgentSchedule, CloudAgentsApiFailure>;
    readonly pause: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly scheduleId: string;
    }) => Effect.Effect<CloudAgentSchedule, CloudAgentsApiFailure>;
    readonly resume: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly scheduleId: string;
    }) => Effect.Effect<CloudAgentSchedule, CloudAgentsApiFailure>;
    readonly remove: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly scheduleId: string;
    }) => Effect.Effect<{ readonly id: string }, CloudAgentsApiFailure>;
    readonly listActivities: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly scheduleId?: string;
      readonly limit: number;
    }) => Effect.Effect<CloudAgentSchedulesPage<CloudAgentScheduleActivity>, CloudAgentsApiFailure>;
    readonly reconcile: (nowMs: number) => Effect.Effect<void>;
  }
>()("t3/cloud/CloudAgentSchedules") {}

function nowIso(nowMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(nowMs));
}

function persistenceFailure(): CloudAgentsApiFailure {
  return apiError("internal_error", "The cloud schedule catalog is unavailable.");
}

function missing(scheduleId: string): CloudAgentsApiFailure {
  return apiError("schedule_not_found", `Schedule '${scheduleId}' was not found.`);
}

function publicSchedule(row: ScheduleRow): CloudAgentSchedule {
  return {
    id: row.scheduleId,
    status: row.status,
    definition: decodeDefinition(row.definitionJson),
    ...(row.nextRunAt === null ? {} : { nextRunAt: row.nextRunAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicActivity(row: ActivityRow): CloudAgentScheduleActivity {
  return {
    id: row.activityId,
    scheduleId: row.scheduleId,
    kind: row.kind,
    message: row.message,
    scheduledFor: row.scheduledFor,
    ...(row.agentId === null ? {} : { agentId: row.agentId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    createdAt: row.createdAt,
  };
}

function scheduleError(
  definition: CloudAgentScheduleDefinition,
  afterMs: number,
): string | undefined {
  const timing = validateCloudAgentScheduleTiming(definition);
  if ("message" in timing) return timing.message;
  if (
    nextCloudAgentScheduleAt({
      cron: timing.cron,
      timezone: definition.timezone,
      afterMs,
    }) === undefined
  ) {
    return "Schedule has no occurrence in the next five years.";
  }
  if (definition.provider.instanceId !== "codex") {
    return "Scheduled cloud runs currently support the qualified Codex provider only.";
  }
  if (definition.limits.maxAttempts > 10) return "Scheduled retries are limited to 10 attempts.";
  if (definition.limits.retryDelaySeconds > 86_400) {
    return "Scheduled retry delay may not exceed 86400 seconds.";
  }
  if (definition.action.type === "create_agent") {
    if (definition.action.request.agentId !== undefined) {
      return "A recurring create-agent schedule cannot reuse a caller-supplied agentId.";
    }
    if (definition.publication === "inherit") {
      return "A create-agent schedule must choose review_only or draft_pr publication.";
    }
    if (
      definition.refPolicy.type === "fixed" &&
      definition.action.request.repos?.[0] === undefined
    ) {
      return "A fixed ref schedule requires a repository.";
    }
  } else {
    if (definition.publication !== "inherit") {
      return "A follow-up schedule inherits the durable agent's publication policy.";
    }
    if (definition.refPolicy.type !== "repository_default") {
      return "A follow-up schedule inherits the durable agent's ref policy.";
    }
    if (
      definition.provider.model.id !== "inherit" ||
      definition.provider.model.params !== undefined
    ) {
      return "A follow-up schedule must use the inherited provider model.";
    }
  }
}

function parsedCron(definition: CloudAgentScheduleDefinition): ParsedCron {
  const timing = validateCloudAgentScheduleTiming(definition);
  if ("message" in timing) throw new Error(timing.message);
  return timing.cron;
}

function nextRunAt(definition: CloudAgentScheduleDefinition, afterMs: number): string {
  const next = nextCloudAgentScheduleAt({
    cron: parsedCron(definition),
    timezone: definition.timezone,
    afterMs,
  });
  if (next === undefined) throw new Error("The schedule has no occurrence in the next five years.");
  return next;
}

function occurrenceKey(scheduleId: string, occurrenceAt: string): string {
  return NodeCrypto.createHash("sha256")
    .update(`${scheduleId}:${occurrenceAt}`)
    .digest("hex")
    .slice(0, 24);
}

function createAgentRequest(
  definition: CloudAgentScheduleDefinition,
  agentId: string,
): CloudAgentsApiCreateAgentRequest {
  if (definition.action.type !== "create_agent") {
    throw new Error("A follow-up schedule cannot create an agent request.");
  }
  const request = definition.action.request;
  const repos = request.repos?.map((repo, index) => {
    if (index !== 0) return repo;
    const primary = {
      url: repo.url,
      ...(repo.prUrl === undefined ? {} : { prUrl: repo.prUrl }),
    };
    return definition.refPolicy.type === "fixed"
      ? { ...primary, startingRef: definition.refPolicy.ref }
      : primary;
  });
  return {
    ...request,
    agentId,
    model: definition.provider.model,
    autoCreatePR: definition.publication === "draft_pr",
    ...(repos === undefined ? {} : { repos }),
  };
}

export const make = Effect.fn("CloudAgentSchedules.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const api = yield* CloudAgentsApi.CloudAgentsApi;
  const mutex = yield* Semaphore.make(1);

  const readOwned = (principalId: string, scheduleId: string) =>
    sql<ScheduleRow>`
      SELECT schedule_id AS "scheduleId", principal_id AS "principalId",
             principal_json AS "principalJson", definition_json AS "definitionJson",
             url_origin AS "urlOrigin", status, next_run_at AS "nextRunAt",
             occurrence_at AS "occurrenceAt", retry_count AS "retryCount",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM cloud_agent_schedules
      WHERE principal_id = ${principalId} AND schedule_id = ${scheduleId}
    `;

  const requireOwned = Effect.fn("CloudAgentSchedules.requireOwned")(function* (
    principalId: string,
    scheduleId: string,
  ) {
    const row = (yield* readOwned(principalId, scheduleId).pipe(
      Effect.mapError(persistenceFailure),
    ))[0];
    if (row === undefined) return yield* Effect.fail(missing(scheduleId));
    return row;
  });

  const addActivity = (input: {
    readonly scheduleId: string;
    readonly principalId: string;
    readonly kind: CloudAgentScheduleActivityKind;
    readonly message: string;
    readonly scheduledFor: string;
    readonly agentId?: string;
    readonly runId?: string;
    readonly createdAt: string;
  }) => sql`
    INSERT INTO cloud_agent_schedule_activities (
      activity_id, schedule_id, principal_id, kind, message, scheduled_for,
      agent_id, run_id, created_at
    ) VALUES (
      ${`activity-${NodeCrypto.randomUUID()}`}, ${input.scheduleId}, ${input.principalId},
      ${input.kind}, ${input.message}, ${input.scheduledFor},
      ${input.agentId ?? null}, ${input.runId ?? null}, ${input.createdAt}
    )
  `;

  const create: CloudAgentSchedules["Service"]["create"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const invalid = scheduleError(input.definition, Date.parse(createdAt));
        if (invalid !== undefined) return yield* Effect.fail(apiError("invalid_request", invalid));
        const next = nextRunAt(input.definition, Date.parse(createdAt));
        const scheduleId = `schedule-${NodeCrypto.randomUUID()}`;
        yield* sql`
          INSERT INTO cloud_agent_schedules (
            schedule_id, principal_id, principal_json, definition_json, url_origin,
            status, next_run_at, created_at, updated_at
          ) VALUES (
            ${scheduleId}, ${input.principal.principalId}, ${encodePrincipal(input.principal)},
            ${encodeDefinition(input.definition)}, ${input.urlOrigin}, 'active', ${next},
            ${createdAt}, ${createdAt}
          )
        `.pipe(Effect.mapError(persistenceFailure));
        return publicSchedule(yield* requireOwned(input.principal.principalId, scheduleId));
      }),
    );

  const list: CloudAgentSchedules["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<ScheduleRow>`
        SELECT schedule_id AS "scheduleId", principal_id AS "principalId",
               principal_json AS "principalJson", definition_json AS "definitionJson",
               url_origin AS "urlOrigin", status, next_run_at AS "nextRunAt",
               occurrence_at AS "occurrenceAt", retry_count AS "retryCount",
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM cloud_agent_schedules
        WHERE principal_id = ${input.principal.principalId}
        ORDER BY created_at DESC
      `.pipe(Effect.mapError(persistenceFailure));
      return { items: rows.map(publicSchedule) };
    });

  const get: CloudAgentSchedules["Service"]["get"] = (input) =>
    requireOwned(input.principal.principalId, input.scheduleId).pipe(Effect.map(publicSchedule));

  const replace: CloudAgentSchedules["Service"]["replace"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* requireOwned(input.principal.principalId, input.scheduleId);
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const invalid = scheduleError(input.definition, Date.parse(updatedAt));
        if (invalid !== undefined) return yield* Effect.fail(apiError("invalid_request", invalid));
        const next =
          existing.status === "active" ? nextRunAt(input.definition, Date.parse(updatedAt)) : null;
        yield* sql`
          UPDATE cloud_agent_schedules
          SET definition_json = ${encodeDefinition(input.definition)},
              url_origin = ${input.urlOrigin}, next_run_at = ${next},
              occurrence_at = NULL, retry_count = 0, updated_at = ${updatedAt}
          WHERE principal_id = ${input.principal.principalId}
            AND schedule_id = ${input.scheduleId}
        `.pipe(Effect.mapError(persistenceFailure));
        return publicSchedule(yield* requireOwned(input.principal.principalId, input.scheduleId));
      }),
    );

  const setStatus =
    (target: "active" | "paused"): CloudAgentSchedules["Service"]["pause"] =>
    (input) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* requireOwned(input.principal.principalId, input.scheduleId);
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          const next =
            target === "active"
              ? nextRunAt(decodeDefinition(existing.definitionJson), Date.parse(updatedAt))
              : null;
          yield* sql`
          UPDATE cloud_agent_schedules
          SET status = ${target}, next_run_at = ${next}, occurrence_at = NULL,
              retry_count = 0, updated_at = ${updatedAt}
          WHERE principal_id = ${input.principal.principalId}
            AND schedule_id = ${input.scheduleId}
        `.pipe(Effect.mapError(persistenceFailure));
          return publicSchedule(yield* requireOwned(input.principal.principalId, input.scheduleId));
        }),
      );

  const remove: CloudAgentSchedules["Service"]["remove"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireOwned(input.principal.principalId, input.scheduleId);
        yield* sql`
          DELETE FROM cloud_agent_schedules
          WHERE principal_id = ${input.principal.principalId}
            AND schedule_id = ${input.scheduleId}
        `.pipe(Effect.mapError(persistenceFailure));
        return { id: input.scheduleId };
      }),
    );

  const listActivities: CloudAgentSchedules["Service"]["listActivities"] = (input) =>
    Effect.gen(function* () {
      const rows =
        input.scheduleId === undefined
          ? yield* sql<ActivityRow>`
            SELECT activity_id AS "activityId", schedule_id AS "scheduleId", kind,
                   message, scheduled_for AS "scheduledFor", agent_id AS "agentId",
                   run_id AS "runId", created_at AS "createdAt"
            FROM cloud_agent_schedule_activities
            WHERE principal_id = ${input.principal.principalId}
            ORDER BY created_at DESC
            LIMIT ${input.limit}
          `
          : yield* sql<ActivityRow>`
            SELECT activity_id AS "activityId", schedule_id AS "scheduleId", kind,
                   message, scheduled_for AS "scheduledFor", agent_id AS "agentId",
                   run_id AS "runId", created_at AS "createdAt"
            FROM cloud_agent_schedule_activities
            WHERE principal_id = ${input.principal.principalId}
              AND schedule_id = ${input.scheduleId}
            ORDER BY created_at DESC
            LIMIT ${input.limit}
          `;
      return { items: rows.map(publicActivity) };
    }).pipe(Effect.mapError(persistenceFailure));

  const observeRuns = Effect.fn("CloudAgentSchedules.observeRuns")(function* (now: string) {
    const runs = yield* sql<RunRow>`
      SELECT schedule_id AS "scheduleId", occurrence_at AS "occurrenceAt",
             principal_id AS "principalId", principal_json AS "principalJson",
             agent_id AS "agentId", run_id AS "runId"
      FROM cloud_agent_schedule_runs
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
          const kind: CloudAgentScheduleActivityKind =
            status === "FINISHED" ? "completed" : status === "CANCELLED" ? "cancelled" : "failed";
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE cloud_agent_schedule_runs
                SET terminal_status = ${status}, updated_at = ${now}
                WHERE schedule_id = ${row.scheduleId} AND occurrence_at = ${row.occurrenceAt}
                  AND terminal_status IS NULL
              `;
              yield* addActivity({
                scheduleId: row.scheduleId,
                principalId: row.principalId,
                kind,
                message: `Scheduled run ${row.runId} ended with ${status}.`,
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

  const advance = (row: ScheduleRow, definition: CloudAgentScheduleDefinition, afterMs: number) =>
    sql`
      UPDATE cloud_agent_schedules
      SET next_run_at = ${nextRunAt(definition, afterMs)}, occurrence_at = NULL,
          retry_count = 0, updated_at = ${nowIso(afterMs)}
      WHERE schedule_id = ${row.scheduleId}
    `;

  const trigger = Effect.fn("CloudAgentSchedules.trigger")(function* (
    row: ScheduleRow,
    nowMs: number,
  ) {
    const definition = decodeDefinition(row.definitionJson);
    const principal = decodePrincipal(row.principalJson);
    const now = nowIso(nowMs);
    const occurrenceAt = row.occurrenceAt ?? row.nextRunAt;
    if (occurrenceAt === null) return;
    const occurrenceMs = Date.parse(occurrenceAt);
    if (
      row.occurrenceAt === null &&
      definition.missedRunPolicy === "skip" &&
      occurrenceMs < nowMs - 90_000
    ) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* addActivity({
            scheduleId: row.scheduleId,
            principalId: row.principalId,
            kind: "missed",
            message: "The controller was offline for this occurrence, so the schedule skipped it.",
            scheduledFor: occurrenceAt,
            createdAt: now,
          });
          yield* advance(row, definition, nowMs);
        }),
      );
      return;
    }

    yield* sql`
      UPDATE cloud_agent_schedules
      SET next_run_at = NULL, occurrence_at = ${occurrenceAt}, updated_at = ${now}
      WHERE schedule_id = ${row.scheduleId}
    `;
    const key = occurrenceKey(row.scheduleId, occurrenceAt);
    const action = definition.action;
    const limits = {
      runSeconds: definition.limits.runSeconds,
      inputWaitSeconds: definition.limits.inputWaitSeconds,
    };
    const admission = Effect.gen(function* () {
      if (action.type === "create_agent") {
        const agentId = `bc-scheduled-${key}`;
        const existing = yield* api
          .getAgent({ principal, agentId, urlOrigin: row.urlOrigin })
          .pipe(Effect.result);
        if (Result.isSuccess(existing)) {
          const runId = existing.success.latestRunId;
          if (runId === undefined) {
            return yield* Effect.fail(
              apiError("internal_error", `Scheduled agent '${agentId}' has no initial run.`),
            );
          }
          const run = yield* api.getRun({ principal, agentId, runId });
          return { agentId, run };
        }
        if (existing.failure.code !== "agent_not_found") {
          return yield* Effect.fail(existing.failure);
        }
        const response = yield* api.createAgent({
          principal,
          urlOrigin: row.urlOrigin,
          body: createAgentRequest(definition, agentId),
          limits,
        });
        return { agentId: response.agent.id, run: response.run };
      }

      const requestId = `scheduled-${key}`;
      const runId = `run-${requestId}`;
      const existing = yield* api
        .getRun({ principal, agentId: action.agentId, runId })
        .pipe(Effect.result);
      if (Result.isSuccess(existing)) return { agentId: action.agentId, run: existing.success };
      if (existing.failure.code !== "run_not_found") {
        return yield* Effect.fail(existing.failure);
      }
      const response = yield* api.createRun({
        principal,
        agentId: action.agentId,
        body: action.request,
        requestId,
        limits,
      });
      return { agentId: action.agentId, run: response.run };
    });
    const admitted = yield* admission.pipe(Effect.result);

    if (Result.isSuccess(admitted)) {
      const agentId = admitted.success.agentId;
      const runId = admitted.success.run.id;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO cloud_agent_schedule_runs (
              schedule_id, occurrence_at, principal_id, principal_json,
              agent_id, run_id, created_at, updated_at
            ) VALUES (
              ${row.scheduleId}, ${occurrenceAt}, ${row.principalId}, ${row.principalJson},
              ${agentId}, ${runId}, ${now}, ${now}
            )
            ON CONFLICT (schedule_id, occurrence_at) DO NOTHING
          `;
          yield* addActivity({
            scheduleId: row.scheduleId,
            principalId: row.principalId,
            kind: "triggered",
            message: `Scheduled run ${runId} was admitted.`,
            scheduledFor: occurrenceAt,
            agentId,
            runId,
            createdAt: now,
          });
          yield* advance(row, definition, Math.max(nowMs, occurrenceMs));
        }),
      );
      return;
    }

    const failure = admitted.failure;
    if (failure.code === "agent_busy") {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* addActivity({
            scheduleId: row.scheduleId,
            principalId: row.principalId,
            kind: "skipped_overlap",
            message: "The durable agent already had an active run, so this occurrence was skipped.",
            scheduledFor: occurrenceAt,
            ...(definition.action.type === "follow_up"
              ? { agentId: definition.action.agentId }
              : {}),
            createdAt: now,
          });
          yield* advance(row, definition, nowMs);
        }),
      );
      return;
    }

    const attempt = row.retryCount + 1;
    if (attempt < definition.limits.maxAttempts) {
      const retryAt = nowIso(nowMs + definition.limits.retryDelaySeconds * 1_000);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE cloud_agent_schedules
            SET next_run_at = ${retryAt}, occurrence_at = ${occurrenceAt},
                retry_count = ${attempt}, updated_at = ${now}
            WHERE schedule_id = ${row.scheduleId}
          `;
          yield* addActivity({
            scheduleId: row.scheduleId,
            principalId: row.principalId,
            kind: "retry_scheduled",
            message: `Admission failed with ${failure.code}; retry ${attempt + 1} is scheduled.`,
            scheduledFor: occurrenceAt,
            createdAt: now,
          });
        }),
      );
      return;
    }

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* addActivity({
          scheduleId: row.scheduleId,
          principalId: row.principalId,
          kind: "failed",
          message: `Admission stopped after ${attempt} attempts with ${failure.code}.`,
          scheduledFor: occurrenceAt,
          createdAt: now,
        });
        yield* advance(row, definition, nowMs);
      }),
    );
  });

  const reconcile: CloudAgentSchedules["Service"]["reconcile"] = (nowMs) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const now = nowIso(nowMs);
        yield* observeRuns(now);
        yield* sql`
          UPDATE cloud_agent_schedules
          SET next_run_at = ${now}, updated_at = ${now}
          WHERE status = 'active' AND next_run_at IS NULL AND occurrence_at IS NOT NULL
        `.pipe(Effect.catch(() => Effect.void));
        const due = yield* sql<ScheduleRow>`
          SELECT schedule_id AS "scheduleId", principal_id AS "principalId",
                 principal_json AS "principalJson", definition_json AS "definitionJson",
                 url_origin AS "urlOrigin", status, next_run_at AS "nextRunAt",
                 occurrence_at AS "occurrenceAt", retry_count AS "retryCount",
                 created_at AS "createdAt", updated_at AS "updatedAt"
          FROM cloud_agent_schedules
          WHERE status = 'active' AND next_run_at <= ${now}
          ORDER BY next_run_at ASC
        `.pipe(Effect.orElseSucceed(() => []));
        yield* Effect.forEach(due, (row) => trigger(row, nowMs).pipe(Effect.ignore), {
          discard: true,
        });
      }),
    );

  const service = CloudAgentSchedules.of({
    create,
    list,
    get,
    replace,
    pause: setStatus("paused"),
    resume: setStatus("active"),
    remove,
    listActivities,
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

export const layer = Layer.effect(CloudAgentSchedules, make());
