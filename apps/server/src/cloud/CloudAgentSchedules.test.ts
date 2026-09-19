import { CloudAgentScheduleCreateRequest } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudAgentSchedules from "./CloudAgentSchedules.ts";

const live = CloudAgentSchedules.layer.pipe(
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

const createDefinition = Schema.decodeSync(CloudAgentScheduleCreateRequest)({
  name: "Daily maintenance",
  cron: "* * * * *",
  timezone: "UTC",
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
});

it.effect("admits due schedules through the Cloud Agents API and retains remote controls", () =>
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const api = yield* CloudAgentsApi.CloudAgentsApi;
    const schedules = yield* CloudAgentSchedules.CloudAgentSchedules;
    const key = yield* keys.create({ name: "Scheduler", kind: "service_account" });
    const principal = (yield* keys.authenticate(key.token))!;

    const created = yield* schedules.create({
      principal,
      definition: createDefinition,
      urlOrigin: "http://controller.test",
    });
    expect(created.status).toBe("active");
    expect(created.nextRunAt).toBeDefined();

    yield* schedules.reconcile(Date.parse(created.nextRunAt!) + 1);
    const agents = yield* api.listAgents({ principal, urlOrigin: "http://controller.test" });
    expect(agents.items).toHaveLength(1);
    expect(
      (yield* schedules.listActivities({ principal, scheduleId: created.id, limit: 20 })).items,
    ).toEqual([
      expect.objectContaining({
        kind: "triggered",
        scheduleId: created.id,
        agentId: agents.items[0]?.id,
      }),
    ]);

    const paused = yield* schedules.pause({ principal, scheduleId: created.id });
    expect(paused).not.toHaveProperty("nextRunAt");
    const resumed = yield* schedules.resume({ principal, scheduleId: created.id });
    expect(resumed.nextRunAt).toBeDefined();
    const edited = yield* schedules.replace({
      principal,
      scheduleId: created.id,
      definition: { ...createDefinition, name: "Dependency maintenance" },
      urlOrigin: "http://controller.test",
    });
    expect(edited.definition.name).toBe("Dependency maintenance");
    expect((yield* schedules.list({ principal })).items).toHaveLength(1);
    expect(yield* schedules.remove({ principal, scheduleId: created.id })).toEqual({
      id: created.id,
    });
    expect((yield* schedules.list({ principal })).items).toHaveLength(0);
  }).pipe(Effect.provide(live)),
);

it.effect("records missed and overlapping occurrences without waking or duplicating work", () =>
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const api = yield* CloudAgentsApi.CloudAgentsApi;
    const schedules = yield* CloudAgentSchedules.CloudAgentSchedules;
    const key = yield* keys.create({ name: "Scheduler", kind: "service_account" });
    const principal = (yield* keys.authenticate(key.token))!;

    const missed = yield* schedules.create({
      principal,
      definition: { ...createDefinition, missedRunPolicy: "skip" },
      urlOrigin: "http://controller.test",
    });
    yield* schedules.reconcile(Date.parse(missed.nextRunAt!) + 5 * 60_000);
    expect(
      (yield* schedules.listActivities({ principal, scheduleId: missed.id, limit: 20 })).items[0]
        ?.kind,
    ).toBe("missed");

    const initial = yield* api.createAgent({
      principal,
      urlOrigin: "http://controller.test",
      body: { prompt: { text: "Long running task" } },
    });
    const followUp = yield* schedules.create({
      principal,
      urlOrigin: "http://controller.test",
      definition: {
        ...createDefinition,
        name: "Follow up",
        action: {
          type: "follow_up",
          agentId: initial.agent.id,
          request: { prompt: { text: "Check again" } },
        },
        provider: { ...createDefinition.provider, model: { id: "inherit" } },
        publication: "inherit",
      },
    });
    yield* schedules.reconcile(Date.parse(followUp.nextRunAt!) + 1);
    expect(
      (yield* schedules.listActivities({ principal, scheduleId: followUp.id, limit: 20 })).items[0]
        ?.kind,
    ).toBe("skipped_overlap");
  }).pipe(Effect.provide(live)),
);

it.effect("rejects schedules whose timing or inherited policy cannot be honored", () =>
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const schedules = yield* CloudAgentSchedules.CloudAgentSchedules;
    const key = yield* keys.create({ name: "Scheduler", kind: "service_account" });
    const principal = (yield* keys.authenticate(key.token))!;

    const impossible = yield* schedules
      .create({
        principal,
        definition: { ...createDefinition, cron: "0 0 31 2 *" },
        urlOrigin: "http://controller.test",
      })
      .pipe(Effect.flip);
    expect(impossible.code).toBe("invalid_request");

    const followUpModel = yield* schedules
      .create({
        principal,
        definition: {
          ...createDefinition,
          action: {
            type: "follow_up",
            agentId: "bc-existing",
            request: { prompt: { text: "Check again" } },
          },
          publication: "inherit",
        },
        urlOrigin: "http://controller.test",
      })
      .pipe(Effect.flip);
    expect(followUpModel.code).toBe("invalid_request");
  }).pipe(Effect.provide(live)),
);
