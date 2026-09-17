import * as NodeServices from "@effect/platform-node/NodeServices";
import { CloudRepositoryPreparationInput, type CloudRepositoryRecipe } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as CloudGitCredentials from "./CloudGitCredentials.ts";
import { make } from "./CloudRepositoryPreparation.ts";

const decodeInput = Schema.decodeSync(CloudRepositoryPreparationInput);

const recipe: CloudRepositoryRecipe = {
  version: 1,
  repository: "Atheal9k/cloud-agents",
  outputBranchPrefix: "cloud/run",
  setup: [
    {
      name: "install",
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync('setup-complete.txt', 'ready'); console.log('setup ready')",
      ],
      timeoutSeconds: 30,
    },
  ],
  devServers: [
    {
      name: "web",
      port: 5173,
      command: {
        name: "serve-web",
        command: process.execPath,
        args: ["server.mjs"],
        timeoutSeconds: 300,
      },
    },
  ],
  verification: [
    {
      name: "focused-test",
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs'); if(fs.readFileSync('setup-complete.txt','utf8')!=='ready') process.exit(2); console.log('verified')",
      ],
      timeoutSeconds: 30,
    },
  ],
  secretReferences: [
    { environmentVariable: "PACKAGE_READ_TOKEN", reference: "cloud/package-read-token" },
  ],
};

function deadlineAfter(minutes: number): string {
  return `2099-01-01T00:${String(minutes).padStart(2, "0")}:00.000Z`;
}

