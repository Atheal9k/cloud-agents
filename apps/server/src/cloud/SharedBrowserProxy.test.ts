import { SharedBrowserViewerId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  SHARED_BROWSER_BOOTSTRAP_PREFIX,
  SHARED_BROWSER_COOKIE_NAME,
  SharedBrowserGateway,
} from "./SharedBrowserGateway.ts";
import {
  sharedBrowserBootstrapRouteLayer,
  sharedBrowserProxyMiddlewareLayer,
} from "./SharedBrowserProxy.ts";
import { PREVIEW_GATEWAY_COOKIE_NAME } from "../preview/Gateway.ts";

const TOKEN = "a".repeat(43);
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function fixture() {
  const requests: Array<{
    readonly url: string;
    readonly authorization: string | undefined;
    readonly cookie: string | undefined;
  }> = [];
  const client = HttpClient.make((request) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response("<main>dcv</main>", {
          headers: {
            "content-security-policy": "frame-ancestors 'none'",
            "set-cookie": "dcv-secret=leak",
            "x-frame-options": "DENY",
          },
        }),
      ),
    );
  });
  const gateway = SharedBrowserGateway.of({
    issue: () => Effect.die("not used"),
    keepAlive: () => Effect.die("not used"),
    takeControl: () => Effect.die("not used"),
    returnControl: () => Effect.die("not used"),
    release: () => Effect.die("not used"),
    attachWebSocket: () => Effect.die("not used"),
    detachWebSocket: () => Effect.die("not used"),
    resolve: (token) =>
      Effect.succeed(
        token === TOKEN
          ? {
              viewerId: SharedBrowserViewerId.make("viewer-1"),
              threadId: ThreadId.make("thread-allocation-1-2"),
              upstreamUrl: "http://127.0.0.1:8090",
              sessionId: "t3-allocation-1-2",
              expiresAtMillis: Date.parse("2099-01-01T00:00:00.000Z"),
            }
          : null,
      ),
  });
  const fallback = HttpRouter.add("*", "/*", HttpServerResponse.text("t3"));
  const routes = Layer.mergeAll(sharedBrowserBootstrapRouteLayer, fallback).pipe(
    Layer.provide(sharedBrowserProxyMiddlewareLayer),
    Layer.provideMerge(Layer.succeed(SharedBrowserGateway, gateway)),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  disposers.push(dispose);
  return { handler, requests };
}

describe("shared browser proxy", () => {
  it("bootstraps a partitioned cookie into the attempt session", async () => {
    const { handler } = fixture();
    const response = await handler(
      new Request(`https://worker.test${SHARED_BROWSER_BOOTSTRAP_PREFIX}${TOKEN}`),
    );
    expect(response.status, await response.clone().text()).toBe(302);
    expect(response.headers.get("location")).toBe("/#t3-allocation-1-2");
    expect(response.headers.get("set-cookie")).toContain(`${SHARED_BROWSER_COOKIE_NAME}=${TOKEN}`);
    expect(response.headers.get("set-cookie")).toContain(`${PREVIEW_GATEWAY_COOKIE_NAME}=`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain("Partitioned");
  });

  it("proxies DCV without forwarding T3 credentials or frame-denial headers", async () => {
    const { handler, requests } = fixture();
    const response = await handler(
      new Request("https://worker.test/app.js", {
        headers: {
          authorization: "Bearer t3-secret",
          cookie: `${SHARED_BROWSER_COOKIE_NAME}=${TOKEN}; t3_session=session-secret`,
        },
      }),
    );
    expect(await response.text()).toBe("<main>dcv</main>");
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:8090/app.js",
        authorization: undefined,
        cookie: undefined,
      },
    ]);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it("does not fall through to T3 after a viewer expires", async () => {
    const { handler, requests } = fixture();
    const response = await handler(
      new Request("https://worker.test/api/server", {
        headers: { cookie: `${SHARED_BROWSER_COOKIE_NAME}=${"b".repeat(43)}` },
      }),
    );
    expect(response.status).toBe(410);
    expect(requests).toEqual([]);
  });
});
