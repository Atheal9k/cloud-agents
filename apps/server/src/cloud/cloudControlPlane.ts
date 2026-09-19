import {
  CloudAgentId,
  CloudRunId,
  CloudRuntimeAttemptId,
  type CloudAgent,
  type CloudRun,
  type CloudRuntimeAttempt,
  type RunAllocationEvent,
} from "@t3tools/contracts";

function assertNever(value: never): never {
  throw new Error(`Unhandled cloud control-plane event: ${String(value)}`);
}

function runtimeId(allocationId: string, attempt: number): CloudRuntimeAttemptId {
  return CloudRuntimeAttemptId.make(`runtime:${allocationId}:${attempt}`);
}

function runBase(run: CloudRun, updatedAt: string) {
  return {
    id: run.id,
    agentId: run.agentId,
    allocationId: run.allocationId,
    branch: run.branch,
    ...(run.execution === undefined ? {} : { execution: run.execution }),
    createdAt: run.createdAt,
    updatedAt,
  };
}

function runtimeBase(runtime: CloudRuntimeAttempt, updatedAt: string) {
  return {
    id: runtime.id,
    agentId: runtime.agentId,
    allocationId: runtime.allocationId,
    attempt: runtime.attempt,
    runIds: runtime.runIds,
    createdAt: runtime.createdAt,
    updatedAt,
  };
}

function activeRun(run: CloudRun): boolean {
  return run.status === "CREATING" || run.status === "RUNNING";
}

export interface CloudControlPlaneProjection {
  readonly agents: ReadonlyArray<CloudAgent>;
  readonly runs: ReadonlyArray<CloudRun>;
  readonly runtimeAttempts: ReadonlyArray<CloudRuntimeAttempt>;
}

