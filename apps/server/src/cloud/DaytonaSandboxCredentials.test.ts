import * as NodeBuffer from "node:buffer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  RunAllocation,
  RunAllocationAttempt,
  emptyCloudSessionLeases,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { CloudRuntimeProvider } from "./CloudRuntimeProvider.ts";
import {
  DAYTONA_CREDENTIAL_ROOT,
  make,
  githubSshWrapper,
  type DaytonaSandboxCredentialRefs,
} from "./DaytonaSandboxCredentials.ts";

const allocation = Schema.decodeSync(RunAllocation)({
  id: "allocation-credentials",
  attempt: 1,
  target: {
    repository: "acme/private",
    baseCommit: "main",
    branch: "cloud/credentials",
  },
  publication: { mode: "review-only" },
  execution: {
    threadId: "thread-credentials",
    title: "Credential proof",
    selectedRef: "main",
    unansweredRequestSeconds: 900,
    turn: {
      commandId: "command-credentials",
      messageId: "message-credentials",
      prompt: "Prove credentials",
      attachments: [],
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2099-09-21T03:00:00.000Z",
    },
  },
  profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "small" },
  deadlines: {
    launchBy: "2099-09-21T03:05:00.000Z",
    bootBy: "2099-09-21T03:10:00.000Z",
    registerBy: "2099-09-21T03:15:00.000Z",
    expiresAt: "2099-09-21T05:00:00.000Z",
    cleanupBy: "2099-09-21T05:05:00.000Z",
  },
  allocationState: {
    status: "booting",
    instanceId: "sandbox-credentials",
    managedRuntime: {
      provider: "daytona",
      runtimeId: "sandbox-credentials",
      region: "us",
      resourceClass: "small",
      lifecycleState: "started",
      agentId: "agent-credentials",
      runId: "run-credentials",
      allocationId: "allocation-credentials",
      attempt: 1,
      observedAt: "2099-09-21T03:01:00.000Z",
    },
    launchedAt: "2099-09-21T03:01:00.000Z",
  },
  agentOutcome: { status: "not-started" },
  previewState: { status: "unavailable" },
  leases: emptyCloudSessionLeases(),
  idleState: { status: "busy" },
  attemptPurpose: "run",
  cleanupState: { status: "not-requested" },
  handledCommandIds: [],
  sequence: 4,
  createdAt: "2099-09-21T03:00:00.000Z",
  updatedAt: "2099-09-21T03:01:00.000Z",
});

const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "dGVzdC1wcml2YXRlLWtleQ==",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

const references: DaytonaSandboxCredentialRefs = {
  gitSsh: "secret/git",
  codexAuthJson: "secret/codex",
  claudeOAuthToken: "secret/claude",
};

function runtimeWithExecute(
  execute: CloudRuntimeProvider["Service"]["execute"],
): CloudRuntimeProvider["Service"] {
  return CloudRuntimeProvider.of({
    readiness: () => Effect.die("unused"),
    create: () => Effect.die("unused"),
    inspect: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    start: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    archive: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    execute,
    ensureProcess: () => Effect.die("unused"),
    inspectProcess: () => Effect.die("unused"),
    deleteProcess: () => Effect.die("unused"),
    preview: () => Effect.die("unused"),
    snapshot: () => Effect.die("unused"),
    desktop: () => Effect.die("unused"),
    resourceClass: "small",
  });
}

it.effect("injects an attempt-bound Codex home and repository-scoped SSH agent", () =>
  Effect.gen(function* () {
    const executions: Parameters<CloudRuntimeProvider["Service"]["execute"]>[0][] = [];
    const reads: string[] = [];
    const runtime = runtimeWithExecute((input) =>
      Effect.sync(() => {
        executions.push(input);
        return { exitCode: executions.length === 1 ? 1 : 0, output: "" };
      }),
    );
    const credentials = yield* make({
      references,
      readSecret: (reference) =>
        Effect.sync(() => {
          reads.push(reference);
          return reference === "secret/git" ? PRIVATE_KEY : '{"auth_mode":"chatgpt"}\n';
        }),
      writeSecret: () => Effect.die("unused"),
    }).pipe(Effect.provideService(CloudRuntimeProvider, runtime));

    yield* credentials.provision({ runtimeId: "sandbox-credentials", allocation });

    expect(reads).toEqual(["secret/git", "secret/codex"]);
    expect(executions).toHaveLength(2);
    expect(executions[0]?.command).toContain("ssh-add -l");
    expect(executions[0]?.command).toContain("codex/auth.json");
    const provision = executions[1];
    assert(provision?.environment !== undefined);
    expect(provision.command).not.toContain(PRIVATE_KEY);
    expect(provision.command).not.toContain("chatgpt");
    const wrapper = NodeBuffer.Buffer.from(
      provision.environment.T3CODE_GIT_SSH_WRAPPER ?? "",
      "base64",
    ).toString();
    expect(wrapper).toContain("StrictHostKeyChecking=yes");
    expect(wrapper).toContain("HostKeyAlgorithms=ssh-ed25519");
    expect(wrapper).toContain("UserKnownHostsFile='/run/t3-cloud-credentials/git/known_hosts'");
    expect(wrapper).toContain("git-upload-pack '\"'\"'acme/private.git'\"'\"'");
    expect(wrapper).toContain("git-receive-pack '\"'\"'acme/private.git'\"'\"'");
    expect(wrapper).not.toContain("acme/other.git");
    const knownHost = NodeBuffer.Buffer.from(
      provision.environment.T3CODE_GITHUB_KNOWN_HOST ?? "",
      "base64",
    ).toString();
    expect(knownHost).toBe(
      "[ssh.github.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
    );
  }),
);

