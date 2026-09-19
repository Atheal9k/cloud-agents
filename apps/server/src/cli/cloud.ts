/**
 * `t3 cloud` - inspect and hand over a controller's state directory.
 *
 * These commands open the controller's SQLite state directly and refuse to run
 * while its server is up. That is the point: the cutover from a local
 * controller to a permanent host has to fence the state it is about to copy,
 * and a fence written after the backup would not be in the copy.
 */
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";

import * as CloudAllocationController from "../cloud/CloudAllocationController.ts";
import * as ControllerSettings from "../cloud/controllerSettings.ts";
import * as ServerConfig from "../config.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class ControllerStateInUseError extends Schema.TaggedError<ControllerStateInUseError>()(
  "ControllerStateInUseError",
  { pid: Schema.Int, origin: Schema.String },
) {
  override get message(): string {
    return `A T3 server (pid ${String(this.pid)}, ${this.origin}) is still using this state directory. Stop it first so exactly one process owns the controller catalog.`;
  }
}

export class ControllerNotDrainedError extends Schema.TaggedError<ControllerNotDrainedError>()(
  "ControllerNotDrainedError",
  { allocationIds: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return [
      "These cloud allocations have not finished cleanup yet:",
      ...this.allocationIds.map((id) => `  ${id}`),
      "Stop admission, let them reach cleanup, then fence again. In-flight worker processes do not migrate.",
    ].join("\n");
  }
}

export class ControllerAlreadyFencedError extends Schema.TaggedError<ControllerAlreadyFencedError>()(
  "ControllerAlreadyFencedError",
  { fencedAt: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `This controller state was already fenced at ${this.fencedAt}: ${this.reason}`;
  }
}

const reasonFlag = Flag.string("reason").pipe(
  Flag.withDescription("Why this state is being handed over. Shown to clients of a fenced copy."),
  Flag.withDefault("This controller state was fenced for a cutover to another host."),
);

/**
 * A stale state file whose process is gone is not a live writer, so only a
 * running pid blocks these commands.
 */
const requireStoppedServer = Effect.fn("cloud.requireStoppedServer")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(state) || !isProcessAlive(state.value.pid)) return;
  return yield* new ControllerStateInUseError({
    pid: state.value.pid,
    origin: state.value.origin,
  });
});

const withControllerState = <A, E, R>(
  config: ServerConfig.ServerConfig["Service"],
  run: Effect.Effect<A, E, R>,
) =>
  run.pipe(
    Effect.provide(
      SqlitePersistenceLayerLive.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );

/** A controller opened for inspection, independent of whether the server that
    owns this directory was started with `--cloud-controller`. */
const openController = (config: ServerConfig.ServerConfig["Service"]) =>
  CloudAllocationController.make({
    enabled: true,
    mode: config.cloudControllerMode ?? "local",
  });

const resolveCloudCliConfig = Effect.fn("cloud.resolveCloudCliConfig")(function* (flags: {
  readonly baseDir: Option.Option<string>;
}) {
  const cliLogLevel = yield* GlobalFlag.LogLevel;
  // Migration and storage chatter would otherwise bury the one line an
  // operator running a cutover step needs to read.
  const logLevel = Option.getOrElse(cliLogLevel, () => "Warn" as const);
  return yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, Option.some(logLevel));
});

const statusCommand = Command.make("status", { ...projectLocationFlags }).pipe(
  Command.withDescription("Show the cloud controller state stored in a T3 data directory."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCloudCliConfig(flags);
      const snapshot = yield* withControllerState(
        config,
        Effect.flatMap(openController(config), (controller) => controller.snapshot),
      );
      const writability = snapshot.controller.writability ?? { status: "writable" as const };
      const undrained = snapshot.allocations.filter(
        (allocation) => allocation.cleanupState.status !== "succeeded",
      );
      yield* Console.log(
        [
          `State directory: ${config.baseDir}`,
          `Mode: ${snapshot.controller.mode} (requires this host online: ${String(snapshot.controller.requiresHostOnline)})`,
          `Writability: ${
            writability.status === "writable"
              ? "writable"
              : `fenced at ${writability.fencedAt} - ${writability.reason}`
          }`,
          `Admission: ${snapshot.controller.admission.status}`,
          `Agents: ${String(snapshot.agents?.length ?? 0)}`,
          `Runs: ${String(snapshot.runs?.length ?? 0)}`,
          `Environments: ${String(snapshot.environments?.length ?? 0)}`,
          `Allocations: ${String(snapshot.allocations.length)}, awaiting cleanup: ${String(undrained.length)}`,
          ...undrained.map((allocation) => `  awaiting cleanup: ${allocation.id}`),
        ].join("\n"),
      );
    }),
  ),
);

const fenceCommand = Command.make("fence", {
  ...projectLocationFlags,
  reason: reasonFlag,
}).pipe(
  Command.withDescription(
    "Fence this controller state so neither it nor a copy of it writes again until it is adopted.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCloudCliConfig(flags);
      yield* requireStoppedServer(config);
      yield* withControllerState(
        config,
        Effect.gen(function* () {
          const controller = yield* openController(config);
          const snapshot = yield* controller.snapshot;
          const existing = snapshot.controller.writability;
          if (existing?.status === "fenced") {
            return yield* new ControllerAlreadyFencedError({
              fencedAt: existing.fencedAt,
              reason: existing.reason,
            });
          }
          const undrained = snapshot.allocations.filter(
            (allocation) => allocation.cleanupState.status !== "succeeded",
          );
          if (undrained.length > 0) {
            return yield* new ControllerNotDrainedError({
              allocationIds: undrained.map((allocation) => allocation.id),
            });
          }
          const settings = yield* ControllerSettings.make();
          const fencedAt = DateTime.formatIso(yield* DateTime.now);
          yield* settings.writeFence({ fencedAt, reason: flags.reason });
          yield* Console.log(
            [
              `Fenced ${config.baseDir} at ${fencedAt}.`,
              `Preserved ${String(snapshot.agents?.length ?? 0)} agents and ${String(snapshot.runs?.length ?? 0)} runs.`,
              "Back up the state directory now, restore it on the new host, then run `t3 cloud adopt` there.",
            ].join("\n"),
          );
        }),
      );
    }),
  ),
);

const adoptCommand = Command.make("adopt", { ...projectLocationFlags }).pipe(
  Command.withDescription(
    "Clear the cutover fence so this host becomes the one writable cloud controller.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCloudCliConfig(flags);
      yield* requireStoppedServer(config);
      yield* withControllerState(
        config,
        Effect.gen(function* () {
          const controller = yield* openController(config);
          const adopted = yield* controller.snapshot;
          const settings = yield* ControllerSettings.make();
          yield* settings.clearFence({});
          const agentIds = (adopted.agents ?? []).map((agent) => agent.id);
          yield* Console.log(
            [
              `Adopted ${config.baseDir}. Admission stays stopped until you reopen it.`,
              `Kept ${String(agentIds.length)} agents and ${String(adopted.runs?.length ?? 0)} runs.`,
              ...agentIds.map((id) => `  agent: ${id}`),
            ].join("\n"),
          );
        }),
      );
    }),
  ),
);

export const cloudCommand = Command.make("cloud").pipe(
  Command.withDescription("Inspect and hand over a cloud controller's state directory."),
  Command.withSubcommands([statusCommand, fenceCommand, adoptCommand]),
);
