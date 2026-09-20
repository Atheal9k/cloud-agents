import type { CloudEnvironmentBuild, RunAllocation, ThreadId } from "@t3tools/contracts";

type SetupExecution = Pick<
  NonNullable<RunAllocation["execution"]>,
  "threadId" | "environmentSetup"
>;

export type CloudEnvironmentSetupAllocation = Pick<
  RunAllocation,
  | "id"
  | "attempt"
  | "allocationState"
  | "agentOutcome"
  | "idleState"
  | "cleanupState"
  | "target"
  | "createdAt"
  | "updatedAt"
> & {
  readonly execution?: SetupExecution;
};

export type CloudEnvironmentSetupState =
  | { readonly kind: "building"; readonly build: CloudEnvironmentBuild }
  | { readonly kind: "verifying"; readonly build: CloudEnvironmentBuild }
  | { readonly kind: "ready"; readonly build: CloudEnvironmentBuild }
  | { readonly kind: "saved"; readonly build: CloudEnvironmentBuild }
  | { readonly kind: "failed"; readonly build: CloudEnvironmentBuild; readonly message: string };

export function cloudEnvironmentSetupState(
  builds: ReadonlyArray<CloudEnvironmentBuild>,
  threadId: ThreadId,
): CloudEnvironmentSetupState | null {
  const build = builds
    .filter((candidate) => candidate.setupThreadId === threadId)
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  if (build === undefined) return null;
  if (build.outcome.status === "running") return { kind: "building", build };
  if (build.outcome.status === "failed") {
    return { kind: "failed", build, message: build.outcome.message };
  }
  if (build.outcome.status === "cancelled") {
    return { kind: "failed", build, message: "The environment Build was cancelled." };
  }
  if (build.outcome.status === "skipped") {
    return { kind: "failed", build, message: "The draft Build did not produce a new snapshot." };
  }
  if (!build.draft) return { kind: "saved", build };
  return build.readyToSaveAt === undefined
    ? { kind: "verifying", build }
    : { kind: "ready", build };
}

export function cloudEnvironmentSetupAllocation(
  allocations: ReadonlyArray<CloudEnvironmentSetupAllocation>,
  threadId: ThreadId,
): CloudEnvironmentSetupAllocation | null {
  return (
    allocations.find(
      (allocation) =>
        allocation.execution?.threadId === threadId &&
        allocation.execution.environmentSetup !== undefined,
    ) ?? null
  );
}

export function latestPendingCloudEnvironmentSetupAllocation(
  allocations: ReadonlyArray<CloudEnvironmentSetupAllocation>,
  repository?: string,
): CloudEnvironmentSetupAllocation | null {
  return (
    allocations
      .filter(
        (allocation) =>
          allocation.execution?.environmentSetup !== undefined &&
          allocation.cleanupState.status !== "succeeded" &&
          (repository === undefined || allocation.target.repository === repository),
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  );
}

export function canStopCloudEnvironmentSetup(allocation: CloudEnvironmentSetupAllocation): boolean {
  return (
    allocation.cleanupState.status === "not-requested" ||
    allocation.cleanupState.status === "failed"
  );
}

export function cloudEnvironmentSetupProgressLabel(
  allocation: CloudEnvironmentSetupAllocation | null,
): string {
  if (allocation === null) return "Submitting setup request...";

  switch (allocation.cleanupState.status) {
    case "requested":
    case "running":
      return "Stopping setup...";
    case "succeeded":
      return "Setup stopped.";
    case "failed":
      return `Cleanup failed: ${allocation.cleanupState.reason}`;
    case "not-requested":
      break;
    default: {
      const _exhaustive: never = allocation.cleanupState;
      return _exhaustive;
    }
  }

  if (allocation.agentOutcome.status === "failed") {
    return `Setup agent stopped: ${allocation.agentOutcome.reason}`;
  }
  if (allocation.agentOutcome.status === "cancelled") return "Setup stopped.";
  if (allocation.agentOutcome.status === "expired") return "Setup expired.";
  if (allocation.agentOutcome.status === "running") return "The setup agent is working.";
  if (allocation.agentOutcome.status === "succeeded") return "The setup agent finished.";

  switch (allocation.allocationState.status) {
    case "queued":
      return "Queued. Waiting for an available cloud worker.";
    case "launching":
      return "Starting a cloud worker...";
    case "booting":
      return "The cloud worker is booting...";
    case "registering":
      return "Connecting to the cloud worker...";
    case "ready":
      return "The setup chat is ready.";
    case "failed":
      return `Setup could not start: ${allocation.allocationState.reason}`;
    default: {
      const _exhaustive: never = allocation.allocationState;
      return _exhaustive;
    }
  }
}
