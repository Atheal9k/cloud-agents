import { CloudAgentSchedule, CloudAgentsApiPrincipal } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/unstable/http";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import { cloudAgentsApiRateLimitsLayer, cloudAgentsApiRouteLayer } from "./CloudAgentsApiHttp.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudAgentSchedules from "./CloudAgentSchedules.ts";

const unused = () => Effect.die("unused");
const decodeCloudAgentSchedule = Schema.decodeUnknownSync(CloudAgentSchedule);

const routesLayer = cloudAgentsApiRouteLayer.pipe(
  Layer.provideMerge(cloudAgentsApiRateLimitsLayer),
  Layer.provideMerge(
    Layer.succeed(CloudAgentsApi.CloudAgentsApi, {
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
    } as unknown as CloudAgentsApi.CloudAgentsApi["Service"]),
  ),
  Layer.provideMerge(
    Layer.succeed(CloudAgentSchedules.CloudAgentSchedules, {
      create: unused,
      list: unused,
      get: unused,
      replace: unused,
      pause: unused,
      resume: unused,
      remove: unused,
      listActivities: unused,
      reconcile: unused,
    } as unknown as CloudAgentSchedules.CloudAgentSchedules["Service"]),
  ),
  Layer.provideMerge(
    Layer.succeed(CloudAgentsApiKeys.CloudAgentsApiKeys, {
      create: unused,
      authenticate: () => Effect.succeed(null),
    } as CloudAgentsApiKeys.CloudAgentsApiKeys["Service"]),
  ),
);

const schedulePrincipal = Schema.decodeSync(CloudAgentsApiPrincipal)({
  principalId: "principal-scheduler",
  kind: "service_account",
  apiKeyName: "Scheduler",
  createdAt: "2026-09-19T00:00:00.000Z",
});

const scheduleServices = CloudAgentSchedules.layer.pipe(
  Layer.provideMerge(CloudAgentsApi.layer),
  Layer.provideMerge(
    Layer.effect(
      CloudAllocationController.CloudAllocationController,
      CloudAllocationController.make({ enabled: true }),
    ),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const scheduleRoutesLayer = cloudAgentsApiRouteLayer.pipe(
  Layer.provideMerge(cloudAgentsApiRateLimitsLayer),
  Layer.provideMerge(scheduleServices),
  Layer.provideMerge(
    Layer.succeed(CloudAgentsApiKeys.CloudAgentsApiKeys, {
      create: unused,
      authenticate: () => Effect.succeed(schedulePrincipal),
    }),
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

it("creates and controls a schedule through the remote API", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(scheduleRoutesLayer, {
    disableLogger: true,
  });
  const headers = {
    authorization: "Bearer t3ca_schedule",
    "content-type": "application/json",
  };
  const definition = {
    name: "Daily maintenance",
    cron: "0 9 * * 1-5",
    timezone: "Australia/Sydney",
    action: {
      type: "create_agent",
      request: {
        prompt: { text: "Update dependencies" },
        repos: [{ url: "https://github.com/acme/app" }],
      },
    },
    refPolicy: { type: "repository_default" },
    recipe: { type: "current" },
    provider: { instanceId: "codex", model: { id: "default" } },
    publication: "review_only",
    limits: {
      runSeconds: 3_600,
      inputWaitSeconds: 300,
      maxAttempts: 3,
      retryDelaySeconds: 60,
    },
    missedRunPolicy: "run_once",
    overlapPolicy: "skip",
  };
  try {
    const createdResponse = await handler(
      new Request("http://127.0.0.1/v1/schedules", {
        method: "POST",
        headers,
        body: JSON.stringify(definition),
      }),
    );
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(200);
    const created = decodeCloudAgentSchedule(await createdResponse.json());
    expect(created).toMatchObject({ status: "active", definition: { name: "Daily maintenance" } });
    expect(created.id).toMatch(/^schedule-/u);
    expect(created.nextRunAt).toBeTruthy();

    const pausedResponse = await handler(
      new Request(`http://127.0.0.1/v1/schedules/${created.id}/pause`, {
        method: "POST",
        headers,
      }),
    );
    expect(pausedResponse.status, await pausedResponse.clone().text()).toBe(200);
    expect(await pausedResponse.json()).toMatchObject({ id: created.id, status: "paused" });

    const listedResponse = await handler(new Request("http://127.0.0.1/v1/schedules", { headers }));
    expect(listedResponse.status, await listedResponse.clone().text()).toBe(200);
    expect(await listedResponse.json()).toMatchObject({
      items: [{ id: created.id, status: "paused" }],
    });
  } finally {
    await dispose();
  }
});
