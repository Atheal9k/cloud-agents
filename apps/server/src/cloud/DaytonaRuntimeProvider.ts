import {
  CloudManagedRuntime,
  DEFAULT_CLOUD_MANAGED_RUNTIME_POLICY,
  type CloudManagedRuntimeLifecycle,
  type CloudManagedRuntimePolicy,
} from "@t3tools/contracts";
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
  type Image,
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
import { daytonaWorkerImage } from "./daytonaWorkerImage.ts";

const LABEL = {
  project: "t3-project",
  allocationId: "t3-allocation-id",
  attempt: "t3-allocation-attempt",
  resourceClass: "t3-resource-class",
  environmentId: "t3-environment-id",
  buildId: "t3-build-id",
  agentId: "t3-agent-id",
  runId: "t3-run-id",
  idleAction: "t3-idle-action",
  idleMinutes: "t3-idle-minutes",
  archiveMinutes: "t3-archive-minutes",
  deleteMinutes: "t3-delete-minutes",
  ttlMinutes: "t3-ttl-minutes",
} as const;

interface DaytonaSandboxClient {
  readonly id: string;
  readonly target: string;
  readonly labels: Record<string, string>;
  readonly state?: string;
  readonly autoStopInterval?: number;
  readonly autoPauseInterval?: number;
  readonly autoArchiveInterval?: number;
  readonly autoDeleteInterval?: number;
  readonly autoDestroyAt?: string;
  readonly createdAt?: string;
  readonly lastActivityAt?: string;
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
  readonly setAutostopInterval: (interval: number) => Promise<void>;
  readonly setAutoPauseInterval: (interval: number) => Promise<void>;
  readonly setAutoArchiveInterval: (interval: number) => Promise<void>;
  readonly setAutoDeleteInterval: (interval: number) => Promise<void>;
  readonly setTtl: (minutes: number) => Promise<void>;
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
      readonly image?: string | Image;
      readonly snapshot?: string;
      readonly user: "root";
      readonly envVars: Record<string, string>;
      readonly labels: Record<string, string>;
      readonly public: false;
      readonly autoStopInterval: number;
      readonly autoPauseInterval: number;
      readonly autoArchiveInterval: number;
      readonly autoDeleteInterval: number;
      readonly ttlMinutes: number;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function processExitPath(sessionId: string): string {
  return `/tmp/t3-process-${encodeURIComponent(sessionId)}.exit`;
}

function wrappedProcessCommand(sessionId: string, command: string): string {
  const status = shellQuote(processExitPath(sessionId));
  return `status=${status}; rm -f "$status"; set +e; ( ${command} ); code=$?; printf %s "$code" > "$status"; exit "$code"`;
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
  const policy = resolvedPolicy(input);
  return {
    [LABEL.project]: config.project,
    [LABEL.allocationId]: input.allocationId,
    [LABEL.attempt]: String(input.attempt),
    [LABEL.resourceClass]: config.resourceClass,
    [LABEL.agentId]: input.agentId,
    [LABEL.runId]: input.runId,
    [LABEL.idleAction]: policy.idle.action,
    [LABEL.idleMinutes]: String(policy.idle.afterMinutes),
    [LABEL.archiveMinutes]: String(policy.archiveAfterMinutes),
    [LABEL.deleteMinutes]: String(policy.deleteAfterMinutes),
    [LABEL.ttlMinutes]: String(policy.maxTtlMinutes),
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

function resolvedPolicy(input: CloudRuntimeCreateInput): CloudManagedRuntimePolicy {
  return input.policy ?? DEFAULT_CLOUD_MANAGED_RUNTIME_POLICY;
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
    const environmentId = sandbox.labels[LABEL.environmentId];
    const buildId = sandbox.labels[LABEL.buildId];
    const idleAction = sandbox.labels[LABEL.idleAction];
    const idleMinutes = sandbox.labels[LABEL.idleMinutes];
    const archiveMinutes = sandbox.labels[LABEL.archiveMinutes];
    const deleteMinutes = sandbox.labels[LABEL.deleteMinutes];
    const ttlMinutes = sandbox.labels[LABEL.ttlMinutes];
    const policy =
      (idleAction === "stop" || idleAction === "pause") &&
      idleMinutes !== undefined &&
      archiveMinutes !== undefined &&
      deleteMinutes !== undefined &&
      ttlMinutes !== undefined
        ? {
            idle: { action: idleAction, afterMinutes: Number(idleMinutes) },
            archiveAfterMinutes: Number(archiveMinutes),
            deleteAfterMinutes: Number(deleteMinutes),
            maxTtlMinutes: Number(ttlMinutes),
          }
        : undefined;
    return yield* decodeRuntime({
      provider: "daytona",
      runtimeId: sandbox.id,
      region: sandbox.target || config.target,
      resourceClass: sandbox.labels[LABEL.resourceClass],
      lifecycleState: lifecycle(sandbox.state),
      ...(environmentId === undefined ? {} : { environmentId }),
      ...(buildId === undefined ? {} : { buildId }),
      agentId: sandbox.labels[LABEL.agentId],
      runId: sandbox.labels[LABEL.runId],
      allocationId: sandbox.labels[LABEL.allocationId],
      attempt: Number(sandbox.labels[LABEL.attempt]),
      ...(policy === undefined ? {} : { policy }),
      ...(sandbox.createdAt === undefined ? {} : { createdAt: sandbox.createdAt }),
      ...(sandbox.lastActivityAt === undefined ? {} : { lastActivityAt: sandbox.lastActivityAt }),
      ...(sandbox.autoDestroyAt === undefined ? {} : { autoDestroyAt: sandbox.autoDestroyAt }),
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

  const requireOwnedSandbox = Effect.fn("DaytonaRuntimeProvider.requireOwnedSandbox")(
    function* (owned: {
      readonly runtimeId: string;
      readonly allocationId: CloudManagedRuntime["allocationId"];
      readonly attempt: CloudManagedRuntime["attempt"];
    }) {
      const sandbox = yield* get(owned.runtimeId);
      const runtime = yield* runtimeFromSandbox(sandbox);
      if (runtime.allocationId !== owned.allocationId || runtime.attempt !== owned.attempt) {
        return yield* providerError(
          "conflict",
          `Daytona sandbox '${owned.runtimeId}' is not owned by allocation '${owned.allocationId}' attempt ${owned.attempt}.`,
        );
      }
      return sandbox;
    },
  );

  const applyPolicy = Effect.fn("DaytonaRuntimeProvider.applyPolicy")(function* (
    sandbox: DaytonaSandboxClient,
    policy: CloudManagedRuntimePolicy,
  ) {
    if (policy.idle.action === "pause") {
      yield* sdk(() => sandbox.setAutostopInterval(0));
      yield* sdk(() => sandbox.setAutoPauseInterval(policy.idle.afterMinutes));
    } else {
      yield* sdk(() => sandbox.setAutoPauseInterval(0));
      yield* sdk(() => sandbox.setAutostopInterval(policy.idle.afterMinutes));
    }
    yield* sdk(() => sandbox.setAutoArchiveInterval(policy.archiveAfterMinutes));
    yield* sdk(() => sandbox.setAutoDeleteInterval(policy.deleteAfterMinutes));
    // Daytona anchors TTL from the setter call. Do not extend the original
    // wall-clock maximum every time a stopped sandbox wakes.
    if (sandbox.autoDestroyAt === undefined) {
      yield* sdk(() => sandbox.setTtl(policy.maxTtlMinutes));
    }
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
      const exitCode =
        command.exitCode ??
        (yield* sdk(() =>
          sandbox.process.executeCommand(
            `test ! -f ${shellQuote(processExitPath(processInput.sessionId))} || cat ${shellQuote(processExitPath(processInput.sessionId))}`,
          ),
        ).pipe(
          Effect.flatMap((result) => {
            const value = result.result.trim();
            if (value.length === 0) return Effect.succeed(undefined);
            const parsed = Number(value);
            return Number.isInteger(parsed)
              ? Effect.succeed(parsed)
              : Effect.fail(
                  providerError(
                    "fatal",
                    `Daytona process session '${processInput.sessionId}' returned an invalid exit status.`,
                  ),
                );
          }),
        ));
      if (exitCode === undefined) {
        return {
          status: "running",
          sessionId: processInput.sessionId,
          commandId: command.id,
          command: command.command,
          output,
        };
      }
      return {
        status: exitCode === 0 ? "succeeded" : "failed",
        sessionId: processInput.sessionId,
        commandId: command.id,
        command: command.command,
        exitCode,
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
            ...(createInput.snapshotId === undefined
              ? { image: daytonaWorkerImage() }
              : { snapshot: createInput.snapshotId }),
            user: "root",
            envVars: { ...createInput.environmentVariables },
            labels: labelsFor(config, createInput),
            public: false,
            autoStopInterval:
              resolvedPolicy(createInput).idle.action === "stop"
                ? resolvedPolicy(createInput).idle.afterMinutes
                : 0,
            autoPauseInterval:
              resolvedPolicy(createInput).idle.action === "pause"
                ? resolvedPolicy(createInput).idle.afterMinutes
                : 0,
            autoArchiveInterval: resolvedPolicy(createInput).archiveAfterMinutes,
            autoDeleteInterval: resolvedPolicy(createInput).deleteAfterMinutes,
            ttlMinutes: resolvedPolicy(createInput).maxTtlMinutes,
          },
          { timeout: 60 },
        ),
      );
      // Daytona's create response can omit labels even though the persisted sandbox has them.
      // Re-read before decoding ownership so we never reject a sandbox we just created.
      return yield* runtimeFromSandbox(yield* get(sandbox.id));
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
            const observed = yield* runtimeFromSandbox(sandbox);
            if (
              observed.allocationId !== assignment.allocationId ||
              observed.attempt > assignment.attempt
            ) {
              return yield* providerError(
                "conflict",
                `Daytona sandbox '${startInput.runtimeId}' is not owned by this allocation attempt.`,
              );
            }
            yield* sdk(() => sandbox.setLabels(labelsFor(config, assignment)));
            yield* sdk(() => sandbox.updateEnv({ ...assignment.environmentVariables }));
            yield* applyPolicy(sandbox, resolvedPolicy(assignment));
          }
          const state = lifecycle(sandbox.state);
          if (state !== "starting" && state !== "started") yield* sdk(() => sandbox.start());
          return yield* runtimeFromSandbox(yield* get(startInput.runtimeId));
        }),
      stop: (owned) =>
        Effect.gen(function* () {
          const sandbox = yield* requireOwnedSandbox(owned);
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
          return yield* runtimeFromSandbox(yield* get(owned.runtimeId));
        }).pipe(Effect.withSpan("DaytonaRuntimeProvider.stop")),
      archive: (owned) =>
        Effect.gen(function* () {
          const sandbox = yield* requireOwnedSandbox(owned);
          const state = lifecycle(sandbox.state);
          if (
            state !== "archiving" &&
            state !== "archived" &&
            state !== "deleting" &&
            state !== "deleted"
          ) {
            yield* sdk(() => sandbox.archive());
          }
          return yield* runtimeFromSandbox(yield* get(owned.runtimeId));
        }).pipe(Effect.withSpan("DaytonaRuntimeProvider.archive")),
      delete: (owned) =>
        Effect.gen(function* () {
          const sandbox = yield* requireOwnedSandbox(owned).pipe(
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
          const command = wrappedProcessCommand(processInput.sessionId, processInput.command);
          const observed = yield* inspectProcess(processInput);
          if (observed.status !== "missing") {
            if (observed.command !== command) {
              return yield* providerError(
                "conflict",
                `Daytona process session '${processInput.sessionId}' contains an unexpected command.`,
              );
            }
            return { ...observed, command: processInput.command };
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
              command,
              runAsync: true,
              suppressInputEcho: true,
            }),
          ).pipe(Effect.result);
          const recovered = yield* inspectProcess(processInput);
          if (recovered.status !== "missing") {
            if (recovered.command !== command) {
              return yield* providerError(
                "conflict",
                `Daytona process session '${processInput.sessionId}' contains an unexpected command.`,
              );
            }
            return { ...recovered, command: processInput.command };
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
    create: (params, options) =>
      params.image === undefined
        ? daytona.create(params, options)
        : daytona.create({ ...params, image: params.image }, options),
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
