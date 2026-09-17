import { RunAllocationCommand } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudAllocationReconciler from "./CloudAllocationReconciler.ts";
import {
  CloudWorkerProvider,
  CloudWorkerProviderError,
  type CloudWorkerInstance,
} from "./CloudWorkerProvider.ts";

const decodeCommand = Schema.decodeSync(RunAllocationCommand);
const startAt = Date.parse("2026-09-17T03:00:00.000Z");

function launchCommand(allocationId: string) {
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
    profile: { id: "linux-web", os: "linux", arch: "x64" },
    deadlines: {
      launchBy: "2026-09-17T03:05:00.000Z",
      bootBy: "2026-09-17T03:10:00.000Z",
      registerBy: "2026-09-17T03:15:00.000Z",
      expiresAt: "2026-09-17T05:00:00.000Z",
      cleanupBy: "2026-09-17T05:05:00.000Z",
    },
  });
}

function fixture(input: { readonly launchFailure?: "capacity" | "lost-response" } = {}) {
  return Effect.gen(function* () {
    const state: {
      instance: CloudWorkerInstance | undefined;
      launchCalls: number;
      findCalls: number;
      terminateCalls: number;
    } = { instance: undefined, launchCalls: 0, findCalls: 0, terminateCalls: 0 };
    const controller = yield* CloudAllocationController.make({ enabled: true });
    const provider = CloudWorkerProvider.of({
      resolveLaunchTemplate: () => Effect.succeed({ id: "lt-worker", version: 7 }),
      findAttempt: () =>
        Effect.sync(() => {
          state.findCalls += 1;
          return state.instance;
        }),
      launch: () =>
        Effect.gen(function* () {
          state.launchCalls += 1;
          if (input.launchFailure === "capacity") {
            return yield* new CloudWorkerProviderError({
              reason: "retryable",
              message: "InsufficientInstanceCapacity",
            });
          }
          state.instance = { instanceId: "i-worker", state: "running" };
          if (input.launchFailure === "lost-response") {
            return yield* new CloudWorkerProviderError({
              reason: "retryable",
              message: "RequestTimeout",
            });
          }
          return state.instance;
        }),
      terminate: () =>
        Effect.sync(() => {
          state.terminateCalls += 1;
          state.instance = { instanceId: "i-worker", state: "terminated" };
        }),
    });
    const reconciler = yield* CloudAllocationReconciler.make().pipe(
      Effect.provideService(CloudAllocationController.CloudAllocationController, controller),
      Effect.provideService(CloudWorkerProvider, provider),
    );
    return { controller, provider, reconciler, state };
  });
}

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
      Effect.provideService(CloudWorkerProvider, provider),
    );
    yield* restartedReconciler.reconcileOnce();
    const allocation = (yield* restartedController.snapshot).allocations[0];
    expect(allocation?.allocationState.status).toBe("booting");
    expect(state.launchCalls).toBe(1);
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
    expect(state.findCalls).toBe(0);
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
    state.instance = { instanceId: "i-worker", state: "pending" };
    yield* reconciler.reconcileOnce();
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
