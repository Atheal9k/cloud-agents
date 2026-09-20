// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  CLOUD_DIAGNOSTICS_SETUP_TOOLS,
  CLOUD_ENV_SETUP_GUEST_HOME_DIRS,
  CLOUD_ENV_SETUP_REFERENCE_FILES,
  CLOUD_ENV_SETUP_RELATIVE_DIR,
  CLOUD_ENV_SETUP_SKILL_NAME,
  CLOUD_ENV_SETUP_TURN_HEADER,
  type CloudEnvSetupWorkflow,
  cloudEnvSetupTurnAlreadyAttached,
  selectCloudEnvSetupWorkflow,
} from "@t3tools/contracts";

import envSetupSkillMd from "../../../../.agents/skills/env-setup/SKILL.md?raw";
import createEnvironmentMd from "../../../../.agents/skills/env-setup/references/create-environment.md?raw";
import updateRepoManagedMd from "../../../../.agents/skills/env-setup/references/update-repo-managed-environment.md?raw";
import updateDbManagedMd from "../../../../.agents/skills/env-setup/references/update-db-managed-environment.md?raw";
import migrateToBuildsMd from "../../../../.agents/skills/env-setup/references/migrate-to-builds.md?raw";

const SKILL_FILE = "SKILL.md";
const OPENER_FENCE = /```text\n([\s\S]*?)\n```/;
const CHECKLIST_TITLES = [
  "Understand the codebase",
  "Generate setup script",
  "Take a snapshot",
  "Verify build in a subagent",
  "Verify success and show card",
] as const;

export class CloudEnvSetupSkillError extends Error {
  readonly _tag = "CloudEnvSetupSkillError";
  readonly reason: "missing-skill" | "missing-reference" | "invalid-skill";

  constructor(reason: "missing-skill" | "missing-reference" | "invalid-skill", message: string) {
    super(message);
    this.name = "CloudEnvSetupSkillError";
    this.reason = reason;
  }
}

export interface CloudEnvSetupSkillFile {
  readonly relativePath: string;
  readonly contents: string;
}

export interface CloudEnvSetupSkillPackage {
  readonly name: typeof CLOUD_ENV_SETUP_SKILL_NAME;
  readonly directory: string;
  readonly skill: CloudEnvSetupSkillFile;
  readonly references: { readonly [K in CloudEnvSetupWorkflow]: CloudEnvSetupSkillFile };
  readonly opener: string;
  readonly checklist: ReadonlyArray<(typeof CHECKLIST_TITLES)[number]>;
}

export interface CloudEnvSetupTurn {
  readonly workflow: CloudEnvSetupWorkflow;
  readonly opener: string | null;
  readonly checklist: ReadonlyArray<(typeof CHECKLIST_TITLES)[number]> | null;
  readonly requiredTools: typeof CLOUD_DIAGNOSTICS_SETUP_TOOLS;
  readonly beforeFirstToolCall: ReadonlyArray<"skill" | "reference" | "opener" | "checklist">;
  readonly affectsRunningAgent: false;
  readonly prompt: string;
}

function readFile(path: string): string {
  return NodeFS.readFileSync(path, "utf8");
}

