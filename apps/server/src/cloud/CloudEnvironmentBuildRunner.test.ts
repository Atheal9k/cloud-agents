/**
 * Exercises a Build against a real Git remote, a real shell `install`, and a
 * real prepared tree on disk. Only the credential transport is substituted,
 * because GitHub SSH is the one part that cannot run locally.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { CloudEnvironmentBuildId, CloudEnvironmentSaveInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  CloudEnvironmentBuildCatalog,
  make as makeBuilds,
} from "./CloudEnvironmentBuildCatalog.ts";
import { make as makeRunner } from "./CloudEnvironmentBuildRunner.ts";
import { make as makeEnvironments } from "./CloudEnvironmentCatalog.ts";
import * as CloudGitCredentials from "./CloudGitCredentials.ts";

const decodeSave = Schema.decodeSync(CloudEnvironmentSaveInput);
const ProcessRunnerLayer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));
const TestLayer = Layer.mergeAll(ProcessRunnerLayer, SqlitePersistenceMemory).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** Writes `install.ok` and prints the Build secret so logs prove redaction. */
const INSTALL = `node -e "require('node:fs').writeFileSync('install.ok','installed\\n'); process.stdout.write(process.env.NPM_TOKEN || '')"`;
const FAILING_INSTALL = `node -e "process.exit(3)"`;

const fixture = Effect.fn("CloudEnvironmentBuildRunner.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-build-" });
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const buildRoot = path.join(root, "builds");

  const git = Effect.fn("CloudEnvironmentBuildRunner.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* processRunner.run({ command: "git", args, cwd }).pipe(Effect.orDie);
    assert.equal(result.code, ChildProcessSpawner.ExitCode(0), result.stderr);
    return result.stdout.trim();
  });

  yield* fs.makeDirectory(source, { recursive: true });
  yield* git(source, ["init", "--initial-branch=main"]);
  yield* git(source, ["config", "user.name", "Cloud Build Test"]);
  yield* git(source, ["config", "user.email", "cloud-build@example.test"]);
  yield* fs.writeFileString(path.join(source, "README.md"), "# Build fixture\n");
  yield* git(source, ["add", "."]);
  yield* git(source, ["commit", "-m", "base"]);
  const headCommit = yield* git(source, ["rev-parse", "HEAD"]);
  yield* git(root, ["init", "--bare", remote]);
  yield* git(source, ["remote", "add", "origin", remote]);
  yield* git(source, ["push", "origin", "main"]);

  const credentials = CloudGitCredentials.CloudGitCredentials.of({
    clone: ({ destination }) =>
      git(root, ["clone", "--no-checkout", "--no-tags", "--", remote, destination]).pipe(
        Effect.asVoid,
      ),
    fetch: ({ ref, cwd }) =>
      git(cwd, ["fetch", "--no-tags", "--force", "--", remote, ref]).pipe(Effect.asVoid),
    resolveRef: ({ ref }) =>
      git(root, ["ls-remote", "--", remote, ref]).pipe(
        Effect.map((output) => output.split(/\s+/)[0] ?? ""),
      ),
    push: () => Effect.void,
    readBranch: () => Effect.succeed(null),
    findPullRequest: () => Effect.succeed(null),
    createDraftPullRequest: () => Effect.die("This fixture never publishes."),
    createDraftRepository: () => Effect.die("This fixture never creates repositories."),
    closePullRequest: () => Effect.die("This fixture never deletes a pull request."),
    syncPrivateGitDependencies: ({ cwd, kinds }) =>
      Effect.gen(function* () {
        if (kinds.includes("submodule")) {
          yield* git(cwd, ["submodule", "update", "--init", "--recursive"]);
        }
        if (kinds.includes("lfs")) {
          yield* git(cwd, ["lfs", "pull"]);
        }
      }),
  });

  const environments = yield* makeEnvironments();
  const builds = yield* makeBuilds();

  const saveEnvironment = (install: string, occurredAt: string, expectedVersion?: number) =>
    environments.save(
      decodeSave({
        environmentId: "environment-build",
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        name: "Build fixture",
        source: { type: "saved", scope: "personal", owner: "victor" },
        repositories: [{ repository: "acme/web", defaultRef: "main" }],
        config: { image: "node:24-bookworm", install },
        secretReferences: [
          { name: "NPM_TOKEN", reference: "secret/npm", availability: "build" },
          { name: "SENTRY_DSN", reference: "secret/sentry", availability: "runtime" },
          {
            name: "USER_TOKEN",
            reference: "secret/user",
            availability: "runtime",
            scope: "user",
          },
        ],
        occurredAt,
      }),
    );

  const environment = yield* saveEnvironment(INSTALL, "2026-09-19T02:00:00.000Z");

  const runner = yield* makeRunner({ buildRoot, installTimeoutSeconds: 120 }).pipe(
    Effect.provideService(CloudGitCredentials.CloudGitCredentials, credentials),
    Effect.provideService(CloudEnvironmentBuildCatalog, builds),
  );

  return {
    fs,
    path,
    environments,
    builds,
    runner,
    headCommit,
    saveEnvironment,
    version: environment.current,
    secretValues: {
      "secret/npm": "npm-build-token",
      "secret/sentry": "runtime-dsn",
      "secret/user": "user-only-token",
    },
  };
});

