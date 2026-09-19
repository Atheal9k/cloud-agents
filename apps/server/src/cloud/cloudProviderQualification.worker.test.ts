// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { cloudProviderWorkerHomes } from "@t3tools/contracts";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../../../");

describe("cloud worker provider homes", () => {
  it("keeps enabled provider credential directories distinct in the worker unit", () => {
    const unit = NodeFs.readFileSync(
      NodePath.join(repoRoot, "infra/cloud-agents/image/files/cloud-agent-worker.service"),
      "utf8",
    );
    const bootstrap = [
      NodeFs.readFileSync(
        NodePath.join(repoRoot, "infra/cloud-agents/image/scripts/cloud-agent-worker-credentials"),
        "utf8",
      ),
      NodeFs.readFileSync(
        NodePath.join(repoRoot, "infra/cloud-agents/image/scripts/verify-worker-image.sh"),
        "utf8",
      ),
    ].join("\n");
    const homes = cloudProviderWorkerHomes();
    expect(homes.length).toBeGreaterThan(1);
    for (const home of homes) {
      expect(unit).toContain(`Environment=${home.env}=${home.path}`);
      expect(bootstrap).toContain(home.path);
      expect(home.path.startsWith("/run/t3-worker/credentials/")).toBe(true);
    }
    expect(unit).not.toContain("Environment=HOME=/run/t3-worker/credentials");
  });
});
