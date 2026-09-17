import { useAtomValue } from "@effect/atom-react";
import { cloudWorkerConnectionRegistration } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, type CloudAllocationSnapshot, type RunAllocation } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { CloudIcon, ExternalLinkIcon, SquareIcon } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import {
  buildCloudRunLaunchCommand,
  cloudRunDisplayState,
  type CloudRunLaunchDraft,
} from "../../cloud/cloudRunLaunch";
import { onOpenCloudLaunchDialog } from "../../cloud/cloudLaunchDialogBus";
import { buildThreadRouteParams } from "../../threadRoutes";
import { randomUUID } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useServerConfigs } from "../../state/entities";
import { cloudAllocations } from "../../state/cloudAllocations";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const fieldClassName = "flex flex-col gap-1.5";
const labelClassName = "text-xs font-medium text-foreground";
const selectClassName =
  "h-8.5 rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-xs/5 outline-none focus:border-ring focus:ring-3 focus:ring-ring/24 sm:h-7.5";

function defaultModel(entry: ProviderInstanceEntry | undefined): string {
  return (
    entry?.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    entry?.models[0]?.slug ??
    ""
  );
}

function initialDraft(
  snapshot: CloudAllocationSnapshot | null,
  providers: ReadonlyArray<ProviderInstanceEntry>,
): CloudRunLaunchDraft {
  const maxRunMinutes = Math.max(1, Math.floor((snapshot?.limits.maxRunSeconds ?? 7_200) / 60));
  const maxInputWaitMinutes = Math.max(
    1,
    Math.floor((snapshot?.limits.maxInputWaitSeconds ?? 900) / 60),
  );
  const provider = providers[0];
  return {
    repository: "",
    selectedRef: "main",
    task: "",
    providerInstanceId: provider?.instanceId ?? "",
    model: defaultModel(provider),
    runtimeMode: "approval-required",
    runMinutes: String(Math.min(60, maxRunMinutes)),
    inputWaitMinutes: String(Math.min(15, maxInputWaitMinutes)),
    instanceType: snapshot?.limits.allowedInstanceTypes[0] ?? "",
    publication: "review-only",
    baseBranch: "main",
  };
}

function runtimeMode(value: string): CloudRunLaunchDraft["runtimeMode"] {
  switch (value) {
    case "approval-required":
    case "auto-accept-edits":
    case "auto":
    case "full-access":
      return value;
    default:
      return "approval-required";
  }
}

function publicationMode(value: string): CloudRunLaunchDraft["publication"] {
  return value === "automatic-draft-pr" ? "automatic-draft-pr" : "review-only";
}

const DISPLAY_LABELS = {
  provisioning: "Provisioning",
  setup: "Setting up",
  waiting: "Waiting to start",
  running: "Running",
  finalizing: "Finalizing",
  failed: "Failed",
  cleanup: "Cleaning up",
  complete: "Complete",
} as const;

function failureMessage(allocation: RunAllocation): string | null {
  if (allocation.cleanupState.status === "failed") return allocation.cleanupState.reason;
  if (allocation.allocationState.status === "failed") return allocation.allocationState.reason;
  return allocation.agentOutcome.status === "failed" ? allocation.agentOutcome.reason : null;
}

function cleanupLabel(allocation: RunAllocation): string | null {
  if (failureMessage(allocation) === null) return null;
  switch (allocation.cleanupState.status) {
    case "requested":
    case "running":
      return "Cleaning up";
    case "succeeded":
      return "Cleaned up";
    case "not-requested":
    case "failed":
      return null;
  }
}

function elapsedMinutes(
  snapshot: CloudAllocationSnapshot,
  allocation: RunAllocation,
): number | null {
  const usage = snapshot.usage.find((candidate) => candidate.allocationId === allocation.id);
  return usage === undefined ? null : Math.ceil(usage.elapsedWorkerSeconds / 60);
}

function estimatedWorkerCost(
  snapshot: CloudAllocationSnapshot,
  allocation: RunAllocation,
): string | null {
  const usage = snapshot.usage.find((candidate) => candidate.allocationId === allocation.id);
  const worker = usage?.costs.workerCompute;
  return worker?.status === "estimated" ? `$${worker.usd.toFixed(2)} est.` : null;
}

