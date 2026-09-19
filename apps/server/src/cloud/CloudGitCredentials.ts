import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const GITHUB_SSH_KNOWN_HOST =
  "[ssh.github.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";
const DEFAULT_COMMAND_TIMEOUT = "2 minutes";
const MAX_SECRET_BYTES = 64 * 1024;

const Repository = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/));
const Branch = Schema.String.check(
  Schema.makeFilter((branch) => {
    if (branch.length === 0 || branch.length > 255) return false;
    if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".lock")) return false;
    if (branch.includes("..") || branch.includes("@{") || branch.includes("//")) return false;
    for (const character of branch) {
      if (character.charCodeAt(0) <= 0x20 || "~^:?*[\\".includes(character)) return false;
    }
    return true;
  }),
);
const PullRequestResponse = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.URLFromString,
});
const PullRequestListResponse = Schema.Array(PullRequestResponse);
const GitCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/));

export type CloudGitRepository = typeof Repository.Type;
export type CloudGitBranch = typeof Branch.Type;

const ErrorReason = Schema.Literals([
  "not-configured",
  "permission-denied",
  "credential-expired",
  "credential-revoked",
  "secret-unavailable",
  "invalid-secret",
  "filesystem-failed",
  "git-failed",
  "host-key-failed",
  "github-failed",
  "invalid-github-response",
  "push-rejected",
]);

export class CloudGitCredentialError extends Schema.TaggedError<CloudGitCredentialError>()(
  "CloudGitCredentialError",
  {
    reason: ErrorReason,
    message: Schema.String,
  },
) {}

export interface CloudGitPullRequest {
  readonly number: number;
  readonly url: string;
}

export class CloudGitCredentials extends Context.Service<
  CloudGitCredentials,
  {
    readonly clone: (input: {
      readonly runId: string;
      readonly repository: string;
      readonly destination: string;
    }) => Effect.Effect<void, CloudGitCredentialError>;
    readonly fetch: (input: {
      readonly runId: string;
      readonly repository: string;
      readonly ref: string;
      readonly cwd: string;
    }) => Effect.Effect<void, CloudGitCredentialError>;
    /** Resolves a ref to its commit without cloning, so a Build can decide
        whether anything changed before it pays for a checkout. */
    readonly resolveRef: (input: {
      readonly runId: string;
      readonly repository: string;
      readonly ref: string;
    }) => Effect.Effect<string, CloudGitCredentialError>;
    readonly push: (input: {
      readonly runId: string;
      readonly repository: string;
      readonly branch: string;
      readonly cwd: string;
    }) => Effect.Effect<void, CloudGitCredentialError>;
    readonly readBranch: (input: {
      readonly runId: string;
      readonly repository: string;
      readonly branch: string;
    }) => Effect.Effect<string | null, CloudGitCredentialError>;
    readonly findPullRequest: (input: {
      readonly runId: string;
      readonly repository: string;
      readonly base: string;
      readonly head: string;
    }) => Effect.Effect<CloudGitPullRequest | null, CloudGitCredentialError>;
    readonly createDraftPullRequest: (input: {
      readonly runId: string;
      readonly repository: string;
      readonly base: string;
      readonly head: string;
      readonly title: string;
      readonly body: string;
      readonly skipReviewerRequest?: boolean;
    }) => Effect.Effect<CloudGitPullRequest, CloudGitCredentialError>;
    readonly closePullRequest: (input: {
      readonly runId: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<void, CloudGitCredentialError>;
    /** Submodule and LFS fetch use the same SSH wrapper as clone. Task code never sees the key. */
    readonly syncPrivateGitDependencies: (input: {
      readonly runId: string;
      readonly cwd: string;
      readonly kinds: ReadonlyArray<"submodule" | "lfs">;
    }) => Effect.Effect<void, CloudGitCredentialError>;
  }
>()("t3/cloud/CloudGitCredentials") {}

function error(reason: typeof ErrorReason.Type, message: string): CloudGitCredentialError {
  return new CloudGitCredentialError({ reason, message });
}

function classifySecretReadFailure(stderr: string): CloudGitCredentialError {
  const normalized = stderr.toLowerCase();
  if (normalized.includes("accessdenied") || normalized.includes("not authorized")) {
    return error(
      "permission-denied",
      "The controller cannot read the configured credential secret. Check its AWS identity policy and the secret resource policy.",
    );
  }
  if (normalized.includes("expiredtoken") || normalized.includes("requestexpired")) {
    return error(
      "credential-expired",
      "The controller's AWS credentials expired while reading the configured credential secret.",
    );
  }
  if (normalized.includes("resourcenotfound") || normalized.includes("scheduled for deletion")) {
    return error(
      "credential-revoked",
      "The configured credential secret no longer exists or is scheduled for deletion.",
    );
  }
  return error(
    "secret-unavailable",
    "The controller could not read the configured credential secret from AWS Secrets Manager.",
  );
}

function classifyGitFailure(
  stderr: string,
  operation: "clone" | "fetch" | "inspect" | "push" | "submodule" | "lfs",
): CloudGitCredentialError {
  const normalized = stderr.toLowerCase();
  if (normalized.includes("host key verification failed")) {
    return error(
      "host-key-failed",
      "GitHub host-key verification failed. Check GitHub's published SSH keys before changing the controller pin.",
    );
  }
  if (
    normalized.includes("permission denied") ||
    normalized.includes("could not read from remote")
  ) {
    return error(
      "credential-revoked",
      "GitHub rejected the configured SSH credential. The key may be revoked or no longer authorized for this repository.",
    );
  }
  if (
    operation === "push" &&
    (normalized.includes("non-fast-forward") ||
      normalized.includes("fetch first") ||
      normalized.includes("[rejected]"))
  ) {
    return error(
      "push-rejected",
      "GitHub rejected the branch update because the remote branch changed.",
    );
  }
  if (operation === "submodule") {
    const submodulePath = /Submodule path '([^']+)'/.exec(stderr)?.[1];
    return error(
      "git-failed",
      submodulePath === undefined
        ? "The trusted Git submodule update failed."
        : `The trusted Git submodule update failed for '${submodulePath}'.`,
    );
  }
  if (operation === "lfs") {
    return error("git-failed", "The trusted Git LFS fetch failed.");
  }
  return error("git-failed", `The trusted Git ${operation} failed.`);
}

