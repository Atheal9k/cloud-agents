import { CloudManagedRuntime, type CloudManagedRuntimeLifecycle } from "@t3tools/contracts";
import {
  Daytona,
  DaytonaAuthenticationError,
  DaytonaBadGatewayError,
  DaytonaBadRequestError,
  DaytonaConflictError,
  DaytonaConnectionError,
  DaytonaForbiddenError,
  DaytonaGoneError,
  DaytonaInternalServerError,
  DaytonaInvalidArgumentError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaServiceUnavailableError,
  DaytonaTimeoutError,
  DaytonaUnprocessableEntityError,
} from "@daytona/sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  CloudRuntimeProvider,
  CloudRuntimeProviderError,
  type CloudRuntimeCreateInput,
  type CloudRuntimeProcess,
} from "./CloudRuntimeProvider.ts";
import {
  DaytonaConfigError,
  resolveDaytonaConfig,
  type ResolvedDaytonaConfig,
} from "./daytonaConfig.ts";

const LABEL = {
  project: "t3-project",
  allocationId: "t3-allocation-id",
  attempt: "t3-allocation-attempt",
  resourceClass: "t3-resource-class",
  environmentId: "t3-environment-id",
  buildId: "t3-build-id",
  agentId: "t3-agent-id",
  runId: "t3-run-id",
} as const;

interface DaytonaSandboxClient {
  readonly id: string;
  readonly target: string;
  readonly labels: Record<string, string>;
  readonly state?: string;
  readonly process: {
    readonly executeCommand: (
      command: string,
      cwd?: string,
      environment?: Record<string, string>,
      timeoutSeconds?: number,
    ) => Promise<{ readonly exitCode: number; readonly result: string }>;
    readonly createSession: (sessionId: string) => Promise<void>;
    readonly getSession: (sessionId: string) => Promise<{
      readonly sessionId: string;
      readonly commands: ReadonlyArray<{
        readonly id: string;
        readonly command: string;
        readonly exitCode?: number;
      }>;
    }>;
    readonly executeSessionCommand: (
      sessionId: string,
      request: {
        readonly command: string;
        readonly runAsync: true;
        readonly suppressInputEcho: true;
      },
    ) => Promise<{ readonly cmdId: string }>;
    readonly getSessionCommandLogs: (
      sessionId: string,
      commandId: string,
    ) => Promise<{ readonly output?: string; readonly stdout?: string; readonly stderr?: string }>;
    readonly deleteSession: (sessionId: string) => Promise<void>;
  };
  readonly computerUse: {
    readonly start: () => Promise<{ readonly status?: unknown; readonly message?: string }>;
    readonly stop: () => Promise<{ readonly status?: unknown; readonly message?: string }>;
    readonly getStatus: () => Promise<{ readonly status?: unknown }>;
  };
  readonly start: (timeoutSeconds?: number) => Promise<void>;
  readonly stop: (timeoutSeconds?: number, force?: boolean) => Promise<void>;
  readonly archive: () => Promise<void>;
  readonly setLabels: (labels: Record<string, string>) => Promise<Record<string, string>>;
  readonly updateEnv: (environment: Record<string, string>) => Promise<void>;
  readonly delete: (timeoutSeconds?: number, wait?: boolean) => Promise<void>;
  readonly createSnapshot: (name: string, timeoutSeconds?: number) => Promise<void>;
  readonly getSignedPreviewUrl: (
    port: number,
    expiresInSeconds?: number,
  ) => Promise<{ readonly url: string; readonly token: string }>;
  readonly expireSignedPreviewUrl: (port: number, token: string) => Promise<void>;
}

interface DaytonaClient {
  readonly create: (
    params: {
      readonly snapshot?: string;
      readonly envVars: Record<string, string>;
      readonly labels: Record<string, string>;
      readonly public: false;
      readonly autoStopInterval: number;
      readonly autoArchiveInterval: number;
      readonly autoDeleteInterval: number;
    },
    options: { readonly timeout: number },
  ) => Promise<DaytonaSandboxClient>;
  readonly get: (runtimeId: string) => Promise<DaytonaSandboxClient>;
  readonly list: (query: {
    readonly labels: Record<string, string>;
  }) => AsyncIterableIterator<DaytonaSandboxClient>;
}

const decodeRuntime = Schema.decodeUnknownEffect(CloudManagedRuntime);

function providerError(
  reason: CloudRuntimeProviderError["reason"],
  message: string,
): CloudRuntimeProviderError {
  return new CloudRuntimeProviderError({ reason, message });
}

