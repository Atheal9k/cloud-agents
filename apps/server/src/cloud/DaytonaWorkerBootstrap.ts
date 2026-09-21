// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  ExecutionEnvironmentDescriptor,
  RunWorkerId,
  type CloudEnvironmentVersion,
  type RunAllocation,
  type RunWorkerRegistrationInput,
  cloudEnvironmentRuntimeServices,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import type { CloudRuntimeProcess } from "./CloudRuntimeProvider.ts";
import { CloudRuntimeProvider } from "./CloudRuntimeProvider.ts";

const T3_PORT = 3773;
const T3_HOME = "/home/cloudagent/.t3-cloud";
const WORKSPACE = "/work/repository";

export type DaytonaWorkerBootstrapStage =
  | "checkout"
  | "setup"
  | "provider"
  | "terminal"
  | "worker"
  | "preview"
  | "registration";

export class DaytonaWorkerBootstrapError extends Schema.TaggedError<DaytonaWorkerBootstrapError>()(
  "DaytonaWorkerBootstrapError",
  {
    stage: Schema.Literals([
      "checkout",
      "setup",
      "provider",
      "terminal",
      "worker",
      "preview",
      "registration",
    ]),
    message: Schema.String,
  },
) {}

export interface DaytonaWorkerBootstrap {
  readonly prepare: (input: {
    readonly allocation: RunAllocation;
    readonly version?: CloudEnvironmentVersion;
  }) => Effect.Effect<
    | { readonly status: "pending"; readonly stage: DaytonaWorkerBootstrapStage }
    | { readonly status: "ready" },
    DaytonaWorkerBootstrapError
  >;
  readonly registration: (input: {
    readonly allocation: RunAllocation;
  }) => Effect.Effect<RunWorkerRegistrationInput | undefined, DaytonaWorkerBootstrapError>;
  readonly preview: (input: {
    readonly allocation: RunAllocation;
    readonly version?: CloudEnvironmentVersion;
  }) => Effect.Effect<string | undefined, DaytonaWorkerBootstrapError>;
  readonly interrupt: (
    allocation: RunAllocation,
  ) => Effect.Effect<void, DaytonaWorkerBootstrapError>;
}

function failure(stage: DaytonaWorkerBootstrapStage, message: string) {
  return new DaytonaWorkerBootstrapError({ stage, message });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function segment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
}

function sessionId(allocation: RunAllocation, stage: string): string {
  return `t3-${segment(allocation.id)}-${allocation.attempt}-${segment(stage)}`.slice(0, 128);
}

function runtimeId(allocation: RunAllocation): string | undefined {
  switch (allocation.allocationState.status) {
    case "booting":
    case "registering":
    case "ready":
    case "failed":
      return allocation.allocationState.managedRuntime?.runtimeId;
    case "queued":
    case "launching":
      return undefined;
  }
}

function checkoutCommand(allocation: RunAllocation): string {
  const repository = allocation.target.repository;
  const selectedRef = allocation.execution?.selectedRef ?? allocation.target.baseCommit;
  const outputBranch = allocation.target.branch;
  const builtWorkspace = `/work/environment/${segment(repository)}`;
  const prepare = allocation.build
    ? `rm -rf ${shellQuote(WORKSPACE)} && cp -a ${shellQuote(builtWorkspace)} ${shellQuote(WORKSPACE)}`
    : `rm -rf ${shellQuote(WORKSPACE)} && git clone ${shellQuote(`https://github.com/${repository}.git`)} ${shellQuote(WORKSPACE)}`;
  return [
    "set -eu",
    prepare,
    `git -c safe.directory=${shellQuote(WORKSPACE)} -C ${shellQuote(WORKSPACE)} checkout -B ${shellQuote(outputBranch)} ${shellQuote(selectedRef)}`,
    `chown -R cloudagent:cloudagent ${shellQuote(WORKSPACE)}`,
  ].join(" && ");
}

function providerCommand(allocation: RunAllocation): string {
  const instanceId = allocation.execution?.turn.modelSelection.instanceId ?? "";
  return instanceId.toLowerCase().includes("claude") ? "claude --version" : "codex --version";
}

function workerCommand(): string {
  return `exec runuser -u cloudagent -- env T3CODE_NO_BROWSER=true t3 --host 0.0.0.0 --port ${T3_PORT} --base-dir ${shellQuote(T3_HOME)}`;
}

function processFailure(stage: DaytonaWorkerBootstrapStage, process: CloudRuntimeProcess) {
  const output = process.status === "missing" ? "" : process.output.trim();
  const suffix = output.length === 0 ? "" : ` ${output.slice(-1_000)}`;
  return failure(stage, `The Daytona ${stage} process exited before it became ready.${suffix}`);
}

