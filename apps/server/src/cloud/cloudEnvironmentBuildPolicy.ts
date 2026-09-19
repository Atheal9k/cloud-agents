// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  cloudEnvironmentBuildSecrets,
  DEFAULT_STALE_BUILD_THRESHOLD_SECONDS,
  type CloudEnvironmentBuild,
  type CloudEnvironmentBuildGitSetup,
  type CloudEnvironmentBuildTrigger,
  type CloudEnvironmentConfig,
  type CloudEnvironmentSecretReference,
  type CloudEnvironmentVersion,
} from "@t3tools/contracts";

/**
 * Key order in a decoded config follows however it was parsed, so hashing it
 * directly would report a change that never happened. Sort on the way in.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Identifies everything a Build's contents depend on: the config it was made
 * from, the build-time secrets it was allowed to see, and the commits it
 * cloned. Runtime secrets are excluded because they never enter the snapshot.
 */
export function cloudEnvironmentBuildFingerprint(input: {
  readonly versionId: CloudEnvironmentVersion["id"];
  readonly config: CloudEnvironmentConfig;
  readonly secretReferences: ReadonlyArray<CloudEnvironmentSecretReference>;
  readonly gitSetup: ReadonlyArray<CloudEnvironmentBuildGitSetup>;
}): string {
  const canonical = stableStringify({
    versionId: input.versionId,
    config: input.config,
    secrets: cloudEnvironmentBuildSecrets(input.secretReferences).map((secret) => ({
      name: secret.name,
      reference: secret.reference,
    })),
    gitSetup: [...input.gitSetup]
      .map((entry) => ({
        repository: entry.repository,
        defaultRef: entry.defaultRef,
        commit: entry.commit,
      }))
      .sort((left, right) => (left.repository < right.repository ? -1 : 1)),
  });
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex");
}

export type CloudEnvironmentBuildPlan =
  | { readonly action: "build" }
  | { readonly action: "skip"; readonly reusedBuildId: CloudEnvironmentBuild["id"] };

/**
 * Only a recurring trigger may skip. A person asking for a Build, a
 * configuration change, or an agent request always produces a new snapshot,
 * because each of those means the caller wants the disk rebuilt.
 */
export function planCloudEnvironmentBuild(input: {
  readonly trigger: CloudEnvironmentBuildTrigger;
  readonly fingerprint: string;
  readonly activeBuild: CloudEnvironmentBuild | undefined;
}): CloudEnvironmentBuildPlan {
  if (input.trigger !== "recurring") return { action: "build" };
  const active = input.activeBuild;
  if (active === undefined || active.outcome.status !== "succeeded") return { action: "build" };
  return active.inputsFingerprint === input.fingerprint
    ? { action: "skip", reusedBuildId: active.id }
    : { action: "build" };
}

/**
 * A missing or unsuccessful Build is stale by definition: there is nothing to
 * boot. A threshold of `0` refreshes every time.
 */
export function isCloudEnvironmentBuildStale(input: {
  readonly build: CloudEnvironmentBuild | undefined;
  readonly staleThresholdSeconds?: number | undefined;
  readonly now: string;
}): boolean {
  const build = input.build;
  if (build === undefined || build.outcome.status !== "succeeded" || build.draft) return true;
  const threshold = input.staleThresholdSeconds ?? DEFAULT_STALE_BUILD_THRESHOLD_SECONDS;
  if (threshold === 0) return true;
  const freshAt = Date.parse(build.freshAt ?? build.outcome.completedAt);
  const now = Date.parse(input.now);
  if (Number.isNaN(freshAt) || Number.isNaN(now)) return true;
  return now - freshAt > threshold * 1000;
}
