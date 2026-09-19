import { CloudAssistantCreateRequest } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudAssistants from "./CloudAssistants.ts";

const live = CloudAssistants.layer.pipe(
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

const definition = Schema.decodeSync(CloudAssistantCreateRequest)({
  name: "Docs maintainer",
  instructions: "Keep the README accurate.",
  provider: { instanceId: "codex", model: { id: "default" } },
  tools: ["shell", "explore"],
  repositories: [{ url: "https://github.com/acme/app", startingRef: "main" }],
  secretAccess: { mode: "named", secretIds: ["gh-app"] },
  persistence: { files: true, browser: false },
  limits: { runSeconds: 3_600, inputWaitSeconds: 300 },
});

it.effect("binds a reusable assistant role onto ordinary durable agent runs", () =>
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const api = yield* CloudAgentsApi.CloudAgentsApi;
    const assistants = yield* CloudAssistants.CloudAssistants;
    const key = yield* keys.create({ name: "Assistants", kind: "service_account" });
    const principal = (yield* keys.authenticate(key.token))!;

    const created = yield* assistants.create({ principal, definition });
    expect(created.status).toBe("IDLE");
    expect(created.workspaceOwner).toBe(principal.principalId);
    expect(created.lifecycle).toMatchObject({
      action: "idle",
      runs: "none",
      subscriptions: "enabled",
      credentials: "retained",
      snapshots: "retained",
      files: "retained",
      browser: "absent",
    });
    expect(created.agentId).toBeUndefined();

    const fact = yield* assistants.writeMemory({
      principal,
      assistantId: created.id,
      fact: {
        text: "The package manager is vp.",
        source: { agentId: "bc-source", runId: "run-1", quote: "use vp i" },
      },
    });
    expect(
      (yield* assistants.listMemory({ principal, assistantId: created.id })).items.map(
        (item) => item.text,
      ),
    ).toEqual(["The package manager is vp."]);
    const edited = yield* assistants.replaceMemory({
      principal,
      assistantId: created.id,
      factId: fact.id,
      fact: {
        text: "Install with vp i.",
        source: { agentId: "bc-source", quote: "vp i" },
      },
    });
    expect(edited.text).toBe("Install with vp i.");

    yield* assistants.putPersistence({
      principal,
      assistantId: created.id,
      kind: "files",
      plaintext: "notes.md",
    });
    expect(
      yield* assistants.getPersistence({
        principal,
        assistantId: created.id,
        kind: "files",
      }),
    ).toEqual({ plaintext: "notes.md" });
    const browserDenied = yield* assistants
      .putPersistence({
        principal,
        assistantId: created.id,
        kind: "browser",
        plaintext: "cookies",
      })
      .pipe(Effect.flip);
    expect(browserDenied.code).toBe("invalid_request");

    const started = yield* assistants.createRun({
      principal,
      assistantId: created.id,
      urlOrigin: "http://controller.test",
      body: { prompt: { text: "Update the README." } },
    });
    expect(started.agentId).toBeDefined();
    const agents = yield* api.listAgents({ principal, urlOrigin: "http://controller.test" });
    expect(agents.items).toHaveLength(1);
    expect(agents.items[0]?.id).toBe(started.agentId);
    const agent = yield* api.getAgent({
      principal,
      agentId: started.agentId,
      urlOrigin: "http://controller.test",
    });
    expect(agent.status === "ACTIVE" || agent.status === "IDLE").toBe(true);

    yield* assistants.attachSubscription({
      principal,
      assistantId: created.id,
      subscription: { id: "sub-docs", kind: "github", status: "enabled" },
    });
    const archived = yield* assistants.archive({ principal, assistantId: created.id });
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.subscriptions[0]?.status).toBe("paused");
    expect(archived.lifecycle.runs).toBe("reject_new");
    expect(
      (yield* api.getAgent({
        principal,
        agentId: started.agentId,
        urlOrigin: "http://controller.test",
      })).status,
    ).toBe("ARCHIVED");

    const unarchived = yield* assistants.unarchive({ principal, assistantId: created.id });
    expect(unarchived.status).toBe("IDLE");
    expect(unarchived.subscriptions[0]?.status).toBe("enabled");
    expect(unarchived.agentId).toBe(started.agentId);

    const reset = yield* assistants.reset({ principal, assistantId: created.id });
    expect((yield* assistants.listMemory({ principal, assistantId: reset.id })).items).toEqual([]);
    const filesGone = yield* assistants
      .getPersistence({ principal, assistantId: created.id, kind: "files" })
      .pipe(Effect.flip);
    expect(filesGone.code).toBe("invalid_request");
    expect(
      (yield* api.listRuns({ principal, agentId: started.agentId })).items.length,
    ).toBeGreaterThan(0);

    expect(yield* assistants.remove({ principal, assistantId: created.id })).toEqual({
      id: created.id,
    });
    expect((yield* assistants.list({ principal })).items).toHaveLength(0);
  }).pipe(Effect.provide(live)),
);

it.effect("rejects unsourced memory and keeps one workspace owner", () =>
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const assistants = yield* CloudAssistants.CloudAssistants;
    const key = yield* keys.create({ name: "Assistants", kind: "service_account" });
    const principal = (yield* keys.authenticate(key.token))!;
    const created = yield* assistants.create({ principal, definition });
    const unsourced = yield* assistants
      .writeMemory({
        principal,
        assistantId: created.id,
        fact: { text: "secret", source: { agentId: created.id } },
      })
      .pipe(Effect.flip);
    expect(unsourced.code).toBe("invalid_request");
  }).pipe(Effect.provide(live)),
);
