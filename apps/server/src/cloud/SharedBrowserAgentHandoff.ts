// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { CommandId, MessageId, SharedBrowserError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const HANDOFF_PROMPT =
  "The human operator changed the shared browser state and returned control. Inspect the current page before continuing. Do not repeat a consequential action without confirming the current state.";

export class SharedBrowserAgentHandoff extends Context.Service<
  SharedBrowserAgentHandoff,
  {
    readonly pause: (threadId: ThreadId) => Effect.Effect<void, SharedBrowserError>;
    readonly resume: (threadId: ThreadId) => Effect.Effect<void, SharedBrowserError>;
  }
>()("t3/cloud/SharedBrowserAgentHandoff") {}

function handoffError(message: string): SharedBrowserError {
  return new SharedBrowserError({ reason: "handoff-failed", message });
}

const randomId = (prefix: string): string =>
  `${prefix}:${NodeCrypto.randomBytes(18).toString("base64url")}`;

export const make = Effect.fn("SharedBrowserAgentHandoff.make")(function* () {
  const orchestration = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;

  const readThread = Effect.fn("SharedBrowserAgentHandoff.readThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(
        Effect.mapError(() => handoffError("The worker could not read the agent's current state.")),
      );
    if (Option.isNone(thread)) {
      return yield* new SharedBrowserError({
        reason: "wrong-thread",
        message: "The shared browser thread no longer exists on this worker.",
      });
    }
    return thread.value;
  });

  const pause: SharedBrowserAgentHandoff["Service"]["pause"] = Effect.fn(
    "SharedBrowserAgentHandoff.pause",
  )(function* (threadId) {
    const thread = yield* readThread(threadId);
    if (thread.session === null || thread.session.activeTurnId === null) return;
    const turnId = thread.session.activeTurnId;

    yield* Effect.scoped(
      Effect.gen(function* () {
        const events = yield* orchestration.subscribeDomainEvents;
        const paused = Stream.runHead(
          events.pipe(
            Stream.filter(
              (event) =>
                event.type === "thread.session-set" &&
                event.payload.threadId === threadId &&
                event.payload.session.activeTurnId === null,
            ),
          ),
        ).pipe(Effect.timeoutOption("30 seconds"));

        const now = DateTime.formatIso(yield* DateTime.now);
        yield* orchestration
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(randomId("shared-browser-takeover")),
            threadId,
            turnId,
            createdAt: now,
          })
          .pipe(
            Effect.mapError(() =>
              handoffError("The worker could not interrupt the agent before takeover."),
            ),
          );

        if (Option.isNone(yield* paused)) {
          return yield* handoffError("The agent did not stop browser input before takeover.");
        }
      }),
    );
  });

  const resume: SharedBrowserAgentHandoff["Service"]["resume"] = Effect.fn(
    "SharedBrowserAgentHandoff.resume",
  )(function* (threadId) {
    const thread = yield* readThread(threadId);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* orchestration
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(randomId("shared-browser-return")),
        threadId,
        message: {
          messageId: MessageId.make(randomId("shared-browser-return-message")),
          role: "user",
          text: HANDOFF_PROMPT,
          attachments: [],
        },
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      })
      .pipe(
        Effect.mapError(() =>
          handoffError("The shared browser was secured, but the agent could not resume."),
        ),
      );
  });

  return SharedBrowserAgentHandoff.of({ pause, resume });
});

export const layer = Layer.effect(SharedBrowserAgentHandoff, make());
