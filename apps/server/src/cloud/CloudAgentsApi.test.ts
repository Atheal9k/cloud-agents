import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";

const live = CloudAgentsApi.layer.pipe(
  Layer.provideMerge(CloudAgentsApiKeys.layer),
  Layer.provideMerge(
    Layer.effect(
      CloudAllocationController.CloudAllocationController,
      CloudAllocationController.make({ enabled: true }),
    ),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect("creates, isolates, cancels, archives, and deletes cloud agents", () =>
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const api = yield* CloudAgentsApi.CloudAgentsApi;
    const user = yield* keys.create({
      name: "User key",
      kind: "user",
      userEmail: "dev@example.com",
    });
    const service = yield* keys.create({ name: "CI", kind: "service_account" });
    const userPrincipal = (yield* keys.authenticate(user.token))!;
    const servicePrincipal = (yield* keys.authenticate(service.token))!;

    expect(yield* api.me(userPrincipal)).toMatchObject({
      apiKeyName: "User key",
      userEmail: "dev@example.com",
    });
    expect(yield* api.me(servicePrincipal)).toEqual({
      apiKeyName: "CI",
      createdAt: servicePrincipal.createdAt,
    });

    const created = yield* api.createAgent({
      principal: userPrincipal,
      urlOrigin: "http://localhost",
      body: {
        prompt: { text: "Add a README" },
        agentId: "bc-11111111-1111-1111-1111-111111111111",
        repos: [{ url: "https://github.com/acme/app", startingRef: "main" }],
        autoCreatePR: true,
        mode: "plan",
      },
    });
    expect(created.agent.status).toBe("ACTIVE");
    expect(created.run.status).toBe("CREATING");

    const conflict = yield* api
      .createAgent({
        principal: userPrincipal,
        urlOrigin: "http://localhost",
        body: {
          prompt: { text: "Again" },
          agentId: "bc-11111111-1111-1111-1111-111111111111",
        },
      })
      .pipe(Effect.flip);
    expect(conflict.code).toBe("agent_id_conflict");

    const busy = yield* api
      .createRun({
        principal: userPrincipal,
        agentId: created.agent.id,
        body: { prompt: { text: "Follow up" } },
      })
      .pipe(Effect.flip);
    expect(busy.code).toBe("agent_busy");

    const isolated = yield* api
      .getAgent({
        principal: servicePrincipal,
        agentId: created.agent.id,
        urlOrigin: "http://localhost",
      })
      .pipe(Effect.flip);
    expect(isolated.code).toBe("agent_not_found");

    const streamed = yield* api.streamRun({
      principal: userPrincipal,
      agentId: created.agent.id,
      runId: created.run.id,
      nowMs: Date.parse(created.run.createdAt),
    });
    expect(streamed.events.some((event) => event.event === "status")).toBe(true);
    expect(streamed.events.some((event) => event.event === "heartbeat")).toBe(true);
    expect(streamed.reconnectSource).toBe("controller-transcript");
    expect(
      (yield* api.listHistory({
        principal: userPrincipal,
        agentId: created.agent.id,
        runId: created.run.id,
        kind: "setup",
      })).items,
    ).toHaveLength(1);

    const missingResume = yield* api
      .streamRun({
        principal: userPrincipal,
        agentId: created.agent.id,
        runId: created.run.id,
        lastEventId: "missing-id",
        nowMs: Date.parse(created.run.createdAt),
      })
      .pipe(Effect.flip);
    expect(missingResume.code).toBe("invalid_last_event_id");

    expect(
      (yield* api.listAgents({ principal: userPrincipal, urlOrigin: "http://localhost" })).items,
    ).toHaveLength(1);
    expect(
      (yield* api.usage({ principal: userPrincipal, agentId: created.agent.id })).runs,
    ).toEqual([expect.objectContaining({ id: created.run.id })]);

    yield* api.cancelRun({
      principal: userPrincipal,
      agentId: created.agent.id,
      runId: created.run.id,
    });
    const recancel = yield* api
      .cancelRun({
        principal: userPrincipal,
        agentId: created.agent.id,
        runId: created.run.id,
      })
      .pipe(Effect.flip);
    expect(recancel.code).toBe("run_not_cancellable");

    yield* api.archive({ principal: userPrincipal, agentId: created.agent.id });
    yield* api.archive({ principal: userPrincipal, agentId: created.agent.id });
    const archivedFollowUp = yield* api
      .createRun({
        principal: userPrincipal,
        agentId: created.agent.id,
        body: { prompt: { text: "Nope" } },
      })
      .pipe(Effect.flip);
    expect(archivedFollowUp.code).toBe("agent_archived");

    yield* api.unarchive({ principal: userPrincipal, agentId: created.agent.id });
    yield* api.deleteAgent({ principal: userPrincipal, agentId: created.agent.id });
    const gone = yield* api
      .getAgent({
        principal: userPrincipal,
        agentId: created.agent.id,
        urlOrigin: "http://localhost",
      })
      .pipe(Effect.flip);
    expect(gone.code).toBe("agent_not_found");
  }).pipe(Effect.provide(live)),
);
