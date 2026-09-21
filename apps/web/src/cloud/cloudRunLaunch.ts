import {
  CloudAgentId,
  CLOUD_ENV_SETUP_USER_REQUEST,
  CLOUD_SCRATCH_WORKSPACE_REPOSITORY,
  CloudProviderUnansweredRequestSeconds,
  CloudRunId,
  CommandId,
  MessageId,
  type OrchestrationProjectShell,
  ProviderInstanceId,
  RunAllocationAttempt,
  RunAllocationId,
  type RunAllocation,
  type RunAllocationCommand,
  type RunPublicationIntent,
  type CloudAllocationSnapshot,
  type CloudAllocationLimits,
  ThreadId,
  admitCloudProviderExecution,
  isCloudProviderEnabled,
  workerProfileForInstanceType,
  isAppleSiliconMacInstanceType,
  isAndroidAcceleratedInstanceType,
  linuxAndroidWorkerProfile,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import type { ProviderInstanceEntry } from "../providerInstances";

export interface CloudRunLaunchDraft {
  readonly repository: string;
  readonly additionalRepositories: ReadonlyArray<string>;
  readonly selectedRef: string;
  readonly task: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly runMinutes: string;
  readonly inputWaitMinutes: string;
  readonly instanceType: string;
  readonly workerProfile: "linux-web" | "linux-android";
  readonly publication: "review-only" | "automatic-draft-pr";
  readonly baseBranch: string;
  readonly branchBehavior: "new-cursor-branch" | "current-branch" | "starting-ref" | "continue-pr";
  readonly skipReviewerRequest: boolean;
}

const DEFAULT_CLOUD_RUN_MINUTES = 3 * 24 * 60;

export interface CloudRunProjectOption {
  readonly title: string;
  readonly repository: string;
}

export function cloudRunProjectOptions(
  projects: ReadonlyArray<Pick<OrchestrationProjectShell, "title" | "repositoryIdentity">>,
): ReadonlyArray<CloudRunProjectOption> {
  const seenRepositories = new Set<string>();
  return projects.flatMap((project) => {
    if (
      project.repositoryIdentity?.provider !== "github" &&
      project.repositoryIdentity?.provider !== "gitlab" &&
      project.repositoryIdentity?.provider !== "bitbucket" &&
      project.repositoryIdentity?.provider !== "azure-devops"
    ) {
      return [];
    }
    const repository = sourceControlRepositorySelector(project.repositoryIdentity);
    if (repository === null) return [];
    const key = repository.toLowerCase();
    if (seenRepositories.has(key)) return [];
    seenRepositories.add(key);
    return [{ title: project.title, repository }];
  });
}

function defaultModel(entry: ProviderInstanceEntry | undefined): string {
  return (
    entry?.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    entry?.models[0]?.slug ??
    ""
  );
}

export function createInitialCloudRunDraft(
  snapshot: CloudAllocationSnapshot | null,
  providers: ReadonlyArray<ProviderInstanceEntry>,
  repository = "",
): CloudRunLaunchDraft {
  const maxRunMinutes = Math.max(
    1,
    Math.floor((snapshot?.limits.maxRunSeconds ?? DEFAULT_CLOUD_RUN_MINUTES * 60) / 60),
  );
  const maxInputWaitMinutes = Math.max(
    1,
    Math.floor((snapshot?.limits.maxInputWaitSeconds ?? 900) / 60),
  );
  const provider =
    providers.find((entry) => isCloudProviderEnabled(entry.driverKind)) ?? providers[0];
  // CA-05's controller defaults only fill a field the caller left open, so a
  // launcher opened on a project still starts from that project.
  const defaults = snapshot?.controller.defaults;
  const configuredModel = defaults?.model;
  const ref = defaults?.ref ?? "main";
  return {
    repository: repository === "" ? (defaults?.repository ?? "") : repository,
    additionalRepositories: [],
    selectedRef: ref,
    task: "",
    providerInstanceId: provider?.instanceId ?? "",
    model:
      configuredModel !== undefined &&
      provider?.models.some((model) => model.slug === configuredModel) === true
        ? configuredModel
        : defaultModel(provider),
    runtimeMode: "full-access",
    runMinutes: String(Math.min(DEFAULT_CLOUD_RUN_MINUTES, maxRunMinutes)),
    inputWaitMinutes: String(Math.min(15, maxInputWaitMinutes)),
    instanceType: snapshot?.limits.allowedInstanceTypes[0] ?? "",
    workerProfile: "linux-web",
    publication: "automatic-draft-pr",
    baseBranch: ref,
    branchBehavior: "new-cursor-branch",
    skipReviewerRequest: false,
  };
}

export function cloudEnvSetupLaunchDraft(draft: CloudRunLaunchDraft): CloudRunLaunchDraft {
  return { ...draft, task: CLOUD_ENV_SETUP_USER_REQUEST };
}

export function reconcileCloudRunLaunchInstanceType(
  draft: CloudRunLaunchDraft,
  limits: CloudAllocationLimits,
): CloudRunLaunchDraft {
  if (limits.allowedInstanceTypes.includes(draft.instanceType)) return draft;
  return { ...draft, instanceType: limits.allowedInstanceTypes[0] ?? "" };
}

export type CloudRunLaunchValidation =
  | { readonly status: "valid"; readonly command: RunAllocationCommand }
  | { readonly status: "invalid"; readonly message: string };

function minutes(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function deadline(startMillis: number, seconds: number): string {
  return new Date(startMillis + seconds * 1_000).toISOString();
}

function titleForTask(task: string): string {
  const firstLine = task.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return (firstLine || "Cloud task").slice(0, 120);
}

export function buildCloudRunLaunchCommand(input: {
  readonly draft: CloudRunLaunchDraft;
  readonly limits: CloudAllocationLimits;
  readonly now: Date;
  readonly requestId: string;
  readonly environmentSetup?: {
    readonly name: string;
    readonly scope: "personal" | "team";
  };
}): CloudRunLaunchValidation {
  const task = input.draft.task.trim();
  const scratch = input.draft.repository.trim() === CLOUD_SCRATCH_WORKSPACE_REPOSITORY;
  const repository = input.draft.repository.trim();
  const additionalRepositories = input.draft.additionalRepositories
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== repository);
  const selectedRef = scratch
    ? input.draft.selectedRef.trim() || "main"
    : input.draft.selectedRef.trim();
  const providerInstanceId = input.draft.providerInstanceId.trim();
  const model = input.draft.model.trim();
  const baseBranch = input.draft.baseBranch.trim();
  const runMinutes = minutes(input.draft.runMinutes);
  const inputWaitMinutes = minutes(input.draft.inputWaitMinutes);

  if (repository.length === 0) {
    return {
      status: "invalid",
      message: "Choose a project linked to a source-control repository.",
    };
  }
  if (!scratch && (repository.includes(" ") || repository.includes(".."))) {
    return { status: "invalid", message: "Repository must be a source-control path." };
  }
  if (!scratch && selectedRef.length === 0) {
    return { status: "invalid", message: "Choose a branch, tag, or commit to start from." };
  }
  if (scratch && input.draft.publication === "automatic-draft-pr") {
    return {
      status: "invalid",
      message: "Create a draft repository before opening pull requests from scratch.",
    };
  }
  if (additionalRepositories.length > 0 && input.draft.publication === "automatic-draft-pr") {
    // Coordinated PRs still use the same draft-PR intent; the controller publishes each changed repo.
  }
  if (task.length === 0) {
    return { status: "invalid", message: "Describe the task before launching." };
  }
  if (providerInstanceId.length === 0 || model.length === 0) {
    return { status: "invalid", message: "Choose a supported provider instance and model." };
  }
  const admitted = admitCloudProviderExecution({ instanceId: providerInstanceId });
  if (admitted.status === "rejected") {
    return { status: "invalid", message: admitted.message };
  }
  if (runMinutes === null || runMinutes * 60 > input.limits.maxRunSeconds) {
    return {
      status: "invalid",
      message: `Run time must be between 1 and ${Math.floor(input.limits.maxRunSeconds / 60)} minutes.`,
    };
  }
  if (inputWaitMinutes === null || inputWaitMinutes * 60 > input.limits.maxInputWaitSeconds) {
    return {
      status: "invalid",
      message: `Input wait must be between 1 and ${Math.floor(input.limits.maxInputWaitSeconds / 60)} minutes.`,
    };
  }
  if (!input.limits.allowedInstanceTypes.includes(input.draft.instanceType)) {
    return { status: "invalid", message: "Choose an instance type allowed by this controller." };
  }
  if (
    input.draft.workerProfile === "linux-android" &&
    !isAndroidAcceleratedInstanceType(input.draft.instanceType)
  ) {
    return {
      status: "invalid",
      message:
        "Android emulator jobs need a nested-virtualization instance type such as m7i.xlarge, not the web worker t3.medium.",
    };
  }
  if (input.draft.publication === "automatic-draft-pr" && baseBranch.length === 0) {
    return { status: "invalid", message: "Choose the pull request base branch." };
  }

  const occurredAt = input.now.toISOString();
  const startedAt = input.now.getTime();
  const allocationId = RunAllocationId.make(input.requestId);
  const commandId = CommandId.make(`cloud-launch:${input.requestId}`);
  const threadId = ThreadId.make(`thread-${input.requestId}-1`);
  const messageId = MessageId.make(`message-${input.requestId}`);
  const title = titleForTask(task);
  const skipReviewerRequest = input.draft.skipReviewerRequest === true;
  const branch =
    input.draft.branchBehavior === "new-cursor-branch"
      ? `cursor/${input.requestId.replace(/[^A-Za-z0-9-]/gu, "").slice(0, 12)}`
      : selectedRef;
  const publication: RunPublicationIntent =
    input.draft.publication === "review-only"
      ? { mode: "review-only" }
      : {
          mode: "automatic-draft-pr",
          baseBranch,
          title,
          body: "Started from the T3 Code cloud launch dialog.",
          ...(skipReviewerRequest ? { skipReviewerRequest: true } : {}),
        };

  return {
    status: "valid",
    command: {
      type: "allocation.launch",
      commandId,
      allocationId,
      attempt: RunAllocationAttempt.make(1),
      occurredAt,
      target: {
        repository,
        baseCommit: selectedRef,
        branch: scratch ? "main" : branch,
        ...(scratch ? { workspaceKind: "scratch" as const } : {}),
        ...(additionalRepositories.length === 0
          ? {}
          : {
              additionalRepositories: additionalRepositories.map((entry) => ({
                repository: entry,
                baseCommit: selectedRef,
                branch,
              })),
            }),
      },
      publication,
      control: {
        agentId: CloudAgentId.make(`agent:${input.requestId}`),
        runId: CloudRunId.make(`run:${input.requestId}:1`),
      },
      execution: {
        threadId,
        title,
        selectedRef,
        unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds.make(inputWaitMinutes * 60),
        ...(input.environmentSetup === undefined
          ? {}
          : { environmentSetup: input.environmentSetup }),
        turn: {
          commandId,
          messageId,
          prompt: task,
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make(providerInstanceId),
            model,
          },
          runtimeMode: input.draft.runtimeMode,
          interactionMode: "default",
          createdAt: occurredAt,
        },
      },
      profile: isAppleSiliconMacInstanceType(input.draft.instanceType)
        ? workerProfileForInstanceType(input.draft.instanceType)
        : input.draft.workerProfile === "linux-android"
          ? linuxAndroidWorkerProfile(input.draft.instanceType)
          : workerProfileForInstanceType(input.draft.instanceType),
      deadlines: {
        launchBy: deadline(startedAt, Math.min(2 * 60, runMinutes * 60)),
        bootBy: deadline(startedAt, Math.min(5 * 60, runMinutes * 60)),
        registerBy: deadline(startedAt, Math.min(7 * 60, runMinutes * 60)),
        expiresAt: deadline(startedAt, runMinutes * 60),
        cleanupBy: deadline(startedAt, runMinutes * 60 + 10 * 60),
      },
    },
  };
}

