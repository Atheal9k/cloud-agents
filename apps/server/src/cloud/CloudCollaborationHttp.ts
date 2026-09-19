import {
  CloudCollaborationError,
  CloudGithubTriggerDefinition,
  type CloudRunEntryPoint,
  type CloudScmConnectionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudCollaboration from "./CloudCollaboration.ts";
import * as CloudGithubTriggers from "./CloudGithubTriggers.ts";
import {
  CloudAgentsApiFailure,
  parseCloudAgentsApiAuthorization,
  parseLimitParam,
} from "./cloudAgentsApiModel.ts";
import { admitCloudRun } from "./cloudCollaborationAdmit.ts";
import { parseIntegrationDelivery } from "./cloudCollaborationPolicy.ts";

const decodeConnection = Schema.decodeUnknownEffect(
  Schema.Struct({
    kind: Schema.Literals([
      "github",
      "github-enterprise",
      "gitlab",
      "gitlab-self-hosted",
      "bitbucket",
      "azure-devops",
    ]),
    displayName: Schema.String,
    baseUrl: Schema.String,
    installedRepositories: Schema.Array(Schema.String),
  }),
);

const decodeGithubTrigger = Schema.decodeUnknownEffect(CloudGithubTriggerDefinition);

const decodeAdmit = Schema.decodeUnknownEffect(
  Schema.Struct({
    entryPoint: Schema.Literals([
      "web",
      "desktop",
      "api",
      "slack",
      "github-mention",
      "bitbucket-mention",
      "linear",
    ]),
    deliveryId: Schema.String,
    prompt: Schema.Struct({ text: Schema.String }),
    agentId: Schema.optionalKey(Schema.String),
    repos: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          url: Schema.String,
          startingRef: Schema.optionalKey(Schema.String),
          prUrl: Schema.optionalKey(Schema.String),
        }),
      ),
    ),
  }),
);

function jsonResponse(status: number, body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, { status });
}

function errorResponse(error: CloudAgentsApiFailure) {
  return jsonResponse(error.status, error.toBody());
}

const ENTRY_BY_PATH: Record<string, CloudRunEntryPoint> = {
  "/v1/integrations/slack/events": "slack",
  "/v1/integrations/github/mentions": "github-mention",
  "/v1/integrations/bitbucket/mentions": "bitbucket-mention",
  "/v1/integrations/linear/webhooks": "linear",
};

