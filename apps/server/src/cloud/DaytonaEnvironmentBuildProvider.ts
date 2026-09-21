// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { Daytona, DaytonaNotFoundError, Image, type Snapshot } from "@daytona/sdk";
import {
  type CloudEnvironmentBase,
  type CloudEnvironmentBuildGitSetup,
  type CloudEnvironmentBuildId,
  type CloudEnvironmentBuildSnapshot,
  type CloudEnvironmentBuildStage,
  type CloudEnvironmentBuildTimings,
  type CloudRepositoryCommandResult,
  type CloudRunStageTiming,
  NonNegativeInt,
  redactCloudEnvironmentSecretOutput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { ResolvedDaytonaConfig } from "./daytonaConfig.ts";
import { DAYTONA_WORKER_IMAGE_VERSIONS, daytonaWorkerImage } from "./daytonaWorkerImage.ts";

const OPERATION_TIMEOUT_SECONDS = 30 * 60;
const WORK_ROOT = "/work/environment";
const PROVENANCE_PATH = "/opt/t3/environment-build.json";

const LABEL = {
  project: "t3-project",
  purpose: "t3-purpose",
  buildId: "t3-build-id",
} as const;

export const DAYTONA_BUILD_ARTIFACTS = {
  workerImage:
    "Pinned system tools only. It contains no repository, source-control credential, provider home, T3 userdata, runtime secret, or phone pairing state.",
  coldSnapshot:
    "A detached repository checkout, install output, and immutable provenance. It retains filesystem state only, never running processes or in-memory state.",
  draftSnapshot:
    "A verified draft remains a cold snapshot until explicit Save activates its Build. Failed verification deletes the draft snapshot; retained drafts require explicit deletion.",
  preparationSandbox:
    "A disposable checkout and install host. T3 deletes it after snapshot creation, including after a failed or cancelled Build.",
  agentState:
    "A durable agent's workspace, T3 event state, provider session, runtime secrets, and phone pairing state remain outside reusable Build artifacts.",
  hotState:
    "Pause or hot-snapshot state is outside environment Builds and may be used only when the selected sandbox class reports support. T3 never treats a cold snapshot as process migration.",
} as const;

export interface DaytonaEnvironmentBuildFailure {
  readonly stage: CloudEnvironmentBuildStage;
  readonly message: string;
  readonly logs?: ReadonlyArray<CloudRepositoryCommandResult>;
  readonly timings?: CloudEnvironmentBuildTimings;
}

export interface DaytonaEnvironmentBuildInput {
  readonly buildId: CloudEnvironmentBuildId;
  readonly base: CloudEnvironmentBase;
  readonly inputsFingerprint: string;
  readonly gitSetup: ReadonlyArray<CloudEnvironmentBuildGitSetup>;
  readonly install: string | undefined;
  readonly secretEnv: Readonly<Record<string, string>>;
  readonly redact: ReadonlyArray<string>;
}

export interface DaytonaEnvironmentBuildResult {
  readonly snapshot: CloudEnvironmentBuildSnapshot;
  readonly logs: ReadonlyArray<CloudRepositoryCommandResult>;
  readonly timings: CloudEnvironmentBuildTimings;
}

interface DaytonaBuildSandbox {
  readonly id: string;
  readonly process: {
    readonly executeCommand: (
      command: string,
      cwd?: string,
      environment?: Record<string, string>,
      timeoutSeconds?: number,
    ) => Promise<{ readonly exitCode: number; readonly result: string }>;
  };
  readonly createSnapshot: (name: string, timeoutSeconds?: number) => Promise<void>;
  readonly archive: () => Promise<void>;
  readonly delete: (timeoutSeconds?: number, wait?: boolean) => Promise<void>;
}

type DaytonaBuildSandboxParams = {
  readonly image?: string | Image;
  readonly snapshot?: string;
  readonly name: string;
  readonly user: string;
  readonly envVars: Record<string, string>;
  readonly labels: Record<string, string>;
  readonly public: false;
  readonly autoStopInterval: number;
  readonly autoArchiveInterval: number;
  readonly autoDeleteInterval: number;
  readonly resources?: { readonly cpu?: number; readonly memory?: number; readonly disk?: number };
};

export interface DaytonaEnvironmentBuildClient {
  readonly create: (
    params: DaytonaBuildSandboxParams,
    options: { readonly timeout: number },
  ) => Promise<DaytonaBuildSandbox>;
  readonly get: (sandboxId: string) => Promise<DaytonaBuildSandbox>;
  readonly snapshots: {
    readonly get: (snapshotId: string) => Promise<Snapshot>;
    readonly delete: (snapshotId: string) => Promise<void>;
  };
}

export interface DaytonaEnvironmentBuildProvider {
  readonly prepare: (
    input: DaytonaEnvironmentBuildInput,
  ) => Effect.Effect<DaytonaEnvironmentBuildResult, DaytonaEnvironmentBuildFailure>;
  readonly inspectSnapshot: (
    snapshotId: string,
  ) => Effect.Effect<Snapshot | undefined, DaytonaEnvironmentBuildFailure>;
  readonly deleteSnapshot: (
    snapshotId: string,
  ) => Effect.Effect<void, DaytonaEnvironmentBuildFailure>;
  readonly archiveSandbox: (
    sandboxId: string,
  ) => Effect.Effect<void, DaytonaEnvironmentBuildFailure>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function workspaceSegment(repository: string): string {
  return repository.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
}

function failure(
  stage: CloudEnvironmentBuildStage,
  message: string,
): DaytonaEnvironmentBuildFailure {
  return { stage, message };
}

type SnapshotOperationFailure =
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly failure: DaytonaEnvironmentBuildFailure };

function snapshotOperationFailure(cause: unknown, message: string): SnapshotOperationFailure {
  return cause instanceof DaytonaNotFoundError
    ? { kind: "not-found" }
    : { kind: "failed", failure: failure("snapshot", message) };
}

function snapshotName(buildId: CloudEnvironmentBuildId): string {
  const safe = buildId.replaceAll(/[^A-Za-z0-9-]+/g, "-").slice(0, 48);
  const suffix = NodeCrypto.createHash("sha256").update(buildId).digest("hex").slice(0, 12);
  return `t3-build-${safe}-${suffix}`;
}

function sandboxName(buildId: CloudEnvironmentBuildId, purpose: "prepare" | "verify"): string {
  return `${snapshotName(buildId)}-${purpose}`.slice(0, 63);
}

function provenance(input: DaytonaEnvironmentBuildInput): string {
  return JSON.stringify({
    version: 1,
    buildId: input.buildId,
    inputsFingerprint: input.inputsFingerprint,
    base: input.base,
    gitSetup: input.gitSetup,
    artifactRetention: DAYTONA_BUILD_ARTIFACTS,
  });
}

function isoDate(value: Date | string): string {
  return DateTime.formatIso(DateTime.makeUnsafe(value));
}

function sdkClient(config: ResolvedDaytonaConfig): DaytonaEnvironmentBuildClient | undefined {
  if (config.admission !== "daytona" || config.apiKey === undefined) return undefined;
  const daytona = new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    target: config.target,
  });
  return {
    create: (params, options) => {
      const shared = {
        name: params.name,
        user: params.user,
        envVars: params.envVars,
        labels: params.labels,
        public: params.public,
        autoStopInterval: params.autoStopInterval,
        autoArchiveInterval: params.autoArchiveInterval,
        autoDeleteInterval: params.autoDeleteInterval,
      };
      if (params.image !== undefined) {
        return daytona.create(
          {
            ...shared,
            image: params.image,
            ...(params.resources === undefined ? {} : { resources: params.resources }),
          },
          options,
        );
      }
      return daytona.create(
        { ...shared, ...(params.snapshot === undefined ? {} : { snapshot: params.snapshot }) },
        options,
      );
    },
    get: (sandboxId) => daytona.get(sandboxId),
    snapshots: {
      get: (snapshotId) => daytona.snapshot.get(snapshotId),
      delete: (snapshotId) => daytona.snapshot.delete(snapshotId),
    },
  };
}

