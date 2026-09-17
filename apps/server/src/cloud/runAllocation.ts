import type { RunAllocation, RunAllocationCommand, RunAllocationEvent } from "@t3tools/contracts";

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
        profile: command.profile,
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
        ? [{ ...base, type: command.type, instanceId: command.instanceId }]
        : [];
    case "allocation.worker-booted":
      return allocation.allocationState.status === "booting" &&
        allocation.agentOutcome.status === "not-started" &&
        allocation.cleanupState.status === "not-requested"
        ? [{ ...base, type: command.type }]
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
    case "allocation.cancel":
      return allocation.cleanupState.status === "not-requested" ||
        allocation.cleanupState.status === "failed"
        ? [{ ...base, type: "allocation.cancellation-requested" }]
        : [];
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
        (allocation.allocationState.status === "failed" ||
          allocation.agentOutcome.status === "failed" ||
          allocation.agentOutcome.status === "cancelled") &&
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
    event.type === "allocation.retry-requested"
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
      profile: event.profile,
      deadlines: event.deadlines,
      allocationState: { status: "queued" },
      agentOutcome: { status: "not-started" },
      previewState: { status: "unavailable" },
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
    case "allocation.cancellation-requested":
      return projectUpdate(allocation, event, {
        agentOutcome:
          allocation.agentOutcome.status === "succeeded" ||
          allocation.agentOutcome.status === "failed"
            ? allocation.agentOutcome
            : { status: "cancelled", cancelledAt: event.occurredAt },
        cleanupState: { status: "requested", requestedAt: event.occurredAt },
      });
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
