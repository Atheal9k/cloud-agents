import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, type ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { CheckIcon, CloudIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  canStopCloudEnvironmentSetup,
  cloudEnvironmentSetupAllocation,
  cloudEnvironmentSetupState,
} from "../../cloud/cloudEnvironmentSetupPresentation";
import { randomUUID } from "../../lib/utils";
import { cloudAllocations } from "../../state/cloudAllocations";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

type SetupProgress = {
  readonly title: string;
  readonly description: string;
};

function durationLabel(start: string, end: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}

function setupProgress(
  allocation: NonNullable<ReturnType<typeof cloudEnvironmentSetupAllocation>>,
): SetupProgress {
  if (
    allocation.cleanupState.status === "requested" ||
    allocation.cleanupState.status === "running"
  ) {
    return {
      title: "Stopping environment setup",
      description: "The controller is stopping the worker and releasing its resources.",
    };
  }
  if (allocation.cleanupState.status === "succeeded") {
    return {
      title: "Environment setup stopped",
      description: "The controller stopped the worker and released its resources.",
    };
  }
  if (allocation.cleanupState.status === "failed") {
    return {
      title: "Environment cleanup needs attention",
      description: allocation.cleanupState.reason,
    };
  }
  if (allocation.allocationState.status === "failed") {
    return {
      title: "Environment setup failed",
      description: allocation.allocationState.reason,
    };
  }
  if (allocation.agentOutcome.status === "failed") {
    const elapsed =
      allocation.allocationState.status === "ready"
        ? ` It stopped ${durationLabel(allocation.allocationState.readyAt, allocation.agentOutcome.completedAt)} after the worker became ready.`
        : "";
    return {
      title: "Setup agent stopped",
      description: `${allocation.agentOutcome.reason}${elapsed}`,
    };
  }
  if (allocation.agentOutcome.status === "cancelled") {
    return {
      title: "Setup agent cancelled",
      description: "The setup agent stopped before it produced a saved environment.",
    };
  }
  if (allocation.agentOutcome.status === "expired") {
    return {
      title: "Environment setup expired",
      description: "The setup agent reached its run limit before it finished.",
    };
  }
  if (allocation.agentOutcome.status === "succeeded") {
    return {
      title: "Finalizing environment setup",
      description: "The agent finished. The controller is retaining its results.",
    };
  }
  if (allocation.agentOutcome.status === "running") {
    return {
      title: "Agent is configuring the environment",
      description:
        "The worker is ready and the setup agent is inspecting and testing the repository.",
    };
  }
  switch (allocation.allocationState.status) {
    case "queued":
      return {
        title: "Setup is queued",
        description: "The controller is waiting for worker capacity.",
      };
    case "launching":
      return {
        title: "Launching the setup worker",
        description: "The controller is requesting a cloud instance.",
      };
    case "booting":
      return {
        title: "Booting the setup worker",
        description: "The cloud instance started and is booting T3 Code.",
      };
    case "registering":
      return {
        title: "Connecting the setup worker",
        description: "The worker booted and is registering with the controller.",
      };
    case "ready":
      return {
        title: "Starting the setup agent",
        description: "The worker is connected and waiting for the setup turn to start.",
      };
  }
}

function setupActivity(
  allocation: NonNullable<ReturnType<typeof cloudEnvironmentSetupAllocation>>,
): ReadonlyArray<string> {
  const activity = [`Requested ${new Date(allocation.createdAt).toLocaleTimeString()}`];
  if (allocation.allocationState.status === "ready") {
    activity.push(
      `Worker ready in ${durationLabel(allocation.createdAt, allocation.allocationState.readyAt)}`,
    );
  }
  if (
    allocation.agentOutcome.status === "succeeded" ||
    allocation.agentOutcome.status === "failed"
  ) {
    activity.push(
      `Agent finished ${new Date(allocation.agentOutcome.completedAt).toLocaleTimeString()}`,
    );
  }
  activity.push(`Controller updated ${new Date(allocation.updatedAt).toLocaleTimeString()}`);
  return activity;
}

export function CloudEnvironmentSetupCard({ threadId }: { readonly threadId: ThreadId }) {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return (
    <CloudEnvironmentSetupCardForEnvironment environmentId={environmentId} threadId={threadId} />
  );
}

