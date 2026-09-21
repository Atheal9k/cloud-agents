import * as NodeBuffer from "node:buffer";

import type { RunAllocation } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { GITHUB_SSH_KNOWN_HOST, decodePrivateKeySecret } from "./CloudGitCredentials.ts";
import { CloudRuntimeProvider } from "./CloudRuntimeProvider.ts";

export const DAYTONA_CREDENTIAL_ROOT = "/run/t3-cloud-credentials";
export const DAYTONA_CODEX_HOME = `${DAYTONA_CREDENTIAL_ROOT}/codex`;
export const DAYTONA_CLAUDE_HOME = `${DAYTONA_CREDENTIAL_ROOT}/claude`;
export const DAYTONA_GIT_SSH_WRAPPER = `${DAYTONA_CREDENTIAL_ROOT}/git/github-ssh`;
export const DAYTONA_RUNTIME_ENV = `${DAYTONA_CREDENTIAL_ROOT}/runtime.env`;

const MAX_SECRET_BYTES = 256 * 1024;
const Repository = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/));
const decodeRepository = Schema.decodeUnknownEffect(Repository);
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

const ErrorReason = Schema.Literals([
  "not-configured",
  "permission-denied",
  "credential-expired",
  "credential-revoked",
  "secret-unavailable",
  "invalid-secret",
  "sandbox-failed",
]);

export class DaytonaSandboxCredentialError extends Schema.TaggedError<DaytonaSandboxCredentialError>()(
  "DaytonaSandboxCredentialError",
  {
    reason: ErrorReason,
    message: Schema.String,
  },
) {}

export interface DaytonaSandboxCredentialRefs {
  readonly gitSsh: string | undefined;
  readonly codexAuthJson: string | undefined;
  readonly claudeOAuthToken: string | undefined;
}

export class DaytonaSandboxCredentials extends Context.Service<
  DaytonaSandboxCredentials,
  {
    readonly provision: (input: {
      readonly runtimeId: string;
      readonly allocation: RunAllocation;
    }) => Effect.Effect<void, DaytonaSandboxCredentialError>;
    readonly release: (input: {
      readonly runtimeId: string;
      readonly allocation: RunAllocation;
    }) => Effect.Effect<void, DaytonaSandboxCredentialError>;
  }
>()("t3/cloud/DaytonaSandboxCredentials") {}