function safeMessage(error: unknown, config: ResolvedDaytonaConfig): string {
  const message = error instanceof Error ? error.message : "Daytona returned an unknown error.";
  return config.apiKey === undefined ? message : message.replaceAll(config.apiKey, "[redacted]");
}

function classifyError(error: unknown, config: ResolvedDaytonaConfig): CloudRuntimeProviderError {
  const message = safeMessage(error, config);
  if (error instanceof DaytonaAuthenticationError || error instanceof DaytonaForbiddenError) {
    return providerError("unauthenticated", message);
  }
  if (error instanceof DaytonaRateLimitError || /quota|limit exceeded/i.test(message)) {
    return providerError("quota", message);
  }
  if (/capacity|no runner|insufficient resource/i.test(message)) {
    return providerError("capacity", message);
  }
  if (error instanceof DaytonaNotFoundError || error instanceof DaytonaGoneError)
    return providerError("not-found", message);
  if (error instanceof DaytonaConflictError) return providerError("conflict", message);
  if (
    error instanceof DaytonaConnectionError ||
    error instanceof DaytonaTimeoutError ||
    error instanceof DaytonaBadGatewayError ||
    error instanceof DaytonaServiceUnavailableError ||
    error instanceof DaytonaInternalServerError
  ) {
    return providerError("provider-outage", message);
  }
  if (
    error instanceof DaytonaInvalidArgumentError ||
    error instanceof DaytonaBadRequestError ||
    error instanceof DaytonaUnprocessableEntityError
  ) {
    return providerError("invalid-config", message);
  }
  return providerError("fatal", message);
}

