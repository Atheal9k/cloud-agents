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
  DEVICE_DISPLAY_ROUTE_PREFIX,
  DeviceDisplayGateway,
  type DeviceDisplayGatewayTarget,
} from "./DeviceDisplayGateway.ts";

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
  "set-cookie",
  "transfer-encoding",
]);

const ALLOWED_GET: ReadonlyArray<RegExp> = [
  /^\/vendor\/serve-sim\/helper\/[^/]+\/(stream\.mjpeg|stream\.avcc|config|health)$/,
  /^\/vendor\/serve-emu\/health$/,
];

const ALLOWED_WS: ReadonlyArray<RegExp> = [
  /^\/vendor\/serve-sim\/helper\/ws$/,
  /^\/vendor\/serve-emu\/ws$/,
];

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.headers.upgrade?.toLowerCase() === "websocket";

function parseRoute(pathname: string): { readonly token: string; readonly rest: string } | null {
  if (!pathname.startsWith(DEVICE_DISPLAY_ROUTE_PREFIX)) return null;
  const remainder = pathname.slice(DEVICE_DISPLAY_ROUTE_PREFIX.length);
  const slash = remainder.indexOf("/");
  if (slash <= 0) return null;
  const token = remainder.slice(0, slash);
  const rest = remainder.slice(slash);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return { token, rest };
}

function deviceQuery(search: string): string | null {
  try {
    return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("device");
  } catch {
    return null;
  }
}

function iosHelperDevice(path: string): string | null {
  const match = path.match(/^\/vendor\/serve-sim\/helper\/([^/]+)\//);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

function allowedGet(path: string, target: DeviceDisplayGatewayTarget): boolean {
  if (!ALLOWED_GET.some((pattern) => pattern.test(path))) return false;
  const helperDevice = iosHelperDevice(path);
  return helperDevice === null || helperDevice === target.deviceId;
}

function allowedSocket(
  path: string,
  search: string,
  target: DeviceDisplayGatewayTarget,
): { readonly ok: true; readonly input: boolean } | { readonly ok: false } {
  if (!ALLOWED_WS.some((pattern) => pattern.test(path))) return { ok: false };
  const device = deviceQuery(search);
  if (device !== target.deviceId) return { ok: false };
  if (path === "/vendor/serve-sim/helper/ws") {
    return target.inputEnabled ? { ok: true, input: true } : { ok: false };
  }
  return { ok: true, input: target.inputEnabled };
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

const proxyWebSocket = Effect.fn("DeviceDisplayProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  token: string,
  waitUntilRevoked: Effect.Effect<void>,
  forwardInput: boolean,
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
      const gateway = yield* DeviceDisplayGateway;
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
            forwardInput
              ? downstream.runRaw((data) => writeUpstream(data))
              : downstream.runRaw(() => Effect.void),
          ),
          waitUntilRevoked,
        ),
        waitForViewerExpiry,
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("DeviceDisplayProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  origin: string,
) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const upstreamRequest = HttpClientRequest.make("GET")(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(requestHeaders(request, origin)),
  );
  const response = yield* client.execute(upstreamRequest);
  const headers = responseHeaders(response);
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

export const deviceDisplayProxyRouteLayer = HttpRouter.add(
  "*",
  `${DEVICE_DISPLAY_ROUTE_PREFIX}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const parsed = parseRoute(url.value.pathname);
    if (parsed === null) return HttpServerResponse.text("Not Found", { status: 404 });
    const gateway = yield* DeviceDisplayGateway;
    const target = yield* gateway.resolve(parsed.token);
    if (target === null) return HttpServerResponse.text("Viewer expired", { status: 410 });
    const origin = new URL(target.upstreamUrl).origin;
    if (isWebSocketUpgrade(request)) {
      const allowed = allowedSocket(parsed.rest, url.value.search, target);
      if (!allowed.ok) return HttpServerResponse.text("Not Found", { status: 404 });
      const connection = yield* gateway.attachWebSocket(parsed.token);
      if (connection === null) return HttpServerResponse.text("Viewer expired", { status: 410 });
      return yield* proxyWebSocket(
        request,
        `${origin.replace(/^http/, "ws")}${parsed.rest}${url.value.search}`,
        parsed.token,
        connection.waitUntilRevoked,
        allowed.input,
      ).pipe(Effect.ensuring(gateway.detachWebSocket(connection.connectionId)));
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (!allowedGet(parsed.rest, target)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* proxyHttp(
      request,
      `${origin}${parsed.rest}${url.value.search}`,
      origin,
    );
  }),
);
