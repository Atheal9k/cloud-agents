import {
  CloudEnvironmentBuildId,
  CloudEnvironmentSaveInput,
  RunAllocationCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make } from "./CloudAllocationController.ts";
import { make as makeBuilds } from "./CloudEnvironmentBuildCatalog.ts";
import * as ControllerSettings from "./controllerSettings.ts";

const decodeCommand = Schema.decodeSync(RunAllocationCommand);
const decodeEnvironmentSave = Schema.decodeSync(CloudEnvironmentSaveInput);

const launchInput = {
  type: "allocation.launch",
  commandId: "command-launch",
  allocationId: "allocation-1",
  attempt: 1,
  occurredAt: "2026-09-17T03:00:00.000Z",
  target: {
    repository: "t3tools/t3code",
    baseCommit: "afd7667ed",
    branch: "ca-04a-local-controller",
  },
  execution: {
    threadId: "thread-allocation-1-1",
    title: "Fix the cloud launch flow",
    selectedRef: "main",
    unansweredRequestSeconds: 900,
    turn: {
      commandId: "command-launch",
      messageId: "message-allocation-1",
      prompt: "Fix the cloud launch flow",
      attachments: [],
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-09-17T03:00:00.000Z",
    },
  },
  profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
  deadlines: {
    launchBy: "2026-09-17T03:05:00.000Z",
    bootBy: "2026-09-17T03:10:00.000Z",
    registerBy: "2026-09-17T03:15:00.000Z",
    expiresAt: "2026-09-17T05:00:00.000Z",
    cleanupBy: "2026-09-17T05:05:00.000Z",
  },
} as const;
const launch = decodeCommand(launchInput);

