import * as NodeCrypto from "node:crypto";

import {
  CloudAllocationLimits,
  RunAllocationCommand,
  type CloudRunResultId,
  type RunAllocationId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAgentRetention from "./CloudAgentRetention.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudRunResults from "./CloudRunResults.ts";

const decodeCommand = Schema.decodeSync(RunAllocationCommand);
const decodeUnknownCommand = Schema.decodeUnknownSync(RunAllocationCommand);
const decodeLimits = Schema.decodeSync(CloudAllocationLimits);
const STARTED_AT = "2026-09-17T03:00:00.000Z";

/** Matches the retained-result identifier shape without the real capture. */
function resultIdFor(allocationId: string): CloudRunResultId {
  return NodeCrypto.createHash("sha256")
    .update(`${allocationId}:1`)
    .digest("hex") as CloudRunResultId;
}

function limits(conversationRetentionDays: number) {
  return decodeLimits({
    maxConcurrentWorkers: 1,
    maxQueueDepth: 8,
    maxRunSeconds: 7_200,
    maxInputWaitSeconds: 900,
    previewLeaseSeconds: 900,
    previewLeaseMaxSeconds: 3600,
    idleReleaseSeconds: 3_600,
    conversationRetentionDays,
    allowedInstanceTypes: ["t3.medium"],
  });
}

function launchCommand(allocationId: string) {
  return decodeCommand({
    type: "allocation.launch",
    commandId: `launch-${allocationId}`,
    allocationId,
    attempt: 1,
    occurredAt: STARTED_AT,
    target: {
      repository: "Atheal9k/cloud-agents",
      baseCommit: "afd7667ed",
      branch: "ca-46-retention",
    },
    control: { agentId: `agent-${allocationId}`, runId: `run-${allocationId}` },
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

/**
 * Drives one allocation to a hibernated guest through the real controller, so
 * the sweep reads the same projection the running system does.
 */
function hibernate(
  controller: CloudAllocationController.CloudAllocationController["Service"],
  allocationId: string,
) {
  return Effect.gen(function* () {
    const dispatch = (input: Record<string, unknown>) =>
      controller.dispatch(
        decodeUnknownCommand({
          allocationId,
          attempt: 1,
          occurredAt: STARTED_AT,
          ...input,
        }),
      );
    const flush = {
      userdata: { status: "flushed", detail: "Checkpointed the write-ahead log." },
      workspace: { status: "flushed", detail: "Captured the workspace checkpoint." },
      providerHome: { status: "unavailable", reason: "The provider home is a runtime directory." },
      flushedAt: STARTED_AT,
    };
    yield* controller.dispatch(launchCommand(allocationId));
    yield* dispatch({
      type: "allocation.launch-started",
      commandId: `${allocationId}-launch-started`,
      launchTemplate: { id: "lt-worker", version: 1 },
    });
    yield* dispatch({
      type: "allocation.instance-launched",
      commandId: `${allocationId}-instance-launched`,
      instanceId: `i-${allocationId}`,
    });
    yield* dispatch({ type: "allocation.worker-booted", commandId: `${allocationId}-booted` });
    yield* dispatch({
      type: "allocation.worker-registered",
      commandId: `${allocationId}-registered`,
      references: {
        workerId: `worker-${allocationId}`,
        environmentId: `environment-${allocationId}`,
        threadId: `thread-${allocationId}`,
      },
      route: {
        httpBaseUrl: "https://worker.example.test",
        wsBaseUrl: "wss://worker.example.test",
        accessToken: "worker-token",
      },
    });
    yield* dispatch({ type: "allocation.agent-started", commandId: `${allocationId}-started` });
    yield* dispatch({
      type: "allocation.agent-succeeded",
      commandId: `${allocationId}-succeeded`,
      resultLocation: { uri: `t3://environment-${allocationId}/thread-${allocationId}` },
    });
    yield* dispatch({
      type: "allocation.idle",
      commandId: `${allocationId}-idle`,
      releaseAt: "2026-09-17T04:00:00.000Z",
      flush,
    });
    return yield* dispatch({
      type: "allocation.hibernate",
      commandId: `${allocationId}-hibernate`,
      snapshot: { instanceId: `i-${allocationId}`, attempt: 1, flush, capturedAt: STARTED_AT },
    });
  });
}

function fixture(conversationRetentionDays = 0) {
  return Effect.gen(function* () {
    const purged: Array<{ allocationId: RunAllocationId; attempts: ReadonlyArray<number> }> = [];
    let expiredSweeps = 0;
    const controller = yield* CloudAllocationController.make({
      enabled: true,
      limits: limits(conversationRetentionDays),
    });
    const results = CloudRunResults.CloudRunResults.of({
      capture: () => Effect.die("unused"),
      status: () => Effect.die("unused"),
      readText: () => Effect.die("unused"),
      resolveDownload: () => Effect.die("unused"),
      startContinuation: () => Effect.die("unused"),
      purgeAllocation: (request) =>
        Effect.sync(() => {
          purged.push(request);
          return [resultIdFor(request.allocationId)] as ReadonlyArray<CloudRunResultId>;
        }),
      purgeExpired: Effect.sync(() => {
        expiredSweeps += 1;
        return [] as ReadonlyArray<CloudRunResultId>;
      }),
    });
    const retention = yield* CloudAgentRetention.make().pipe(
      Effect.provideService(
        CloudAllocationController.CloudAllocationController,
        CloudAllocationController.CloudAllocationController.of(controller),
      ),
      Effect.provideService(CloudRunResults.CloudRunResults, results),
    );
    return {
      controller,
      retention,
      purged,
      expiredSweeps: () => expiredSweeps,
    } as const;
  });
}

it.effect("collects an unused snapshot after its inactivity window and only once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(STARTED_AT));
    const { controller, retention } = yield* fixture();
    yield* hibernate(controller, "allocation-idle");

    yield* TestClock.setTime(Date.parse("2026-12-15T03:00:00.000Z"));
    yield* retention.sweepOnce();
    expect((yield* controller.snapshot).allocations[0]).toMatchObject({
      idleState: { status: "hibernated" },
      cleanupState: { status: "not-requested" },
    });

    yield* TestClock.setTime(Date.parse("2026-12-17T03:00:00.000Z"));
    yield* retention.sweepOnce();
    const collected = (yield* controller.snapshot).allocations[0];
    expect(collected).toMatchObject({
      idleState: { status: "busy" },
      cleanupState: { status: "requested" },
    });

    yield* retention.sweepOnce();
    expect((yield* controller.snapshot).allocations[0]?.sequence).toBe(collected?.sequence);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("keeps conversations indefinitely until an administrator caps them", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(STARTED_AT));
    const uncapped = yield* fixture();
    yield* hibernate(uncapped.controller, "allocation-kept");
    yield* TestClock.setTime(Date.parse("2030-01-01T00:00:00.000Z"));
    yield* uncapped.retention.sweepOnce();

    expect((yield* uncapped.controller.snapshot).allocations[0]?.deletion).toBeUndefined();
    expect(uncapped.purged).toEqual([]);
    expect(uncapped.expiredSweeps()).toBe(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("erases a capped conversation once its compute claim is released", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(STARTED_AT));
    const { controller, retention, purged } = yield* fixture(30);
    yield* hibernate(controller, "allocation-capped");
    yield* hibernate(controller, "allocation-fresh");

    yield* TestClock.setTime(Date.parse("2026-10-18T03:00:00.000Z"));
    yield* retention.sweepOnce();
    const requested = (yield* controller.snapshot).allocations;
    expect(requested.map((allocation) => allocation.deletion?.status)).toEqual([
      "requested",
      "requested",
    ]);
    // Nothing is erased while the guests are still claimed.
    expect(purged).toEqual([]);

    for (const allocation of requested) {
      for (const type of ["allocation.cleanup-started", "allocation.cleanup-succeeded"]) {
        yield* controller.dispatch(
          decodeUnknownCommand({
            type,
            commandId: `${allocation.id}-${type}`,
            allocationId: allocation.id,
            attempt: allocation.attempt,
            occurredAt: "2026-10-18T03:05:00.000Z",
          }),
        );
      }
    }
    yield* retention.sweepOnce();

    expect(purged).toEqual([
      { allocationId: "allocation-capped", attempts: [1] },
      { allocationId: "allocation-fresh", attempts: [1] },
    ]);
    const swept = yield* controller.snapshot;
    expect(swept.allocations).toEqual([]);
    expect(swept.agents).toEqual([]);
    expect(swept.deletions).toEqual([
      {
        agentId: "agent-allocation-capped",
        allocationId: "allocation-capped",
        deletedAt: "2026-10-18T03:00:00.000Z",
        purgedResultIds: [resultIdFor("allocation-capped")],
        snapshots: "policy-expiry",
      },
      {
        agentId: "agent-allocation-fresh",
        allocationId: "allocation-fresh",
        deletedAt: "2026-10-18T03:00:00.000Z",
        purgedResultIds: [resultIdFor("allocation-fresh")],
        snapshots: "policy-expiry",
      },
    ]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("never collects an agent whose run is still in flight", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(STARTED_AT));
    const { controller, retention, purged } = yield* fixture(1);
    yield* controller.dispatch(launchCommand("allocation-running"));

    yield* TestClock.setTime(Date.parse("2030-01-01T00:00:00.000Z"));
    yield* retention.sweepOnce();

    const untouched = (yield* controller.snapshot).allocations[0];
    expect(untouched?.deletion).toBeUndefined();
    expect(untouched?.cleanupState.status).toBe("not-requested");
    expect(purged).toEqual([]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
