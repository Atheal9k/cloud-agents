import {
  CloudProviderUnansweredRequestSeconds,
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
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import type { ProviderInstanceEntry } from "../providerInstances";

export interface CloudRunLaunchDraft {
  readonly repository: string;
  readonly selectedRef: string;
  readonly task: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly runMinutes: string;
  readonly inputWaitMinutes: string;
  readonly instanceType: string;
  readonly publication: "review-only" | "automatic-draft-pr";
  readonly baseBranch: string;
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
    if (project.repositoryIdentity?.provider !== "github") return [];
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
  const provider = providers[0];
  return {
    repository,
    selectedRef: "main",
    task: "",
    providerInstanceId: provider?.instanceId ?? "",
    model: defaultModel(provider),
    runtimeMode: "full-access",
    runMinutes: String(Math.min(DEFAULT_CLOUD_RUN_MINUTES, maxRunMinutes)),
    inputWaitMinutes: String(Math.min(15, maxInputWaitMinutes)),
    instanceType: snapshot?.limits.allowedInstanceTypes[0] ?? "",
    publication: "automatic-draft-pr",
    baseBranch: "main",
  };
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

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
}): CloudRunLaunchValidation {
  const task = input.draft.task.trim();
  const repository = input.draft.repository.trim();
  const selectedRef = input.draft.selectedRef.trim();
  const providerInstanceId = input.draft.providerInstanceId.trim();
  const model = input.draft.model.trim();
  const baseBranch = input.draft.baseBranch.trim();
  const runMinutes = minutes(input.draft.runMinutes);
  const inputWaitMinutes = minutes(input.draft.inputWaitMinutes);

  if (repository.length === 0) {
    return { status: "invalid", message: "Choose a project linked to a GitHub repository." };
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    return { status: "invalid", message: "Repository must use the owner/name format." };
  }
  if (selectedRef.length === 0) {
    return { status: "invalid", message: "Choose a branch, tag, or commit to start from." };
  }
  if (task.length === 0) {
    return { status: "invalid", message: "Describe the task before launching." };
  }
  if (providerInstanceId.length === 0 || model.length === 0) {
    return { status: "invalid", message: "Choose a supported provider instance and model." };
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
  const publication: RunPublicationIntent =
    input.draft.publication === "review-only"
      ? { mode: "review-only" }
      : {
          mode: "automatic-draft-pr",
          baseBranch,
          title,
          body: "Started from the T3 Code cloud launch dialog.",
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
        branch: `cloud/${input.requestId.slice(0, 12)}`,
      },
      publication,
      execution: {
        threadId,
        title,
        selectedRef,
        unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds.make(inputWaitMinutes * 60),
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
      profile: {
        id: "linux-web",
        os: "linux",
        arch: "x64",
        instanceType: input.draft.instanceType,
      },
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
  | "complete";

type CloudRunStateSource = {
  readonly allocationState: { readonly status: RunAllocation["allocationState"]["status"] };
  readonly agentOutcome: { readonly status: RunAllocation["agentOutcome"]["status"] };
  readonly cleanupState: { readonly status: RunAllocation["cleanupState"]["status"] };
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