it.effect("injects only the selected Claude setup-token and never writes it back", () =>
  Effect.gen(function* () {
    if (allocation.execution === undefined) return;
    const claudeAllocation: typeof allocation = {
      ...allocation,
      execution: {
        ...allocation.execution,
        turn: {
          ...allocation.execution.turn,
          modelSelection: {
            ...allocation.execution.turn.modelSelection,
            instanceId: ProviderInstanceId.make("claudeAgent"),
          },
        },
      },
    };
    const executions: Parameters<CloudRuntimeProvider["Service"]["execute"]>[0][] = [];
    const reads: string[] = [];
    let writeCount = 0;
    const runtime = runtimeWithExecute((input) =>
      Effect.sync(() => {
        executions.push(input);
        return { exitCode: executions.length === 1 ? 1 : 0, output: "" };
      }),
    );
    const credentials = yield* make({
      references,
      readSecret: (reference) =>
        Effect.sync(() => {
          reads.push(reference);
          return reference === "secret/git" ? PRIVATE_KEY : "claude-setup-token";
        }),
      writeSecret: () => Effect.sync(() => void (writeCount += 1)),
    }).pipe(Effect.provideService(CloudRuntimeProvider, runtime));

    yield* credentials.provision({
      runtimeId: "sandbox-credentials",
      allocation: claudeAllocation,
    });
    yield* credentials.release({
      runtimeId: "sandbox-credentials",
      allocation: claudeAllocation,
    });

    expect(reads).toEqual(["secret/git", "secret/claude"]);
    const provision = executions[1];
    assert(provision?.environment !== undefined);
    expect(provision.command).not.toContain("claude-setup-token");
    expect(provision.environment.T3CODE_CODEX_AUTH_JSON).toBeUndefined();
    const runtimeEnvironment = NodeBuffer.Buffer.from(
      provision.environment.T3CODE_RUNTIME_ENV ?? "",
      "base64",
    ).toString();
    expect(runtimeEnvironment).toContain("CLAUDE_CODE_OAUTH_TOKEN='claude-setup-token'");
    expect(writeCount).toBe(0);
  }),
);

it.effect("reprovisions after a restored or reassigned sandbox loses its runtime marker", () =>
  Effect.gen(function* () {
    const executions: Parameters<CloudRuntimeProvider["Service"]["execute"]>[0][] = [];
    const reads: string[] = [];
    const exitCodes = [0, 1, 0];
    const runtime = runtimeWithExecute((input) =>
      Effect.sync(() => {
        executions.push(input);
        return { exitCode: exitCodes.shift() ?? 0, output: "" };
      }),
    );
    const credentials = yield* make({
      references,
      readSecret: (reference) =>
        Effect.sync(() => {
          reads.push(reference);
          return reference === "secret/git" ? PRIVATE_KEY : '{"auth_mode":"chatgpt"}\n';
        }),
      writeSecret: () => Effect.die("unused"),
    }).pipe(Effect.provideService(CloudRuntimeProvider, runtime));

    yield* credentials.provision({ runtimeId: "sandbox-credentials", allocation });
    expect(reads).toEqual([]);

    const reassigned: typeof allocation = {
      ...allocation,
      attempt: RunAllocationAttempt.make(2),
    };
    yield* credentials.provision({ runtimeId: "sandbox-credentials", allocation: reassigned });
    expect(reads).toEqual(["secret/git", "secret/codex"]);
    expect(executions[1]?.command).toContain("allocation-credentials:2:acme/private:codex");
    expect(executions[2]?.command).toContain(`rm -rf -- '${DAYTONA_CREDENTIAL_ROOT}'`);
  }),
);

