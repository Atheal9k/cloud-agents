import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import {
  SHARED_BROWSER_BOOTSTRAP_PREFIX,
  SHARED_BROWSER_COOKIE_MAX_AGE_SECONDS,
  SHARED_BROWSER_COOKIE_NAME,
  SharedBrowserGateway,
} from "./SharedBrowserGateway.ts";
import { PREVIEW_GATEWAY_COOKIE_NAME } from "../preview/Gateway.ts";

const GATEWAY_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "none",
  partitioned: true,
} as const;

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "content-security-policy",
  "set-cookie",
  "transfer-encoding",
  "x-frame-options",
]);

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.headers.upgrade?.toLowerCase() === "websocket";

function upstreamOrigin(rawUrl: string): string {
  return new URL(rawUrl).origin;
}

function requestHeaders(request: HttpServerRequest.HttpServerRequest, origin: string) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  headers.origin = origin;
  return headers;
}

function responseHeaders(response: {
  readonly headers: Readonly<Record<string, string | undefined>>;
}) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  headers["cache-control"] = "private, no-store, no-transform";
  headers["referrer-policy"] = "no-referrer";
  return headers;
}

const proxyWebSocket = Effect.fn("SharedBrowserProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  token: string,
  waitUntilRevoked: Effect.Effect<void>,
) {
  const downstream = yield* request.upgrade;
  const protocols = request.headers["sec-websocket-protocol"]
    ?.split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    ...(protocols === undefined || protocols.length === 0 ? {} : { protocols }),
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeDownstream = yield* downstream.writer;
      const writeUpstream = yield* upstream.writer;
      const gateway = yield* SharedBrowserGateway;
      const waitForViewerExpiry = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("1 second");
          if ((yield* gateway.resolve(token)) === null) return;
        }
      });
      yield* Effect.raceFirst(
        Effect.raceFirst(
          Effect.raceFirst(
            upstream.runRaw((data) => writeDownstream(data)),
            downstream.runRaw((data) => writeUpstream(data)),
          ),
          waitUntilRevoked,
        ),
        waitForViewerExpiry,
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("SharedBrowserProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  origin: string,
) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(requestHeaders(request, origin)),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream),
  );
  const response = yield* client.execute(upstreamRequest);
  const headers = responseHeaders(response);
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const bootstrapHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const token = url.value.pathname.slice(SHARED_BROWSER_BOOTSTRAP_PREFIX.length);
  if (token.length === 0 || token.includes("/")) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const gateway = yield* SharedBrowserGateway;
  const target = yield* gateway.resolve(token);
  if (target === null) return HttpServerResponse.text("Viewer expired", { status: 410 });
  return HttpServerResponse.redirect(`/#${encodeURIComponent(target.sessionId)}`, {
    status: 302,
    headers: {
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    },
  }).pipe(
    HttpServerResponse.setCookieUnsafe(SHARED_BROWSER_COOKIE_NAME, token, {
      ...GATEWAY_COOKIE_OPTIONS,
      maxAge: SHARED_BROWSER_COOKIE_MAX_AGE_SECONDS * 1_000,
    }),
    HttpServerResponse.expireCookieUnsafe(PREVIEW_GATEWAY_COOKIE_NAME, GATEWAY_COOKIE_OPTIONS),
  );
});

export const sharedBrowserBootstrapRouteLayer = HttpRouter.add(
  "GET",
  `${SHARED_BROWSER_BOOTSTRAP_PREFIX}*`,
  bootstrapHandler,
);

export const sharedBrowserProxyMiddlewareLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url) || url.value.pathname.startsWith(SHARED_BROWSER_BOOTSTRAP_PREFIX)) {
        return yield* httpEffect;
      }
      const token = request.cookies[SHARED_BROWSER_COOKIE_NAME];
      if (token === undefined) return yield* httpEffect;
      const gateway = yield* SharedBrowserGateway;
      const target = yield* gateway.resolve(token);
      if (target === null) {
        return HttpServerResponse.text("Viewer expired", {
          status: 410,
          headers: {
            "cache-control": "private, no-store",
            "set-cookie": `${SHARED_BROWSER_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0`,
          },
        });
      }
      const origin = upstreamOrigin(target.upstreamUrl);
      const upstreamPath = `${url.value.pathname}${url.value.search}`;
      if (isWebSocketUpgrade(request)) {
        const connection = yield* gateway.attachWebSocket(token);
        if (connection === null) {
          return HttpServerResponse.text("Viewer expired", { status: 410 });
        }
        const connectionOrigin = upstreamOrigin(connection.target.upstreamUrl);
        return yield* proxyWebSocket(
          request,
          `${connectionOrigin.replace(/^http/, "ws")}${upstreamPath}`,
          token,
          connection.waitUntilRevoked,
        ).pipe(Effect.ensuring(gateway.detachWebSocket(connection.connectionId)));
      }
      return yield* proxyHttp(request, `${origin}${upstreamPath}`, origin);
    }),
  { global: true },
);