function CloudRunRow(props: {
  readonly allocation: RunAllocation;
  readonly snapshot: CloudAllocationSnapshot;
  readonly busy: boolean;
  readonly onCancel: (allocation: RunAllocation) => void;
  readonly onOpen: (allocation: RunAllocation) => void;
}) {
  const displayState = cloudRunDisplayState(props.allocation);
  const error = failureMessage(props.allocation);
  const cleanup = cleanupLabel(props.allocation);
  const minutes = elapsedMinutes(props.snapshot, props.allocation);
  const cost = estimatedWorkerCost(props.snapshot, props.allocation);
  const canCancel =
    props.allocation.cleanupState.status === "not-requested" && displayState !== "complete";
  const canOpen =
    props.allocation.allocationState.status === "ready" &&
    props.allocation.allocationState.route !== undefined &&
    props.allocation.cleanupState.status === "not-requested";

  return (
    <div className="rounded-xl border bg-muted/24 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {props.allocation.execution?.title ?? props.allocation.target.repository}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span>{DISPLAY_LABELS[displayState]}</span>
            {cleanup === null ? null : <span>{cleanup}</span>}
            <span>{props.allocation.profile.instanceType ?? props.allocation.profile.id}</span>
            {minutes === null ? null : <span>{minutes} min</span>}
            {cost === null ? null : <span>{cost}</span>}
          </div>
          {error === null ? null : <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex shrink-0 gap-1.5">
          {canOpen ? (
            <Button size="sm" variant="outline" onClick={() => props.onOpen(props.allocation)}>
              <ExternalLinkIcon className="size-3.5" />
              Open
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              size="sm"
              variant="outline"
              disabled={props.busy}
              onClick={() => props.onCancel(props.allocation)}
            >
              <SquareIcon className="size-3" />
              Stop
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function CloudRunDialog() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const supportsCloud =
    primaryEnvironmentId !== null &&
    serverConfigs.get(primaryEnvironmentId)?.environment.capabilities.cloudAllocations === true;

  if (primaryEnvironmentId === null || !supportsCloud) return null;
  return <CloudRunDialogForEnvironment environmentId={primaryEnvironmentId} />;
}

function CloudRunDialogForEnvironment(props: {
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
}) {
  const navigate = useNavigate();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const providers = useMemo(
    () =>
      deriveProviderInstanceEntries(serverProviders).filter(
        (provider) => isProviderInstancePickerReady(provider) && provider.models.length > 0,
      ),
    [serverProviders],
  );
  const snapshotResult = useAtomValue(
    cloudAllocations.snapshot({ environmentId: props.environmentId, input: {} }),
  );
  const snapshot = Option.getOrNull(AsyncResult.value(snapshotResult));
  const dispatch = useAtomCommand(cloudAllocations.dispatch, { reportFailure: false });
  const registerEnvironment = useAtomCommand(environmentCatalog.register, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => initialDraft(snapshot, providers));
  const [requestId, setRequestId] = useState(randomUUID);
  const [launchedId, setLaunchedId] = useState<string | null>(null);
  const [busyAllocationId, setBusyAllocationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      onOpenCloudLaunchDialog(() => {
        setDraft(initialDraft(snapshot, providers));
        setRequestId(randomUUID());
        setLaunchedId(null);
        setError(null);
        setOpen(true);
      }),
    [providers, snapshot],
  );

  const selectedProvider = providers.find(
    (provider) => provider.instanceId === draft.providerInstanceId,
  );

  const recentAllocations = useMemo(
    () =>
      [...(snapshot?.allocations ?? [])]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 5),
    [snapshot],
  );

  const launch = async (event: FormEvent) => {
    event.preventDefault();
    if (snapshot === null || launchedId !== null) return;
    const built = buildCloudRunLaunchCommand({
      draft,
      limits: snapshot.limits,
      now: new Date(),
      requestId,
    });
    if (built.status === "invalid") {
      setError(built.message);
      return;
    }
    setError(null);
    setBusyAllocationId(requestId);
    const result = await dispatch({ environmentId: props.environmentId, input: built.command });
    setBusyAllocationId(null);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The controller rejected the cloud run.");
      return;
    }
    setLaunchedId(requestId);
  };

  const cancel = async (allocation: RunAllocation) => {
    setBusyAllocationId(allocation.id);
    const result = await dispatch({
      environmentId: props.environmentId,
      input: {
        type: "allocation.cancel",
        commandId: CommandId.make(`cloud-cancel:${randomUUID()}`),
        allocationId: allocation.id,
        attempt: allocation.attempt,
        occurredAt: new Date().toISOString(),
      },
    });
    setBusyAllocationId(null);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The controller could not stop the run.");
    }
  };

  const openRun = async (allocation: RunAllocation) => {
    const registration = cloudWorkerConnectionRegistration(allocation);
    if (registration === null || allocation.allocationState.status !== "ready") return;
    setBusyAllocationId(allocation.id);
    const result = await registerEnvironment(registration);
    setBusyAllocationId(null);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error ? cause.message : "The worker connection could not be saved.",
      );
      return;
    }
    setOpen(false);
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: allocation.allocationState.references.environmentId,
        threadId: allocation.allocationState.references.threadId,
      }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-h-[calc(100dvh-2rem)] w-[min(720px,calc(100vw-2rem))] max-w-3xl overflow-y-auto">
        <form onSubmit={(event) => void launch(event)}>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <CloudIcon className="size-5" />
              <DialogTitle>New cloud thread</DialogTitle>
            </div>
            <DialogDescription>
              The local T3 controller stays responsible for this worker after the browser or desktop
              app disconnects.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            {snapshot === null ? (
              <div className="rounded-lg border bg-muted/24 p-3 text-sm text-muted-foreground">
                Connecting to the cloud controller...
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Destination</span>
                    <Input value="Cloud worker" disabled />
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Repository</span>
                    <Input
                      value={draft.repository}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, repository: event.target.value }))
                      }
                    />
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Start ref</span>
                    <Input
                      value={draft.selectedRef}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, selectedRef: event.target.value }))
                      }
                    />
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Model</span>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        aria-label="Provider instance"
                        className={selectClassName}
                        value={draft.providerInstanceId}
                        onChange={(event) => {
                          const provider = providers.find(
                            (candidate) => candidate.instanceId === event.target.value,
                          );
                          setDraft((current) => ({
                            ...current,
                            providerInstanceId: event.target.value,
                            model: defaultModel(provider),
                          }));
                        }}
                      >
                        {providers.map((provider) => (
                          <option key={provider.instanceId} value={provider.instanceId}>
                            {provider.displayName}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="Model"
                        className={selectClassName}
                        value={draft.model}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, model: event.target.value }))
                        }
                      >
                        {(selectedProvider?.models ?? []).map((model) => (
                          <option key={model.slug} value={model.slug}>
                            {model.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    {providers.length === 0 ? (
                      <span className="text-xs text-destructive">
                        No ready provider has a supported model.
                      </span>
                    ) : null}
                  </label>
                </div>
                <label className={fieldClassName}>
                  <span className={labelClassName}>Task</span>
                  <Textarea
                    autoFocus
                    value={draft.task}
                    placeholder="Describe the change to make and how to verify it."
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, task: event.target.value }))
                    }
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Permissions</span>
                    <select
                      className={selectClassName}
                      value={draft.runtimeMode}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          runtimeMode: runtimeMode(event.target.value),
                        }))
                      }
                    >
                      <option value="approval-required">Ask for approval</option>
                      <option value="auto-accept-edits">Auto-accept edits</option>
                      <option value="full-access">Full access</option>
                    </select>
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Worker</span>
                    <select
                      className={selectClassName}
                      value={draft.instanceType}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, instanceType: event.target.value }))
                      }
                    >
                      {snapshot.limits.allowedInstanceTypes.map((instanceType) => (
                        <option key={instanceType} value={instanceType}>
                          {instanceType}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Run limit, min</span>
                    <Input
                      type="number"
                      min={1}
                      max={Math.floor(snapshot.limits.maxRunSeconds / 60)}
                      value={draft.runMinutes}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, runMinutes: event.target.value }))
                      }
                    />
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Input wait, min</span>
                    <Input
                      type="number"
                      min={1}
                      max={Math.floor(snapshot.limits.maxInputWaitSeconds / 60)}
                      value={draft.inputWaitMinutes}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          inputWaitMinutes: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Publication</span>
                    <select
                      className={selectClassName}
                      value={draft.publication}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          publication: publicationMode(event.target.value),
                        }))
                      }
                    >
                      <option value="review-only">Review only</option>
                      <option value="automatic-draft-pr">Open draft PR</option>
                    </select>
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>PR base branch</span>
                    <Input
                      disabled={draft.publication === "review-only"}
                      value={draft.baseBranch}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, baseBranch: event.target.value }))
                      }
                    />
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  One worker at a time. The controller allows {snapshot.limits.maxQueueDepth} queued{" "}
                  {snapshot.limits.maxQueueDepth === 1 ? "run" : "runs"} and estimates cost from
                  configured instance prices.
                </p>
              </>
            )}

            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            {snapshot !== null && recentAllocations.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">Recent cloud runs</h3>
                {recentAllocations.map((allocation) => (
                  <CloudRunRow
                    key={allocation.id}
                    allocation={allocation}
                    snapshot={snapshot}
                    busy={busyAllocationId === allocation.id}
                    onCancel={(candidate) => void cancel(candidate)}
                    onOpen={(candidate) => void openRun(candidate)}
                  />
                ))}
              </section>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              type="submit"
              disabled={
                snapshot === null ||
                providers.length === 0 ||
                busyAllocationId !== null ||
                launchedId !== null
              }
            >
              {busyAllocationId === requestId
                ? "Launching..."
                : launchedId === requestId
                  ? "Launch requested"
                  : "Launch cloud thread"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