it.effect("writes refreshed Codex credentials back and removes transient agent material", () =>
  Effect.gen(function* () {
    const refreshed = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rotated"}}\n';
    const executions: Parameters<CloudRuntimeProvider["Service"]["execute"]>[0][] = [];
    const writes: Array<{ readonly reference: string; readonly value: string }> = [];
    const runtime = runtimeWithExecute((input) =>
      Effect.sync(() => {
        executions.push(input);
        return input.command.includes("base64 -w0")
          ? { exitCode: 0, output: NodeBuffer.Buffer.from(refreshed).toString("base64") }
          : { exitCode: 0, output: "" };
      }),
    );
    const credentials = yield* make({
      references,
      readSecret: () => Effect.succeed('{"auth_mode":"chatgpt"}\n'),
      writeSecret: (input) => Effect.sync(() => void writes.push(input)),
    }).pipe(Effect.provideService(CloudRuntimeProvider, runtime));

    yield* credentials.release({ runtimeId: "sandbox-credentials", allocation });

    expect(writes).toEqual([{ reference: "secret/codex", value: refreshed }]);
    expect(executions.at(-1)?.command).toContain("agent.pid");
    expect(executions.at(-1)?.command).toContain(`rm -rf -- '${DAYTONA_CREDENTIAL_ROOT}'`);
  }),
);

it.effect("runs clone, fetch, pull, and push through both GitHub SSH URL forms", () =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const wrapper = githubSshWrapper({
      repository: "acme/private",
      expiresAtEpochSeconds: 4_102_444_800,
    });
    const expiredWrapper = githubSshWrapper({
      repository: "acme/private",
      expiresAtEpochSeconds: 1,
    });
    const proof = yield* runner.run({
      command: "bash",
      args: ["-s"],
      stdin: `set -eu
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/fake-bin" "$root/source"
printf %s '${NodeBuffer.Buffer.from(wrapper).toString("base64")}' | base64 -d >"$root/github-ssh"
printf %s '${NodeBuffer.Buffer.from(expiredWrapper).toString("base64")}' | base64 -d >"$root/github-ssh-expired"
chmod 0700 "$root/github-ssh" "$root/github-ssh-expired"
cat >"$root/fake-bin/ssh" <<'SH'
#!/bin/sh
set -eu
remote_command=
for argument do remote_command=$argument; done
if test "\${FAKE_HOST_MISMATCH:-0}" = 1; then
  echo 'Host key verification failed' >&2
  exit 255
fi
case "$remote_command" in
  "git-upload-pack 'acme/private.git'"|"git-upload-pack '/acme/private.git'") exec git-upload-pack "$FAKE_REMOTE" ;;
  "git-receive-pack 'acme/private.git'"|"git-receive-pack '/acme/private.git'") exec git-receive-pack "$FAKE_REMOTE" ;;
  *) echo "unexpected fake SSH command: $remote_command" >&2; exit 90 ;;
esac
SH
chmod 0700 "$root/fake-bin/ssh"
git -C "$root/source" init --initial-branch=main >/dev/null
git -C "$root/source" config user.name 'Credential Proof'
git -C "$root/source" config user.email 'credential-proof@example.test'
printf 'base\n' >"$root/source/README.md"
git -C "$root/source" add README.md
git -C "$root/source" commit -m base >/dev/null
git init --bare "$root/remote.git" >/dev/null
git -C "$root/source" remote add origin "$root/remote.git"
git -C "$root/source" push origin main >/dev/null
export PATH="$root/fake-bin:$PATH" FAKE_REMOTE="$root/remote.git" GIT_SSH="$root/github-ssh"
git clone git@github.com:acme/private.git "$root/scp" >/dev/null
git -C "$root/scp" fetch origin main >/dev/null
printf 'next\n' >>"$root/source/README.md"
git -C "$root/source" commit -am next >/dev/null
git -C "$root/source" push origin main >/dev/null
git -C "$root/scp" pull --ff-only origin main >/dev/null
git clone ssh://git@github.com/acme/private.git "$root/uri" >/dev/null
git -C "$root/scp" config user.name 'Credential Proof'
git -C "$root/scp" config user.email 'credential-proof@example.test'
printf 'proof\n' >"$root/scp/proof.txt"
git -C "$root/scp" add proof.txt
git -C "$root/scp" commit -m proof >/dev/null
git -C "$root/scp" push origin HEAD:refs/heads/proof >/dev/null
test "$(git --git-dir "$root/remote.git" show refs/heads/proof:proof.txt)" = proof
if git ls-remote git@github.com:acme/other.git >"$root/wrong.out" 2>"$root/wrong.err"; then exit 91; fi
grep -q 'rejected this repository or operation' "$root/wrong.err"
if FAKE_HOST_MISMATCH=1 git ls-remote git@github.com:acme/private.git >"$root/host.out" 2>"$root/host.err"; then exit 92; fi
grep -q 'Host key verification failed' "$root/host.err"
if PATH="$root/fake-bin:$PATH" FAKE_REMOTE="$root/remote.git" "$root/github-ssh-expired" git@github.com "git-upload-pack 'acme/private.git'" >"$root/expired.out" 2>"$root/expired.err"; then exit 93; fi
grep -q 'credential expired' "$root/expired.err"
printf 'clone-fetch-pull-push-ok\n'
`,
      timeout: "30 seconds",
      maxOutputBytes: 1024 * 1024,
    });

    assert.equal(proof.code, ChildProcessSpawner.ExitCode(0), proof.stderr);
    expect(proof.stdout).toContain("clone-fetch-pull-push-ok");
  }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)))),
);
