/**
 * Per-boot `start` and named terminals for an environment version. `install`
 * stays on the Build; this path never re-runs it. Health and logs are recorded
 * while the processes are still in the caller's scope.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as ChildProcess from "node:child_process";
import * as Net from "node:net";
import {
  type CloudEnvironmentRuntimeBootRecord,
  type CloudEnvironmentRuntimeService,
  type CloudEnvironmentRuntimeServiceHealth,
  type CloudEnvironmentVersion,
  cloudEnvironmentRuntimeServices,
  injectCloudEnvironmentSecrets,
  missingCloudEnvironmentSecrets,
  redactCloudEnvironmentSecretOutput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

const MAX_LOG_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_HEALTH_CHECK_MS = 1_500;

export class CloudEnvironmentRuntimeBootError extends Schema.TaggedError<CloudEnvironmentRuntimeBootError>()(
  "CloudEnvironmentRuntimeBootError",
  {
    reason: Schema.Literals(["secret-unavailable", "spawn-failed", "filesystem-failed"]),
    message: Schema.String,
  },
) {}

export class CloudEnvironmentRuntimeBoot extends Context.Service<
  CloudEnvironmentRuntimeBoot,
  {
    readonly boot: (input: {
      readonly version: CloudEnvironmentVersion;
      readonly cwd: string;
      readonly occurredAt: string;
      readonly secretValues?: Readonly<Record<string, string>>;
      readonly healthCheckMs?: number;
    }) => Effect.Effect<
      CloudEnvironmentRuntimeBootRecord,
      CloudEnvironmentRuntimeBootError,
      Scope.Scope
    >;
  }
>()("t3/cloud/CloudEnvironmentRuntimeBoot") {}

function bootError(
  reason: CloudEnvironmentRuntimeBootError["reason"],
  message: string,
): CloudEnvironmentRuntimeBootError {
  return new CloudEnvironmentRuntimeBootError({ reason, message });
}

function serviceScript(command: string, platform: string): string {
  return platform === "win32" ? `@echo off\r\n${command}\r\n` : `set -e\n${command}\n`;
}

function portOpen(port: number): Effect.Effect<boolean> {
  return Effect.callback<boolean>((resume) => {
    const socket = Net.connect({ port, host: "127.0.0.1" }, () => {
      socket.end();
      resume(Effect.succeed(true));
    });
    socket.on("error", () => resume(Effect.succeed(false)));
  });
}

export const make = Effect.fn("CloudEnvironmentRuntimeBoot.make")(function* (input?: {
  readonly healthCheckMs?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const healthCheckMs = input?.healthCheckMs ?? DEFAULT_HEALTH_CHECK_MS;

  const boot: CloudEnvironmentRuntimeBoot["Service"]["boot"] = Effect.fn(
    "CloudEnvironmentRuntimeBoot.boot",
  )(function* (request): Effect.fn.Return<
    CloudEnvironmentRuntimeBootRecord,
    CloudEnvironmentRuntimeBootError,
    Scope.Scope
  > {
    const secretValues = request.secretValues ?? {};
    const missing = missingCloudEnvironmentSecrets({
      phase: "runtime",
      secrets: request.version.secretReferences,
      values: secretValues,
    });
    if (missing.length > 0) {
      return yield* bootError(
        "secret-unavailable",
        `Runtime secret '${missing[0]!.name}' is unavailable.`,
      );
    }
    const injected = injectCloudEnvironmentSecrets({
      phase: "runtime",
      secrets: request.version.secretReferences,
      values: secretValues,
    });
    const services = cloudEnvironmentRuntimeServices(request.version.config);
    const scriptsRoot = path.join(request.cwd, ".t3-runtime-boot");
    yield* fs
      .makeDirectory(scriptsRoot, { recursive: true })
      .pipe(
        Effect.mapError(() =>
          bootError("filesystem-failed", "The runtime could not write its boot scripts."),
        ),
      );
    yield* Effect.addFinalizer(() =>
      fs.remove(scriptsRoot, { recursive: true, force: true }).pipe(Effect.ignore),
    );

    const health: Array<CloudEnvironmentRuntimeServiceHealth> = [];
    for (const service of services) {
      health.push(
        yield* startService({
          service,
          cwd: request.cwd,
          scriptsRoot,
          secretEnv: injected.env,
          redact: injected.redact,
          occurredAt: request.occurredAt,
          healthCheckMs: request.healthCheckMs ?? healthCheckMs,
        }),
      );
    }
    return { services: health };
  });

  const startService = Effect.fn("CloudEnvironmentRuntimeBoot.startService")(function* (request: {
    readonly service: CloudEnvironmentRuntimeService;
    readonly cwd: string;
    readonly scriptsRoot: string;
    readonly secretEnv: Readonly<Record<string, string>>;
    readonly redact: ReadonlyArray<string>;
    readonly occurredAt: string;
    readonly healthCheckMs: number;
  }): Effect.fn.Return<
    CloudEnvironmentRuntimeServiceHealth,
    CloudEnvironmentRuntimeBootError,
    Scope.Scope
  > {
    const startedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const scriptPath = path.join(
      request.scriptsRoot,
      `${request.service.kind}-${request.service.name}.${platform === "win32" ? "cmd" : "sh"}`,
    );
    yield* fs
      .writeFileString(scriptPath, serviceScript(request.service.command, platform))
      .pipe(
        Effect.mapError(() =>
          bootError("filesystem-failed", `The runtime could not write '${request.service.name}'.`),
        ),
      );
    const spawn =
      platform === "win32"
        ? { command: "cmd.exe", args: ["/d", "/s", "/c", scriptPath] }
        : { command: "/bin/sh", args: [scriptPath] };
    const child = yield* Effect.try({
      try: () =>
        ChildProcess.spawn(spawn.command, spawn.args, {
          cwd: request.cwd,
          env: { ...process.env, CI: "1", ...request.secretEnv },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      catch: () =>
        bootError("spawn-failed", `The runtime could not start '${request.service.name}'.`),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }),
    );

    yield* Effect.sleep(Duration.millis(request.healthCheckMs));
    const completedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const stillRunning = child.exitCode === null && child.signalCode === null;
    let portHealthy = true;
    if (request.service.port !== undefined) {
      portHealthy = yield* portOpen(request.service.port);
    }
    const healthy = stillRunning && portHealthy;
    const clipped = (value: string) =>
      value.length > MAX_LOG_OUTPUT_BYTES
        ? `${value.slice(0, MAX_LOG_OUTPUT_BYTES)}\n[output truncated]`
        : value;
    const message = !stillRunning
      ? `'${request.service.name}' exited before it became healthy.`
      : !portHealthy
        ? `'${request.service.name}' did not listen on port ${request.service.port}.`
        : `'${request.service.name}' is running.`;
    return {
      name: request.service.name,
      kind: request.service.kind,
      status: healthy ? "healthy" : "unhealthy",
      ...(request.service.port === undefined ? {} : { port: request.service.port }),
      message,
      log: {
        name: request.service.name,
        command: spawn.command,
        args: spawn.args,
        startedAt,
        completedAt,
        exitCode: child.exitCode,
        timedOut: false,
        stdout: redactCloudEnvironmentSecretOutput(clipped(stdout), request.redact),
        stderr: redactCloudEnvironmentSecretOutput(clipped(stderr), request.redact),
        stdoutTruncated: stdout.length > MAX_LOG_OUTPUT_BYTES,
        stderrTruncated: stderr.length > MAX_LOG_OUTPUT_BYTES,
      },
    };
  });

  return CloudEnvironmentRuntimeBoot.of({ boot });
});

export const layer = Layer.effect(CloudEnvironmentRuntimeBoot, make());
