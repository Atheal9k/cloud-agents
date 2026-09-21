import { useAtomValue } from "@effect/atom-react";
import { cloudWorkerConnectionRegistration } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CLOUD_ENV_SETUP_USER_REQUEST,
  CommandId,
  type CloudAllocationSnapshot,
  cloudEnvironmentBase,
  type CloudEnvironment,
  type CloudEnvironmentBase,
  type CloudEnvironmentBuild,
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudAgentId,
  CLOUD_SCRATCH_WORKSPACE_REPOSITORY,
  type CloudEnvironmentVersion,
  isAppleSiliconMacInstanceType,
  isAndroidAcceleratedInstanceType,
  isCloudProviderEnabled,
  type RunAllocation,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import {
  CheckIcon,
  CloudIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  SearchIcon,
  SquareIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import {
  buildCloudRunLaunchCommand,
  cloudEnvSetupLaunchDraft,
  cloudRunDisplayState,
  cloudRunProgressPresentation,
  cloudRunProjectOptions,
  controllerSummary,
  createInitialCloudRunDraft,
  reconcileCloudRunLaunchInstanceType,
  type CloudRunLaunchDraft,
} from "../../cloud/cloudRunLaunch";
import { onOpenCloudLaunchDialog } from "../../cloud/cloudLaunchDialogBus";
import {
  canStopCloudEnvironmentSetup,
  cloudEnvironmentSetupProgressLabel,
  latestPendingCloudEnvironmentSetupAllocation,
} from "../../cloud/cloudEnvironmentSetupPresentation";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn, randomUUID } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useServerConfigs } from "../../state/entities";
import { cloudAllocations } from "../../state/cloudAllocations";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
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

type EnvironmentSetupStep = "repositories" | "details" | "progress";

function repositoryName(repository: string): string {
  return repository.match(/[^/]+$/u)?.[0] ?? repository;
}