it.effect("keeps the local allocation controller opt-in", () =>
  Effect.gen(function* () {
    const controller = yield* make({ enabled: false });
    const error = yield* controller.snapshot.pipe(Effect.flip);

    expect(error.reason).toBe("controller-disabled");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rejects admission beyond the durable queue bound", () =>
  Effect.gen(function* () {
    const controller = yield* make({
      enabled: true,
      limits: {
        maxConcurrentWorkers: 1,
        maxQueueDepth: 0,
        maxRunSeconds: 7_200,
        maxInputWaitSeconds: 900,
        previewGraceSeconds: 900,
        idleReleaseSeconds: 3_600,
        allowedInstanceTypes: ["t3.medium"],
      },
    });
    yield* controller.dispatch(launch);
    const error = yield* controller
      .dispatch(
        decodeCommand({
          ...launchInput,
          commandId: "command-launch-2",
          allocationId: "allocation-2",
        }),
      )
      .pipe(Effect.flip);

    expect(error.reason).toBe("queue-full");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rejects macOS iOS admission in us-west-1 instead of placing elsewhere", () =>
  Effect.gen(function* () {
    const controller = yield* make({
      enabled: true,
      region: "us-west-1",
      limits: {
        maxConcurrentWorkers: 1,
        maxQueueDepth: 8,
        maxRunSeconds: 7_200,
        maxInputWaitSeconds: 900,
        previewGraceSeconds: 900,
        idleReleaseSeconds: 3_600,
        allowedInstanceTypes: ["mac2-m2.metal"],
      },
    });
    const error = yield* controller
      .dispatch(
        decodeCommand({
          ...launchInput,
          profile: {
            id: "macos-ios",
            os: "darwin",
            arch: "arm64",
            device: "ios",
            instanceType: "mac2-m2.metal",
          },
        }),
      )
      .pipe(Effect.flip);

    expect(error.reason).toBe("invalid-request");
    expect(error.message).toContain("us-west-1");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("admits an Apple Silicon iOS worker in a supported Mac region", () =>
  Effect.gen(function* () {
    const controller = yield* make({
      enabled: true,
      region: "us-west-2",
      limits: {
        maxConcurrentWorkers: 1,
        maxQueueDepth: 8,
        maxRunSeconds: 7_200,
        maxInputWaitSeconds: 900,
        previewGraceSeconds: 900,
        idleReleaseSeconds: 3_600,
        allowedInstanceTypes: ["mac2-m2.metal"],
      },
    });
    const allocation = yield* controller.dispatch(
      decodeCommand({
        ...launchInput,
        profile: {
          id: "macos-ios",
          os: "darwin",
          arch: "arm64",
          device: "ios",
          instanceType: "mac2-m2.metal",
        },
      }),
    );

    expect(allocation.profile).toMatchObject({
      id: "macos-ios",
      os: "darwin",
      device: "ios",
      instanceType: "mac2-m2.metal",
    });
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("persists allocation events and rebuilds the catalog after restart", () =>
  Effect.gen(function* () {
    const firstController = yield* make({ enabled: true });
    const launched = yield* firstController.dispatch(launch);
    const duplicate = yield* firstController.dispatch(launch);

    expect(launched.allocationState.status).toBe("queued");
    expect(duplicate).toEqual(launched);

    const sql = yield* SqlClient.SqlClient;
    const eventCount = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM cloud_allocation_events
    `;
    expect(eventCount[0]?.count).toBe(1);

    const restartedController = yield* make({ enabled: true });
    const snapshot = yield* restartedController.snapshot;

    expect(snapshot.controller).toEqual({
      mode: "local",
      requiresHostOnline: true,
      admission: { status: "open" },
      writability: { status: "writable" },
    });
    expect(snapshot.limits.maxRunSeconds).toBe(3 * 24 * 60 * 60);
    expect(snapshot.allocations).toEqual([launched]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("pins the resolved environment version when an agent starts", () =>
  Effect.gen(function* () {
    const controller = yield* make({ enabled: true });
    const environment = decodeEnvironmentSave({
      environmentId: "web-environment",
      name: "Web",
      source: { type: "saved", scope: "personal", owner: "victor" },
      repositories: [{ repository: "t3tools/t3code", defaultRef: "main" }],
      config: { image: "node:24" },
      secretReferences: [],
      occurredAt: "2026-09-17T02:55:00.000Z",
    });
    yield* controller.saveEnvironment(environment);
    const first = yield* controller.dispatch(launch);
    yield* controller.saveEnvironment(
      decodeEnvironmentSave({
        ...environment,
        expectedVersion: 1,
        config: { image: "node:24.8" },
        occurredAt: "2026-09-17T03:01:00.000Z",
      }),
    );
    const second = yield* controller.dispatch(
      decodeCommand({
        ...launchInput,
        commandId: "command-launch-version-2",
        allocationId: "allocation-version-2",
      }),
    );

    expect(first.environment).toMatchObject({
      environmentId: "web-environment",
      version: 1,
    });
    expect(second.environment).toMatchObject({
      environmentId: "web-environment",
      version: 2,
    });
    expect((yield* controller.snapshot).environments?.[0]?.history).toHaveLength(2);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("surfaces the environment catalog's reason instead of a generic failure", () =>
  Effect.gen(function* () {
    const controller = yield* make({ enabled: true });
    yield* controller.saveEnvironment(
      decodeEnvironmentSave({
        environmentId: "committed-environment",
        name: "Committed",
        source: {
          type: "repository",
          repository: "t3tools/t3code",
          path: ".cursor/environment.json",
          commit: "abc123",
        },
        repositories: [{ repository: "t3tools/t3code", defaultRef: "main" }],
        config: { image: "node:24" },
        secretReferences: [],
        occurredAt: "2026-09-17T02:55:00.000Z",
      }),
    );
    const error = yield* controller
      .saveEnvironment(
        decodeEnvironmentSave({
          environmentId: "dashboard-environment",
          name: "Dashboard",
          source: { type: "saved", scope: "personal", owner: "victor" },
          repositories: [{ repository: "t3tools/t3code", defaultRef: "main" }],
          config: { image: "node:20" },
          secretReferences: [],
          occurredAt: "2026-09-17T02:56:00.000Z",
        }),
      )
      .pipe(Effect.flip);

    expect(error.reason).toBe("repository-environment-exists");
    expect(error.message).toContain(".cursor/environment.json");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rejects invalid shapes and run durations before allocation", () =>
  Effect.gen(function* () {
    const controller = yield* make({ enabled: true });
    const invalidShape = yield* controller
      .dispatch(
        decodeCommand({
          ...launchInput,
          profile: { ...launchInput.profile, instanceType: "m7i.48xlarge" },
        }),
      )
      .pipe(Effect.flip);
    const invalidDuration = yield* controller
      .dispatch(
        decodeCommand({
          ...launchInput,
          commandId: "command-long-run",
          allocationId: "allocation-long-run",
          deadlines: {
            ...launchInput.deadlines,
            expiresAt: "2026-09-20T03:00:01.000Z",
            cleanupBy: "2026-09-20T03:10:01.000Z",
          },
        }),
      )
      .pipe(Effect.flip);
    const invalidInputWait = yield* controller
      .dispatch(
        decodeCommand({
          ...launchInput,
          commandId: "command-long-input-wait",
          allocationId: "allocation-long-input-wait",
          execution: {
            ...launchInput.execution,
            unansweredRequestSeconds: 901,
          },
        }),
      )
      .pipe(Effect.flip);

    expect(invalidShape.reason).toBe("invalid-request");
    expect(invalidDuration.reason).toBe("invalid-request");
    expect(invalidInputWait.reason).toBe("invalid-request");
    expect((yield* controller.snapshot).allocations).toEqual([]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("persists stopped admission without blocking control of accepted runs", () =>
  Effect.gen(function* () {
    const controller = yield* make({ enabled: true });
    const accepted = yield* controller.dispatch(launch);
    yield* controller.setAdmission({
      admissionOpen: false,
      occurredAt: "2026-09-17T03:01:00.000Z",
    });
    const rejected = yield* controller
      .dispatch(
        decodeCommand({
          ...launchInput,
          commandId: "command-launch-while-stopped",
          allocationId: "allocation-while-stopped",
        }),
      )
      .pipe(Effect.flip);
    const cancelled = yield* controller.dispatch(
      decodeCommand({
        type: "allocation.cancel",
        commandId: "command-cancel-accepted",
        allocationId: accepted.id,
        attempt: accepted.attempt,
        occurredAt: "2026-09-17T03:02:00.000Z",
      }),
    );
    const restarted = yield* make({ enabled: true });

    expect(rejected.reason).toBe("admission-stopped");
    expect(cancelled.cleanupState.status).toBe("requested");
    expect((yield* restarted.snapshot).controller.admission).toEqual({
      status: "stopped",
      stoppedAt: "2026-09-17T03:01:00.000Z",
    });
    const reopened = yield* restarted.setAdmission({
      admissionOpen: true,
      occurredAt: "2026-09-17T03:03:00.000Z",
    });
    const acceptedAfterReopen = yield* restarted.dispatch(
      decodeCommand({
        ...launchInput,
        commandId: "command-launch-after-reopen",
        allocationId: "allocation-after-reopen",
      }),
    );
    expect(reopened.controller.admission.status).toBe("open");
    expect(acceptedAfterReopen.allocationState.status).toBe("queued");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("reports elapsed worker time and categorized estimate assumptions", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-17T03:00:00.000Z"));
    const controller = yield* make({ enabled: true });
    const accepted = yield* controller.dispatch(launch);
    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.launch-started",
        commandId: "command-launch-started",
        allocationId: accepted.id,
        attempt: accepted.attempt,
        occurredAt: "2026-09-17T03:00:00.000Z",
        launchTemplate: { id: "lt-worker", version: 1 },
      }),
    );
    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.instance-launched",
        commandId: "command-instance-launched",
        allocationId: accepted.id,
        attempt: accepted.attempt,
        occurredAt: "2026-09-17T03:00:00.000Z",
        instanceId: "i-worker",
      }),
    );
    yield* TestClock.setTime(Date.parse("2026-09-17T04:00:00.000Z"));

    const snapshot = yield* controller.snapshot;
    const usage = snapshot.usage[0];
    expect(usage?.elapsedWorkerSeconds).toBe(3_600);
    expect(usage?.instanceType).toBe("t3.medium");
    expect(usage?.costs.workerCompute).toMatchObject({ status: "estimated", usd: 0.0496 });
    expect(usage?.costs.controllerHost.status).toBe("not-attributed");
    expect(usage?.costs.provider.status).toBe("unknown");
    expect(usage?.costs.storage.status).toBe("unknown");
    expect(usage?.costs.streamingTransfer.status).toBe("unknown");
    expect(snapshot.spendingControl).toBe("estimate-only");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("keeps one durable agent across runs and rejects active-run races", () =>
  Effect.gen(function* () {
    const controller = yield* make({ enabled: true });
    const controlledLaunch = decodeCommand({
      ...launchInput,
      control: { agentId: "agent-1", runId: "run-1" },
    });
    let allocation = yield* controller.dispatch(controlledLaunch);
    const duplicateAgent = yield* controller
      .dispatch(
        decodeCommand({
          ...launchInput,
          commandId: "command-duplicate-agent",
          allocationId: "allocation-2",
          control: { agentId: "agent-1", runId: "run-duplicate" },
        }),
      )
      .pipe(Effect.flip);

    expect(duplicateAgent.reason).toBe("agent_busy");
    expect((yield* controller.snapshot).agents).toEqual([
      expect.objectContaining({ id: "agent-1", status: "ACTIVE", activeRunId: "run-1" }),
    ]);

    const dispatch = (input: typeof RunAllocationCommand.Encoded) =>
      controller.dispatch(decodeCommand(input));
    allocation = yield* dispatch({
      type: "allocation.launch-started",
      commandId: "command-start-launch",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:00:01.000Z",
      launchTemplate: { id: "lt-worker", version: 1 },
    });
    allocation = yield* dispatch({
      type: "allocation.instance-launched",
      commandId: "command-instance",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:00:02.000Z",
      instanceId: "i-worker",
    });
    allocation = yield* dispatch({
      type: "allocation.worker-booted",
      commandId: "command-booted",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:00:03.000Z",
    });
    allocation = yield* dispatch({
      type: "allocation.worker-registered",
      commandId: "command-registered",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:00:04.000Z",
      references: {
        workerId: "worker-1",
        environmentId: "environment-1",
        threadId: "thread-allocation-1-1",
      },
      route: {
        httpBaseUrl: "https://worker.example.test",
        wsBaseUrl: "wss://worker.example.test",
        accessToken: "worker-token",
      },
    });
    allocation = yield* dispatch({
      type: "allocation.agent-started",
      commandId: "command-run-started",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:00:05.000Z",
    });
    allocation = yield* dispatch({
      type: "allocation.agent-succeeded",
      commandId: "command-run-finished",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:00:06.000Z",
      resultLocation: { uri: "s3://results/run-1" },
    });

    expect((yield* controller.snapshot).agents?.[0]).toMatchObject({
      id: "agent-1",
      status: "IDLE",
    });

    allocation = yield* dispatch({
      type: "allocation.follow-up",
      commandId: "command-follow-up",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:01:00.000Z",
      runId: "run-2",
      execution: {
        ...launchInput.execution,
        title: "Review the result",
        turn: {
          ...launchInput.execution.turn,
          commandId: "command-follow-up",
          messageId: "message-follow-up",
          prompt: "Review the result",
          createdAt: "2026-09-17T03:01:00.000Z",
        },
      },
      deadlines: {
        launchBy: "2026-09-17T03:06:00.000Z",
        bootBy: "2026-09-17T03:11:00.000Z",
        registerBy: "2026-09-17T03:16:00.000Z",
        expiresAt: "2026-09-17T05:01:00.000Z",
        cleanupBy: "2026-09-17T05:06:00.000Z",
      },
    });
    const activeSnapshot = yield* controller.snapshot;
    expect(activeSnapshot.agents?.[0]).toMatchObject({
      id: "agent-1",
      status: "ACTIVE",
      activeRunId: "run-2",
    });
    expect(activeSnapshot.runs?.map((run) => [run.id, run.status])).toEqual([
      ["run-1", "FINISHED"],
      ["run-2", "CREATING"],
    ]);

    const busyFollowUp = yield* dispatch({
      type: "allocation.follow-up",
      commandId: "command-follow-up-race",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:01:01.000Z",
      runId: "run-3",
      execution: launchInput.execution,
      deadlines: launchInput.deadlines,
    }).pipe(Effect.flip);
    const busyArchive = yield* dispatch({
      type: "allocation.agent-archive",
      commandId: "command-archive-race",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:01:02.000Z",
    }).pipe(Effect.flip);
    expect(busyFollowUp.reason).toBe("agent_busy");
    expect(busyArchive.reason).toBe("agent_busy");

    allocation = yield* dispatch({
      type: "allocation.cancel",
      commandId: "command-cancel-follow-up",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:01:03.000Z",
    });
    allocation = yield* dispatch({
      type: "allocation.agent-archive",
      commandId: "command-archive",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:01:04.000Z",
    });
    expect((yield* controller.snapshot).agents?.[0]).toMatchObject({
      id: "agent-1",
      status: "ARCHIVED",
    });

    yield* dispatch({
      type: "allocation.agent-unarchive",
      commandId: "command-unarchive",
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:01:05.000Z",
    });
    expect((yield* controller.snapshot).agents?.[0]).toMatchObject({
      id: "agent-1",
      status: "IDLE",
    });
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("reports a permanent controller as not needing this host online", () =>
  Effect.gen(function* () {
    const controller = yield* make({ enabled: true, mode: "permanent" });
    const snapshot = yield* controller.snapshot;

    expect(snapshot.controller.mode).toBe("permanent");
    expect(snapshot.controller.requiresHostOnline).toBe(false);
    expect(snapshot.usage).toEqual([]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("refuses every write once its state directory is fenced", () =>
  Effect.gen(function* () {
    const settings = yield* ControllerSettings.make();
    yield* settings.writeFence({
      fencedAt: "2026-09-19T10:00:00.000Z",
      reason: "Moved to the permanent controller.",
    });

    const controller = yield* make({ enabled: true });
    const snapshot = yield* controller.snapshot;
    expect(snapshot.controller.writability).toEqual({
      status: "fenced",
      fencedAt: "2026-09-19T10:00:00.000Z",
      reason: "Moved to the permanent controller.",
    });

    const launchError = yield* controller.dispatch(launch).pipe(Effect.flip);
    expect(launchError.reason).toBe("controller-fenced");
    const admissionError = yield* controller
      .setAdmission({ admissionOpen: true, occurredAt: "2026-09-19T10:01:00.000Z" })
      .pipe(Effect.flip);
    expect(admissionError.reason).toBe("controller-fenced");

    // Adoption clears the fence but deliberately leaves admission stopped, so
    // a restored copy cannot take work between starting up and being checked.
    yield* settings.clearFence({});
    const stillStopped = yield* controller.dispatch(launch).pipe(Effect.flip);
    expect(stillStopped.reason).toBe("admission-stopped");

    yield* controller.setAdmission({
      admissionOpen: true,
      occurredAt: "2026-09-19T10:02:00.000Z",
    });
    const adopted = yield* controller.dispatch(launch);
    expect(adopted.allocationState.status).toBe("queued");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("pins the active Build for a launch and skips one that went stale", () =>
  Effect.gen(function* () {
    const controller = yield* make({ enabled: true });
    const builds = yield* makeBuilds();
    const environment = yield* controller.saveEnvironment(
      decodeEnvironmentSave({
        environmentId: "web-environment",
        name: "Web",
        source: { type: "saved", scope: "personal", owner: "victor" },
        repositories: [{ repository: "t3tools/t3code", defaultRef: "main" }],
        config: { image: "node:24", install: "pnpm install" },
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
          id: "build-1",
          digest: "b".repeat(64),
          sizeBytes: 1024,
          createdAt: "2026-09-17T02:58:00.000Z",
        },
        completedAt: "2026-09-17T02:58:00.000Z",
      },
    });

    // A feature-branch run boots the Build, then checks out the ref it asked for.
    const fresh = yield* controller.dispatch(launch);
    expect(fresh.build).toMatchObject({
      buildId: "build-1",
      snapshot: { id: "build-1" },
      gitSetup: [{ repository: "t3tools/t3code", commit: "a".repeat(40) }],
    });
    expect(fresh.execution?.selectedRef).toBe("main");

    const stale = yield* controller.dispatch(
      decodeCommand({
        ...launchInput,
        commandId: "command-launch-stale",
        allocationId: "allocation-stale",
        occurredAt: "2026-09-19T03:00:00.000Z",
        deadlines: {
          launchBy: "2026-09-19T03:05:00.000Z",
          bootBy: "2026-09-19T03:10:00.000Z",
          registerBy: "2026-09-19T03:15:00.000Z",
          expiresAt: "2026-09-19T05:00:00.000Z",
          cleanupBy: "2026-09-19T05:05:00.000Z",
        },
      }),
    );
    expect(stale.build).toBeUndefined();
    expect((yield* controller.snapshot).builds).toHaveLength(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