it.effect(
  "clones the default ref, runs install, snapshots the tree, and activates it",
  () =>
    Effect.gen(function* () {
      const context = yield* fixture();
      const build = yield* context.runner.run({
        buildId: CloudEnvironmentBuildId.make("build-1"),
        version: context.version,
        trigger: "manual",
        draft: false,
        occurredAt: "2026-09-19T02:01:00.000Z",
        secretValues: context.secretValues,
      });

      assert(build.outcome.status === "succeeded");
      expect(build.gitSetup).toEqual([
        { repository: "acme/web", defaultRef: "main", commit: context.headCommit },
      ]);
      expect(build.logs).toHaveLength(1);
      expect(build.logs[0]?.exitCode).toBe(0);
      expect(build.logs[0]?.stdout).toContain("[redacted]");
      expect(build.logs[0]?.stdout).not.toContain("npm-build-token");
      expect(build.logs[0]?.stdout).not.toContain("user-only-token");
      expect(build.logs[0]?.stdout).not.toContain("runtime-dsn");
      expect(build.timings.clone).toBeDefined();
      expect(build.timings.install).toBeDefined();
      expect(build.timings.snapshot).toBeDefined();
      expect(build.outcome.snapshot.sizeBytes).toBeGreaterThan(0);

      // The snapshot is a real prepared tree: checkout and install output are both on disk.
      const tree = context.runner.snapshotPath(build.outcome.snapshot.id);
      const workspace = context.path.join(tree, "acme-web");
      expect(yield* context.fs.exists(context.path.join(workspace, "README.md"))).toBe(true);
      expect(yield* context.fs.readFileString(context.path.join(workspace, "install.ok"))).toBe(
        "installed\n",
      );

      const [environment] = yield* context.environments.list;
      expect(environment?.activeBuildId).toBe("build-1");
    }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(TestLayer)),
  120_000,
);

it.effect(
  "records the failing install and leaves the last active Build in place",
  () =>
    Effect.gen(function* () {
      const context = yield* fixture();
      yield* context.runner.run({
        buildId: CloudEnvironmentBuildId.make("build-1"),
        version: context.version,
        trigger: "manual",
        draft: false,
        occurredAt: "2026-09-19T02:01:00.000Z",
        secretValues: context.secretValues,
      });

      const broken = yield* context.saveEnvironment(FAILING_INSTALL, "2026-09-19T02:02:00.000Z", 1);
      const failed = yield* context.runner.run({
        buildId: CloudEnvironmentBuildId.make("build-2"),
        version: broken.current,
        trigger: "configuration-change",
        draft: false,
        occurredAt: "2026-09-19T02:02:30.000Z",
        secretValues: context.secretValues,
      });

      assert(failed.outcome.status === "failed");
      expect(failed.outcome.stage).toBe("install");
      expect(failed.outcome.message).toContain("code 3");
      expect(failed.logs[0]?.exitCode).toBe(3);
      // The failed tree is discarded rather than left occupying the Build root.
      expect(yield* context.fs.exists(context.runner.snapshotPath("build-2"))).toBe(false);

      const [environment] = yield* context.environments.list;
      expect(environment?.activeBuildId).toBe("build-1");
    }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(TestLayer)),
  120_000,
);