it.layer(NodeServices.layer)("CloudRepositoryPreparation", (it) => {
  const fixture = Effect.fn("CloudRepositoryPreparation.test.fixture")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.make();
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-repository-" });
    const source = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspaces");

    const git = Effect.fn("CloudRepositoryPreparation.test.git")(function* (
      args: ReadonlyArray<string>,
      cwd?: string,
    ) {
      const result = yield* runner
        .run({ command: "git", args, ...(cwd ? { cwd } : {}) })
        .pipe(Effect.orDie);
      assert.equal(result.code, ChildProcessSpawner.ExitCode(0), result.stderr);
      return result.stdout.trim();
    });

    yield* fs.makeDirectory(source, { recursive: true });
    yield* git(["init", "--initial-branch=main"], source);
    yield* git(["config", "user.name", "Cloud Repository Test"], source);
    yield* git(["config", "user.email", "cloud-repository@example.test"], source);
    yield* fs.writeFileString(path.join(source, ".gitignore"), "local-only.txt\n");
    yield* fs.writeFileString(path.join(source, "AGENTS.md"), "# Repository instructions\n");
    yield* fs.writeFileString(path.join(source, "tracked.txt"), "tracked\n");
    yield* git(["add", "."], source);
    yield* git(["commit", "-m", "initial"], source);
    const sourceCommit = yield* git(["rev-parse", "HEAD"], source);
    yield* fs.writeFileString(path.join(source, "local-only.txt"), "ignored local state\n");
    yield* fs.writeFileString(path.join(source, "uncommitted.txt"), "uncommitted local state\n");

    const clone = (request: { readonly destination: string }) =>
      git(["clone", "--no-checkout", "--no-tags", "--", source, request.destination]).pipe(
        Effect.asVoid,
      );
    const fetch = (request: { readonly ref: string; readonly cwd: string }) =>
      git(["fetch", "--no-tags", "--force", "--", source, request.ref], request.cwd).pipe(
        Effect.asVoid,
      );
    const credentials = CloudGitCredentials.CloudGitCredentials.of({
      clone,
      fetch,
      push: () => Effect.die("push should not run during preparation"),
      createDraftPullRequest: () => Effect.die("PR creation should not run during preparation"),
    });
    const preparation = yield* make({ workspaceRoot }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(CloudGitCredentials.CloudGitCredentials, credentials),
    );
    return { fs, git, path, preparation, root, sourceCommit } as const;
  });

  it.effect("creates a clean isolated checkout and retains setup and verification results", () =>
    Effect.gen(function* () {
      const { fs, git, path, preparation, sourceCommit } = yield* fixture();
      const record = yield* preparation.prepare(
        decodeInput({
          allocationId: "allocation-one",
          attempt: 1,
          selectedRef: "main",
          deadline: deadlineAfter(2),
          recipe,
        }),
      );

      expect(record.resolvedCommit).toBe(sourceCommit);
      expect(record.outputBranch).toMatch(/^cloud\/run\/[0-9a-f]{12}$/);
      expect(record.instructionFiles).toEqual(["AGENTS.md"]);
      expect(record.setupResults).toMatchObject([
        { name: "install", exitCode: 0, timedOut: false, stdout: "setup ready\n" },
      ]);
      expect(record.devServers).toEqual(recipe.devServers);
      expect(record.verification).toEqual(recipe.verification);
      expect(record.permittedSecretReferences).toEqual(recipe.secretReferences);
      expect(yield* fs.exists(path.join(record.workspacePath, "local-only.txt"))).toBe(false);
      expect(yield* fs.exists(path.join(record.workspacePath, "uncommitted.txt"))).toBe(false);
      expect(yield* git(["branch", "--show-current"], record.workspacePath)).toBe(
        record.outputBranch,
      );

      yield* git(
        ["remote", "set-url", "origin", "ssh://attacker.invalid/changed.git"],
        record.workspacePath,
      );
      expect(record.repository).toBe("Atheal9k/cloud-agents");

      const verification = yield* preparation.verify({
        preparation: record,
        deadline: deadlineAfter(2),
      });
      expect(verification.results).toMatchObject([
        { name: "focused-test", exitCode: 0, timedOut: false, stdout: "verified\n" },
      ]);
    }),
  );

  it.effect("retains failed command output and exit code", () =>
    Effect.gen(function* () {
      const { preparation } = yield* fixture();
      const failure = yield* preparation
        .prepare(
          decodeInput({
            allocationId: "allocation-failed-setup",
            attempt: 1,
            selectedRef: "main",
            deadline: deadlineAfter(2),
            recipe: {
              ...recipe,
              setup: [
                {
                  name: "broken-setup",
                  command: process.execPath,
                  args: ["-e", "console.error('setup failed'); process.exit(7)"],
                  timeoutSeconds: 30,
                },
              ],
            },
          }),
        )
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        reason: "command-failed",
        stage: "setup",
        commandResults: [{ name: "broken-setup", exitCode: 7, stderr: "setup failed\n" }],
      });
    }),
  );

  it.effect("reports a missing setup dependency before an agent can start", () =>
    Effect.gen(function* () {
      const { preparation } = yield* fixture();
      const failure = yield* preparation
        .prepare(
          decodeInput({
            allocationId: "allocation-missing-dependency",
            attempt: 1,
            selectedRef: "main",
            deadline: deadlineAfter(2),
            recipe: {
              ...recipe,
              setup: [
                {
                  name: "missing-tool",
                  command: "t3-command-that-does-not-exist-ca10",
                  args: [],
                  timeoutSeconds: 30,
                },
              ],
            },
          }),
        )
        .pipe(Effect.flip);

      expect(failure.reason).toBe("dependency-missing");
      expect(failure.message).toContain("t3-command-that-does-not-exist-ca10");
    }),
  );

  it.effect("rejects ambiguous recipes before cloning", () =>
    Effect.gen(function* () {
      const { preparation } = yield* fixture();
      const failure = yield* preparation
        .prepare(
          decodeInput({
            allocationId: "allocation-invalid-recipe",
            attempt: 1,
            selectedRef: "main",
            deadline: deadlineAfter(2),
            recipe: {
              ...recipe,
              secretReferences: [
                { environmentVariable: "AWS_SECRET_ACCESS_KEY", reference: "must-not-pass" },
              ],
            },
          }),
        )
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: "invalid-recipe", stage: "setup" });
      expect(failure.message).toContain("reserved prefix");
    }),
  );
});
