import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudCollaboration from "./CloudCollaboration.ts";
import { cloudCollaborationRouteLayer } from "./CloudCollaborationHttp.ts";
import * as CloudGithubTriggers from "./CloudGithubTriggers.ts";

const unused = () => Effect.die("unused");
let webhookInput:
  | Parameters<CloudGithubTriggers.CloudGithubTriggers["Service"]["receive"]>[0]
  | undefined;

const receiveWebhook: CloudGithubTriggers.CloudGithubTriggers["Service"]["receive"] = (input) =>
  Effect.sync(() => {
    webhookInput = input;
    return {
      status: "triggered",
      reused: false,
      message: "Webhook admitted.",
      agentId: "bc-agent",
      runId: "run-webhook",
    };
  });

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
    Layer.succeed(CloudGithubTriggers.CloudGithubTriggers, {
      create: unused,
      list: unused,
      get: unused,
      disable: unused,
      enable: unused,
      remove: unused,
      listActivities: unused,
      receive: receiveWebhook,
    } as unknown as CloudGithubTriggers.CloudGithubTriggers["Service"]),
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

it("passes the raw GitHub delivery to signature-aware admission", async () => {
  webhookInput = undefined;
  const { handler, dispose } = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });
  try {
    const body = '{"action":"submitted"}';
    const response = await handler(
      new Request("http://127.0.0.1/v1/integrations/github/webhooks/github-trigger-1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-1",
          "x-github-event": "pull_request_review",
          "x-hub-signature-256": "sha256=signature",
        },
        body,
      }),
    );
    expect(response.status, await response.clone().text()).toBe(202);
    expect(webhookInput).toEqual({
      triggerId: "github-trigger-1",
      deliveryId: "delivery-1",
      event: "pull_request_review",
      signature: "sha256=signature",
      body,
    });
  } finally {
    await dispose();
  }
});