export type CloudRunDisplayState =
  | "provisioning"
  | "setup"
  | "waiting"
  | "running"
  | "finalizing"
  | "failed"
  | "cleanup"
  | "idle"
  | "hibernated"
  | "waking"
  | "complete";

type CloudRunStateSource = {
  readonly allocationState: { readonly status: RunAllocation["allocationState"]["status"] };
  readonly agentOutcome: { readonly status: RunAllocation["agentOutcome"]["status"] };
  readonly cleanupState: { readonly status: RunAllocation["cleanupState"]["status"] };
  readonly idleState: { readonly status: RunAllocation["idleState"]["status"] };
};

export function cloudRunDisplayState(allocation: CloudRunStateSource): CloudRunDisplayState {
  if (allocation.cleanupState.status === "failed") return "failed";
  if (
    allocation.allocationState.status === "failed" ||
    allocation.agentOutcome.status === "failed"
  ) {
    return "failed";
  }
  if (
    allocation.cleanupState.status === "running" ||
    allocation.cleanupState.status === "requested"
  ) {
    return "cleanup";
  }
  if (allocation.cleanupState.status === "succeeded") return "complete";
  // An idle or hibernated agent has finished its turn and is waiting for the
  // next one. Reporting it as finalizing or complete would read as an ended
  // conversation, which is exactly what it is not.
  if (allocation.idleState.status === "hibernated") return "hibernated";
  if (allocation.idleState.status === "idle") return "idle";
  if (allocation.idleState.status === "waking") return "waking";
  if (
    allocation.agentOutcome.status === "succeeded" ||
    allocation.agentOutcome.status === "cancelled"
  ) {
    return "finalizing";
  }
  if (allocation.agentOutcome.status === "running") return "running";
  if (allocation.allocationState.status === "ready") return "waiting";
  if (allocation.allocationState.status === "registering") return "setup";
  return "provisioning";
}

