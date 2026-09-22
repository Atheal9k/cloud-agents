import {
  CloudAgentId,
  CloudProviderUnansweredRequestSeconds,
  CloudRunId,
  CommandId,
  MessageId,
  ProviderInstanceId,
  RunAllocationAttempt,
  RunAllocationId,
  ThreadId,
  admitCloudProviderExecution,
  workerProfileForInstanceType,
  type CloudAgentReview,
  type CloudAgentReviewAction,
  type CloudAllocationLimits,
  type RunAllocation,
  type RunAllocationCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type CloudAgentCommandResult =
  | { readonly status: "valid"; readonly command: RunAllocationCommand }
  | { readonly status: "invalid"; readonly message: string };

function deadline(startedAt: number, seconds: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(startedAt + seconds * 1_000));
}

function titleForTask(task: string): string {
  const firstLine = task.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return (firstLine || "Cloud task").slice(0, 120);
}

function runDeadlines(now: Date, limits: CloudAllocationLimits) {
  const startedAt = now.getTime();
  const runSeconds = Math.min(3 * 24 * 60 * 60, limits.maxRunSeconds);
  return {
    launchBy: deadline(startedAt, Math.min(120, runSeconds)),
    bootBy: deadline(startedAt, Math.min(300, runSeconds)),
    registerBy: deadline(startedAt, Math.min(420, runSeconds)),
    expiresAt: deadline(startedAt, runSeconds),
    cleanupBy: deadline(startedAt, runSeconds + 600),
  };
}

export function buildCloudAgentLaunchCommand(input: {
  readonly repository: string;
  readonly selectedRef: string;
  readonly task: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly limits: CloudAllocationLimits;
  readonly now: Date;
  readonly requestId: string;
}): CloudAgentCommandResult {
  const repository = input.repository.trim();
  const selectedRef = input.selectedRef.trim();
  const task = input.task.trim();
  const providerInstanceId = input.providerInstanceId.trim();
  const model = input.model.trim();
  const instanceType = input.limits.allowedInstanceTypes[0];

  if (repository.length === 0 || repository.includes(" ") || repository.includes("..")) {
    return { status: "invalid", message: "Choose a source-control repository." };
  }
  if (selectedRef.length === 0) {
    return { status: "invalid", message: "Choose a branch, tag, or commit." };
  }
  if (task.length === 0) {
    return { status: "invalid", message: "Describe the task before launching." };
  }
  if (providerInstanceId.length === 0 || model.length === 0) {
    return { status: "invalid", message: "No cloud-capable provider and model are ready." };
  }
  const admission = admitCloudProviderExecution({ instanceId: providerInstanceId });
  if (admission.status === "rejected") {
    return { status: "invalid", message: admission.message };
  }
  if (instanceType === undefined) {
    return { status: "invalid", message: "The controller has no allowed worker profile." };
  }

  const occurredAt = input.now.toISOString();
  const allocationId = RunAllocationId.make(input.requestId);
  const commandId = CommandId.make(`mobile-cloud-launch:${input.requestId}`);
  const agentId = CloudAgentId.make(`agent:${input.requestId}`);
  const runId = CloudRunId.make(`run:${input.requestId}:1`);
  const threadId = ThreadId.make(`thread-${input.requestId}-1`);
  const title = titleForTask(task);
  const branchSuffix = input.requestId.replace(/[^A-Za-z0-9-]/gu, "").slice(0, 12);

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
        branch: `cursor/${branchSuffix}`,
      },
      publication: {
        mode: "automatic-draft-pr",
        baseBranch: selectedRef,
        title,
        body: "Started from T3 Code Mobile.",
      },
      control: { agentId, runId },
      execution: {
        threadId,
        title,
        selectedRef,
        unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds.make(
          Math.min(900, input.limits.maxInputWaitSeconds),
        ),
        turn: {
          commandId,
          messageId: MessageId.make(`message-${input.requestId}`),
          prompt: task,
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make(providerInstanceId),
            model,
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: occurredAt,
        },
      },
      profile: workerProfileForInstanceType(instanceType),
      deadlines: runDeadlines(input.now, input.limits),
    },
  };
}

export function buildCloudAgentFollowUpCommand(input: {
  readonly allocation: RunAllocation;
  readonly prompt: string;
  readonly limits: CloudAllocationLimits;
  readonly now: Date;
  readonly requestId: string;
}): CloudAgentCommandResult {
  const prompt = input.prompt.trim();
  const previous = input.allocation.execution;
  const control = input.allocation.control;
  if (prompt.length === 0) {
    return { status: "invalid", message: "Write a follow-up before sending." };
  }
  if (previous === undefined || control === undefined) {
    return { status: "invalid", message: "This retained agent cannot accept a follow-up." };
  }

  const occurredAt = input.now.toISOString();
  const commandId = CommandId.make(`mobile-cloud-follow-up:${input.requestId}`);
  return {
    status: "valid",
    command: {
      type: "allocation.follow-up",
      commandId,
      allocationId: input.allocation.id,
      attempt: input.allocation.attempt,
      occurredAt,
      runId: CloudRunId.make(`run:${input.requestId}`),
      execution: {
        ...previous,
        turn: {
          ...previous.turn,
          commandId,
          messageId: MessageId.make(`message-${input.requestId}`),
          prompt,
          attachments: [],
          createdAt: occurredAt,
        },
      },
      deadlines: runDeadlines(input.now, input.limits),
    },
  };
}

export function cloudAgentStatusLabel(status: CloudAgentReview["agentStatus"]): string {
  switch (status) {
    case "ACTIVE":
      return "Active";
    case "IDLE":
      return "Idle";
    case "ARCHIVED":
      return "Archived";
  }
}

export function cloudReviewActionLabel(action: CloudAgentReviewAction): string {
  switch (action) {
    case "archive":
      return "Archive";
    case "unarchive":
      return "Unarchive";
    case "cancel":
      return "Cancel run";
    case "reopen":
      return "Reopen preview";
    case "stop":
      return "Stop session";
    case "delete":
      return "Delete permanently";
    case "delete-pr":
      return "Delete pull request";
  }
}

export function cloudInspectionText(inspection: CloudAgentReview["diff"]): string {
  switch (inspection.status) {
    case "text":
      return inspection.preview;
    case "binary":
    case "oversized":
    case "missing":
      return inspection.reason;
  }
}
