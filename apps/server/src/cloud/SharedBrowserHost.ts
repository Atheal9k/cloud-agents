import { SharedBrowserError, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

const SharedBrowserHostDescriptor = Schema.Struct({
  upstreamUrl: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  display: TrimmedNonEmptyString,
  attemptKey: TrimmedNonEmptyString,
  threadId: ThreadId,
  xAuthority: Schema.optional(TrimmedNonEmptyString),
  dbusSessionBusAddress: Schema.optional(TrimmedNonEmptyString),
});
export type SharedBrowserHostDescriptor = typeof SharedBrowserHostDescriptor.Type;

const decodeDescriptor = Schema.decodeUnknownOption(
  Schema.fromJsonString(SharedBrowserHostDescriptor),
);

export class SharedBrowserHost extends Context.Service<
  SharedBrowserHost,
  {
    readonly available: boolean;
    readonly prepare: (
      threadId: ThreadId,
    ) => Effect.Effect<SharedBrowserHostDescriptor, SharedBrowserError>;
  }
>()("t3/cloud/SharedBrowserHost") {}

function sharedBrowserError(
  reason: SharedBrowserError["reason"],
  message: string,
): SharedBrowserError {
  return new SharedBrowserError({ reason, message });
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

function applyBrowserEnvironment(descriptor: SharedBrowserHostDescriptor): void {
  process.env.DISPLAY = descriptor.display;
  process.env.T3CODE_SHARED_BROWSER_SESSION_ID = descriptor.sessionId;
  if (descriptor.xAuthority !== undefined) process.env.XAUTHORITY = descriptor.xAuthority;
  if (descriptor.dbusSessionBusAddress !== undefined) {
    process.env.DBUS_SESSION_BUS_ADDRESS = descriptor.dbusSessionBusAddress;
  }
}

export const make = Effect.fn("SharedBrowserHost.make")(function* (input?: {
  readonly lifecycleCommand?: string;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const lifecycleCommand = input?.lifecycleCommand;
  const prepared = yield* Ref.make<SharedBrowserHostDescriptor | null>(null);
  const semaphore = yield* Semaphore.make(1);

  const prepare: SharedBrowserHost["Service"]["prepare"] = (threadId) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(prepared);
        if (current !== null) {
          if (current.threadId !== threadId) {
            return yield* sharedBrowserError(
              "wrong-thread",
              "The shared browser belongs to another thread on this worker.",
            );
          }
          applyBrowserEnvironment(current);
          return current;
        }
        if (lifecycleCommand === undefined) {
          return yield* sharedBrowserError(
            "unavailable",
            "This worker profile does not provide a shared browser session.",
          );
        }

        const result = yield* runner
          .run({
            command: lifecycleCommand,
            args: [],
            timeout: "30 seconds",
            maxOutputBytes: 8 * 1_024,
          })
          .pipe(
            Effect.mapError(() =>
              sharedBrowserError(
                "lifecycle-failed",
                "The worker could not start its shared browser session.",
              ),
            ),
          );
        if (result.code !== 0 || result.stdoutInvalidUtf8 || result.stdoutTruncated) {
          return yield* sharedBrowserError(
            "lifecycle-failed",
            "The worker shared browser helper returned an invalid result.",
          );
        }
        const decoded = decodeDescriptor(result.stdout.trim());
        if (
          Option.isNone(decoded) ||
          validateLoopbackUpstream(decoded.value.upstreamUrl) === null
        ) {
          return yield* sharedBrowserError(
            "lifecycle-failed",
            "The worker shared browser helper returned an invalid descriptor.",
          );
        }
        if (decoded.value.threadId !== threadId) {
          return yield* sharedBrowserError(
            "wrong-thread",
            "The shared browser descriptor does not match this thread.",
          );
        }
        yield* Ref.set(prepared, decoded.value);
        applyBrowserEnvironment(decoded.value);
        return decoded.value;
      }),
    );

  return SharedBrowserHost.of({ available: lifecycleCommand !== undefined, prepare });
});

export const layer = Layer.effect(
  SharedBrowserHost,
  Effect.gen(function* () {
    const command = yield* Config.string("T3CODE_SHARED_BROWSER_COMMAND").pipe(Config.option);
    const lifecycleCommand = Option.getOrUndefined(command);
    return yield* make(lifecycleCommand === undefined ? undefined : { lifecycleCommand });
  }),
);