const PROGRESS_LABELS = {
  allocation: "Allocating sandbox",
  start: "Starting sandbox",
  checkout: "Checking out repository",
  setup: "Setting up T3 worker",
  provider: "Running provider",
  terminal: "Starting terminal",
  preview: "Publishing preview",
  stop: "Stopping sandbox",
  archive: "Archiving sandbox",
  delete: "Releasing resource",
} as const;

export function cloudRunProgressPresentation(
  allocation: Pick<RunAllocation, "progress">,
  nowMs: number,
): { readonly label: string; readonly detail: string; readonly elapsed: string } | null {
  const progress = allocation.progress;
  if (progress === undefined) return null;
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - Date.parse(progress.startedAt)) / 1_000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsed =
    minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const label =
    progress.stage === "stop" && progress.status === "requested"
      ? "Cancellation requested"
      : progress.stage === "delete" && progress.status === "succeeded"
        ? "Resource released"
        : PROGRESS_LABELS[progress.stage];
  return { label, detail: progress.message, elapsed };
}

/**
 * What the dialog promises about outliving the client. A local controller
 * outlives the browser but not its machine; a permanent one outlives both, so
 * the copy has to follow the controller rather than be written once.
 */
export function controllerSummary(snapshot: CloudAllocationSnapshot | null): string {
  if (snapshot === null) return "Connecting to the cloud controller...";
  return snapshot.controller.requiresHostOnline
    ? "The local T3 controller stays responsible for this worker after the browser or desktop app disconnects, as long as its machine stays online."
    : "The permanent T3 controller stays responsible for this worker after the browser or desktop app disconnects, with this computer switched off.";
}