function CloudEnvironmentSetupCardForEnvironment({
  environmentId,
  threadId,
}: {
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  readonly threadId: ThreadId;
}) {
  const snapshotResult = useAtomValue(cloudAllocations.snapshot({ environmentId, input: {} }));
  const snapshot = Option.getOrNull(AsyncResult.value(snapshotResult));
  const dispatch = useAtomCommand(cloudAllocations.dispatch, { reportFailure: false });
  const cancelBuild = useAtomCommand(cloudAllocations.cancelBuild, { reportFailure: false });
  const saveBuild = useAtomCommand(cloudAllocations.saveBuild, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useMemo(
    () => cloudEnvironmentSetupState(snapshot?.builds ?? [], threadId),
    [snapshot?.builds, threadId],
  );
  const allocation = useMemo(
    () => cloudEnvironmentSetupAllocation(snapshot?.allocations ?? [], threadId),
    [snapshot?.allocations, threadId],
  );
  if (state === null && allocation === null) return null;

  const canStopAllocation = allocation !== null && canStopCloudEnvironmentSetup(allocation);
  const canStopBuild = state?.kind === "building";
  const canStop = canStopAllocation || canStopBuild;
  const cleanupStatus = allocation?.cleanupState.status;
  const allocationProgress = allocation === null ? null : setupProgress(allocation);
  const activity = allocation === null ? [] : setupActivity(allocation);

  const save = async () => {
    if (state?.kind !== "ready" || saving) return;
    setSaving(true);
    const result = await saveBuild({
      environmentId,
      input: { buildId: state.build.id, occurredAt: new Date().toISOString() },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The tested setup could not be saved.");
      return;
    }
    setError(null);
  };

  const stop = async () => {
    if (!canStop || stopping) return;
    setStopping(true);
    let failure: string | null = null;
    if (canStopAllocation && allocation !== null) {
      const result = await dispatch({
        environmentId,
        input: {
          type: "allocation.cancel",
          commandId: CommandId.make(`cloud-cancel:${randomUUID()}`),
          allocationId: allocation.id,
          attempt: allocation.attempt,
          occurredAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        failure = cause instanceof Error ? cause.message : "The cloud setup could not be stopped.";
      }
    }
    if (canStopBuild && state !== null) {
      const result = await cancelBuild({
        environmentId,
        input: { buildId: state.build.id, occurredAt: new Date().toISOString() },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        failure = cause instanceof Error ? cause.message : "The environment Build could not stop.";
      }
    }
    setStopping(false);
    setError(failure);
  };

  const title =
    allocationProgress !== null &&
    (cleanupStatus !== "not-requested" ||
      allocation?.allocationState.status === "failed" ||
      (allocation?.agentOutcome.status !== "not-started" &&
        allocation?.agentOutcome.status !== "running"))
      ? allocationProgress.title
      : state?.kind === "ready"
        ? "Environment ready to save"
        : state?.kind === "saved"
          ? "Environment saved"
          : state?.kind === "failed"
            ? "Environment setup needs attention"
            : state?.kind === "building"
              ? "Building the environment"
              : state?.kind === "verifying"
                ? "Verifying the environment"
                : (allocationProgress?.title ?? "Setting up the environment");

  const description =
    allocationProgress !== null &&
    (cleanupStatus !== "not-requested" ||
      allocation?.allocationState.status === "failed" ||
      (allocation?.agentOutcome.status !== "not-started" &&
        allocation?.agentOutcome.status !== "running"))
      ? allocationProgress.description
      : state?.kind === "ready"
        ? "The setup agent finished its checks and proposed this tested Build."
        : state?.kind === "saved"
          ? "Future Cloud Agents can now use this setup."
          : state?.kind === "failed"
            ? state.message
            : state?.kind === "building"
              ? "The setup agent is installing dependencies and taking a snapshot."
              : state?.kind === "verifying"
                ? "The Build passed. The agent is finishing its fresh-agent checks."
                : (allocationProgress?.description ??
                  "You can stop this setup here even while its worker is disconnected.");

  return (
    <aside className="absolute top-4 right-4 z-30 w-[min(22rem,calc(100%-2rem))] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {state?.kind === "saved" ? (
            <CheckIcon className="size-4" />
          ) : (
            <CloudIcon className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          {activity.length === 0 ? null : (
            <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
              {activity.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          )}
          {error === null ? null : (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            {state?.kind === "ready" ? (
              <Button
                className="flex-1"
                size="sm"
                disabled={saving || stopping}
                onClick={() => void save()}
              >
                {saving ? "Saving..." : "Save setup"}
              </Button>
            ) : null}
            {canStop ? (
              <Button
                className="flex-1"
                size="sm"
                variant="destructive-outline"
                disabled={saving || stopping}
                onClick={() => void stop()}
              >
                {stopping
                  ? "Stopping..."
                  : cleanupStatus === "failed"
                    ? "Retry stop"
                    : "Stop setup"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  );
}
