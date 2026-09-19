import {
  type CloudAdmissionControlInput,
  type CloudControllerDefaultsInput,
  CloudAgentDeletion,
  CloudAgentId,
  CloudAllocationControllerError,
  type CloudAllocationControllerMode,
  CloudAllocationLimits,
  type CloudAllocationSnapshot,
  type CloudAuditListInput,
  DEFAULT_IDLE_RELEASE_SECONDS,
  DEFAULT_PREVIEW_LEASE_MAX_SECONDS,
  DEFAULT_PREVIEW_LEASE_SECONDS,
  type CloudEnvironment,
  type CloudEnvironmentBuild,
  cloudEnvironmentBuildReference,
  type CloudEnvironmentBuildCancelInput,
  type CloudEnvironmentBuildError,
  type CloudEnvironmentBuildSaveInput,
  type CloudEnvironmentBuildStaleThresholdInput,
  type CloudEnvironmentError,
  type CloudEnvironmentResolution,
  type CloudEnvironmentResolutionInput,
  type CloudEnvironmentRestoreInput,
  type CloudEnvironmentSaveInput,
  type CloudRunResultId,
  type CloudRunUsage,
  type CloudInvoiceInput,
  type CloudSpendLimitInput,
  type CloudUsageExportInput,
  CloudWorkerPriceAssumption,
  admitCloudProviderExecution,
  admitLinuxAndroidWorker,
  admitMacIosWorker,
  DEFAULT_CONVERSATION_RETENTION_DAYS,
  isLinuxAndroidWorkerProfile,
  isMacIosWorkerProfile,
  macDedicatedHostUsageCost,
  RunAllocationEvent,
  RunAllocationId,
  type RunAllocation,
  type RunAllocationCommand,
  type CloudScmAccessPolicy,
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
import { resolveAwsWorkerConfig } from "./awsWorkerConfig.ts";
import { projectCloudControlPlane } from "./cloudControlPlane.ts";
import * as CloudAccountingCatalog from "./CloudAccountingCatalog.ts";
import {
  admitSpendLimit,
  auditActionForCommand,
  auditEvent,
  cloudUsageMeters,
  estimatedUsageUsd,
  exportUsageReport,
  principalOf,
  reconcileInvoices,
  spendLimitStatus,
  spendPeriodWindow,
} from "./cloudAccountingPolicy.ts";
import * as CloudEnvironmentBuildCatalog from "./CloudEnvironmentBuildCatalog.ts";
import { isCloudEnvironmentBuildStale } from "./cloudEnvironmentBuildPolicy.ts";
import * as CloudEnvironmentCatalog from "./CloudEnvironmentCatalog.ts";
import * as CloudMacHostCatalog from "./CloudMacHostCatalog.ts";
import * as CloudWarmPoolCatalog from "./CloudWarmPoolCatalog.ts";
import {
  admitCloudWorkspaceLaunch,
  cloudWorkspaceLaunchRepositories,
} from "./cloudWorkspacePolicy.ts";
import { planWarmPoolCapacity, warmPoolInventories } from "./cloudWarmPoolPolicy.ts";
import * as ControllerSettings from "./controllerSettings.ts";
import { attachCloudEnvSetupTurn } from "./cloudEnvSetupSkill.ts";
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
const DeletionRow = Schema.Struct({
  deletion: Schema.fromJsonString(CloudAgentDeletion),
});
const encodeDeletion = Schema.encodeSync(Schema.fromJsonString(CloudAgentDeletion));
const DEFAULT_LIMITS = {
  maxConcurrentWorkers: 1,
  maxQueueDepth: 8,
  maxRunSeconds: 3 * 24 * 60 * 60,
  maxInputWaitSeconds: 15 * 60,
  previewLeaseSeconds: DEFAULT_PREVIEW_LEASE_SECONDS,
  previewLeaseMaxSeconds: DEFAULT_PREVIEW_LEASE_MAX_SECONDS,
  idleReleaseSeconds: DEFAULT_IDLE_RELEASE_SECONDS,
  conversationRetentionDays: DEFAULT_CONVERSATION_RETENTION_DAYS,
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
    /**
     * Erases one agent's events and leaves a tombstone. Callers purge the
     * retained results first and pass what they removed, so the record cannot
     * claim an erasure that did not happen.
     */
    readonly purgeAllocation: (input: {
      readonly allocationId: RunAllocationId;
      readonly deletedAt: string;
      readonly purgedResultIds: ReadonlyArray<CloudRunResultId>;
    }) => Effect.Effect<CloudAgentDeletion, CloudAllocationControllerError>;
    readonly snapshot: Effect.Effect<CloudAllocationSnapshot, CloudAllocationControllerError>;
    readonly stream: Stream.Stream<CloudAllocationSnapshot, CloudAllocationControllerError>;
    readonly setAdmission: (
      input: CloudAdmissionControlInput,
    ) => Effect.Effect<CloudAllocationSnapshot, CloudAllocationControllerError>;
    readonly setDefaults: (
      input: CloudControllerDefaultsInput,
    ) => Effect.Effect<CloudAllocationSnapshot, CloudAllocationControllerError>;
    readonly setSpendLimit: (
      input: CloudSpendLimitInput,
    ) => Effect.Effect<CloudAllocationSnapshot, CloudAllocationControllerError>;
    readonly recordInvoice: (
      input: CloudInvoiceInput,
    ) => Effect.Effect<
      import("@t3tools/contracts").CloudInvoiceLine,
      CloudAllocationControllerError
    >;
    readonly exportUsage: (
      input: CloudUsageExportInput,
    ) => Effect.Effect<
      import("@t3tools/contracts").CloudUsageExport,
      CloudAllocationControllerError
    >;
    readonly listAudit: (
      input: CloudAuditListInput,
    ) => Effect.Effect<
      ReadonlyArray<import("@t3tools/contracts").CloudAuditEvent>,
      CloudAllocationControllerError
    >;
    readonly saveEnvironment: (
      input: CloudEnvironmentSaveInput,
    ) => Effect.Effect<CloudEnvironment, CloudAllocationControllerError | CloudEnvironmentError>;
    readonly restoreEnvironment: (
      input: CloudEnvironmentRestoreInput,
    ) => Effect.Effect<CloudEnvironment, CloudAllocationControllerError | CloudEnvironmentError>;
    readonly resolveEnvironment: (
      input: CloudEnvironmentResolutionInput,
    ) => Effect.Effect<
      CloudEnvironmentResolution | null,
      CloudAllocationControllerError | CloudEnvironmentError
    >;
    /** Republishes the snapshot after a Build settled outside the controller. */
    readonly refresh: Effect.Effect<CloudAllocationSnapshot, CloudAllocationControllerError>;
    readonly saveBuild: (
      input: CloudEnvironmentBuildSaveInput,
    ) => Effect.Effect<
      CloudEnvironmentBuild,
      CloudAllocationControllerError | CloudEnvironmentBuildError
    >;
    readonly cancelBuild: (
      input: CloudEnvironmentBuildCancelInput,
    ) => Effect.Effect<
      CloudEnvironmentBuild,
      CloudAllocationControllerError | CloudEnvironmentBuildError
    >;
    readonly setBuildStaleThreshold: (
      input: CloudEnvironmentBuildStaleThresholdInput,
    ) => Effect.Effect<
      CloudAllocationSnapshot,
      CloudAllocationControllerError | CloudEnvironmentBuildError
    >;
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
        "The cloud allocation catalog contains an invalid event.",
      )
    : controllerError("persistence-failed", "The cloud allocation catalog is unavailable.");
}

