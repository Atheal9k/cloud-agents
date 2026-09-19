// @effect-diagnostics nodeBuiltinImport:off
/**
 * The runtime-local identity endpoint. It listens on a Unix socket inside the
 * guest (a named pipe on Windows, so the same code is testable on a developer
 * machine) and answers three things: non-secret runtime metadata, a
 * five-minute OIDC token, and the JWKS that verifies it. Nothing is reachable
 * over the network, so filesystem permissions are the authorization boundary.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import {
  CLOUD_RUNTIME_IDENTITY_JWKS_PATH,
  CLOUD_RUNTIME_IDENTITY_METADATA_PATH,
  CLOUD_RUNTIME_IDENTITY_RATE_LIMIT_PER_MINUTE,
  CLOUD_RUNTIME_IDENTITY_TOKEN_PATH,
  CLOUD_RUNTIME_TOKEN_TTL_SECONDS,
  CloudSecurityError,
  type CloudEgressPolicy,
  type CloudJsonWebKeySet,
  type CloudRuntimeIdentitySubject,
  type CloudRuntimeMetadata,
  type CloudRuntimeToken,
  type CloudSecretBinding,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { consumeRateLimit, type RateLimitWindow } from "./cloudAgentsApiModel.ts";
import {
  CLOUD_RUNTIME_IDENTITY_DEFAULTS,
  cloudRuntimeJwks,
  cloudRuntimeSigningKey,
  signCloudRuntimeToken,
  type CloudRuntimeSigningKey,
} from "./cloudRuntimeIdentityToken.ts";
import { cloudRuntimeIdentityClaims } from "./cloudSecurityPolicy.ts";

export interface CloudRuntimeIdentitySession {
  readonly subject: CloudRuntimeIdentitySubject;
  readonly egress: CloudEgressPolicy;
  /** Names and availability only; the socket never serves secret values. */
  readonly secrets: ReadonlyArray<CloudSecretBinding>;
}

export interface CloudRuntimeIdentityOptions {
  readonly socketPath: string;
  readonly session: CloudRuntimeIdentitySession;
  readonly keyPair: { readonly privateKey: string; readonly publicKey: string };
  readonly issuer?: string | undefined;
  readonly audience?: string | undefined;
}

export interface CloudRuntimeIdentityHandle {
  readonly socketPath: string;
  readonly jwks: CloudJsonWebKeySet;
  readonly key: CloudRuntimeSigningKey;
}

const JsonBody = Schema.fromJsonString(Schema.Unknown);
const toJson = Schema.encodeSync(JsonBody);
const fromJson = Schema.decodeUnknownSync(JsonBody);

/**
 * One socket per runtime, under a directory only the runtime user can enter.
 * Windows has no Unix sockets in this position, so a named pipe stands in and
 * the guest never sees the difference.
 */
export function cloudRuntimeIdentitySocketPath(input: {
  readonly runtimeId: string;
  readonly directory?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}): string {
  const safeId = input.runtimeId.replaceAll(/[^A-Za-z0-9_-]/g, "-");
  const platform = input.platform ?? HostProcessPlatform.defaultValue();
  if (platform === "win32") return `\\\\.\\pipe\\t3-cloud-identity-${safeId}`;
  return NodePath.join(input.directory ?? "/run/t3-cloud", safeId, "identity.sock");
}

function identityError(message: string, cause?: unknown): CloudSecurityError {
  return new CloudSecurityError({
    reason: "identity-unavailable",
    message: cause === undefined ? message : `${message} (${String(cause)})`,
  });
}

const prepareSocketPath = (socketPath: string, isWindows: boolean) =>
  isWindows
    ? Effect.void
    : Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(NodePath.dirname(socketPath), { recursive: true, mode: 0o700 });
          await NodeFSP.rm(socketPath, { force: true });
        },
        catch: (cause) => identityError("Could not prepare the identity socket path.", cause),
      });

const removeSocketPath = (socketPath: string, isWindows: boolean) =>
  isWindows
    ? Effect.void
    : Effect.promise(() => NodeFSP.rm(socketPath, { force: true }).catch(() => undefined));

function metadataOf(session: CloudRuntimeIdentitySession, issuer: string): CloudRuntimeMetadata {
  return {
    agentId: session.subject.agentId,
    runId: session.subject.runId,
    ownerId: session.subject.ownerId,
    workspaceId: session.subject.workspaceId,
    environmentId: session.subject.environmentId,
    repositories: session.subject.repositories,
    hosting: session.subject.hosting,
    issuer,
    jwksPath: CLOUD_RUNTIME_IDENTITY_JWKS_PATH,
    tokenPath: CLOUD_RUNTIME_IDENTITY_TOKEN_PATH,
    tokenTtlSeconds: CLOUD_RUNTIME_TOKEN_TTL_SECONDS,
    egress: session.egress,
    secrets: session.secrets,
  };
}

function mintToken(input: {
  readonly session: CloudRuntimeIdentitySession;
  readonly key: CloudRuntimeSigningKey;
  readonly issuer: string;
  readonly audience: string;
  readonly nowMs: number;
}): CloudRuntimeToken {
  const claims = cloudRuntimeIdentityClaims({
    subject: input.session.subject,
    issuer: input.issuer,
    audience: input.audience,
    nowSeconds: Math.floor(input.nowMs / 1000),
    jti: NodeCrypto.randomUUID(),
  });
  return {
    token: signCloudRuntimeToken({ claims, key: input.key }),
    tokenType: "Bearer",
    expiresIn: claims.exp - claims.iat,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(claims.exp * 1000)),
    claims,
  };
}

