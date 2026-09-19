import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import { cloudAgentsApiRateLimitsLayer, cloudAgentsApiRouteLayer } from "./CloudAgentsApiHttp.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";

const unused = () => Effect.die("unused");

const routesLayer = cloudAgentsApiRouteLayer.pipe(
  Layer.provideMerge(cloudAgentsApiRateLimitsLayer),
  Layer.provideMerge(
    Layer.succeed(
      CloudAgentsApi.CloudAgentsApi,
      {
        me: unused,
        createAgent: unused,
        listAgents: unused,
        getAgent: unused,
        createRun: unused,
        listRuns: unused,
        getRun: unused,
        cancelRun: unused,
        usage: unused,
        usageReport: unused,
        archive: unused,
        unarchive: unused,
        deleteAgent: unused,
        streamRun: unused,
        listModels: unused,
        listRepositories: unused,
        appendStreamEvent: unused,
      } as unknown as CloudAgentsApi.CloudAgentsApi["Service"],
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(CloudAgentsApiKeys.CloudAgentsApiKeys, {
      create: unused,
      authenticate: () => Effect.succeed(null),
    } as CloudAgentsApiKeys.CloudAgentsApiKeys["Service"]),
  ),
);

it("rejects missing Cloud Agents API keys with a stable unauthorized code", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });
  try {
    const response = await handler(new Request("http://127.0.0.1/v1/me"));
    expect(response.status, await response.clone().text()).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-ratelimit-limit")).toBeTruthy();
  } finally {
    await dispose();
  }
});

it("rejects an unknown Bearer key with unauthorized", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });
  try {
    const response = await handler(
      new Request("http://127.0.0.1/v1/me", {
        headers: { authorization: "Bearer t3ca_unknown" },
      }),
    );
    expect(response.status, await response.clone().text()).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  } finally {
    await dispose();
  }
});
