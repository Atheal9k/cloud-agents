import { DeviceDisplayViewerId, ThreadId } from "@t3tools/contracts";
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
  DEVICE_DISPLAY_ROUTE_PREFIX,
  DeviceDisplayGateway,
  type DeviceDisplayGatewayTarget,
} from "./DeviceDisplayGateway.ts";
import { deviceDisplayProxyRouteLayer } from "./DeviceDisplayProxy.ts";

const TOKEN = "a".repeat(43);
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function target(overrides?: Partial<DeviceDisplayGatewayTarget>): DeviceDisplayGatewayTarget {
  return {
    viewerId: DeviceDisplayViewerId.make("viewer-1"),
    threadId: ThreadId.make("thread-allocation-1-2"),
    upstreamUrl: "http://127.0.0.1:3401",
    deviceId: "emulator-5554",
    platform: "android",
    inputEnabled: false,
    expiresAtMillis: Date.parse("2099-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fixture(resolved: DeviceDisplayGatewayTarget | null) {
  const requests: string[] = [];
  const client = HttpClient.make((request) => {
    requests.push(request.url);
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("frame")));
  });
  const gateway = DeviceDisplayGateway.of({
    issue: () => Effect.die("not used"),
    keepAlive: () => Effect.die("not used"),
    takeControl: () => Effect.die("not used"),
    returnControl: () => Effect.die("not used"),
    release: () => Effect.die("not used"),
    hibernate: () => Effect.die("not used"),
    restore: () => Effect.die("not used"),
    attachWebSocket: () => Effect.die("not used"),
    detachWebSocket: () => Effect.die("not used"),
    resolve: (token) => Effect.succeed(token === TOKEN ? resolved : null),
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    deviceDisplayProxyRouteLayer.pipe(
      Layer.provideMerge(Layer.succeed(DeviceDisplayGateway, gateway)),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests };
}

describe("device display proxy", () => {
  it("forwards the job's Android health check without T3 credentials", async () => {
    const { handler, requests } = fixture(target());
    const response = await handler(
      new Request(
        `https://worker.test${DEVICE_DISPLAY_ROUTE_PREFIX}${TOKEN}/vendor/serve-emu/health`,
        { headers: { authorization: "Bearer t3-secret", cookie: "t3_session=secret" } },
      ),
    );
    expect(await response.text()).toBe("frame");
    expect(requests).toEqual(["http://127.0.0.1:3401/vendor/serve-emu/health"]);
  });

  it("forwards the job's iOS stream and rejects a different helper id", async () => {
    const ios = fixture(
      target({ platform: "ios", deviceId: "udid-1", inputEnabled: false }),
    );
    const allowed = await ios.handler(
      new Request(
        `https://worker.test${DEVICE_DISPLAY_ROUTE_PREFIX}${TOKEN}/vendor/serve-sim/helper/udid-1/stream.avcc`,
      ),
    );
    expect(allowed.status).toBe(200);
    const denied = await ios.handler(
      new Request(
        `https://worker.test${DEVICE_DISPLAY_ROUTE_PREFIX}${TOKEN}/vendor/serve-sim/helper/other/stream.avcc`,
      ),
    );
    expect(denied.status).toBe(404);
  });

  it("never forwards the vendor shell endpoint, ADB, or arbitrary files", async () => {
    const { handler, requests } = fixture(target({ inputEnabled: true }));
    const blocked = [
      `/vendor/serve-sim/exec`,
      `/vendor/serve-emu/api/devices`,
      `/etc/passwd`,
      `/vendor/serve-emu/ws?device=emulator-5556`,
    ];
    for (const path of blocked) {
      const response = await handler(
        new Request(`https://worker.test${DEVICE_DISPLAY_ROUTE_PREFIX}${TOKEN}${path}`, {
          method: path.includes("exec") ? "POST" : "GET",
        }),
      );
      expect(response.status, path).toBe(404);
    }
    expect(requests).toEqual([]);
  });

  it("keeps the iOS input socket closed until the human owns the lease", async () => {
    const { handler } = fixture(
      target({ platform: "ios", deviceId: "udid-1", inputEnabled: false }),
    );
    const response = await handler(
      new Request(
        `https://worker.test${DEVICE_DISPLAY_ROUTE_PREFIX}${TOKEN}/vendor/serve-sim/helper/ws?device=udid-1`,
        { headers: { upgrade: "websocket", connection: "Upgrade" } },
      ),
    );
    expect(response.status).toBe(404);
  });

  it("does not fall through after hibernate or expiry", async () => {
    const { handler, requests } = fixture(null);
    const response = await handler(
      new Request(
        `https://worker.test${DEVICE_DISPLAY_ROUTE_PREFIX}${"b".repeat(43)}/vendor/serve-emu/health`,
      ),
    );
    expect(response.status).toBe(410);
    expect(requests).toEqual([]);
  });
});