function failure(reason: typeof ErrorReason.Type, message: string): DaytonaSandboxCredentialError {
  return new DaytonaSandboxCredentialError({ reason, message });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function encoded(value: string): string {
  return NodeBuffer.Buffer.from(value).toString("base64");
}

function providerFor(allocation: RunAllocation): "codex" | "claude" {
  const instanceId = allocation.execution?.turn.modelSelection.instanceId ?? "";
  return instanceId.toLowerCase().includes("claude") ? "claude" : "codex";
}

function markerFor(allocation: RunAllocation): string {
  return [
    allocation.id,
    allocation.attempt,
    allocation.target.repository,
    providerFor(allocation),
    allocation.deadlines.expiresAt,
  ].join(":");
}

function gitCommandPatterns(repository: string): ReadonlyArray<string> {
  return ["git-upload-pack", "git-receive-pack"].flatMap((operation) => [
    `${operation} '${repository}.git'`,
    `${operation} '/${repository}.git'`,
    `${operation} ${repository}.git`,
    `${operation} /${repository}.git`,
  ]);
}

export function githubSshWrapper(input: {
  readonly repository: string;
  readonly expiresAtEpochSeconds: number;
}): string {
  const approvedCommands = gitCommandPatterns(input.repository)
    .map((command) => `  ${shellQuote(command)}) ;;`)
    .join("\n");
  const gitRoot = `${DAYTONA_CREDENTIAL_ROOT}/git`;
  return [
    "#!/bin/sh",
    "set -eu",
    `test "$(date +%s)" -lt ${input.expiresAtEpochSeconds} || { echo 'T3 Git credential expired' >&2; exit 78; }`,
    "remote_command=",
    "for argument do remote_command=$argument; done",
    'case "$remote_command" in',
    approvedCommands,
    "  *) echo 'T3 Git credential rejected this repository or operation' >&2; exit 77 ;;",
    "esac",
    "exec ssh -F /dev/null \\",
    "  -o BatchMode=yes \\",
    "  -o Hostname=ssh.github.com \\",
    "  -o Port=443 \\",
    "  -o IdentitiesOnly=yes \\",
    `  -o IdentityAgent=${shellQuote(`${gitRoot}/agent.sock`)} \\`,
    `  -o IdentityFile=${shellQuote(`${gitRoot}/identity.pub`)} \\`,
    "  -o StrictHostKeyChecking=yes \\",
    "  -o HostKeyAlgorithms=ssh-ed25519 \\",
    "  -o GlobalKnownHostsFile=/dev/null \\",
    `  -o UserKnownHostsFile=${shellQuote(`${gitRoot}/known_hosts`)} \\`,
    '  "$@"',
    "",
  ].join("\n");
}

function decodeCodexAuthJson(raw: string): string | null {
  if (raw.includes("\0") || NodeBuffer.Buffer.byteLength(raw) > MAX_SECRET_BYTES) return null;
  const trimmed = raw.trim();
  const result = decodeJson(trimmed);
  return Result.isSuccess(result) && Predicate.isObject(result.success) ? `${trimmed}\n` : null;
}

function decodeClaudeOAuthToken(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 && !/[\s'\0]/.test(trimmed) ? trimmed : null;
}

function cleanupCommand(): string {
  const pidPath = `${DAYTONA_CREDENTIAL_ROOT}/git/agent.pid`;
  return [
    "set -eu",
    `if test -r ${shellQuote(pidPath)}; then agent_pid=$(cat ${shellQuote(pidPath)}); case "$agent_pid" in ''|*[!0-9]*) ;; *) kill "$agent_pid" 2>/dev/null || true ;; esac; fi`,
    `rm -rf -- ${shellQuote(DAYTONA_CREDENTIAL_ROOT)}`,
  ].join(" && ");
}

function provisionCommand(input: {
  readonly allocation: RunAllocation;
  readonly provider: "codex" | "claude";
  readonly repository: string;
}): string {
  const gitRoot = `${DAYTONA_CREDENTIAL_ROOT}/git`;
  const marker = markerFor(input.allocation);
  const expiresAtEpochSeconds = Math.floor(
    Date.parse(input.allocation.deadlines.expiresAt) / 1_000,
  );
  return [
    cleanupCommand(),
    `install -d -o root -g root -m 0700 ${shellQuote(DAYTONA_CREDENTIAL_ROOT)}`,
    `install -d -o cloudagent -g cloudagent -m 0700 ${shellQuote(DAYTONA_CODEX_HOME)} ${shellQuote(DAYTONA_CLAUDE_HOME)} ${shellQuote(gitRoot)}`,
    `printf %s "$T3CODE_GITHUB_KNOWN_HOST" | base64 -d > ${shellQuote(`${gitRoot}/known_hosts`)}`,
    `printf %s "$T3CODE_GIT_SSH_WRAPPER" | base64 -d > ${shellQuote(DAYTONA_GIT_SSH_WRAPPER)}`,
    `printf %s "$T3CODE_RUNTIME_ENV" | base64 -d > ${shellQuote(DAYTONA_RUNTIME_ENV)}`,
    ...(input.provider === "codex"
      ? [
          `printf %s "$T3CODE_CODEX_AUTH_JSON" | base64 -d > ${shellQuote(`${DAYTONA_CODEX_HOME}/auth.json`)}`,
          `printf '%s\n' 'cli_auth_credentials_store = "file"' > ${shellQuote(`${DAYTONA_CODEX_HOME}/config.toml`)}`,
          `chown cloudagent:cloudagent ${shellQuote(`${DAYTONA_CODEX_HOME}/auth.json`)} ${shellQuote(`${DAYTONA_CODEX_HOME}/config.toml`)}`,
          `chmod 0600 ${shellQuote(`${DAYTONA_CODEX_HOME}/auth.json`)} ${shellQuote(`${DAYTONA_CODEX_HOME}/config.toml`)}`,
        ]
      : []),
    `chown root:cloudagent ${shellQuote(DAYTONA_RUNTIME_ENV)}`,
    `chmod 0640 ${shellQuote(DAYTONA_RUNTIME_ENV)}`,
    `chmod 0444 ${shellQuote(`${gitRoot}/known_hosts`)}`,
    `chmod 0755 ${shellQuote(DAYTONA_GIT_SSH_WRAPPER)}`,
    `runuser -u cloudagent -- ssh-agent -a ${shellQuote(`${gitRoot}/agent.sock`)} -s > ${shellQuote(`${gitRoot}/agent.env`)}`,
    `agent_pid=$(sed -n 's/^SSH_AGENT_PID=\\([0-9][0-9]*\\);.*/\\1/p' ${shellQuote(`${gitRoot}/agent.env`)})`,
    `test -n "$agent_pid" && printf '%s\n' "$agent_pid" > ${shellQuote(`${gitRoot}/agent.pid`)}`,
    `printf %s "$T3CODE_GIT_PRIVATE_KEY" | base64 -d | runuser -u cloudagent -- env SSH_AUTH_SOCK=${shellQuote(`${gitRoot}/agent.sock`)} ssh-add - >/dev/null`,
    `runuser -u cloudagent -- env SSH_AUTH_SOCK=${shellQuote(`${gitRoot}/agent.sock`)} ssh-add -L > ${shellQuote(`${gitRoot}/identity.pub`)}`,
    `chmod 0444 ${shellQuote(`${gitRoot}/identity.pub`)}`,
    `printf %s ${shellQuote(marker)} > ${shellQuote(`${DAYTONA_CREDENTIAL_ROOT}/assignment`)}`,
    `chmod 0444 ${shellQuote(`${DAYTONA_CREDENTIAL_ROOT}/assignment`)}`,
    `test "$(date +%s)" -lt ${expiresAtEpochSeconds}`,
  ].join(" && ");
}

function classifySecretFailure(stderr: string): DaytonaSandboxCredentialError {
  const normalized = stderr.toLowerCase();
  if (normalized.includes("accessdenied") || normalized.includes("not authorized")) {
    return failure(
      "permission-denied",
      "The controller cannot read a Daytona credential secret. Check its AWS identity policy and the secret resource policy.",
    );
  }
  if (normalized.includes("expiredtoken") || normalized.includes("requestexpired")) {
    return failure(
      "credential-expired",
      "The controller's AWS credentials expired while reading a Daytona credential secret.",
    );
  }
  if (normalized.includes("resourcenotfound") || normalized.includes("scheduled for deletion")) {
    return failure(
      "credential-revoked",
      "A configured Daytona credential secret no longer exists or is scheduled for deletion.",
    );
  }
  return failure(
    "secret-unavailable",
    "The controller could not read a Daytona credential secret from AWS Secrets Manager.",
  );
}

export const make = Effect.fn("DaytonaSandboxCredentials.make")(function* (input: {
  readonly references: DaytonaSandboxCredentialRefs;
  readonly readSecret: (reference: string) => Effect.Effect<string, DaytonaSandboxCredentialError>;
  readonly writeSecret: (input: {
    readonly reference: string;
    readonly value: string;
  }) => Effect.Effect<void, DaytonaSandboxCredentialError>;
}) {
  const runtimes = yield* CloudRuntimeProvider;

  const requiredSecret = Effect.fn("DaytonaSandboxCredentials.requiredSecret")(function* (
    reference: string | undefined,
    purpose: string,
  ) {
    if (reference === undefined) {
      return yield* failure(
        "not-configured",
        `The controller has no ${purpose} secret reference configured for Daytona.`,
      );
    }
    return yield* input.readSecret(reference);
  });

  const provision: DaytonaSandboxCredentials["Service"]["provision"] = Effect.fn(
    "DaytonaSandboxCredentials.provision",
  )(function* ({ runtimeId, allocation }) {
    const repository = yield* decodeRepository(allocation.target.repository).pipe(
      Effect.mapError(() =>
        failure("invalid-secret", "The assigned GitHub repository is invalid."),
      ),
    );
    const expiresAtEpochSeconds = Math.floor(Date.parse(allocation.deadlines.expiresAt) / 1_000);
    const nowEpochSeconds = DateTime.toEpochMillis(yield* DateTime.now) / 1_000;
    if (!Number.isFinite(expiresAtEpochSeconds) || expiresAtEpochSeconds <= nowEpochSeconds) {
      return yield* failure(
        "credential-expired",
        "The Daytona allocation expired before credentials could be provisioned.",
      );
    }

    const provider = providerFor(allocation);
    const marker = markerFor(allocation);
    const existing = yield* runtimes
      .execute({
        runtimeId,
        command: [
          `test -r ${shellQuote(`${DAYTONA_CREDENTIAL_ROOT}/assignment`)}`,
          `test "$(cat ${shellQuote(`${DAYTONA_CREDENTIAL_ROOT}/assignment`)})" = ${shellQuote(marker)}`,
          `test -S ${shellQuote(`${DAYTONA_CREDENTIAL_ROOT}/git/agent.sock`)}`,
          `test -x ${shellQuote(DAYTONA_GIT_SSH_WRAPPER)}`,
          `test -r ${shellQuote(DAYTONA_RUNTIME_ENV)}`,
          `runuser -u cloudagent -- env SSH_AUTH_SOCK=${shellQuote(`${DAYTONA_CREDENTIAL_ROOT}/git/agent.sock`)} ssh-add -l >/dev/null`,
          provider === "codex"
            ? `test -r ${shellQuote(`${DAYTONA_CODEX_HOME}/auth.json`)}`
            : `grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' ${shellQuote(DAYTONA_RUNTIME_ENV)}`,
          `test "$(date +%s)" -lt ${expiresAtEpochSeconds}`,
        ].join(" && "),
        timeoutSeconds: 10,
      })
      .pipe(Effect.mapError((error) => failure("sandbox-failed", error.message)));
    if (existing.exitCode === 0) return;

    const [rawGitKey, rawProviderCredential] = yield* Effect.all([
      requiredSecret(input.references.gitSsh, "Git SSH"),
      provider === "codex"
        ? requiredSecret(input.references.codexAuthJson, "Codex auth.json")
        : requiredSecret(input.references.claudeOAuthToken, "Claude setup-token"),
    ]);
    const privateKey = decodePrivateKeySecret(rawGitKey);
    if (privateKey === null) {
      return yield* failure(
        "invalid-secret",
        "The Daytona Git SSH secret must contain an unencrypted private key.",
      );
    }
    const codexAuthJson = provider === "codex" ? decodeCodexAuthJson(rawProviderCredential) : null;
    const claudeOAuthToken =
      provider === "claude" ? decodeClaudeOAuthToken(rawProviderCredential) : null;
    if (provider === "codex" && codexAuthJson === null) {
      return yield* failure(
        "invalid-secret",
        "The Daytona Codex secret must contain a complete auth.json object.",
      );
    }
    if (provider === "claude" && claudeOAuthToken === null) {
      return yield* failure(
        "invalid-secret",
        "The Daytona Claude secret must contain the raw setup-token without whitespace.",
      );
    }

    const provisioned = yield* runtimes
      .execute({
        runtimeId,
        command: provisionCommand({ allocation, provider, repository }),
        environment: {
          T3CODE_GITHUB_KNOWN_HOST: encoded(GITHUB_SSH_KNOWN_HOST),
          T3CODE_GIT_SSH_WRAPPER: encoded(githubSshWrapper({ repository, expiresAtEpochSeconds })),
          T3CODE_RUNTIME_ENV: encoded(
            [
              `CODEX_HOME=${shellQuote(DAYTONA_CODEX_HOME)}`,
              `CLAUDE_CONFIG_DIR=${shellQuote(DAYTONA_CLAUDE_HOME)}`,
              `GIT_SSH=${shellQuote(DAYTONA_GIT_SSH_WRAPPER)}`,
              "GIT_TERMINAL_PROMPT=0",
              "GCM_INTERACTIVE=never",
              ...(provider === "claude"
                ? [`CLAUDE_CODE_OAUTH_TOKEN=${shellQuote(claudeOAuthToken ?? "")}`]
                : []),
              "",
            ].join("\n"),
          ),
          T3CODE_GIT_PRIVATE_KEY: encoded(privateKey),
          ...(codexAuthJson === null ? {} : { T3CODE_CODEX_AUTH_JSON: encoded(codexAuthJson) }),
        },
        timeoutSeconds: 30,
      })
      .pipe(Effect.mapError((error) => failure("sandbox-failed", error.message)));
    if (provisioned.exitCode !== 0) {
      return yield* failure(
        "sandbox-failed",
        "The Daytona sandbox could not install its attempt-bound credentials.",
      );
    }
  });

  const release: DaytonaSandboxCredentials["Service"]["release"] = Effect.fn(
    "DaytonaSandboxCredentials.release",
  )(function* ({ runtimeId, allocation }) {
    const provider = providerFor(allocation);
    let writeBackError: DaytonaSandboxCredentialError | undefined;
    if (provider === "codex" && input.references.codexAuthJson !== undefined) {
      const readBack = yield* runtimes
        .execute({
          runtimeId,
          command: `test -r ${shellQuote(`${DAYTONA_CODEX_HOME}/auth.json`)} && base64 -w0 ${shellQuote(`${DAYTONA_CODEX_HOME}/auth.json`)}`,
          timeoutSeconds: 10,
        })
        .pipe(Effect.result);
      if (Result.isSuccess(readBack) && readBack.success.exitCode === 0) {
        const decoded = NodeBuffer.Buffer.from(readBack.success.output.trim(), "base64").toString();
        const authJson = decodeCodexAuthJson(decoded);
        if (authJson !== null) {
          const current = yield* input
            .readSecret(input.references.codexAuthJson)
            .pipe(Effect.result);
          if (Result.isFailure(current)) {
            writeBackError = current.failure;
          } else if (decodeCodexAuthJson(current.success) !== authJson) {
            const written = yield* input
              .writeSecret({ reference: input.references.codexAuthJson, value: authJson })
              .pipe(Effect.result);
            if (Result.isFailure(written)) writeBackError = written.failure;
          }
        }
      }
    }

    const cleaned = yield* runtimes
      .execute({ runtimeId, command: cleanupCommand(), timeoutSeconds: 10 })
      .pipe(Effect.mapError((error) => failure("sandbox-failed", error.message)));
    if (cleaned.exitCode !== 0) {
      return yield* failure(
        "sandbox-failed",
        "The Daytona sandbox could not remove its transient credentials.",
      );
    }
    if (writeBackError !== undefined) return yield* writeBackError;
  });

  return DaytonaSandboxCredentials.of({ provision, release });
});

const optionalReference = (name: string) =>
  Config.string(name).pipe(
    Config.map((value) => value.trim()),
    Config.option,
    Config.map(Option.filter((value) => value.length > 0)),
    Config.map(Option.getOrUndefined),
  );

export const layer = Layer.effect(
  DaytonaSandboxCredentials,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const [gitSsh, codexAuthJson, claudeOAuthToken] = yield* Effect.all([
      optionalReference("T3CODE_CLOUD_GIT_SSH_SECRET_REF"),
      optionalReference("T3CODE_CLOUD_CODEX_AUTH_JSON_SECRET_REF"),
      optionalReference("T3CODE_CLOUD_CLAUDE_OAUTH_TOKEN_SECRET_REF"),
    ]);
    const readSecret = Effect.fn("DaytonaSandboxCredentials.readSecret")(function* (
      reference: string,
    ) {
      const result = yield* runner
        .run({
          command: "aws",
          args: [
            "secretsmanager",
            "get-secret-value",
            "--secret-id",
            reference,
            "--query",
            "SecretString",
            "--output",
            "text",
            "--no-cli-pager",
          ],
          timeout: "30 seconds",
          maxOutputBytes: MAX_SECRET_BYTES,
        })
        .pipe(
          Effect.mapError(() =>
            failure(
              "secret-unavailable",
              "The controller could not run AWS Secrets Manager credential lookup.",
            ),
          ),
        );
      if (result.code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* classifySecretFailure(result.stderr);
      }
      return result.stdout;
    });
    const writeSecret = Effect.fn("DaytonaSandboxCredentials.writeSecret")(function* (input: {
      readonly reference: string;
      readonly value: string;
    }) {
      const result = yield* runner
        .run({
          command: "aws",
          args: [
            "secretsmanager",
            "put-secret-value",
            "--secret-id",
            input.reference,
            "--secret-string",
            "file:///dev/stdin",
            "--no-cli-pager",
          ],
          stdin: input.value,
          timeout: "30 seconds",
          maxOutputBytes: 64 * 1024,
        })
        .pipe(
          Effect.mapError(() =>
            failure(
              "secret-unavailable",
              "The controller could not run AWS Secrets Manager credential writeback.",
            ),
          ),
        );
      if (result.code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* classifySecretFailure(result.stderr);
      }
    });
    return yield* make({
      references: { gitSsh, codexAuthJson, claudeOAuthToken },
      readSecret,
      writeSecret,
    });
  }),
);