function urlAt(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.hash = "";
  return url.toString();
}

const decodeControllerCredential = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ credential: Schema.String }),
      Schema.Struct({ access_token: Schema.String }),
    ]),
  ),
);
const encodeAccessCache = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ access_token: Schema.String })),
);
export const make = Effect.fn("DaytonaWorkerBootstrap.make")(function* () {
  const runtimes = yield* CloudRuntimeProvider;
  const httpClient = yield* HttpClient.HttpClient;

  const ensureCompleted = Effect.fn("DaytonaWorkerBootstrap.ensureCompleted")(function* (input: {
    readonly runtimeId: string;
    readonly sessionId: string;
    readonly command: string;
    readonly stage: DaytonaWorkerBootstrapStage;
  }) {
    const process = yield* runtimes
      .ensureProcess(input)
      .pipe(Effect.mapError((error) => failure(input.stage, error.message)));
    if (process.status === "failed") return yield* processFailure(input.stage, process);
    return process.status === "succeeded";
  });

  const ensureRunning = Effect.fn("DaytonaWorkerBootstrap.ensureRunning")(function* (input: {
    readonly runtimeId: string;
    readonly sessionId: string;
    readonly command: string;
    readonly stage: DaytonaWorkerBootstrapStage;
  }) {
    const process = yield* runtimes
      .ensureProcess(input)
      .pipe(Effect.mapError((error) => failure(input.stage, error.message)));
    if (process.status === "failed" || process.status === "succeeded") {
      return yield* processFailure(input.stage, process);
    }
    return process.status === "running";
  });

  const prepare: DaytonaWorkerBootstrap["prepare"] = Effect.fn("DaytonaWorkerBootstrap.prepare")(
    function* ({ allocation, version }) {
      const id = runtimeId(allocation);
      if (id === undefined)
        return yield* failure("setup", "The allocation has no Daytona runtime.");
      if (
        !(yield* ensureCompleted({
          runtimeId: id,
          sessionId: sessionId(allocation, "checkout"),
          command: checkoutCommand(allocation),
          stage: "checkout",
        }))
      ) {
        return { status: "pending", stage: "checkout" };
      }
      if (
        !(yield* ensureCompleted({
          runtimeId: id,
          sessionId: sessionId(allocation, "provider"),
          command: providerCommand(allocation),
          stage: "provider",
        }))
      ) {
        return { status: "pending", stage: "provider" };
      }
      for (const service of version === undefined
        ? []
        : cloudEnvironmentRuntimeServices(version.config)) {
        const running = yield* ensureRunning({
          runtimeId: id,
          sessionId: sessionId(allocation, `${service.kind}-${service.name}`),
          command: `cd ${shellQuote(WORKSPACE)} && exec runuser -u cloudagent -- /bin/sh -lc ${shellQuote(service.command)}`,
          stage: service.kind === "terminal" ? "terminal" : "setup",
        });
        if (!running)
          return { status: "pending", stage: service.kind === "start" ? "setup" : "terminal" };
      }
      return (yield* ensureRunning({
        runtimeId: id,
        sessionId: sessionId(allocation, "worker"),
        command: workerCommand(),
        stage: "worker",
      }))
        ? { status: "ready" }
        : { status: "pending", stage: "worker" };
    },
  );

  const registration: DaytonaWorkerBootstrap["registration"] = Effect.fn(
    "DaytonaWorkerBootstrap.registration",
  )(function* ({ allocation }) {
    const id = runtimeId(allocation);
    if (id === undefined || allocation.execution === undefined) {
      return yield* failure("registration", "The allocation has no Daytona worker execution.");
    }
    const worker = yield* runtimes
      .inspectProcess({ runtimeId: id, sessionId: sessionId(allocation, "worker") })
      .pipe(Effect.mapError((error) => failure("worker", error.message)));
    if (worker.status === "missing") return undefined;
    if (worker.status !== "running") return yield* processFailure("worker", worker);

    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const expiresInSeconds = Math.max(
      60,
      Math.ceil((Date.parse(allocation.deadlines.cleanupBy) - now) / 1_000),
    );
    const preview = yield* runtimes
      .preview({ action: "issue", runtimeId: id, port: T3_PORT, expiresInSeconds })
      .pipe(Effect.mapError((error) => failure("preview", error.message)));
    if (preview === undefined) {
      return yield* failure("preview", "Daytona did not issue a signed worker URL.");
    }
    const descriptor = yield* httpClient
      .execute(HttpClientRequest.get(urlAt(preview.url, "/.well-known/t3/environment")))
      .pipe(
        Effect.timeout("10 seconds"),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
        Effect.mapError(() => failure("registration", "The T3 worker descriptor is not ready.")),
      );
    const controllerAccessPath = `${T3_HOME}/controller-access.json`;
    const controllerCredential = yield* runtimes
      .execute({
        runtimeId: id,
        command: [
          "set -eu",
          `if test -s ${shellQuote(controllerAccessPath)}; then cat ${shellQuote(controllerAccessPath)}; else runuser -u cloudagent -- t3 auth pairing create --base-dir ${shellQuote(T3_HOME)} --ttl 2h --label ${shellQuote(`cloud:${allocation.id}:${allocation.attempt}`)} --json; fi`,
        ].join(" && "),
        timeoutSeconds: 10,
      })
      .pipe(Effect.mapError((error) => failure("registration", error.message)));
    if (controllerCredential.exitCode !== 0) {
      return yield* failure("registration", "The worker pairing credential is unavailable.");
    }
    const credential = yield* decodeControllerCredential(controllerCredential.output).pipe(
      Effect.mapError(() =>
        failure("registration", "The worker controller credential is invalid."),
      ),
    );
    const accessToken =
      "access_token" in credential
        ? credential.access_token
        : yield* HttpClientRequest.post(urlAt(preview.url, "/oauth/token")).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: AuthTokenExchangeGrantType,
              subject_token: credential.credential,
              subject_token_type: AuthEnvironmentBootstrapTokenType,
              requested_token_type: AuthAccessTokenType,
              client_label: `T3 cloud controller ${allocation.id}`,
              client_device_type: "bot",
            }),
            httpClient.execute,
            Effect.timeout("10 seconds"),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthAccessTokenResult)),
            Effect.mapError(() =>
              failure("registration", "The T3 worker did not issue a controller access token."),
            ),
            Effect.map((access) => access.access_token),
          );
    if (!("access_token" in credential)) {
      const encoded = NodeBuffer.Buffer.from(
        encodeAccessCache({ access_token: accessToken }),
      ).toString("base64");
      const persisted = yield* runtimes
        .execute({
          runtimeId: id,
          command: `printf %s "$T3CODE_CONTROLLER_ACCESS_CACHE" | base64 -d > ${shellQuote(`${controllerAccessPath}.tmp`)} && chown cloudagent:cloudagent ${shellQuote(`${controllerAccessPath}.tmp`)} && chmod 0600 ${shellQuote(`${controllerAccessPath}.tmp`)} && mv ${shellQuote(`${controllerAccessPath}.tmp`)} ${shellQuote(controllerAccessPath)}`,
          environment: { T3CODE_CONTROLLER_ACCESS_CACHE: encoded },
          timeoutSeconds: 10,
        })
        .pipe(Effect.mapError((error) => failure("registration", error.message)));
      if (persisted.exitCode !== 0) {
        return yield* failure("registration", "The worker access token could not be persisted.");
      }
    }
    const http = new URL(preview.url);
    http.pathname = "/";
    http.hash = "";
    const ws = new URL(http);
    ws.protocol = "wss:";
    return {
      allocationId: allocation.id,
      attempt: allocation.attempt,
      references: {
        workerId: RunWorkerId.make(`daytona:${id}`),
        environmentId: descriptor.environmentId,
        threadId: allocation.execution.threadId,
      },
      route: {
        httpBaseUrl: http.toString(),
        wsBaseUrl: ws.toString(),
        accessToken,
      },
    };
  });

  const preview: DaytonaWorkerBootstrap["preview"] = Effect.fn("DaytonaWorkerBootstrap.preview")(
    function* ({ allocation, version }) {
      const id = runtimeId(allocation);
      const port =
        version === undefined
          ? undefined
          : cloudEnvironmentRuntimeServices(version.config).find(
              (service) => service.port !== undefined,
            )?.port;
      if (id === undefined || port === undefined) return undefined;
      const issued = yield* runtimes
        .preview({ action: "issue", runtimeId: id, port, expiresInSeconds: 15 * 60 })
        .pipe(Effect.mapError((error) => failure("preview", error.message)));
      return issued?.url;
    },
  );

  const interrupt: DaytonaWorkerBootstrap["interrupt"] = Effect.fn(
    "DaytonaWorkerBootstrap.interrupt",
  )(function* (allocation) {
    const id = runtimeId(allocation);
    if (id === undefined) return;
    yield* runtimes
      .deleteProcess({ runtimeId: id, sessionId: sessionId(allocation, "worker") })
      .pipe(Effect.mapError((error) => failure("worker", error.message)));
  });

  return { prepare, registration, preview, interrupt } satisfies DaytonaWorkerBootstrap;
});
