import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { CloudAssistantDefinition } from "@t3tools/contracts";

import {
  assertPersistenceIsolation,
  assertWorkspaceOwner,
  cloudAssistantLifecycleEffects,
  composeAssistantRunPrompt,
  decryptCloudAssistantBlob,
  defaultCloudAssistantPersistence,
  encryptCloudAssistantBlob,
  mintCloudAssistantDataKey,
  persistenceStoreKey,
  validateCloudAssistantDefinition,
  validateCloudAssistantMemory,
} from "./cloudAssistantPolicy.ts";

const decodeDefinition = Schema.decodeUnknownSync(CloudAssistantDefinition);

const definition = decodeDefinition({
  name: "Docs maintainer",
  instructions: "Keep the README accurate.",
  provider: { instanceId: "codex", model: { id: "default" } },
  tools: ["shell"],
  repositories: [{ url: "https://github.com/acme/app" }],
  secretAccess: { mode: "none" },
  persistence: { files: true, browser: false },
  limits: { runSeconds: 600, inputWaitSeconds: 60 },
});

describe("cloud assistant policy", () => {
  it("keeps files and browser persistence opt-in and isolated per assistant", () => {
    expect(defaultCloudAssistantPersistence()).toEqual({ files: false, browser: false });
    expect(validateCloudAssistantDefinition(definition)).toBeUndefined();
    expect(
      validateCloudAssistantDefinition(
        decodeDefinition({
          ...definition,
          provider: { instanceId: "cursor", model: { id: "default" } },
        }),
      ),
    ).toMatch(/unsupported/);
    expect(
      validateCloudAssistantDefinition(
        decodeDefinition({
          ...definition,
          tools: ["shell", "computerUse"],
          provider: { instanceId: "claudeAgent", model: { id: "default" } },
        }),
      ),
    ).toMatch(/computer use/);
    expect(persistenceStoreKey("asst-a", "files")).not.toBe(persistenceStoreKey("asst-b", "files"));
    expect(
      assertPersistenceIsolation({ ownerAssistantId: "asst-a", requestedAssistantId: "asst-b" }),
    ).toMatch(/not shared/);
    expect(assertWorkspaceOwner({ workspaceOwner: "owner", principalId: "other" })).toMatch(
      /one owner/,
    );
  });

  it("requires source context for memory and encrypts opted-in state with a per-assistant key", () => {
    expect(
      validateCloudAssistantMemory({
        text: "Uses vp.",
        source: { agentId: "bc-1" },
      }),
    ).toMatch(/source context/);
    expect(
      validateCloudAssistantMemory({
        text: "Uses vp.",
        source: { agentId: "bc-1", quote: "vp i" },
      }),
    ).toBeUndefined();

    const keyA = mintCloudAssistantDataKey();
    const keyB = mintCloudAssistantDataKey();
    const encrypted = encryptCloudAssistantBlob({ dataKey: keyA, plaintext: "cookies" });
    if ("message" in encrypted) throw new Error(encrypted.message);
    expect(decryptCloudAssistantBlob({ dataKey: keyA, ciphertext: encrypted.ciphertext })).toEqual({
      plaintext: "cookies",
    });
    expect(decryptCloudAssistantBlob({ dataKey: keyB, ciphertext: encrypted.ciphertext })).toEqual({
      message: "Persistent assistant state could not be decrypted.",
    });
  });

  it("defines IDLE, archive, reset, and delete effects without a third conversation store", () => {
    expect(cloudAssistantLifecycleEffects({ action: "idle", definition })).toMatchObject({
      runs: "none",
      subscriptions: "enabled",
      credentials: "retained",
      snapshots: "retained",
      files: "retained",
      browser: "absent",
    });
    expect(cloudAssistantLifecycleEffects({ action: "archive", definition })).toMatchObject({
      runs: "reject_new",
      subscriptions: "paused",
    });
    expect(cloudAssistantLifecycleEffects({ action: "reset", definition })).toMatchObject({
      runs: "history_retained",
      memory: "cleared",
      files: "cleared",
    });
    expect(cloudAssistantLifecycleEffects({ action: "delete", definition })).toMatchObject({
      runs: "deleted",
      subscriptions: "disabled",
      credentials: "revoked",
      snapshots: "policy-expiry",
    });
    expect(
      composeAssistantRunPrompt({
        instructions: "Be brief.",
        memory: [{ text: "Uses vp.", source: { agentId: "bc-1", quote: "vp i" } }],
        prompt: "Update the README.",
      }),
    ).toContain("source agent bc-1");
  });
});