function classifyGitHubFailure(
  stderr: string,
  operation: "inspect" | "create" | "close",
): CloudGitCredentialError {
  const normalized = stderr.toLowerCase();
  if (normalized.includes("401") || normalized.includes("bad credentials")) {
    return error(
      "credential-expired",
      "GitHub rejected the controller API credential. Replace or rotate the configured token.",
    );
  }
  if (
    normalized.includes("403") ||
    normalized.includes("resource not accessible") ||
    normalized.includes("forbidden")
  ) {
    return error(
      "permission-denied",
      operation === "create"
        ? "The controller GitHub credential cannot create a pull request for this repository."
        : operation === "close"
          ? "The controller GitHub credential cannot delete a pull request for this repository."
          : "The controller GitHub credential cannot inspect pull requests for this repository.",
    );
  }
  return error(
    "github-failed",
    operation === "create"
      ? "GitHub did not create the draft pull request."
      : operation === "close"
        ? "GitHub did not close the pull request."
        : "GitHub did not return the repository's pull requests.",
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const decodeSingleFieldJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

function parseSingleFieldSecret(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  const decoded = decodeSingleFieldJson(trimmed);
  if (!Result.isSuccess(decoded)) return null;
  const entries = Object.entries(decoded.success);
  return entries.length === 1 ? (entries[0]?.[1] ?? null) : null;
}

export function decodePrivateKeySecret(raw: string): string | null {
  const secret = parseSingleFieldSecret(raw);
  if (secret === null || secret.includes("\0")) return null;
  const normalized = secret.replaceAll("\r\n", "\n").trim();
  const match = normalized.match(
    /^-----BEGIN (OPENSSH|RSA|EC) PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END \1 PRIVATE KEY-----$/,
  );
  return match === null ? null : `${normalized}\n`;
}

function decodeTokenSecret(raw: string): string | null {
  const secret = parseSingleFieldSecret(raw)?.trim();
  if (secret === undefined || secret === null || secret.length === 0 || /\s/.test(secret))
    return null;
  return secret;
}

const decodeRepository = Schema.decodeUnknownEffect(Repository);
const decodeBranch = Schema.decodeUnknownEffect(Branch);
const decodePullRequestResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PullRequestResponse),
);
const decodePullRequestListResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PullRequestListResponse),
);
const decodeGitCommit = Schema.decodeUnknownEffect(GitCommit);