function replayEvents(
  events: ReadonlyArray<RunAllocationEvent>,
): Effect.Effect<RunAllocation | undefined, CloudAllocationControllerError> {
  return Effect.try({
    try: () => replayRunAllocationEvents(events),
    catch: () =>
      controllerError(
        "invalid-persisted-event",
        "The cloud allocation catalog contains an inconsistent event sequence.",
      ),
  });
}

/**
 * Queue depth counts allocations that want a running guest. A hibernated one
 * holds no worker, so an open conversation does not consume the queue an
 * active run needs.
 */
function waitingForAWorker(allocation: RunAllocation): boolean {
  return (
    allocation.cleanupState.status !== "succeeded" && allocation.idleState.status !== "hibernated"
  );
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
  readonly mode?: CloudAllocationControllerMode;
  readonly limits?: CloudAllocationLimits;
  readonly workerPriceAssumptions?: ReadonlyArray<CloudWorkerPriceAssumption>;
  readonly region?: string;
  /** CA-49 repository ceiling. Absent leaves every repository reachable. */
  readonly scmPolicy?: CloudScmAccessPolicy;
}) {
  const sql = yield* SqlClient.SqlClient;
  const environments = yield* CloudEnvironmentCatalog.make();
  const builds = yield* CloudEnvironmentBuildCatalog.make();
  const macHosts = yield* CloudMacHostCatalog.make();
  const warmPool = yield* CloudWarmPoolCatalog.make();
  const settings = yield* ControllerSettings.make();
  const accounting = yield* CloudAccountingCatalog.make();
  const mode = input.mode ?? "local";
  const region = input.region ?? "us-west-1";
  const changes = yield* PubSub.unbounded<CloudAllocationSnapshot>();
  const mutex = yield* Semaphore.make(1);
  const limits = input.limits ?? DEFAULT_LIMITS;
  const scmPolicy = input.scmPolicy;
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

  const readDeletion = SqlSchema.findAll({
    Request: AllocationIdRequest,
    Result: DeletionRow,
    execute: ({ allocationId }) => sql`
      SELECT deletion_json AS deletion
      FROM cloud_agent_deletions
      WHERE allocation_id = ${allocationId}
    `,
  });

  const readDeletionRows = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: DeletionRow,
    execute: () => sql`
      SELECT deletion_json AS deletion
      FROM cloud_agent_deletions
      ORDER BY deleted_at ASC, allocation_id ASC
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
          "Cloud allocations are disabled. Start T3 with --cloud-controller to use this server as the controller.",
        ),
      );

  /** Every write goes through here, so a fenced state directory cannot become
      a second writer after a cutover copied it to another host. */
  const requireWritable = Effect.gen(function* () {
    yield* requireEnabled;
    const row = yield* settings.read({}).pipe(Effect.mapError(persistenceError));
    const writability = ControllerSettings.writabilityFromRow(row);
    if (writability.status === "fenced") {
      return yield* controllerError(
        "controller-fenced",
        `${writability.reason} Adopt it with \`t3 cloud adopt\` on the controller that should own it.`,
      );
    }
  });

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
    hosts: ReadonlyArray<import("@t3tools/contracts").CloudMacHost>,
  ): CloudRunUsage => {
    // Compute is billed while a guest runs, and hibernation stops it. Summing
    // the running intervals is what keeps an open conversation from reporting
    // days of compute it never used.
    let runningSinceMillis: number | undefined;
    let elapsedWorkerMillis = 0;
    for (const event of events) {
      if (event.type === "allocation.instance-launched") {
        runningSinceMillis = Date.parse(event.occurredAt);
        continue;
      }
      if (event.type !== "allocation.hibernated" && event.type !== "allocation.cleanup-succeeded") {
        continue;
      }
      const stoppedMillis = Date.parse(event.occurredAt);
      if (runningSinceMillis !== undefined && Number.isFinite(stoppedMillis)) {
        elapsedWorkerMillis += Math.max(0, stoppedMillis - runningSinceMillis);
      }
      runningSinceMillis = undefined;
    }
    if (runningSinceMillis !== undefined && Number.isFinite(runningSinceMillis)) {
      elapsedWorkerMillis += Math.max(0, DateTime.toEpochMillis(now) - runningSinceMillis);
    }
    const elapsedWorkerSeconds = Math.ceil(elapsedWorkerMillis / 1_000);
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
            assumption: isMacIosWorkerProfile(allocation.profile)
              ? `${price.region} ${price.instanceType} guest runtime at $${price.hourlyUsd}/hour; Dedicated Host charges are recorded separately and survive job cancellation.`
              : `${price.region} ${price.instanceType} at $${price.hourlyUsd}/hour; excludes taxes and discounts.`,
          };
    const host = hosts.find(
      (candidate) =>
        candidate.occupiedBy?.allocationId === allocation.id ||
        (allocationInstanceId(allocation) !== undefined &&
          candidate.instanceId === allocationInstanceId(allocation)),
    );
    const dedicatedHost =
      host === undefined || price === undefined
        ? undefined
        : macDedicatedHostUsageCost({
            host,
            hourlyUsd: price.hourlyUsd,
            region: price.region,
            now: DateTime.formatIso(now),
          });
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
            mode === "local"
              ? "This allocation uses the local T3 controller, so no EC2 host charge is attributed."
              : "The permanent controller host is billed continuously, not per allocation.",
        },
        workerCompute,
        ...(dedicatedHost === undefined ? {} : { dedicatedHost }),
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
      meters: cloudUsageMeters({
        events,
        nowMs: DateTime.toEpochMillis(now),
        hourlyUsd: price?.hourlyUsd,
        rateAssumption: workerCompute.status === "estimated" ? workerCompute.assumption : undefined,
        hasSnapshot: allocation.idleState.status === "hibernated",
      }),
    };
  };

  const readSnapshot = Effect.gen(function* () {
    yield* requireEnabled;
    const [
      rows,
      deletionRows,
      controllerSettings,
      now,
      environmentCatalog,
      buildCatalog,
      macHostCatalog,
      warmGuests,
      timings,
      limitRows,
      attributions,
      invoices,
      audit,
    ] = yield* Effect.all([
      readAllEventRows({}),
      readDeletionRows({}),
      settings.read({}),
      DateTime.now,
      environments.list,
      builds.list,
      macHosts.list,
      warmPool.list,
      warmPool.timings,
      accounting.listLimitRows(),
      accounting.listAttributions(),
      accounting.listInvoices(),
      accounting.listAudit(100),
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
    const controlPlane = yield* Effect.try({
      try: () => projectCloudControlPlane(grouped.values()),
      catch: () =>
        controllerError(
          "invalid-persisted-event",
          "The cloud allocation catalog cannot rebuild its agent and run records.",
        ),
    });
    const nowIso = DateTime.formatIso(now);
    const usage = allocations.map((allocation) =>
      usageForAllocation(allocation, grouped.get(allocation.id) ?? [], now, macHostCatalog),
    );
    const usageByAllocation = new Map(usage.map((row) => [row.allocationId, row]));
    const spendLimits = limitRows.map((row) => {
      const principal = { kind: row.principalKind, id: row.principalId };
      const window = spendPeriodWindow(row.period, nowIso);
      const start = Date.parse(window.start);
      const end = Date.parse(window.end);
      const usedUsd = attributions.reduce((total, attribution) => {
        if (
          row.principalKind !== "team" &&
          (attribution.principalKind !== row.principalKind ||
            attribution.principalId !== row.principalId)
        ) {
          return total;
        }
        const allocation = allocations.find(
          (candidate) => candidate.id === attribution.allocationId,
        );
        if (allocation === undefined) return total;
        const created = Date.parse(allocation.createdAt);
        if (!Number.isFinite(created) || created < start || created >= end) return total;
        return total + estimatedUsageUsd(usageByAllocation.get(allocation.id)!);
      }, 0);
      return spendLimitStatus({
        principal,
        period: row.period,
        capUsd: row.capUsd,
        usedUsd,
        nowIso,
      });
    });
    const reconciledInvoices = reconcileInvoices({
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        source: invoice.source,
        dimension: invoice.dimension,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        invoicedUsd: invoice.invoicedUsd,
        recordedAt: invoice.recordedAt,
      })),
      usages: usage,
    });
    return {
      controller: {
        mode,
        requiresHostOnline: mode === "local",
        admission:
          controllerSettings.admissionOpen === 1
            ? { status: "open" }
            : {
                status: "stopped",
                stoppedAt: controllerSettings.admissionUpdatedAt ?? DateTime.formatIso(now),
              },
        writability: ControllerSettings.writabilityFromRow(controllerSettings),
        defaults: ControllerSettings.defaultsFromRow(controllerSettings),
      },
      limits,
      workerPriceAssumptions,
      spendingControl: spendLimits.length > 0 ? ("hard-cap" as const) : ("estimate-only" as const),
      allocations,
      agents: controlPlane.agents,
      runs: controlPlane.runs,
      runtimeAttempts: controlPlane.runtimeAttempts,
      environments: environmentCatalog,
      builds: buildCatalog,
      macHosts: macHostCatalog,
      warmGuests,
      capacity: planWarmPoolCapacity({
        inventories: warmPoolInventories({ guests: warmGuests, allocations }),
        timings,
      }),
      deletions: deletionRows.map((row) => row.deletion),
      usage,
      spendLimits,
      invoices: reconciledInvoices,
      audit,
    } satisfies CloudAllocationSnapshot;
  });

  const validateAdmission = (
    command: RunAllocationCommand,
    longRunning?: boolean,
    previousAllocation?: RunAllocation,
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
    if (command.type === "allocation.launch" && isMacIosWorkerProfile(command.profile)) {
      const admitted = admitMacIosWorker({
        profile: command.profile,
        region,
      });
      if (admitted.status === "rejected") {
        return controllerError("invalid-request", admitted.message);
      }
    }
    if (command.type === "allocation.launch" && isLinuxAndroidWorkerProfile(command.profile)) {
      const admitted = admitLinuxAndroidWorker({
        profile: command.profile,
        region,
      });
      if (admitted.status === "rejected") {
        return controllerError("invalid-request", admitted.message);
      }
    }
    /**
     * Every configured repository is checked before a worker is ever launched,
     * so a blocked submodule or extra checkout cannot widen the triggering
     * user's reach. Start-from-scratch skips the ceiling until a draft repo exists.
     */
    if (command.type === "allocation.launch") {
      const access = command.target.access;
      const repositories = cloudWorkspaceLaunchRepositories({
        primary: command.target.repository,
        additional: command.target.additionalRepositories,
      });
      const admitted = admitCloudWorkspaceLaunch({
        repositories,
        ...(longRunning === undefined ? {} : { longRunning }),
        ...(scmPolicy === undefined
          ? {}
          : {
              scm: {
                policy: scmPolicy,
                request: {
                  scope: access?.scope ?? "write",
                  userRepositories:
                    access?.userRepositories ?? repositories.map((entry) => entry.repository),
                  userScope: access?.userScope ?? "write",
                  configuredRepositories: repositories.map((entry) => entry.repository),
                },
              },
            }),
      });
      if (admitted.status === "rejected") {
        return controllerError("invalid-request", admitted.message);
      }
    }
    if (
      command.type !== "allocation.launch" &&
      command.type !== "allocation.retry" &&
      command.type !== "allocation.follow-up"
    )
      return undefined;
    if (
      (command.type === "allocation.launch" || command.type === "allocation.follow-up") &&
      command.execution !== undefined &&
      command.execution.unansweredRequestSeconds > limits.maxInputWaitSeconds
    ) {
      return controllerError(
        "invalid-request",
        `Cloud input may wait at most ${limits.maxInputWaitSeconds} seconds.`,
      );
    }
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
    if (command.type === "allocation.launch" || command.type === "allocation.follow-up") {
      const execution = command.execution;
      if (execution !== undefined) {
        const admitted = admitCloudProviderExecution({
          instanceId: execution.turn.modelSelection.instanceId,
          ...(previousAllocation?.execution === undefined
            ? {}
            : { previousInstanceId: previousAllocation.execution.turn.modelSelection.instanceId }),
        });
        if (admitted.status === "rejected") {
          return controllerError("invalid-request", admitted.message);
        }
      }
    }
    return undefined;
  };

  const dispatch: CloudAllocationController["Service"]["dispatch"] = (command) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireWritable;
        const deleted = yield* readDeletion({ allocationId: command.allocationId }).pipe(
          Effect.mapError(persistenceError),
        );
        if (deleted.length > 0) {
          return yield* controllerError(
            "agent-deleted",
            `Cloud agent for allocation '${command.allocationId}' was permanently deleted.`,
          );
        }
        const current = yield* readAllocation(command.allocationId);
        if (command.type === "allocation.launch" && current === undefined) {
          const snapshot = yield* readSnapshot;
          const linkedAgent = snapshot.agents?.find(
            (agent) => command.control !== undefined && agent.id === command.control.agentId,
          );
          if (linkedAgent?.status === "ACTIVE") {
            return yield* controllerError(
              "agent_busy",
              `Cloud agent '${linkedAgent.id}' already has an active run.`,
            );
          }
          if (linkedAgent?.status === "ARCHIVED") {
            return yield* controllerError(
              "agent-archived",
              `Cloud agent '${linkedAgent.id}' is archived.`,
            );
          }
          if (linkedAgent !== undefined) {
            return yield* controllerError(
              "invalid-request",
              `Cloud agent '${linkedAgent.id}' already exists. Submit a follow-up to its allocation instead.`,
            );
          }
          if (
            command.control !== undefined &&
            snapshot.runs?.some((run) => run.id === command.control?.runId) === true
          ) {
            return yield* controllerError(
              "run-already-exists",
              `Cloud run '${command.control.runId}' already exists.`,
            );
          }
          if (snapshot.controller.admission.status === "stopped") {
            return yield* controllerError(
              "admission-stopped",
              "Cloud run admission is stopped. Running jobs, results, and cleanup remain available.",
            );
          }
          const launchSpend = admitSpendLimit({
            principal: principalOf(command.principal),
            limits: snapshot.spendLimits ?? [],
          });
          if (launchSpend.status === "rejected") {
            return yield* controllerError("spend-limit-exceeded", launchSpend.message);
          }
          const invalid = validateAdmission(command, snapshot.controller.defaults?.longRunning);
          if (invalid !== undefined) return yield* invalid;
          const pending = snapshot.allocations.filter(waitingForAWorker).length;
          if (pending >= limits.maxConcurrentWorkers + limits.maxQueueDepth) {
            return yield* controllerError(
              "queue-full",
              `The cloud allocation queue is full at ${limits.maxQueueDepth} waiting jobs.`,
            );
          }
        }
        if (command.type === "allocation.follow-up" && current !== undefined) {
          if (current.handledCommandIds.includes(command.commandId)) return current;
          const snapshot = yield* readSnapshot;
          const agent = snapshot.agents?.find(
            (candidate) => candidate.allocationId === command.allocationId,
          );
          if (agent?.status === "ACTIVE") {
            return yield* controllerError(
              "agent_busy",
              `Cloud agent '${agent.id}' already has an active run.`,
            );
          }
          if (agent?.status === "ARCHIVED") {
            return yield* controllerError(
              "agent-archived",
              `Cloud agent '${agent.id}' is archived.`,
            );
          }
          if (snapshot.runs?.some((run) => run.id === command.runId) === true) {
            return yield* controllerError(
              "run-already-exists",
              `Cloud run '${command.runId}' already exists.`,
            );
          }
          if (snapshot.controller.admission.status === "stopped") {
            return yield* controllerError(
              "admission-stopped",
              "Cloud run admission is stopped. Running jobs, results, and cleanup remain available.",
            );
          }
          const followUpSpend = admitSpendLimit({
            principal: principalOf(command.principal),
            limits: snapshot.spendLimits ?? [],
          });
          if (followUpSpend.status === "rejected") {
            return yield* controllerError("spend-limit-exceeded", followUpSpend.message);
          }
          const invalid = validateAdmission(
            command,
            snapshot.controller.defaults?.longRunning,
            current,
          );
          if (invalid !== undefined) return yield* invalid;
        }
        if (
          command.type === "allocation.agent-archive" &&
          current !== undefined &&
          (current.agentOutcome.status === "not-started" ||
            current.agentOutcome.status === "running")
        ) {
          return yield* controllerError(
            "agent_busy",
            `Cloud agent for allocation '${current.id}' already has an active run.`,
          );
        }
        if (command.type === "allocation.retry" && current?.cleanupState.status === "succeeded") {
          const snapshot = yield* readSnapshot;
          if (snapshot.controller.admission.status === "stopped") {
            return yield* controllerError(
              "admission-stopped",
              "Cloud run admission is stopped. Running jobs, results, and cleanup remain available.",
            );
          }
          const retrySpend = admitSpendLimit({
            principal: principalOf(undefined),
            limits: snapshot.spendLimits ?? [],
          });
          if (retrySpend.status === "rejected") {
            return yield* controllerError("spend-limit-exceeded", retrySpend.message);
          }
          const invalid = validateAdmission(
            command,
            snapshot.controller.defaults?.longRunning,
            current,
          );
          if (invalid !== undefined) return yield* invalid;
          const pending = snapshot.allocations.filter(waitingForAWorker).length;
          if (pending >= limits.maxConcurrentWorkers + limits.maxQueueDepth) {
            return yield* controllerError(
              "queue-full",
              `The cloud allocation queue is full at ${limits.maxQueueDepth} waiting jobs.`,
            );
          }
        }
        const resolved =
          command.type === "allocation.launch" && current === undefined
            ? yield* environments
                .resolve({ repository: command.target.repository })
                .pipe(Effect.mapError(persistenceError))
            : null;
        /**
         * A stale Build is deliberately not pinned. The run then clones and
         * installs for itself rather than booting a snapshot whose refs, config,
         * or secrets may have moved on.
         */
        const pinnedBuild =
          resolved === null
            ? undefined
            : yield* Effect.gen(function* () {
                const environmentId = resolved.version.environmentId;
                const [activeBuild, staleThresholdSeconds] = yield* Effect.all([
                  builds.activeBuild(environmentId),
                  builds.staleThresholdSeconds(environmentId),
                ]).pipe(Effect.mapError(persistenceError));
                if (
                  activeBuild === undefined ||
                  isCloudEnvironmentBuildStale({
                    build: activeBuild,
                    staleThresholdSeconds,
                    now: command.occurredAt,
                  })
                ) {
                  return undefined;
                }
                return cloudEnvironmentBuildReference(activeBuild);
              });
        const launchCommand =
          command.type === "allocation.launch"
            ? {
                ...command,
                execution: {
                  ...command.execution,
                  turn: {
                    ...command.execution.turn,
                    prompt: attachCloudEnvSetupTurn({
                      prompt: command.execution.turn.prompt,
                      environmentInfo:
                        resolved === null
                          ? {}
                          : {
                              environmentId: resolved.version.environmentId,
                              environmentJsonPath:
                                resolved.version.source.type === "repository"
                                  ? resolved.version.source.path
                                  : null,
                            },
                    }).prompt,
                  },
                },
              }
            : command;
        const events = decideRunAllocationCommand(
          current,
          launchCommand,
          resolved === null ? undefined : resolved.reference,
          pinnedBuild,
        );
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
        if (command.type === "allocation.launch") {
          yield* accounting
            .attribute({
              allocationId: command.allocationId,
              principal: principalOf(command.principal),
              attributedAt: command.occurredAt,
            })
            .pipe(Effect.mapError(persistenceError));
        }
        const audited = auditActionForCommand(command.type);
        if (audited !== undefined) {
          yield* accounting
            .appendAudit(
              auditEvent({
                id: `audit:${command.commandId}`,
                occurredAt: command.occurredAt,
                actor: principalOf("principal" in command ? command.principal : undefined),
                action: audited,
                resourceType: command.type.startsWith("allocation.agent") ? "agent" : "run",
                resourceId: command.allocationId,
                summary: `${command.type} for allocation '${command.allocationId}'.`,
              }),
            )
            .pipe(Effect.catch(() => Effect.void));
        }

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

  /**
   * The event rows go, so the prompt, titles, and run history they carry go
   * with them: a permanent delete that only hid the conversation would not be
   * permanent. Erasing and tombstoning share one transaction, so a crash can
   * never leave an agent that replays without its own record of deletion.
   */
  const purgeAllocation: CloudAllocationController["Service"]["purgeAllocation"] = (request) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireWritable;
        const existing = yield* readDeletion({ allocationId: request.allocationId }).pipe(
          Effect.mapError(persistenceError),
        );
        const recorded = existing[0]?.deletion;
        if (recorded !== undefined) return recorded;
        const allocation = yield* readAllocation(request.allocationId);
        if (allocation === undefined) {
          return yield* controllerError(
            "allocation-not-found",
            `Cloud allocation '${request.allocationId}' does not exist.`,
          );
        }
        if (allocation.deletion?.status !== "requested") {
          return yield* controllerError(
            "invalid-request",
            `Cloud allocation '${request.allocationId}' has no delete to complete.`,
          );
        }
        const deletion = {
          agentId: allocation.control?.agentId ?? CloudAgentId.make(`agent:${allocation.id}`),
          allocationId: allocation.id,
          deletedAt: request.deletedAt,
          purgedResultIds: request.purgedResultIds,
          snapshots: "policy-expiry",
        } satisfies CloudAgentDeletion;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                DELETE FROM cloud_allocation_events
                WHERE allocation_id = ${allocation.id}
              `;
              yield* sql`
                INSERT INTO cloud_agent_deletions (allocation_id, deleted_at, deletion_json)
                VALUES (${allocation.id}, ${deletion.deletedAt}, ${encodeDeletion(deletion)})
              `;
            }),
          )
          .pipe(Effect.mapError(persistenceError));
        yield* PubSub.publish(changes, yield* readSnapshot);
        yield* Effect.logInfo("Cloud agent permanently deleted.", {
          allocationId: deletion.allocationId,
          agentId: deletion.agentId,
          purgedResults: deletion.purgedResultIds.length,
        });
        return deletion;
      }),
    );

  const setAdmission: CloudAllocationController["Service"]["setAdmission"] = (control) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireWritable;
        yield* settings.writeAdmission(control).pipe(Effect.mapError(persistenceError));
        yield* accounting
          .appendAudit(
            auditEvent({
              id: `audit:admission:${control.occurredAt}`,
              occurredAt: control.occurredAt,
              action: "admin",
              resourceType: "controller",
              resourceId: "admission",
              summary: control.admissionOpen
                ? "Opened cloud run admission."
                : "Stopped cloud run admission.",
            }),
          )
          .pipe(Effect.catch(() => Effect.void));
        const snapshot = yield* readSnapshot;
        yield* PubSub.publish(changes, snapshot);
        yield* Effect.logInfo("Cloud allocation admission changed.", {
          admissionStatus: snapshot.controller.admission.status,
        });
        return snapshot;
      }),
    );

  /** Defaults are a hint for new runs, so they stay writable while admission
      is stopped but not while the state is fenced. */
  const setDefaults: CloudAllocationController["Service"]["setDefaults"] = (control) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireWritable;
        yield* settings
          .writeDefaults({
            defaultModel: control.defaults.model ?? null,
            defaultRepository: control.defaults.repository ?? null,
            defaultRef: control.defaults.ref ?? null,
            defaultContext: control.defaults.context ?? null,
            defaultLongRunning:
              control.defaults.longRunning === undefined
                ? null
                : control.defaults.longRunning
                  ? 1
                  : 0,
            defaultComputerUse:
              control.defaults.computerUse === undefined
                ? null
                : control.defaults.computerUse
                  ? 1
                  : 0,
            defaultSummaries:
              control.defaults.summaries === undefined ? null : control.defaults.summaries ? 1 : 0,
            defaultArtifactsToGit:
              control.defaults.artifactsToGit === undefined
                ? null
                : control.defaults.artifactsToGit
                  ? 1
                  : 0,
            defaultCollaboration: control.defaults.collaboration ?? null,
            defaultSelfHostedMode: control.defaults.selfHostedMode ?? null,
          })
          .pipe(Effect.mapError(persistenceError));
        yield* accounting
          .appendAudit(
            auditEvent({
              id: `audit:defaults:${control.occurredAt}`,
              occurredAt: control.occurredAt,
              action: "admin",
              resourceType: "controller",
              resourceId: "defaults",
              summary: "Updated cloud launch defaults.",
            }),
          )
          .pipe(Effect.catch(() => Effect.void));
        const snapshot = yield* readSnapshot;
        yield* PubSub.publish(changes, snapshot);
        return snapshot;
      }),
    );

  const publishEnvironmentChange = <A>(effect: Effect.Effect<A, CloudEnvironmentError>) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireWritable;
        const result = yield* effect;
        yield* accounting
          .appendAudit(
            auditEvent({
              id: `audit:environment:${Date.now()}`,
              occurredAt: new Date().toISOString(),
              action: "config",
              resourceType: "environment",
              resourceId: "catalog",
              summary: "Updated a cloud environment version.",
            }),
          )
          .pipe(Effect.catch(() => Effect.void));
        yield* PubSub.publish(changes, yield* readSnapshot);
        return result;
      }),
    );

  const publishBuildChange = <A>(effect: Effect.Effect<A, CloudEnvironmentBuildError>) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireWritable;
        const result = yield* effect;
        yield* accounting
          .appendAudit(
            auditEvent({
              id: `audit:build:${Date.now()}`,
              occurredAt: new Date().toISOString(),
              action: "build-activation",
              resourceType: "build",
              resourceId: "catalog",
              summary: "Updated a cloud environment Build.",
            }),
          )
          .pipe(Effect.catch(() => Effect.void));
        yield* PubSub.publish(changes, yield* readSnapshot);
        return result;
      }),
    );

  const refresh: CloudAllocationController["Service"]["refresh"] = mutex.withPermits(1)(
    Effect.gen(function* () {
      const snapshot = yield* readSnapshot;
      yield* PubSub.publish(changes, snapshot);
      return snapshot;
    }),
  );

  const setSpendLimit: CloudAllocationController["Service"]["setSpendLimit"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireWritable;
        yield* accounting.upsertLimit(input).pipe(Effect.mapError(persistenceError));
        yield* accounting
          .appendAudit(
            auditEvent({
              id: `audit:spend:${input.principal.kind}:${input.principal.id}:${input.period}:${input.occurredAt}`,
              occurredAt: input.occurredAt,
              actor: input.principal,
              action: "admin",
              resourceType: "spend-limit",
              resourceId: `${input.principal.kind}:${input.principal.id}:${input.period}`,
              summary:
                input.capUsd === null
                  ? `Removed ${input.period} spend cap for ${input.principal.kind} '${input.principal.id}'.`
                  : `Set ${input.period} spend cap for ${input.principal.kind} '${input.principal.id}' to $${input.capUsd}.`,
            }),
          )
          .pipe(Effect.catch(() => Effect.void));
        const snapshot = yield* readSnapshot;
        yield* PubSub.publish(changes, snapshot);
        return snapshot;
      }),
    );

  const recordInvoice: CloudAllocationController["Service"]["recordInvoice"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireWritable;
        const snapshot = yield* readSnapshot;
        const [line] = reconcileInvoices({
          invoices: [
            {
              id: `invoice:${input.source}:${input.dimension}:${input.periodStart}`,
              source: input.source,
              dimension: input.dimension,
              periodStart: input.periodStart,
              periodEnd: input.periodEnd,
              invoicedUsd: input.invoicedUsd,
              recordedAt: input.occurredAt,
            },
          ],
          usages: snapshot.usage,
        });
        if (line === undefined) {
          return yield* controllerError("invalid-request", "The invoice could not be recorded.");
        }
        yield* accounting.recordInvoice(line).pipe(Effect.mapError(persistenceError));
        yield* accounting
          .appendAudit(
            auditEvent({
              id: `audit:invoice:${line.id}`,
              occurredAt: input.occurredAt,
              action: "admin",
              resourceType: "invoice",
              resourceId: line.id,
              summary: `Recorded ${input.source} invoice for ${input.dimension}.`,
            }),
          )
          .pipe(Effect.catch(() => Effect.void));
        yield* PubSub.publish(changes, yield* readSnapshot);
        return line;
      }),
    );

  const exportUsage: CloudAllocationController["Service"]["exportUsage"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireEnabled;
        const snapshot = yield* readSnapshot;
        return exportUsageReport({
          generatedAt: snapshot.usage[0]?.calculatedAt ?? input.periodEnd,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          usages: snapshot.usage,
          spendLimits: snapshot.spendLimits ?? [],
          invoices: snapshot.invoices ?? [],
        });
      }),
    );

  const listAudit: CloudAllocationController["Service"]["listAudit"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireEnabled;
        return yield* accounting
          .listAudit(input.limit ?? 100)
          .pipe(Effect.mapError(persistenceError));
      }),
    );

  const saveBuild: CloudAllocationController["Service"]["saveBuild"] = (input) =>
    publishBuildChange(builds.save(input));
  const cancelBuild: CloudAllocationController["Service"]["cancelBuild"] = (input) =>
    publishBuildChange(builds.cancel(input));
  const setBuildStaleThreshold: CloudAllocationController["Service"]["setBuildStaleThreshold"] = (
    input,
  ) => publishBuildChange(builds.setStaleThreshold(input)).pipe(Effect.flatMap(() => refresh));

  const saveEnvironment: CloudAllocationController["Service"]["saveEnvironment"] = (input) =>
    publishEnvironmentChange(environments.save(input));
  const restoreEnvironment: CloudAllocationController["Service"]["restoreEnvironment"] = (input) =>
    publishEnvironmentChange(environments.restore(input));
  const resolveEnvironment: CloudAllocationController["Service"]["resolveEnvironment"] = (input) =>
    environments.resolve(input);

  const snapshot = mutex.withPermits(1)(readSnapshot);
  const stream = Stream.unwrap(
    subscribeBeforeSnapshot(changes, readSnapshot, mutex).pipe(
      Effect.map(({ latest, changes: updates }) => Stream.concat(Stream.succeed(latest), updates)),
    ),
  );

  return CloudAllocationController.of({
    dispatch,
    purgeAllocation,
    snapshot,
    stream,
    setAdmission,
    setDefaults,
    setSpendLimit,
    recordInvoice,
    exportUsage,
    listAudit,
    refresh,
    saveBuild,
    cancelBuild,
    setBuildStaleThreshold,
    saveEnvironment,
    restoreEnvironment,
    resolveEnvironment,
  });
});

const CloudAllocationPolicyConfig = Config.all({
  maxQueueDepth: Config.int("T3CODE_CLOUD_MAX_QUEUE_DEPTH").pipe(Config.withDefault(8)),
  maxConcurrentWorkers: Config.int("T3CODE_CLOUD_MAX_CONCURRENT_WORKERS").pipe(
    Config.withDefault(1),
  ),
  maxRunSeconds: Config.int("T3CODE_CLOUD_MAX_RUN_SECONDS").pipe(
    Config.withDefault(3 * 24 * 60 * 60),
  ),
  maxInputWaitSeconds: Config.int("T3CODE_CLOUD_MAX_INPUT_WAIT_SECONDS").pipe(
    Config.withDefault(15 * 60),
  ),
  previewLeaseSeconds: Config.int("T3CODE_CLOUD_PREVIEW_LEASE_SECONDS").pipe(
    Config.withDefault(DEFAULT_PREVIEW_LEASE_SECONDS),
  ),
  previewLeaseMaxSeconds: Config.int("T3CODE_CLOUD_PREVIEW_LEASE_MAX_SECONDS").pipe(
    Config.withDefault(DEFAULT_PREVIEW_LEASE_MAX_SECONDS),
  ),
  idleReleaseSeconds: Config.int("T3CODE_CLOUD_IDLE_RELEASE_SECONDS").pipe(
    Config.withDefault(DEFAULT_IDLE_RELEASE_SECONDS),
  ),
  conversationRetentionDays: Config.int("T3CODE_CLOUD_CONVERSATION_RETENTION_DAYS").pipe(
    Config.withDefault(DEFAULT_CONVERSATION_RETENTION_DAYS),
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
      maxConcurrentWorkers: policy.maxConcurrentWorkers,
      maxQueueDepth: policy.maxQueueDepth,
      maxRunSeconds: policy.maxRunSeconds,
      maxInputWaitSeconds: policy.maxInputWaitSeconds,
      previewLeaseSeconds: policy.previewLeaseSeconds,
      previewLeaseMaxSeconds: policy.previewLeaseMaxSeconds,
      idleReleaseSeconds: policy.idleReleaseSeconds,
      conversationRetentionDays: policy.conversationRetentionDays,
      allowedInstanceTypes: workerPriceAssumptions.map((assumption) => assumption.instanceType),
    });
    // A malformed repository ceiling must stop the controller rather than
    // quietly admit runs with no ceiling at all.
    const security = yield* resolveAwsWorkerConfig().pipe(Effect.orDie);
    return yield* make({
      enabled: serverConfig.cloudControllerEnabled === true,
      mode: serverConfig.cloudControllerMode ?? "local",
      limits,
      workerPriceAssumptions,
      region: policy.region,
      scmPolicy: security.security.scm,
    });
  }),
);
