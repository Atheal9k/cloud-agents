import {
  CloudAgentId,
  CloudRunId,
  RunAllocationAttempt,
  RunAllocationId,
  type CloudManagedRuntime,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import { make } from "./CloudRuntimeCleanupQueue.ts";

const firstSeenAt = "2026-09-21T01:00:00.000Z";
const runtime: CloudManagedRuntime = {
  provider: "daytona",
  runtimeId: "sandbox-lost",
  region: "us",
  resourceClass: "small",
  lifecycleState: "started",
  agentId: CloudAgentId.make("agent-lost"),
  runId: CloudRunId.make("run-lost"),
  allocationId: RunAllocationId.make("allocation-lost"),
  attempt: RunAllocationAttempt.make(2),
  observedAt: firstSeenAt,
};

it.effect("keeps lost Daytona resources visible until a retry resolves them", () =>
  Effect.gen(function* () {
    const queue = yield* make();
    const controller = yield* CloudAllocationController.make({ enabled: true });
    const first = yield* queue.recordFailure({
      runtime,
      error: "Daytona timed out after accepting delete.",
      occurredAt: firstSeenAt,
    });

    expect(first).toMatchObject({ status: "pending", attempts: 1, firstSeenAt });
    expect((yield* controller.snapshot).runtimeCleanupQueue).toEqual([first]);
    expect(yield* queue.due(firstSeenAt)).toEqual([]);

    const dueAt = first.nextRetryAt;
    const retrying = yield* queue.markRetrying(first, dueAt);
    expect(retrying.status).toBe("retrying");
    const second = yield* queue.recordFailure({
      runtime,
      error: "Daytona is still unavailable.",
      occurredAt: dueAt,
    });
    expect(second).toMatchObject({ attempts: 2, firstSeenAt });
    expect(Date.parse(second.nextRetryAt) - Date.parse(dueAt)).toBe(60_000);

    yield* queue.resolve(runtime.runtimeId);
    expect(yield* queue.list).toEqual([]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