it.effect(
  "skips a recurring Build whose refs, config, and secrets have not moved",
  () =>
    Effect.gen(function* () {
      const context = yield* fixture();
      yield* context.runner.run({
        buildId: CloudEnvironmentBuildId.make("build-1"),
        version: context.version,
        trigger: "manual",
        draft: false,
        occurredAt: "2026-09-19T02:01:00.000Z",
        secretValues: context.secretValues,
      });

      const skipped = yield* context.runner.run({
        buildId: CloudEnvironmentBuildId.make("build-2"),
        version: context.version,
        trigger: "recurring",
        draft: false,
        occurredAt: "2026-09-20T02:01:00.000Z",
        secretValues: context.secretValues,
      });

      assert(skipped.outcome.status === "skipped");
      expect(skipped.outcome.reusedBuildId).toBe("build-1");
      // Nothing was cloned or installed for the skipped Build.
      expect(yield* context.fs.exists(context.runner.snapshotPath("build-2"))).toBe(false);
      expect(skipped.logs).toEqual([]);

      const active = yield* context.builds.activeBuild(context.version.environmentId);
      expect(active?.id).toBe("build-1");
      expect(active?.freshAt).toBeDefined();
    }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(TestLayer)),
  120_000,
);

it.effect(
  "keeps an agent-requested Build draft until it is saved",
  () =>
    Effect.gen(function* () {
      const context = yield* fixture();
      const draft = yield* context.runner.run({
        buildId: CloudEnvironmentBuildId.make("build-draft"),
        version: context.version,
        trigger: "agent-requested",
        draft: true,
        occurredAt: "2026-09-19T02:01:00.000Z",
        secretValues: context.secretValues,
      });

      expect(draft.draft).toBe(true);
      expect(draft.outcome.status).toBe("succeeded");
      expect((yield* context.environments.list)[0]?.activeBuildId).toBeUndefined();

      yield* context.builds.save({
        buildId: CloudEnvironmentBuildId.make("build-draft"),
        occurredAt: "2026-09-19T02:03:00.000Z",
      });
      expect((yield* context.environments.list)[0]?.activeBuildId).toBe("build-draft");
    }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(TestLayer)),
  120_000,
);

it.effect("rejects a Build before it starts when ports collide or Build secrets are missing", () =>
  Effect.gen(function* () {
    const context = yield* fixture();
    const colliding = yield* context.runner
      .run({
        buildId: CloudEnvironmentBuildId.make("build-ports"),
        version: {
          ...context.version,
          config: {
            ...context.version.config,
            ports: [
              { name: "web", port: 5173 },
              { name: "dup", port: 5173 },
            ],
          },
        },
        trigger: "manual",
        draft: false,
        occurredAt: "2026-09-19T02:01:00.000Z",
        secretValues: context.secretValues,
      })
      .pipe(Effect.flip);
    const missingSecret = yield* context.runner
      .run({
        buildId: CloudEnvironmentBuildId.make("build-secret"),
        version: context.version,
        trigger: "manual",
        draft: false,
        occurredAt: "2026-09-19T02:01:00.000Z",
      })
      .pipe(Effect.flip);

    expect(colliding.reason).toBe("admission-rejected");
    expect(colliding.message).toContain("Port 5173");
    expect(missingSecret.reason).toBe("admission-rejected");
    expect(missingSecret.message).toContain("NPM_TOKEN");
    expect(yield* context.builds.list).toEqual([]);
  }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(TestLayer)),
);

