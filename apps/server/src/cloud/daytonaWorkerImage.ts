import { Image } from "@daytona/sdk";

export const DAYTONA_WORKER_IMAGE_VERSIONS = {
  baseImage: "node:24.13.1-bookworm-slim",
  node: "24.13.1",
  t3: "0.0.42",
  t3LinuxX64: "0.0.42",
  codex: "0.154.0",
  claudeCode: "2.1.273",
} as const;

const SYSTEM_TOOLS = [
  "ca-certificates",
  "curl",
  "g++",
  "git",
  "git-lfs",
  "jq",
  "make",
  "openssh-client",
  "python3",
] as const;

/**
 * The shared image contains programs only. Repository checkouts, provider
 * homes, T3 userdata, credentials, and runtime secrets belong to a sandbox or
 * durable agent and are never image inputs.
 */
export function daytonaWorkerImage(
  baseImage: string = DAYTONA_WORKER_IMAGE_VERSIONS.baseImage,
): Image {
  return Image.base(baseImage)
    .runCommands(
      `apt-get update && apt-get install --yes --no-install-recommends ${SYSTEM_TOOLS.join(" ")} && rm -rf /var/lib/apt/lists/*`,
      `npm install --global --omit=dev --include=optional --no-audit --no-fund t3@${DAYTONA_WORKER_IMAGE_VERSIONS.t3} @t3code/t3-linux-x64@${DAYTONA_WORKER_IMAGE_VERSIONS.t3LinuxX64} @openai/codex@${DAYTONA_WORKER_IMAGE_VERSIONS.codex} @anthropic-ai/claude-code@${DAYTONA_WORKER_IMAGE_VERSIONS.claudeCode}`,
      "npm cache clean --force",
      "useradd --create-home --shell /bin/bash cloudagent && install -d -o cloudagent -g cloudagent -m 0750 /work /opt/t3",
    )
    .env({ HOME: "/home/cloudagent" })
    .workdir("/work")
    .cmd(["sleep", "infinity"]);
}
