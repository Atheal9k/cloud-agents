import {
  DeviceDisplayError,
  DeviceDisplaySession,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

const DeviceDisplayHostDescriptor = Schema.Struct({
  upstreamUrl: TrimmedNonEmptyString,
  attemptKey: TrimmedNonEmptyString,
  threadId: ThreadId,
  session: DeviceDisplaySession,
});
export type DeviceDisplayHostDescriptor = typeof DeviceDisplayHostDescriptor.Type;

const decodeDescriptor = Schema.decodeUnknownOption(
  Schema.fromJsonString(DeviceDisplayHostDescriptor),
);

export class DeviceDisplayHost extends Context.Service<
  DeviceDisplayHost,
  {
    readonly available: boolean;
    readonly prepare: (
      threadId: ThreadId,
    ) => Effect.Effect<DeviceDisplayHostDescriptor, DeviceDisplayError>;
    readonly setInputEnabled: (
      threadId: ThreadId,
      enabled: boolean,
    ) => Effect.Effect<void, DeviceDisplayError>;
    readonly reset: () => Effect.Effect<void>;
  }
>()("t3/cloud/DeviceDisplayHost") {}

function displayError(reason: DeviceDisplayError["reason"], message: string): DeviceDisplayError {
  return new DeviceDisplayError({ reason, message });
}

function validateLoopbackUpstream(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export const make = Effect.fn("DeviceDisplayHost.make")(function* (input?: {
  readonly lifecycleCommand?: string;
  readonly permissionCommand?: string;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const lifecycleCommand = input?.lifecycleCommand;
  const prepared = yield* Ref.make<DeviceDisplayHostDescriptor | null>(null);
  const semaphore = yield* Semaphore.make(1);

  const prepareUnlocked = Effect.fn("DeviceDisplayHost.prepareUnlocked")(function* (
    threadId: ThreadId,
  ) {
    const current = yield* Ref.get(prepared);
    if (current !== null) {
      if (current.threadId !== threadId) {
        return yield* displayError(
          "wrong-thread",
          "The device display belongs to another thread on this worker.",
        );
      }
      return current;
    }
    if (lifecycleCommand === undefined) {
      return yield* displayError(
        "unavailable",
        "This worker profile does not provide an Android or iOS device display.",
      );
    }

    const result = yield* runner
      .run({
        command: lifecycleCommand,
        args: [threadId],
        timeout: "30 seconds",
        maxOutputBytes: 8 * 1_024,
      })
      .pipe(
        Effect.mapError(() =>
          displayError(
            "lifecycle-failed",
            "The worker could not start its device display session.",
          ),
        ),
      );
    if (result.code !== 0 || result.stdoutInvalidUtf8 || result.stdoutTruncated) {
      return yield* displayError(
        "lifecycle-failed",
        "The worker device display helper returned an invalid result.",
      );
    }
    const decoded = decodeDescriptor(result.stdout.trim());
    if (Option.isNone(decoded) || validateLoopbackUpstream(decoded.value.upstreamUrl) === null) {
      return yield* displayError(
        "lifecycle-failed",
        "The worker device display helper returned an invalid descriptor.",
      );
    }
    if (decoded.value.threadId !== threadId) {
      return yield* displayError(
        "wrong-thread",
        "The device display descriptor does not match this thread.",
      );
    }
    yield* Ref.set(prepared, decoded.value);
    return decoded.value;
  });

  const prepare: DeviceDisplayHost["Service"]["prepare"] = (threadId) =>
    semaphore.withPermits(1)(prepareUnlocked(threadId));

  const setInputEnabled: DeviceDisplayHost["Service"]["setInputEnabled"] = (threadId, enabled) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* prepareUnlocked(threadId);
        if (input?.permissionCommand === undefined) {
          return yield* displayError(
            "unavailable",
            "This worker image does not support device display input handoff.",
          );
        }
        const result = yield* runner
          .run({
            command: input.permissionCommand,
            args: [enabled ? "human" : "agent"],
            timeout: "10 seconds",
            maxOutputBytes: 4 * 1_024,
          })
          .pipe(
            Effect.mapError(() =>
              displayError(
                "lifecycle-failed",
                "The worker could not change device display input permissions.",
              ),
            ),
          );
        if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
          return yield* displayError(
            "lifecycle-failed",
            "The worker could not change device display input permissions.",
          );
        }
      }),
    );

  const reset: DeviceDisplayHost["Service"]["reset"] = () => Ref.set(prepared, null);

  return DeviceDisplayHost.of({
    available: lifecycleCommand !== undefined,
    prepare,
    setInputEnabled,
    reset,
  });
});

export const layer = Layer.effect(
  DeviceDisplayHost,
  Effect.gen(function* () {
    const command = yield* Config.string("T3CODE_DEVICE_DISPLAY_COMMAND").pipe(Config.option);
    const lifecycleCommand = Option.getOrUndefined(command);
    const permissionCommand = Option.getOrUndefined(
      yield* Config.string("T3CODE_DEVICE_DISPLAY_PERMISSION_COMMAND").pipe(Config.option),
    );
    return yield* make(
      lifecycleCommand === undefined
        ? undefined
        : {
            lifecycleCommand,
            ...(permissionCommand === undefined ? {} : { permissionCommand }),
          },
    );
  }),
);
