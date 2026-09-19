import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudSelfHosted from "./CloudSelfHosted.ts";
import { cloudSelfHostedRouteLayer } from "./CloudSelfHostedHttp.ts";

const unused = () => Effect.die("unused");

const principal = {
  principalId: "principal:sa",
  kind: "service_account" as const,
  apiKeyName: "pools",
  createdAt: "2026-09-19T00:00:00.000Z",
};

const userPrincipal = {
  principalId: "principal:user",
  kind: "user" as const,
  apiKeyName: "dev",
  createdAt: "2026-09-19T00:00:00.000Z",
  userId: 321,
};

const routesLayer = cloudSelfHostedRouteLayer.pipe(
  Layer.provideMerge(
    Layer.succeed(CloudSelfHosted.CloudSelfHosted, {
      setPolicy: (mode: "off" | "allow" | "require") => Effect.succeed(mode),
      policy: Effect.succeed("allow"),
      launchPreview: (target: "cloud" | "pool" | "machine") =>
        Effect.succeed({
          policy: "allow",
          target,
          allowed: true,
          hosting: target === "cloud" ? "managed" : "self-hosted",
          differences: [],
        }),
      registerPool: () => Effect.succeed({ registered: true }),
      listPools: () =>
        Effect.succeed({
          pools: [
            {
              scope: "team",
              ownerId: 1,
              poolName: "gpu",
              connectedWorkerCount: 0,
              inUseWorkerCount: 0,
              firstSeenAtMs: 1,
              lastSeenAtMs: 1,
              isStale: false,
              deleted: false,
              workerReadyTimeoutSeconds: 900,
            },
          ],
        }),
      deregisterPool: () => Effect.succeed({ deregistered: true }),
      connectWorker: () => unused(),
      disconnectWorker: unused,
      idleRelease: unused,
      listWorkers: unused,
      summary: unused,
      getWorker: unused,
      enqueue: unused,
      listPending: () =>
        Effect.succeed({
          requests: [
            {
              id: "bc-1",
              userId: 321,
              createdAtMs: 1,
              labels: [{ key: "pool", value: "gpu" }],
            },
          ],
          streamCursor: "v4.1.1",
        }),
      watchPending: () =>
        Effect.succeed({
          events: [
            { id: "v4.1.2", event: "created", data: { id: "bc-1" }, createdAtMs: 1 },
            { id: "v4.1.3", event: "heartbeat", data: {}, createdAtMs: 2 },
          ],
        }),
      claim: () => Effect.succeed({ id: "bc-1", workerId: "pw_1" }),
      release: unused,
      expire: unused,
      management: () =>
        Effect.succeed({ status: 200, body: "ok\n", contentType: "text/plain" }),
    } as unknown as CloudSelfHosted.CloudSelfHosted["Service"]),
  ),
  Layer.provideMerge(
    Layer.succeed(CloudAgentsApiKeys.CloudAgentsApiKeys, {
      create: unused,
      authenticate: (token: string) =>
        Effect.succeed(token === "sa" ? principal : token === "user" ? userPrincipal : null),
    } as CloudAgentsApiKeys.CloudAgentsApiKeys["Service"]),
  ),
);

it("rejects user keys on pool APIs and serves list/watch/claim for a service account", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });
  try {
    const userDenied = await handler(
      new Request("http://127.0.0.1/v0/private-workers/pools", {
        method: "POST",
        headers: { authorization: "Bearer user", "content-type": "application/json" },
        body: JSON.stringify({ scope: "team", poolName: "gpu" }),
      }),
    );
    expect(userDenied.status, await userDenied.clone().text()).toBe(409);
    expect(await userDenied.json()).toMatchObject({ code: "pool_auth_required" });

    const listed = await handler(
      new Request("http://127.0.0.1/v0/private-workers/pools", {
        headers: { authorization: "Bearer sa" },
      }),
    );
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(await listed.json()).toMatchObject({ pools: [{ poolName: "gpu", connectedWorkerCount: 0 }] });

    const pending = await handler(
      new Request("http://127.0.0.1/v0/private-workers/pending-requests", {
        headers: { authorization: "Bearer sa" },
      }),
    );
    expect(await pending.json()).toMatchObject({ streamCursor: "v4.1.1" });

    const stream = await handler(
      new Request("http://127.0.0.1/v0/private-workers/pending-requests/stream?cursor=v4.1.1", {
        headers: { authorization: "Bearer sa" },
      }),
    );
    expect(stream.status, await stream.clone().text()).toBe(200);
    expect(await stream.text()).toMatch(/event: created/);

    const claimed = await handler(
      new Request("http://127.0.0.1/v0/private-workers/claim", {
        method: "POST",
        headers: { authorization: "Bearer sa", "content-type": "application/json" },
        body: JSON.stringify({ id: "bc-1", workerId: "pw_1" }),
      }),
    );
    expect(claimed.status, await claimed.clone().text()).toBe(200);
    expect(await claimed.json()).toEqual({ id: "bc-1", workerId: "pw_1" });

    const healthz = await handler(
      new Request("http://127.0.0.1/v0/private-workers/pw_1/healthz", {
        headers: { authorization: "Bearer sa" },
      }),
    );
    expect(healthz.status, await healthz.clone().text()).toBe(200);
    expect(await healthz.text()).toBe("ok\n");
  } finally {
    await dispose();
  }
});
