import {
  CloudAgentId,
  CloudMacHostId,
  CloudRunId,
  CloudWarmGuestId,
  RunAllocationCommand,
  type CloudAllocationSnapshot,
  type CloudEnvironment,
  type CloudEnvironmentVersion,
  type CloudManagedRuntime,
  type RunAllocation,
  type RunAllocationProgressStage,
  type RunRuntimeFlush,
  type RunRuntimeSnapshot,
  emulatorWakeResumption,
  androidNeedsNestedVirtualizationLaunch,
  admitMacIosWorker,
  isLinuxAndroidWorkerProfile,
  isMacIosWorkerProfile,
  isSelfHostedWorkerProfile,
  placeMacIosJob,
  simulatorWakeResumption,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
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
import { expiredLeases, holdsRuntime, settleIdleSeconds } from "./cloudPreviewLeasePolicy.ts";
import * as CloudMacHostCatalog from "./CloudMacHostCatalog.ts";
import * as CloudRuntimeProvider from "./CloudRuntimeProvider.ts";
import * as CloudWarmPoolCatalog from "./CloudWarmPoolCatalog.ts";
import {
  planWarmPoolCapacity,
  placementForClaim,
  warmPoolInventories,
  warmPoolSupportsProfile,
} from "./cloudWarmPoolPolicy.ts";
import * as CloudWorkerRegistration from "./CloudWorkerRegistration.ts";
import * as CloudWorkerProvider from "./CloudWorkerProvider.ts";
import * as CloudWorkerRunClient from "./CloudWorkerRunClient.ts";
import * as DaytonaWorkerBootstrap from "./DaytonaWorkerBootstrap.ts";
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

/** A reopen attempt that has not yet run the environment's per-boot services. */
function awaitingReopen(allocation: RunAllocation): boolean {
  return allocation.attemptPurpose === "reopen" && allocation.reopen === undefined;
}

/**
 * The environment a reopened guest starts. The disk is the one the run left
 * behind; the services are the ones the environment declares now, because an
 * operator who fixed a broken `start` expects the fix when they reopen.
 */
function environmentVersionFor(
  allocation: RunAllocation,
  environments: ReadonlyArray<CloudEnvironment>,
): CloudEnvironmentVersion | undefined {
  const reference = allocation.environment;
  if (reference === undefined) return undefined;
  return environments.find((candidate) => candidate.id === reference.environmentId)?.current;
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

function managedRuntimeOf(allocation: RunAllocation): CloudManagedRuntime | undefined {
  switch (allocation.allocationState.status) {
    case "booting":
    case "registering":
    case "ready":
    case "failed":
      return allocation.allocationState.managedRuntime;
    case "queued":
    case "launching":
      return undefined;
  }
}

function usesManagedRuntime(allocation: RunAllocation): boolean {
  switch (allocation.allocationState.status) {
    case "launching":
    case "failed":
      return allocation.allocationState.managedProvider === "daytona";
    case "booting":
    case "registering":
    case "ready":
      return allocation.allocationState.managedRuntime?.provider === "daytona";
    case "queued":
      return false;
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
function unflushed(
  reason: string,
  flushedAt: string,
  extras: { readonly macosIos?: boolean; readonly linuxAndroid?: boolean } = {},
): RunRuntimeFlush {
  const component = { status: "unavailable", reason } as const;
  return {
    userdata: component,
    workspace: component,
    providerHome: component,
    ...(extras.macosIos
      ? {
          simulator: {
            status: "unavailable" as const,
            reason:
              "The iOS Simulator process is not restorable across hibernation. Wake creates a new reserved UDID.",
          },
          xcodeCache: {
            status: "unavailable" as const,
            reason:
              "Xcode caches stay on the Mac image and environment Build, not in the job snapshot.",
          },
        }
      : {}),
    ...(extras.linuxAndroid
      ? {
          emulator: {
            status: "unavailable" as const,
            reason:
              "AVD data was not flushed. Wake created a new AVD and app/login state did not persist.",
          },
        }
      : {}),
    flushedAt,
  };
}

export const make = Effect.fn("CloudAllocationReconciler.make")(function* (input?: {
  readonly idleReleaseSeconds?: number;
  readonly runClient?: CloudWorkerRunClient.CloudWorkerRunClient["Service"];
  readonly daytonaWorker?: DaytonaWorkerBootstrap.DaytonaWorkerBootstrap;
}) {
  const controller = yield* CloudAllocationController.CloudAllocationController;
  const registrations = yield* CloudWorkerRegistration.CloudWorkerRegistration;
  const workers = yield* CloudWorkerProvider.CloudWorkerProvider;
  const runtimes = yield* CloudRuntimeProvider.CloudRuntimeProvider;
  const macHosts = yield* CloudMacHostCatalog.make();
  const warmPool = yield* CloudWarmPoolCatalog.make();
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

  const reportProgress = Effect.fn("CloudAllocationReconciler.reportProgress")(function* (input: {
    readonly allocation: RunAllocation;
    readonly occurredAt: string;
    readonly operation: string;
    readonly stage: RunAllocationProgressStage;
    readonly status: "requested" | "running" | "succeeded" | "failed";
    readonly message: string;
  }) {
    const startedAt =
      input.allocation.progress?.stage === input.stage
        ? input.allocation.progress.startedAt
        : input.occurredAt;
    yield* dispatch(input.allocation, input.occurredAt, {
      type: "allocation.progress-reported",
      commandId: commandId(
        input.allocation,
        "progress",
        `${input.operation}:${input.stage}:${input.status}`,
      ),
      progress: {
        stage: input.stage,
        status: input.status,
        message: input.message,
        startedAt,
        updatedAt: input.occurredAt,
      },
    });
  });

  const failLaunch = Effect.fn("CloudAllocationReconciler.failLaunch")(function* (
    allocation: RunAllocation,
    occurredAt: string,
    reason: string,
    managedProvider?: "daytona",
  ) {
    const failed = yield* dispatch(allocation, occurredAt, {
      type: "allocation.launch-failed",
      commandId: commandId(allocation, "launch-failed"),
      reason,
      ...(managedProvider === undefined ? {} : { managedProvider }),
    });
    return yield* dispatch(failed, occurredAt, {
      type: "allocation.cancel",
      commandId: commandId(allocation, "cleanup-after-launch-failure"),
    });
  });

  const runtimeAssignment = (
    allocation: RunAllocation,
    registrationCredential: string,
    maxInputWaitSeconds: number,
  ): CloudRuntimeProvider.CloudRuntimeCreateInput => ({
    allocationId: allocation.id,
    attempt: allocation.attempt,
    agentId: allocation.control?.agentId ?? CloudAgentId.make(`agent:${allocation.id}`),
    runId: allocation.control?.runId ?? CloudRunId.make(`run:${allocation.id}:1`),
    ...(allocation.environment === undefined
      ? {}
      : { environmentId: allocation.environment.environmentId }),
    ...(allocation.build === undefined ? {} : { buildId: allocation.build.buildId }),
    ...(allocation.build === undefined ? {} : { snapshotId: allocation.build.snapshot.id }),
    environmentVariables: {
      T3CODE_CLOUD_ALLOCATION_ID: allocation.id,
      T3CODE_CLOUD_ALLOCATION_ATTEMPT: String(allocation.attempt),
      T3CODE_CLOUD_REPOSITORY: allocation.target.repository,
      T3CODE_CLOUD_SELECTED_REF: allocation.execution?.selectedRef ?? allocation.target.baseCommit,
      T3CODE_CLOUD_OUTPUT_BRANCH: allocation.target.branch,
      T3CODE_CLOUD_EXPIRES_AT: allocation.deadlines.expiresAt,
      T3CODE_CLOUD_MAX_INPUT_WAIT_SECONDS: String(maxInputWaitSeconds),
      T3CODE_CLOUD_REGISTRATION_CREDENTIAL: registrationCredential,
    },
  });

  const cleanup = Effect.fn("CloudAllocationReconciler.cleanup")(function* (
    allocation: RunAllocation,
    now: DateTime.Utc,
    occurredAt: string,
  ) {
    if (allocation.cleanupState.status === "requested") {
      yield* reportProgress({
        allocation,
        occurredAt,
        operation: "cancellation-requested",
        stage: "stop",
        status: "requested",
        message: "Cancellation requested. Interrupting the provider and stopping the sandbox.",
      });
      if (input?.daytonaWorker !== undefined && usesManagedRuntime(allocation)) {
        const interrupted = yield* input.daytonaWorker.interrupt(allocation).pipe(Effect.result);
        if (Result.isFailure(interrupted)) {
          yield* Effect.logWarning("Could not interrupt the Daytona T3 worker before cleanup.", {
            allocationId: allocation.id,
            attempt: allocation.attempt,
            error: interrupted.failure.message,
          });
        }
      }
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

    const recordedManagedRuntime = managedRuntimeOf(allocation);
    const managedResult = yield* runtimes
      .inspect(
        recordedManagedRuntime === undefined
          ? {
              kind: "allocation-attempt",
              allocationId: allocation.id,
              attempt: allocation.attempt,
            }
          : { kind: "id", runtimeId: recordedManagedRuntime.runtimeId },
      )
      .pipe(Effect.result);
    if (Result.isSuccess(managedResult) && managedResult.success !== undefined) {
      const managed = managedResult.success;
      if (managed.lifecycleState !== "deleted") {
        if (hasPassed(now, allocation.deadlines.cleanupBy)) {
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.cleanup-failed",
            commandId: commandId(allocation, "cleanup-deadline", allocation.cleanupState.startedAt),
            reason: "The Daytona sandbox was not deleted before its cleanup deadline.",
          });
          return;
        }
        if (
          managed.lifecycleState === "creating" ||
          managed.lifecycleState === "starting" ||
          managed.lifecycleState === "started" ||
          managed.lifecycleState === "unknown" ||
          managed.lifecycleState === "error"
        ) {
          yield* reportProgress({
            allocation,
            occurredAt,
            operation: "sandbox-stop",
            stage: "stop",
            status: "running",
            message: "Provider interrupted. Stopping the Daytona sandbox.",
          });
          const stopped = yield* runtimes.stop(managed.runtimeId).pipe(Effect.result);
          if (Result.isFailure(stopped)) {
            yield* Effect.logWarning("Could not stop the Daytona sandbox during cleanup.", {
              allocationId: allocation.id,
              attempt: allocation.attempt,
              runtimeId: managed.runtimeId,
              error: stopped.failure.message,
            });
          }
          return;
        }
        if (managed.lifecycleState === "stopping" || managed.lifecycleState === "archiving") {
          yield* reportProgress({
            allocation,
            occurredAt,
            operation:
              managed.lifecycleState === "stopping" ? "sandbox-stop-wait" : "sandbox-archive-wait",
            stage: managed.lifecycleState === "stopping" ? "stop" : "archive",
            status: "running",
            message:
              managed.lifecycleState === "stopping"
                ? "Waiting for Daytona to confirm the sandbox stopped."
                : "Archiving the stopped sandbox.",
          });
          return;
        }
        if (managed.lifecycleState === "stopped") {
          yield* reportProgress({
            allocation,
            occurredAt,
            operation: "sandbox-archive",
            stage: "archive",
            status: "running",
            message: "Sandbox stopped. Archiving its resources.",
          });
          const archived = yield* runtimes.archive(managed.runtimeId).pipe(Effect.result);
          if (Result.isFailure(archived)) {
            yield* Effect.logWarning("Could not archive the Daytona sandbox during cleanup.", {
              allocationId: allocation.id,
              attempt: allocation.attempt,
              runtimeId: managed.runtimeId,
              error: archived.failure.message,
            });
          }
          return;
        }
        yield* reportProgress({
          allocation,
          occurredAt,
          operation: "sandbox-delete",
          stage: "delete",
          status: "running",
          message:
            managed.lifecycleState === "deleting"
              ? "Waiting for Daytona to confirm the resource was released."
              : "Archive confirmed. Releasing the Daytona resource.",
        });
        if (managed.lifecycleState === "deleting") return;
        const deleted = yield* runtimes.delete(managed.runtimeId).pipe(Effect.result);
        if (Result.isFailure(deleted)) {
          yield* Effect.logWarning("Could not release the Daytona sandbox.", {
            allocationId: allocation.id,
            attempt: allocation.attempt,
            runtimeId: managed.runtimeId,
            error: deleted.failure.message,
          });
        }
        return;
      }
      yield* reportProgress({
        allocation,
        occurredAt,
        operation: "sandbox-delete-confirmed",
        stage: "delete",
        status: "succeeded",
        message: "Daytona confirmed the resource was released.",
      });
      yield* dispatch(allocation, occurredAt, {
        type: "allocation.cleanup-succeeded",
        commandId: commandId(allocation, "cleanup-succeeded", allocation.cleanupState.startedAt),
      });
      return;
    }
    if (Result.isSuccess(managedResult) && usesManagedRuntime(allocation)) {
      yield* reportProgress({
        allocation,
        occurredAt,
        operation: "sandbox-delete-confirmed",
        stage: "delete",
        status: "succeeded",
        message: "Daytona confirmed the resource was released.",
      });
      yield* dispatch(allocation, occurredAt, {
        type: "allocation.cleanup-succeeded",
        commandId: commandId(allocation, "cleanup-succeeded", allocation.cleanupState.startedAt),
      });
      return;
    }
    if (Result.isSuccess(managedResult) && allocation.allocationState.status === "queued") {
      yield* dispatch(allocation, occurredAt, {
        type: "allocation.cleanup-succeeded",
        commandId: commandId(allocation, "cleanup-succeeded", allocation.cleanupState.startedAt),
      });
      return;
    }
    if (recordedManagedRuntime !== undefined && Result.isFailure(managedResult)) {
      yield* Effect.logWarning("Could not inspect the Daytona sandbox during cleanup.", {
        allocationId: allocation.id,
        attempt: allocation.attempt,
        runtimeId: recordedManagedRuntime.runtimeId,
        error: managedResult.failure.message,
      });
      return;
    }

    const resources = yield* workers.findAttemptResources({
      allocationId: allocation.id,
      attempt: allocation.attempt,
    });
    if (resources.length === 0) {
      yield* warmPool.releaseClaim({
        allocationId: allocation.id,
        occurredAt,
      });
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
    if (isMacIosWorkerProfile(allocation.profile)) {
      yield* Effect.forEach(
        liveResources,
        (resource) =>
          resource.registrationCredentialPresent
            ? workers.revokeRegistrationCredential(resource.instanceId)
            : Effect.void,
        { discard: true },
      );
      const hosts = yield* macHosts.list;
      const host = hosts.find((candidate) => candidate.occupiedBy?.allocationId === allocation.id);
      if (host !== undefined) {
        yield* macHosts.save(CloudMacHostCatalog.finishMacHostJob({ host, occurredAt }));
      }
      yield* dispatch(allocation, occurredAt, {
        type: "allocation.cleanup-succeeded",
        commandId: commandId(allocation, "cleanup-succeeded", allocation.cleanupState.startedAt),
      });
      return;
    }
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
    const macosIos = isMacIosWorkerProfile(allocation.profile);
    const linuxAndroid = isLinuxAndroidWorkerProfile(allocation.profile);
    const extras = { macosIos, linuxAndroid };
    const flush =
      flushed === undefined
        ? unflushed(
            "This controller has no run client to flush the guest with.",
            occurredAt,
            extras,
          )
        : Result.isSuccess(flushed)
          ? {
              ...flushed.success,
              ...(macosIos && flushed.success.simulator === undefined
                ? {
                    simulator: {
                      status: "unavailable" as const,
                      reason:
                        "The iOS Simulator process is not restorable across hibernation. Wake creates a new reserved UDID.",
                    },
                  }
                : {}),
              ...(linuxAndroid && flushed.success.emulator === undefined
                ? {
                    emulator: {
                      status: "unavailable" as const,
                      reason:
                        "AVD data was not flushed. Wake created a new AVD and app/login state did not persist.",
                    },
                  }
                : {}),
            }
          : unflushed(flushed.failure.message, occurredAt, extras);
    yield* dispatch(allocation, occurredAt, {
      type: "allocation.idle",
      commandId: commandId(allocation, "idle"),
      releaseAt: idleReleaseAt({
        settledAt: occurredAt,
        idleReleaseSeconds: settleIdleSeconds({ allocation, idleReleaseSeconds }),
      }),
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
   * What a person changed by hand on a reopened guest, captured before the disk
   * is stopped. It writes a checkpoint and a diff on the guest and nothing
   * else: the pull request the run already published is not touched.
   */
  const captureSessionEdits = Effect.fn("CloudAllocationReconciler.captureSessionEdits")(function* (
    allocation: RunAllocation,
    occurredAt: string,
  ) {
    if (allocation.attemptPurpose !== "reopen" || allocation.sessionEdits !== undefined) {
      return false;
    }
    if (runClient === undefined) return false;
    const edits = yield* runClient.sessionEdits(allocation).pipe(Effect.result);
    yield* dispatch(allocation, occurredAt, {
      type: "allocation.session-edits-captured",
      commandId: commandId(allocation, "session-edits"),
      edits: Result.isSuccess(edits)
        ? edits.success
        : { status: "unavailable", reason: edits.failure.message },
    });
    return true;
  });

  /**
   * Stopping the guest and recording its snapshot are two steps, and a crash
   * can land between them. The snapshot is therefore written only once the
   * provider reports the runtime stopped, so a re-run after a crash records the same
   * snapshot instead of losing it or stopping twice.
   */
  const release = Effect.fn("CloudAllocationReconciler.release")(function* (
    allocation: RunAllocation,
    occurredAt: string,
  ) {
    if (allocation.idleState.status !== "idle") return;
    const instanceId = recordedInstanceId(allocation);
    if (instanceId === undefined) return;
    const recordedManaged = managedRuntimeOf(allocation);
    if (recordedManaged !== undefined) {
      const inspected = yield* runtimes
        .inspect({ kind: "id", runtimeId: recordedManaged.runtimeId })
        .pipe(Effect.result);
      if (Result.isFailure(inspected)) {
        yield* Effect.logWarning("Could not read the Daytona sandbox to stop it.", {
          allocationId: allocation.id,
          runtimeId: recordedManaged.runtimeId,
          error: inspected.failure.message,
        });
        return;
      }
      const managed = inspected.success;
      if (
        managed === undefined ||
        managed.lifecycleState === "deleted" ||
        managed.lifecycleState === "error"
      ) {
        yield* dispatch(allocation, occurredAt, {
          type: "allocation.cancel",
          commandId: commandId(allocation, "hibernate-sandbox-lost"),
        });
        return;
      }
      if (
        managed.lifecycleState === "stopping" ||
        managed.lifecycleState === "archiving" ||
        managed.lifecycleState === "starting" ||
        managed.lifecycleState === "creating"
      ) {
        return;
      }
      if (managed.lifecycleState !== "stopped" && managed.lifecycleState !== "archived") {
        yield* runtimes.stop(managed.runtimeId);
        return;
      }
      const snapshot: RunRuntimeSnapshot = {
        instanceId: managed.runtimeId,
        attempt: allocation.attempt,
        flush: allocation.idleState.flush,
        capturedAt: occurredAt,
      };
      yield* dispatch(allocation, occurredAt, {
        type: "allocation.hibernate",
        commandId: commandId(allocation, "hibernate"),
        snapshot,
      });
      yield* Effect.logInfo("Cloud agent stopped its Daytona sandbox.", {
        allocationId: allocation.id,
        attempt: allocation.attempt,
        runtimeId: managed.runtimeId,
      });
      return;
    }
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
    // The route and its bearer token are bound to this attempt, and the guest
    // that served them is stopped. Revoking the registration credential here is
    // what stops a stale token from being replayed against the woken runtime,
    // which comes back on a new, fenced attempt.
    if (guest.registrationCredentialPresent) {
      yield* workers.revokeRegistrationCredential(instanceId).pipe(Effect.ignore);
    }
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
    maxInputWaitSeconds: number,
    idleReleaseSeconds: number,
    environments: ReadonlyArray<CloudEnvironment>,
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
    // A lease ends on its own clock, so a session someone walked away from
    // stops holding the guest whether or not anything else has moved.
    const expired = expiredLeases({ allocation, now: occurredAt });
    if (expired.length > 0) {
      for (const lease of expired) {
        yield* dispatch(allocation, occurredAt, {
          type: "allocation.session-lease-release",
          commandId: commandId(allocation, "lease-expired", lease.kind),
          kind: lease.kind,
          reason: lease.reason,
        });
      }
      return;
    }
    // A hibernated guest is stopped and costs no compute. Nothing moves it
    // until a follow-up wakes it, which is what makes the conversation, not
    // the worker lifetime, decide how long a thread stays open.
    if (allocation.idleState.status === "hibernated") return;
    if (allocation.idleState.status === "idle") {
      // Somebody is still looking at it. The idle timer is about people who
      // walked away, so it defers rather than pulling the app out from under.
      if (holdsRuntime({ allocation, now: occurredAt })) return;
      if (!isIdleReleaseDue({ allocation, now: occurredAt })) return;
      if (yield* captureSessionEdits(allocation, occurredAt)) return;
      yield* release(allocation, occurredAt);
      return;
    }
    if (
      allocation.idleState.status === "busy" &&
      allocation.allocationState.status === "ready" &&
      hasAgentSettled(allocation) &&
      // A reopened guest is settled the moment it comes back, so settling it
      // here would start the idle timer before the app it was reopened for is
      // even running. The environment start goes first.
      !awaitingReopen(allocation)
    ) {
      yield* settle(allocation, occurredAt, idleReleaseSeconds);
      return;
    }

    switch (allocation.allocationState.status) {
      case "queued": {
        if (isSelfHostedWorkerProfile(allocation.profile)) return;
        yield* reportProgress({
          allocation,
          occurredAt,
          operation: "sandbox-allocation",
          stage: "allocation",
          status: "running",
          message: "Allocating Daytona capacity.",
        });
        if (hasPassed(now, allocation.deadlines.launchBy)) {
          yield* failLaunch(
            allocation,
            occurredAt,
            "The worker launch did not start before its launch deadline.",
          );
          return;
        }
        const readiness = yield* runtimes.readiness();
        if (
          readiness.admission !== "enabled" ||
          readiness.authentication !== "configured" ||
          readiness.reachability !== "reachable"
        ) {
          yield* failLaunch(allocation, occurredAt, readiness.detail, "daytona");
          return;
        }
        yield* dispatch(allocation, occurredAt, {
          type: "allocation.launch-started",
          commandId: commandId(allocation, "launch-started"),
          launchTemplate: { id: `daytona:${runtimes.resourceClass}`, version: 1 },
          managedProvider: "daytona",
        });
        return;
      }
      case "launching": {
        if (isSelfHostedWorkerProfile(allocation.profile)) return;
        if (allocation.allocationState.managedProvider === "daytona") {
          yield* reportProgress({
            allocation,
            occurredAt,
            operation: "sandbox-start",
            stage: "start",
            status: "running",
            message: "Starting the assigned Daytona sandbox.",
          });
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
              "Daytona did not return or recover a sandbox before the launch deadline.",
            );
            return;
          }
          const registrationCredential = yield* registrations.issueCredential(allocation);
          const assignment = runtimeAssignment(
            allocation,
            registrationCredential,
            maxInputWaitSeconds,
          );
          const retained = retainedRuntimeSnapshot(allocation);
          let launched = yield* (
            retained === undefined
              ? runtimes.create(assignment)
              : runtimes.start({ runtimeId: retained.instanceId, assignment })
          ).pipe(Effect.result);
          if (
            retained !== undefined &&
            Result.isFailure(launched) &&
            launched.failure.reason === "not-found"
          ) {
            launched = yield* runtimes.create(assignment).pipe(Effect.result);
          }
          if (Result.isSuccess(launched)) {
            yield* dispatch(allocation, occurredAt, {
              type: "allocation.instance-launched",
              commandId: commandId(allocation, "instance-launched"),
              instanceId: launched.success.runtimeId,
              managedRuntime: launched.success,
            });
            return;
          }

          const failures = allocation.allocationState.retry.failures + 1;
          const retryable =
            launched.failure.reason === "capacity" || launched.failure.reason === "provider-outage";
          if (!retryable || failures >= MAX_LAUNCH_FAILURES) {
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
            placement:
              allocation.placement ??
              placementForClaim({
                claimed: undefined,
                buildId: allocation.build?.buildId,
                claimLatencyMs: 0,
                fallbackReason: "ec2-startup",
              }),
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

        const environment = allocation.environment;
        const build = allocation.build;
        // A hibernated run owns its filesystem. Claiming a warm guest for it
        // would silently restart the agent on an empty disk, so the retained
        // snapshot always wins over the warm pool.
        const snapshot = retainedRuntimeSnapshot(allocation);
        const claimStarted = yield* DateTime.now;
        const claimed =
          !warmPoolSupportsProfile(allocation.profile.id) ||
          snapshot !== undefined ||
          environment === undefined ||
          build === undefined
            ? undefined
            : yield* warmPool.claim({
                key: {
                  environmentId: environment.environmentId,
                  versionId: environment.versionId,
                  profileId: allocation.profile.id,
                  buildId: build.buildId,
                },
                allocationId: allocation.id,
                occurredAt,
              });
        const claimLatencyMs = Math.max(
          0,
          DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(claimStarted),
        );
        if (claimed !== undefined) {
          yield* warmPool.recordTiming({
            kind: "warm-claim",
            durationMs: claimLatencyMs,
            occurredAt,
          });
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.instance-launched",
            commandId: commandId(allocation, "instance-launched"),
            instanceId: claimed.id,
            placement: placementForClaim({
              claimed,
              buildId: build?.buildId,
              claimLatencyMs,
              fallbackReason: "no-warm-guest",
            }),
          });
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
        let placementHostId: string | undefined;
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
        if (isMacIosWorkerProfile(allocation.profile)) {
          const capacity = yield* workers.inspectMacCapacity({ instanceType }).pipe(Effect.result);
          if (Result.isFailure(capacity)) {
            yield* failLaunch(allocation, occurredAt, capacity.failure.message);
            return;
          }
          const admitted = admitMacIosWorker({
            profile: allocation.profile,
            region: capacity.success.region,
            capacity: capacity.success,
          });
          if (admitted.status === "rejected") {
            yield* failLaunch(allocation, occurredAt, admitted.message);
            return;
          }
          const hosts = yield* macHosts.list;
          const macPlacement = placeMacIosJob({
            hosts,
            region: capacity.success.region,
            instanceType,
            releaseRequested: hosts.some((host) => host.releaseRequestedAt !== undefined),
          });
          if (macPlacement.action === "wait") return;
          if (macPlacement.action === "reject") {
            yield* failLaunch(allocation, occurredAt, macPlacement.reason);
            return;
          }
          if (macPlacement.action === "occupy") {
            yield* macHosts.save(
              CloudMacHostCatalog.occupyMacHost({
                host: macPlacement.host,
                allocationId: allocation.id,
                attempt: allocation.attempt,
                occurredAt,
              }),
            );
            placementHostId = macPlacement.host.awsHostId;
          } else {
            const availabilityZone = capacity.success.availabilityZones[0];
            if (availabilityZone === undefined) {
              yield* failLaunch(
                allocation,
                occurredAt,
                `Region ${capacity.success.region} has no availability zone offering ${instanceType}.`,
              );
              return;
            }
            const allocated = yield* workers
              .allocateDedicatedHost({ instanceType, availabilityZone })
              .pipe(Effect.result);
            if (Result.isFailure(allocated)) {
              yield* failLaunch(allocation, occurredAt, allocated.failure.message);
              return;
            }
            const recorded = CloudMacHostCatalog.recordAllocatedMacHost({
              id: CloudMacHostId.make(`mac:${allocated.success.hostId}`),
              awsHostId: allocated.success.hostId,
              region: capacity.success.region,
              availabilityZone,
              instanceType,
              macos: "image",
              xcode: "image",
              simulatorRuntime: "image",
              allocatedAt: occurredAt,
            });
            yield* macHosts.save(
              CloudMacHostCatalog.occupyMacHost({
                host: recorded,
                allocationId: allocation.id,
                attempt: allocation.attempt,
                occurredAt,
              }),
            );
            placementHostId = allocated.success.hostId;
          }
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
            ...(placementHostId === undefined ? {} : { placementHostId }),
            ...(isLinuxAndroidWorkerProfile(allocation.profile) &&
            androidNeedsNestedVirtualizationLaunch(instanceType)
              ? { nestedVirtualization: true }
              : {}),
          })
          .pipe(Effect.result);
        if (Result.isSuccess(launched)) {
          if (placementHostId !== undefined) {
            const hosts = yield* macHosts.list;
            const host = hosts.find((candidate) => candidate.awsHostId === placementHostId);
            if (host !== undefined) {
              yield* macHosts.save({
                ...host,
                instanceId: launched.success.instanceId,
                updatedAt: occurredAt,
              });
            }
          }
          const placement = placementForClaim({
            claimed: undefined,
            buildId: allocation.build?.buildId,
            claimLatencyMs,
            fallbackReason:
              placementHostId !== undefined
                ? "dedicated-host"
                : allocation.build === undefined
                  ? "no-fresh-build"
                  : "no-warm-guest",
          });
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.instance-launched",
            commandId: commandId(allocation, "instance-launched"),
            instanceId: launched.success.instanceId,
            placement,
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
        const managed = allocation.allocationState.managedRuntime;
        if (managed !== undefined) {
          const inspected = yield* runtimes
            .inspect({ kind: "id", runtimeId: managed.runtimeId })
            .pipe(Effect.result);
          if (Result.isFailure(inspected)) {
            if (
              inspected.failure.reason !== "provider-outage" ||
              hasPassed(now, allocation.deadlines.bootBy)
            ) {
              yield* failLaunch(allocation, occurredAt, inspected.failure.message);
            }
            return;
          }
          if (inspected.success?.lifecycleState === "started") {
            if (input?.daytonaWorker !== undefined) {
              const version = environmentVersionFor(allocation, environments);
              const prepared = yield* input.daytonaWorker
                .prepare({
                  allocation,
                  ...(version === undefined ? {} : { version }),
                })
                .pipe(Effect.result);
              if (Result.isFailure(prepared)) {
                yield* failLaunch(allocation, occurredAt, prepared.failure.message);
                return;
              }
              if (prepared.success.status !== "ready") {
                const stage: RunAllocationProgressStage = (() => {
                  switch (prepared.success.stage) {
                    case "checkout":
                    case "setup":
                    case "provider":
                    case "terminal":
                    case "preview":
                      return prepared.success.stage;
                    case "worker":
                    case "registration":
                      return "setup";
                  }
                })();
                yield* reportProgress({
                  allocation,
                  occurredAt,
                  operation: `worker-${prepared.success.stage}`,
                  stage,
                  status: "running",
                  message:
                    stage === "checkout"
                      ? "Checking out the selected ref and output branch."
                      : stage === "provider"
                        ? "Checking the selected provider inside the sandbox."
                        : stage === "terminal"
                          ? "Starting the environment terminal."
                          : "Starting the environment and T3 worker.",
                });
                return;
              }
            }
            yield* dispatch(allocation, occurredAt, {
              type: "allocation.worker-booted",
              commandId: commandId(allocation, "worker-booted"),
            });
            return;
          }
          if (
            inspected.success === undefined ||
            inspected.success.lifecycleState === "deleted" ||
            inspected.success.lifecycleState === "error"
          ) {
            yield* failLaunch(
              allocation,
              occurredAt,
              "The Daytona sandbox disappeared or entered an error state before boot completed.",
            );
            return;
          }
          if (hasPassed(now, allocation.deadlines.bootBy)) {
            yield* failLaunch(
              allocation,
              occurredAt,
              "The Daytona sandbox did not start before its boot deadline.",
            );
          }
          return;
        }
        if (allocation.placement?.warmFork === "warm") {
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.worker-booted",
            commandId: commandId(allocation, "worker-booted"),
            placement: allocation.placement,
          });
          return;
        }
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
          const bootTimeMs = Math.max(
            0,
            Date.parse(occurredAt) - Date.parse(allocation.allocationState.launchedAt),
          );
          yield* warmPool.recordTiming({
            kind: "ec2-startup",
            durationMs: bootTimeMs,
            occurredAt,
          });
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.worker-booted",
            commandId: commandId(allocation, "worker-booted"),
            placement: {
              warmFork: "cold" as const,
              ...(allocation.build === undefined ? {} : { buildId: allocation.build.buildId }),
              claimLatencyMs: allocation.placement?.claimLatencyMs ?? 0,
              bootTimeMs,
              fallbackReason: allocation.placement?.fallbackReason ?? "ec2-startup",
            },
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
      case "registering": {
        if (input?.daytonaWorker !== undefined && usesManagedRuntime(allocation)) {
          yield* reportProgress({
            allocation,
            occurredAt,
            operation: "worker-registration",
            stage: "setup",
            status: "running",
            message: "Registering the attempt-bound T3 worker route.",
          });
          const registrationCredential = yield* registrations.issueCredential(allocation);
          const prepared = yield* input.daytonaWorker
            .registration({ allocation })
            .pipe(Effect.result);
          if (Result.isSuccess(prepared) && prepared.success !== undefined) {
            const registered = yield* registrations
              .register(registrationCredential, prepared.success)
              .pipe(Effect.result);
            if (Result.isSuccess(registered)) return;
            yield* Effect.logWarning("Could not register the Daytona T3 worker yet.", {
              allocationId: allocation.id,
              attempt: allocation.attempt,
              error: registered.failure.message,
            });
          } else if (Result.isFailure(prepared)) {
            yield* Effect.logWarning("Could not prepare the Daytona T3 worker route yet.", {
              allocationId: allocation.id,
              attempt: allocation.attempt,
              stage: prepared.failure.stage,
              error: prepared.failure.message,
            });
          }
        }
        if (hasPassed(now, allocation.deadlines.registerBy)) {
          yield* failLaunch(
            allocation,
            occurredAt,
            "The worker service did not register before its registration deadline.",
          );
        }
        return;
      }
      case "failed":
        yield* dispatch(allocation, occurredAt, {
          type: "allocation.cancel",
          commandId: commandId(allocation, "cleanup-after-failure"),
        });
        return;
      case "ready": {
        if (
          input?.daytonaWorker !== undefined &&
          usesManagedRuntime(allocation) &&
          allocation.previewState.status === "unavailable"
        ) {
          yield* reportProgress({
            allocation,
            occurredAt,
            operation: "preview-publish",
            stage: "preview",
            status: "running",
            message: "Publishing a short-lived signed Daytona preview.",
          });
          const version = environmentVersionFor(allocation, environments);
          const preview = yield* input.daytonaWorker
            .preview({ allocation, ...(version === undefined ? {} : { version }) })
            .pipe(Effect.result);
          if (Result.isFailure(preview)) {
            yield* Effect.logWarning("Could not publish the Daytona development preview yet.", {
              allocationId: allocation.id,
              attempt: allocation.attempt,
              error: preview.failure.message,
            });
          } else if (preview.success !== undefined) {
            yield* dispatch(allocation, occurredAt, {
              type: "allocation.preview-published",
              commandId: commandId(allocation, "preview-published"),
              url: preview.success,
            });
            return;
          }
        }
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
              ...(isMacIosWorkerProfile(allocation.profile)
                ? {
                    simulator: simulatorWakeResumption({
                      simulatorFlush: snapshot.flush.simulator,
                    }),
                  }
                : {}),
              ...(isLinuxAndroidWorkerProfile(allocation.profile)
                ? {
                    emulator: emulatorWakeResumption({
                      emulatorFlush: snapshot.flush.emulator,
                      avdDataPresent: snapshot.flush.emulator?.status === "flushed",
                    }),
                  }
                : {}),
              restoredAt: occurredAt,
            },
          });
          return;
        }
        if (allocation.execution === undefined || runClient === undefined) return;
        /**
         * A reopen attempt exists so a person can look at the app. It runs the
         * environment's per-boot `start` and stops there: no turn is submitted,
         * so the run state machine never moves and the published branch is left
         * exactly as the run left it.
         */
        if (allocation.attemptPurpose === "reopen") {
          if (allocation.reopen !== undefined) return;
          const version = environmentVersionFor(allocation, environments);
          if (version === undefined) {
            yield* Effect.logWarning("A reopened agent has no environment version to start.", {
              allocationId: allocation.id,
              attempt: allocation.attempt,
            });
            return;
          }
          const reopened = yield* runClient.reopen(allocation, version).pipe(Effect.result);
          if (Result.isFailure(reopened)) {
            yield* Effect.logWarning("Could not start the environment on a reopened guest.", {
              allocationId: allocation.id,
              attempt: allocation.attempt,
              error: reopened.failure.message,
            });
            return;
          }
          yield* dispatch(allocation, occurredAt, {
            type: "allocation.reopened",
            commandId: commandId(allocation, "reopened"),
            reopen: reopened.success,
          });
          return;
        }
        if (allocation.agentOutcome.status === "not-started") {
          yield* reportProgress({
            allocation,
            occurredAt,
            operation: "provider-turn",
            stage: "provider",
            status: "running",
            message: "Starting the provider turn through the registered T3 worker.",
          });
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

  const reconcileWarmPool = Effect.fn("CloudAllocationReconciler.reconcileWarmPool")(function* (
    snapshot: CloudAllocationSnapshot,
    occurredAt: string,
  ) {
    const guests = snapshot.warmGuests ?? [];
    const timings = snapshot.capacity?.timings ?? (yield* warmPool.timings);
    for (const environment of snapshot.environments ?? []) {
      const activeBuildId = environment.activeBuildId;
      if (activeBuildId === undefined) continue;
      const build = (snapshot.builds ?? []).find((candidate) => candidate.id === activeBuildId);
      if (build === undefined) continue;
      const profiles = new Set<string>([
        ...guests
          .filter((guest) => guest.environmentId === environment.id)
          .map((guest) => guest.profileId),
        ...snapshot.allocations
          .filter((allocation) => allocation.environment?.environmentId === environment.id)
          .map((allocation) => allocation.profile.id),
      ]);
      yield* Effect.forEach(
        [...profiles],
        (profileId) =>
          warmPool.drainObsolete({
            environmentId: environment.id,
            profileId,
            versionId: build.versionId,
            buildId: build.id,
            occurredAt,
          }),
        { discard: true },
      );
    }

    const currentGuests = yield* warmPool.list;
    const plan = planWarmPoolCapacity({
      inventories: warmPoolInventories({
        guests: currentGuests,
        allocations: snapshot.allocations,
      }),
      timings,
    });
    yield* Effect.forEach(
      plan.pools,
      (decision) =>
        Effect.gen(function* () {
          const inventory = warmPoolInventories({
            guests: yield* warmPool.list,
            allocations: snapshot.allocations,
          }).find(
            (candidate) =>
              candidate.key.environmentId === decision.key.environmentId &&
              candidate.key.versionId === decision.key.versionId &&
              candidate.key.profileId === decision.key.profileId &&
              candidate.key.buildId === decision.key.buildId,
          );
          const snapshotId = inventory?.snapshotId;
          if (decision.action === "replenish" && snapshotId !== undefined) {
            const have = (inventory?.warming ?? 0) + (inventory?.ready ?? 0);
            const missing = Math.max(0, decision.target - have);
            yield* Effect.forEach(
              Array.from({ length: missing }, (_, index) => index),
              (index) =>
                Effect.gen(function* () {
                  const guest = yield* warmPool.start({
                    id: CloudWarmGuestId.make(
                      `${decision.key.buildId}-warm-${NodeCrypto.randomUUID()}-${index}`,
                    ),
                    key: decision.key,
                    snapshotId,
                    startedAt: occurredAt,
                  });
                  yield* warmPool.markReady({
                    guestId: guest.id,
                    bootTimeMs: timings?.coldBuildRestoreMs ?? 0,
                    occurredAt,
                  });
                  if (timings?.coldBuildRestoreMs !== undefined) {
                    yield* warmPool.recordTiming({
                      kind: "cold-build-restore",
                      durationMs: timings.coldBuildRestoreMs,
                      occurredAt,
                    });
                  }
                }),
              { discard: true },
            );
            return;
          }
          if (decision.action === "drain") {
            yield* warmPool.evictIdle({
              key: decision.key,
              keepReady: decision.target,
              occurredAt,
            });
          }
        }),
      { discard: true },
    );
  });

  const reconcileOnce = Effect.fn("CloudAllocationReconciler.reconcileOnce")(function* () {
    const snapshot = yield* controller.snapshot;
    // A fenced controller has handed its state to another host. Launching or
    // terminating AWS workers from here would make two controllers act on the
    // same allocations.
    if (snapshot.controller.writability?.status === "fenced") return;
    const now = yield* DateTime.now;
    const occurredAt = DateTime.formatIso(now);
    yield* reconcileWarmPool(snapshot, occurredAt);
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
    const idleReleaseSeconds = input?.idleReleaseSeconds ?? snapshot.limits.idleReleaseSeconds;
    const environments = snapshot.environments ?? [];
    for (const next of occupying) {
      yield* reconcileAllocation(
        next,
        snapshot.limits.maxInputWaitSeconds,
        idleReleaseSeconds,
        environments,
      );
    }
    const remainingSlots = snapshot.limits.maxConcurrentWorkers - occupying.length;
    for (const next of queued.slice(0, Math.max(0, remainingSlots))) {
      yield* reconcileAllocation(
        next,
        snapshot.limits.maxInputWaitSeconds,
        idleReleaseSeconds,
        environments,
      );
    }
    yield* reconcileMacHosts(DateTime.formatIso(yield* DateTime.now));
  });

  const reconcileMacHosts = Effect.fn("CloudAllocationReconciler.reconcileMacHosts")(function* (
    occurredAt: string,
  ) {
    const hosts = yield* macHosts.list;
    yield* Effect.forEach(
      hosts,
      (host) =>
        Effect.gen(function* () {
          if (host.availability === "scrubbing" && host.occupiedBy === undefined) {
            yield* macHosts.save(CloudMacHostCatalog.markMacHostAvailable({ host, occurredAt }));
            return;
          }
          if (
            (host.availability === "release-requested" || host.availability === "releasing") &&
            host.occupiedBy === undefined
          ) {
            const now = Date.parse(occurredAt);
            const earliest = Date.parse(host.earliestReleaseAt);
            if (!Number.isFinite(now) || !Number.isFinite(earliest) || now < earliest) return;
            const released = yield* workers
              .releaseDedicatedHost(host.awsHostId)
              .pipe(Effect.result);
            if (Result.isFailure(released)) {
              yield* macHosts.save({ ...host, availability: "releasing", updatedAt: occurredAt });
              return;
            }
            yield* macHosts.save({
              ...host,
              availability: "released",
              releasedAt: occurredAt,
              updatedAt: occurredAt,
            });
          }
        }),
      { discard: true },
    );
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

      const managedResources = yield* runtimes.list().pipe(Effect.result);
      if (Result.isSuccess(managedResources)) {
        yield* Effect.forEach(
          managedResources.success,
          (runtime) => {
            if (retained.has(runtime.runtimeId)) return Effect.void;
            const allocation = allocations.get(runtime.allocationId);
            const recorded = allocation === undefined ? undefined : managedRuntimeOf(allocation);
            const abandoned =
              allocation === undefined ||
              runtime.attempt < allocation.attempt ||
              allocation.cleanupState.status === "succeeded" ||
              (recorded !== undefined && recorded.runtimeId !== runtime.runtimeId);
            return abandoned ? runtimes.delete(runtime.runtimeId) : Effect.void;
          },
          { discard: true },
        );
      } else if (
        managedResources.failure.reason !== "disabled" &&
        managedResources.failure.reason !== "unauthenticated"
      ) {
        yield* Effect.logWarning("Could not reconcile Daytona sandboxes.", {
          error: managedResources.failure.message,
        });
      }

      const legacyResources = yield* workers.listWorkers().pipe(Effect.result);
      if (Result.isFailure(legacyResources)) return;
      const resources = legacyResources.success;

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
    const daytonaWorker = yield* DaytonaWorkerBootstrap.make();
    const reconciler = yield* make({ runClient, daytonaWorker });
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
