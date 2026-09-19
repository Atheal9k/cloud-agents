// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CLOUD_AGENTS_API_STREAM_RETENTION_SECONDS,
  CloudAgentScheduleCreateRequest,
  CloudAgentAutomationCreateRequest,
  CloudAgentAutomationDeliveryRequest,
  CloudAgentAutomationMemoryWrite,
  CloudAgentSubscriptionCreateRequest,
  CloudAgentSubscriptionDeliveryRequest,
  CloudAgentsApiCreateAgentRequest,
  CloudAgentsApiCreateRunRequest,
  CloudAssistantCreateRequest,
  CloudAssistantMemoryWrite,
  CloudAssistantPersistenceKind,
  CloudAssistantSubscription,
  type CloudAgentsApiPrincipal,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudAgentSchedules from "./CloudAgentSchedules.ts";
import * as CloudAgentAutomations from "./CloudAgentAutomations.ts";
import * as CloudAssistants from "./CloudAssistants.ts";
import * as CloudAgentSubscriptions from "./CloudAgentSubscriptions.ts";
import {
  CloudAgentsApiFailure,
  defaultMinuteLimit,
  encodeSse,
  parseBooleanParam,
  parseCloudAgentsApiAuthorization,
  parseLimitParam,
  repositoryHourLimit,
  repositoryMinuteLimit,
  type RateLimitWindow,
} from "./cloudAgentsApiModel.ts";

const decodeCreateAgent = Schema.decodeUnknownEffect(CloudAgentsApiCreateAgentRequest);
const decodeCreateRun = Schema.decodeUnknownEffect(CloudAgentsApiCreateRunRequest);
const decodeSchedule = Schema.decodeUnknownEffect(CloudAgentScheduleCreateRequest);
const decodeAutomation = Schema.decodeUnknownEffect(CloudAgentAutomationCreateRequest);
const decodeAutomationDelivery = Schema.decodeUnknownEffect(CloudAgentAutomationDeliveryRequest);
const decodeAutomationMemory = Schema.decodeUnknownEffect(CloudAgentAutomationMemoryWrite);
const decodeAssistant = Schema.decodeUnknownEffect(CloudAssistantCreateRequest);
const decodeAssistantMemory = Schema.decodeUnknownEffect(CloudAssistantMemoryWrite);
const decodeAssistantSubscription = Schema.decodeUnknownEffect(CloudAssistantSubscription);
const decodeAssistantPersistence = Schema.decodeUnknownEffect(
  Schema.Struct({
    kind: CloudAssistantPersistenceKind,
    plaintext: Schema.String,
  }),
);
const decodeSubscription = Schema.decodeUnknownEffect(CloudAgentSubscriptionCreateRequest);
const decodeSubscriptionDelivery = Schema.decodeUnknownEffect(
  CloudAgentSubscriptionDeliveryRequest,
);

type LimitState = {
  minute: Map<string, RateLimitWindow>;
  repoMinute: Map<string, RateLimitWindow>;
  repoHour: Map<string, RateLimitWindow>;
};

class CloudAgentsApiRateLimits extends Context.Service<
  CloudAgentsApiRateLimits,
  Ref.Ref<LimitState>
>()("t3/cloud/CloudAgentsApiHttp/CloudAgentsApiRateLimits") {}

function jsonResponse(status: number, body: unknown, headers: Record<string, string>) {
  return HttpServerResponse.jsonUnsafe(body, { status, headers });
}

function errorResponse(error: CloudAgentsApiFailure, headers: Record<string, string>) {
  return jsonResponse(error.status, error.toBody(), headers);
}

function requestIdOf(header: string | undefined): string {
  const trimmed = header?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : NodeCrypto.randomUUID();
}

function originOf(request: HttpServerRequest.HttpServerRequest): string {
  const host = request.headers.host;
  const proto = request.headers["x-forwarded-proto"] ?? "http";
  return host === undefined ? "http://localhost" : `${proto}://${host}`;
}