const DISPLAY_LABELS = {
  provisioning: "Provisioning",
  setup: "Setting up",
  waiting: "Waiting to start",
  running: "Running",
  finalizing: "Finalizing",
  failed: "Failed",
  cleanup: "Cleaning up",
  idle: "Idle",
  hibernated: "Hibernated",
  waking: "Waking",
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

function snapshotObservedAt(snapshot: CloudAllocationSnapshot, allocation: RunAllocation): number {
  const usage = snapshot.usage.find((candidate) => candidate.allocationId === allocation.id);
  return Date.parse(usage?.calculatedAt ?? allocation.updatedAt);
}

function CloudRunRow(props: {
  readonly allocation: RunAllocation;
  readonly snapshot: CloudAllocationSnapshot;
  readonly busy: boolean;
  readonly onCancel: (allocation: RunAllocation) => void;
  readonly onOpen: (allocation: RunAllocation) => void;
  readonly onReview: (allocation: RunAllocation) => void;
}) {
  const displayState = cloudRunDisplayState(props.allocation);
  const error = failureMessage(props.allocation);
  const cleanup = cleanupLabel(props.allocation);
  const minutes = elapsedMinutes(props.snapshot, props.allocation);
  const cost = estimatedWorkerCost(props.snapshot, props.allocation);
  const progress = cloudRunProgressPresentation(
    props.allocation,
    snapshotObservedAt(props.snapshot, props.allocation),
  );
  const canCancel =
    (props.allocation.cleanupState.status === "not-requested" ||
      props.allocation.cleanupState.status === "failed") &&
    displayState !== "complete";
  const canOpen =
    props.allocation.allocationState.status === "ready" &&
    props.allocation.allocationState.route !== undefined &&
    props.allocation.idleState.status !== "hibernated" &&
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
          {progress === null ? null : (
            <div className="mt-2 flex items-baseline gap-2 text-xs">
              <span className="font-medium text-foreground">{progress.label}</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {progress.elapsed}
              </span>
            </div>
          )}
          {progress === null ? null : (
            <p className="mt-0.5 text-xs text-muted-foreground">{progress.detail}</p>
          )}
          {error === null ? null : <p className="mt-2 text-xs text-destructive">{error}</p>}
          {displayState === "hibernated" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              The worker was released while this agent was idle. A follow-up restores it from its
              snapshot.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="outline" onClick={() => props.onReview(props.allocation)}>
            Review
          </Button>
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
              {props.allocation.cleanupState.status === "failed" ? "Retry cleanup" : "Stop"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function cloudEnvironmentSourceLabel(source: CloudEnvironmentVersion["source"]): string {
  if (source.type === "repository") {
    return `${source.path} at ${source.commit.slice(0, 8)}`;
  }
  if (source.scope === "default") return "Default";
  return `${source.scope === "personal" ? "Personal" : "Team"} · ${source.owner}`;
}

function cloudEnvironmentBaseLabel(base: CloudEnvironmentBase): string {
  switch (base.kind) {
    case "image":
      return `Image ${base.image}`;
    case "snapshot":
      return `Snapshot ${base.snapshot}`;
    case "dockerfile":
      return "Dockerfile";
  }
}

const CLOUD_BUILD_TRIGGER_LABELS: Record<CloudEnvironmentBuild["trigger"], string> = {
  manual: "Manual",
  recurring: "Recurring",
  "configuration-change": "Config change",
  "agent-requested": "Agent",
};

function cloudBuildStatusLabel(build: CloudEnvironmentBuild): string {
  switch (build.outcome.status) {
    case "running":
      return "Running";
    case "succeeded":
      return build.draft ? "Draft ready" : "Succeeded";
    case "failed":
      return `Failed at ${build.outcome.stage}`;
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped, inputs unchanged";
  }
}

function CloudEnvironmentBuildRow(props: {
  readonly build: CloudEnvironmentBuild;
  readonly busy: boolean;
  readonly onSave: (build: CloudEnvironmentBuild) => void;
  readonly onCancel: (build: CloudEnvironmentBuild) => void;
}) {
  const build = props.build;
  const canSave = build.draft && build.outcome.status === "succeeded";
  const canCancel = build.outcome.status === "running";
  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate">
        v{build.version} · {CLOUD_BUILD_TRIGGER_LABELS[build.trigger]} ·{" "}
        {cloudBuildStatusLabel(build)}
        {build.outcome.status === "succeeded"
          ? ` · ${Math.round(build.outcome.snapshot.sizeBytes / 1_000_000)} MB`
          : ""}
      </span>
      {canSave ? (
        <Button
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onSave(build)}
        >
          Save
        </Button>
      ) : canCancel ? (
        <Button
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onCancel(build)}
        >
          Cancel
        </Button>
      ) : null}
    </li>
  );
}

function CloudEnvironmentCard(props: {
  readonly environment: CloudEnvironment;
  readonly builds: ReadonlyArray<CloudEnvironmentBuild>;
  readonly busy: boolean;
  readonly onRestore: (environment: CloudEnvironment, version: number) => void;
  readonly onBuild: (environment: CloudEnvironment) => void;
  readonly onSaveBuild: (build: CloudEnvironmentBuild) => void;
  readonly onCancelBuild: (build: CloudEnvironmentBuild) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [buildsOpen, setBuildsOpen] = useState(false);
  const current = props.environment.current;
  const history = props.environment.history;
  const activeBuild = props.builds.find((build) => build.id === props.environment.activeBuildId);

  return (
    <div className="rounded-xl border bg-muted/24 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{current.name}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {cloudEnvironmentSourceLabel(current.source)}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          v{current.version} · {history.length} version{history.length === 1 ? "" : "s"}
        </Button>
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex gap-1">
          <dt className="text-muted-foreground">Repositories</dt>
          <dd className="truncate">
            {current.repositories.map((entry) => entry.repository).join(", ")}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-muted-foreground">Active Build</dt>
          <dd className="truncate">
            {activeBuild === undefined
              ? "None"
              : `v${activeBuild.version} · ${CLOUD_BUILD_TRIGGER_LABELS[activeBuild.trigger]}`}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-muted-foreground">Base</dt>
          <dd className="truncate">
            {cloudEnvironmentBaseLabel(cloudEnvironmentBase(current.config))}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-muted-foreground">Runtime policy</dt>
          <dd>
            {current.effectivePolicy.runtimeUser} · {current.effectivePolicy.egressMode}
            {current.effectivePolicy.networkProfile === undefined
              ? ""
              : ` · ${current.effectivePolicy.networkProfile.enabled ? current.effectivePolicy.networkProfile.kind : "public overlay off"}`}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onBuild(props.environment)}
        >
          Build now
        </Button>
        {props.builds.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={buildsOpen}
            onClick={() => setBuildsOpen((open) => !open)}
          >
            {props.builds.length} Build{props.builds.length === 1 ? "" : "s"}
          </Button>
        ) : null}
      </div>
      {buildsOpen ? (
        <ul className="mt-2 space-y-1 border-t pt-2">
          {props.builds.map((build) => (
            <CloudEnvironmentBuildRow
              key={build.id}
              build={build}
              busy={props.busy}
              onSave={props.onSaveBuild}
              onCancel={props.onCancelBuild}
            />
          ))}
        </ul>
      ) : null}
      {historyOpen ? (
        <ul className="mt-3 space-y-1 border-t pt-2">
          {history.map((version) => (
            <li key={version.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate">
                v{version.version} · {cloudEnvironmentBaseLabel(version.base)}
                {version.restoredFromVersion === undefined
                  ? ""
                  : ` · restored from v${version.restoredFromVersion}`}
              </span>
              {version.version === current.version ? (
                <span className="shrink-0 text-muted-foreground">Current</span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={props.busy}
                  onClick={() => props.onRestore(props.environment, version.version)}
                >
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
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
  const projects = useProjects();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const providers = useMemo(
    () =>
      deriveProviderInstanceEntries(serverProviders).filter(
        (provider) =>
          isCloudProviderEnabled(provider.driverKind) &&
          provider.isDefault &&
          isProviderInstancePickerReady(provider) &&
          provider.models.length > 0,
      ),
    [serverProviders],
  );
  const snapshotResult = useAtomValue(
    cloudAllocations.snapshot({ environmentId: props.environmentId, input: {} }),
  );
  const snapshot = Option.getOrNull(AsyncResult.value(snapshotResult));
  const writability = snapshot?.controller.writability;
  const fence = writability?.status === "fenced" ? writability : null;
  const projectOptions = useMemo(() => cloudRunProjectOptions(projects), [projects]);
  const dispatch = useAtomCommand(cloudAllocations.dispatch, { reportFailure: false });
  const setAdmission = useAtomCommand(cloudAllocations.setAdmission, { reportFailure: false });
  const registerEnvironment = useAtomCommand(environmentCatalog.register, { reportFailure: false });
  const restoreEnvironment = useAtomCommand(cloudAllocations.restoreEnvironment, {
    reportFailure: false,
  });
  const startBuild = useAtomCommand(cloudAllocations.startBuild, { reportFailure: false });
  const saveBuild = useAtomCommand(cloudAllocations.saveBuild, { reportFailure: false });
  const saveEnvironment = useAtomCommand(cloudAllocations.saveEnvironment, {
    reportFailure: false,
  });
  const cancelBuild = useAtomCommand(cloudAllocations.cancelBuild, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() =>
    createInitialCloudRunDraft(snapshot, providers, projectOptions[0]?.repository),
  );
  const [requestId, setRequestId] = useState(randomUUID);
  const [launchedId, setLaunchedId] = useState<string | null>(null);
  const [busyAllocationId, setBusyAllocationId] = useState<string | null>(null);
  const [busyEnvironmentId, setBusyEnvironmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupMode, setSetupMode] = useState(false);
  const [setupStep, setSetupStep] = useState<EnvironmentSetupStep>("repositories");
  const [setupSearch, setSetupSearch] = useState("");
  const [setupName, setSetupName] = useState("");
  const [setupScope, setSetupScope] = useState<"personal" | "team">("personal");
  const [savingSkippedSetup, setSavingSkippedSetup] = useState(false);
  const [resumingAdmission, setResumingAdmission] = useState(false);

  useEffect(() => {
    if (snapshot === null) return;
    setDraft((current) => reconcileCloudRunLaunchInstanceType(current, snapshot.limits));
  }, [snapshot]);

  useEffect(
    () =>
      onOpenCloudLaunchDialog((intent) => {
        const existingSetup =
          intent.kind === "env-setup"
            ? latestPendingCloudEnvironmentSetupAllocation(
                snapshot?.allocations ?? [],
                intent.repository,
              )
            : null;
        const next = createInitialCloudRunDraft(
          snapshot,
          providers,
          existingSetup?.target.repository ??
            (intent.kind === "env-setup" && intent.repository !== undefined
              ? intent.repository
              : projectOptions[0]?.repository),
        );
        setDraft(intent.kind === "env-setup" ? cloudEnvSetupLaunchDraft(next) : next);
        setSetupMode(intent.kind === "env-setup");
        setSetupStep(existingSetup === null ? "repositories" : "progress");
        setSetupSearch("");
        setSetupName(
          existingSetup?.execution?.environmentSetup?.name ??
            (intent.kind === "env-setup" && next.repository.length > 0
              ? repositoryName(next.repository)
              : ""),
        );
        setSetupScope(existingSetup?.execution?.environmentSetup?.scope ?? "personal");
        setSavingSkippedSetup(false);
        setResumingAdmission(false);
        setRequestId(existingSetup?.id ?? randomUUID());
        setLaunchedId(existingSetup?.id ?? null);
        setError(null);
        setOpen(true);
      }),
    [projectOptions, providers, snapshot],
  );

  const selectedProvider = providers.find(
    (provider) => provider.instanceId === draft.providerInstanceId,
  );
  const admissionStopped = snapshot?.controller.admission.status === "stopped";
  const modelOptionsByInstance = useMemo(
    () => new Map(providers.map((provider) => [provider.instanceId, provider.models])),
    [providers],
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
    if (snapshot.controller.admission.status === "stopped") {
      setError("New cloud runs are paused. Resume admission before starting setup.");
      return;
    }
    if (snapshot.controller.writability?.status === "fenced") {
      setError(`This cloud controller is fenced: ${snapshot.controller.writability.reason}`);
      return;
    }
    const requestedDraft = setupMode
      ? {
          ...draft,
          task: `Set up ${setupName.trim()} cloud environment.\n\n${CLOUD_ENV_SETUP_USER_REQUEST}\nScope: ${setupScope}.`,
        }
      : draft;
    const launchDraft = reconcileCloudRunLaunchInstanceType(requestedDraft, snapshot.limits);
    if (launchDraft !== draft) setDraft(launchDraft);
    const built = buildCloudRunLaunchCommand({
      draft: launchDraft,
      limits: snapshot.limits,
      now: new Date(),
      requestId,
      ...(setupMode
        ? {
            environmentSetup: {
              name: setupName.trim(),
              scope: setupScope,
            },
          }
        : {}),
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
    if (setupMode) setSetupStep("progress");
  };

  const setupRepositories = [draft.repository, ...draft.additionalRepositories].filter(
    (repository) => repository.length > 0,
  );
  const filteredSetupProjects = projectOptions.filter((project) => {
    const query = setupSearch.trim().toLowerCase();
    return (
      query.length === 0 ||
      project.title.toLowerCase().includes(query) ||
      project.repository.toLowerCase().includes(query)
    );
  });
  const setSetupRepositories = (repositories: ReadonlyArray<string>) => {
    setDraft((current) => ({
      ...current,
      repository: repositories[0] ?? "",
      additionalRepositories: repositories.slice(1),
    }));
    if (setupName.length === 0 && repositories[0] !== undefined) {
      setSetupName(repositoryName(repositories[0]));
    }
  };
  const toggleSetupRepository = (repository: string) => {
    const selected = setupRepositories.includes(repository)
      ? setupRepositories.filter((candidate) => candidate !== repository)
      : [...setupRepositories, repository];
    setSetupRepositories(selected);
  };

  const skipAndSaveSetup = async () => {
    if (setupRepositories.length === 0 || setupName.trim().length === 0) return;
    setSavingSkippedSetup(true);
    const result = await saveEnvironment({
      environmentId: props.environmentId,
      input: {
        environmentId: CloudEnvironmentId.make(`environment:${randomUUID()}`),
        name: setupName.trim(),
        source: {
          type: "saved",
          scope: setupScope,
          owner: setupScope === "team" ? "team" : "local-operator",
        },
        repositories: setupRepositories.map((repository) => ({
          repository,
          defaultRef: draft.selectedRef.trim() || "main",
        })),
        config: { image: "ubuntu:24.04" },
        secretReferences: [],
        occurredAt: new Date().toISOString(),
      },
    });
    setSavingSkippedSetup(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The environment could not be saved.");
      return;
    }
    setError(null);
    setOpen(false);
  };

  const resumeAdmission = async () => {
    setResumingAdmission(true);
    const result = await setAdmission({
      environmentId: props.environmentId,
      input: { admissionOpen: true, occurredAt: new Date().toISOString() },
    });
    setResumingAdmission(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Cloud admission could not be resumed.");
      return;
    }
    setError(null);
  };

  const restore = async (environment: CloudEnvironment, restoreVersion: number) => {
    setBusyEnvironmentId(environment.id);
    const result = await restoreEnvironment({
      environmentId: props.environmentId,
      input: {
        environmentId: environment.id,
        expectedVersion: environment.current.version,
        restoreVersion,
        occurredAt: new Date().toISOString(),
      },
    });
    setBusyEnvironmentId(null);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error ? cause.message : "The controller could not restore that version.",
      );
      return;
    }
    setError(null);
  };

  /** Every Build mutation reports through the same environment-scoped busy flag. */
  const runBuildCommand = async (
    environmentId: string,
    command: () => Promise<{ readonly _tag: string }>,
    failureMessage: string,
  ) => {
    setBusyEnvironmentId(environmentId);
    const result = await command();
    setBusyEnvironmentId(null);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result as never);
      setError(cause instanceof Error ? cause.message : failureMessage);
      return;
    }
    setError(null);
  };

  const build = (environment: CloudEnvironment) =>
    runBuildCommand(
      environment.id,
      () =>
        startBuild({
          environmentId: props.environmentId,
          input: {
            buildId: CloudEnvironmentBuildId.make(`build:${randomUUID()}`),
            environmentId: environment.id,
            trigger: "manual",
            occurredAt: new Date().toISOString(),
          },
        }),
      "The controller could not start that Build.",
    );

  const acceptBuild = (target: CloudEnvironmentBuild) =>
    runBuildCommand(
      target.environmentId,
      () =>
        saveBuild({
          environmentId: props.environmentId,
          input: { buildId: target.id, occurredAt: new Date().toISOString() },
        }),
      "The controller could not save that Build.",
    );

  const stopBuild = (target: CloudEnvironmentBuild) =>
    runBuildCommand(
      target.environmentId,
      () =>
        cancelBuild({
          environmentId: props.environmentId,
          input: { buildId: target.id, occurredAt: new Date().toISOString() },
        }),
      "The controller could not cancel that Build.",
    );

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

  const openReview = (allocation: RunAllocation) => {
    const agentId = allocation.control?.agentId ?? CloudAgentId.make(`agent:${allocation.id}`);
    setOpen(false);
    void navigate({
      to: "/cloud-agents/$agentId",
      params: { agentId },
    });
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

  if (setupMode) {
    const setupAllocation = snapshot?.allocations.find((allocation) => allocation.id === requestId);
    const canOpenSetup =
      setupAllocation?.allocationState.status === "ready" &&
      setupAllocation.allocationState.route !== undefined;
    const canStopSetup =
      setupAllocation !== undefined && canStopCloudEnvironmentSetup(setupAllocation);
    const setupProgressLabel = cloudEnvironmentSetupProgressLabel(setupAllocation ?? null);

    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="w-[min(520px,calc(100vw-2rem))] overflow-hidden">
          <form
            className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col max-sm:max-h-[calc(100dvh-3rem)]"
            onSubmit={(event) => void launch(event)}
          >
            <DialogHeader>
              <DialogTitle>Create a new environment</DialogTitle>
              <DialogDescription>
                {setupStep === "repositories"
                  ? "Select one or more repositories."
                  : setupStep === "details"
                    ? "Name the environment and choose who can use it."
                    : `Setting up ${setupName || "your environment"}.`}
              </DialogDescription>
            </DialogHeader>

            <DialogPanel className="space-y-4" scrollAreaClassName="min-h-0 flex-1">
              {setupStep === "repositories" ? (
                <div className="overflow-hidden rounded-xl border border-border">
                  <label className="flex items-center gap-2 border-b border-border px-3">
                    <SearchIcon className="size-4 text-muted-foreground" />
                    <Input
                      autoFocus
                      className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                      value={setupSearch}
                      placeholder="Search repositories"
                      onChange={(event) => setSetupSearch(event.currentTarget.value)}
                    />
                  </label>
                  <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
                    <span>Repositories</span>
                    <span>Select multiple</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto px-1 pb-1">
                    {filteredSetupProjects.length === 0 ? (
                      <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                        No linked repositories match this search.
                      </p>
                    ) : (
                      filteredSetupProjects.map((project) => {
                        const selected = setupRepositories.includes(project.repository);
                        return (
                          <button
                            key={project.repository}
                            type="button"
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent"
                            aria-pressed={selected}
                            onClick={() => toggleSetupRepository(project.repository)}
                          >
                            <FolderGit2Icon className="size-4 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">{project.repository}</span>
                            <span
                              className={cn(
                                "flex size-4 items-center justify-center rounded-full border",
                                selected
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-input",
                              )}
                            >
                              {selected ? <CheckIcon className="size-3" /> : null}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : setupStep === "details" ? (
                <>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Name</span>
                    <Input
                      autoFocus
                      value={setupName}
                      onChange={(event) => setSetupName(event.currentTarget.value)}
                    />
                  </label>
                  <div className={fieldClassName}>
                    <div className="flex items-center justify-between">
                      <span className={labelClassName}>
                        {setupRepositories.length === 1 ? "Repository" : "Repositories"}
                      </span>
                      <Button
                        type="button"
                        size="micro"
                        variant="ghost"
                        onClick={() => setSetupStep("repositories")}
                      >
                        Edit
                      </Button>
                    </div>
                    <div className="space-y-1 rounded-lg border border-border p-2">
                      {setupRepositories.map((repository) => (
                        <div key={repository} className="flex items-center gap-2 text-sm">
                          <FolderGit2Icon className="size-4 text-muted-foreground" />
                          <span className="truncate">{repository}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Scope</span>
                    <select
                      className={selectClassName}
                      value={setupScope}
                      onChange={(event) =>
                        setSetupScope(event.currentTarget.value === "team" ? "team" : "personal")
                      }
                    >
                      <option value="personal">Personal</option>
                      <option value="team">Team</option>
                    </select>
                  </label>
                  <p className="text-sm text-muted-foreground">
                    An agent will explore the codebase, generate install scripts, and verify the
                    application. Setup usually takes 5-20 minutes. Interrupt anytime to steer the
                    agent or finish setup manually in its terminal.
                  </p>
                  {admissionStopped ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/32 bg-warning-surface p-3">
                      <p className="text-sm text-warning-foreground">
                        New cloud runs are paused. Resume admission before starting setup.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="warning-outline"
                        disabled={resumingAdmission}
                        onClick={() => void resumeAdmission()}
                      >
                        {resumingAdmission ? "Resuming..." : "Resume admission"}
                      </Button>
                    </div>
                  ) : fence !== null ? (
                    <p className="rounded-lg border border-destructive/24 bg-destructive/8 p-3 text-sm text-destructive">
                      This cloud controller is fenced: {fence.reason}
                    </p>
                  ) : providers.length === 0 ? (
                    <p className="rounded-lg border border-warning/32 bg-warning-surface p-3 text-sm text-warning-foreground">
                      Configure a default cloud-capable provider and model before starting setup.
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-xl border border-border bg-muted/24 p-4">
                    <div className="flex items-center gap-2">
                      <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <CloudIcon className="size-5" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold">Set up a cloud environment</h3>
                        <p className="text-xs text-muted-foreground">Agent-led setup</p>
                      </div>
                    </div>
                    <p className="mt-3 text-sm text-muted-foreground">
                      The agent can run, test, verify, and demo changes like an engineer.
                    </p>
                    <ol className="mt-3 space-y-2 text-sm">
                      <li className="flex gap-3">
                        <span className="text-muted-foreground">1</span>
                        <span>Explore, install, and verify the application</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="text-muted-foreground">2</span>
                        <span>Ask for secrets or network access as needed</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="text-muted-foreground">3</span>
                        <span>Prompt you to review and save the configuration</span>
                      </li>
                    </ol>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                    <span className="text-muted-foreground">{setupProgressLabel}</span>
                    {canOpenSetup && setupAllocation !== undefined ? (
                      <Button type="button" size="sm" onClick={() => void openRun(setupAllocation)}>
                        Open setup
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}

              {error === null ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </DialogPanel>

            {setupStep === "repositories" ? (
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={setupRepositories.length === 0}
                  onClick={() => {
                    setError(null);
                    setSetupStep("details");
                  }}
                >
                  Continue
                </Button>
              </DialogFooter>
            ) : setupStep === "details" ? (
              <DialogFooter className="sm:justify-between">
                <Button
                  type="button"
                  variant="outline"
                  disabled={savingSkippedSetup || setupName.trim().length === 0}
                  onClick={() => void skipAndSaveSetup()}
                >
                  {savingSkippedSetup ? "Saving..." : "Skip and save"}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    snapshot === null ||
                    admissionStopped ||
                    fence !== null ||
                    setupName.trim().length === 0 ||
                    providers.length === 0 ||
                    resumingAdmission ||
                    busyAllocationId !== null
                  }
                >
                  {busyAllocationId === requestId ? "Starting..." : "Set up with agent"}
                </Button>
              </DialogFooter>
            ) : (
              <DialogFooter className="sm:justify-between">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Close
                </Button>
                {canStopSetup && setupAllocation !== undefined ? (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busyAllocationId === setupAllocation.id}
                    onClick={() => void cancel(setupAllocation)}
                  >
                    {busyAllocationId === setupAllocation.id
                      ? "Stopping..."
                      : setupAllocation.cleanupState.status === "failed"
                        ? "Retry stop"
                        : "Stop setup"}
                  </Button>
                ) : null}
              </DialogFooter>
            )}
          </form>
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="w-[min(720px,calc(100vw-2rem))] max-w-3xl overflow-hidden">
        <form
          className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col max-sm:max-h-[calc(100dvh-3rem)]"
          onSubmit={(event) => void launch(event)}
        >
          <DialogHeader>
            <div className="flex items-center gap-2">
              <CloudIcon className="size-5" />
              <DialogTitle>
                {draft.task === CLOUD_ENV_SETUP_USER_REQUEST
                  ? "Set up cloud environment"
                  : "New cloud thread"}
              </DialogTitle>
            </div>
            <DialogDescription>{controllerSummary(snapshot)}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5" scrollAreaClassName="flex-1">
            {fence === null ? null : (
              <p
                role="alert"
                className="rounded-lg border bg-muted/24 p-3 text-sm text-destructive"
              >
                This controller is fenced and accepts no new work: {fence.reason} Saved results stay
                readable here.
              </p>
            )}

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
                    <span className={labelClassName}>Project</span>
                    <select
                      aria-label="Project"
                      className={selectClassName}
                      value={draft.repository}
                      onChange={(event) => {
                        const repository = event.target.value;
                        const environment = snapshot?.environments?.find((candidate) =>
                          candidate.current.repositories.some(
                            (entry) => entry.repository === repository,
                          ),
                        );
                        const additionalRepositories = (environment?.current.repositories ?? [])
                          .map((entry) => entry.repository)
                          .filter((entry) => entry !== repository);
                        setDraft((current) => ({
                          ...current,
                          repository,
                          additionalRepositories,
                          ...(repository === CLOUD_SCRATCH_WORKSPACE_REPOSITORY
                            ? { publication: "review-only" as const }
                            : {}),
                        }));
                      }}
                    >
                      <option value="">Select a linked GitHub project</option>
                      <option value={CLOUD_SCRATCH_WORKSPACE_REPOSITORY}>Start from scratch</option>
                      {projectOptions.map((project) => (
                        <option key={project.repository} value={project.repository}>
                          {project.title} · {project.repository}
                        </option>
                      ))}
                    </select>
                    {draft.repository === CLOUD_SCRATCH_WORKSPACE_REPOSITORY ? (
                      <span className="text-xs text-muted-foreground">
                        Starts in an isolated workspace. Create a draft repository through GitHub,
                        GitLab, Bitbucket, or Azure DevOps when the work is ready. Port forwarding
                        and Design Mode use the same preview lease as other runs; deploy waits for
                        that draft repository.
                      </span>
                    ) : projectOptions.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        Add a project from a GitHub repository or Git URL first.
                      </span>
                    ) : null}
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
                  <div className={fieldClassName}>
                    <span className={labelClassName}>Model</span>
                    {selectedProvider ? (
                      <ProviderModelPicker
                        activeInstanceId={selectedProvider.instanceId}
                        model={draft.model}
                        lockedProvider={null}
                        instanceEntries={providers}
                        modelOptionsByInstance={modelOptionsByInstance}
                        triggerVariant="outline"
                        triggerClassName="h-8.5 w-full bg-background px-3 text-sm text-foreground shadow-xs/5 sm:h-7.5"
                        triggerAriaLabel="Model"
                        onInstanceModelChange={(instanceId, model) =>
                          setDraft((current) => ({
                            ...current,
                            providerInstanceId: instanceId,
                            model,
                          }))
                        }
                      />
                    ) : (
                      <span className="text-xs text-destructive">
                        No ready provider has a supported model.
                      </span>
                    )}
                  </div>
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
                          {isAppleSiliconMacInstanceType(instanceType)
                            ? `${instanceType} (iOS Simulator)`
                            : isAndroidAcceleratedInstanceType(instanceType)
                              ? `${instanceType} (Android emulator)`
                              : instanceType}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>App surface</span>
                    <select
                      className={selectClassName}
                      value={
                        isAppleSiliconMacInstanceType(draft.instanceType)
                          ? "macos-ios"
                          : draft.workerProfile
                      }
                      disabled={isAppleSiliconMacInstanceType(draft.instanceType)}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          workerProfile:
                            event.target.value === "linux-android" ? "linux-android" : "linux-web",
                        }))
                      }
                    >
                      <option value="linux-web">Web</option>
                      <option value="linux-android">Android emulator</option>
                      {isAppleSiliconMacInstanceType(draft.instanceType) ? (
                        <option value="macos-ios">iOS Simulator</option>
                      ) : null}
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
                {isAppleSiliconMacInstanceType(draft.instanceType) ? (
                  <p className="text-xs text-muted-foreground">
                    iOS Simulator jobs use an Apple Silicon Dedicated Host with a 24-hour minimum.
                    Cancelling the job stops the Simulator work; it does not end the host charge.
                    The local T3 controller must stay online.
                  </p>
                ) : null}
                {draft.workerProfile === "linux-android" &&
                !isAppleSiliconMacInstanceType(draft.instanceType) ? (
                  <p className="text-xs text-muted-foreground">
                    Android jobs boot a nested-virtualization Linux worker with KVM. t3.medium is
                    rejected. ADB stays on the worker loopback; live display is a later thread
                    preview.
                  </p>
                ) : null}
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
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Branch</span>
                    <select
                      className={selectClassName}
                      value={draft.branchBehavior}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          branchBehavior: event.target
                            .value as CloudRunLaunchDraft["branchBehavior"],
                        }))
                      }
                    >
                      <option value="new-cursor-branch">New cursor/ branch</option>
                      <option value="current-branch">Current branch</option>
                      <option value="starting-ref">Starting ref</option>
                      <option value="continue-pr">Continue existing PR</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 pt-6 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.skipReviewerRequest}
                      disabled={draft.publication === "review-only"}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          skipReviewerRequest: event.target.checked,
                        }))
                      }
                    />
                    <span>Skip reviewer requests</span>
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

            {snapshot?.environments !== undefined && snapshot.environments.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">Cloud environments</h3>
                {snapshot.environments.map((environment) => (
                  <CloudEnvironmentCard
                    key={environment.id}
                    environment={environment}
                    builds={(snapshot.builds ?? []).filter(
                      (entry) => entry.environmentId === environment.id,
                    )}
                    busy={busyEnvironmentId === environment.id}
                    onRestore={(target, version) => void restore(target, version)}
                    onBuild={(target) => void build(target)}
                    onSaveBuild={(target) => void acceptBuild(target)}
                    onCancelBuild={(target) => void stopBuild(target)}
                  />
                ))}
              </section>
            ) : null}

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
                    onReview={openReview}
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
                fence !== null ||
                draft.repository.length === 0 ||
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
