import { RunAllocationAttempt, RunAllocationCommand } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudAllocationReconciler from "./CloudAllocationReconciler.ts";
import { CloudWorkerRegistration } from "./CloudWorkerRegistration.ts";
import { CloudWorkerRunClient } from "./CloudWorkerRunClient.ts";
import {
  CloudWorkerProvider,
  CloudWorkerProviderError,
  type CloudWorkerResource,
} from "./CloudWorkerProvider.ts";

const decodeCommand = Schema.decodeSync(RunAllocationCommand);
const startAt = Date.parse("2026-09-17T03:00:00.000Z");
const secondAttempt = Schema.decodeSync(RunAllocationAttempt)(2);

function launchCommand(allocationId: string, withExecution = false) {
  return decodeCommand({
    type: "allocation.launch",
    commandId: `launch-${allocationId}`,
    allocationId,
    attempt: 1,
    occurredAt: "2026-09-17T03:00:00.000Z",
    target: {
      repository: "t3tools/t3code",
      baseCommit: "afd7667ed",
      branch: "ca-08-durable-worker-allocation",
    },
    ...(withExecution
      ? {
          execution: {
            threadId: `thread-${allocationId}`,
            title: "Cloud task",
            selectedRef: "afd7667ed",
            unansweredRequestSeconds: 900,
            turn: {
              commandId: `turn-${allocationId}`,
              messageId: `message-${allocationId}`,
              prompt: "Fix the failing test",
              attachments: [],
              modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
              runtimeMode: "approval-required",
              interactionMode: "default",
              createdAt: "2026-09-17T03:00:00.000Z",
            },
          },
        }
      : {}),
    profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
    deadlines: {
      launchBy: "2026-09-17T03:05:00.000Z",
      bootBy: "2026-09-17T03:10:00.000Z",
      registerBy: "2026-09-17T03:15:00.000Z",
      expiresAt: "2026-09-17T05:00:00.000Z",
      cleanupBy: "2026-09-17T05:05:00.000Z",
    },
  });
}

function fixture(
  input: {
    readonly launchFailure?: "capacity" | "lost-response";
    readonly terminateFailure?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const state: {
      instance: CloudWorkerResource | undefined;
      launchCalls: number;
      findCalls: number;
      revokeCalls: number;
      terminateCalls: number;
      startCalls: number;
      statusCalls: number;
    } = {
      instance: undefined,
      launchCalls: 0,
      findCalls: 0,
      revokeCalls: 0,
      terminateCalls: 0,
      startCalls: 0,
      statusCalls: 0,
    };
    const controller = yield* CloudAllocationController.make({ enabled: true });
    const provider = CloudWorkerProvider.of({
      resolveLaunchTemplate: () => Effect.succeed({ id: "lt-worker", version: 7 }),
      findAttemptResources: () =>
        Effect.sync(() => {
          state.findCalls += 1;
          return state.instance === undefined ? [] : [state.instance];
        }),
      listWorkers: () =>
        Effect.sync(() =>
          state.instance === undefined || state.instance.state === "terminated"
            ? []
            : [state.instance],
        ),
      launch: (launchInput) =>
        Effect.gen(function* () {
          state.launchCalls += 1;
          if (input.launchFailure === "capacity") {
            return yield* new CloudWorkerProviderError({
              reason: "retryable",
              message: "InsufficientInstanceCapacity",
            });
          }
          state.instance = {
            instanceId: "i-worker",
            state: "running",
            identity: {
              status: "matched",
              allocationId: launchInput.allocationId,
              attempt: launchInput.attempt,
            },
            registrationCredentialPresent: true,
          };
          if (input.launchFailure === "lost-response") {
            return yield* new CloudWorkerProviderError({
              reason: "retryable",
              message: "RequestTimeout",
            });
          }
          return { instanceId: state.instance.instanceId, state: state.instance.state };
        }),
      revokeRegistrationCredential: () =>
        Effect.sync(() => {
          state.revokeCalls += 1;
          if (state.instance !== undefined) {
            state.instance = { ...state.instance, registrationCredentialPresent: false };
          }
        }),
      terminate: () =>
        Effect.gen(function* () {
          state.terminateCalls += 1;
          if (input.terminateFailure === true) {
            return yield* new CloudWorkerProviderError({
              reason: "retryable",
              message: "RequestTimeout",
            });
          }
          if (state.instance !== undefined) {
            state.instance = { ...state.instance, state: "terminated" };
          }
        }),
    });
    const runClient = CloudWorkerRunClient.of({
      start: () =>
        Effect.sync(() => {
          state.startCalls += 1;
        }),
      status: () =>
        Effect.sync(() => {
          state.statusCalls += 1;
          return "succeeded" as const;
        }),
    });
    const reconciler = yield* CloudAllocationReconciler.make({ runClient }).pipe(
      Effect.provideService(CloudAllocationController.CloudAllocationController, controller),
      Effect.provideService(
        CloudWorkerRegistration,
        CloudWorkerRegistration.of({
          issueCredential: () => Effect.succeed("registration-credential"),
          register: () => Effect.die("unused"),
        }),
      ),
      Effect.provideService(CloudWorkerProvider, provider),
    );
    return { controller, provider, reconciler, state };
  });
}