function limitHeaders(
  requestId: string,
  limit: { readonly remaining: number; readonly limit: number; readonly resetAtMs: number },
): Record<string, string> {
  return {
    "x-request-id": requestId,
    "x-ratelimit-limit": String(limit.limit),
    "x-ratelimit-remaining": String(Math.max(0, limit.remaining)),
    "x-ratelimit-reset": String(Math.ceil(limit.resetAtMs / 1000)),
  };
}

const consume = (
  limits: Ref.Ref<LimitState>,
  principal: CloudAgentsApiPrincipal,
  nowMs: number,
  repositories: boolean,
) =>
  Ref.modify(limits, (state) => {
    if (repositories) {
      const minute = repositoryMinuteLimit(nowMs, state.repoMinute.get(principal.principalId));
      const hour = repositoryHourLimit(nowMs, state.repoHour.get(principal.principalId));
      const next: LimitState = {
        ...state,
        repoMinute: new Map(state.repoMinute).set(principal.principalId, minute.window),
        repoHour: new Map(state.repoHour).set(principal.principalId, hour.window),
      };
      const allowed = minute.decision.allowed && hour.decision.allowed;
      const tighter =
        hour.decision.remaining < minute.decision.remaining ? hour.decision : minute.decision;
      return [{ ...tighter, allowed }, next] as const;
    }
    const minute = defaultMinuteLimit(nowMs, state.minute.get(principal.principalId));
    return [
      minute.decision,
      { ...state, minute: new Map(state.minute).set(principal.principalId, minute.window) },
    ] as const;
  });

const handleV1 = (deps: {
  readonly api: CloudAgentsApi.CloudAgentsApi["Service"];
  readonly keys: CloudAgentsApiKeys.CloudAgentsApiKeys["Service"];
  readonly schedules: CloudAgentSchedules.CloudAgentSchedules["Service"];
  readonly automations: CloudAgentAutomations.CloudAgentAutomations["Service"];
  readonly assistants: CloudAssistants.CloudAssistants["Service"];
  readonly subscriptions: CloudAgentSubscriptions.CloudAgentSubscriptions["Service"];
  readonly limits: Ref.Ref<LimitState>;
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestId = requestIdOf(request.headers["x-request-id"]);
    const nowMs = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname.replace(/\/$/u, "") || "/";
    if (request.method.toUpperCase() === "POST" && path.startsWith("/v1/automation-hooks/")) {
      const hookMeta = limitHeaders(requestId, { remaining: 59, limit: 60, resetAtMs: nowMs });
      const token = parseCloudAgentsApiAuthorization(request.headers.authorization);
      if (token instanceof CloudAgentsApiFailure) return errorResponse(token, hookMeta);
      const delivery = yield* decodeAutomationDelivery(
        yield* request.json.pipe(
          Effect.mapError(
            () => new CloudAgentsApiFailure("invalid_request", "JSON body required.", 400),
          ),
        ),
      ).pipe(
        Effect.mapError(
          () => new CloudAgentsApiFailure("invalid_request", "Invalid automation delivery.", 400),
        ),
      );
      return jsonResponse(
        200,
        yield* deps.automations.deliver({
          hookId: path.slice("/v1/automation-hooks/".length),
          token,
          delivery,
          urlOrigin: originOf(request),
        }),
        hookMeta,
      );
    }
    const token = parseCloudAgentsApiAuthorization(request.headers.authorization);
    if (token instanceof CloudAgentsApiFailure) {
      return errorResponse(
        token,
        limitHeaders(requestId, { remaining: 0, limit: 60, resetAtMs: nowMs }),
      );
    }
    const principal = yield* deps.keys.authenticate(token);
    if (principal === null) {
      return errorResponse(
        new CloudAgentsApiFailure("unauthorized", "The API key is invalid.", 401),
        limitHeaders(requestId, { remaining: 0, limit: 60, resetAtMs: nowMs }),
      );
    }
    const decision = yield* consume(
      deps.limits,
      principal,
      nowMs,
      url.pathname.startsWith("/v1/repositories"),
    );
    const meta = limitHeaders(requestId, decision);
    if (!decision.allowed) {
      return errorResponse(
        new CloudAgentsApiFailure("rate_limited", "Rate limit exceeded.", 429),
        meta,
      );
    }
    return yield* dispatchV1({
      api: deps.api,
      schedules: deps.schedules,
      automations: deps.automations,
      assistants: deps.assistants,
      subscriptions: deps.subscriptions,
      principal,
      request,
      url,
      origin: originOf(request),
      nowMs,
      meta,
    });
  }).pipe(
    Effect.catchIf(
      (error): error is CloudAgentsApiFailure => error instanceof CloudAgentsApiFailure,
      (error) =>
        Effect.succeed(
          errorResponse(error, {
            "x-request-id": NodeCrypto.randomUUID(),
            "x-ratelimit-limit": "60",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "0",
          }),
        ),
    ),
    Effect.catchCause(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { code: "internal_error", message: "The Cloud Agents API failed." },
          { status: 500 },
        ),
      ),
    ),
  );