function lifecycle(state: string | undefined): CloudManagedRuntimeLifecycle {
  switch (state) {
    case "creating":
    case "restoring":
    case "pending_build":
    case "building_snapshot":
    case "pulling_snapshot":
    case "snapshotting":
    case "forking":
    case "resizing":
      return "creating";
    case "starting":
    case "resuming":
      return "starting";
    case "started":
      return "started";
    case "stopping":
    case "pausing":
      return "stopping";
    case "stopped":
    case "paused":
      return "stopped";
    case "archiving":
      return "archiving";
    case "archived":
      return "archived";
    case "destroying":
      return "deleting";
    case "destroyed":
      return "deleted";
    case "error":
    case "build_failed":
      return "error";
    case "unknown":
    case "11184809":
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

function labelsFor(config: ResolvedDaytonaConfig, input: CloudRuntimeCreateInput) {
  return {
    [LABEL.project]: config.project,
    [LABEL.allocationId]: input.allocationId,
    [LABEL.attempt]: String(input.attempt),
    [LABEL.resourceClass]: config.resourceClass,
    [LABEL.agentId]: input.agentId,
    [LABEL.runId]: input.runId,
    ...(input.environmentId === undefined ? {} : { [LABEL.environmentId]: input.environmentId }),
    ...(input.buildId === undefined ? {} : { [LABEL.buildId]: input.buildId }),
  };
}

function assignmentMatches(runtime: CloudManagedRuntime, input: CloudRuntimeCreateInput): boolean {
  return (
    runtime.allocationId === input.allocationId &&
    runtime.attempt === input.attempt &&
    runtime.agentId === input.agentId &&
    runtime.runId === input.runId &&
    runtime.environmentId === input.environmentId &&
    runtime.buildId === input.buildId
  );
}

export const make = Effect.fn("DaytonaRuntimeProvider.make")(function (input: {
  readonly config: ResolvedDaytonaConfig;
  readonly client?: DaytonaClient;
}) {
  const { config } = input;

  const requireClient = Effect.fn("DaytonaRuntimeProvider.requireClient")(function* () {
    if (config.admission === "disabled") {
      return yield* providerError("disabled", "Managed cloud runtime admission is disabled.");
    }
    if (config.apiKey === undefined) {
      return yield* providerError(
        "unauthenticated",
        "DAYTONA_API_KEY is required before a managed cloud run can start.",
      );
    }
    if (input.client === undefined) {
      return yield* providerError("fatal", "The Daytona client is unavailable.");
    }
    return input.client;
  });

  const sdk = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (error) => classifyError(error, config),
    });

  const runtimeFromSandbox = Effect.fn("DaytonaRuntimeProvider.runtimeFromSandbox")(function* (
    sandbox: DaytonaSandboxClient,
  ) {
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    return yield* decodeRuntime({
      provider: "daytona",
      runtimeId: sandbox.id,
      region: sandbox.target || config.target,
      resourceClass: sandbox.labels[LABEL.resourceClass],
      lifecycleState: lifecycle(sandbox.state),
      environmentId: sandbox.labels[LABEL.environmentId],
      buildId: sandbox.labels[LABEL.buildId],
      agentId: sandbox.labels[LABEL.agentId],
      runId: sandbox.labels[LABEL.runId],
      allocationId: sandbox.labels[LABEL.allocationId],
      attempt: Number(sandbox.labels[LABEL.attempt]),
      observedAt,
    }).pipe(
      Effect.mapError(() =>
        providerError(
          "fatal",
          `Daytona sandbox '${sandbox.id}' has incomplete T3 ownership labels.`,
        ),
      ),
    );
  });

  const listRaw = Effect.fn("DaytonaRuntimeProvider.listRaw")(function* (
    labels: Record<string, string>,
  ) {
    const client = yield* requireClient();
    return yield* sdk(async () => {
      const sandboxes: DaytonaSandboxClient[] = [];
      for await (const sandbox of client.list({ labels })) sandboxes.push(sandbox);
      return sandboxes;
    });
  });

  const get = Effect.fn("DaytonaRuntimeProvider.get")(function* (runtimeId: string) {
    const client = yield* requireClient();
    return yield* sdk(() => client.get(runtimeId));
  });

  const inspect: CloudRuntimeProvider["Service"]["inspect"] = (locator) =>
    Effect.gen(function* () {
      if (locator.kind === "id") {
        const sandbox = yield* get(locator.runtimeId).pipe(
          Effect.catchIf(
            (error) => error.reason === "not-found",
            () => Effect.void,
          ),
        );
        return sandbox === undefined ? undefined : yield* runtimeFromSandbox(sandbox);
      }
      const matches = yield* listRaw({
        [LABEL.project]: config.project,
        [LABEL.allocationId]: locator.allocationId,
        [LABEL.attempt]: String(locator.attempt),
      });
      if (matches.length > 1) {
        return yield* providerError(
          "conflict",
          `Daytona returned ${matches.length} sandboxes for one allocation attempt.`,
        );
      }
      const sandbox = matches[0];
      return sandbox === undefined ? undefined : yield* runtimeFromSandbox(sandbox);
    });

  const list: CloudRuntimeProvider["Service"]["list"] = () =>
    Effect.gen(function* () {
      const sandboxes = yield* listRaw({ [LABEL.project]: config.project });
      return yield* Effect.forEach(sandboxes, runtimeFromSandbox);
    });

  const inspectProcess = Effect.fn("DaytonaRuntimeProvider.inspectProcess")(
    function* (processInput: {
      readonly runtimeId: string;
      readonly sessionId: string;
    }): Effect.fn.Return<CloudRuntimeProcess, CloudRuntimeProviderError> {
      const sandbox = yield* get(processInput.runtimeId);
      const session = yield* sdk(() => sandbox.process.getSession(processInput.sessionId)).pipe(
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.void,
        ),
      );
      if (session === undefined) {
        return { status: "missing", sessionId: processInput.sessionId };
      }
      if (session.commands.length > 1) {
        return yield* providerError(
          "conflict",
          `Daytona process session '${processInput.sessionId}' contains more than one command.`,
        );
      }
      const command = session.commands[0];
      if (command === undefined) {
        return { status: "missing", sessionId: processInput.sessionId };
      }
      const logs = yield* sdk(() =>
        sandbox.process.getSessionCommandLogs(processInput.sessionId, command.id),
      );
      const output = logs.output ?? [logs.stdout, logs.stderr].filter(Boolean).join("\n");
      if (command.exitCode === undefined) {
        return {
          status: "running",
          sessionId: processInput.sessionId,
          commandId: command.id,
          command: command.command,
          output,
        };
      }
      return {
        status: command.exitCode === 0 ? "succeeded" : "failed",
        sessionId: processInput.sessionId,
        commandId: command.id,
        command: command.command,
        exitCode: command.exitCode,
        output,
      };
    },
  );

  const create: CloudRuntimeProvider["Service"]["create"] = (createInput) =>
    Effect.gen(function* () {
      const existing = yield* inspect({
        kind: "allocation-attempt",
        allocationId: createInput.allocationId,
        attempt: createInput.attempt,
      });
      if (existing !== undefined) {
        if (assignmentMatches(existing, createInput)) return existing;
        return yield* providerError(
          "conflict",
          `Daytona sandbox '${existing.runtimeId}' belongs to a different T3 agent assignment.`,
        );
      }
      const client = yield* requireClient();
      const sandbox = yield* sdk(() =>
        client.create(
          {
            ...(createInput.snapshotId === undefined ? {} : { snapshot: createInput.snapshotId }),
            envVars: { ...createInput.environmentVariables },
            labels: labelsFor(config, createInput),
            public: false,
            autoStopInterval: 0,
            autoArchiveInterval: 0,
            autoDeleteInterval: -1,
          },
          { timeout: 60 },
        ),
      );
      return yield* runtimeFromSandbox(sandbox);
    });

  const readiness: CloudRuntimeProvider["Service"]["readiness"] = () =>
    Effect.gen(function* () {
      if (config.admission === "disabled") {
        return {
          provider: "daytona",
          admission: "disabled",
          authentication: config.apiKey === undefined ? "missing" : "configured",
          reachability: "unchecked",
          region: config.target,
          resourceClass: config.resourceClass,
          observedSandboxes: 0,
          readySandboxes: 0,
          detail: "Managed runtime admission is disabled.",
        } as const;
      }
      if (config.apiKey === undefined) {
        return {
          provider: "daytona",
          admission: "enabled",
          authentication: "missing",
          reachability: "unchecked",
          region: config.target,
          resourceClass: config.resourceClass,
          observedSandboxes: 0,
          readySandboxes: 0,
          detail: "DAYTONA_API_KEY is not configured on the controller.",
        } as const;
      }
      const observed = yield* list().pipe(Effect.result);
      if (observed._tag === "Failure") {
        return {
          provider: "daytona",
          admission: "enabled",
          authentication: observed.failure.reason === "unauthenticated" ? "invalid" : "configured",
          reachability: "unreachable",
          region: config.target,
          resourceClass: config.resourceClass,
          observedSandboxes: 0,
          readySandboxes: 0,
          detail: observed.failure.message,
        } as const;
      }
      return {
        provider: "daytona",
        admission: "enabled",
        authentication: "configured",
        reachability: "reachable",
        region: config.target,
        resourceClass: config.resourceClass,
        observedSandboxes: observed.success.length,
        readySandboxes: observed.success.filter((runtime) => runtime.lifecycleState === "started")
          .length,
        detail: `Daytona returned ${observed.success.length} T3 sandbox${observed.success.length === 1 ? "" : "es"}.`,
      } as const;
    });

  return Effect.succeed(
    CloudRuntimeProvider.of({
      readiness,
      create,
      inspect,
      list,
      start: (startInput) =>
        Effect.gen(function* () {
          const sandbox = yield* get(startInput.runtimeId);
          const assignment = startInput.assignment;
          if (assignment !== undefined) {
            yield* sdk(() => sandbox.setLabels(labelsFor(config, assignment)));
            yield* sdk(() => sandbox.updateEnv({ ...assignment.environmentVariables }));
          }
          const state = lifecycle(sandbox.state);
          if (state !== "starting" && state !== "started") yield* sdk(() => sandbox.start());
          return yield* runtimeFromSandbox(yield* get(startInput.runtimeId));
        }),
      stop: (runtimeId) =>
        Effect.gen(function* () {
          const sandbox = yield* get(runtimeId);
          const state = lifecycle(sandbox.state);
          if (
            state !== "stopping" &&
            state !== "stopped" &&
            state !== "archiving" &&
            state !== "archived" &&
            state !== "deleting" &&
            state !== "deleted"
          ) {
            yield* sdk(() => sandbox.stop());
          }
          return yield* runtimeFromSandbox(yield* get(runtimeId));
        }).pipe(Effect.withSpan("DaytonaRuntimeProvider.stop")),
      archive: (runtimeId) =>
        Effect.gen(function* () {
          const sandbox = yield* get(runtimeId);
          const state = lifecycle(sandbox.state);
          if (
            state !== "archiving" &&
            state !== "archived" &&
            state !== "deleting" &&
            state !== "deleted"
          ) {
            yield* sdk(() => sandbox.archive());
          }
          return yield* runtimeFromSandbox(yield* get(runtimeId));
        }).pipe(Effect.withSpan("DaytonaRuntimeProvider.archive")),
      delete: (runtimeId) =>
        Effect.gen(function* () {
          const sandbox = yield* get(runtimeId).pipe(
            Effect.catchIf(
              (error) => error.reason === "not-found",
              () => Effect.void,
            ),
          );
          if (sandbox === undefined) return;
          const state = lifecycle(sandbox.state);
          if (state === "deleting" || state === "deleted") return;
          yield* sdk(() => sandbox.delete(60, true));
        }),
      execute: (executeInput) =>
        Effect.gen(function* () {
          const sandbox = yield* get(executeInput.runtimeId);
          const response = yield* sdk(() =>
            sandbox.process.executeCommand(
              executeInput.command,
              executeInput.cwd,
              executeInput.environment === undefined ? undefined : { ...executeInput.environment },
              executeInput.timeoutSeconds,
            ),
          );
          return { exitCode: response.exitCode, output: response.result };
        }),
      ensureProcess: (processInput) =>
        Effect.gen(function* () {
          const observed = yield* inspectProcess(processInput);
          if (observed.status !== "missing") {
            if (observed.command !== processInput.command) {
              return yield* providerError(
                "conflict",
                `Daytona process session '${processInput.sessionId}' contains an unexpected command.`,
              );
            }
            return observed;
          }
          const sandbox = yield* get(processInput.runtimeId);
          yield* sdk(() => sandbox.process.createSession(processInput.sessionId)).pipe(
            Effect.catchIf(
              (error) => error.reason === "conflict",
              () => Effect.void,
            ),
          );
          const started = yield* sdk(() =>
            sandbox.process.executeSessionCommand(processInput.sessionId, {
              command: processInput.command,
              runAsync: true,
              suppressInputEcho: true,
            }),
          ).pipe(Effect.result);
          const recovered = yield* inspectProcess(processInput);
          if (recovered.status !== "missing") {
            if (recovered.command !== processInput.command) {
              return yield* providerError(
                "conflict",
                `Daytona process session '${processInput.sessionId}' contains an unexpected command.`,
              );
            }
            return recovered;
          }
          if (started._tag === "Failure") return yield* started.failure;
          return {
            status: "running",
            sessionId: processInput.sessionId,
            commandId: started.success.cmdId,
            command: processInput.command,
            output: "",
          } as const;
        }),
      inspectProcess,
      deleteProcess: (processInput) =>
        Effect.gen(function* () {
          const sandbox = yield* get(processInput.runtimeId);
          yield* sdk(() => sandbox.process.deleteSession(processInput.sessionId)).pipe(
            Effect.catchIf(
              (error) => error.reason === "not-found",
              () => Effect.void,
            ),
          );
        }),
      preview: (previewInput) =>
        Effect.gen(function* () {
          const sandbox = yield* get(previewInput.runtimeId);
          if (previewInput.action === "revoke") {
            yield* sdk(() => sandbox.expireSignedPreviewUrl(previewInput.port, previewInput.token));
            return undefined;
          }
          return yield* sdk(() =>
            sandbox.getSignedPreviewUrl(previewInput.port, previewInput.expiresInSeconds),
          );
        }),
      snapshot: (snapshotInput) =>
        Effect.gen(function* () {
          const sandbox = yield* get(snapshotInput.runtimeId);
          yield* sdk(() => sandbox.createSnapshot(snapshotInput.name));
          return { name: snapshotInput.name };
        }),
      desktop: (desktopInput) =>
        Effect.gen(function* () {
          const sandbox = yield* get(desktopInput.runtimeId);
          if (desktopInput.action === "status") {
            const result = yield* sdk(() => sandbox.computerUse.getStatus());
            return { status: typeof result.status === "string" ? result.status : "running" };
          }
          const result = yield* sdk(() =>
            desktopInput.action === "start"
              ? sandbox.computerUse.start()
              : sandbox.computerUse.stop(),
          );
          return {
            status:
              typeof result.status === "string"
                ? result.status
                : (result.message ?? desktopInput.action),
          };
        }),
      resourceClass: config.resourceClass,
    }),
  );
});

function makeSdkClient(config: ResolvedDaytonaConfig): DaytonaClient | undefined {
  if (config.apiKey === undefined || config.admission === "disabled") return undefined;
  const daytona = new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    target: config.target,
  });
  return {
    create: (params, options) => daytona.create(params, options),
    get: (runtimeId) => daytona.get(runtimeId),
    list: (query) => daytona.list(query),
  };
}

export const layer = Layer.effect(
  CloudRuntimeProvider,
  Effect.gen(function* () {
    const config = yield* resolveDaytonaConfig().pipe(
      Effect.mapError((error: DaytonaConfigError) =>
        providerError("invalid-config", error.message),
      ),
    );
    const client = makeSdkClient(config);
    return yield* make({ config, ...(client === undefined ? {} : { client }) });
  }),
);
