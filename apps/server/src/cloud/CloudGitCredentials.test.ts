import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { decodePrivateKeySecret, make } from "./CloudGitCredentials.ts";

const privateKey = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "ZmFrZS1wcml2YXRlLWtleQ==",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

const rotatedPrivateKey = privateKey.replace(
  "ZmFrZS1wcml2YXRlLWtleQ==",
  "cm90YXRlZC1wcml2YXRlLWtleQ==",
);

const processOutput = (input?: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}): ProcessRunner.ProcessRunOutput => ({
  stdout: input?.stdout ?? "",
  stderr: input?.stderr ?? "",
  code: ChildProcessSpawner.ExitCode(input?.code ?? 0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

describe("decodePrivateKeySecret", () => {
  it("accepts raw OpenSSH and single-field JSON values with normalized line endings", () => {
    expect(decodePrivateKeySecret(privateKey.replaceAll("\n", "\r\n"))).toBe(privateKey);
    expect(decodePrivateKeySecret(JSON.stringify({ privateKey: privateKey.trimEnd() }))).toBe(
      privateKey,
    );
  });

  it("rejects malformed and ambiguous JSON secrets", () => {
    expect(decodePrivateKeySecret("not-a-key")).toBeNull();
    expect(decodePrivateKeySecret(JSON.stringify({ key: privateKey, note: "extra" }))).toBeNull();
    expect(decodePrivateKeySecret(JSON.stringify({ key: 123 }))).toBeNull();
  });
});

it.layer(NodeServices.layer)("CloudGitCredentials", (it) => {
  it.effect("clones through an isolated SSH-over-443 wrapper and removes run credentials", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-git-test-" });
      const destination = path.join(root, "workspace");
      const invocations: ProcessRunner.ProcessRunInput[] = [];
      let writtenKey = "";
      let wrapper = "";
      let knownHosts = "";
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            invocations.push(input);
            if (input.command === "aws") {
              return processOutput({
                stdout: JSON.stringify({ privateKey: privateKey.trimEnd() }),
              });
            }
            if (input.command === "ssh-keygen") {
              writtenKey = yield* fs.readFileString(input.args[4]!);
              return processOutput({ stdout: "ssh-ed25519 public-key\n" });
            }
            assert.equal(input.command, "git");
            const wrapperPath = input.env?.GIT_SSH;
            assert.isString(wrapperPath);
            wrapper = yield* fs.readFileString(wrapperPath);
            knownHosts = yield* fs.readFileString(
              path.join(path.dirname(wrapperPath), "known_hosts"),
            );
            return processOutput();
          }),
      });
      const credentials = yield* make({
        credentialRoot: path.join(root, "credentials"),
        sshSecretRef: "cloud-agent-victor-key",
        githubTokenSecretRef: undefined,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));

      yield* credentials.clone({
        runId: "allocation-one",
        repository: "Atheal9k/cloud-agents",
        destination,
      });

      assert.equal(writtenKey, privateKey);
      assert.include(wrapper, "Hostname=ssh.github.com");
      assert.include(wrapper, "Port=443");
      assert.include(wrapper, "StrictHostKeyChecking=yes");
      assert.include(wrapper, "IdentityAgent=none");
      assert.notInclude(wrapper, "fake-private-key");
      assert.equal(
        knownHosts,
        "[ssh.github.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
      );
      const git = invocations.find((entry) => entry.command === "git");
      assert.deepEqual(git?.args, [
        "clone",
        "--no-tags",
        "--origin",
        "origin",
        "--",
        "ssh://git@ssh.github.com:443/Atheal9k/cloud-agents.git",
        destination,
      ]);
      assert.equal(git?.env?.SSH_AUTH_SOCK, "");
      assert.equal(git?.env?.SSH_AGENT_PID, "");
      assert.deepEqual(yield* fs.readDirectory(path.join(root, "credentials")), []);
    }),
  );

  it.effect("pushes only to the configured repository and requested branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-git-push-" });
      let gitInput: ProcessRunner.ProcessRunInput | undefined;
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          if (input.command === "aws") return Effect.succeed(processOutput({ stdout: privateKey }));
          if (input.command === "ssh-keygen") return Effect.succeed(processOutput());
          gitInput = input;
          return Effect.succeed(processOutput());
        },
      });
      const credentials = yield* make({
        credentialRoot: path.join(root, "credentials"),
        sshSecretRef: "cloud-agent-victor-key",
        githubTokenSecretRef: undefined,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));

      yield* credentials.push({
        runId: "allocation-two",
        repository: "Atheal9k/cloud-agents",
        branch: "feat/ca-06",
        cwd: path.join(root, "workspace"),
      });

      assert.deepEqual(gitInput?.args, [
        "push",
        "--",
        "ssh://git@ssh.github.com:443/Atheal9k/cloud-agents.git",
        "HEAD:refs/heads/feat/ca-06",
      ]);
    }),
  );

  it.effect("creates a draft PR with the controller token and no gh login state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-github-test-" });
      let githubInput: ProcessRunner.ProcessRunInput | undefined;
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          if (input.command === "aws") {
            return Effect.succeed(processOutput({ stdout: JSON.stringify({ token: "ghp_test" }) }));
          }
          githubInput = input;
          return Effect.succeed(
            processOutput({
              stdout: JSON.stringify({
                number: 42,
                html_url: "https://github.com/Atheal9k/cloud-agents/pull/42",
              }),
            }),
          );
        },
      });
      const credentials = yield* make({
        credentialRoot: path.join(root, "credentials"),
        sshSecretRef: undefined,
        githubTokenSecretRef: "cloud-agent-github-token",
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));

      const pullRequest = yield* credentials.createDraftPullRequest({
        runId: "allocation-three",
        repository: "Atheal9k/cloud-agents",
        base: "main",
        head: "feat/ca-06",
        title: "feat(cloud): protect Git credentials",
        body: "Controller-created draft.",
      });

      assert.deepEqual(pullRequest, {
        number: 42,
        url: "https://github.com/Atheal9k/cloud-agents/pull/42",
      });
      assert.deepEqual(githubInput?.args, [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "POST",
        "repos/Atheal9k/cloud-agents/pulls",
        "--input",
        "-",
      ]);
      assert.equal(githubInput?.env?.GH_TOKEN, "ghp_test");
      assert.equal(githubInput?.env?.GITHUB_TOKEN, "ghp_test");
      assert.match(githubInput?.env?.GH_CONFIG_DIR ?? "", /allocation-three-/);
      assert.deepEqual(JSON.parse(githubInput?.stdin ?? "{}"), {
        title: "feat(cloud): protect Git credentials",
        body: "Controller-created draft.",
        head: "feat/ca-06",
        base: "main",
        draft: true,
      });
      assert.deepEqual(yield* fs.readDirectory(path.join(root, "credentials")), []);
    }),
  );

  it.effect("returns useful credential errors without logging secret values", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-git-errors-" });
      const sensitiveValue = "DO-NOT-LOG-THIS-CREDENTIAL";
      const runner = ProcessRunner.ProcessRunner.of({
        run: () =>
          Effect.succeed(
            processOutput({
              code: 255,
              stderr: `AccessDeniedException: ${sensitiveValue}`,
            }),
          ),
      });
      const credentials = yield* make({
        credentialRoot: path.join(root, "credentials"),
        sshSecretRef: "cloud-agent-victor-key",
        githubTokenSecretRef: undefined,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));

      const failure = yield* credentials
        .clone({
          runId: "allocation-four",
          repository: "Atheal9k/cloud-agents",
          destination: path.join(root, "workspace"),
        })
        .pipe(Effect.flip);

      assert.equal(failure.reason, "permission-denied");
      assert.notInclude(JSON.stringify(failure), sensitiveValue);
      assert.notInclude(failure.message, "cloud-agent-victor-key");
    }),
  );

  it.effect("distinguishes expired and revoked credential lookups", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-git-errors-" });
      const failures = [
        { stderr: "ExpiredToken: request token expired", reason: "credential-expired" },
        { stderr: "ResourceNotFoundException: secret missing", reason: "credential-revoked" },
      ] as const;

      for (const [index, expected] of failures.entries()) {
        const runner = ProcessRunner.ProcessRunner.of({
          run: () => Effect.succeed(processOutput({ code: 255, stderr: expected.stderr })),
        });
        const credentials = yield* make({
          credentialRoot: path.join(root, `credentials-${index}`),
          sshSecretRef: "cloud-agent-victor-key",
          githubTokenSecretRef: undefined,
        }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));

        const failure = yield* credentials
          .clone({
            runId: `allocation-error-${index}`,
            repository: "Atheal9k/cloud-agents",
            destination: path.join(root, `workspace-${index}`),
          })
          .pipe(Effect.flip);

        assert.equal(failure.reason, expected.reason);
      }
    }),
  );

  it.effect("reads each rotated key into a separate run directory and removes both", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-git-rotation-" });
      const credentialRoot = path.join(root, "credentials");
      const secrets = [privateKey, rotatedPrivateKey];
      const validatedKeys: string[] = [];
      const keyPaths: string[] = [];
      let secretRead = 0;
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            if (input.command === "aws") {
              return processOutput({ stdout: secrets[secretRead++] });
            }
            if (input.command === "ssh-keygen") {
              const keyPath = input.args[4]!;
              keyPaths.push(keyPath);
              validatedKeys.push(yield* fs.readFileString(keyPath));
            }
            return processOutput();
          }),
      });
      const credentials = yield* make({
        credentialRoot,
        sshSecretRef: "cloud-agent-victor-key",
        githubTokenSecretRef: undefined,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));

      yield* credentials.clone({
        runId: "allocation-before-rotation",
        repository: "Atheal9k/cloud-agents",
        destination: path.join(root, "workspace-one"),
      });
      yield* credentials.clone({
        runId: "allocation-after-rotation",
        repository: "Atheal9k/cloud-agents",
        destination: path.join(root, "workspace-two"),
      });

      assert.deepEqual(validatedKeys, secrets);
      assert.notEqual(path.dirname(keyPaths[0]!), path.dirname(keyPaths[1]!));
      assert.deepEqual(yield* fs.readDirectory(credentialRoot), []);
    }),
  );
});
