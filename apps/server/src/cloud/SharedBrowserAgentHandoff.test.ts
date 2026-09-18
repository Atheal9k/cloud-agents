import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { make } from "./SharedBrowserAgentHandoff.ts";

const threadId = ThreadId.make("thread-allocation-1-2");
const turnId = TurnId.make("turn-running");
const now = "2026-09-18T00:00:00.000Z";

const session = {
  threadId,
  status: "running",
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  activeTurnId: turnId,
  lastError: null,
  updatedAt: now,
} satisfies NonNullable<OrchestrationThreadShell["session"]>;

const thread: OrchestrationThreadShell = {
  id: threadId,
  projectId: ProjectId.make("cloud:allocation-1:2"),
  title: "Cloud task",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.3-codex",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "cloud/task",
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session,
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const pausedEvent: OrchestrationEvent = {
  sequence: 2,
  eventId: EventId.make("event-paused"),
  aggregateKind: "thread",
  aggregateId: threadId,
  type: "thread.session-set",
  payload: {
    threadId,
    session: {
      ...session,
      status: "interrupted",
      activeTurnId: null,
    },
  },
  occurredAt: now,
  commandId: CommandId.make("command-paused"),
  causationEventId: null,
  correlationId: CorrelationId.make("command-paused"),
  metadata: {},
};

it.effect("interrupts the active turn before sending the browser-state handoff follow-up", () => {
  const commands: OrchestrationCommand[] = [];

  return Effect.gen(function* () {
    const handoff = yield* make();
    yield* handoff.pause(threadId);
    yield* handoff.resume(threadId);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      type: "thread.turn.interrupt",
      threadId,
      turnId,
    });
    expect(commands[1]).toMatchObject({
      type: "thread.turn.start",
      threadId,
      message: {
        role: "user",
        text: expect.stringContaining("human operator changed the shared browser state"),
      },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.succeedSome(thread),
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
          subscribeDomainEvents: Effect.succeed(Stream.make(pausedEvent)),
        }),
      ),
    ),
  );
});
