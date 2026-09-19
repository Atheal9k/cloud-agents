import { CloudAgentAutomationCreateRequest } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudAgentAutomations from "./CloudAgentAutomations.ts";

const live = CloudAgentAutomations.layer.pipe(
  Layer.provideMerge(CloudAgentsApi.layer),
  Layer.provideMerge(CloudAgentsApiKeys.layer),
  Layer.provideMerge(
    Layer.effect(
      CloudAllocationController.CloudAllocationController,
      CloudAllocationController.make({ enabled: true }),
    ),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const createDefinition = Schema.decodeSync(CloudAgentAutomationCreateRequest)({
  name: "Daily maintenance",
  instructions: "Update dependencies.",
  triggers: [{ type: "cron", cron: "* * * * *", timezone: "UTC" }],
  repositories: { mode: "single", repos: [{ url: "https://github.com/acme/app" }] },
  provider: { instanceId: "codex", model: { id: "default" } },
  tools: {
    createPullRequest: true,
    commentOnPullRequest: true,
    requestReviewers: false,
    sendToSlack: false,
    readSlack: false,
    mcp: false,
    memories: true,
    computerUse: true,
  },
  publication: "draft_pr",
  limits: {
    runSeconds: 3_600,
    inputWaitSeconds: 300,
    maxAttempts: 3,
    retryDelaySeconds: 60,
  },
  missedRunPolicy: "run_once",
  overlapPolicy: "skip",
  runAs: "service_account",
  hibernateAfterCompletion: true,
});

it.effect("admits due automations as a service-account principal with remote controls", () =>
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const api = yield* CloudAgentsApi.CloudAgentsApi;
    const automations = yield* CloudAgentAutomations.CloudAgentAutomations;
    const key = yield* keys.create({ name: "Owner", kind: "user" });
    const principal = (yield* keys.authenticate(key.token))!;

    const created = yield* automations.create({
      principal,
      definition: createDefinition,
      urlOrigin: "http://controller.test",
    });
    expect(created.actorKind).toBe("service_account");
    expect(created.actorPrincipalId).not.toBe(principal.principalId);
    expect(created.nextRunAt).toBeDefined();

    yield* automations.reconcile(Date.parse(created.nextRunAt!) + 1);
    const agents = yield* api.listAgents({
      principal: {
        ...principal,
        kind: "service_account",
        principalId: created.actorPrincipalId,
      },
      urlOrigin: "http://controller.test",
    });
    expect(agents.items).toHaveLength(1);
    expect(
      (yield* automations.listActivities({ principal, automationId: created.id, limit: 20 })).items,
    ).toEqual([
      expect.objectContaining({
        kind: "triggered",
        automationId: created.id,
        agentId: agents.items[0]?.id,
      }),
    ]);

    const paused = yield* automations.pause({ principal, automationId: created.id });
    expect(paused).not.toHaveProperty("nextRunAt");
    expect((yield* automations.resume({ principal, automationId: created.id })).nextRunAt).toBeDefined();
    const edited = yield* automations.replace({
      principal,
      automationId: created.id,
      definition: { ...createDefinition, name: "Dependency maintenance" },
      urlOrigin: "http://controller.test",
    });
    expect(edited.definition.name).toBe("Dependency maintenance");
    expect(yield* automations.remove({ principal, automationId: created.id })).toEqual({
      id: created.id,
    });
  }).pipe(Effect.provide(live)),
);

it.effect("deduplicates webhook deliveries, records missed cron slots, and keeps inspectable memories", () =>
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const automations = yield* CloudAgentAutomations.CloudAgentAutomations;
    const key = yield* keys.create({ name: "Owner", kind: "user" });
    const principal = (yield* keys.authenticate(key.token))!;

    const missed = yield* automations.create({
      principal,
      definition: { ...createDefinition, missedRunPolicy: "skip" },
      urlOrigin: "http://controller.test",
    });
    yield* automations.reconcile(Date.parse(missed.nextRunAt!) + 5 * 60_000);
    expect(
      (yield* automations.listActivities({ principal, automationId: missed.id, limit: 20 })).items[0]
        ?.kind,
    ).toBe("missed");

    const webhook = yield* automations.create({
      principal,
      urlOrigin: "http://controller.test",
      definition: {
        ...createDefinition,
        name: "PagerDuty",
        triggers: [
          { type: "pagerduty", events: ["incident_triggered"] },
          { type: "webhook" },
        ],
      },
    });
    expect(webhook.webhookToken).toBeDefined();
    const hookId = webhook.webhook?.hookId;
    const token = webhook.webhookToken;
    if (hookId === undefined || token === undefined) {
      throw new Error("Expected a private webhook token.");
    }
    const memory = yield* automations.writeMemory({
      principal,
      automationId: webhook.id,
      fact: { text: "Cache stampedes after 09:00.", source: { agentId: "bc-prior" } },
    });
    expect(memory.name).toBe("MEMORIES.md");
    const first = yield* automations.deliver({
      hookId,
      token,
      urlOrigin: "http://controller.test",
      delivery: {
        deliveryId: "pd-1",
        type: "pagerduty",
        event: "incident_triggered",
        text: "API latency",
      },
    });
    expect(first.kind).toBe("triggered");
    expect(first.agentId).toBeDefined();
    const replay = yield* automations.deliver({
      hookId,
      token,
      urlOrigin: "http://controller.test",
      delivery: {
        deliveryId: "pd-1",
        type: "pagerduty",
        event: "incident_triggered",
        text: "API latency",
      },
    });
    expect(replay.kind).toBe("deduplicated");
    expect(replay.agentId).toBe(first.agentId);
    expect((yield* automations.listMemory({ principal, automationId: webhook.id })).items).toHaveLength(
      1,
    );
    expect(yield* automations.deleteMemory({ principal, automationId: webhook.id, factId: memory.id })).toEqual(
      { id: memory.id },
    );

    const overlap = yield* automations.deliver({
      principal,
      automationId: webhook.id,
      urlOrigin: "http://controller.test",
      delivery: {
        deliveryId: "pd-2",
        type: "pagerduty",
        event: "incident_triggered",
        text: "Second incident",
      },
    });
    expect(overlap.kind).toBe("skipped_overlap");
  }).pipe(Effect.provide(live)),
);

it.effect("keeps user spend separate from a service-account automation", () =>
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const api = yield* CloudAgentsApi.CloudAgentsApi;
    const automations = yield* CloudAgentAutomations.CloudAgentAutomations;
    const userKey = yield* keys.create({ name: "Alice", kind: "user" });
    const user = (yield* keys.authenticate(userKey.token))!;
    const created = yield* automations.create({
      principal: user,
      urlOrigin: "http://controller.test",
      definition: {
        ...createDefinition,
        triggers: [{ type: "webhook" }],
      },
    });
    yield* automations.deliver({
      principal: user,
      automationId: created.id,
      urlOrigin: "http://controller.test",
      delivery: { deliveryId: "wh-1", type: "webhook", event: "custom" },
    });
    expect(
      (yield* api.listAgents({ principal: user, urlOrigin: "http://controller.test" })).items,
    ).toHaveLength(0);
    expect(
      (
        yield* api.listAgents({
          principal: {
            ...user,
            kind: "service_account",
            principalId: created.actorPrincipalId,
          },
          urlOrigin: "http://controller.test",
        })
      ).items,
    ).toHaveLength(1);
  }).pipe(Effect.provide(live)),
);