function exists(path: string): boolean {
  try {
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findCloudEnvSetupSkillDirectory(from = import.meta.dirname): string {
  let current = from.startsWith("file:") ? NodeURL.fileURLToPath(from) : from;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = NodePath.join(current, CLOUD_ENV_SETUP_RELATIVE_DIR);
    if (exists(NodePath.join(candidate, SKILL_FILE))) return candidate;
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new CloudEnvSetupSkillError(
    "missing-skill",
    `Cloud Agents could not discover '${CLOUD_ENV_SETUP_SKILL_NAME}' under ${CLOUD_ENV_SETUP_RELATIVE_DIR}.`,
  );
}

function parseOpener(createReference: string): string {
  const match = OPENER_FENCE.exec(createReference);
  const opener = match?.[1]?.trim() ?? "";
  if (!opener.startsWith("Environments let agents run")) {
    throw new CloudEnvSetupSkillError(
      "invalid-skill",
      "The create-environment reference is missing its verbatim opener.",
    );
  }
  return opener.replaceAll("\r\n", "\n");
}

function parseChecklist(createReference: string): CloudEnvSetupSkillPackage["checklist"] {
  for (const title of CHECKLIST_TITLES) {
    if (!createReference.includes(`\`${title}\``) && !createReference.includes(title)) {
      throw new CloudEnvSetupSkillError(
        "invalid-skill",
        `The create-environment checklist is missing '${title}'.`,
      );
    }
  }
  return CHECKLIST_TITLES;
}

function resolveReference(directory: string, relativePath: string): CloudEnvSetupSkillFile {
  const absolute = NodePath.join(directory, relativePath);
  if (!exists(absolute)) {
    throw new CloudEnvSetupSkillError(
      "missing-reference",
      `env-setup is missing '${relativePath}' relative to its skill directory.`,
    );
  }
  return { relativePath, contents: readFile(absolute).replaceAll("\r\n", "\n") };
}

function assembleCloudEnvSetupSkillPackage(input: {
  readonly directory: string;
  readonly skillContents: string;
  readonly references: CloudEnvSetupSkillPackage["references"];
}): CloudEnvSetupSkillPackage {
  const skill = {
    relativePath: SKILL_FILE,
    contents: input.skillContents.replaceAll("\r\n", "\n"),
  };
  for (const relativePath of Object.values(CLOUD_ENV_SETUP_REFERENCE_FILES)) {
    if (!skill.contents.includes(relativePath)) {
      throw new CloudEnvSetupSkillError(
        "invalid-skill",
        `SKILL.md does not resolve '${relativePath}' relative to the skill directory.`,
      );
    }
  }
  return {
    name: CLOUD_ENV_SETUP_SKILL_NAME,
    directory: input.directory,
    skill,
    references: input.references,
    opener: parseOpener(input.references.create.contents),
    checklist: parseChecklist(input.references.create.contents),
  };
}

/** Inlined by the CLI pack so a published `t3` still has the skill without a git checkout. */
export function loadBundledCloudEnvSetupSkillPackage(): CloudEnvSetupSkillPackage {
  return assembleCloudEnvSetupSkillPackage({
    directory: CLOUD_ENV_SETUP_RELATIVE_DIR,
    skillContents: envSetupSkillMd,
    references: {
      create: {
        relativePath: CLOUD_ENV_SETUP_REFERENCE_FILES.create,
        contents: createEnvironmentMd.replaceAll("\r\n", "\n"),
      },
      "repo-managed": {
        relativePath: CLOUD_ENV_SETUP_REFERENCE_FILES["repo-managed"],
        contents: updateRepoManagedMd.replaceAll("\r\n", "\n"),
      },
      "db-managed": {
        relativePath: CLOUD_ENV_SETUP_REFERENCE_FILES["db-managed"],
        contents: updateDbManagedMd.replaceAll("\r\n", "\n"),
      },
      migrate: {
        relativePath: CLOUD_ENV_SETUP_REFERENCE_FILES.migrate,
        contents: migrateToBuildsMd.replaceAll("\r\n", "\n"),
      },
    },
  });
}

export function loadCloudEnvSetupSkillPackage(directory?: string): CloudEnvSetupSkillPackage {
  if (directory === undefined) {
    try {
      return loadCloudEnvSetupSkillPackage(findCloudEnvSetupSkillDirectory());
    } catch (error) {
      if (error instanceof CloudEnvSetupSkillError && error.reason === "missing-skill") {
        return loadBundledCloudEnvSetupSkillPackage();
      }
      throw error;
    }
  }
  const skillPath = NodePath.join(directory, SKILL_FILE);
  if (!exists(skillPath)) {
    throw new CloudEnvSetupSkillError(
      "missing-skill",
      `env-setup is missing ${SKILL_FILE} in '${directory}'.`,
    );
  }
  return assembleCloudEnvSetupSkillPackage({
    directory,
    skillContents: readFile(skillPath),
    references: {
      create: resolveReference(directory, CLOUD_ENV_SETUP_REFERENCE_FILES.create),
      "repo-managed": resolveReference(directory, CLOUD_ENV_SETUP_REFERENCE_FILES["repo-managed"]),
      "db-managed": resolveReference(directory, CLOUD_ENV_SETUP_REFERENCE_FILES["db-managed"]),
      migrate: resolveReference(directory, CLOUD_ENV_SETUP_REFERENCE_FILES.migrate),
    },
  });
}

export function installCloudEnvSetupSkillPackage(input: {
  readonly skill: CloudEnvSetupSkillPackage;
  readonly home: string;
}): ReadonlyArray<string> {
  const written: string[] = [];
  for (const relativeDir of CLOUD_ENV_SETUP_GUEST_HOME_DIRS) {
    const destination = NodePath.join(input.home, relativeDir);
    NodeFS.mkdirSync(NodePath.join(destination, "references"), { recursive: true });
    const skillPath = NodePath.join(destination, SKILL_FILE);
    NodeFS.writeFileSync(skillPath, input.skill.skill.contents);
    written.push(skillPath);
    for (const file of Object.values(input.skill.references)) {
      const filePath = NodePath.join(destination, file.relativePath);
      NodeFS.writeFileSync(filePath, file.contents);
      written.push(filePath);
    }
  }
  return written;
}

function workflowHeading(workflow: CloudEnvSetupWorkflow): string {
  switch (workflow) {
    case "create":
      return "create or fully set up an environment";
    case "repo-managed":
      return "update a repository-managed environment";
    case "db-managed":
      return "update a DB-managed environment";
    case "migrate":
      return "migrate an environment to builds";
  }
}

export function buildCloudEnvSetupTurn(input: {
  readonly skill: CloudEnvSetupSkillPackage;
  readonly workflow: CloudEnvSetupWorkflow;
  readonly userPrompt: string;
}): CloudEnvSetupTurn {
  if (cloudEnvSetupTurnAlreadyAttached(input.userPrompt)) {
    return {
      workflow: input.workflow,
      opener: input.workflow === "create" ? input.skill.opener : null,
      checklist: input.workflow === "create" ? input.skill.checklist : null,
      requiredTools: CLOUD_DIAGNOSTICS_SETUP_TOOLS,
      beforeFirstToolCall:
        input.workflow === "create"
          ? ["skill", "reference", "opener", "checklist"]
          : ["skill", "reference"],
      affectsRunningAgent: false,
      prompt: input.userPrompt,
    };
  }
  const reference = input.skill.references[input.workflow];
  const create = input.workflow === "create";
  const beforeFirstToolCall = create
    ? (["skill", "reference", "opener", "checklist"] as const)
    : (["skill", "reference"] as const);
  const prompt = [
    input.userPrompt.trim(),
    "",
    "---",
    CLOUD_ENV_SETUP_TURN_HEADER,
    "",
    `Load the env-setup skill and the ${workflowHeading(input.workflow)} reference before the first tool call.`,
    "Environment configuration changes affect newly started agents. Do not claim to rebuild or migrate this running agent.",
    create
      ? "Send the create reference's verbatim opener as plain chat text, then create its exact five-item checklist, before calling any tool."
      : "Call environment-info before treating a later workflow as selected. The matching reference is already inlined.",
    "",
    `# ${input.skill.skill.relativePath}`,
    input.skill.skill.contents.trim(),
    "",
    `# ${reference.relativePath}`,
    reference.contents.trim(),
  ].join("\n");
  return {
    workflow: input.workflow,
    opener: create ? input.skill.opener : null,
    checklist: create ? input.skill.checklist : null,
    requiredTools: CLOUD_DIAGNOSTICS_SETUP_TOOLS,
    beforeFirstToolCall,
    affectsRunningAgent: false,
    prompt,
  };
}

export function attachCloudEnvSetupTurn(input: {
  readonly prompt: string;
  readonly environmentInfo?: {
    readonly environmentId?: string | undefined;
    readonly environmentJsonPath?: string | null | undefined;
  };
  readonly skill?: CloudEnvSetupSkillPackage;
}): { readonly prompt: string; readonly workflow: CloudEnvSetupWorkflow | null } {
  const workflow = selectCloudEnvSetupWorkflow({
    prompt: input.prompt,
    ...(input.environmentInfo === undefined ? {} : { environmentInfo: input.environmentInfo }),
  });
  if (workflow === null) return { prompt: input.prompt, workflow: null };
  const skill = input.skill ?? loadCloudEnvSetupSkillPackage();
  return {
    prompt: buildCloudEnvSetupTurn({ skill, workflow, userPrompt: input.prompt }).prompt,
    workflow,
  };
}
