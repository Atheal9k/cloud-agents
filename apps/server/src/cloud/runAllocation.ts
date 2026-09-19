import {
  CloudAgentId,
  type CloudEnvironmentBuildReference,
  type CloudEnvironmentVersionReference,
  RunAllocationAttempt,
  type RunAllocation,
  type RunAllocationCommand,
  type RunAllocationEvent,
} from "@t3tools/contracts";

import { hasAgentSettled } from "./cloudHibernationPolicy.ts";

function assertNever(value: never): never {
  throw new Error(`Unhandled allocation variant: ${String(value)}`);
}

function eventBase(
  allocation: RunAllocation,
  command: Exclude<RunAllocationCommand, { readonly type: "allocation.launch" }>,
) {
  return {
    sequence: allocation.sequence + 1,
    commandId: command.commandId,
    allocationId: command.allocationId,
    attempt: command.attempt,
    occurredAt: command.occurredAt,
  };
}

/**
 * Pure controller transition. An empty result means the command was already
 * handled, targets a stale attempt, or cannot change the current state.
 */
export function decideRunAllocationCommand(
  allocation: RunAllocation | undefined,
  command: RunAllocationCommand,
  /**
   * Environment version the controller resolved for a launch. Absent when no
   * environment covers the repository. Callers never take this from the client.
   */
  environment?: CloudEnvironmentVersionReference,
  /**
   * Prepared snapshot the run boots before checking out its requested ref.
   * Absent when the environment has no active, fresh Build.
   */
  build?: CloudEnvironmentBuildReference,
): ReadonlyArray<RunAllocationEvent> {
  if (command.type === "allocation.launch") {
    if (allocation !== undefined) return [];
    return [
      {
        type: "allocation.requested",
        sequence: 1,
        commandId: command.commandId,
        allocationId: command.allocationId,
        attempt: command.attempt,
        occurredAt: command.occurredAt,
        target: command.target,
        publication: command.publication,
        ...(command.execution === undefined ? {} : { execution: command.execution }),
        ...(command.control === undefined ? {} : { control: command.control }),
        profile: command.profile,
        ...(environment === undefined ? {} : { environment }),
        ...(build === undefined ? {} : { build }),
        deadlines: command.deadlines,
      },
    ];
  }

  if (
    allocation === undefined ||
    allocation.id !== command.allocationId ||
    allocation.handledCommandIds.includes(command.commandId) ||
    allocation.attempt !== command.attempt
  ) {
    return [];
  }

  const base = eventBase(allocation, command);
  switch (command.type) {
    case "allocation.launch-started":
      return allocation.allocationState.status === "queued" &&
        allocation.agentOutcome.status === "not-started" &&
        allocation.cleanupState.status === "not-requested"
        ? [{ ...base, type: command.type, launchTemplate: command.launchTemplate }]
        : [];
    case "allocation.launch-retry-scheduled":
      return allocation.allocationState.status === "launching" &&
        command.failures === allocation.allocationState.retry.failures + 1 &&
        allocation.agentOutcome.status === "not-started" &&
        allocation.cleanupState.status === "not-requested"
        ? [
            {
              ...base,
              type: command.type,
              failures: command.failures,
              retryAt: command.retryAt,
              reason: command.reason,
            },
          ]
        : [];
    case "allocation.instance-launched":
      return allocation.allocationState.status === "launching" &&
        allocation.agentOutcome.status === "not-started" &&
        allocation.cleanupState.status === "not-requested"
        ? [
            {
              ...base,
              type: command.type,
              instanceId: command.instanceId,
              ...(command.placement === undefined ? {} : { placement: command.placement }),
            },
          ]
        : [];
    case "allocation.worker-booted":
      return allocation.allocationState.status === "booting" &&
        allocation.agentOutcome.status === "not-started" &&
        allocation.cleanupState.status === "not-requested"
        ? [
            {
              ...base,
              type: command.type,
              ...(command.placement === undefined ? {} : { placement: command.placement }),
            },
          ]
        : [];
    case "allocation.worker-assigned":
      return allocation.allocationState.status === "registering" &&
        allocation.agentOutcome.status === "not-started" &&
        allocation.cleanupState.status === "not-requested"
        ? [{ ...base, type: command.type, references: command.references }]
        : [];
    case "allocation.worker-registered":
      return allocation.allocationState.status === "registering" &&
        allocation.agentOutcome.status === "not-started" &&
        allocation.cleanupState.status === "not-requested"
        ? [
            {
              ...base,
              type: command.type,
              references: command.references,
              route: command.route,
            },
          ]
        : [];
    case "allocation.launch-failed":
      return (allocation.allocationState.status === "queued" ||
        allocation.allocationState.status === "launching" ||
        allocation.allocationState.status === "booting" ||
        allocation.allocationState.status === "registering") &&
        allocation.agentOutcome.status === "not-started" &&
        allocation.cleanupState.status === "not-requested"
        ? [{ ...base, type: command.type, reason: command.reason }]
        : [];
    case "allocation.agent-started":
      return allocation.allocationState.status === "ready" &&
        allocation.agentOutcome.status === "not-started" &&
        allocation.cleanupState.status === "not-requested"
        ? [{ ...base, type: command.type }]
        : [];
    case "allocation.agent-succeeded":
      return allocation.agentOutcome.status === "running"
        ? [{ ...base, type: command.type, resultLocation: command.resultLocation }]
        : [];
    case "allocation.agent-failed":
      return allocation.agentOutcome.status === "running"
        ? [
            {
              ...base,
              type: command.type,
              reason: command.reason,
              resultLocation: command.resultLocation,
            },
          ]
        : [];
    case "allocation.preview-published":
      return allocation.allocationState.status === "ready" &&
        allocation.cleanupState.status !== "running" &&
        allocation.cleanupState.status !== "succeeded"
        ? [{ ...base, type: command.type, url: command.url }]
        : [];
    case "allocation.preview-withdrawn":
      return allocation.previewState.status === "available"
        ? [{ ...base, type: command.type }]
        : [];
    case "allocation.idle":
      return allocation.allocationState.status === "ready" &&
        hasAgentSettled(allocation) &&
        allocation.idleState.status === "busy" &&
        allocation.cleanupState.status === "not-requested"
        ? [
            {
              ...base,
              type: "allocation.went-idle",
              releaseAt: command.releaseAt,
              flush: command.flush,
            },
          ]
        : [];
    case "allocation.hibernate":
      return allocation.idleState.status === "idle" &&
        allocation.cleanupState.status === "not-requested"
        ? [{ ...base, type: "allocation.hibernated", snapshot: command.snapshot }]
        : [];
    case "allocation.runtime-restored":
      return allocation.idleState.status === "waking" &&
        allocation.allocationState.status === "ready"
        ? [{ ...base, type: "allocation.runtime-restored", restore: command.restore }]
        : [];
    case "allocation.cancel":
      return allocation.cleanupState.status === "not-requested" ||
        allocation.cleanupState.status === "failed"
        ? [{ ...base, type: "allocation.cancellation-requested" }]
        : [];
    case "allocation.expire":
      return (allocation.agentOutcome.status === "not-started" ||
        allocation.agentOutcome.status === "running") &&
        allocation.cleanupState.status === "not-requested"
        ? [{ ...base, type: "allocation.expired" }]
        : [];
    case "allocation.follow-up": {
      const terminal =
        allocation.agentOutcome.status === "succeeded" ||
        allocation.agentOutcome.status === "failed" ||
        allocation.agentOutcome.status === "cancelled" ||
        allocation.agentOutcome.status === "expired";
      /**
       * A hibernated guest is stopped, so its route is gone and its runtime is
       * finished. Waking it takes a fresh attempt that fences the old runtime
       * and restores exactly one guest from the recorded snapshot.
       */
      const wakeSnapshot =
        allocation.idleState.status === "hibernated" ? allocation.idleState.snapshot : undefined;
      const reuseRuntime =
        wakeSnapshot === undefined &&
        allocation.allocationState.status === "ready" &&
        allocation.cleanupState.status === "not-requested";
      const replaceRuntime = allocation.cleanupState.status === "succeeded";
      if (
        allocation.archivedAt !== undefined ||
        !terminal ||
        (!reuseRuntime && !replaceRuntime && wakeSnapshot === undefined)
      ) {
        return [];
      }
      return [
        {
          ...base,
          type: "allocation.follow-up-requested",
          attempt: reuseRuntime
            ? allocation.attempt
            : RunAllocationAttempt.make(allocation.attempt + 1),
          runId: command.runId,
          execution: command.execution,
          deadlines: command.deadlines,
          ...(wakeSnapshot === undefined ? {} : { restoreFrom: wakeSnapshot }),
        },
      ];
    }
    case "allocation.agent-archive":
      return allocation.archivedAt === undefined &&
        allocation.agentOutcome.status !== "not-started" &&
        allocation.agentOutcome.status !== "running"
        ? [{ ...base, type: "allocation.agent-archived" }]
        : [];
    case "allocation.agent-unarchive":
      return allocation.archivedAt === undefined
        ? []
        : [{ ...base, type: "allocation.agent-unarchived" }];
    case "allocation.cleanup-started":
      return allocation.cleanupState.status === "requested"
        ? [{ ...base, type: command.type }]
        : [];
    case "allocation.cleanup-succeeded":
      return allocation.cleanupState.status === "running" ? [{ ...base, type: command.type }] : [];
    case "allocation.cleanup-failed":
      return allocation.cleanupState.status === "running"
        ? [{ ...base, type: command.type, reason: command.reason }]
        : [];
    case "allocation.retry":
      return allocation.cleanupState.status === "succeeded" &&
        allocation.allocationState.status === "failed" &&
        command.nextAttempt === allocation.attempt + 1
        ? [
            {
              ...base,
              type: "allocation.retry-requested",
              attempt: command.nextAttempt,
              deadlines: command.deadlines,
              startPoint: command.startPoint,
              publication: command.publication,
            },
          ]
        : [];
    default:
      return assertNever(command);
  }
}