const dispatchV1 = (input: {
  readonly api: CloudAgentsApi.CloudAgentsApi["Service"];
  readonly schedules: CloudAgentSchedules.CloudAgentSchedules["Service"];
  readonly automations: CloudAgentAutomations.CloudAgentAutomations["Service"];
  readonly assistants: CloudAssistants.CloudAssistants["Service"];
  readonly subscriptions: CloudAgentSubscriptions.CloudAgentSubscriptions["Service"];
  readonly principal: CloudAgentsApiPrincipal;
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly origin: string;
  readonly nowMs: number;
  readonly meta: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const {
      api,
      schedules,
      automations,
      assistants,
      subscriptions,
      principal,
      request,
      url,
      origin,
      nowMs,
      meta,
    } = input;
    const method = request.method.toUpperCase();
    const path = url.pathname.replace(/\/$/u, "") || "/";
    const parts = path.split("/").filter((part) => part.length > 0);
    const jsonBody = request.json.pipe(
      Effect.mapError(
        () => new CloudAgentsApiFailure("invalid_request", "JSON body required.", 400),
      ),
    );

    if (method === "GET" && path === "/v1/me") {
      return jsonResponse(200, yield* api.me(principal), meta);
    }
    if (method === "GET" && path === "/v1/models") {
      return jsonResponse(200, { items: yield* api.listModels }, meta);
    }
    if (method === "GET" && path === "/v1/repositories") {
      return jsonResponse(200, { items: yield* api.listRepositories }, meta);
    }
    if (method === "GET" && path === "/v1/usage-report") {
      const periodStart = url.searchParams.get("periodStart") ?? "1970-01-01T00:00:00.000Z";
      const periodEnd =
        url.searchParams.get("periodEnd") ?? DateTime.formatIso(DateTime.nowUnsafe());
      return jsonResponse(200, yield* api.usageReport({ periodStart, periodEnd }), meta);
    }
    if (method === "POST" && path === "/v1/schedules") {
      const definition = yield* decodeSchedule(yield* jsonBody).pipe(
        Effect.mapError(
          () => new CloudAgentsApiFailure("invalid_request", "Invalid schedule request.", 400),
        ),
      );
      return jsonResponse(
        200,
        yield* schedules.create({ principal, definition, urlOrigin: origin }),
        meta,
      );
    }
    if (method === "GET" && path === "/v1/schedules") {
      return jsonResponse(200, yield* schedules.list({ principal }), meta);
    }
    if (method === "GET" && path === "/v1/schedule-activities") {
      const limit = parseLimitParam(url.searchParams.get("limit"));
      if (limit instanceof CloudAgentsApiFailure) return errorResponse(limit, meta);
      const scheduleId = url.searchParams.get("scheduleId");
      return jsonResponse(
        200,
        yield* schedules.listActivities({
          principal,
          limit,
          ...(scheduleId === null ? {} : { scheduleId }),
        }),
        meta,
      );
    }
    if (parts[0] === "v1" && parts[1] === "schedules" && parts[2] !== undefined) {
      const scheduleId = parts[2];
      if (method === "GET" && parts.length === 3) {
        return jsonResponse(200, yield* schedules.get({ principal, scheduleId }), meta);
      }
      if (method === "PUT" && parts.length === 3) {
        const definition = yield* decodeSchedule(yield* jsonBody).pipe(
          Effect.mapError(
            () => new CloudAgentsApiFailure("invalid_request", "Invalid schedule request.", 400),
          ),
        );
        return jsonResponse(
          200,
          yield* schedules.replace({ principal, scheduleId, definition, urlOrigin: origin }),
          meta,
        );
      }
      if (method === "DELETE" && parts.length === 3) {
        return jsonResponse(200, yield* schedules.remove({ principal, scheduleId }), meta);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "pause") {
        return jsonResponse(200, yield* schedules.pause({ principal, scheduleId }), meta);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "resume") {
        return jsonResponse(200, yield* schedules.resume({ principal, scheduleId }), meta);
      }
    }
    if (method === "POST" && path === "/v1/automations") {
      const definition = yield* decodeAutomation(yield* jsonBody).pipe(
        Effect.mapError(
          () => new CloudAgentsApiFailure("invalid_request", "Invalid automation request.", 400),
        ),
      );
      return jsonResponse(
        200,
        yield* automations.create({ principal, definition, urlOrigin: origin }),
        meta,
      );
    }
    if (method === "GET" && path === "/v1/automations") {
      return jsonResponse(200, yield* automations.list({ principal }), meta);
    }
    if (method === "GET" && path === "/v1/automation-activities") {
      const limit = parseLimitParam(url.searchParams.get("limit"));
      if (limit instanceof CloudAgentsApiFailure) return errorResponse(limit, meta);
      const automationId = url.searchParams.get("automationId");
      return jsonResponse(
        200,
        yield* automations.listActivities({
          principal,
          limit,
          ...(automationId === null ? {} : { automationId }),
        }),
        meta,
      );
    }
    if (parts[0] === "v1" && parts[1] === "automations" && parts[2] !== undefined) {
      const automationId = parts[2];
      if (method === "GET" && parts.length === 3) {
        return jsonResponse(200, yield* automations.get({ principal, automationId }), meta);
      }
      if (method === "PUT" && parts.length === 3) {
        const definition = yield* decodeAutomation(yield* jsonBody).pipe(
          Effect.mapError(
            () => new CloudAgentsApiFailure("invalid_request", "Invalid automation request.", 400),
          ),
        );
        return jsonResponse(
          200,
          yield* automations.replace({ principal, automationId, definition, urlOrigin: origin }),
          meta,
        );
      }
      if (method === "DELETE" && parts.length === 3) {
        return jsonResponse(200, yield* automations.remove({ principal, automationId }), meta);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "pause") {
        return jsonResponse(200, yield* automations.pause({ principal, automationId }), meta);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "resume") {
        return jsonResponse(200, yield* automations.resume({ principal, automationId }), meta);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "deliveries") {
        const delivery = yield* decodeAutomationDelivery(yield* jsonBody).pipe(
          Effect.mapError(
            () => new CloudAgentsApiFailure("invalid_request", "Invalid automation delivery.", 400),
          ),
        );
        return jsonResponse(
          200,
          yield* automations.deliver({ principal, automationId, delivery, urlOrigin: origin }),
          meta,
        );
      }
      if (method === "GET" && parts.length === 4 && parts[3] === "memory") {
        return jsonResponse(200, yield* automations.listMemory({ principal, automationId }), meta);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "memory") {
        const fact = yield* decodeAutomationMemory(yield* jsonBody).pipe(
          Effect.mapError(
            () => new CloudAgentsApiFailure("invalid_request", "Invalid memory request.", 400),
          ),
        );
        return jsonResponse(
          200,
          yield* automations.writeMemory({ principal, automationId, fact }),
          meta,
        );
      }
      if (method === "DELETE" && parts.length === 5 && parts[3] === "memory" && parts[4] !== undefined) {
        return jsonResponse(
          200,
          yield* automations.deleteMemory({ principal, automationId, factId: parts[4] }),
          meta,
        );
      }
    }
    if (method === "POST" && path === "/v1/assistants") {
      const definition = yield* decodeAssistant(yield* jsonBody).pipe(
        Effect.mapError(
          () => new CloudAgentsApiFailure("invalid_request", "Invalid assistant request.", 400),
        ),
      );
      return jsonResponse(200, yield* assistants.create({ principal, definition }), meta);
    }
    if (method === "GET" && path === "/v1/assistants") {
      return jsonResponse(200, yield* assistants.list({ principal }), meta);
    }
    if (parts[0] === "v1" && parts[1] === "assistants" && parts[2] !== undefined) {
      const assistantId = parts[2];
      if (method === "GET" && parts.length === 3) {
        return jsonResponse(200, yield* assistants.get({ principal, assistantId }), meta);
      }
      if (method === "PUT" && parts.length === 3) {
        const definition = yield* decodeAssistant(yield* jsonBody).pipe(
          Effect.mapError(
            () => new CloudAgentsApiFailure("invalid_request", "Invalid assistant request.", 400),
          ),
        );
        return jsonResponse(
          200,
          yield* assistants.replace({ principal, assistantId, definition }),
          meta,
        );
      }
      if (method === "DELETE" && parts.length === 3) {
        return jsonResponse(200, yield* assistants.remove({ principal, assistantId }), meta);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "archive") {
        return jsonResponse(200, yield* assistants.archive({ principal, assistantId }), meta);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "unarchive") {
        return jsonResponse(200, yield* assistants.unarchive({ principal, assistantId }), meta);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "reset") {
        return jsonResponse(200, yield* assistants.reset({ principal, assistantId }), meta);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "runs") {
        const body = yield* decodeCreateRun(yield* jsonBody).pipe(
          Effect.mapError(
            () => new CloudAgentsApiFailure("invalid_request", "Invalid create run request.", 400),
          ),
        );
        return jsonResponse(
          200,
          yield* assistants.createRun({ principal, assistantId, body, urlOrigin: origin }),
          meta,
        );
      }
      if (method === "GET" && parts.length === 4 && parts[3] === "memory") {
        return jsonResponse(200, yield* assistants.listMemory({ principal, assistantId }), meta);
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "memory") {
        const fact = yield* decodeAssistantMemory(yield* jsonBody).pipe(
          Effect.mapError(
            () => new CloudAgentsApiFailure("invalid_request", "Invalid memory request.", 400),
          ),
        );
        return jsonResponse(
          200,
          yield* assistants.writeMemory({ principal, assistantId, fact }),
          meta,
        );
      }
      if (
        method === "PUT" &&
        parts.length === 5 &&
        parts[3] === "memory" &&
        parts[4] !== undefined
      ) {
        const fact = yield* decodeAssistantMemory(yield* jsonBody).pipe(
          Effect.mapError(
            () => new CloudAgentsApiFailure("invalid_request", "Invalid memory request.", 400),
          ),
        );
        return jsonResponse(
          200,
          yield* assistants.replaceMemory({
            principal,
            assistantId,
            factId: parts[4],
            fact,
          }),
          meta,
        );
      }
      if (
        method === "DELETE" &&
        parts.length === 5 &&
        parts[3] === "memory" &&
        parts[4] !== undefined
      ) {
        return jsonResponse(
          200,
          yield* assistants.deleteMemory({ principal, assistantId, factId: parts[4] }),
          meta,
        );
      }
      if (method === "PUT" && parts.length === 4 && parts[3] === "persistence") {
        const body = yield* decodeAssistantPersistence(yield* jsonBody).pipe(
          Effect.mapError(
            () => new CloudAgentsApiFailure("invalid_request", "Invalid persistence request.", 400),
          ),
        );
        return jsonResponse(
          200,
          yield* assistants.putPersistence({
            principal,
            assistantId,
            kind: body.kind,
            plaintext: body.plaintext,
          }),
          meta,
        );
      }
      if (
        method === "GET" &&
        parts.length === 5 &&
        parts[3] === "persistence" &&
        parts[4] !== undefined
      ) {
        if (parts[4] !== "files" && parts[4] !== "browser") {
          return errorResponse(
            new CloudAgentsApiFailure("invalid_request", "Unknown persistence kind.", 400),
            meta,
          );
        }
        return jsonResponse(
          200,
          yield* assistants.getPersistence({ principal, assistantId, kind: parts[4] }),
          meta,
        );
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "subscriptions") {
        const subscription = yield* decodeAssistantSubscription(yield* jsonBody).pipe(
          Effect.mapError(
            () =>
              new CloudAgentsApiFailure("invalid_request", "Invalid subscription request.", 400),
          ),
        );
        return jsonResponse(
          200,
          yield* assistants.attachSubscription({ principal, assistantId, subscription }),
          meta,
        );
      }
    }
    if (method === "POST" && path === "/v1/agents") {
      const body = yield* decodeCreateAgent(yield* jsonBody).pipe(
        Effect.mapError(
          () => new CloudAgentsApiFailure("invalid_request", "Invalid create agent request.", 400),
        ),
      );
      return jsonResponse(
        200,
        yield* api.createAgent({ principal, body, urlOrigin: origin }),
        meta,
      );
    }
    if (method === "GET" && path === "/v1/agents") {
      const limit = parseLimitParam(url.searchParams.get("limit"));
      if (limit instanceof CloudAgentsApiFailure) return errorResponse(limit, meta);
      const cursor = url.searchParams.get("cursor");
      const prUrl = url.searchParams.get("prUrl");
      const page = yield* api.listAgents({
        principal,
        urlOrigin: origin,
        limit,
        ...(cursor === null ? {} : { cursor }),
        includeArchived: parseBooleanParam(url.searchParams.get("includeArchived"), true),
        ...(prUrl === null ? {} : { prUrl }),
      });
      return jsonResponse(200, page, meta);
    }

    if (parts[0] !== "v1" || parts[1] !== "agents" || parts[2] === undefined) {
      return errorResponse(
        new CloudAgentsApiFailure("invalid_request", "Unknown Cloud Agents API route.", 400),
        meta,
      );
    }
    const agentId = parts[2];
    if (method === "GET" && parts.length === 3) {
      return jsonResponse(
        200,
        yield* api.getAgent({ principal, agentId, urlOrigin: origin }),
        meta,
      );
    }
    if (method === "DELETE" && parts.length === 3) {
      return jsonResponse(200, yield* api.deleteAgent({ principal, agentId }), meta);
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "archive") {
      return jsonResponse(200, yield* api.archive({ principal, agentId }), meta);
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "unarchive") {
      return jsonResponse(200, yield* api.unarchive({ principal, agentId }), meta);
    }
    if (method === "GET" && parts.length === 4 && parts[3] === "usage") {
      const runId = url.searchParams.get("runId");
      return jsonResponse(
        200,
        yield* api.usage({ principal, agentId, ...(runId === null ? {} : { runId }) }),
        meta,
      );
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "subscriptions") {
      const definition = yield* decodeSubscription(yield* jsonBody).pipe(
        Effect.mapError(
          () => new CloudAgentsApiFailure("invalid_request", "Invalid subscription request.", 400),
        ),
      );
      return jsonResponse(
        200,
        yield* subscriptions.create({ principal, agentId, definition, urlOrigin: origin }),
        meta,
      );
    }
    if (method === "GET" && parts.length === 4 && parts[3] === "subscriptions") {
      return jsonResponse(
        200,
        yield* subscriptions.list({ principal, agentId, urlOrigin: origin }),
        meta,
      );
    }
    if (parts[3] === "subscriptions" && parts[4] !== undefined) {
      const subscriptionId = parts[4];
      if (method === "GET" && parts.length === 5) {
        return jsonResponse(
          200,
          yield* subscriptions.get({ principal, agentId, subscriptionId, urlOrigin: origin }),
          meta,
        );
      }
      if (method === "DELETE" && parts.length === 5) {
        return jsonResponse(
          200,
          yield* subscriptions.remove({ principal, agentId, subscriptionId, urlOrigin: origin }),
          meta,
        );
      }
      if (method === "POST" && parts.length === 6 && parts[5] === "events") {
        const delivery = yield* decodeSubscriptionDelivery(yield* jsonBody).pipe(
          Effect.mapError(
            () => new CloudAgentsApiFailure("invalid_request", "Invalid subscription event.", 400),
          ),
        );
        return jsonResponse(
          200,
          yield* subscriptions.deliver({
            principal,
            agentId,
            subscriptionId,
            urlOrigin: origin,
            delivery,
          }),
          meta,
        );
      }
      if (method === "GET" && parts.length === 6 && parts[5] === "receipts") {
        const limit = parseLimitParam(url.searchParams.get("limit"));
        if (limit instanceof CloudAgentsApiFailure) return errorResponse(limit, meta);
        return jsonResponse(
          200,
          yield* subscriptions.listReceipts({ principal, agentId, subscriptionId, limit }),
          meta,
        );
      }
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "runs") {
      const body = yield* decodeCreateRun(yield* jsonBody).pipe(
        Effect.mapError(
          () => new CloudAgentsApiFailure("invalid_request", "Invalid create run request.", 400),
        ),
      );
      return jsonResponse(200, yield* api.createRun({ principal, agentId, body }), meta);
    }
    if (method === "GET" && parts.length === 4 && parts[3] === "runs") {
      const limit = parseLimitParam(url.searchParams.get("limit"));
      if (limit instanceof CloudAgentsApiFailure) return errorResponse(limit, meta);
      const cursor = url.searchParams.get("cursor");
      return jsonResponse(
        200,
        yield* api.listRuns({ principal, agentId, limit, ...(cursor === null ? {} : { cursor }) }),
        meta,
      );
    }
    if (parts[3] === "runs" && parts[4] !== undefined) {
      const runId = parts[4];
      if (method === "GET" && parts.length === 5) {
        return jsonResponse(200, yield* api.getRun({ principal, agentId, runId }), meta);
      }
      if (method === "POST" && parts.length === 6 && parts[5] === "cancel") {
        return jsonResponse(200, yield* api.cancelRun({ principal, agentId, runId }), meta);
      }
      if (method === "GET" && parts.length === 6 && parts[5] === "stream") {
        const lastEventId = request.headers["last-event-id"] ?? undefined;
        const streamed = yield* api.streamRun({
          principal,
          agentId,
          runId,
          ...(lastEventId === undefined || lastEventId.length === 0 ? {} : { lastEventId }),
          nowMs,
        });
        const body = streamed.events.map((event) => encodeSse(event)).join("");
        return HttpServerResponse.text(body, {
          status: 200,
          contentType: "text/event-stream",
          headers: {
            ...meta,
            "cache-control": "no-cache",
            "x-cursor-stream-retention-seconds": String(CLOUD_AGENTS_API_STREAM_RETENTION_SECONDS),
            "x-t3-reconnect-source": streamed.reconnectSource,
          },
        });
      }
      if (method === "GET" && parts.length === 6 && parts[5] === "history") {
        const kindParam = url.searchParams.get("kind") ?? "transcript";
        if (
          kindParam !== "transcript" &&
          kindParam !== "tool" &&
          kindParam !== "setup" &&
          kindParam !== "artifacts"
        ) {
          return errorResponse(
            new CloudAgentsApiFailure("invalid_request", "Unknown history kind.", 400),
            meta,
          );
        }
        const cursor = url.searchParams.get("cursor");
        return jsonResponse(
          200,
          yield* api.listHistory({
            principal,
            agentId,
            runId,
            kind: kindParam,
            ...(cursor === null ? {} : { cursor }),
          }),
          meta,
        );
      }
    }
    return errorResponse(
      new CloudAgentsApiFailure("invalid_request", "Unknown Cloud Agents API route.", 400),
      meta,
    );
  });

const limitsLayer = Layer.effect(
  CloudAgentsApiRateLimits,
  Ref.make<LimitState>({
    minute: new Map(),
    repoMinute: new Map(),
    repoHour: new Map(),
  }),
);

export const cloudAgentsApiRateLimitsLayer = limitsLayer;

export const cloudAgentsApiRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const api = yield* CloudAgentsApi.CloudAgentsApi;
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const schedules = yield* CloudAgentSchedules.CloudAgentSchedules;
    const automations = yield* CloudAgentAutomations.CloudAgentAutomations;
    const assistants = yield* CloudAssistants.CloudAssistants;
    const subscriptions = yield* CloudAgentSubscriptions.CloudAgentSubscriptions;
    const limits = yield* CloudAgentsApiRateLimits;
    return HttpRouter.add(
      "*",
      "/v1*",
      handleV1({ api, keys, schedules, automations, assistants, subscriptions, limits }),
    );
  }),
);