export function projectCloudControlPlane(
  eventGroups: Iterable<ReadonlyArray<RunAllocationEvent>>,
): CloudControlPlaneProjection {
  const agents: CloudAgent[] = [];
  const allRuns: CloudRun[] = [];
  const allRuntimes: CloudRuntimeAttempt[] = [];

  for (const events of eventGroups) {
    const requested = events[0];
    if (requested === undefined) continue;
    if (requested.type !== "allocation.requested") {
      throw new Error("The first cloud control-plane event must request an allocation");
    }

    const agentId =
      requested.control?.agentId ?? CloudAgentId.make(`agent:${requested.allocationId}`);
    const firstRunId =
      requested.control?.runId ?? CloudRunId.make(`run:${requested.allocationId}:1`);
    let currentRunId = firstRunId;
    let archivedAt: string | undefined;
    let deletedAt: string | undefined;
    let updatedAt = requested.occurredAt;
    const runs = new Map<CloudRunId, CloudRun>();
    const runtimes = new Map<number, CloudRuntimeAttempt>();

    runs.set(firstRunId, {
      id: firstRunId,
      agentId,
      allocationId: requested.allocationId,
      branch: requested.target.branch,
      ...(requested.execution === undefined ? {} : { execution: requested.execution }),
      status: "CREATING",
      createdAt: requested.occurredAt,
      updatedAt: requested.occurredAt,
    });
    runtimes.set(requested.attempt, {
      id: runtimeId(requested.allocationId, requested.attempt),
      agentId,
      allocationId: requested.allocationId,
      attempt: requested.attempt,
      runIds: [firstRunId],
      status: "CREATING",
      createdAt: requested.occurredAt,
      updatedAt: requested.occurredAt,
    });

    for (const event of events.slice(1)) {
      updatedAt = event.occurredAt;
      const run = runs.get(currentRunId);
      const runtime = runtimes.get(event.attempt);

      switch (event.type) {
        case "allocation.requested":
          throw new Error("A cloud agent can only be requested once");
        case "allocation.launch-started":
        case "allocation.launch-retry-scheduled":
        case "allocation.instance-launched":
        case "allocation.worker-booted":
        case "allocation.preview-published":
        case "allocation.preview-withdrawn":
        case "allocation.cleanup-started":
        case "allocation.cleanup-failed":
        case "allocation.went-idle":
        case "allocation.runtime-restored":
          if (runtime !== undefined) {
            runtimes.set(event.attempt, { ...runtime, updatedAt: event.occurredAt });
          }
          break;
        case "allocation.hibernated":
          // The guest is stopped with its disk intact, so the runtime is not
          // released: a later attempt restores this exact snapshot.
          if (runtime !== undefined) {
            runtimes.set(event.attempt, {
              ...runtimeBase(runtime, event.occurredAt),
              status: "HIBERNATED",
              snapshot: event.snapshot,
            });
          }
          break;
        case "allocation.worker-assigned":
        case "allocation.worker-registered":
          if (runtime !== undefined) {
            runtimes.set(event.attempt, {
              ...runtimeBase(runtime, event.occurredAt),
              status: "ACTIVE",
              references: event.references,
            });
          }
          break;
        case "allocation.launch-failed":
          if (runtime !== undefined) {
            runtimes.set(event.attempt, {
              ...runtimeBase(runtime, event.occurredAt),
              status: "ERROR",
              reason: event.reason,
            });
          }
          if (run !== undefined && activeRun(run)) {
            runs.set(currentRunId, {
              ...runBase(run, event.occurredAt),
              status: "ERROR",
              completedAt: event.occurredAt,
              reason: event.reason,
            });
          }
          break;
        case "allocation.agent-started":
          if (run !== undefined && run.status === "CREATING") {
            runs.set(currentRunId, {
              ...runBase(run, event.occurredAt),
              status: "RUNNING",
              startedAt: event.occurredAt,
            });
          }
          break;
        case "allocation.agent-succeeded":
          if (run !== undefined && run.status === "RUNNING") {
            runs.set(currentRunId, {
              ...runBase(run, event.occurredAt),
              status: "FINISHED",
              completedAt: event.occurredAt,
              resultLocation: event.resultLocation,
            });
          }
          break;
        case "allocation.agent-failed":
          if (run !== undefined && run.status === "RUNNING") {
            runs.set(currentRunId, {
              ...runBase(run, event.occurredAt),
              status: "ERROR",
              completedAt: event.occurredAt,
              reason: event.reason,
              resultLocation: event.resultLocation,
            });
          }
          break;
        case "allocation.cancellation-requested":
          if (run !== undefined && activeRun(run)) {
            runs.set(currentRunId, {
              ...runBase(run, event.occurredAt),
              status: "CANCELLED",
              completedAt: event.occurredAt,
            });
          }
          break;
        case "allocation.expired":
          if (run !== undefined && activeRun(run)) {
            runs.set(currentRunId, {
              ...runBase(run, event.occurredAt),
              status: "EXPIRED",
              completedAt: event.occurredAt,
            });
          }
          break;
        case "allocation.cleanup-succeeded":
          if (runtime !== undefined && runtime.status !== "FENCED") {
            runtimes.set(event.attempt, {
              ...runtimeBase(runtime, event.occurredAt),
              status: "RELEASED",
            });
          }
          break;
        case "allocation.retry-requested": {
          const previous = runtimes.get(event.attempt - 1);
          if (previous !== undefined) {
            runtimes.set(previous.attempt, {
              ...runtimeBase(previous, event.occurredAt),
              status: "FENCED",
            });
          }
          if (run !== undefined) {
            runs.set(currentRunId, {
              ...runBase(run, event.occurredAt),
              status: "CREATING",
            });
          }
          runtimes.set(event.attempt, {
            id: runtimeId(event.allocationId, event.attempt),
            agentId,
            allocationId: event.allocationId,
            attempt: event.attempt,
            runIds: [currentRunId],
            status: "CREATING",
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
          });
          break;
        }
        case "allocation.follow-up-requested": {
          const previousRunId = currentRunId;
          currentRunId = event.runId;
          runs.set(currentRunId, {
            id: currentRunId,
            agentId,
            allocationId: event.allocationId,
            branch: requested.target.branch,
            execution: event.execution,
            status: "CREATING",
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
          });
          const followUpRuntime = runtimes.get(event.attempt);
          if (followUpRuntime === undefined) {
            const previousRuntime = [...runtimes.values()].findLast((candidate) =>
              candidate.runIds.includes(previousRunId),
            );
            if (previousRuntime !== undefined) {
              runtimes.set(previousRuntime.attempt, {
                ...runtimeBase(previousRuntime, event.occurredAt),
                status: "FENCED",
              });
            }
            runtimes.set(event.attempt, {
              id: runtimeId(event.allocationId, event.attempt),
              agentId,
              allocationId: event.allocationId,
              attempt: event.attempt,
              runIds: [currentRunId],
              status: "CREATING",
              createdAt: event.occurredAt,
              updatedAt: event.occurredAt,
            });
          } else {
            runtimes.set(event.attempt, {
              ...followUpRuntime,
              runIds: [...followUpRuntime.runIds, currentRunId],
              updatedAt: event.occurredAt,
            });
          }
          break;
        }
        case "allocation.agent-archived":
          archivedAt = event.occurredAt;
          break;
        case "allocation.agent-unarchived":
          archivedAt = undefined;
          break;
        case "allocation.agent-deleted":
          deletedAt = event.occurredAt;
          break;
        default:
          assertNever(event);
      }
    }

    const projectedRuns = [...runs.values()];
    const projectedRuntimes = [...runtimes.values()];
    const latestRun = runs.get(currentRunId);
    if (latestRun === undefined) {
      throw new Error("A cloud agent must retain its current run");
    }
    const conversation = {
      title: requested.execution?.title ?? requested.target.repository,
      runIds: projectedRuns.map((run) => run.id),
    };
    const agentBase = {
      id: agentId,
      allocationId: requested.allocationId,
      conversation,
      repository: requested.target.repository,
      baseCommit: requested.target.baseCommit,
      environmentProfileId: requested.profile.id,
      ...(requested.environment === undefined ? {} : { environment: requested.environment }),
      branches: [...new Set(projectedRuns.map((run) => run.branch))],
      createdAt: requested.occurredAt,
      updatedAt,
    };

    if (deletedAt !== undefined) {
      continue;
    }

    if (archivedAt !== undefined) {
      agents.push({ ...agentBase, status: "ARCHIVED", archivedAt });
    } else if (activeRun(latestRun)) {
      const activeRuntime = projectedRuntimes.findLast(
        (candidate) => candidate.status === "ACTIVE" && candidate.runIds.includes(latestRun.id),
      );
      agents.push({
        ...agentBase,
        status: "ACTIVE",
        activeRunId: latestRun.id,
        ...(activeRuntime?.status === "ACTIVE"
          ? {
              runtime: {
                runtimeAttemptId: activeRuntime.id,
                ...activeRuntime.references,
              },
            }
          : {}),
      });
    } else {
      agents.push({ ...agentBase, status: "IDLE" });
    }

    allRuns.push(...projectedRuns);
    allRuntimes.push(...projectedRuntimes);
  }

  return { agents, runs: allRuns, runtimeAttempts: allRuntimes };
}
