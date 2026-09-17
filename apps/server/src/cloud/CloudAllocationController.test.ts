import { RunAllocationCommand } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make } from "./CloudAllocationController.ts";

const decodeCommand = Schema.decodeSync(RunAllocationCommand);

const launch = decodeCommand({
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
  profile: { id: "linux-web", os: "linux", arch: "x64" },
  deadlines: {
    launchBy: "2026-09-17T03:05:00.000Z",
    expiresAt: "2026-09-17T05:00:00.000Z",
    cleanupBy: "2026-09-17T05:05:00.000Z",
  },
});

it.effect("keeps the local allocation controller opt-in", () =>
  Effect.gen(function* () {
    const controller = yield* make({ enabled: false });
    const error = yield* controller.snapshot.pipe(Effect.flip);

    expect(error.reason).toBe("controller-disabled");
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

    expect(snapshot.controller).toEqual({ mode: "local", requiresHostOnline: true });
    expect(snapshot.allocations).toEqual([launched]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
