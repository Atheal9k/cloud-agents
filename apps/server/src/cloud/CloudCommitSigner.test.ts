import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { make } from "./CloudCommitSigner.ts";
import { CLOUD_COMMIT_SIGNING_SERVICE_IDENTITY } from "./cloudCommitSigningPolicy.ts";

it.layer(NodeServices.layer)("CloudCommitSigner", (it) => {
  it.effect("signs a publication commit and refuses task-code callers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.make();
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-commit-signer-" });
      const workspace = path.join(root, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });
      const git = (args: ReadonlyArray<string>) =>
        runner.run({ command: "git", args, cwd: workspace }).pipe(Effect.orDie);
      yield* git(["init", "--initial-branch=main"]);
      yield* git(["config", "user.name", "Publication Test"]);
      yield* git(["config", "user.email", "publication@example.test"]);
      yield* fs.writeFileString(path.join(workspace, "tracked.txt"), "base\n");
      yield* git(["add", "tracked.txt"]);
      yield* git(["commit", "-m", "base"]);
      const base = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
      yield* fs.writeFileString(path.join(workspace, "tracked.txt"), "changed\n");

      const signer = yield* make({ keyRoot: path.join(root, "keys") }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      const denied = yield* signer
        .signCommit({
          caller: { kind: "task-code" },
          allowedRepository: "acme/app",
          cwd: workspace,
          baseCommit: base,
          message: "should fail\n",
          provenance: {
            baseCommit: base,
            repository: "acme/app",
            principal: { kind: "user", id: "alice" },
          },
        })
        .pipe(Effect.result);
      expect(denied._tag).toBe("Failure");

      const signed = yield* signer.signCommit({
        caller: {
          kind: "trusted-publication",
          repository: "acme/app",
          identity: CLOUD_COMMIT_SIGNING_SERVICE_IDENTITY,
        },
        allowedRepository: "acme/app",
        cwd: workspace,
        baseCommit: base,
        message: "feat: signed\n",
        provenance: {
          baseCommit: base,
          repository: "acme/app",
          principal: { kind: "user", id: "alice" },
        },
      });
      expect(signed).not.toBeNull();
      expect(signed?.signature.algorithm).toBe("ssh-ed25519");
      expect(signed?.signature.backing).toBe("hsm");
      const verify = yield* runner.run({
        command: "git",
        args: ["log", "-1", "--pretty=%G?"],
        cwd: workspace,
      });
      expect(verify.code).toBe(ChildProcessSpawner.ExitCode(0));
      expect(yield* signer.available).toBe(true);
    }),
  );
});
