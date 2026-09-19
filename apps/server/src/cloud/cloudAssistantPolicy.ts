// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CLOUD_ASSISTANT_INSTRUCTIONS_MAX_BYTES,
  CLOUD_ASSISTANT_MEMORY_MAX_BYTES,
  CLOUD_ASSISTANT_PERSISTENCE_MAX_BYTES,
  CLOUD_ASSISTANT_TOOLS,
  type CloudAssistantDefinition,
  type CloudAssistantLifecycleAction,
  type CloudAssistantLifecycleEffects,
  type CloudAssistantMemorySource,
  type CloudAssistantPersistenceKind,
  admitCloudProviderExecution,
} from "@t3tools/contracts";

const TOOLS = new Set<string>(CLOUD_ASSISTANT_TOOLS);

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function defaultCloudAssistantPersistence(): {
  readonly files: false;
  readonly browser: false;
} {
  return { files: false, browser: false };
}

export function validateCloudAssistantDefinition(
  definition: CloudAssistantDefinition,
): string | undefined {
  if (utf8Bytes(definition.instructions) > CLOUD_ASSISTANT_INSTRUCTIONS_MAX_BYTES) {
    return "Assistant instructions exceed the size limit.";
  }
  if (definition.tools.length === 0) {
    return "An assistant needs at least one tool.";
  }
  const seen = new Set<string>();
  for (const tool of definition.tools) {
    if (!TOOLS.has(tool)) return `Unknown assistant tool '${tool}'.`;
    if (seen.has(tool)) return "Assistant tools must be unique.";
    seen.add(tool);
  }
  if (definition.secretAccess.mode === "named" && definition.secretAccess.secretIds.length === 0) {
    return "Named secret access needs at least one secret id.";
  }
  const admitted = admitCloudProviderExecution({
    instanceId: definition.provider.instanceId,
    computerUse: definition.tools.includes("computerUse"),
  });
  if (admitted.status === "rejected") return admitted.message;
  return undefined;
}

export function validateCloudAssistantMemory(input: {
  readonly text: string;
  readonly source: CloudAssistantMemorySource;
}): string | undefined {
  if (utf8Bytes(input.text) > CLOUD_ASSISTANT_MEMORY_MAX_BYTES) {
    return "A memory fact exceeds the size limit.";
  }
  if (input.source.agentId.trim().length === 0) {
    return "A memory fact needs source context.";
  }
  if (
    (input.source.quote === undefined || input.source.quote.trim().length === 0) &&
    (input.source.runId === undefined || input.source.runId.trim().length === 0)
  ) {
    return "A consequential memory fact must cite a run or quoted source context.";
  }
  return undefined;
}

export function persistenceOptedIn(
  definition: CloudAssistantDefinition,
  kind: CloudAssistantPersistenceKind,
): boolean {
  return definition.persistence[kind];
}

export function persistenceStoreKey(
  assistantId: string,
  kind: CloudAssistantPersistenceKind,
): string {
  return `${assistantId}:${kind}`;
}

export function assertPersistenceIsolation(input: {
  readonly ownerAssistantId: string;
  readonly requestedAssistantId: string;
}): string | undefined {
  if (input.ownerAssistantId !== input.requestedAssistantId) {
    return "Persistent files and browser state are not shared between assistants.";
  }
  return undefined;
}

export function mintCloudAssistantDataKey(): string {
  return NodeCrypto.randomBytes(32).toString("base64");
}

export function encryptCloudAssistantBlob(input: {
  readonly dataKey: string;
  readonly plaintext: string;
}): { readonly ciphertext: string } | { readonly message: string } {
  if (utf8Bytes(input.plaintext) > CLOUD_ASSISTANT_PERSISTENCE_MAX_BYTES) {
    return { message: "Persistent assistant state exceeds the size limit." };
  }
  const key = Buffer.from(input.dataKey, "base64");
  if (key.length !== 32) return { message: "Assistant data key is invalid." };
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([iv, tag, encrypted]).toString("base64"),
  };
}

