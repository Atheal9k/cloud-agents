import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Clock from "effect/Clock";
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
  PREVIEW_GATEWAY_BOOTSTRAP_PREFIX,
  PREVIEW_GATEWAY_COOKIE_NAME,
  PreviewGateway,
  type PreviewGatewayTarget,
} from "./Gateway.ts";

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

const PREVIEW_SANDBOX_POLICY =
  "sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.headers.upgrade?.toLowerCase() === "websocket";

function upstreamOrigin(target: PreviewGatewayTarget): string {
  const hostname = target.protocol === "https" ? "localhost" : "127.0.0.1";
  return `${target.protocol}://${hostname}:${target.port}`;
}

function requestHeaders(request: HttpServerRequest.HttpServerRequest, origin: string) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  if (request.headers.origin !== undefined) headers.origin = origin;
  return headers;
}

function responseHeaders(
  response: { readonly headers: Readonly<Record<string, string | undefined>> },
  origin: string,
) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
    if (name === "location") {
      try {
        const location = new URL(value, origin);
        if (location.origin === origin) {
          headers.location = `${location.pathname}${location.search}${location.hash}`;
          continue;
        }
      } catch {
        // Preserve malformed upstream locations so the browser reports them.
      }
    }
    headers[name] = value;
  }
  const contentType = headers["content-type"]?.toLowerCase() ?? "";
  if (contentType.startsWith("text/html") || contentType.startsWith("application/xhtml+xml")) {
    headers["content-security-policy"] = PREVIEW_SANDBOX_POLICY;
    headers["referrer-policy"] = "no-referrer";
  }
  headers["cache-control"] = "no-store, no-transform";
  return headers;
}

const proxyWebSocket = Effect.fn("PreviewGatewayProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
) {
  const downstream = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, { openTimeout: "10 seconds" }).pipe(
    Effect.provide(NodeSocket.layerWebSocketConstructor),
  );
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeDownstream = yield* downstream.writer;
      const writeUpstream = yield* upstream.writer;
      yield* Effect.raceFirst(
        upstream.runRaw((data) => writeDownstream(data)),
        downstream.runRaw((data) => writeUpstream(data)),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("PreviewGatewayProxy.proxyHttp")(function* (
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
  const headers = responseHeaders(response, origin);
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
  const token = url.value.pathname.slice(PREVIEW_GATEWAY_BOOTSTRAP_PREFIX.length);
  if (token.length === 0 || token.includes("/")) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const gateway = yield* PreviewGateway;
  const target = yield* gateway.resolve(token);
  if (target === null) return HttpServerResponse.text("Preview expired", { status: 410 });
  const nowMillis = yield* Clock.currentTimeMillis;
  const maxAge = Math.max(1, Math.ceil((target.expiresAtMillis - nowMillis) / 1_000));
  return HttpServerResponse.redirect(target.initialPath, {
    status: 302,
    headers: {
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": `${PREVIEW_GATEWAY_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`,
    },
  });
});

export const previewGatewayBootstrapRouteLayer = HttpRouter.add(
  "GET",
  `${PREVIEW_GATEWAY_BOOTSTRAP_PREFIX}*`,
  bootstrapHandler,
);

export const previewGatewayProxyMiddlewareLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url) || url.value.pathname.startsWith(PREVIEW_GATEWAY_BOOTSTRAP_PREFIX)) {
        return yield* httpEffect;
      }
      const token = request.cookies[PREVIEW_GATEWAY_COOKIE_NAME];
      if (token === undefined) return yield* httpEffect;
      const gateway = yield* PreviewGateway;
      const target = yield* gateway.resolve(token);
      if (target === null) {
        return HttpServerResponse.text("Preview expired", {
          status: 410,
          headers: {
            "cache-control": "private, no-store",
            "set-cookie": `${PREVIEW_GATEWAY_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0`,
          },
        });
      }
      const origin = upstreamOrigin(target);
      const upstreamPath = `${url.value.pathname}${url.value.search}`;
      if (isWebSocketUpgrade(request)) {
        return yield* proxyWebSocket(request, `${origin.replace(/^http/, "ws")}${upstreamPath}`);
      }
      return yield* proxyHttp(request, `${origin}${upstreamPath}`, origin);
    }),
  { global: true },
);
