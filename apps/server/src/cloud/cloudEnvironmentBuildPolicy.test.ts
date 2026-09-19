import {
  CloudEnvironmentBuild,
  type CloudEnvironmentConfig,
  type CloudEnvironmentSecretReference,
  CloudEnvironmentVersionId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  cloudEnvironmentBuildFingerprint,
  isCloudEnvironmentBuildStale,
  planCloudEnvironmentBuild,
} from "./cloudEnvironmentBuildPolicy.ts";

const decodeBuild = Schema.decodeSync(CloudEnvironmentBuild);
const VERSION_ID = CloudEnvironmentVersionId.make("environment-web:1");

const config = {
  image: "node:24-bookworm",
  install: "pnpm install",
  user: "node",
} satisfies CloudEnvironmentConfig;

const secrets: ReadonlyArray<CloudEnvironmentSecretReference> = [
  { name: "NPM_TOKEN", reference: "secret/npm", availability: "build" },
  { name: "SENTRY_DSN", reference: "secret/sentry", availability: "runtime" },
];

const gitSetup = [
  { repository: "acme/web", defaultRef: "main", commit: "a".repeat(40) },
  { repository: "acme/api", defaultRef: "main", commit: "b".repeat(40) },
];

const fingerprint = cloudEnvironmentBuildFingerprint({
  versionId: VERSION_ID,
  config,
  secretReferences: secrets,
  gitSetup,
});

const succeededBuild = decodeBuild({
  id: "build-1",
  environmentId: "environment-web",
  versionId: VERSION_ID,
  version: 1,
  trigger: "manual",
  draft: false,
  base: { kind: "image", image: "node:24-bookworm" },
  inputsFingerprint: fingerprint,
  gitSetup,
  logs: [],
  timings: {},
  outcome: {
    status: "succeeded",
    snapshot: {
      id: "build-1",
      digest: "c".repeat(64),
      sizeBytes: 2048,
      createdAt: "2026-09-19T02:00:00.000Z",
    },
    completedAt: "2026-09-19T02:00:00.000Z",
  },
  startedAt: "2026-09-19T01:59:00.000Z",
  freshAt: "2026-09-19T02:00:00.000Z",
});

it("fingerprints the same inputs identically whatever order the keys arrive in", () => {
  const reordered = cloudEnvironmentBuildFingerprint({
    versionId: VERSION_ID,
    config: { user: "node", install: "pnpm install", image: "node:24-bookworm" },
    secretReferences: [secrets[1]!, secrets[0]!],
    gitSetup: [gitSetup[1]!, gitSetup[0]!],
  });
  expect(reordered).toBe(fingerprint);
});

it("ignores runtime secrets, which never enter the shared snapshot", () => {
  const withoutRuntimeSecret = cloudEnvironmentBuildFingerprint({
    versionId: VERSION_ID,
    config,
    secretReferences: [secrets[0]!],
    gitSetup,
  });
  expect(withoutRuntimeSecret).toBe(fingerprint);
});

it("changes when a cloned commit moves", () => {
  const moved = cloudEnvironmentBuildFingerprint({
    versionId: VERSION_ID,
    config,
    secretReferences: secrets,
    gitSetup: [gitSetup[0]!, { ...gitSetup[1]!, commit: "d".repeat(40) }],
  });
  expect(moved).not.toBe(fingerprint);
});

it("skips only a recurring trigger whose inputs match the active Build", () => {
  expect(
    planCloudEnvironmentBuild({
      trigger: "recurring",
      fingerprint,
      activeBuild: succeededBuild,
    }),
  ).toEqual({ action: "skip", reusedBuildId: "build-1" });

  for (const trigger of ["manual", "configuration-change", "agent-requested"] as const) {
    expect(
      planCloudEnvironmentBuild({ trigger, fingerprint, activeBuild: succeededBuild }),
    ).toEqual({ action: "build" });
  }
});

it("rebuilds a recurring trigger when the inputs moved or nothing is active", () => {
  expect(
    planCloudEnvironmentBuild({
      trigger: "recurring",
      fingerprint: "e".repeat(64),
      activeBuild: succeededBuild,
    }),
  ).toEqual({ action: "build" });
  expect(
    planCloudEnvironmentBuild({ trigger: "recurring", fingerprint, activeBuild: undefined }),
  ).toEqual({ action: "build" });
});

it("treats a Build as fresh inside the threshold and stale outside it", () => {
  expect(
    isCloudEnvironmentBuildStale({
      build: succeededBuild,
      now: "2026-09-19T20:00:00.000Z",
    }),
  ).toBe(false);
  expect(
    isCloudEnvironmentBuildStale({
      build: succeededBuild,
      now: "2026-09-20T03:00:00.000Z",
    }),
  ).toBe(true);
});

it("always refreshes at a zero threshold and never trusts a draft or missing Build", () => {
  expect(
    isCloudEnvironmentBuildStale({
      build: succeededBuild,
      staleThresholdSeconds: 0,
      now: "2026-09-19T02:00:01.000Z",
    }),
  ).toBe(true);
  expect(
    isCloudEnvironmentBuildStale({
      build: { ...succeededBuild, draft: true },
      now: "2026-09-19T02:00:01.000Z",
    }),
  ).toBe(true);
  expect(isCloudEnvironmentBuildStale({ build: undefined, now: "2026-09-19T02:00:01.000Z" })).toBe(
    true,
  );
});
