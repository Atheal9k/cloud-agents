import {
  RunAllocationCommand,
  type RunAllocation,
  type RunRuntimeFlush,
  type RunRuntimeSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import {
  hasAgentSettled,
  idleReleaseAt,
  isIdleReleaseDue,
  retainedRuntimeSnapshot,
  runDeadlineApplies,
} from "./cloudHibernationPolicy.ts";
import * as CloudWorkerRegistration from "./CloudWorkerRegistration.ts";
import * as CloudWorkerProvider from "./CloudWorkerProvider.ts";
import * as CloudWorkerRunClient from "./CloudWorkerRunClient.ts";
import type { CloudWorkerResource } from "./CloudWorkerProvider.ts";

const MAX_LAUNCH_FAILURES = 3;
const decodeCommand = Schema.decodeUnknownEffect(RunAllocationCommand);

function commandId(
  allocation: RunAllocation,
  action: string,
  discriminator?: string | number,
): string {
  return ["ca08", allocation.id, allocation.attempt, action, discriminator]
    .filter((part) => part !== undefined)
    .join(":");
}

function hasPassed(now: DateTime.Utc, deadline: string): boolean {
  return DateTime.toEpochMillis(now) >= Date.parse(deadline);
}

function recordedInstanceId(allocation: RunAllocation): string | undefined {
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

function orderedAllocations(
  allocations: ReadonlyArray<RunAllocation>,
): ReadonlyArray<RunAllocation> {
  return [...allocations].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

/**
 * A guest that answered nothing about its own state still has to become idle,
 * or a worker the controller cannot reach would hold compute forever. The
 * report says so instead of claiming a flush that did not happen.
 */
function unflushed(reason: string, flushedAt: string): RunRuntimeFlush {
  const component = { status: "unavailable", reason } as const;
  return {
    userdata: component,
    workspace: component,
    providerHome: component,
    flushedAt,
  };
}

function reviewDeadline(allocation: RunAllocation, reviewGraceMillis: number): number | undefined {
  switch (allocation.agentOutcome.status) {
    case "succeeded":
    case "failed":
      return Math.min(
        Date.parse(allocation.agentOutcome.completedAt) + reviewGraceMillis,
        Date.parse(allocation.deadlines.expiresAt),
      );
    case "not-started":
    case "running":
    case "cancelled":
    case "expired":
      return undefined;
  }
}

export const make = Effect.fn("CloudAllocationReconciler.make")(function* (input?: {
  readonly reviewGraceMillis?: number;
  readonly idleReleaseSeconds?: number;
  readonly runClient?: CloudWorkerRunClient.CloudWorkerRunClient["Service"];
}) {
  const controller = yield* CloudAllocationController.CloudAllocationController;
  const registrations = yield* CloudWorkerRegistration.CloudWorkerRegistration;
  const workers = yield* CloudWorkerProvider.CloudWorkerProvider;
  const runClient = input?.runClient;
  const dispatch = Effect.fn("CloudAllocationReconciler.dispatch")(function* (
    allocation: RunAllocation,
    occurredAt: string,
    command: Record<string, unknown>,
  ) {
    const decoded = yield* decodeCommand({
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt,
      ...command,
    });
    return yield* controller.dispatch(decoded);
  });

  const failLaunch = Effect.fn("CloudAllocationReconciler.failLaunch")(function* (
    allocation: RunAllocation,
    occurredAt: string,
    reason: string,
  ) {
    const failed = yield* dispatch(allocation, occurredAt, {
      type: "allocation.launch-failed",
      commandId: commandId(allocation, "launch-failed"),
      reason,
    });
    return yield* dispatch(failed, occurredAt, {
      type: "allocation.cancel",
      commandId: commandId(allocation, "cleanup-after-launch-failure"),
    });
  });

  const cleanup = Effect.fn("CloudAllocationReconciler.cleanup")(function* (
    allocation: RunAllocation,
    now: DateTime.Utc,
    occurredAt: string,
  ) {
    if (allocation.cleanupState.status === "requested") {
      if (allocation.previewState.status === "available") {
        yield* dispatch(allocation, occurredAt, {
          type: "allocation.preview-withdrawn",
          commandId: commandId(allocation, "preview-withdrawn"),
        });
        return;
      }
      yield* dispatch(allocation, occurredAt, {
        type: "allocation.cleanup-started",
        commandId: commandId(allocation, "cleanup-started", allocation.cleanupState.requestedAt),
      });
      return;
    }
    if (allocation.cleanupState.status !== "running") return;

    const resources = yield* workers.findAttemptResources({
      allocationId: allocation.id,
      attempt: allocation.attempt,
    });
    if (resources.length === 0) {
      if (
        allocation.allocationState.status !== "launching" ||
        hasPassed(now, allocation.deadlines.launchBy)
      ) {
        yield* dispatch(allocation, occurredAt, {
          type: "allocation.cleanup-succeeded",
          commandId: commandId(allocation, "cleanup-succeeded", allocation.cleanupState.startedAt),
        });
      }
      return;
    }

    const liveResources = resources.filter((resource) => resource.state !== "terminated");
    if (liveResources.length === 0) {
      yield* dispatch(allocation, occurredAt, {
        type: "allocation.cleanup-succeeded",
        commandId: commandId(allocation, "cleanup-succeeded", allocation.cleanupState.startedAt),
      });
      return;
    }

    if (hasPassed(now, allocation.deadlines.cleanupBy)) {
      yield* dispatch(allocation, occurredAt, {
        type: "allocation.cleanup-failed",
        commandId: commandId(allocation, "cleanup-deadline", allocation.cleanupState.startedAt),
        reason: "The worker did not terminate before its cleanup deadline.",
      });
      return;
    }

    yield* Effect.forEach(
      liveResources,
      (resource) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Cleaning up cloud worker resource.", {
            allocationId: allocation.id,
            attempt: allocation.attempt,
            instanceId: resource.instanceId,
            workerState: resource.state,
          });
          if (resource.registrationCredentialPresent) {
            yield* workers.revokeRegistrationCredential(resource.instanceId);
          }
          if (resource.state !== "shutting-down" && resource.state !== "stopping") {
            yield* workers.terminate(resource.instanceId);
          }
        }),
      { discard: true },
    );
  });

  /**
   * The settle boundary. The guest keeps running, but everything the
   * conversation needs is made durable first, so releasing it later cannot
   * lose the turn that just finished.
   */
  const settle = Effect.fn("CloudAllocationReconciler.settle")(function* (
    allocation: RunAllocation,
    occurredAt: string,
    idleReleaseSeconds: number,
  ) {
    const flushed =
      runClient === undefined ? undefined : yield* runClient.flush(allocation).pipe(Effect.result);
    const flush =
      flushed === undefined
        ? unflushed("This controller has no run client to flush the guest with.", occurredAt)
        : Result.isSuccess(flushed)
          ? flushed.success
          : unflushed(flushed.failure.message, occurredAt);
    yield* dispatch(allocation, occurredAt, {
      type: "allocation.idle",
      commandId: commandId(allocation, "idle"),
      releaseAt: idleReleaseAt({ settledAt: occurredAt, idleReleaseSeconds }),
      flush,
    });
    yield* Effect.logInfo("Cloud agent settled and started its idle-release timer.", {
      allocationId: allocation.id,
      attempt: allocation.attempt,
      idleReleaseSeconds,
      workspaceFlush: flush.workspace.status,
    });
  });

  /**
   * Stopping the guest and recording its snapshot are two steps, and a crash
   * can land between them. The snapshot is therefore written only once AWS
   * reports the guest stopped, so a re-run after a crash records the same
   * snapshot instead of losing it or stopping twice.
   */
  const release = Effect.fn("CloudAllocationReconciler.release")(function* (
    allocation: RunAllocation,
    occurredAt: string,
  ) {
    if (allocation.idleState.status !== "idle") return;
    const instanceId = recordedInstanceId(allocation);
    if (instanceId === undefined) return;
    const resources = yield* workers
      .findAttemptResources({ allocationId: allocation.id, attempt: allocation.attempt })
      .pipe(Effect.result);
    if (Result.isFailure(resources)) {
      yield* Effect.logWarning("Could not read the guest to hibernate.", {
        allocationId: allocation.id,
        error: resources.failure.message,
      });
      return;
    }
    const guest = resources.success.find((resource) => resource.instanceId === instanceId);
    if (guest === undefined || guest.state === "terminated" || guest.state === "shutting-down") {
      // There is no disk left to keep. The retained result stays the recovery
      // boundary, so the allocation is cleaned up rather than left claiming a
      // snapshot it cannot restore.
      yield* dispatch(allocation, occurredAt, {
        type: "allocation.cancel",
        commandId: commandId(allocation, "hibernate-guest-lost"),
      });
      return;
    }
    if (guest.state === "stopping") return;
    if (guest.state !== "stopped") {
      yield* workers.hibernate(instanceId);
      return;
    }
    const snapshot: RunRuntimeSnapshot = {
      instanceId,
      attempt: allocation.attempt,
      flush: allocation.idleState.flush,
      capturedAt: occurredAt,
    };
    yield* dispatch(allocation, occurredAt, {
      type: "allocation.hibernate",
      commandId: commandId(allocation, "hibernate"),
      snapshot,
    });
    yield* Effect.logInfo("Cloud agent hibernated its guest.", {
      allocationId: allocation.id,
      attempt: allocation.attempt,
      instanceId,
    });
  });

  const reconcileAllocation = Effect.fn("CloudAllocationReconciler.reconcileAllocation")(function* (
    allocation: RunAllocation,
    reviewGraceMillis: number,
    maxInputWaitSeconds: number,
    idleReleaseSeconds: number,
  ) {
    const now = yield* DateTime.now;
    const occurredAt = DateTime.formatIso(now);

    if (allocation.cleanupState.status !== "not-requested") {
      yield* cleanup(allocation, now, occurredAt);
      return;
    }

    if (runDeadlineApplies(allocation) && hasPassed(now, allocation.deadlines.expiresAt)) {
      yield* dispatch(allocation, occurredAt, {
        type:
          allocation.agentOutcome.status === "not-started" ||
          allocation.agentOutcome.status === "running"
            ? "allocation.expire"
            : "allocation.cancel",
        commandId: commandId(allocation, "expire"),
      });
      return;
    }
    // The review grace ends the preview, not the conversation. It runs on its
    // own clock, so a settled agent still loses its preview on time whether or
    // not its guest has already been released.
    const completedReviewDeadline = reviewDeadline(allocation, reviewGraceMillis);
    if (
      completedReviewDeadline !== undefined &&
      allocation.previewState.status === "available" &&
      DateTime.toEpochMillis(now) >= completedReviewDeadline
    ) {
      yield* dispatch(allocation, occurredAt, {
        type: "allocation.preview-withdrawn",
        commandId: commandId(allocation, "review-complete"),
      });
      return;
    }
    // A hibernated guest is stopped and costs no compute. Nothing moves it
    // until a follow-up wakes it, which is what makes the conversation, not
    // the worker lifetime, decide how long a thread stays open.
    if (allocation.idleState.status === "hibernated") return;
    if (allocation.idleState.status === "idle") {
      if (!isIdleReleaseDue({ allocation, now: occurredAt })) return;
      yield* release(allocation, occurredAt);
      return;
    }
    if (
      allocation.idleState.status === "busy" &&
      allocation.allocationState.status === "ready" &&
      hasAgentSettled(allocation)
    ) {
      yield* settle(allocation, occurredAt, idleReleaseSeconds);
      return;
    }

    switch (allocation.allocationState.status) {
      case "queued": {
        if (hasPassed(now, allocation.deadlines.launchBy)) {
          yield* failLaunch(
            allocation,
            occurredAt,
            "The worker launch did not start before its launch deadline.",
          );
          return;
        }
        const instanceType = allocation.profile.instanceType;
        if (instanceType === undefined) {
          yield* failLaunch(
            allocation,
            occurredAt,
            "The allocation does not record a worker instance type.",
          );
          return;
        }
        const launchTemplate = yield* workers
          .resolveLaunchTemplate(allocation.profile.id)
          .pipe(
            Effect.catch((error) =>
              failLaunch(allocation, occurredAt, error.message).pipe(Effect.as(undefined)),
            ),
          );
        if (launchTemplate === undefined) return;
        yield* dispatch(allocation, occurredAt, {
          type: "allocation.launch-started",
          commandId: commandId(allocation, "launch-started"),
          launchTemplate,
        });
        return;
      }
      case "launching": {
        const findResult = yield* workers
          .findAttemptResources({
            allocationId: allocation.id,
            attempt: allocation.attempt,
          })
          .pipe(Effect.result);
        if (Result.isFailure(findResult)) {
          if (
            findResult.failure.reason !== "retryable" ||
            hasPassed(now, allocation.deadlines.launchBy)
          ) {
            yield* failLaunch(allocation, occurredAt, findResult.failure.message);
          }
          return;
        }
        const existingResources = findResult.success;
        if (existingResources.length > 1) {
          yield* failLaunch(
            allocation,
            occurredAt,
            "AWS returned more than one worker for this allocation attempt.",
          );
          return;
        }
        const existing = existingResources[0];
        if (existing !== undefined && existing.state !== "terminated") {
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.instance-launched",
            commandId: commandId(allocation, "instance-launched"),
            instanceId: existing.instanceId,
          });
          return;
        }
        if (existing?.state === "terminated") {
          yield* failLaunch(
            allocation,
            occurredAt,
            "The worker instance terminated before it finished booting.",
          );
          return;
        }
        if (
          allocation.allocationState.retry.status === "waiting" &&
          !hasPassed(now, allocation.allocationState.retry.retryAt)
        ) {
          return;
        }
        if (hasPassed(now, allocation.deadlines.launchBy)) {
          yield* failLaunch(
            allocation,
            occurredAt,
            "AWS did not return or recover a worker before the launch deadline.",
          );
          return;
        }

        const instanceType = allocation.profile.instanceType;
        if (instanceType === undefined) {
          yield* failLaunch(
            allocation,
            occurredAt,
            "The allocation does not record a worker instance type.",
          );
          return;
        }
        const registrationCredential = yield* registrations.issueCredential(allocation);
        const snapshot = retainedRuntimeSnapshot(allocation);
        if (snapshot !== undefined) {
          const restored = yield* workers
            .restore({
              instanceId: snapshot.instanceId,
              allocationId: allocation.id,
              attempt: allocation.attempt,
              selectedRef: allocation.execution?.selectedRef ?? allocation.target.baseCommit,
              outputBranch: allocation.target.branch,
              expiresAt: allocation.deadlines.expiresAt,
              maxInputWaitSeconds,
              registrationCredential,
            })
            .pipe(Effect.result);
          if (Result.isSuccess(restored)) {
            yield* dispatch(allocation, occurredAt, {
              type: "allocation.instance-launched",
              commandId: commandId(allocation, "instance-launched"),
              instanceId: restored.success.instanceId,
            });
            return;
          }
          // The snapshot could not be started. Placing a fresh guest is the
          // honest fallback; the wake report says the filesystem did not come
          // back rather than pretending it did.
          yield* Effect.logWarning("Could not restore a hibernated cloud guest.", {
            allocationId: allocation.id,
            attempt: allocation.attempt,
            instanceId: snapshot.instanceId,
            error: restored.failure.message,
          });
        }
        const launched = yield* workers
          .launch({
            allocationId: allocation.id,
            attempt: allocation.attempt,
            repository: allocation.target.repository,
            selectedRef: allocation.execution?.selectedRef ?? allocation.target.baseCommit,
            outputBranch: allocation.target.branch,
            expiresAt: allocation.deadlines.expiresAt,
            instanceType,
            maxInputWaitSeconds,
            launchTemplate: allocation.allocationState.launchTemplate,
            registrationCredential,
          })
          .pipe(Effect.result);
        if (Result.isSuccess(launched)) {
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.instance-launched",
            commandId: commandId(allocation, "instance-launched"),
            instanceId: launched.success.instanceId,
          });
          return;
        }

        const failures = allocation.allocationState.retry.failures + 1;
        if (launched.failure.reason !== "retryable" || failures >= MAX_LAUNCH_FAILURES) {
          yield* failLaunch(allocation, occurredAt, launched.failure.message);
          return;
        }
        const retryAt = DateTime.formatIso(
          DateTime.add(now, { seconds: Math.min(5 * 2 ** (failures - 1), 30) }),
        );
        if (Date.parse(retryAt) >= Date.parse(allocation.deadlines.launchBy)) {
          yield* failLaunch(allocation, occurredAt, launched.failure.message);
          return;
        }
        yield* dispatch(allocation, occurredAt, {
          type: "allocation.launch-retry-scheduled",
          commandId: commandId(allocation, "launch-retry", failures),
          failures,
          retryAt,
          reason: launched.failure.message,
        });
        return;
      }
      case "booting": {
        const instanceId = allocation.allocationState.instanceId;
        const findResult = yield* workers
          .findAttemptResources({
            allocationId: allocation.id,
            attempt: allocation.attempt,
          })
          .pipe(Effect.result);
        if (Result.isFailure(findResult)) {
          if (
            findResult.failure.reason !== "retryable" ||
            hasPassed(now, allocation.deadlines.bootBy)
          ) {
            yield* failLaunch(allocation, occurredAt, findResult.failure.message);
          }
          return;
        }
        const instance = findResult.success.find((resource) => resource.instanceId === instanceId);
        if (instance?.state === "running") {
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.worker-booted",
            commandId: commandId(allocation, "worker-booted"),
          });
          return;
        }
        if (instance?.state === "terminated" || instance?.state === "shutting-down") {
          yield* failLaunch(
            allocation,
            occurredAt,
            "The worker instance terminated before boot completed.",
          );
          return;
        }
        if (hasPassed(now, allocation.deadlines.bootBy)) {
          yield* failLaunch(
            allocation,
            occurredAt,
            "The worker did not boot before its boot deadline.",
          );
        }
        return;
      }
      case "registering":
        if (hasPassed(now, allocation.deadlines.registerBy)) {
          yield* failLaunch(
            allocation,
            occurredAt,
            "The worker service did not register before its registration deadline.",
          );
        }
        return;
      case "failed":
        yield* dispatch(allocation, occurredAt, {
          type: "allocation.cancel",
          commandId: commandId(allocation, "cleanup-after-failure"),
        });
        return;
      case "ready": {
        if (allocation.idleState.status === "waking") {
          const snapshot = allocation.idleState.snapshot;
          const restoredInPlace = allocation.allocationState.instanceId === snapshot.instanceId;
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.runtime-restored",
            commandId: commandId(allocation, "runtime-restored"),
            restore: {
              filesystem: restoredInPlace
                ? {
                    status: "resumed",
                    detail: `Restored the guest disk from the snapshot taken at ${snapshot.capturedAt}.`,
                  }
                : {
                    status: "not-resumed",
                    reason:
                      "The hibernated guest could not be started, so a fresh one was placed from the environment Build.",
                  },
              // T3 resumes the thread from its own restored database. The
              // provider CLI does not resume its native session across a stop.
              providerSession: {
                status: "not-resumed",
                reason:
                  snapshot.flush.providerHome.status === "unavailable"
                    ? snapshot.flush.providerHome.reason
                    : "The provider starts a new native session against the restored workspace.",
              },
              restoredAt: occurredAt,
            },
          });
          return;
        }
        if (allocation.execution === undefined || runClient === undefined) return;
        if (allocation.agentOutcome.status === "not-started") {
          const started = yield* runClient.start(allocation).pipe(Effect.result);
          if (Result.isFailure(started)) {
            yield* Effect.logWarning("Could not start the cloud thread on its worker.", {
              allocationId: allocation.id,
              attempt: allocation.attempt,
              error: started.failure.message,
            });
            return;
          }
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.agent-started",
            commandId: commandId(allocation, "agent-started"),
          });
          return;
        }
        if (allocation.agentOutcome.status !== "running") return;
        const status = yield* runClient.status(allocation).pipe(Effect.result);
        if (Result.isFailure(status)) {
          yield* Effect.logWarning("Could not read the cloud thread status from its worker.", {
            allocationId: allocation.id,
            attempt: allocation.attempt,
            error: status.failure.message,
          });
          return;
        }
        if (status.success === "running") return;
        const resultLocation = {
          uri: `t3://${allocation.allocationState.references.environmentId}/${allocation.execution.threadId}`,
        };
        if (status.success === "succeeded") {
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.agent-succeeded",
            commandId: commandId(allocation, "agent-succeeded"),
            resultLocation,
          });
          return;
        }
        yield* dispatch(allocation, occurredAt, {
          type: "allocation.agent-failed",
          commandId: commandId(allocation, "agent-failed"),
          reason: "The worker provider turn ended with an error or interruption.",
          resultLocation,
        });
        return;
      }
    }
  });

  const reconcileOnce = Effect.fn("CloudAllocationReconciler.reconcileOnce")(function* () {
    const snapshot = yield* controller.snapshot;
    // A fenced controller has handed its state to another host. Launching or
    // terminating AWS workers from here would make two controllers act on the
    // same allocations.
    if (snapshot.controller.writability?.status === "fenced") return;
    const pending = orderedAllocations(snapshot.allocations).filter(
      (allocation) => allocation.cleanupState.status !== "succeeded",
    );
    // A hibernated guest holds no compute, so it does not hold the worker
    // slot either. Waking one makes it active again and puts it back in line.
    const active = pending.filter((allocation) => allocation.idleState.status !== "hibernated");
    const occupying = active.filter(
      (allocation) =>
        allocation.allocationState.status !== "queued" ||
        allocation.cleanupState.status !== "not-requested",
    );
    const queued = active.filter(
      (allocation) =>
        allocation.allocationState.status === "queued" &&
        allocation.cleanupState.status === "not-requested",
    );
    const reviewGraceMillis =
      input?.reviewGraceMillis ?? snapshot.limits.previewGraceSeconds * 1_000;
    const idleReleaseSeconds = input?.idleReleaseSeconds ?? snapshot.limits.idleReleaseSeconds;
    for (const next of occupying) {
      yield* reconcileAllocation(
        next,
        reviewGraceMillis,
        snapshot.limits.maxInputWaitSeconds,
        idleReleaseSeconds,
      );
    }
    const remainingSlots = snapshot.limits.maxConcurrentWorkers - occupying.length;
    for (const next of queued.slice(0, Math.max(0, remainingSlots))) {
      yield* reconcileAllocation(
        next,
        reviewGraceMillis,
        snapshot.limits.maxInputWaitSeconds,
        idleReleaseSeconds,
      );
    }
  });

  const removeAbandonedResource = Effect.fn("CloudAllocationReconciler.removeAbandonedResource")(
    function* (resource: CloudWorkerResource) {
      if (resource.registrationCredentialPresent) {
        yield* workers.revokeRegistrationCredential(resource.instanceId);
      }
      if (resource.state !== "shutting-down" && resource.state !== "stopping") {
        yield* workers.terminate(resource.instanceId);
      }
    },
  );

  const reconcileWorkersOnce = Effect.fn("CloudAllocationReconciler.reconcileWorkersOnce")(
    function* () {
      const snapshot = yield* controller.snapshot;
      if (snapshot.controller.writability?.status === "fenced") return;
      const resources = yield* workers.listWorkers();
      const allocations = new Map(
        snapshot.allocations.map((allocation) => [allocation.id, allocation]),
      );
      // A stopped guest an allocation still owns is a snapshot waiting to be
      // woken. It carries the attempt it hibernated on, which is behind the
      // attempt a wake already created, so it has to be excluded by identity
      // before any of the staleness rules below see it.
      const retained = new Set(
        snapshot.allocations
          .map((allocation) => retainedRuntimeSnapshot(allocation)?.instanceId)
          .filter((instanceId): instanceId is string => instanceId !== undefined),
      );

      yield* Effect.forEach(
        resources,
        (resource) =>
          Effect.gen(function* () {
            if (retained.has(resource.instanceId)) return;
            if (resource.identity.status === "unmatched") {
              yield* removeAbandonedResource(resource);
              return;
            }

            const allocation = allocations.get(resource.identity.allocationId);
            if (allocation === undefined) {
              yield* removeAbandonedResource(resource);
              return;
            }
            if (resource.identity.attempt > allocation.attempt) return;
            if (
              resource.identity.attempt < allocation.attempt ||
              allocation.cleanupState.status === "succeeded"
            ) {
              yield* removeAbandonedResource(resource);
              return;
            }
            const expectedInstanceId = recordedInstanceId(allocation);
            if (expectedInstanceId !== undefined && resource.instanceId !== expectedInstanceId) {
              yield* removeAbandonedResource(resource);
              return;
            }
            if (
              resource.registrationCredentialPresent &&
              (allocation.allocationState.status === "ready" ||
                allocation.allocationState.status === "failed" ||
                allocation.cleanupState.status !== "not-requested")
            ) {
              yield* workers.revokeRegistrationCredential(resource.instanceId);
            }
          }),
        { discard: true },
      );
    },
  );

  return { reconcileOnce, reconcileWorkersOnce } as const;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (config.cloudControllerEnabled !== true) return;
    const runClient = yield* CloudWorkerRunClient.CloudWorkerRunClient;
    const reconciler = yield* make({ runClient });
    yield* reconciler.reconcileOnce().pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Cloud allocation reconciliation failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced("2 seconds")),
      Effect.forkScoped,
    );
    yield* reconciler.reconcileWorkersOnce().pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Cloud worker resource reconciliation failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped,
    );
  }),
);
