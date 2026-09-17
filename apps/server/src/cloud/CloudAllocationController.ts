import {
  CloudAllocationControllerError,
  type CloudAllocationSnapshot,
  RunAllocationEvent,
  RunAllocationId,
  type RunAllocation,
  type RunAllocationCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as ServerConfig from "../config.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import {
  decideRunAllocationCommand,
  projectRunAllocationEvent,
  replayRunAllocationEvents,
} from "./runAllocation.ts";

const AllocationIdRequest = Schema.Struct({ allocationId: RunAllocationId });
const EmptyRequest = Schema.Struct({});
const PersistedEventRow = Schema.Struct({
  event: Schema.fromJsonString(RunAllocationEvent),
});

const controllerStatus = {
  mode: "local",
  requiresHostOnline: true,
} as const;

export class CloudAllocationController extends Context.Service<
  CloudAllocationController,
  {
    readonly dispatch: (
      command: RunAllocationCommand,
    ) => Effect.Effect<RunAllocation, CloudAllocationControllerError>;
    readonly snapshot: Effect.Effect<CloudAllocationSnapshot, CloudAllocationControllerError>;
    readonly stream: Stream.Stream<CloudAllocationSnapshot, CloudAllocationControllerError>;
  }
>()("t3/cloud/CloudAllocationController") {}

function controllerError(
  reason: CloudAllocationControllerError["reason"],
  message: string,
): CloudAllocationControllerError {
  return new CloudAllocationControllerError({ reason, message });
}

function persistenceError(cause: unknown): CloudAllocationControllerError {
  return Schema.isSchemaError(cause)
    ? controllerError(
        "invalid-persisted-event",
        "The local cloud allocation catalog contains an invalid event.",
      )
    : controllerError("persistence-failed", "The local cloud allocation catalog is unavailable.");
}

function replayEvents(
  events: ReadonlyArray<RunAllocationEvent>,
): Effect.Effect<RunAllocation | undefined, CloudAllocationControllerError> {
  return Effect.try({
    try: () => replayRunAllocationEvents(events),
    catch: () =>
      controllerError(
        "invalid-persisted-event",
        "The local cloud allocation catalog contains an inconsistent event sequence.",
      ),
  });
}

export const make = Effect.fn("CloudAllocationController.make")(function* (input: {
  readonly enabled: boolean;
  readonly maxQueueDepth?: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<CloudAllocationSnapshot>();
  const mutex = yield* Semaphore.make(1);

  const readEventsByAllocation = SqlSchema.findAll({
    Request: AllocationIdRequest,
    Result: PersistedEventRow,
    execute: ({ allocationId }) => sql`
      SELECT event_json AS event
      FROM cloud_allocation_events
      WHERE allocation_id = ${allocationId}
      ORDER BY sequence ASC
    `,
  });

  const readAllEventRows = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: PersistedEventRow,
    execute: () => sql`
      SELECT event_json AS event
      FROM cloud_allocation_events
      ORDER BY allocation_id ASC, sequence ASC
    `,
  });

  const appendEvent = SqlSchema.void({
    Request: RunAllocationEvent,
    execute: (event) => sql`
      INSERT INTO cloud_allocation_events (
        allocation_id,
        sequence,
        command_id,
        attempt,
        occurred_at,
        event_json
      ) VALUES (
        ${event.allocationId},
        ${event.sequence},
        ${event.commandId},
        ${event.attempt},
        ${event.occurredAt},
        ${JSON.stringify(event)}
      )
    `,
  });

  const requireEnabled = input.enabled
    ? Effect.void
    : Effect.fail(
        controllerError(
          "controller-disabled",
          "Cloud allocations are disabled. Start T3 with --cloud-controller to use this server as the local controller.",
        ),
      );

  const readAllocation = Effect.fn("CloudAllocationController.readAllocation")(function* (
    allocationId: RunAllocationId,
  ) {
    const rows = yield* readEventsByAllocation({ allocationId }).pipe(
      Effect.mapError(persistenceError),
    );
    return yield* replayEvents(rows.map((row) => row.event));
  });

  const readSnapshot = Effect.gen(function* () {
    yield* requireEnabled;
    const rows = yield* readAllEventRows({}).pipe(Effect.mapError(persistenceError));
    const grouped = new Map<RunAllocationId, Array<RunAllocationEvent>>();
    for (const row of rows) {
      const events = grouped.get(row.event.allocationId) ?? [];
      events.push(row.event);
      grouped.set(row.event.allocationId, events);
    }
    const allocations = yield* Effect.forEach(grouped.values(), replayEvents).pipe(
      Effect.map((values) => values.filter((value): value is RunAllocation => value !== undefined)),
    );
    return { controller: controllerStatus, allocations } satisfies CloudAllocationSnapshot;
  });

  const dispatch: CloudAllocationController["Service"]["dispatch"] = (command) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireEnabled;
        const current = yield* readAllocation(command.allocationId);
        if (command.type === "allocation.launch" && current === undefined) {
          const snapshot = yield* readSnapshot;
          const queued = snapshot.allocations.filter(
            (allocation) => allocation.cleanupState.status !== "succeeded",
          ).length;
          if (queued >= (input.maxQueueDepth ?? 32)) {
            return yield* controllerError(
              "queue-full",
              `The cloud allocation queue is full at ${input.maxQueueDepth ?? 32} jobs.`,
            );
          }
        }
        const events = decideRunAllocationCommand(current, command);
        if (events.length === 0) {
          if (current === undefined) {
            return yield* controllerError(
              "allocation-not-found",
              `Cloud allocation '${command.allocationId}' does not exist.`,
            );
          }
          return current;
        }

        yield* sql
          .withTransaction(Effect.forEach(events, appendEvent, { discard: true }))
          .pipe(Effect.mapError(persistenceError));

        const [firstEvent, ...remainingEvents] = events;
        if (firstEvent === undefined) {
          return yield* controllerError(
            "invalid-persisted-event",
            "The allocation command produced no event.",
          );
        }
        let next = projectRunAllocationEvent(current, firstEvent);
        for (const event of remainingEvents) {
          next = projectRunAllocationEvent(next, event);
        }
        const snapshot = yield* readSnapshot;
        yield* PubSub.publish(changes, snapshot);
        return next;
      }),
    );

  const snapshot = mutex.withPermits(1)(readSnapshot);
  const stream = Stream.unwrap(
    subscribeBeforeSnapshot(changes, readSnapshot, mutex).pipe(
      Effect.map(({ latest, changes: updates }) => Stream.concat(Stream.succeed(latest), updates)),
    ),
  );

  return CloudAllocationController.of({ dispatch, snapshot, stream });
});

export const layer = Layer.effect(
  CloudAllocationController,
  Effect.flatMap(ServerConfig.ServerConfig, (config) =>
    make({ enabled: config.cloudControllerEnabled === true }),
  ),
);