function requireCurrentEvent(allocation: RunAllocation, event: RunAllocationEvent): void {
  if (allocation.id !== event.allocationId) {
    throw new Error(`Allocation event ${event.sequence} targets a different allocation`);
  }
  if (event.sequence !== allocation.sequence + 1) {
    throw new Error(`Allocation event ${event.sequence} is not the next sequence`);
  }
  if (
    event.type === "allocation.retry-requested" ||
    (event.type === "allocation.follow-up-requested" && event.attempt !== allocation.attempt)
      ? event.attempt !== allocation.attempt + 1
      : event.attempt !== allocation.attempt
  ) {
    throw new Error(`Allocation event ${event.sequence} targets the wrong attempt`);
  }
}

function projectUpdate(
  allocation: RunAllocation,
  event: RunAllocationEvent,
  patch: Partial<RunAllocation>,
): RunAllocation {
  return {
    ...allocation,
    ...patch,
    handledCommandIds: [...allocation.handledCommandIds, event.commandId],
    sequence: event.sequence,
    updatedAt: event.occurredAt,
  };
}

/** Project one persisted event. Sequence or attempt gaps fail replay loudly. */
export function projectRunAllocationEvent(
  allocation: RunAllocation | undefined,
  event: RunAllocationEvent,
): RunAllocation {
  if (allocation === undefined) {
    if (event.type !== "allocation.requested") {
      throw new Error("The first allocation event must request the allocation");
    }
    if (event.sequence !== 1) {
      throw new Error("The first allocation event must have sequence 1");
    }
    return {
      id: event.allocationId,
      attempt: event.attempt,
      target: event.target,
      publication: event.publication ?? { mode: "review-only" },
      ...(event.execution === undefined ? {} : { execution: event.execution }),
      ...(event.control === undefined ? {} : { control: event.control }),
      profile: event.profile,
      ...(event.environment === undefined ? {} : { environment: event.environment }),
      ...(event.build === undefined ? {} : { build: event.build }),
      deadlines: event.deadlines,
      allocationState: { status: "queued" },
      agentOutcome: { status: "not-started" },
      previewState: { status: "unavailable" },
      idleState: { status: "busy" },
      cleanupState: { status: "not-requested" },
      handledCommandIds: [event.commandId],
      sequence: event.sequence,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    };
  }

  if (allocation.handledCommandIds.includes(event.commandId)) return allocation;
  if (event.type === "allocation.requested") {
    throw new Error("An allocation can only be requested once");
  }
  requireCurrentEvent(allocation, event);

  switch (event.type) {
    case "allocation.launch-started":
      return projectUpdate(allocation, event, {
        allocationState: {
          status: "launching",
          startedAt: event.occurredAt,
          launchTemplate: event.launchTemplate,
          retry: { status: "ready", failures: 0 },
        },
      });
    case "allocation.launch-retry-scheduled":
      if (allocation.allocationState.status !== "launching") {
        throw new Error("A launch retry requires a launching allocation");
      }
      return projectUpdate(allocation, event, {
        allocationState: {
          ...allocation.allocationState,
          retry: {
            status: "waiting",
            failures: event.failures,
            retryAt: event.retryAt,
            reason: event.reason,
          },
        },
      });
    case "allocation.instance-launched":
      return projectUpdate(allocation, event, {
        allocationState: {
          status: "booting",
          instanceId: event.instanceId,
          launchedAt: event.occurredAt,
        },
        ...(event.placement === undefined ? {} : { placement: event.placement }),
      });
    case "allocation.worker-booted":
      if (allocation.allocationState.status !== "booting") {
        throw new Error("A boot receipt requires a booting allocation");
      }
      return projectUpdate(allocation, event, {
        allocationState: {
          status: "registering",
          instanceId: allocation.allocationState.instanceId,
          bootedAt: event.occurredAt,
        },
        ...(event.placement === undefined ? {} : { placement: event.placement }),
      });
    case "allocation.worker-assigned":
      if (allocation.allocationState.status !== "registering") {
        throw new Error("Worker assignment requires a registering allocation");
      }
      return projectUpdate(allocation, event, {
        allocationState: {
          status: "ready",
          instanceId: allocation.allocationState.instanceId,
          references: event.references,
          readyAt: event.occurredAt,
        },
      });
    case "allocation.worker-registered":
      if (allocation.allocationState.status !== "registering") {
        throw new Error("Worker registration requires a registering allocation");
      }
      return projectUpdate(allocation, event, {
        allocationState: {
          status: "ready",
          instanceId: allocation.allocationState.instanceId,
          references: event.references,
          route: event.route,
          readyAt: event.occurredAt,
        },
      });
    case "allocation.launch-failed":
      const instanceId =
        allocation.allocationState.status === "booting" ||
        allocation.allocationState.status === "registering" ||
        allocation.allocationState.status === "ready"
          ? allocation.allocationState.instanceId
          : undefined;
      return projectUpdate(allocation, event, {
        allocationState: {
          status: "failed",
          reason: event.reason,
          failedAt: event.occurredAt,
          ...(instanceId === undefined ? {} : { instanceId }),
        },
      });
    case "allocation.agent-started":
      return projectUpdate(allocation, event, {
        agentOutcome: { status: "running", startedAt: event.occurredAt },
      });
    case "allocation.agent-succeeded":
      return projectUpdate(allocation, event, {
        agentOutcome: {
          status: "succeeded",
          resultLocation: event.resultLocation,
          completedAt: event.occurredAt,
        },
      });
    case "allocation.agent-failed":
      return projectUpdate(allocation, event, {
        agentOutcome: {
          status: "failed",
          reason: event.reason,
          resultLocation: event.resultLocation,
          completedAt: event.occurredAt,
        },
      });
    case "allocation.preview-published":
      return projectUpdate(allocation, event, {
        previewState: {
          status: "available",
          url: event.url,
          publishedAt: event.occurredAt,
        },
      });
    case "allocation.preview-withdrawn":
      return projectUpdate(allocation, event, { previewState: { status: "unavailable" } });
    case "allocation.went-idle":
      return projectUpdate(allocation, event, {
        idleState: {
          status: "idle",
          settledAt: event.occurredAt,
          releaseAt: event.releaseAt,
          flush: event.flush,
        },
      });
    case "allocation.hibernated": {
      if (allocation.allocationState.status !== "ready") {
        throw new Error("Hibernation requires a ready allocation");
      }
      // The guest is stopped, so its route and any preview it served are gone.
      // Dropping the route here is what stops the controller from dialing a
      // machine that is not running.
      const { route, ...stopped } = allocation.allocationState;
      void route;
      return projectUpdate(allocation, event, {
        allocationState: stopped,
        previewState: { status: "unavailable" },
        idleState: {
          status: "hibernated",
          hibernatedAt: event.occurredAt,
          snapshot: event.snapshot,
        },
      });
    }
    case "allocation.runtime-restored":
      return projectUpdate(allocation, event, {
        idleState: { status: "busy", restore: event.restore },
      });
    case "allocation.cancellation-requested":
      return projectUpdate(allocation, event, {
        agentOutcome:
          allocation.agentOutcome.status === "succeeded" ||
          allocation.agentOutcome.status === "failed"
            ? allocation.agentOutcome
            : { status: "cancelled", cancelledAt: event.occurredAt },
        // Cleanup releases the guest, so the allocation stops holding an idle
        // one. The snapshot it was keeping is no longer restorable.
        idleState: { status: "busy" },
        cleanupState: { status: "requested", requestedAt: event.occurredAt },
      });
    case "allocation.expired":
      return projectUpdate(allocation, event, {
        agentOutcome: { status: "expired", expiredAt: event.occurredAt },
        idleState: { status: "busy" },
        cleanupState: { status: "requested", requestedAt: event.occurredAt },
      });
    case "allocation.follow-up-requested": {
      const replacedRuntime = event.attempt !== allocation.attempt;
      const runtimeReset = replacedRuntime
        ? ({
            allocationState: { status: "queued" },
            previewState: { status: "unavailable" },
            cleanupState: { status: "not-requested" },
          } satisfies Pick<RunAllocation, "allocationState" | "previewState" | "cleanupState">)
        : {};
      return projectUpdate(allocation, event, {
        attempt: event.attempt,
        idleState:
          event.restoreFrom === undefined
            ? { status: "busy" }
            : {
                status: "waking",
                requestedAt: event.occurredAt,
                snapshot: event.restoreFrom,
              },
        execution: event.execution,
        control: {
          agentId: allocation.control?.agentId ?? CloudAgentId.make(`agent:${allocation.id}`),
          runId: event.runId,
        },
        deadlines: event.deadlines,
        agentOutcome: { status: "not-started" },
        ...runtimeReset,
      });
    }
    case "allocation.agent-archived":
      return projectUpdate(allocation, event, {
        archivedAt: event.occurredAt,
        cleanupState:
          allocation.cleanupState.status === "not-requested"
            ? { status: "requested", requestedAt: event.occurredAt }
            : allocation.cleanupState,
      });
    case "allocation.agent-unarchived": {
      const { archivedAt, ...unarchived } = allocation;
      void archivedAt;
      return projectUpdate(unarchived, event, {});
    }
    case "allocation.cleanup-started":
      return projectUpdate(allocation, event, {
        cleanupState: { status: "running", startedAt: event.occurredAt },
      });
    case "allocation.cleanup-succeeded":
      return projectUpdate(allocation, event, {
        previewState: { status: "unavailable" },
        cleanupState: { status: "succeeded", completedAt: event.occurredAt },
      });
    case "allocation.cleanup-failed":
      return projectUpdate(allocation, event, {
        cleanupState: {
          status: "failed",
          reason: event.reason,
          failedAt: event.occurredAt,
        },
      });
    case "allocation.retry-requested":
      return projectUpdate(allocation, event, {
        attempt: event.attempt,
        deadlines: event.deadlines,
        retry: {
          previousAttempt: allocation.attempt,
          startPoint: event.startPoint ?? {
            type: "base-commit",
            commit: allocation.target.baseCommit,
          },
          publication: event.publication ?? { status: "not-attempted" },
        },
        allocationState: { status: "queued" },
        agentOutcome: { status: "not-started" },
        previewState: { status: "unavailable" },
        idleState: { status: "busy" },
        cleanupState: { status: "not-requested" },
      });
    default:
      return assertNever(event);
  }
}

export function replayRunAllocationEvents(
  events: ReadonlyArray<RunAllocationEvent>,
): RunAllocation | undefined {
  let allocation: RunAllocation | undefined;
  for (const event of events) {
    allocation = projectRunAllocationEvent(allocation, event);
  }
  return allocation;
}