export const make = Effect.fn("CloudGitCredentials.make")(function* (input: {
  readonly credentialRoot: string;
  readonly sshSecretRef: string | undefined;
  readonly githubTokenSecretRef: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;

  const readSecret = Effect.fn("CloudGitCredentials.readSecret")(function* (
    reference: string | undefined,
    purpose: "SSH" | "GitHub API",
  ) {
    if (reference === undefined || reference.trim().length === 0) {
      return yield* error(
        "not-configured",
        `The controller has no ${purpose} secret reference configured.`,
      );
    }
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
          error(
            "secret-unavailable",
            "The controller could not run AWS Secrets Manager credential lookup.",
          ),
        ),
      );
    if (result.code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* classifySecretReadFailure(result.stderr);
    }
    return result.stdout;
  });

  const withRunDirectory = <A, E>(
    runId: string,
    use: (directory: string) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | CloudGitCredentialError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const filesystemFailed = () =>
          error(
            "filesystem-failed",
            "The controller could not create protected run credential files.",
          );
        yield* fs
          .makeDirectory(input.credentialRoot, { recursive: true })
          .pipe(Effect.mapError(filesystemFailed));
        yield* fs.chmod(input.credentialRoot, 0o700).pipe(Effect.mapError(filesystemFailed));
        const safeRunId = runId.replaceAll(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "run";
        const directory = yield* fs
          .makeTempDirectoryScoped({
            directory: input.credentialRoot,
            prefix: `${safeRunId}-`,
          })
          .pipe(Effect.mapError(filesystemFailed));
        yield* fs.chmod(directory, 0o700).pipe(Effect.mapError(filesystemFailed));
        return yield* use(directory);
      }),
    );

  const withSshCredential = <A, E>(
    runId: string,
    use: (input: {
      readonly directory: string;
      readonly gitEnvironment: NodeJS.ProcessEnv;
    }) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | CloudGitCredentialError> =>
    withRunDirectory(runId, (directory) =>
      Effect.gen(function* () {
        const filesystemFailed = () =>
          error(
            "filesystem-failed",
            "The controller could not write protected run credential files.",
          );
        const raw = yield* readSecret(input.sshSecretRef, "SSH");
        const privateKey = decodePrivateKeySecret(raw);
        if (privateKey === null) {
          return yield* error(
            "invalid-secret",
            "The configured SSH secret must be an unencrypted OpenSSH private key or a single-field JSON object containing one.",
          );
        }

        const keyPath = path.join(directory, "github.key");
        const knownHostsPath = path.join(directory, "known_hosts");
        const wrapperPath = path.join(directory, "github-ssh.sh");
        yield* fs
          .writeFileString(keyPath, privateKey, { mode: 0o600 })
          .pipe(Effect.mapError(filesystemFailed));
        yield* fs
          .writeFileString(knownHostsPath, GITHUB_SSH_KNOWN_HOST, { mode: 0o600 })
          .pipe(Effect.mapError(filesystemFailed));
        yield* fs
          .writeFileString(
            wrapperPath,
            [
              "#!/bin/sh",
              "exec ssh -F /dev/null \\",
              `  -i ${shellQuote(keyPath)} \\`,
              "  -o IdentitiesOnly=yes \\",
              "  -o IdentityAgent=none \\",
              "  -o BatchMode=yes \\",
              "  -o Hostname=ssh.github.com \\",
              "  -o Port=443 \\",
              "  -o StrictHostKeyChecking=yes \\",
              "  -o HostKeyAlgorithms=ssh-ed25519 \\",
              "  -o GlobalKnownHostsFile=/dev/null \\",
              `  -o UserKnownHostsFile=${shellQuote(knownHostsPath)} \\`,
              '  "$@"',
              "",
            ].join("\n"),
            { mode: 0o700 },
          )
          .pipe(Effect.mapError(filesystemFailed));
        yield* Effect.all([
          fs.chmod(keyPath, 0o600).pipe(Effect.mapError(filesystemFailed)),
          fs.chmod(knownHostsPath, 0o600).pipe(Effect.mapError(filesystemFailed)),
          fs.chmod(wrapperPath, 0o700).pipe(Effect.mapError(filesystemFailed)),
        ]);

        const validation = yield* runner
          .run({
            command: "ssh-keygen",
            args: ["-y", "-P", "", "-f", keyPath],
            timeout: "10 seconds",
            maxOutputBytes: 16 * 1024,
          })
          .pipe(
            Effect.mapError(() =>
              error(
                "invalid-secret",
                "The controller could not validate the configured SSH private key.",
              ),
            ),
          );
        if (validation.code !== ChildProcessSpawner.ExitCode(0)) {
          return yield* error(
            "invalid-secret",
            "The configured SSH private key is invalid or requires an interactive passphrase.",
          );
        }

        return yield* use({
          directory,
          gitEnvironment: {
            GIT_SSH: wrapperPath,
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "never",
            SSH_AUTH_SOCK: "",
            SSH_AGENT_PID: "",
          },
        });
      }),
    );

  const runWorkspaceGit = Effect.fn("CloudGitCredentials.runWorkspaceGit")(function* (input: {
    readonly operation: "submodule" | "lfs";
    readonly runId: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly extraEnv?: Readonly<Record<string, string>>;
  }) {
    return yield* withSshCredential(input.runId, ({ gitEnvironment }) =>
      runner
        .run({
          command: "git",
          args: [...input.args],
          cwd: input.cwd,
          env: { ...gitEnvironment, ...input.extraEnv },
          timeout: DEFAULT_COMMAND_TIMEOUT,
          maxOutputBytes: 1024 * 1024,
        })
        .pipe(
          Effect.mapError(() =>
            error(
              "git-failed",
              `The controller could not start the trusted Git ${input.operation}.`,
            ),
          ),
          Effect.flatMap((result) =>
            result.code === ChildProcessSpawner.ExitCode(0)
              ? Effect.succeed(result)
              : Effect.fail(classifyGitFailure(result.stderr, input.operation)),
          ),
        ),
    );
  });

  const runGit = Effect.fn("CloudGitCredentials.runGit")(function* (input: {
    readonly operation: "clone" | "fetch" | "inspect" | "push";
    readonly runId: string;
    readonly repository: string;
    readonly cwd?: string;
    readonly args: ReadonlyArray<string>;
    readonly trailingArgs: ReadonlyArray<string>;
  }) {
    const repository = yield* decodeRepository(input.repository).pipe(
      Effect.mapError(() => error("git-failed", "The configured GitHub repository is invalid.")),
    );
    return yield* withSshCredential(input.runId, ({ gitEnvironment }) =>
      runner
        .run({
          command: "git",
          args: [
            ...input.args,
            `ssh://git@ssh.github.com:443/${repository}.git`,
            ...input.trailingArgs,
          ],
          ...(input.operation !== "clone" && input.cwd !== undefined ? { cwd: input.cwd } : {}),
          env: gitEnvironment,
          timeout: DEFAULT_COMMAND_TIMEOUT,
          maxOutputBytes: 1024 * 1024,
        })
        .pipe(
          Effect.mapError(() =>
            error(
              "git-failed",
              `The controller could not start the trusted Git ${input.operation}.`,
            ),
          ),
          Effect.flatMap((result) =>
            result.code === ChildProcessSpawner.ExitCode(0)
              ? Effect.succeed(result)
              : Effect.fail(classifyGitFailure(result.stderr, input.operation)),
          ),
        ),
    );
  });

  const clone: CloudGitCredentials["Service"]["clone"] = (request) =>
    runGit({
      operation: "clone",
      runId: request.runId,
      repository: request.repository,
      cwd: request.destination,
      args: ["clone", "--no-checkout", "--no-tags", "--origin", "origin", "--"],
      trailingArgs: [request.destination],
    }).pipe(Effect.asVoid);

  const fetch: CloudGitCredentials["Service"]["fetch"] = (request) =>
    runGit({
      operation: "fetch",
      runId: request.runId,
      repository: request.repository,
      cwd: request.cwd,
      args: ["fetch", "--no-tags", "--force", "--"],
      trailingArgs: [request.ref],
    }).pipe(Effect.asVoid);

  const resolveRef: CloudGitCredentials["Service"]["resolveRef"] = (request) =>
    runGit({
      operation: "inspect",
      runId: request.runId,
      repository: request.repository,
      args: ["ls-remote", "--"],
      trailingArgs: [request.ref],
    }).pipe(
      Effect.flatMap((result) => {
        const commit = result.stdout.trim().split(/\s+/)[0];
        return commit !== undefined && /^[0-9a-f]{40,64}$/.test(commit)
          ? Effect.succeed(commit)
          : Effect.fail(
              error("git-failed", `The ref '${request.ref}' did not resolve to a commit.`),
            );
      }),
    );

  const push: CloudGitCredentials["Service"]["push"] = (request) =>
    decodeBranch(request.branch).pipe(
      Effect.mapError(() => error("git-failed", "The requested publication branch is invalid.")),
      Effect.flatMap((branch) =>
        withRunDirectory(request.runId, (directory) =>
          Effect.gen(function* () {
            const publicationRepository = path.join(directory, "publication.git");
            const copy = yield* runner
              .run({
                command: "git",
                args: ["clone", "--bare", "--no-local", "--", request.cwd, publicationRepository],
                timeout: DEFAULT_COMMAND_TIMEOUT,
                maxOutputBytes: 1024 * 1024,
              })
              .pipe(
                Effect.mapError(() =>
                  error("git-failed", "The controller could not copy the branch for publication."),
                ),
              );
            if (copy.code !== ChildProcessSpawner.ExitCode(0)) {
              return yield* error(
                "git-failed",
                "The controller could not copy the branch for publication.",
              );
            }
            return yield* runGit({
              operation: "push",
              runId: request.runId,
              repository: request.repository,
              cwd: publicationRepository,
              args: ["push", "--no-verify", "--"],
              trailingArgs: [`HEAD:refs/heads/${branch}`],
            });
          }),
        ),
      ),
    );

  const readBranch: CloudGitCredentials["Service"]["readBranch"] = (request) =>
    Effect.gen(function* () {
      const repository = yield* decodeRepository(request.repository).pipe(
        Effect.mapError(() => error("git-failed", "The configured GitHub repository is invalid.")),
      );
      const branch = yield* decodeBranch(request.branch).pipe(
        Effect.mapError(() => error("git-failed", "The publication branch is invalid.")),
      );
      return yield* withSshCredential(request.runId, ({ gitEnvironment }) =>
        runner
          .run({
            command: "git",
            args: [
              "ls-remote",
              "--heads",
              "--exit-code",
              "--",
              `ssh://git@ssh.github.com:443/${repository}.git`,
              `refs/heads/${branch}`,
            ],
            env: gitEnvironment,
            timeout: "30 seconds",
            maxOutputBytes: 64 * 1024,
          })
          .pipe(
            Effect.mapError(() =>
              error("git-failed", "The controller could not inspect the publication branch."),
            ),
            Effect.flatMap((result) => {
              if (result.code === ChildProcessSpawner.ExitCode(2)) return Effect.succeed(null);
              if (result.code !== ChildProcessSpawner.ExitCode(0)) {
                return Effect.fail(classifyGitFailure(result.stderr, "inspect"));
              }
              const [commit] = result.stdout.trim().split(/\s+/, 1);
              return decodeGitCommit(commit).pipe(
                Effect.mapError(() =>
                  error(
                    "git-failed",
                    "GitHub returned an invalid commit for the publication branch.",
                  ),
                ),
              );
            }),
          ),
      );
    });

  const findPullRequest: CloudGitCredentials["Service"]["findPullRequest"] = (request) =>
    Effect.gen(function* () {
      const repository = yield* decodeRepository(request.repository).pipe(
        Effect.mapError(() =>
          error("github-failed", "The configured GitHub repository is invalid."),
        ),
      );
      const [base, head] = yield* Effect.all([
        decodeBranch(request.base),
        decodeBranch(request.head),
      ]).pipe(Effect.mapError(() => error("github-failed", "The pull request branch is invalid.")));
      const raw = yield* readSecret(input.githubTokenSecretRef, "GitHub API");
      const token = decodeTokenSecret(raw);
      if (token === null) {
        return yield* error(
          "invalid-secret",
          "The configured GitHub API secret must contain one token without whitespace.",
        );
      }
      const [owner] = repository.split("/", 1);
      return yield* withRunDirectory(request.runId, (directory) =>
        runner
          .run({
            command: "gh",
            args: [
              "api",
              "--hostname",
              "github.com",
              "--method",
              "GET",
              `repos/${repository}/pulls`,
              "-f",
              "state=open",
              "-f",
              `head=${owner}:${head}`,
              "-f",
              `base=${base}`,
              "-f",
              "per_page=1",
            ],
            env: {
              GH_HOST: "github.com",
              GH_TOKEN: token,
              GITHUB_TOKEN: token,
              GH_CONFIG_DIR: directory,
              GH_DEBUG: "",
            },
            timeout: "30 seconds",
            maxOutputBytes: 1024 * 1024,
          })
          .pipe(
            Effect.mapError(() =>
              error("github-failed", "The controller could not inspect GitHub pull requests."),
            ),
            Effect.flatMap((result) =>
              result.code === ChildProcessSpawner.ExitCode(0)
                ? decodePullRequestListResponse(result.stdout).pipe(
                    Effect.map((responses) => {
                      const response = responses[0];
                      return response === undefined
                        ? null
                        : { number: response.number, url: response.html_url.toString() };
                    }),
                    Effect.mapError(() =>
                      error(
                        "invalid-github-response",
                        "GitHub returned an invalid pull request list.",
                      ),
                    ),
                  )
                : Effect.fail(classifyGitHubFailure(result.stderr, "inspect")),
            ),
          ),
      );
    });

  const createDraftPullRequest: CloudGitCredentials["Service"]["createDraftPullRequest"] = (
    request,
  ) =>
    Effect.gen(function* () {
      const repository = yield* decodeRepository(request.repository).pipe(
        Effect.mapError(() =>
          error("github-failed", "The configured GitHub repository is invalid."),
        ),
      );
      const [base, head] = yield* Effect.all([
        decodeBranch(request.base),
        decodeBranch(request.head),
      ]).pipe(Effect.mapError(() => error("github-failed", "The pull request branch is invalid.")));
      const raw = yield* readSecret(input.githubTokenSecretRef, "GitHub API");
      const token = decodeTokenSecret(raw);
      if (token === null) {
        return yield* error(
          "invalid-secret",
          "The configured GitHub API secret must contain one token without whitespace.",
        );
      }

      const created = yield* withRunDirectory(request.runId, (directory) =>
        runner
          .run({
            command: "gh",
            args: [
              "api",
              "--hostname",
              "github.com",
              "--method",
              "POST",
              `repos/${repository}/pulls`,
              "--input",
              "-",
            ],
            env: {
              GH_HOST: "github.com",
              GH_TOKEN: token,
              GITHUB_TOKEN: token,
              GH_CONFIG_DIR: directory,
              GH_DEBUG: "",
            },
            stdin: JSON.stringify({
              title: request.title,
              body: request.body,
              head,
              base,
              draft: true,
            }),
            timeout: "30 seconds",
            maxOutputBytes: 1024 * 1024,
          })
          .pipe(
            Effect.mapError(() =>
              error("github-failed", "The controller could not start the GitHub API request."),
            ),
            Effect.flatMap((result) =>
              result.code === ChildProcessSpawner.ExitCode(0)
                ? decodePullRequestResponse(result.stdout).pipe(
                    Effect.map((response) => ({
                      number: response.number,
                      url: response.html_url.toString(),
                    })),
                    Effect.mapError(() =>
                      error(
                        "invalid-github-response",
                        "GitHub created a pull request but returned an invalid response.",
                      ),
                    ),
                  )
                : Effect.fail(classifyGitHubFailure(result.stderr, "create")),
            ),
          ),
      );
      if (request.skipReviewerRequest === true) {
        yield* withRunDirectory(request.runId, (directory) =>
          runner
            .run({
              command: "gh",
              args: [
                "api",
                "--hostname",
                "github.com",
                "--method",
                "DELETE",
                `repos/${repository}/pulls/${created.number}/requested_reviewers`,
                "--input",
                "-",
              ],
              env: {
                GH_HOST: "github.com",
                GH_TOKEN: token,
                GITHUB_TOKEN: token,
                GH_CONFIG_DIR: directory,
                GH_DEBUG: "",
              },
              stdin: JSON.stringify({ reviewers: [], team_reviewers: [] }),
              timeout: "30 seconds",
              maxOutputBytes: 1024 * 1024,
            })
            .pipe(
              Effect.mapError(() =>
                error("github-failed", "The controller could not suppress pull request reviewers."),
              ),
              Effect.flatMap((result) =>
                result.code === ChildProcessSpawner.ExitCode(0) ||
                result.stderr.toLowerCase().includes("422")
                  ? Effect.void
                  : Effect.fail(classifyGitHubFailure(result.stderr, "create")),
              ),
            ),
        );
      }
      return created;
    });

  const closePullRequest: CloudGitCredentials["Service"]["closePullRequest"] = (request) =>
    Effect.gen(function* () {
      const repository = yield* decodeRepository(request.repository).pipe(
        Effect.mapError(() =>
          error("github-failed", "The configured GitHub repository is invalid."),
        ),
      );
      if (!Number.isInteger(request.number) || request.number <= 0) {
        return yield* error("github-failed", "The pull request number is invalid.");
      }
      const raw = yield* readSecret(input.githubTokenSecretRef, "GitHub API");
      const token = decodeTokenSecret(raw);
      if (token === null) {
        return yield* error(
          "invalid-secret",
          "The configured GitHub API secret must contain one token without whitespace.",
        );
      }
      return yield* withRunDirectory(request.runId, (directory) =>
        runner
          .run({
            command: "gh",
            args: [
              "api",
              "--hostname",
              "github.com",
              "--method",
              "PATCH",
              `repos/${repository}/pulls/${request.number}`,
              "--input",
              "-",
            ],
            env: {
              GH_HOST: "github.com",
              GH_TOKEN: token,
              GITHUB_TOKEN: token,
              GH_CONFIG_DIR: directory,
              GH_DEBUG: "",
            },
            stdin: JSON.stringify({ state: "closed" }),
            timeout: "30 seconds",
            maxOutputBytes: 1024 * 1024,
          })
          .pipe(
            Effect.mapError(() =>
              error("github-failed", "The controller could not start the GitHub API request."),
            ),
            Effect.flatMap((result) =>
              result.code === ChildProcessSpawner.ExitCode(0)
                ? Effect.void
                : Effect.fail(classifyGitHubFailure(result.stderr, "close")),
            ),
          ),
      );
    });

  const syncPrivateGitDependencies: CloudGitCredentials["Service"]["syncPrivateGitDependencies"] = (
    request,
  ) =>
    Effect.gen(function* () {
      if (request.kinds.includes("submodule")) {
        yield* runWorkspaceGit({
          operation: "submodule",
          runId: request.runId,
          cwd: request.cwd,
          args: ["submodule", "update", "--init", "--recursive"],
        });
      }
      if (request.kinds.includes("lfs")) {
        yield* runWorkspaceGit({
          operation: "lfs",
          runId: request.runId,
          cwd: request.cwd,
          args: ["lfs", "pull"],
        });
      }
    });

  return CloudGitCredentials.of({
    clone,
    fetch,
    resolveRef,
    push,
    readBranch,
    findPullRequest,
    createDraftPullRequest,
    closePullRequest,
    syncPrivateGitDependencies,
  });
});

const optionalReference = (name: string) =>
  Config.string(name).pipe(
    Config.map((value) => value.trim()),
    Config.option,
    Config.map(Option.filter((value) => value.length > 0)),
    Config.map(Option.getOrUndefined),
  );

export const layer = Layer.effect(
  CloudGitCredentials,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const [sshSecretRef, githubTokenSecretRef] = yield* Effect.all([
      optionalReference("T3CODE_CLOUD_GIT_SSH_SECRET_REF"),
      optionalReference("T3CODE_CLOUD_GITHUB_TOKEN_SECRET_REF"),
    ]);
    return yield* make({
      credentialRoot: path.join(config.secretsDir, "cloud-git-runs"),
      sshSecretRef,
      githubTokenSecretRef,
    });
  }),
);
