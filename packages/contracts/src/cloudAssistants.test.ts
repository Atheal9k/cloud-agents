import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CloudAssistant,
  CloudAssistantCreateRequest,
  CloudAssistantLifecycleEffects,
  CloudAssistantMemoryFact,
} from "./cloudAssistants.ts";

const decodeCreate = Schema.decodeUnknownSync(CloudAssistantCreateRequest);
const decodeAssistant = Schema.decodeUnknownSync(CloudAssistant);
const decodeMemory = Schema.decodeUnknownSync(CloudAssistantMemoryFact);
const decodeLifecycle = Schema.decodeUnknownSync(CloudAssistantLifecycleEffects);

describe("cloud assistant contracts", () => {
  it("decodes a reusable assistant role, memory source, and lifecycle effects", () => {
    const definition = decodeCreate({
      name: "Docs maintainer",
      instructions: "Keep the README accurate.",
      provider: { instanceId: "codex", model: { id: "default" } },
      tools: ["shell", "explore"],
      repositories: [{ url: "https://github.com/acme/app", startingRef: "main" }],
      secretAccess: { mode: "named", secretIds: ["gh-app"] },
      persistence: { files: false, browser: false },
      limits: { runSeconds: 3_600, inputWaitSeconds: 300 },
    });
    expect(definition.persistence.files).toBe(false);
    expect(definition.secretAccess.mode).toBe("named");

    expect(
      decodeMemory({
        id: "mem-1",
        text: "The package manager is vp.",
        source: { agentId: "bc-1", runId: "run-1", quote: "use vp i" },
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-19T00:00:00.000Z",
      }).source.quote,
    ).toBe("use vp i");

    expect(
      decodeLifecycle({
        action: "idle",
        runs: "none",
        subscriptions: "enabled",
        credentials: "retained",
        snapshots: "retained",
        memory: "retained",
        files: "absent",
        browser: "absent",
      }).action,
    ).toBe("idle");

    expect(
      decodeAssistant({
        id: "asst-1",
        status: "IDLE",
        definition,
        workspaceOwner: "principal-1",
        subscriptions: [],
        credentials: "retained",
        snapshots: "retained",
        lifecycle: {
          action: "idle",
          runs: "none",
          subscriptions: "enabled",
          credentials: "retained",
          snapshots: "retained",
          memory: "retained",
          files: "absent",
          browser: "absent",
        },
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-19T00:00:00.000Z",
      }).workspaceOwner,
    ).toBe("principal-1");
  });
});