const handleIntegrations = (deps: {
  readonly keys: CloudAgentsApiKeys.CloudAgentsApiKeys["Service"];
  readonly collaboration: CloudCollaboration.CloudCollaboration["Service"];
  readonly githubTriggers: CloudGithubTriggers.CloudGithubTriggers["Service"];
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname.replace(/\/$/u, "") || "/";
    const method = request.method.toUpperCase();
    const webhookPrefix = "/v1/integrations/github/webhooks/";
    if (method === "POST" && path.startsWith(webhookPrefix)) {
      const triggerId = path.slice(webhookPrefix.length);
      if (triggerId.length === 0) {
        return errorResponse(
          new CloudAgentsApiFailure("invalid_request", "GitHub trigger id is required.", 400),
        );
      }
      const body = yield* request.text.pipe(
        Effect.mapError(
          () => new CloudAgentsApiFailure("invalid_request", "Webhook body is required.", 400),
        ),
      );
      const result = yield* deps.githubTriggers.receive({
        triggerId,
        deliveryId: request.headers["x-github-delivery"] ?? "",
        event: request.headers["x-github-event"] ?? "",
        signature: request.headers["x-hub-signature-256"],
        body,
      });
      return jsonResponse(result.reused ? 200 : 202, result);
    }
    const authorization = parseCloudAgentsApiAuthorization(request.headers.authorization);
    if (authorization instanceof CloudAgentsApiFailure) return errorResponse(authorization);
    const principal = yield* deps.keys.authenticate(authorization);
    if (principal === null) {
      return errorResponse(new CloudAgentsApiFailure("unauthorized", "Unknown API key.", 401));
    }
    const host = request.headers.host;
    const proto = request.headers["x-forwarded-proto"] ?? "http";
    const origin = host === undefined ? "http://localhost" : `${proto}://${host}`;
    const jsonBody = request.json.pipe(
      Effect.mapError(
        () => new CloudAgentsApiFailure("invalid_request", "JSON body required.", 400),
      ),
    );

    if (method === "GET" && path === "/v1/integrations/scm") {
      return jsonResponse(200, { items: yield* deps.collaboration.listConnections() });
    }
    if (method === "POST" && path === "/v1/integrations/scm") {
      const body = yield* decodeConnection(yield* jsonBody).pipe(
        Effect.mapError(
          () => new CloudAgentsApiFailure("invalid_request", "Invalid SCM connection.", 400),
        ),
      );
      const connection = yield* deps.collaboration.connect(body as CloudScmConnectionInput);
      return jsonResponse(200, connection);
    }
    if (method === "DELETE" && path.startsWith("/v1/integrations/scm/")) {
      const id = path.slice("/v1/integrations/scm/".length);
      yield* deps.collaboration.disconnect(id);
      return jsonResponse(200, { id });
    }

    if (method === "POST" && path === "/v1/integrations/github/triggers") {
      const definition = yield* decodeGithubTrigger(yield* jsonBody).pipe(
        Effect.mapError(
          () => new CloudAgentsApiFailure("invalid_request", "Invalid GitHub trigger.", 400),
        ),
      );
      return jsonResponse(
        201,
        yield* deps.githubTriggers.create({ principal, definition, urlOrigin: origin }),
      );
    }
    if (method === "GET" && path === "/v1/integrations/github/triggers") {
      return jsonResponse(200, yield* deps.githubTriggers.list({ principal }));
    }
    if (method === "GET" && path === "/v1/integrations/github/trigger-activities") {
      const limit = parseLimitParam(url.searchParams.get("limit"));
      if (limit instanceof CloudAgentsApiFailure) return errorResponse(limit);
      const triggerId = url.searchParams.get("triggerId");
      return jsonResponse(
        200,
        yield* deps.githubTriggers.listActivities({
          principal,
          limit,
          ...(triggerId === null ? {} : { triggerId }),
        }),
      );
    }
    const githubTriggerPrefix = "/v1/integrations/github/triggers/";
    if (path.startsWith(githubTriggerPrefix)) {
      const suffix = path.slice(githubTriggerPrefix.length);
      const [triggerId, action] = suffix.split("/");
      if (triggerId !== undefined && triggerId.length > 0) {
        if (method === "GET" && action === undefined) {
          return jsonResponse(200, yield* deps.githubTriggers.get({ principal, triggerId }));
        }
        if (method === "DELETE" && action === undefined) {
          return jsonResponse(200, yield* deps.githubTriggers.remove({ principal, triggerId }));
        }
        if (method === "POST" && action === "disable") {
          return jsonResponse(200, yield* deps.githubTriggers.disable({ principal, triggerId }));
        }
        if (method === "POST" && action === "enable") {
          return jsonResponse(200, yield* deps.githubTriggers.enable({ principal, triggerId }));
        }
      }
    }

    const webhookEntry = ENTRY_BY_PATH[path];
    if (method === "POST" && webhookEntry !== undefined) {
      const payload = yield* jsonBody;
      const parsed = parseIntegrationDelivery({ entryPoint: webhookEntry, payload });
      if (parsed === undefined) {
        return errorResponse(
          new CloudAgentsApiFailure(
            "invalid_request",
            "The integration payload is missing a delivery id.",
            400,
          ),
        );
      }
      const admitted = yield* admitCloudRun({
        principal,
        urlOrigin: origin,
        entryPoint: webhookEntry,
        deliveryId: parsed.deliveryId,
        prompt: { text: parsed.prompt },
        ...(parsed.agentId === undefined ? {} : { agentId: parsed.agentId }),
      });
      return jsonResponse(admitted.reused ? 200 : 201, admitted);
    }

    if (method === "POST" && path === "/v1/integrations/runs") {
      const body = yield* decodeAdmit(yield* jsonBody).pipe(
        Effect.mapError(
          () => new CloudAgentsApiFailure("invalid_request", "Invalid integration run.", 400),
        ),
      );
      const admitted = yield* admitCloudRun({
        principal,
        urlOrigin: origin,
        entryPoint: body.entryPoint,
        deliveryId: body.deliveryId,
        prompt: body.prompt,
        ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
        ...(body.repos === undefined
          ? {}
          : {
              create: {
                prompt: body.prompt,
                repos: body.repos,
                ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
              },
            }),
      });
      return jsonResponse(admitted.reused ? 200 : 201, admitted);
    }

    return errorResponse(
      new CloudAgentsApiFailure("invalid_request", "Unknown collaboration route.", 400),
    );
  }).pipe(
    Effect.catchIf(
      (error): error is CloudAgentsApiFailure => error instanceof CloudAgentsApiFailure,
      (error) => Effect.succeed(errorResponse(error)),
    ),
    Effect.catchIf(Schema.is(CloudCollaborationError), (error) =>
      Effect.succeed(errorResponse(CloudCollaboration.mapCollaborationFailure(error))),
    ),
    Effect.catchCause(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { code: "internal_error", message: "The collaboration route failed." },
          { status: 500 },
        ),
      ),
    ),
  );

export const cloudCollaborationRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const collaboration = yield* CloudCollaboration.CloudCollaboration;
    const githubTriggers = yield* CloudGithubTriggers.CloudGithubTriggers;
    yield* CloudAgentsApi.CloudAgentsApi;
    return HttpRouter.add(
      "*",
      "/v1/integrations*",
      handleIntegrations({ keys, collaboration, githubTriggers }),
    );
  }),
);