/**
 * Starts the endpoint for the life of the calling scope. The rate limiter is a
 * single window because there is exactly one caller: the guest this socket
 * belongs to.
 */
export const serveCloudRuntimeIdentity = Effect.fn("serveCloudRuntimeIdentity")(function* (
  options: CloudRuntimeIdentityOptions,
) {
  const key = cloudRuntimeSigningKey(options.keyPair);
  const jwks = cloudRuntimeJwks([key]);
  const issuer = options.issuer ?? CLOUD_RUNTIME_IDENTITY_DEFAULTS.issuer;
  const audience = options.audience ?? CLOUD_RUNTIME_IDENTITY_DEFAULTS.audience;
  // The handler is a synchronous Node callback, so it reads the clock directly
  // rather than suspending; tests can still drive it through a TestClock.
  const clock = yield* Clock.Clock;
  const isWindows = (yield* HostProcessPlatform) === "win32";
  let tokenWindow: RateLimitWindow | undefined;

  const respond = (
    response: NodeHttp.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    });
    response.end(toJson(body));
  };

  const handle = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (path === CLOUD_RUNTIME_IDENTITY_JWKS_PATH && request.method === "GET") {
      respond(response, 200, jwks, { "cache-control": "max-age=300" });
      return;
    }
    if (path === CLOUD_RUNTIME_IDENTITY_METADATA_PATH && request.method === "GET") {
      respond(response, 200, metadataOf(options.session, issuer));
      return;
    }
    if (
      path === CLOUD_RUNTIME_IDENTITY_TOKEN_PATH &&
      (request.method === "GET" || request.method === "POST")
    ) {
      const nowMs = clock.currentTimeMillisUnsafe();
      const limited = consumeRateLimit({
        window: tokenWindow,
        nowMs,
        limit: CLOUD_RUNTIME_IDENTITY_RATE_LIMIT_PER_MINUTE,
        windowMs: 60_000,
      });
      tokenWindow = limited.window;
      const rateHeaders = {
        "x-ratelimit-limit": String(limited.decision.limit),
        "x-ratelimit-remaining": String(limited.decision.remaining),
        "x-ratelimit-reset": String(Math.ceil(limited.decision.resetAtMs / 1000)),
      };
      if (!limited.decision.allowed) {
        respond(
          response,
          429,
          {
            reason: "rate-limited",
            message: `Identity tokens are limited to ${CLOUD_RUNTIME_IDENTITY_RATE_LIMIT_PER_MINUTE} per minute.`,
          },
          {
            ...rateHeaders,
            "retry-after": String(
              Math.max(1, Math.ceil((limited.decision.resetAtMs - nowMs) / 1000)),
            ),
          },
        );
        return;
      }
      respond(
        response,
        200,
        mintToken({ session: options.session, key, issuer, audience, nowMs }),
        rateHeaders,
      );
      return;
    }
    respond(response, 404, {
      reason: "identity-unavailable",
      message: `No runtime identity resource at '${path}'.`,
    });
  };

  yield* prepareSocketPath(options.socketPath, isWindows);
  const _server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server, CloudSecurityError>((resume) => {
      const created = NodeHttp.createServer(handle);
      created.once("error", (cause) =>
        resume(Effect.fail(identityError("Could not start the runtime identity socket.", cause))),
      );
      created.listen(options.socketPath, () => resume(Effect.succeed(created)));
    }),
    (created) =>
      Effect.callback<void>((resume) => {
        created.closeAllConnections();
        created.close(() => resume(Effect.void));
      }).pipe(Effect.andThen(removeSocketPath(options.socketPath, isWindows))),
  );
  // The directory already excludes other users; tighten the socket too, so a
  // shared /run does not hand the endpoint to anything else on the host.
  if (!isWindows) {
    yield* Effect.promise(() => NodeFSP.chmod(options.socketPath, 0o600).catch(() => undefined));
  }
  return { socketPath: options.socketPath, jwks, key } satisfies CloudRuntimeIdentityHandle;
});

export interface CloudRuntimeIdentityResponse {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: unknown;
}

/** Guest-side client, used by the worker and by the verification tests. */
export const requestCloudRuntimeIdentity = (input: {
  readonly socketPath: string;
  readonly path: string;
  readonly method?: "GET" | "POST";
}): Effect.Effect<CloudRuntimeIdentityResponse, CloudSecurityError> =>
  Effect.callback<CloudRuntimeIdentityResponse, CloudSecurityError>((resume) => {
    const request = NodeHttp.request(
      { socketPath: input.socketPath, path: input.path, method: input.method ?? "GET" },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("error", (cause) =>
          resume(Effect.fail(identityError("The identity socket response failed.", cause))),
        );
        incoming.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resume(
            Effect.sync(() => ({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: text.length === 0 ? undefined : fromJson(text),
            })),
          );
        });
      },
    );
    request.once("error", (cause) =>
      resume(Effect.fail(identityError("Could not reach the identity socket.", cause))),
    );
    request.end();
    return Effect.sync(() => request.destroy());
  });