it.effect("rejects a private registry destination the egress policy cannot reach", () =>
  Effect.gen(function* () {
    const context = yield* fixture();
    const error = yield* context.runner
      .run({
        buildId: CloudEnvironmentBuildId.make("build-egress"),
        version: {
          ...context.version,
          config: {
            ...context.version.config,
            egressMode: "network_settings_only",
            egressAllowlist: [],
            privateDependencies: [
              {
                id: "npm",
                kind: "package-registry",
                destination: "https://npm.corp.example",
                secretName: "NPM_TOKEN",
              },
            ],
          },
        },
        trigger: "manual",
        draft: false,
        occurredAt: "2026-09-19T02:01:00.000Z",
        secretValues: context.secretValues,
      })
      .pipe(Effect.flip);

    expect(error.reason).toBe("admission-rejected");
    expect(error.message).toContain("npm.corp.example");
    expect(yield* context.builds.list).toEqual([]);
  }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(TestLayer)),
);

it.effect(
  "removes credential files from the prepared tree before it is snapshotted",
  () =>
    Effect.gen(function* () {
      const context = yield* fixture();
      const withNpmrc = yield* context.saveEnvironment(
        `node -e "require('node:fs').writeFileSync('.npmrc','_authToken=npm-build-token\\n');require('node:fs').writeFileSync('install.ok','installed\\n')"`,
        "2026-09-19T02:04:00.000Z",
        1,
      );
      const build = yield* context.runner.run({
        buildId: CloudEnvironmentBuildId.make("build-npmrc"),
        version: withNpmrc.current,
        trigger: "manual",
        draft: false,
        occurredAt: "2026-09-19T02:04:30.000Z",
        secretValues: context.secretValues,
      });

      assert(build.outcome.status === "succeeded");
      const workspace = context.path.join(
        context.runner.snapshotPath(build.outcome.snapshot.id),
        "acme-web",
      );
      expect(yield* context.fs.exists(context.path.join(workspace, ".npmrc"))).toBe(false);
      expect(yield* context.fs.exists(context.path.join(workspace, "install.ok"))).toBe(true);
    }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(TestLayer)),
  120_000,
);

it.effect(
  "clones every configured repository as a sibling in one Build",
  () =>
    Effect.gen(function* () {
      const context = yield* fixture();
      const environment = yield* context.environments.save(
        decodeSave({
          environmentId: "environment-build-multi",
          name: "Multi-repo Build",
          source: { type: "saved", scope: "personal", owner: "victor" },
          repositories: [
            { repository: "acme/web", defaultRef: "main" },
            { repository: "acme/api", defaultRef: "main" },
          ],
          config: { image: "node:24-bookworm", install: INSTALL },
          secretReferences: [{ name: "NPM_TOKEN", reference: "secret/npm", availability: "build" }],
          occurredAt: "2026-09-19T03:00:00.000Z",
        }),
      );
      const build = yield* context.runner.run({
        buildId: CloudEnvironmentBuildId.make("build-multi"),
        version: environment.current,
        trigger: "manual",
        draft: false,
        occurredAt: "2026-09-19T03:01:00.000Z",
        secretValues: { "secret/npm": "npm-build-token" },
      });

      assert(build.outcome.status === "succeeded");
      expect(build.gitSetup).toEqual([
        { repository: "acme/web", defaultRef: "main", commit: context.headCommit },
        { repository: "acme/api", defaultRef: "main", commit: context.headCommit },
      ]);
      const tree = context.runner.snapshotPath(build.outcome.snapshot.id);
      expect(yield* context.fs.exists(context.path.join(tree, "acme-web", "README.md"))).toBe(true);
      expect(yield* context.fs.exists(context.path.join(tree, "acme-api", "README.md"))).toBe(true);
      expect(
        yield* context.fs.readFileString(context.path.join(tree, "acme-web", "install.ok")),
      ).toBe("installed\n");
    }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(TestLayer)),
  120_000,
);
