import { CLOUD_DIAGNOSTICS_CURSOR_TOOL_NAMES } from "./cloudExtensibility.ts";

/** Entry-point copy. The skill package, not this sentence, owns agent behavior. */
export const CLOUD_ENV_SETUP_USER_REQUEST =
  "Make this repository fully usable for Cloud Agents. Use the repository-owned env-setup skill.";

/** Idempotency marker so a launch is not wrapped twice. */
export const CLOUD_ENV_SETUP_TURN_HEADER =
  "Repository-owned env-setup skill (inline before any tool call)";

export const CLOUD_ENV_SETUP_SKILL_NAME = "env-setup";

export const CLOUD_ENV_SETUP_RELATIVE_DIR = ".agents/skills/env-setup";

export const CLOUD_ENV_SETUP_REFERENCE_FILES = {
  create: "references/create-environment.md",
  "repo-managed": "references/update-repo-managed-environment.md",
  "db-managed": "references/update-db-managed-environment.md",
  migrate: "references/migrate-to-builds.md",
} as const;

export type CloudEnvSetupWorkflow = keyof typeof CLOUD_ENV_SETUP_REFERENCE_FILES;

export const CLOUD_ENV_SETUP_WORKFLOWS = Object.keys(
  CLOUD_ENV_SETUP_REFERENCE_FILES,
) as ReadonlyArray<CloudEnvSetupWorkflow>;

/** Provider skill roots that must see the same package, relative to guest home. */
export const CLOUD_ENV_SETUP_GUEST_HOME_DIRS = [
  ".agents/skills/env-setup",
  ".cursor/skills/env-setup",
  ".claude/skills/env-setup",
] as const;

export type CloudEnvSetupPromptIntent = "create" | "migrate" | "update" | "none";

export function cloudEnvSetupPromptIntent(prompt: string): CloudEnvSetupPromptIntent {
  const text = prompt.toLowerCase();
  if (
    (/\bmigrat(?:e|ion|ing)\b/.test(text) && /\bbuilds?\b/.test(text)) ||
    /\bbuild migration\b/.test(text) ||
    /work with builds/.test(text) ||
    /prebuilt baselines/.test(text)
  ) {
    return "migrate";
  }
  if (
    text.includes("env-setup") ||
    text.includes("fully usable") ||
    /\bset up (?:this |the |an |a )?(?:repository |repo )?(?:cloud )?environment\b/.test(text) ||
    /\benvironment setup\b/.test(text)
  ) {
    return "create";
  }
  if (/\b(?:update|improve|change|fix) (?:the )?(?:environment|setup)\b/.test(text)) {
    return "update";
  }
  return "none";
}

export function cloudEnvSetupTurnAlreadyAttached(prompt: string): boolean {
  return prompt.includes(CLOUD_ENV_SETUP_TURN_HEADER);
}

/**
 * Choose the skill reference. Migration intent wins. A missing environment or
 * an explicit create request uses create. Otherwise `environmentJsonPath`
 * distinguishes repository-managed from dashboard-managed updates. Ordinary
 * prompts against an existing environment leave setup unattached.
 */
export function selectCloudEnvSetupWorkflow(input: {
  readonly prompt: string;
  readonly environmentInfo?: {
    readonly environmentId?: string | undefined;
    readonly environmentJsonPath?: string | null | undefined;
  };
}): CloudEnvSetupWorkflow | null {
  if (cloudEnvSetupTurnAlreadyAttached(input.prompt)) return null;
  const intent = cloudEnvSetupPromptIntent(input.prompt);
  const environmentId = input.environmentInfo?.environmentId?.trim() ?? "";
  const hasEnvironment = environmentId.length > 0;
  const environmentJsonPath = input.environmentInfo?.environmentJsonPath?.trim() ?? "";

  if (intent === "migrate") return hasEnvironment ? "migrate" : "create";
  if (!hasEnvironment || intent === "create") return "create";
  if (intent === "none") return null;
  return environmentJsonPath.length > 0 ? "repo-managed" : "db-managed";
}

export function cloudEnvSetupMappedToolName(name: string): string {
  return CLOUD_DIAGNOSTICS_CURSOR_TOOL_NAMES[name] ?? name;
}