it.effect("starts and observes a registered cloud thread without a connected client", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* fixture();
    yield* controller.dispatch(launchCommand("allocation-1", true));
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();

    const registering = (yield* controller.snapshot).allocations[0];
    expect(registering?.allocationState.status).toBe("registering");
    if (registering === undefined) return;
    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.worker-assigned",
        commandId: "assign-allocation-1",
        allocationId: registering.id,
        attempt: registering.attempt,
        occurredAt: "2026-09-17T03:00:01.000Z",
        references: {
          workerId: "worker-1",
          environmentId: "environment-1",
          threadId: "thread-allocation-1",
        },
      }),
    );

    yield* reconciler.reconcileOnce();
    expect(state.startCalls).toBe(1);
    expect((yield* controller.snapshot).allocations[0]?.agentOutcome.status).toBe("running");

    yield* reconciler.reconcileOnce();
    const completed = (yield* controller.snapshot).allocations[0];
    expect(state.statusCalls).toBe(1);
    expect(completed?.agentOutcome.status).toBe("succeeded");
    if (completed?.agentOutcome.status === "succeeded") {
      expect(completed.agentOutcome.resultLocation.uri).toBe(
        "t3://environment-1/thread-allocation-1",
      );
    }
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("recovers a lost launch response without creating another instance", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, provider, reconciler, state } = yield* fixture({
      launchFailure: "lost-response",
    });
    yield* controller.dispatch(launchCommand("allocation-1"));

    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    expect(state.launchCalls).toBe(1);

    const restartedController = yield* CloudAllocationController.make({ enabled: true });
    const restartedReconciler = yield* CloudAllocationReconciler.make().pipe(
      Effect.provideService(
        CloudAllocationController.CloudAllocationController,
        restartedController,
      ),
      Effect.provideService(
        CloudWorkerRegistration,
        CloudWorkerRegistration.of({
          issueCredential: () => Effect.succeed("registration-credential"),
          register: () => Effect.die("unused"),
        }),
      ),
      Effect.provideService(CloudWorkerProvider, provider),
    );
    yield* restartedReconciler.reconcileOnce();
    const allocation = (yield* restartedController.snapshot).allocations[0];
    expect(allocation?.allocationState.status).toBe("booting");
    expect(state.launchCalls).toBe(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "keeps completed results during review grace, then withdraws the preview and cleans up",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(startAt);
      const { controller, reconciler, state } = yield* fixture();
      yield* controller.dispatch(launchCommand("allocation-1"));
      yield* reconciler.reconcileOnce();
      yield* reconciler.reconcileOnce();
      yield* reconciler.reconcileOnce();

      const registering = (yield* controller.snapshot).allocations[0];
      expect(registering?.allocationState.status).toBe("registering");
      if (registering === undefined) return;
      yield* controller.dispatch(
        decodeCommand({
          type: "allocation.worker-assigned",
          commandId: "assign-allocation-1",
          allocationId: registering.id,
          attempt: registering.attempt,
          occurredAt: "2026-09-17T03:00:01.000Z",
          references: {
            workerId: "worker-1",
            environmentId: "environment-1",
            threadId: "thread-1",
          },
        }),
      );
      yield* controller.dispatch(
        decodeCommand({
          type: "allocation.agent-started",
          commandId: "start-agent-1",
          allocationId: registering.id,
          attempt: registering.attempt,
          occurredAt: "2026-09-17T03:00:02.000Z",
        }),
      );
      yield* controller.dispatch(
        decodeCommand({
          type: "allocation.preview-published",
          commandId: "publish-preview-1",
          allocationId: registering.id,
          attempt: registering.attempt,
          occurredAt: "2026-09-17T03:00:03.000Z",
          url: "https://preview.example.test/",
        }),
      );
      yield* controller.dispatch(
        decodeCommand({
          type: "allocation.agent-succeeded",
          commandId: "complete-agent-1",
          allocationId: registering.id,
          attempt: registering.attempt,
          occurredAt: "2026-09-17T03:00:04.000Z",
          resultLocation: { uri: "cloud-result:allocation-1" },
        }),
      );

      yield* TestClock.setTime(Date.parse("2026-09-17T03:15:03.000Z"));
      yield* reconciler.reconcileOnce();
      expect((yield* controller.snapshot).allocations[0]?.cleanupState.status).toBe(
        "not-requested",
      );

      yield* TestClock.setTime(Date.parse("2026-09-17T03:15:04.000Z"));
      yield* reconciler.reconcileOnce();
      yield* reconciler.reconcileOnce();
      expect((yield* controller.snapshot).allocations[0]?.previewState.status).toBe("unavailable");
      yield* reconciler.reconcileOnce();
      yield* reconciler.reconcileOnce();
      expect(state.terminateCalls).toBe(1);
      expect((yield* controller.snapshot).allocations[0]?.cleanupState.status).toBe("running");
      yield* reconciler.reconcileOnce();

      const allocation = (yield* controller.snapshot).allocations[0];
      expect(allocation?.agentOutcome.status).toBe("succeeded");
      expect(allocation?.cleanupState.status).toBe("succeeded");
      expect(state.revokeCalls).toBe(1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("removes abandoned workers but never a newer attempt", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* fixture();
    const allocation = yield* controller.dispatch(launchCommand("allocation-1"));
    state.instance = {
      instanceId: "i-newer",
      state: "running",
      identity: {
        status: "matched",
        allocationId: allocation.id,
        attempt: secondAttempt,
      },
      registrationCredentialPresent: true,
    };

    yield* reconciler.reconcileWorkersOnce();
    expect(state.terminateCalls).toBe(0);
    expect(state.revokeCalls).toBe(0);

    state.instance = {
      instanceId: "i-unmatched",
      state: "running",
      identity: { status: "unmatched" },
      registrationCredentialPresent: true,
    };
    yield* reconciler.reconcileWorkersOnce();
    expect(state.terminateCalls).toBe(1);
    expect(state.revokeCalls).toBe(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("keeps failed cleanup visible and accepts an explicit retry", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler } = yield* fixture({ terminateFailure: true });
    const allocation = yield* controller.dispatch(launchCommand("allocation-1"));
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.cancel",
        commandId: "cancel-allocation-1",
        allocationId: allocation.id,
        attempt: allocation.attempt,
        occurredAt: "2026-09-17T03:00:01.000Z",
      }),
    );
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce().pipe(Effect.flip);
    yield* TestClock.setTime(Date.parse("2026-09-17T05:05:00.000Z"));
    yield* reconciler.reconcileOnce();

    const failed = (yield* controller.snapshot).allocations[0];
    expect(failed?.cleanupState.status).toBe("failed");
    if (failed === undefined) return;
    const retried = yield* controller.dispatch(
      decodeCommand({
        type: "allocation.cancel",
        commandId: "retry-cleanup-allocation-1",
        allocationId: failed.id,
        attempt: failed.attempt,
        occurredAt: "2026-09-17T05:05:01.000Z",
      }),
    );
    expect(retried.cleanupState.status).toBe("requested");
    yield* reconciler.reconcileOnce();
    expect((yield* controller.snapshot).allocations[0]?.cleanupState.status).toBe("running");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("cancels before launch without calling AWS", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* fixture();
    const launched = yield* controller.dispatch(launchCommand("allocation-1"));
    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.cancel",
        commandId: "cancel-allocation-1",
        allocationId: launched.id,
        attempt: launched.attempt,
        occurredAt: "2026-09-17T03:00:01.000Z",
      }),
    );

    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    const allocation = (yield* controller.snapshot).allocations[0];
    expect(allocation?.cleanupState.status).toBe("succeeded");
    expect(state.launchCalls).toBe(0);
    expect(state.findCalls).toBe(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("expires an allocation without a connected client", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* fixture();
    yield* controller.dispatch(launchCommand("allocation-1"));
    yield* TestClock.setTime(Date.parse("2026-09-17T05:00:00.000Z"));

    yield* reconciler.reconcileOnce();

    const allocation = (yield* controller.snapshot).allocations[0];
    expect(allocation?.agentOutcome.status).toBe("cancelled");
    expect(allocation?.cleanupState.status).toBe("requested");
    expect(state.launchCalls).toBe(0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("finds and terminates an instance that appears after cancellation", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* fixture();
    const launched = yield* controller.dispatch(launchCommand("allocation-1"));
    yield* reconciler.reconcileOnce();
    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.cancel",
        commandId: "cancel-allocation-1",
        allocationId: launched.id,
        attempt: launched.attempt,
        occurredAt: "2026-09-17T03:00:01.000Z",
      }),
    );

    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    expect(state.terminateCalls).toBe(0);
    state.instance = {
      instanceId: "i-worker",
      state: "pending",
      identity: {
        status: "matched",
        allocationId: launched.id,
        attempt: launched.attempt,
      },
      registrationCredentialPresent: true,
    };
    yield* reconciler.reconcileOnce();
    expect((yield* controller.snapshot).allocations[0]?.cleanupState.status).toBe("running");
    yield* reconciler.reconcileOnce();

    const allocation = (yield* controller.snapshot).allocations[0];
    expect(state.terminateCalls).toBe(1);
    expect(allocation?.cleanupState.status).toBe("succeeded");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("bounds capacity retries and keeps later jobs queued", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* fixture({ launchFailure: "capacity" });
    yield* controller.dispatch(launchCommand("allocation-1"));
    yield* controller.dispatch(launchCommand("allocation-2"));

    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    yield* TestClock.adjust("5 seconds");
    yield* reconciler.reconcileOnce();
    yield* TestClock.adjust("10 seconds");
    yield* reconciler.reconcileOnce();

    const allocations = (yield* controller.snapshot).allocations;
    expect(state.launchCalls).toBe(3);
    expect(
      allocations.find((allocation) => allocation.id === "allocation-1")?.cleanupState.status,
    ).toBe("requested");
    expect(
      allocations.find((allocation) => allocation.id === "allocation-2")?.allocationState.status,
    ).toBe("queued");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("fails registration at its own deadline before agent runtime expiry", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler } = yield* fixture();
    yield* controller.dispatch(launchCommand("allocation-1"));
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();

    expect((yield* controller.snapshot).allocations[0]?.allocationState.status).toBe("registering");
    yield* TestClock.setTime(Date.parse("2026-09-17T03:15:00.000Z"));
    yield* reconciler.reconcileOnce();

    const allocation = (yield* controller.snapshot).allocations[0];
    expect(allocation?.allocationState.status).toBe("failed");
    expect(allocation?.cleanupState.status).toBe("requested");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
