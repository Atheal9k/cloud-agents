import { expect, it } from "@effect/vitest";

import { DAYTONA_WORKER_IMAGE_VERSIONS, daytonaWorkerImage } from "./daytonaWorkerImage.ts";

it("builds a pinned repository-independent Daytona worker image", () => {
  const dockerfile = daytonaWorkerImage().dockerfile;

  expect(dockerfile).toContain(`FROM ${DAYTONA_WORKER_IMAGE_VERSIONS.baseImage}`);
  expect(dockerfile).toContain(`t3@${DAYTONA_WORKER_IMAGE_VERSIONS.t3}`);
  expect(dockerfile).toContain(`@openai/codex@${DAYTONA_WORKER_IMAGE_VERSIONS.codex}`);
  expect(dockerfile).toContain(
    `@anthropic-ai/claude-code@${DAYTONA_WORKER_IMAGE_VERSIONS.claudeCode}`,
  );
  expect(dockerfile).toContain("git git-lfs jq openssh-client");
  expect(dockerfile).not.toContain("@latest");
  expect(dockerfile).not.toMatch(/\.codex|\.claude|\.ssh|\.t3\/userdata|git-credentials/i);
});