export function decryptCloudAssistantBlob(input: {
  readonly dataKey: string;
  readonly ciphertext: string;
}): { readonly plaintext: string } | { readonly message: string } {
  const key = Buffer.from(input.dataKey, "base64");
  if (key.length !== 32) return { message: "Assistant data key is invalid." };
  const packed = Buffer.from(input.ciphertext, "base64");
  if (packed.length < 29) return { message: "Persistent assistant state is corrupt." };
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const encrypted = packed.subarray(28);
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return {
      plaintext: Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"),
    };
  } catch {
    return { message: "Persistent assistant state could not be decrypted." };
  }
}

export function persistenceEffect(
  definition: CloudAssistantDefinition,
  kind: CloudAssistantPersistenceKind,
  action: CloudAssistantLifecycleAction,
): CloudAssistantLifecycleEffects["files"] {
  if (!definition.persistence[kind]) return "absent";
  if (action === "reset") return "cleared";
  if (action === "delete") return "deleted";
  return "retained";
}

export function cloudAssistantLifecycleEffects(input: {
  readonly action: CloudAssistantLifecycleAction;
  readonly definition: CloudAssistantDefinition;
}): CloudAssistantLifecycleEffects {
  const { action, definition } = input;
  switch (action) {
    case "idle":
      return {
        action,
        runs: "none",
        subscriptions: "enabled",
        credentials: "retained",
        snapshots: "retained",
        memory: "retained",
        files: persistenceEffect(definition, "files", action),
        browser: persistenceEffect(definition, "browser", action),
      };
    case "archive":
      return {
        action,
        runs: "reject_new",
        subscriptions: "paused",
        credentials: "retained",
        snapshots: "retained",
        memory: "retained",
        files: persistenceEffect(definition, "files", action),
        browser: persistenceEffect(definition, "browser", action),
      };
    case "unarchive":
      return {
        action,
        runs: "none",
        subscriptions: "enabled",
        credentials: "retained",
        snapshots: "retained",
        memory: "retained",
        files: persistenceEffect(definition, "files", action),
        browser: persistenceEffect(definition, "browser", action),
      };
    case "reset":
      return {
        action,
        runs: "history_retained",
        subscriptions: "enabled",
        credentials: "retained",
        snapshots: "retained",
        memory: "cleared",
        files: persistenceEffect(definition, "files", action),
        browser: persistenceEffect(definition, "browser", action),
      };
    case "delete":
      return {
        action,
        runs: "deleted",
        subscriptions: "disabled",
        credentials: "revoked",
        snapshots: "policy-expiry",
        memory: "deleted",
        files: persistenceEffect(definition, "files", action),
        browser: persistenceEffect(definition, "browser", action),
      };
  }
}

export function composeAssistantRunPrompt(input: {
  readonly instructions: string;
  readonly memory: ReadonlyArray<{
    readonly text: string;
    readonly source: CloudAssistantMemorySource;
  }>;
  readonly prompt: string;
}): string {
  const facts =
    input.memory.length === 0
      ? undefined
      : input.memory
          .map((fact) => {
            const run = fact.source.runId === undefined ? "" : ` run ${fact.source.runId}`;
            const quote =
              fact.source.quote === undefined ? "" : ` quote ${JSON.stringify(fact.source.quote)}`;
            return `- ${fact.text} (source agent ${fact.source.agentId}${run}${quote})`;
          })
          .join("\n");
  return [
    `Assistant instructions:\n${input.instructions}`,
    facts === undefined ? undefined : `Remembered facts:\n${facts}`,
    input.prompt,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

export function assertWorkspaceOwner(input: {
  readonly workspaceOwner: string;
  readonly principalId: string;
}): string | undefined {
  if (input.workspaceOwner !== input.principalId) {
    return "A writable assistant workspace has one owner.";
  }
  return undefined;
}
