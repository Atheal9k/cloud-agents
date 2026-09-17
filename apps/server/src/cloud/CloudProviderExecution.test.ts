import {
  ApprovalRequestId,
  CloudProviderExecutionStartInput,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  OrchestrationEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  type ServerProvider as ServerProviderType,
  TurnId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { CloudProviderExecution, layer, make } from "./CloudProviderExecution.ts";

const decodeProvider = Schema.decodeSync(ServerProvider);
const decodeStartInput = Schema.decodeSync(CloudProviderExecutionStartInput);
const decodeEvent = Schema.decodeSync(OrchestrationEvent);

const readyCodex = decodeProvider({
  instanceId: "codex-cloud",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "0.154.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-17T05:00:00.000Z",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      aliases: ["sol"],
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
});

function startInput() {
  return decodeStartInput({
    preparation: {
      allocationId: "allocation-11",
      attempt: 1,
      repository: "Atheal9k/cloud-agents",
      selectedRef: "main",
      resolvedCommit: "a".repeat(40),
      outputBranch: "cloud/run/ca11",
      workspacePath: "/work/cloud-run-ca11",
      instructionFiles: ["AGENTS.md"],
      setupResults: [],
      devServers: [
        {
          name: "web",
          port: 5173,
          command: {
            name: "serve-web",
            command: "vp",
            args: ["run", "dev"],
            timeoutSeconds: 300,
          },
        },
      ],
      verification: [
        {
          name: "focused-test",
          command: "vp",
          args: ["test", "run", "focused.test.ts"],
          timeoutSeconds: 300,
        },
      ],
      permittedSecretReferences: [],
      preparedAt: "2026-09-17T05:00:00.000Z",
    },
    threadId: "thread-allocation-11",
    title: "Implement CA-11",
    unansweredRequestSeconds: 900,
    turn: {
      commandId: "cloud-turn-start-11",
      messageId: "cloud-message-11",
      prompt: "Implement the selected ticket.",
      attachments: [
        {
          type: "image",
          id: "attachment-1",
          name: "reference.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
      ],
      modelSelection: { instanceId: "codex-cloud", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-09-17T05:01:00.000Z",
    },
  });
}

function fixture(
  providers: ReadonlyArray<ServerProviderType>,
  options?: { readonly maxInputWaitSeconds?: number },
) {
  return Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const orchestration = OrchestrationEngineService.of({
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () => Effect.die("unused"),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.succeed(0),
    });
    const execution = yield* make(options).pipe(
      Effect.provideService(OrchestrationEngineService, orchestration),
      Effect.provide(makeProviderRegistryLayer(providers)),
    );
    return { commands, execution };
  });
}

it.effect("starts Codex through ordinary project and turn orchestration commands", () =>
  Effect.gen(function* () {
    const { commands, execution } = yield* fixture([readyCodex]);
    const result = yield* execution.start(startInput());

    expect(result).toMatchObject({
      allocationId: "allocation-11",
      attempt: 1,
      projectId: "cloud:allocation-11:1",
      threadId: "thread-allocation-11",
      acceptedSequence: 2,
    });
    expect(commands).toEqual([
      {
        type: "project.create",
        commandId: "cloud:allocation-11:1:project-create",
        projectId: "cloud:allocation-11:1",
        title: "Atheal9k/cloud-agents",
        workspaceRoot: "/work/cloud-run-ca11",
        createdAt: "2026-09-17T05:01:00.000Z",
      },
      {
        type: "thread.turn.start",
        commandId: "cloud-turn-start-11",
        threadId: "thread-allocation-11",
        message: {
          messageId: "cloud-message-11",
          role: "user",
          text: "Implement the selected ticket.",
          attachments: [
            {
              type: "image",
              id: "attachment-1",
              name: "reference.png",
              mimeType: "image/png",
              sizeBytes: 128,
            },
          ],
        },
        modelSelection: { instanceId: "codex-cloud", model: "gpt-5.6-sol" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: "cloud:allocation-11:1",
            title: "Implement CA-11",
            modelSelection: { instanceId: "codex-cloud", model: "gpt-5.6-sol" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: "cloud/run/ca11",
            worktreePath: null,
            createdAt: "2026-09-17T05:01:00.000Z",
          },
        },
        createdAt: "2026-09-17T05:01:00.000Z",
      },
    ]);
  }),
);

it.effect("rejects input-wait policies above the worker limit before starting a turn", () =>
  Effect.gen(function* () {
    const { commands, execution } = yield* fixture([readyCodex], { maxInputWaitSeconds: 899 });
    const error = yield* execution.start(startInput()).pipe(Effect.flip);

    expect(error.reason).toBe("invalid-execution-policy");
    expect(commands).toEqual([]);
  }),
);

it.effect("uses ordinary controls for a live worker thread", () =>
  Effect.gen(function* () {
    const { commands, execution } = yield* fixture([readyCodex]);
    const input = startInput();
    yield* execution.followUp({
      threadId: input.threadId,
      turn: {
        ...input.turn,
        commandId: CommandId.make("cloud-follow-up-11"),
        messageId: MessageId.make("cloud-follow-up-message-11"),
        prompt: "Now run the focused test.",
        attachments: [],
      },
    });
    yield* execution.interrupt({
      commandId: input.turn.commandId,
      threadId: input.threadId,
      turnId: TurnId.make("provider-turn-1"),
      createdAt: "2026-09-17T05:02:00.000Z",
    });
    yield* execution.approve({
      commandId: CommandId.make("cloud-approval-11"),
      threadId: input.threadId,
      requestId: ApprovalRequestId.make("approval-11"),
      decision: "accept",
      createdAt: "2026-09-17T05:03:00.000Z",
    });
    yield* execution.answer({
      commandId: CommandId.make("cloud-answer-11"),
      threadId: input.threadId,
      requestId: ApprovalRequestId.make("question-11"),
      answers: { choice: "Run the focused test" },
      createdAt: "2026-09-17T05:04:00.000Z",
    });

    expect(commands.map((command) => command.type)).toEqual([
      "thread.turn.start",
      "thread.turn.interrupt",
      "thread.approval.respond",
      "thread.user-input.respond",
    ]);
    expect(commands[0]).toMatchObject({
      message: { text: "Now run the focused test." },
      modelSelection: { instanceId: "codex-cloud", model: "gpt-5.6-sol" },
    });
    expect(commands[1]).toMatchObject({ turnId: "provider-turn-1" });
    expect(commands[2]).toMatchObject({ requestId: "approval-11", decision: "accept" });
    expect(commands[3]).toMatchObject({
      requestId: "question-11",
      answers: { choice: "Run the focused test" },
    });
  }),
);

it.effect("declines unanswered approvals without racing a second client's response", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const commands: OrchestrationCommand[] = [];
    const orchestration = OrchestrationEngineService.of({
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () => Effect.die("unused"),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      streamDomainEvents: Stream.fromPubSub(events),
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      latestSequence: Effect.succeed(0),
    });
    const executionLayer = layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(OrchestrationEngineService, orchestration),
          makeProviderRegistryLayer([readyCodex]),
        ),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const execution = yield* CloudProviderExecution;
        const input = decodeStartInput({
          ...startInput(),
          unansweredRequestSeconds: 5,
        });
        yield* execution.start(input);
        yield* PubSub.publish(
          events,
          decodeEvent({
            sequence: 3,
            eventId: EventId.make("cloud-approval-requested"),
            aggregateKind: "thread",
            aggregateId: input.threadId,
            occurredAt: "2026-09-17T05:02:00.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.activity-appended",
            payload: {
              threadId: input.threadId,
              activity: {
                id: EventId.make("cloud-approval-activity"),
                tone: "approval",
                kind: "approval.requested",
                summary: "Command approval requested",
                payload: { requestId: "approval-timeout-1" },
                turnId: null,
                createdAt: "2026-09-17T05:02:00.000Z",
              },
            },
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;

        yield* PubSub.publish(
          events,
          decodeEvent({
            sequence: 4,
            eventId: EventId.make("cloud-approval-requested-2"),
            aggregateKind: "thread",
            aggregateId: input.threadId,
            occurredAt: "2026-09-17T05:03:00.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.activity-appended",
            payload: {
              threadId: input.threadId,
              activity: {
                id: EventId.make("cloud-approval-activity-2"),
                tone: "approval",
                kind: "approval.requested",
                summary: "Command approval requested",
                payload: { requestId: "approval-answered-2" },
                turnId: null,
                createdAt: "2026-09-17T05:03:00.000Z",
              },
            },
          }),
        );
        yield* Effect.yieldNow;
        yield* execution.approve({
          commandId: CommandId.make("second-client-approval"),
          threadId: input.threadId,
          requestId: ApprovalRequestId.make("approval-answered-2"),
          decision: "accept",
          createdAt: "2026-09-17T05:03:01.000Z",
        });
        yield* PubSub.publish(
          events,
          decodeEvent({
            sequence: 5,
            eventId: EventId.make("cloud-approval-response-2"),
            aggregateKind: "thread",
            aggregateId: input.threadId,
            occurredAt: "2026-09-17T05:03:01.000Z",
            commandId: CommandId.make("second-client-approval"),
            causationEventId: null,
            correlationId: CommandId.make("second-client-approval"),
            metadata: {},
            type: "thread.approval-response-requested",
            payload: {
              threadId: input.threadId,
              requestId: "approval-answered-2",
              decision: "accept",
              createdAt: "2026-09-17T05:03:01.000Z",
            },
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
      }).pipe(Effect.provide(executionLayer)),
    );

    expect(
      commands.filter(
        (command) => command.type === "thread.approval.respond" && command.decision === "decline",
      ),
    ).toEqual([
      expect.objectContaining({
        requestId: "approval-timeout-1",
        decision: "decline",
      }),
    ]);
    expect(commands.at(-1)).toMatchObject({
      type: "thread.approval.respond",
      requestId: "approval-answered-2",
      decision: "accept",
    });
  }),
);

it.effect("reports authentication, model, and quota failures separately", () =>
  Effect.gen(function* () {
    const cases = [
      {
        provider: { ...readyCodex, auth: { status: "unauthenticated" as const } },
        reason: "authentication-failed",
      },
      {
        provider: { ...readyCodex, models: [] },
        reason: "model-unavailable",
      },
      {
        provider: {
          ...readyCodex,
          usageLimits: {
            checkedAt: "2026-09-17T05:00:00.000Z",
            windows: [
              {
                id: "primary",
                kind: "session" as const,
                label: "Session",
                usedPercent: 100,
                resetsAt: "2026-09-17T06:00:00.000Z",
              },
            ],
          },
        },
        reason: "quota-exhausted",
      },
    ] as const;

    for (const testCase of cases) {
      const { execution } = yield* fixture([testCase.provider]);
      const error = yield* execution.start(startInput()).pipe(Effect.flip);
      expect(error.reason).toBe(testCase.reason);
    }
  }),
);

it.effect("rejects unqualified providers before creating worker state", () =>
  Effect.gen(function* () {
    const claude = {
      ...readyCodex,
      instanceId: ProviderInstanceId.make("claude-cloud"),
      driver: ProviderDriverKind.make("claudeAgent"),
    };
    const { commands, execution } = yield* fixture([claude]);
    const input = startInput();
    const error = yield* execution
      .start({
        ...input,
        turn: {
          ...input.turn,
          modelSelection: { instanceId: claude.instanceId, model: "gpt-5.6-sol" },
        },
      })
      .pipe(Effect.flip);

    expect(error.reason).toBe("provider-not-qualified");
    expect(commands).toEqual([]);
  }),
);
