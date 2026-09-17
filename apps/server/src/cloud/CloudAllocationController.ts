import {
  CloudAdmissionControlInput,
  CloudAllocationControllerError,
  CloudAllocationLimits,
  type CloudAllocationSnapshot,
  type CloudRunUsage,
  CloudWorkerPriceAssumption,
  RunAllocationEvent,
  RunAllocationId,
  type RunAllocation,
  type RunAllocationCommand,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
const AdmissionRow = Schema.Struct({
  admissionOpen: Schema.Int,
  updatedAt: Schema.NullOr(Schema.String),
});

const DEFAULT_LIMITS = {
  maxConcurrentWorkers: 1,
  maxQueueDepth: 8,
  maxRunSeconds: 2 * 60 * 60,
  maxInputWaitSeconds: 15 * 60,
  previewGraceSeconds: 15 * 60,
  allowedInstanceTypes: ["t3.medium"],
} as const satisfies CloudAllocationLimits;

const DEFAULT_WORKER_PRICE_ASSUMPTIONS = [
  {
    instanceType: "t3.medium",
    hourlyUsd: 0.0496,
    region: "us-west-1",
    description: "Configured Linux on-demand worker rate. Taxes and discounts are excluded.",
  },
] as const satisfies ReadonlyArray<CloudWorkerPriceAssumption>;
const decodeWorkerPriceAssumptions = Schema.decodeEffect(
  Schema.Array(CloudWorkerPriceAssumption).pipe(Schema.check(Schema.isMinLength(1))),
);
const decodeCloudAllocationLimits = Schema.decodeEffect(CloudAllocationLimits);

export class CloudAllocationController extends Context.Service<
  CloudAllocationController,
  {
    readonly dispatch: (
      command: RunAllocationCommand,
    ) => Effect.Effect<RunAllocation, CloudAllocationControllerError>;
    readonly snapshot: Effect.Effect<CloudAllocationSnapshot, CloudAllocationControllerError>;
    readonly stream: Stream.Stream<CloudAllocationSnapshot, CloudAllocationControllerError>;
    readonly setAdmission: (
      input: CloudAdmissionControlInput,
    ) => Effect.Effect<CloudAllocationSnapshot, CloudAllocationControllerError>;
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

function allocationInstanceId(allocation: RunAllocation): string | undefined {
  switch (allocation.allocationState.status) {
    case "booting":
    case "registering":
    case "ready":
      return allocation.allocationState.instanceId;
    case "failed":
      return allocation.allocationState.instanceId;
    case "queued":
    case "launching":
      return undefined;
  }
}

export const make = Effect.fn("CloudAllocationController.make")(function* (input: {
  readonly enabled: boolean;
  readonly limits?: CloudAllocationLimits;
  readonly workerPriceAssumptions?: ReadonlyArray<CloudWorkerPriceAssumption>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<CloudAllocationSnapshot>();
  const mutex = yield* Semaphore.make(1);
  const limits = input.limits ?? DEFAULT_LIMITS;
  const workerPriceAssumptions = input.workerPriceAssumptions ?? DEFAULT_WORKER_PRICE_ASSUMPTIONS;

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

  const readAdmission = SqlSchema.findOne({
    Request: EmptyRequest,
    Result: AdmissionRow,
    execute: () => sql`
      SELECT
        admission_open AS "admissionOpen",
        admission_updated_at AS "updatedAt"
      FROM cloud_controller_settings
      WHERE singleton_id = 1
    `,
  });

  const writeAdmission = SqlSchema.void({
    Request: CloudAdmissionControlInput,
    execute: ({ admissionOpen, occurredAt }) => sql`
      UPDATE cloud_controller_settings
      SET
        admission_open = ${admissionOpen ? 1 : 0},
        admission_updated_at = ${occurredAt}
      WHERE singleton_id = 1
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

  const usageForAllocation = (
    allocation: RunAllocation,
    events: ReadonlyArray<RunAllocationEvent>,
    now: DateTime.Utc,
  ): CloudRunUsage => {
    const workerStartedAt = events.find(
      (event) =>
        event.attempt === allocation.attempt && event.type === "allocation.instance-launched",
    )?.occurredAt;
    const workerStoppedAt = events.findLast(
      (event) =>
        event.attempt === allocation.attempt && event.type === "allocation.cleanup-succeeded",
    )?.occurredAt;
    const startMillis = workerStartedAt === undefined ? undefined : Date.parse(workerStartedAt);
    const endMillis =
      workerStoppedAt === undefined ? DateTime.toEpochMillis(now) : Date.parse(workerStoppedAt);
    const elapsedWorkerSeconds =
      startMillis === undefined || !Number.isFinite(startMillis) || !Number.isFinite(endMillis)
        ? 0
        : Math.max(0, Math.ceil((endMillis - startMillis) / 1_000));
    const instanceType = allocation.profile.instanceType;
    const price = workerPriceAssumptions.find(
      (assumption) => assumption.instanceType === instanceType,
    );
    const workerCompute =
      price === undefined
        ? {
            status: "unknown" as const,
            reason: "No worker hourly-rate assumption is configured for this instance type.",
          }
        : {
            status: "estimated" as const,
            usd:
              Math.round(
                ((elapsedWorkerSeconds / 3_600) * price.hourlyUsd + Number.EPSILON) * 1e6,
              ) / 1e6,
            assumption: `${price.region} ${price.instanceType} at $${price.hourlyUsd}/hour; excludes taxes and discounts.`,
          };
    return {
      allocationId: allocation.id,
      attempt: allocation.attempt,
      calculatedAt: DateTime.formatIso(now),
      elapsedWorkerSeconds,
      ...(instanceType === undefined ? {} : { instanceType }),
      deadlines: allocation.deadlines,
      costs: {
        controllerHost: {
          status: "not-attributed",
          reason:
            "This allocation uses the local T3 controller, so no EC2 host charge is attributed.",
        },
        workerCompute,
        storage: {
          status: "unknown",
          reason: "Worker and retained-result storage are billed separately from compute.",
        },
        provider: {
          status: "unknown",
          reason: "The selected provider does not report attributable usage for this allocation.",
        },
        streamingTransfer: {
          status: "unknown",
          reason: "Preview and display transfer are not metered by the controller.",
        },
      },
    };
  };

  const readSnapshot = Effect.gen(function* () {
    yield* requireEnabled;
    const [rows, admission, now] = yield* Effect.all([
      readAllEventRows({}),
      readAdmission({}),
      DateTime.now,
    ]).pipe(Effect.mapError(persistenceError));
    const grouped = new Map<RunAllocationId, Array<RunAllocationEvent>>();
    for (const row of rows) {
      const events = grouped.get(row.event.allocationId) ?? [];
      events.push(row.event);
      grouped.set(row.event.allocationId, events);
    }
    const allocations = yield* Effect.forEach(grouped.values(), replayEvents).pipe(
      Effect.map((values) => values.filter((value): value is RunAllocation => value !== undefined)),
    );
    return {
      controller: {
        mode: "local",
        requiresHostOnline: true,
        admission:
          admission.admissionOpen === 1
            ? { status: "open" }
            : { status: "stopped", stoppedAt: admission.updatedAt ?? DateTime.formatIso(now) },
      },
      limits,
      workerPriceAssumptions,
      spendingControl: "estimate-only",
      allocations,
      usage: allocations.map((allocation) =>
        usageForAllocation(allocation, grouped.get(allocation.id) ?? [], now),
      ),
    } satisfies CloudAllocationSnapshot;
  });

  const validateAdmission = (
    command: RunAllocationCommand,
  ): CloudAllocationControllerError | undefined => {
    const instanceType =
      command.type === "allocation.launch" ? command.profile.instanceType : undefined;
    if (command.type === "allocation.launch" && instanceType === undefined) {
      return controllerError(
        "invalid-request",
        "Cloud worker requests must select an instance type.",
      );
    }
    if (
      command.type === "allocation.launch" &&
      instanceType !== undefined &&
      !limits.allowedInstanceTypes.includes(instanceType)
    ) {
      return controllerError(
        "invalid-request",
        `Instance type '${instanceType}' is not allowed by this controller.`,
      );
    }
    if (command.type !== "allocation.launch" && command.type !== "allocation.retry")
      return undefined;
    const occurredAt = Date.parse(command.occurredAt);
    const expiresAt = Date.parse(command.deadlines.expiresAt);
    const timestamps = [
      occurredAt,
      Date.parse(command.deadlines.launchBy),
      Date.parse(command.deadlines.bootBy),
      Date.parse(command.deadlines.registerBy),
      expiresAt,
      Date.parse(command.deadlines.cleanupBy),
    ];
    if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) {
      return controllerError("invalid-request", "Cloud run deadlines must be valid timestamps.");
    }
    let previous = timestamps[0] ?? Number.NaN;
    for (const timestamp of timestamps.slice(1)) {
      if (timestamp < previous) {
        return controllerError(
          "invalid-request",
          "Cloud run deadlines must be in chronological order.",
        );
      }
      previous = timestamp;
    }
    if (expiresAt - occurredAt > limits.maxRunSeconds * 1_000) {
      return controllerError(
        "invalid-request",
        `Cloud runs may last at most ${limits.maxRunSeconds} seconds.`,
      );
    }
    return undefined;
  };

  const dispatch: CloudAllocationController["Service"]["dispatch"] = (command) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireEnabled;
        const current = yield* readAllocation(command.allocationId);
        if (command.type === "allocation.launch" && current === undefined) {
          const snapshot = yield* readSnapshot;
          if (snapshot.controller.admission.status === "stopped") {
            return yield* controllerError(
              "admission-stopped",
              "Cloud run admission is stopped. Running jobs, results, and cleanup remain available.",
            );
          }
          const invalid = validateAdmission(command);
          if (invalid !== undefined) return yield* invalid;
          const pending = snapshot.allocations.filter(
            (allocation) => allocation.cleanupState.status !== "succeeded",
          ).length;
          if (pending >= limits.maxConcurrentWorkers + limits.maxQueueDepth) {
            return yield* controllerError(
              "queue-full",
              `The cloud allocation queue is full at ${limits.maxQueueDepth} waiting jobs.`,
            );
          }
        }
        if (command.type === "allocation.retry" && current?.cleanupState.status === "succeeded") {
          const snapshot = yield* readSnapshot;
          if (snapshot.controller.admission.status === "stopped") {
            return yield* controllerError(
              "admission-stopped",
              "Cloud run admission is stopped. Running jobs, results, and cleanup remain available.",
            );
          }
          const invalid = validateAdmission(command);
          if (invalid !== undefined) return yield* invalid;
          const pending = snapshot.allocations.filter(
            (allocation) => allocation.cleanupState.status !== "succeeded",
          ).length;
          if (pending >= limits.maxConcurrentWorkers + limits.maxQueueDepth) {
            return yield* controllerError(
              "queue-full",
              `The cloud allocation queue is full at ${limits.maxQueueDepth} waiting jobs.`,
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
        const instanceId = allocationInstanceId(next);
        yield* Effect.logInfo("Cloud allocation state changed.", {
          allocationId: next.id,
          attempt: next.attempt,
          commandType: command.type,
          allocationStatus: next.allocationState.status,
          agentStatus: next.agentOutcome.status,
          cleanupStatus: next.cleanupState.status,
          ...(instanceId === undefined ? {} : { instanceId }),
          ...(next.allocationState.status === "ready"
            ? {
                workerId: next.allocationState.references.workerId,
                threadId: next.allocationState.references.threadId,
              }
            : {}),
        });
        return next;
      }),
    );

  const setAdmission: CloudAllocationController["Service"]["setAdmission"] = (control) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireEnabled;
        yield* writeAdmission(control).pipe(Effect.mapError(persistenceError));
        const snapshot = yield* readSnapshot;
        yield* PubSub.publish(changes, snapshot);
        yield* Effect.logInfo("Cloud allocation admission changed.", {
          admissionStatus: snapshot.controller.admission.status,
        });
        return snapshot;
      }),
    );

  const snapshot = mutex.withPermits(1)(readSnapshot);
  const stream = Stream.unwrap(
    subscribeBeforeSnapshot(changes, readSnapshot, mutex).pipe(
      Effect.map(({ latest, changes: updates }) => Stream.concat(Stream.succeed(latest), updates)),
    ),
  );

  return CloudAllocationController.of({ dispatch, snapshot, stream, setAdmission });
});

const CloudAllocationPolicyConfig = Config.all({
  maxQueueDepth: Config.int("T3CODE_CLOUD_MAX_QUEUE_DEPTH").pipe(Config.withDefault(8)),
  maxRunSeconds: Config.int("T3CODE_CLOUD_MAX_RUN_SECONDS").pipe(Config.withDefault(2 * 60 * 60)),
  maxInputWaitSeconds: Config.int("T3CODE_CLOUD_MAX_INPUT_WAIT_SECONDS").pipe(
    Config.withDefault(15 * 60),
  ),
  previewGraceSeconds: Config.int("T3CODE_CLOUD_PREVIEW_GRACE_SECONDS").pipe(
    Config.withDefault(15 * 60),
  ),
  workerPrices: Config.string("T3CODE_CLOUD_WORKER_PRICES").pipe(
    Config.withDefault("t3.medium=0.0496"),
  ),
  region: Config.string("T3CODE_CLOUD_AWS_REGION").pipe(Config.withDefault("us-west-1")),
});

export const layer = Layer.effect(
  CloudAllocationController,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const policy = yield* CloudAllocationPolicyConfig;
    const workerPriceAssumptions = yield* decodeWorkerPriceAssumptions(
      policy.workerPrices.split(",").map((entry) => {
        const [instanceType = "", hourlyUsd = ""] = entry.split("=");
        return {
          instanceType: instanceType.trim(),
          hourlyUsd: Number(hourlyUsd),
          region: policy.region,
          description: "Configured Linux on-demand worker rate. Taxes and discounts are excluded.",
        };
      }),
    );
    const limits = yield* decodeCloudAllocationLimits({
      maxConcurrentWorkers: 1,
      maxQueueDepth: policy.maxQueueDepth,
      maxRunSeconds: policy.maxRunSeconds,
      maxInputWaitSeconds: policy.maxInputWaitSeconds,
      previewGraceSeconds: policy.previewGraceSeconds,
      allowedInstanceTypes: workerPriceAssumptions.map((assumption) => assumption.instanceType),
    });
    return yield* make({
      enabled: serverConfig.cloudControllerEnabled === true,
      limits,
      workerPriceAssumptions,
    });
  }),
);