export const make = Effect.fn("DaytonaEnvironmentBuildProvider.make")(function (input: {
  readonly config: ResolvedDaytonaConfig;
  readonly client?: DaytonaEnvironmentBuildClient;
}) {
  const client = input.client ?? sdkClient(input.config);

  const sdk = <A>(
    stage: CloudEnvironmentBuildStage,
    message: string,
    operation: () => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: operation,
      catch: () => failure(stage, message),
    });

  const requireClient = (stage: CloudEnvironmentBuildStage) => {
    if (input.config.admission === "disabled") {
      return Effect.fail(failure(stage, "Managed Daytona environment Builds are disabled."));
    }
    if (input.config.apiKey === undefined && input.client === undefined) {
      return Effect.fail(
        failure(stage, "DAYTONA_API_KEY is required to run an environment Build."),
      );
    }
    if (client === undefined) {
      return Effect.fail(failure(stage, "The Daytona environment Build client is unavailable."));
    }
    return Effect.succeed(client);
  };

  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const timing = (startedAt: string, completedAt: string) => ({
    startedAt,
    completedAt,
    durationMs: NonNegativeInt.make(Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))),
  });

  const createSandbox = Effect.fn("DaytonaEnvironmentBuildProvider.createSandbox")(
    function* (request: {
      readonly buildId: CloudEnvironmentBuildId;
      readonly purpose: "prepare" | "verify";
      readonly base:
        | CloudEnvironmentBase
        | { readonly kind: "snapshot"; readonly snapshot: string };
    }) {
      const daytona = yield* requireClient("base");
      const source =
        request.base.kind === "snapshot"
          ? { snapshot: request.base.snapshot }
          : request.base.kind === "image"
            ? { image: daytonaWorkerImage(request.base.image) }
            : undefined;
      if (source === undefined) {
        return yield* Effect.fail(
          failure(
            "base",
            "Daytona cannot build a repository Dockerfile before the repository checkout exists. Save an explicit image or snapshot base.",
          ),
        );
      }
      const resources = {
        ...(input.config.cpu === undefined ? {} : { cpu: input.config.cpu }),
        ...(input.config.memoryGib === undefined ? {} : { memory: input.config.memoryGib }),
        ...(input.config.diskGib === undefined ? {} : { disk: input.config.diskGib }),
      };
      return yield* sdk("base", "Daytona could not create the isolated Build sandbox.", () =>
        daytona.create(
          {
            ...source,
            name: sandboxName(request.buildId, request.purpose),
            user: request.purpose === "prepare" ? "root" : "cloudagent",
            envVars: {},
            labels: {
              [LABEL.project]: input.config.project,
              [LABEL.purpose]: `environment-build-${request.purpose}`,
              [LABEL.buildId]: request.buildId,
            },
            public: false,
            autoStopInterval: 0,
            autoArchiveInterval: 0,
            autoDeleteInterval: 60,
            ...(Object.keys(resources).length === 0 ? {} : { resources }),
          },
          { timeout: OPERATION_TIMEOUT_SECONDS },
        ),
      );
    },
  );

  const execute = Effect.fn("DaytonaEnvironmentBuildProvider.execute")(function* (request: {
    readonly sandbox: DaytonaBuildSandbox;
    readonly stage: CloudEnvironmentBuildStage;
    readonly command: string;
    readonly cwd?: string;
    readonly environment?: Readonly<Record<string, string>>;
    readonly message: string;
  }) {
    const result = yield* sdk(request.stage, request.message, () =>
      request.sandbox.process.executeCommand(
        request.command,
        request.cwd,
        request.environment === undefined ? undefined : { ...request.environment },
        OPERATION_TIMEOUT_SECONDS,
      ),
    );
    if (result.exitCode !== 0) {
      return yield* Effect.fail(failure(request.stage, request.message));
    }
    return result;
  });

  const deleteSandbox = (sandbox: DaytonaBuildSandbox) =>
    sdk("snapshot", "Daytona could not delete a disposable Build sandbox.", () =>
      sandbox.delete(60, true),
    ).pipe(Effect.ignore);

  const inspectSnapshot: DaytonaEnvironmentBuildProvider["inspectSnapshot"] = (snapshotId) =>
    Effect.gen(function* () {
      const daytona = yield* requireClient("snapshot");
      return yield* Effect.tryPromise({
        try: () => daytona.snapshots.get(snapshotId),
        catch: (cause) =>
          snapshotOperationFailure(cause, "Daytona could not inspect the Build snapshot."),
      }).pipe(
        Effect.catch((cause) =>
          cause.kind === "not-found" ? Effect.succeed(undefined) : Effect.fail(cause.failure),
        ),
      );
    });

  const deleteSnapshot: DaytonaEnvironmentBuildProvider["deleteSnapshot"] = (snapshotId) =>
    Effect.gen(function* () {
      const daytona = yield* requireClient("snapshot");
      yield* Effect.tryPromise({
        try: () => daytona.snapshots.delete(snapshotId),
        catch: (cause) =>
          snapshotOperationFailure(cause, "Daytona could not delete the Build snapshot."),
      }).pipe(
        Effect.catch((cause) =>
          cause.kind === "not-found" ? Effect.void : Effect.fail(cause.failure),
        ),
      );
    });

  const verifySnapshot = Effect.fn("DaytonaEnvironmentBuildProvider.verifySnapshot")(
    function* (request: {
      readonly build: DaytonaEnvironmentBuildInput;
      readonly snapshotId: string;
      readonly provenanceDigest: string;
    }) {
      const verifier = yield* createSandbox({
        buildId: request.build.buildId,
        purpose: "verify",
        base: { kind: "snapshot", snapshot: request.snapshotId },
      });
      yield* Effect.gen(function* () {
        const repositoryChecks = request.build.gitSetup
          .map((entry) => {
            const directory = `${WORK_ROOT}/${workspaceSegment(entry.repository)}`;
            return `test "$(git -C ${shellQuote(directory)} rev-parse HEAD)" = ${shellQuote(entry.commit)}`;
          })
          .join(" && ");
        const command = [
          `test "$(sha256sum ${PROVENANCE_PATH} | cut -d' ' -f1)" = ${shellQuote(request.provenanceDigest)}`,
          `test "$(node --version)" = ${shellQuote(`v${DAYTONA_WORKER_IMAGE_VERSIONS.node}`)}`,
          "git --version >/dev/null",
          "t3 --version >/dev/null",
          "codex --version >/dev/null",
          "claude --version >/dev/null",
          repositoryChecks,
          "test ! -e /home/cloudagent/.ssh",
          "test ! -e /home/cloudagent/.codex",
          "test ! -e /home/cloudagent/.claude",
          "test ! -e /home/cloudagent/.t3",
        ]
          .filter((part) => part.length > 0)
          .join(" && ");
        yield* execute({
          sandbox: verifier,
          stage: "snapshot",
          command,
          message: "The fresh Daytona verification sandbox did not match the prepared Build.",
        });
      }).pipe(Effect.ensuring(deleteSandbox(verifier)));
    },
  );

  const prepare: DaytonaEnvironmentBuildProvider["prepare"] = (build) =>
    Effect.gen(function* () {
      const logs: Array<CloudRepositoryCommandResult> = [];
      const timings: {
        base?: CloudRunStageTiming;
        clone?: CloudRunStageTiming;
        install?: CloudRunStageTiming;
        snapshot?: CloudRunStageTiming;
      } = {};
      const baseStartedAt = yield* now;
      const sandbox = yield* createSandbox({
        buildId: build.buildId,
        purpose: "prepare",
        base: build.base,
      });
      timings.base = timing(baseStartedAt, yield* now);

      const prepared = yield* Effect.result(
        Effect.gen(function* () {
          yield* execute({
            sandbox,
            stage: "clone",
            command: `rm -rf ${WORK_ROOT} && install -d -o cloudagent -g cloudagent -m 0750 ${WORK_ROOT}`,
            message: "The Daytona Build sandbox could not create its isolated workspace.",
          });
          const cloneStartedAt = yield* now;
          for (const entry of build.gitSetup) {
            const destination = `${WORK_ROOT}/${workspaceSegment(entry.repository)}`;
            const repositoryUrl = `https://github.com/${entry.repository}.git`;
            yield* execute({
              sandbox,
              stage: "clone",
              command: [
                `runuser -u cloudagent -- git clone --no-checkout --no-tags -- ${shellQuote(repositoryUrl)} ${shellQuote(destination)}`,
                `runuser -u cloudagent -- git -C ${shellQuote(destination)} fetch --no-tags --force -- origin ${shellQuote(entry.commit)}`,
                `runuser -u cloudagent -- git -C ${shellQuote(destination)} checkout --detach ${shellQuote(entry.commit)}`,
              ].join(" && "),
              message: `Daytona could not check out '${entry.repository}' at ${entry.commit}.`,
            });
          }
          timings.clone = timing(cloneStartedAt, yield* now);

          const install = build.install?.trim();
          if (install !== undefined && install.length > 0) {
            const primary = build.gitSetup[0];
            const installStartedAt = yield* now;
            const encoded = Buffer.from(`set -e\n${install}\n`).toString("base64");
            const startedAt = yield* now;
            const result = yield* sdk(
              "install",
              "Daytona could not run the environment's 'install' command.",
              () =>
                sandbox.process.executeCommand(
                  `printf %s ${shellQuote(encoded)} | base64 -d > /tmp/t3-install.sh && chmod 0755 /tmp/t3-install.sh && runuser -u cloudagent --preserve-environment -- /bin/sh /tmp/t3-install.sh`,
                  primary === undefined
                    ? WORK_ROOT
                    : `${WORK_ROOT}/${workspaceSegment(primary.repository)}`,
                  { CI: "1", GIT_TERMINAL_PROMPT: "0", ...build.secretEnv },
                  OPERATION_TIMEOUT_SECONDS,
                ),
            );
            const completedAt = yield* now;
            logs.push({
              name: "install",
              command: "/bin/sh",
              args: ["/tmp/t3-install.sh"],
              startedAt,
              completedAt,
              exitCode: result.exitCode,
              timedOut: false,
              stdout: redactCloudEnvironmentSecretOutput(result.result, build.redact),
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
            if (result.exitCode !== 0) {
              return yield* Effect.fail(
                failure(
                  "install",
                  `The environment's 'install' exited with code ${result.exitCode}.`,
                ),
              );
            }
            timings.install = timing(installStartedAt, completedAt);
          }

          const manifest = provenance(build);
          const manifestDigest = NodeCrypto.createHash("sha256").update(manifest).digest("hex");
          const encodedManifest = Buffer.from(manifest).toString("base64");
          yield* execute({
            sandbox,
            stage: "snapshot",
            command: [
              `find ${WORK_ROOT} -type f \\( -name .netrc -o -name .npmrc -o -name .pypirc -o -name .git-credentials -o -name credentials.json -o -name '*.pem' -o -name '*.key' -o -name id_rsa -o -name id_ed25519 -o -name id_ecdsa -o -name id_dsa \\) -delete`,
              `find ${WORK_ROOT} -type f \\( -path '*/.aws/credentials' -o -path '*/.aws/config' -o -path '*/.ssh/authorized_keys' \\) -delete`,
              "rm -rf /root/.ssh /root/.gitconfig /root/.git-credentials /root/.codex /root/.claude /root/.grok /root/.t3",
              "rm -rf /home/cloudagent/.ssh /home/cloudagent/.gitconfig /home/cloudagent/.git-credentials /home/cloudagent/.codex /home/cloudagent/.claude /home/cloudagent/.grok /home/cloudagent/.t3",
              `printf %s ${shellQuote(encodedManifest)} | base64 -d > ${PROVENANCE_PATH}`,
              "chmod 0444 /opt/t3/environment-build.json",
              "rm -f /tmp/t3-install.sh",
            ].join(" && "),
            message:
              "The Daytona Build could not remove transient credentials before snapshotting.",
          });

          const snapshotStartedAt = yield* now;
          const name = snapshotName(build.buildId);
          yield* sdk("snapshot", "Daytona could not create the environment Build snapshot.", () =>
            sandbox.createSnapshot(name, OPERATION_TIMEOUT_SECONDS),
          );
          const daytona = yield* requireClient("snapshot");
          const snapshot = yield* sdk(
            "snapshot",
            "Daytona created the Build snapshot but could not read its provenance.",
            () => daytona.snapshots.get(name),
          );
          yield* verifySnapshot({
            build,
            snapshotId: snapshot.id,
            provenanceDigest: manifestDigest,
          }).pipe(
            Effect.onError(() =>
              sdk("snapshot", "Daytona could not discard a failed draft snapshot.", () =>
                daytona.snapshots.delete(snapshot.id),
              ).pipe(Effect.ignore),
            ),
          );
          const snapshotCompletedAt = yield* now;
          timings.snapshot = timing(snapshotStartedAt, snapshotCompletedAt);
          const digest = NodeCrypto.createHash("sha256")
            .update(`${build.inputsFingerprint}:${snapshot.id}:${manifestDigest}`)
            .digest("hex");
          return {
            snapshot: {
              id: snapshot.id,
              digest,
              sizeBytes: NonNegativeInt.make(Math.max(0, Math.round(snapshot.size ?? 0))),
              createdAt: isoDate(snapshot.createdAt),
            },
            logs,
            timings: timings satisfies CloudEnvironmentBuildTimings,
          };
        }).pipe(Effect.ensuring(deleteSandbox(sandbox))),
      );
      if (Result.isFailure(prepared)) {
        return yield* Effect.fail({
          ...prepared.failure,
          logs,
          timings: { ...timings } satisfies CloudEnvironmentBuildTimings,
        });
      }
      return prepared.success;
    });

  const archiveSandbox: DaytonaEnvironmentBuildProvider["archiveSandbox"] = (sandboxId) =>
    Effect.gen(function* () {
      const daytona = yield* requireClient("snapshot");
      const sandbox = yield* sdk(
        "snapshot",
        "Daytona could not find the Build sandbox to archive.",
        () => daytona.get(sandboxId),
      );
      yield* sdk("snapshot", "Daytona could not archive the Build sandbox.", () =>
        sandbox.archive(),
      );
    });

  return Effect.succeed({
    prepare,
    inspectSnapshot,
    deleteSnapshot,
    archiveSandbox,
  } satisfies DaytonaEnvironmentBuildProvider);
});
