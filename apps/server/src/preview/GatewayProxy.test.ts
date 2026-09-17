import { ThreadId } from "@t3tools/contracts";
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
  PREVIEW_GATEWAY_BOOTSTRAP_PREFIX,
  PREVIEW_GATEWAY_COOKIE_NAME,
  PreviewGateway,
} from "./Gateway.ts";
import {
  previewGatewayBootstrapRouteLayer,
  previewGatewayProxyMiddlewareLayer,
} from "./GatewayProxy.ts";

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
        new Response("<main>app</main>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "set-cookie": "app-secret=leak",
          },
        }),
      ),
    );
  });
  const gateway = PreviewGateway.of({
    issue: () => Effect.die("not used"),
    resolve: (token) =>
      Effect.succeed(
        token === TOKEN
          ? {
              threadId: ThreadId.make("thread-allocation-1-2"),
              port: 5173,
              protocol: "http",
              initialPath: "/dashboard",
              expiresAtMillis: Date.now() + 60_000,
              pid: 42,
              terminalId: "terminal-1",
            }
          : null,
      ),
  });
  const fallback = HttpRouter.add("*", "/*", HttpServerResponse.text("t3"));
  const routes = Layer.mergeAll(previewGatewayBootstrapRouteLayer, fallback).pipe(
    Layer.provide(previewGatewayProxyMiddlewareLayer),
    Layer.provideMerge(Layer.succeed(PreviewGateway, gateway)),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  disposers.push(dispose);
  return { handler, requests };
}

describe("preview gateway proxy", () => {
  it("bootstraps an isolated partitioned cookie and redirects to the app path", async () => {
    const { handler } = fixture();
    const response = await handler(
      new Request(`https://worker.test${PREVIEW_GATEWAY_BOOTSTRAP_PREFIX}${TOKEN}`),
    );
    expect(response.status, await response.clone().text()).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(response.headers.get("set-cookie")).toContain(`${PREVIEW_GATEWAY_COOKIE_NAME}=${TOKEN}`);
    expect(response.headers.get("set-cookie")).toContain("Partitioned");
  });

  it("proxies every app path without forwarding T3 credentials", async () => {
    const { handler, requests } = fixture();
    const response = await handler(
      new Request("https://worker.test/api/data?view=full", {
        headers: {
          authorization: "Bearer t3-secret",
          cookie: `${PREVIEW_GATEWAY_COOKIE_NAME}=${TOKEN}; t3_session=session-secret`,
        },
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.text()).toBe("<main>app</main>");
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:5173/api/data?view=full",
        authorization: undefined,
        cookie: undefined,
      },
    ]);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
  });

  it("leaves ordinary T3 requests alone when no preview grant is present", async () => {
    const { handler, requests } = fixture();
    const response = await handler(new Request("https://worker.test/api/server"));
    expect(await response.text()).toBe("t3");
    expect(requests).toEqual([]);
  });

  it("never falls through to authenticated T3 routes after a preview expires", async () => {
    const { handler, requests } = fixture();
    const response = await handler(
      new Request("https://worker.test/api/server", {
        headers: { cookie: `${PREVIEW_GATEWAY_COOKIE_NAME}=${"b".repeat(43)}` },
      }),
    );
    expect(response.status).toBe(410);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(requests).toEqual([]);
  });
});
