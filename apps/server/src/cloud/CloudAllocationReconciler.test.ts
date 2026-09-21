import {
  CloudAgentId,
  CloudEnvironmentBuildId,
  CloudEnvironmentSaveInput,
  CloudRunId,
  CloudWarmGuestId,
  DEFAULT_CONVERSATION_RETENTION_DAYS,
  RunAllocationAttempt,
  RunAllocationCommand,
  RunAllocationId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudAllocationReconciler from "./CloudAllocationReconciler.ts";
import {
  CloudRuntimeProvider,
  CloudRuntimeProviderError,
  type CloudRuntimeCreateInput,
} from "./CloudRuntimeProvider.ts";
import { make as makeBuilds } from "./CloudEnvironmentBuildCatalog.ts";
import { make as makeWarmPool } from "./CloudWarmPoolCatalog.ts";
import * as ControllerSettings from "./controllerSettings.ts";
import { CloudWorkerRegistration } from "./CloudWorkerRegistration.ts";
import { CloudWorkerRunClient } from "./CloudWorkerRunClient.ts";
import {
  CloudWorkerProvider,
  CloudWorkerProviderError,
  type CloudWorkerResource,
} from "./CloudWorkerProvider.ts";

const decodeCommand = Schema.decodeSync(RunAllocationCommand);
const decodeEnvironmentSave = Schema.decodeSync(CloudEnvironmentSaveInput);
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
    readonly readinessFailure?: "disabled" | "missing" | "outage";
    readonly terminateFailure?: boolean;
    readonly hibernateFailure?: boolean;
    readonly restoreFailure?: boolean;
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
      flushCalls: number;
      reopenCalls: number;
      sessionEditsCalls: number;
      hibernateCalls: number;
      archiveCalls: number;
      restoreCalls: number;
      runtimeArchived: boolean;
    } = {
      instance: undefined,
      launchCalls: 0,
      findCalls: 0,
      revokeCalls: 0,
      terminateCalls: 0,
      startCalls: 0,
      statusCalls: 0,
      flushCalls: 0,
      reopenCalls: 0,
      sessionEditsCalls: 0,
      hibernateCalls: 0,
      archiveCalls: 0,
      restoreCalls: 0,
      runtimeArchived: false,
    };
    let assignment: CloudRuntimeCreateInput | undefined;
    const controller = yield* CloudAllocationController.make({ enabled: true });
    const provider = CloudWorkerProvider.of({
      resolveLaunchTemplate: () => Effect.succeed({ id: "lt-worker", version: 7 }),
      findAttemptResources: (attempt) =>
        Effect.sync(() => {
          state.findCalls += 1;
          const instance = state.instance;
          // The real provider filters by the allocation and attempt tags, so a
          // guest still tagged for an earlier attempt must not answer here.
          return instance === undefined ||
            instance.identity.status !== "matched" ||
            instance.identity.attempt !== attempt.attempt
            ? []
            : [instance];
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
      inspectMacCapacity: () =>
        Effect.succeed({
          region: "us-west-1",
          instanceType: "t3.medium",
          appleSilicon: false,
          dedicatedHostQuota: { used: 0, limit: 1 },
          availableHostIds: [],
          availabilityZones: ["us-west-1a"],
        }),
      allocateDedicatedHost: () => Effect.succeed({ hostId: "h-unused" }),
      releaseDedicatedHost: () => Effect.void,
      revokeRegistrationCredential: () =>
        Effect.sync(() => {
          state.revokeCalls += 1;
          if (state.instance !== undefined) {
            state.instance = { ...state.instance, registrationCredentialPresent: false };
          }
        }),
      hibernate: () =>
        Effect.gen(function* () {
          state.hibernateCalls += 1;
          if (input.hibernateFailure === true) {
            return yield* new CloudWorkerProviderError({
              reason: "retryable",
              message: "RequestTimeout",
            });
          }
          if (state.instance !== undefined) {
            state.instance = { ...state.instance, state: "stopped" };
          }
        }),
      restore: (restoreInput) =>
        Effect.gen(function* () {
          state.restoreCalls += 1;
          if (input.restoreFailure === true) {
            return yield* new CloudWorkerProviderError({
              reason: "fatal",
              message: "InvalidInstanceID.NotFound",
            });
          }
          state.instance = {
            instanceId: restoreInput.instanceId,
            state: "running",
            identity: {
              status: "matched",
              allocationId: restoreInput.allocationId,
              attempt: restoreInput.attempt,
            },
            registrationCredentialPresent: true,
          };
          return { instanceId: state.instance.instanceId, state: state.instance.state };
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
      runtimeKind: "ec2-fallback",
    });
    const managedRuntime = () => {
      const instance = state.instance;
      if (instance === undefined || instance.state === "terminated") {
        return undefined;
      }
      const identity = instance.identity.status === "matched" ? instance.identity : undefined;
      const current =
        assignment ??
        (identity === undefined
          ? undefined
          : {
              allocationId: identity.allocationId,
              attempt: identity.attempt,
              agentId: CloudAgentId.make(`agent:${identity.allocationId}`),
              runId: CloudRunId.make(`run:${identity.allocationId}:1`),
              environmentVariables: {},
            });
      if (current === undefined) return undefined;
      return {
        provider: "daytona" as const,
        runtimeId: instance.instanceId,
        region: "us",
        resourceClass: "t3.medium",
        lifecycleState: state.runtimeArchived
          ? ("archived" as const)
          : instance.state === "running"
            ? ("started" as const)
            : instance.state === "stopped"
              ? ("stopped" as const)
              : ("creating" as const),
        allocationId: current.allocationId,
        attempt: current.attempt,
        agentId: current.agentId,
        runId: current.runId,
        ...(current.environmentId === undefined ? {} : { environmentId: current.environmentId }),
        ...(current.buildId === undefined ? {} : { buildId: current.buildId }),
        observedAt: "2026-09-17T03:00:00.000Z",
      };
    };
    const runtimeProvider = CloudRuntimeProvider.of({
      readiness: () =>
        Effect.succeed({
          provider: "daytona",
          admission: input.readinessFailure === "disabled" ? "disabled" : "enabled",
          authentication: input.readinessFailure === "missing" ? "missing" : "configured",
          reachability:
            input.readinessFailure === "outage"
              ? "unreachable"
              : input.readinessFailure === "missing" || input.readinessFailure === "disabled"
                ? "unchecked"
                : "reachable",
          region: "us",
          resourceClass: "t3.medium",
          observedSandboxes: state.instance === undefined ? 0 : 1,
          readySandboxes: state.instance?.state === "running" ? 1 : 0,
          detail:
            input.readinessFailure === "missing"
              ? "DAYTONA_API_KEY is not configured."
              : input.readinessFailure === "disabled"
                ? "Daytona admission is disabled."
                : input.readinessFailure === "outage"
                  ? "Daytona is unreachable."
                  : "Daytona is ready.",
        }),
      create: (createInput) =>
        Effect.gen(function* () {
          const existing = managedRuntime();
          if (existing !== undefined && existing.allocationId === createInput.allocationId) {
            return existing;
          }
          state.launchCalls += 1;
          if (input.launchFailure === "capacity") {
            return yield* new CloudRuntimeProviderError({
              reason: "capacity",
              message: "InsufficientInstanceCapacity",
            });
          }
          assignment = createInput;
          state.runtimeArchived = false;
          state.instance = {
            instanceId: "i-worker",
            state: "running",
            identity: {
              status: "matched",
              allocationId: createInput.allocationId,
              attempt: createInput.attempt,
            },
            registrationCredentialPresent: true,
          };
          if (input.launchFailure === "lost-response") {
            return yield* new CloudRuntimeProviderError({
              reason: "provider-outage",
              message: "RequestTimeout",
            });
          }
          return managedRuntime()!;
        }),
      inspect: (locator) =>
        Effect.sync(() => {
          state.findCalls += 1;
          const runtime = managedRuntime();
          if (runtime === undefined) return undefined;
          return locator.kind === "id"
            ? locator.runtimeId === runtime.runtimeId
              ? runtime
              : undefined
            : locator.allocationId === runtime.allocationId && locator.attempt === runtime.attempt
              ? runtime
              : undefined;
        }),
      list: () => Effect.sync(() => (managedRuntime() === undefined ? [] : [managedRuntime()!])),
      start: ({ assignment: nextAssignment }) =>
        Effect.gen(function* () {
          state.restoreCalls += 1;
          if (input.restoreFailure === true) {
            if (state.instance !== undefined) {
              state.instance = { ...state.instance, state: "terminated" };
            }
            return yield* new CloudRuntimeProviderError({
              reason: "not-found",
              message: "Sandbox not found",
            });
          }
          if (nextAssignment !== undefined) assignment = nextAssignment;
          if (state.instance !== undefined) {
            state.runtimeArchived = false;
            state.instance = {
              ...state.instance,
              state: "running",
              identity:
                assignment === undefined
                  ? state.instance.identity
                  : {
                      status: "matched",
                      allocationId: assignment.allocationId,
                      attempt: assignment.attempt,
                    },
            };
          }
          return managedRuntime()!;
        }),
      stop: () =>
        Effect.gen(function* () {
          state.hibernateCalls += 1;
          if (input.hibernateFailure === true) {
            return yield* new CloudRuntimeProviderError({
              reason: "provider-outage",
              message: "RequestTimeout",
            });
          }
          if (state.instance !== undefined)
            state.instance = { ...state.instance, state: "stopped" };
          state.runtimeArchived = false;
          return managedRuntime()!;
        }),
      archive: () =>
        Effect.sync(() => {
          state.archiveCalls += 1;
          state.runtimeArchived = true;
          return managedRuntime()!;
        }),
      delete: () =>
        Effect.gen(function* () {
          state.terminateCalls += 1;
          state.revokeCalls += 1;
          if (input.terminateFailure === true) {
            return yield* new CloudRuntimeProviderError({
              reason: "provider-outage",
              message: "RequestTimeout",
            });
          }
          if (state.instance !== undefined) {
            state.instance = { ...state.instance, state: "terminated" };
          }
        }),
      execute: () => Effect.die("unused"),
      ensureProcess: () => Effect.die("unused"),
      inspectProcess: () => Effect.die("unused"),
      deleteProcess: () => Effect.die("unused"),
      preview: () => Effect.die("unused"),
      snapshot: ({ name }) => Effect.succeed({ name }),
      desktop: () => Effect.die("unused"),
      resourceClass: "t3.medium",
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
      flush: () =>
        Effect.sync(() => {
          state.flushCalls += 1;
          return {
            userdata: { status: "flushed", detail: "Checkpointed 4 write-ahead log pages." },
            workspace: {
              status: "flushed",
              detail: "Captured the workspace as refs/t3/cloud-idle/allocation-1/1.",
            },
            providerHome: {
              status: "unavailable",
              reason: "Provider homes live in runtime directories that a stop clears.",
            },
            flushedAt: "2026-09-17T03:20:00.000Z",
          } as const;
        }),
      threadDetail: () => Effect.die("unused"),
      reopen: () =>
        Effect.sync(() => {
          state.reopenCalls += 1;
          return {
            environmentStart: { services: [] },
            browser: { status: "fresh", reason: "No browser profile is declared." },
            reopenedAt: "2026-09-17T04:00:00.000Z",
            providerRunStarted: false,
          } as const;
        }),
      sessionEdits: () =>
        Effect.sync(() => {
          state.sessionEditsCalls += 1;
          return { status: "unchanged", capturedAt: "2026-09-17T04:10:00.000Z" } as const;
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
      Effect.provideService(CloudRuntimeProvider, runtimeProvider),
    );
    return { controller, provider, runtimeProvider, reconciler, state };
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
    const { controller, provider, runtimeProvider, reconciler, state } = yield* fixture({
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
      Effect.provideService(CloudRuntimeProvider, runtimeProvider),
    );
    yield* TestClock.adjust("5 seconds");
    yield* restartedReconciler.reconcileOnce();
    const allocation = (yield* restartedController.snapshot).allocations[0];
    expect(allocation?.allocationState.status).toBe("booting");
    expect(state.launchCalls).toBe(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("fails launch before creating a sandbox when Daytona credentials are missing", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* fixture({ readinessFailure: "missing" });
    yield* controller.dispatch(launchCommand("allocation-1"));

    yield* reconciler.reconcileOnce();

    const allocation = (yield* controller.snapshot).allocations[0];
    expect(allocation?.allocationState).toMatchObject({
      status: "failed",
      reason: "DAYTONA_API_KEY is not configured.",
      managedProvider: "daytona",
    });
    expect(allocation?.cleanupState.status).toBe("requested");
    expect(state.launchCalls).toBe(0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("ends a preview when its lease expires and keeps the settled guest", () =>
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
        type: "allocation.worker-registered",
        commandId: "assign-allocation-1",
        allocationId: registering.id,
        attempt: registering.attempt,
        occurredAt: "2026-09-17T03:00:01.000Z",
        references: {
          workerId: "worker-1",
          environmentId: "environment-1",
          threadId: "thread-1",
        },
        route: {
          httpBaseUrl: "https://worker.example.test/",
          wsBaseUrl: "wss://worker.example.test/",
          accessToken: "worker-access-token",
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

    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.session-lease-open",
        commandId: "open-preview-lease-1",
        allocationId: registering.id,
        attempt: registering.attempt,
        occurredAt: "2026-09-17T03:00:05.000Z",
        kind: "app-preview",
        expiresAt: "2026-09-17T03:15:05.000Z",
        hardExpiresAt: "2026-09-17T07:00:05.000Z",
      }),
    );

    yield* TestClock.setTime(Date.parse("2026-09-17T03:15:03.000Z"));
    yield* reconciler.reconcileOnce();
    const watched = (yield* controller.snapshot).allocations[0];
    expect(watched?.previewState.status).toBe("available");
    // A held lease defers the idle release rather than racing it.
    expect(watched?.idleState.status).toBe("idle");

    yield* TestClock.setTime(Date.parse("2026-09-17T03:15:06.000Z"));
    yield* reconciler.reconcileOnce();
    const withdrawn = (yield* controller.snapshot).allocations[0];
    expect(withdrawn?.leases.appPreview).toMatchObject({
      status: "released",
      reason: "The session lease expired without a heartbeat.",
    });
    expect(withdrawn?.previewState.status).toBe("unavailable");
    // The lease ends the preview, not the conversation: the guest is still
    // there and nothing has been terminated.
    expect(withdrawn?.cleanupState.status).toBe("not-requested");
    expect(state.terminateCalls).toBe(0);

    yield* reconciler.reconcileOnce();
    const idle = (yield* controller.snapshot).allocations[0];
    expect(idle?.idleState.status).toBe("idle");
    expect(idle?.agentOutcome.status).toBe("succeeded");
    expect(state.terminateCalls).toBe(0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("removes a stale Daytona sandbox but never a newer allocation attempt", () =>
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
      instanceId: "i-stale",
      state: "running",
      identity: {
        status: "matched",
        allocationId: RunAllocationId.make("missing-allocation"),
        attempt: RunAllocationAttempt.make(1),
      },
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
    yield* reconciler.reconcileOnce();
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

it.effect("stops, archives, and confirms Daytona resource release after cancellation", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* fixture();
    const allocation = yield* controller.dispatch(launchCommand("allocation-1"));
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.cancel",
        commandId: "cancel-daytona-allocation-1",
        allocationId: allocation.id,
        attempt: allocation.attempt,
        occurredAt: "2026-09-17T03:00:01.000Z",
      }),
    );

    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();

    const released = (yield* controller.snapshot).allocations[0];
    expect(state.hibernateCalls).toBe(1);
    expect(state.archiveCalls).toBe(1);
    expect(state.terminateCalls).toBe(1);
    expect(released?.cleanupState.status).toBe("succeeded");
    expect(released?.progress).toMatchObject({
      stage: "delete",
      status: "succeeded",
      message: "Daytona confirmed the resource was released.",
    });
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
    expect(allocation?.agentOutcome.status).toBe("expired");
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
    yield* reconciler.reconcileWorkersOnce();
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

it.effect("does not act on AWS while its controller state is fenced", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* fixture();
    yield* controller.dispatch(launchCommand("allocation-1", true));

    const settings = yield* ControllerSettings.make();
    yield* settings.writeFence({
      fencedAt: "2026-09-17T03:00:30.000Z",
      reason: "Cutover to the permanent controller.",
    });

    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileWorkersOnce();
    expect(state.launchCalls).toBe(0);
    expect(state.terminateCalls).toBe(0);
    expect((yield* controller.snapshot).allocations[0]?.allocationState.status).toBe("queued");

    yield* settings.clearFence({});
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    expect(state.launchCalls).toBe(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

function followUpCommand(allocationId: string, occurredAt: string, runId: string) {
  return decodeCommand({
    type: "allocation.follow-up",
    commandId: "follow-up-" + runId,
    allocationId,
    attempt: 1,
    occurredAt,
    runId,
    execution: {
      threadId: "thread-" + allocationId,
      title: "Cloud task",
      selectedRef: "afd7667ed",
      unansweredRequestSeconds: 900,
      turn: {
        commandId: "turn-" + runId,
        messageId: "message-" + runId,
        prompt: "Pick this back up",
        attachments: [],
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: occurredAt,
      },
    },
    deadlines: {
      launchBy: "2026-09-18T09:05:00.000Z",
      bootBy: "2026-09-18T09:10:00.000Z",
      registerBy: "2026-09-18T09:15:00.000Z",
      expiresAt: "2026-09-18T11:00:00.000Z",
      cleanupBy: "2026-09-18T11:05:00.000Z",
    },
  });
}

/** Drives one allocation from launch to a settled guest ready to go idle. */
const settledFixture = Effect.fn("settledFixture")(function* (input?: {
  readonly restoreFailure?: boolean;
  readonly environment?: {
    readonly environmentId: string;
    readonly repository: string;
    readonly start: string;
  };
}) {
  const harness = yield* fixture(
    input?.restoreFailure === undefined ? {} : { restoreFailure: input.restoreFailure },
  );
  if (input?.environment !== undefined) {
    yield* harness.controller.saveEnvironment(
      decodeEnvironmentSave({
        environmentId: input.environment.environmentId,
        name: "Web",
        source: { type: "saved", scope: "personal", owner: "victor" },
        repositories: [{ repository: input.environment.repository, defaultRef: "main" }],
        config: { image: "node:24", start: input.environment.start },
        secretReferences: [],
        occurredAt: "2026-09-17T02:55:00.000Z",
      }),
    );
  }
  yield* harness.controller.dispatch(launchCommand("allocation-1", true));
  yield* harness.reconciler.reconcileOnce();
  yield* harness.reconciler.reconcileOnce();
  yield* harness.reconciler.reconcileOnce();
  const registering = (yield* harness.controller.snapshot).allocations[0];
  if (registering === undefined) throw new Error("Expected an allocation");
  yield* harness.controller.dispatch(
    decodeCommand({
      type: "allocation.worker-registered",
      commandId: "register-allocation-1",
      allocationId: registering.id,
      attempt: registering.attempt,
      occurredAt: "2026-09-17T03:00:01.000Z",
      references: {
        workerId: "worker-1",
        environmentId: "environment-1",
        threadId: "thread-allocation-1",
      },
      route: {
        httpBaseUrl: "https://worker.example.test/",
        wsBaseUrl: "wss://worker.example.test/",
        accessToken: "worker-access-token",
      },
    }),
  );
  yield* harness.reconciler.reconcileOnce();
  yield* harness.reconciler.reconcileOnce();
  return harness;
});

it.effect("flushes a settled guest, then releases it when the idle window ends", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* settledFixture();

    yield* reconciler.reconcileOnce();
    const idle = (yield* controller.snapshot).allocations[0];
    expect(state.flushCalls).toBe(1);
    expect(idle?.idleState).toMatchObject({
      status: "idle",
      releaseAt: "2026-09-17T04:00:00.000Z",
      flush: { workspace: { status: "flushed" }, providerHome: { status: "unavailable" } },
    });

    yield* TestClock.setTime(Date.parse("2026-09-17T03:59:59.000Z"));
    yield* reconciler.reconcileOnce();
    expect(state.hibernateCalls).toBe(0);
    expect((yield* controller.snapshot).allocations[0]?.idleState.status).toBe("idle");

    yield* TestClock.setTime(Date.parse("2026-09-17T04:00:00.000Z"));
    yield* reconciler.reconcileOnce();
    expect(state.hibernateCalls).toBe(1);
    // The snapshot is recorded only once AWS reports the guest stopped.
    yield* reconciler.reconcileOnce();
    const hibernated = (yield* controller.snapshot).allocations[0];
    expect(hibernated?.idleState).toMatchObject({
      status: "hibernated",
      snapshot: { instanceId: "i-worker", attempt: 1 },
    });
    expect(state.terminateCalls).toBe(0);

    // The guest is stopped, so the compute meter stopped with it.
    const usage = (yield* controller.snapshot).usage[0];
    expect(usage?.elapsedWorkerSeconds).toBe(3_600);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("records the snapshot after a crash between the stop and its receipt", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, provider, runtimeProvider, reconciler, state } = yield* settledFixture();
    yield* reconciler.reconcileOnce();
    yield* TestClock.setTime(Date.parse("2026-09-17T04:00:00.000Z"));
    yield* reconciler.reconcileOnce();
    expect(state.hibernateCalls).toBe(1);
    expect((yield* controller.snapshot).allocations[0]?.idleState.status).toBe("idle");

    // The controller dies before writing the receipt. A fresh one rebuilds from
    // the persisted events and finds the guest already stopped.
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
      Effect.provideService(CloudRuntimeProvider, runtimeProvider),
    );
    yield* restartedReconciler.reconcileOnce();

    expect(state.hibernateCalls).toBe(1);
    expect((yield* restartedController.snapshot).allocations[0]?.idleState).toMatchObject({
      status: "hibernated",
      snapshot: { instanceId: "i-worker" },
    });
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("wakes a hibernated guest and reports disk and provider resume separately", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* settledFixture();
    yield* reconciler.reconcileOnce();
    yield* TestClock.setTime(Date.parse("2026-09-17T04:00:00.000Z"));
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();

    // A hibernated guest is not an abandoned worker, so the sweep leaves it.
    yield* reconciler.reconcileWorkersOnce();
    expect(state.terminateCalls).toBe(0);

    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00.000Z"));
    const woken = yield* controller.dispatch(
      followUpCommand("allocation-1", "2026-09-18T09:00:00.000Z", "run-2"),
    );
    expect(woken.attempt).toBe(2);
    expect(woken.idleState.status).toBe("waking");

    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    expect(state.restoreCalls).toBe(1);
    expect(state.launchCalls).toBe(1);
    const booting = (yield* controller.snapshot).allocations[0];
    expect(booting?.allocationState).toMatchObject({ status: "booting", instanceId: "i-worker" });

    yield* reconciler.reconcileOnce();
    const registering = (yield* controller.snapshot).allocations[0];
    if (registering === undefined) throw new Error("Expected an allocation");
    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.worker-registered",
        commandId: "register-allocation-1-attempt-2",
        allocationId: registering.id,
        attempt: registering.attempt,
        occurredAt: "2026-09-18T09:01:00.000Z",
        references: {
          workerId: "worker-1",
          environmentId: "environment-1",
          threadId: "thread-allocation-1",
        },
        route: {
          httpBaseUrl: "https://worker.example.test/",
          wsBaseUrl: "wss://worker.example.test/",
          accessToken: "worker-access-token-2",
        },
      }),
    );

    yield* reconciler.reconcileOnce();
    const restored = (yield* controller.snapshot).allocations[0];
    expect(restored?.idleState).toMatchObject({
      status: "busy",
      restore: {
        filesystem: { status: "resumed" },
        providerSession: { status: "not-resumed" },
      },
    });
    if (restored?.idleState.status === "busy" && restored.idleState.restore !== undefined) {
      expect(restored.idleState.restore.providerSession).toMatchObject({
        reason: "Provider homes live in runtime directories that a stop clears.",
      });
    }
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("reopens a hibernated guest by running the environment start, not a run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* settledFixture({
      environment: {
        environmentId: "environment-web",
        repository: "t3tools/t3code",
        start: "pnpm dev",
      },
    });
    yield* reconciler.reconcileOnce();
    yield* TestClock.setTime(Date.parse("2026-09-17T04:00:00.000Z"));
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    expect((yield* controller.snapshot).allocations[0]?.idleState.status).toBe("hibernated");
    const runsBefore = (yield* controller.snapshot).runs?.length ?? 0;
    const startCallsBefore = state.startCalls;

    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00.000Z"));
    const reopened = yield* controller.dispatch(
      decodeCommand({
        type: "allocation.reopen",
        commandId: "reopen-allocation-1",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-18T09:00:00.000Z",
        nextAttempt: 2,
        deadlines: {
          launchBy: "2026-09-18T09:05:00.000Z",
          bootBy: "2026-09-18T09:10:00.000Z",
          registerBy: "2026-09-18T09:15:00.000Z",
          expiresAt: "2026-09-18T11:00:00.000Z",
          cleanupBy: "2026-09-18T11:05:00.000Z",
        },
      }),
    );
    expect(reopened.attempt).toBe(2);
    expect(reopened.attemptPurpose).toBe("reopen");

    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    const registering = (yield* controller.snapshot).allocations[0];
    if (registering === undefined) throw new Error("Expected an allocation");
    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.worker-registered",
        commandId: "register-allocation-1-reopen",
        allocationId: registering.id,
        attempt: registering.attempt,
        occurredAt: "2026-09-18T09:01:00.000Z",
        references: {
          workerId: "worker-1",
          environmentId: "environment-1",
          threadId: "thread-allocation-1",
        },
        route: {
          httpBaseUrl: "https://worker.example.test/",
          wsBaseUrl: "wss://worker.example.test/",
          accessToken: "worker-access-token-reopen",
        },
      }),
    );

    // Restore, then the environment start. Neither step submits a turn.
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();

    const viewable = (yield* controller.snapshot).allocations[0];
    expect(state.reopenCalls).toBe(1);
    expect(state.startCalls).toBe(startCallsBefore);
    expect(viewable?.reopen).toMatchObject({ providerRunStarted: false });
    expect(viewable?.agentOutcome.status).toBe("succeeded");
    expect((yield* controller.snapshot).runs?.length ?? 0).toBe(runsBefore);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("snapshots and releases the guest when a person stops the session", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* settledFixture();
    yield* reconciler.reconcileOnce();
    expect((yield* controller.snapshot).allocations[0]?.idleState).toMatchObject({
      releaseAt: "2026-09-17T04:00:00.000Z",
    });

    // Well inside the idle window, so only the explicit stop can end it.
    yield* TestClock.setTime(Date.parse("2026-09-17T03:10:00.000Z"));
    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.session-stop",
        commandId: "stop-allocation-1",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:10:00.000Z",
      }),
    );

    yield* reconciler.reconcileOnce();
    expect(state.hibernateCalls).toBe(1);
    yield* reconciler.reconcileOnce();
    expect((yield* controller.snapshot).allocations[0]?.idleState).toMatchObject({
      status: "hibernated",
      snapshot: { instanceId: "i-worker", attempt: 1 },
    });
    // Stopping releases compute. It never terminates the disk behind it.
    expect(state.terminateCalls).toBe(0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("places a fresh guest when the snapshot cannot be started", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* settledFixture({ restoreFailure: true });
    yield* reconciler.reconcileOnce();
    yield* TestClock.setTime(Date.parse("2026-09-17T04:00:00.000Z"));
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();

    yield* TestClock.setTime(Date.parse("2026-09-18T09:00:00.000Z"));
    yield* controller.dispatch(
      followUpCommand("allocation-1", "2026-09-18T09:00:00.000Z", "run-2"),
    );
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    expect(state.restoreCalls).toBe(1);
    expect(state.launchCalls).toBe(2);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("packs two queued allocations when the controller has two worker slots", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const launched = new Set<string>();
    const controller = yield* CloudAllocationController.make({
      enabled: true,
      limits: {
        maxConcurrentWorkers: 2,
        maxQueueDepth: 8,
        maxRunSeconds: 7_200,
        maxInputWaitSeconds: 900,
        previewLeaseSeconds: 900,
        previewLeaseMaxSeconds: 3600,
        idleReleaseSeconds: 3_600,
        conversationRetentionDays: DEFAULT_CONVERSATION_RETENTION_DAYS,
        allowedInstanceTypes: ["t3.medium"],
      },
    });
    const provider = CloudWorkerProvider.of({
      runtimeKind: "firecracker",
      resolveLaunchTemplate: () => Effect.succeed({ id: "fc-linux-web", version: 1 }),
      findAttemptResources: () => Effect.succeed([]),
      listWorkers: () => Effect.succeed([]),
      inspectMacCapacity: () => Effect.die("unused"),
      allocateDedicatedHost: () => Effect.die("unused"),
      releaseDedicatedHost: () => Effect.die("unused"),
      launch: (launchInput) =>
        Effect.sync(() => {
          launched.add(launchInput.allocationId);
          return {
            instanceId: `fc:${launchInput.allocationId}`,
            state: "pending" as const,
            runtimeKind: "firecracker" as const,
          };
        }),
      revokeRegistrationCredential: () => Effect.void,
      hibernate: () => Effect.void,
      restore: () =>
        Effect.succeed({ instanceId: "fc-restored", state: "pending", runtimeKind: "firecracker" }),
      terminate: () => Effect.void,
    });
    const runtimeProvider = CloudRuntimeProvider.of({
      readiness: () =>
        Effect.succeed({
          provider: "daytona",
          admission: "enabled",
          authentication: "configured",
          reachability: "reachable",
          region: "us",
          resourceClass: "t3.medium",
          observedSandboxes: launched.size,
          readySandboxes: launched.size,
          detail: "Daytona is ready.",
        }),
      create: (input) =>
        Effect.sync(() => {
          launched.add(input.allocationId);
          return {
            provider: "daytona",
            runtimeId: `fc:${input.allocationId}`,
            region: "us",
            resourceClass: "t3.medium",
            lifecycleState: "started",
            allocationId: input.allocationId,
            attempt: input.attempt,
            agentId: input.agentId,
            runId: input.runId,
            observedAt: "2026-09-17T03:00:00.000Z",
          };
        }),
      inspect: () => Effect.succeed(undefined),
      list: () => Effect.succeed([]),
      start: () => Effect.die("unused"),
      stop: () => Effect.die("unused"),
      archive: () => Effect.die("unused"),
      delete: () => Effect.void,
      execute: () => Effect.die("unused"),
      ensureProcess: () => Effect.die("unused"),
      inspectProcess: () => Effect.die("unused"),
      deleteProcess: () => Effect.die("unused"),
      preview: () => Effect.die("unused"),
      snapshot: ({ name }) => Effect.succeed({ name }),
      desktop: () => Effect.die("unused"),
      resourceClass: "t3.medium",
    });
    const reconciler = yield* CloudAllocationReconciler.make().pipe(
      Effect.provideService(CloudAllocationController.CloudAllocationController, controller),
      Effect.provideService(
        CloudWorkerRegistration,
        CloudWorkerRegistration.of({
          issueCredential: () => Effect.succeed("registration-credential"),
          register: () => Effect.die("unused"),
        }),
      ),
      Effect.provideService(CloudWorkerProvider, provider),
      Effect.provideService(CloudRuntimeProvider, runtimeProvider),
    );
    yield* controller.dispatch(launchCommand("allocation-a"));
    yield* controller.dispatch(launchCommand("allocation-b"));
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();
    expect(launched.size).toBe(2);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("uses the environment build snapshot without calling the AWS launcher", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const { controller, reconciler, state } = yield* fixture();
    const builds = yield* makeBuilds();
    const warmPool = yield* makeWarmPool();
    const environment = yield* controller.saveEnvironment(
      decodeEnvironmentSave({
        environmentId: "environment-web",
        name: "Web",
        source: { type: "saved", scope: "personal", owner: "victor" },
        repositories: [{ repository: "t3tools/t3code", defaultRef: "main" }],
        config: { image: "node:24" },
        secretReferences: [],
        occurredAt: "2026-09-17T02:55:00.000Z",
      }),
    );
    yield* builds.start({
      buildId: CloudEnvironmentBuildId.make("build-1"),
      version: environment.current,
      trigger: "manual",
      draft: false,
      base: { kind: "image", image: "node:24" },
      inputsFingerprint: "f".repeat(64),
      startedAt: "2026-09-17T02:56:00.000Z",
    });
    yield* builds.complete({
      buildId: CloudEnvironmentBuildId.make("build-1"),
      gitSetup: [{ repository: "t3tools/t3code", defaultRef: "main", commit: "a".repeat(40) }],
      logs: [],
      timings: {},
      outcome: {
        status: "succeeded",
        snapshot: {
          id: "snap-1",
          digest: "b".repeat(64),
          sizeBytes: 1024,
          createdAt: "2026-09-17T02:58:00.000Z",
        },
        completedAt: "2026-09-17T02:58:00.000Z",
      },
    });
    yield* warmPool.start({
      id: CloudWarmGuestId.make("guest-warm-1"),
      key: {
        environmentId: environment.id,
        versionId: environment.current.id,
        profileId: "linux-web",
        buildId: CloudEnvironmentBuildId.make("build-1"),
      },
      snapshotId: "snap-1",
      startedAt: "2026-09-17T02:59:00.000Z",
    });
    yield* warmPool.markReady({
      guestId: CloudWarmGuestId.make("guest-warm-1"),
      bootTimeMs: 90,
      occurredAt: "2026-09-17T02:59:05.000Z",
    });

    yield* controller.dispatch(launchCommand("allocation-1"));
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();

    const booting = (yield* controller.snapshot).allocations[0];
    expect(state.launchCalls).toBe(1);
    expect(booting?.allocationState.status).toBe("booting");
    if (booting?.allocationState.status === "booting") {
      expect(booting.allocationState.instanceId).toBe("i-worker");
      expect(booting.allocationState.managedRuntime?.buildId).toBe("build-1");
    }

    yield* reconciler.reconcileOnce();
    expect((yield* controller.snapshot).allocations[0]?.allocationState.status).toBe("registering");
    expect(state.launchCalls).toBe(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
