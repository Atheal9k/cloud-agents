import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudCollaboration from "./CloudCollaboration.ts";
import { cloudCollaborationRouteLayer } from "./CloudCollaborationHttp.ts";

const unused = () => Effect.die("unused");

const routesLayer = cloudCollaborationRouteLayer.pipe(
  Layer.provideMerge(
    Layer.succeed(CloudCollaboration.CloudCollaboration, {
      listConnections: unused,
      connect: unused,
      disconnect: unused,
      installedRepositories: unused,
      followUpPolicy: unused,
      authorizeRepository: unused,
      viewSharedAgent: unused,
      authorizeFollowUp: unused,
      findIdempotentRun: unused,
      rememberIdempotentRun: unused,
    } as unknown as CloudCollaboration.CloudCollaboration["Service"]),
  ),
  Layer.provideMerge(
    Layer.succeed(CloudAgentsApi.CloudAgentsApi, {
      createAgent: unused,
      createRun: unused,
    } as unknown as CloudAgentsApi.CloudAgentsApi["Service"]),
  ),
  Layer.provideMerge(
    Layer.succeed(CloudAgentsApiKeys.CloudAgentsApiKeys, {
      create: unused,
      authenticate: () => Effect.succeed(null),
    } as CloudAgentsApiKeys.CloudAgentsApiKeys["Service"]),
  ),
);

it("rejects unsigned integration deliveries", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });
  try {
    const response = await handler(
      new Request("http://127.0.0.1/v1/integrations/slack/events", { method: "POST" }),
    );
    expect(response.status, await response.clone().text()).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  } finally {
    await dispose();
  }
});
