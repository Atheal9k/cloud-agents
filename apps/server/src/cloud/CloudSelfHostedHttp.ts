import {
  CLOUD_SELF_HOSTED_API_PREFIX,
  CloudSelfHostedConnectWorkerRequest,
  CloudSelfHostedRegisterPoolRequest,
  type CloudAgentsApiPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudSelfHosted from "./CloudSelfHosted.ts";
import { CloudSelfHostedFailure } from "./cloudSelfHostedPolicy.ts";
import {
  CloudAgentsApiFailure,
  parseBooleanParam,
  parseCloudAgentsApiAuthorization,
  parseLimitParam,
} from "./cloudAgentsApiModel.ts";

const decodeRegister = Schema.decodeUnknownEffect(CloudSelfHostedRegisterPoolRequest);
const decodeConnect = Schema.decodeUnknownEffect(CloudSelfHostedConnectWorkerRequest);
const decodeClaim = Schema.decodeUnknownEffect(
  Schema.Struct({ id: Schema.String, workerId: Schema.String }),
);
const decodePolicy = Schema.decodeUnknownEffect(
  Schema.Struct({ mode: Schema.Literals(["off", "allow", "require"]) }),
);

function parsePoolLimit(value: string | null) {
  if (value === null || value.length === 0) return 50;
  return parseLimitParam(value);
}

function encodePoolSse(event: { readonly id?: string; readonly event: string; readonly data: unknown }): string {
  return [
    ...(event.id === undefined ? [] : [`id: ${event.id}`]),
    `event: ${event.event}`,
    `data: ${JSON.stringify(event.data)}`,
    "",
    "",
  ].join("\n");
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string>) {
  return HttpServerResponse.jsonUnsafe(body, { status, headers });
}

function errorResponse(error: CloudSelfHostedFailure | CloudAgentsApiFailure, headers: Record<string, string>) {
  return jsonResponse(error.status, error.toBody(), headers);
}

function requireServiceAccount(principal: CloudAgentsApiPrincipal): CloudSelfHostedFailure | undefined {
  if (principal.kind === "service_account") return undefined;
  return new CloudSelfHostedFailure(
    "pool_auth_required",
    "Pool APIs require a service account API key.",
    409,
  );
}

const handlePrivateWorkers = (deps: {
  readonly selfHosted: CloudSelfHosted.CloudSelfHosted["Service"];
  readonly keys: CloudAgentsApiKeys.CloudAgentsApiKeys["Service"];
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = parseCloudAgentsApiAuthorization(request.headers.authorization);
    if (token instanceof CloudAgentsApiFailure) {
      return errorResponse(token, {});
    }
    const principal = yield* deps.keys.authenticate(token);
    if (principal === null) {
      return errorResponse(new CloudAgentsApiFailure("unauthorized", "The API key is invalid.", 401), {});
    }
    const url = new URL(request.url, "http://localhost");
    const method = request.method.toUpperCase();
    const path = url.pathname.replace(/\/$/u, "") || "/";
    const suffix = path.slice(CLOUD_SELF_HOSTED_API_PREFIX.length) || "/";
    const parts = suffix.split("/").filter((part) => part.length > 0);
    const jsonBody = request.json.pipe(
      Effect.mapError(() => new CloudSelfHostedFailure("invalid_request", "JSON body required.", 400)),
    );

    if (method === "GET" && suffix === "/launch-preview") {
      const target = url.searchParams.get("target") ?? "pool";
      if (target !== "cloud" && target !== "pool" && target !== "machine") {
        return errorResponse(
          new CloudSelfHostedFailure("invalid_request", "target must be cloud, pool, or machine.", 400),
          {},
        );
      }
      return jsonResponse(200, yield* deps.selfHosted.launchPreview(target), {});
    }
    if (method === "POST" && suffix === "/settings") {
      const body = yield* decodePolicy(yield* jsonBody).pipe(
        Effect.mapError(() => new CloudSelfHostedFailure("invalid_request", "Invalid policy.", 400)),
      );
      return jsonResponse(200, { mode: yield* deps.selfHosted.setPolicy(body.mode) }, {});
    }
    if (method === "GET" && suffix === "/summary") {
      return jsonResponse(200, yield* deps.selfHosted.summary, {});
    }
    if (method === "GET" && suffix === "/pools") {
      const scope = url.searchParams.get("scope") ?? "all";
      if (scope !== "all" && scope !== "team_pool" && scope !== "personal") {
        return errorResponse(new CloudSelfHostedFailure("invalid_request", "Unknown pool list scope.", 400), {});
      }
      return jsonResponse(
        200,
        yield* deps.selfHosted.listPools({
          scope,
          includeStale: parseBooleanParam(url.searchParams.get("includeStale"), false),
        }),
        {},
      );
    }
    if (method === "POST" && suffix === "/pools") {
      const denied = requireServiceAccount(principal);
      if (denied !== undefined) return errorResponse(denied, {});
      const body = yield* decodeRegister(yield* jsonBody).pipe(
        Effect.mapError(() => new CloudSelfHostedFailure("invalid_request", "Invalid pool registration.", 400)),
      );
      return jsonResponse(200, yield* deps.selfHosted.registerPool(body, principal), {});
    }
    if (method === "DELETE" && suffix === "/pools") {
      const denied = requireServiceAccount(principal);
      if (denied !== undefined) return errorResponse(denied, {});
      const scope = url.searchParams.get("scope");
      const poolName = url.searchParams.get("pool_name");
      if (scope !== "user" && scope !== "team") {
        return errorResponse(new CloudSelfHostedFailure("invalid_request", "scope must be user or team.", 400), {});
      }
      if (poolName === null || poolName.trim().length === 0) {
        return errorResponse(new CloudSelfHostedFailure("invalid_request", "pool_name is required.", 400), {});
      }
      const repoOwner = url.searchParams.get("repo_owner");
      const repoName = url.searchParams.get("repo_name");
      return jsonResponse(
        200,
        yield* deps.selfHosted.deregisterPool({
          scope,
          poolName,
          ...(repoOwner === null ? {} : { repoOwner }),
          ...(repoName === null ? {} : { repoName }),
        }),
        {},
      );
    }
    if (method === "GET" && suffix === "/pending-requests") {
      const denied = requireServiceAccount(principal);
      if (denied !== undefined) return errorResponse(denied, {});
      const limit = parsePoolLimit(url.searchParams.get("limit"));
      if (limit instanceof CloudAgentsApiFailure) return errorResponse(limit, {});
      const pageToken = url.searchParams.get("pageToken");
      const repository = url.searchParams.get("repository");
      const pool = url.searchParams.get("pool");
      return jsonResponse(
        200,
        yield* deps.selfHosted.listPending({
          limit,
          ...(pageToken === null ? {} : { pageToken }),
          ...(repository === null ? {} : { repository }),
          ...(pool === null ? {} : { pool }),
        }),
        {},
      );
    }
    if (method === "GET" && suffix === "/pending-requests/stream") {
      const denied = requireServiceAccount(principal);
      if (denied !== undefined) return errorResponse(denied, {});
      const cursor = url.searchParams.get("cursor") ?? request.headers["last-event-id"];
      if (cursor === undefined || cursor.length === 0) {
        return errorResponse(new CloudSelfHostedFailure("invalid_request", "cursor is required.", 400), {});
      }
      const lastEventId = request.headers["last-event-id"];
      const repository = url.searchParams.get("repository");
      const pool = url.searchParams.get("pool");
      const streamed = yield* deps.selfHosted.watchPending({
        cursor,
        ...(lastEventId === undefined || lastEventId.length === 0 ? {} : { lastEventId }),
        ...(repository === null || repository.length === 0 ? {} : { repository }),
        ...(pool === null || pool.length === 0 ? {} : { pool }),
      });
      return HttpServerResponse.text(streamed.events.map((event) => encodePoolSse(event)).join(""), {
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
      });
    }
    if (method === "POST" && suffix === "/claim") {
      const denied = requireServiceAccount(principal);
      if (denied !== undefined) return errorResponse(denied, {});
      const body = yield* decodeClaim(yield* jsonBody).pipe(
        Effect.mapError(() => new CloudSelfHostedFailure("invalid_request", "id and workerId are required.", 400)),
      );
      return jsonResponse(200, yield* deps.selfHosted.claim(body), {});
    }
    if (method === "POST" && parts[0] === "claims" && parts[2] === "release" && parts[1] !== undefined) {
      const denied = requireServiceAccount(principal);
      if (denied !== undefined) return errorResponse(denied, {});
      return jsonResponse(200, yield* deps.selfHosted.release(parts[1]), {});
    }
    if (method === "POST" && suffix === "/connect") {
      const body = yield* decodeConnect(yield* jsonBody).pipe(
        Effect.mapError(() => new CloudSelfHostedFailure("invalid_request", "Invalid worker connect payload.", 400)),
      );
      return jsonResponse(200, yield* deps.selfHosted.connectWorker(body, principal), {});
    }
    if (method === "POST" && parts[0] !== undefined && parts[1] === "disconnect") {
      yield* deps.selfHosted.disconnectWorker(parts[0]);
      return jsonResponse(200, { disconnected: true }, {});
    }
    if (method === "POST" && parts[0] !== undefined && parts[1] === "idle-release") {
      yield* deps.selfHosted.idleRelease(parts[0]);
      return jsonResponse(200, { released: true }, {});
    }
    if (
      method === "GET" &&
      parts.length === 2 &&
      parts[0] !== undefined &&
      (parts[1] === "healthz" || parts[1] === "readyz" || parts[1] === "metrics")
    ) {
      const probed = yield* deps.selfHosted.management(`/${parts[1]}`, parts[0]);
      return HttpServerResponse.text(probed.body, {
        status: probed.status,
        contentType: probed.contentType,
      });
    }
    if (method === "GET" && suffix === "") {
      const status = url.searchParams.get("status") ?? "all";
      const scope = url.searchParams.get("scope") ?? "all";
      if (status !== "all" && status !== "in_use" && status !== "idle") {
        return errorResponse(new CloudSelfHostedFailure("invalid_request", "Unknown worker status filter.", 400), {});
      }
      if (scope !== "all" && scope !== "team_pool" && scope !== "personal") {
        return errorResponse(new CloudSelfHostedFailure("invalid_request", "Unknown worker scope filter.", 400), {});
      }
      const limit = parsePoolLimit(url.searchParams.get("limit"));
      if (limit instanceof CloudAgentsApiFailure) return errorResponse(limit, {});
      const pageToken = url.searchParams.get("pageToken");
      return jsonResponse(
        200,
        yield* deps.selfHosted.listWorkers({
          status,
          scope,
          limit,
          ...(pageToken === null ? {} : { pageToken }),
        }),
        {},
      );
    }
    if (method === "GET" && parts.length === 1 && parts[0] !== undefined && parts[0] !== "pools") {
      const worker = yield* deps.selfHosted.getWorker(parts[0]);
      if (worker === undefined) {
        return errorResponse(new CloudSelfHostedFailure("invalid_request", "Worker not found.", 404), {});
      }
      return jsonResponse(200, worker, {});
    }
    return errorResponse(
      new CloudSelfHostedFailure("invalid_request", "Unknown self-hosted worker route.", 400),
      {},
    );
  }).pipe(
    Effect.catchIf(
      (error): error is CloudSelfHostedFailure => error instanceof CloudSelfHostedFailure,
      (error) => Effect.succeed(errorResponse(error, {})),
    ),
    Effect.catchCause(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { code: "internal_error", message: "The self-hosted pool API failed." },
          { status: 500 },
        ),
      ),
    ),
  );

export const cloudSelfHostedRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const selfHosted = yield* CloudSelfHosted.CloudSelfHosted;
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    return HttpRouter.add("*", `${CLOUD_SELF_HOSTED_API_PREFIX}*`, handlePrivateWorkers({ selfHosted, keys }));
  }),
);
