import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CLOUD_DIAGNOSTICS_SETUP_TOOLS,
  CLOUD_ENV_SETUP_REFERENCE_FILES,
  CLOUD_ENV_SETUP_TURN_HEADER,
  CLOUD_ENV_SETUP_USER_REQUEST,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  CloudEnvSetupSkillError,
  attachCloudEnvSetupTurn,
  buildCloudEnvSetupTurn,
  findCloudEnvSetupSkillDirectory,
  installCloudEnvSetupSkillPackage,
  loadCloudEnvSetupSkillPackage,
} from "./cloudEnvSetupSkill.ts";

describe("cloud env-setup skill package", () => {
  it("discovers env-setup and resolves all four references from the skill directory", () => {
    const directory = findCloudEnvSetupSkillDirectory();
    const skill = loadCloudEnvSetupSkillPackage(directory);

    expect(skill.name).toBe("env-setup");
    expect(skill.directory).toBe(directory);
    expect(skill.skill.contents).toContain("name: env-setup");
    for (const relativePath of Object.values(CLOUD_ENV_SETUP_REFERENCE_FILES)) {
      expect(skill.skill.contents).toContain(relativePath);
      expect(NodeFS.existsSync(NodePath.join(directory, relativePath))).toBe(true);
    }
    expect(skill.opener.startsWith("Environments let agents run")).toBe(true);
    expect(skill.opener).toContain("Interrupt anytime to steer the agent or ask questions.");
    expect(skill.checklist).toEqual([
      "Understand the codebase",
      "Generate setup script",
      "Take a snapshot",
      "Verify build in a subagent",
      "Verify success and show card",
    ]);
  });

  it("fails packaging when the skill or a referenced workflow is missing", () => {
    const missingSkill = NodePath.join(NodeOS.tmpdir(), `env-setup-missing-${Date.now()}`);
    NodeFS.mkdirSync(missingSkill, { recursive: true });
    expect(() => loadCloudEnvSetupSkillPackage(missingSkill)).toThrow(CloudEnvSetupSkillError);

    const incomplete = NodePath.join(NodeOS.tmpdir(), `env-setup-incomplete-${Date.now()}`);
    NodeFS.mkdirSync(NodePath.join(incomplete, "references"), { recursive: true });
    const complete = loadCloudEnvSetupSkillPackage();
    NodeFS.writeFileSync(NodePath.join(incomplete, "SKILL.md"), complete.skill.contents);
    NodeFS.writeFileSync(
      NodePath.join(incomplete, CLOUD_ENV_SETUP_REFERENCE_FILES.create),
      complete.references.create.contents,
    );
    expect(() => loadCloudEnvSetupSkillPackage(incomplete)).toThrow(/missing 'references\//);
  });

  it("installs the package so Cursor, Claude, and Codex skill roots can discover it", () => {
    const home = NodePath.join(NodeOS.tmpdir(), `env-setup-home-${Date.now()}`);
    const written = installCloudEnvSetupSkillPackage({
      skill: loadCloudEnvSetupSkillPackage(),
      home,
    });
    expect(written.some((path) => path.endsWith(`${NodePath.sep}SKILL.md`))).toBe(true);
    expect(
      NodeFS.readFileSync(
        NodePath.join(home, ".agents/skills/env-setup/references/create-environment.md"),
        "utf8",
      ),
    ).toContain("verbatim opener");
    expect(
      NodeFS.existsSync(
        NodePath.join(home, ".cursor/skills/env-setup/references/migrate-to-builds.md"),
      ),
    ).toBe(true);
    expect(
      NodeFS.existsSync(
        NodePath.join(
          home,
          ".claude/skills/env-setup/references/update-db-managed-environment.md",
        ),
      ),
    ).toBe(true);
  });

  it("inlines the create reference before the first tool call", () => {
    const skill = loadCloudEnvSetupSkillPackage();
    const turn = buildCloudEnvSetupTurn({
      skill,
      workflow: "create",
      userPrompt: CLOUD_ENV_SETUP_USER_REQUEST,
    });

    expect(turn.beforeFirstToolCall).toEqual(["skill", "reference", "opener", "checklist"]);
    expect(turn.prompt.indexOf(CLOUD_ENV_SETUP_TURN_HEADER)).toBeGreaterThan(-1);
    expect(turn.prompt.indexOf(skill.skill.contents.trim())).toBeGreaterThan(
      turn.prompt.indexOf(CLOUD_ENV_SETUP_TURN_HEADER),
    );
    expect(turn.prompt.indexOf("references/create-environment.md")).toBeGreaterThan(
      turn.prompt.indexOf("# SKILL.md"),
    );
    expect(turn.opener).toBe(skill.opener);
    expect(turn.checklist).toEqual(skill.checklist);
    expect(turn.requiredTools).toEqual(CLOUD_DIAGNOSTICS_SETUP_TOOLS);
    expect(turn.affectsRunningAgent).toBe(false);
    expect(turn.prompt).toContain("newly started agents");
    expect(turn.prompt).toContain("Do not claim to rebuild or migrate this running agent.");
  });

  it("is idempotent when the skill is already inlined", () => {
    const first = attachCloudEnvSetupTurn({ prompt: CLOUD_ENV_SETUP_USER_REQUEST });
    const second = attachCloudEnvSetupTurn({ prompt: first.prompt });
    expect(first.workflow).toBe("create");
    expect(second.prompt).toBe(first.prompt);
    expect(second.workflow).toBeNull();
  });
});
