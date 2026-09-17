import {
  CloudProviderExecutionError,
  type CloudProviderExecutionRecord,
  type CloudProviderExecutionStartInput,
  type CloudProviderFollowUpInput,
  type CloudProviderInterruptInput,
  CommandId,
  type OrchestrationCommand,
  ProjectId,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";

const QUALIFIED_DRIVER = ProviderDriverKind.make("codex");

export class CloudProviderExecution extends Context.Service<
  CloudProviderExecution,
  {
    readonly start: (
      input: CloudProviderExecutionStartInput,
    ) => Effect.Effect<CloudProviderExecutionRecord, CloudProviderExecutionError>;
    readonly followUp: (
      input: CloudProviderFollowUpInput,
    ) => Effect.Effect<{ readonly acceptedSequence: number }, CloudProviderExecutionError>;
    readonly interrupt: (
      input: CloudProviderInterruptInput,
    ) => Effect.Effect<{ readonly acceptedSequence: number }, CloudProviderExecutionError>;
  }
>()("t3/cloud/CloudProviderExecution") {}

function executionError(
  reason: CloudProviderExecutionError["reason"],
  message: string,
): CloudProviderExecutionError {
  return new CloudProviderExecutionError({ reason, message });
}

function projectId(preparation: CloudProviderExecutionStartInput["preparation"]) {
  return ProjectId.make(`cloud:${preparation.allocationId}:${preparation.attempt}`);
}

function hasActiveExhaustedWindow(provider: ServerProvider, createdAt: string): boolean {
  const createdAtMillis = Date.parse(createdAt);
  return (
    provider.usageLimits?.windows.some((window) => {
      if (window.usedPercent < 100) return false;
      if (window.resetsAt === undefined) return true;
      const resetsAtMillis = Date.parse(window.resetsAt);
      return (
        !Number.isFinite(createdAtMillis) ||
        !Number.isFinite(resetsAtMillis) ||
        resetsAtMillis > createdAtMillis
      );
    }) === true
  );
}

function supportsModel(provider: ServerProvider, model: string): boolean {
  return provider.models.some(
    (candidate) => candidate.slug === model || candidate.aliases?.includes(model) === true,
  );
}

function validateAttachments(
  attachments: CloudProviderFollowUpInput["turn"]["attachments"],
): Effect.Effect<void, CloudProviderExecutionError> {
  const unsupported = attachments.find(
    (attachment) => attachment.type !== "image" && attachment.type !== "file",
  );
  return unsupported === undefined
    ? Effect.void
    : Effect.fail(
        executionError(
          "unsupported-attachment",
          `Attachment '${unsupported.name}' has unsupported type '${unsupported.type}'.`,
        ),
      );
}

export const make = Effect.fn("CloudProviderExecution.make")(function* () {
  const orchestration = yield* OrchestrationEngineService;
  const providers = yield* ProviderRegistry;

  const preflightTurn = Effect.fn("CloudProviderExecution.preflightTurn")(function* (
    turn: CloudProviderFollowUpInput["turn"],
  ) {
    yield* validateAttachments(turn.attachments);
    const snapshots = yield* providers.getProviders;
    const provider = snapshots.find(
      (candidate) => candidate.instanceId === turn.modelSelection.instanceId,
    );
    if (provider === undefined || provider.driver !== QUALIFIED_DRIVER) {
      return yield* executionError(
        "provider-not-qualified",
        `Provider instance '${turn.modelSelection.instanceId}' is not qualified for cloud execution.`,
      );
    }
    if (
      provider.availability === "unavailable" ||
      provider.installed !== true ||
      provider.enabled !== true ||
      provider.status === "disabled" ||
      provider.status === "error"
    ) {
      return yield* executionError(
        "provider-unavailable",
        `Provider instance '${provider.instanceId}' is unavailable on this worker.`,
      );
    }
    if (provider.auth.status !== "authenticated") {
      return yield* executionError(
        "authentication-failed",
        `Provider instance '${provider.instanceId}' is not authenticated on this worker.`,
      );
    }
    if (!supportsModel(provider, turn.modelSelection.model)) {
      return yield* executionError(
        "model-unavailable",
        `Model '${turn.modelSelection.model}' is unavailable for provider instance '${provider.instanceId}'.`,
      );
    }
    if (hasActiveExhaustedWindow(provider, turn.createdAt)) {
      return yield* executionError(
        "quota-exhausted",
        `Provider instance '${provider.instanceId}' has no remaining quota.`,
      );
    }
  });

  const dispatch = Effect.fn("CloudProviderExecution.dispatch")(function* (
    command: OrchestrationCommand,
  ) {
    return yield* orchestration
      .dispatch(command)
      .pipe(
        Effect.mapError(() =>
          executionError("orchestration-failed", "The worker rejected the T3 session command."),
        ),
      );
  });

  const start: CloudProviderExecution["Service"]["start"] = Effect.fn(
    "CloudProviderExecution.start",
  )(function* (request) {
    yield* preflightTurn(request.turn);

    const executionProjectId = projectId(request.preparation);
    yield* dispatch({
      type: "project.create",
      commandId: CommandId.make(
        `cloud:${request.preparation.allocationId}:${request.preparation.attempt}:project-create`,
      ),
      projectId: executionProjectId,
      title: request.preparation.repository,
      workspaceRoot: request.preparation.workspacePath,
      createdAt: request.turn.createdAt,
    });
    const receipt = yield* dispatch({
      type: "thread.turn.start",
      commandId: request.turn.commandId,
      threadId: request.threadId,
      message: {
        messageId: request.turn.messageId,
        role: "user",
        text: request.turn.prompt,
        attachments: request.turn.attachments,
      },
      modelSelection: request.turn.modelSelection,
      runtimeMode: request.turn.runtimeMode,
      interactionMode: request.turn.interactionMode,
      bootstrap: {
        createThread: {
          projectId: executionProjectId,
          title: request.title,
          modelSelection: request.turn.modelSelection,
          runtimeMode: request.turn.runtimeMode,
          interactionMode: request.turn.interactionMode,
          branch: request.preparation.outputBranch,
          worktreePath: null,
          createdAt: request.turn.createdAt,
        },
      },
      createdAt: request.turn.createdAt,
    });

    return {
      allocationId: request.preparation.allocationId,
      attempt: request.preparation.attempt,
      projectId: executionProjectId,
      threadId: request.threadId,
      modelSelection: request.turn.modelSelection,
      runtimeMode: request.turn.runtimeMode,
      interactionMode: request.turn.interactionMode,
      acceptedSequence: receipt.sequence,
      startedAt: request.turn.createdAt,
    } satisfies CloudProviderExecutionRecord;
  });

  const followUp: CloudProviderExecution["Service"]["followUp"] = Effect.fn(
    "CloudProviderExecution.followUp",
  )(function* (request) {
    yield* preflightTurn(request.turn);
    const receipt = yield* dispatch({
      type: "thread.turn.start",
      commandId: request.turn.commandId,
      threadId: request.threadId,
      message: {
        messageId: request.turn.messageId,
        role: "user",
        text: request.turn.prompt,
        attachments: request.turn.attachments,
      },
      modelSelection: request.turn.modelSelection,
      runtimeMode: request.turn.runtimeMode,
      interactionMode: request.turn.interactionMode,
      createdAt: request.turn.createdAt,
    });
    return { acceptedSequence: receipt.sequence };
  });

  const interrupt: CloudProviderExecution["Service"]["interrupt"] = Effect.fn(
    "CloudProviderExecution.interrupt",
  )(function* (request) {
    const receipt = yield* dispatch({
      type: "thread.turn.interrupt",
      commandId: request.commandId,
      threadId: request.threadId,
      ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
      createdAt: request.createdAt,
    });
    return { acceptedSequence: receipt.sequence };
  });

  return CloudProviderExecution.of({ start, followUp, interrupt });
});

export const layer = Layer.effect(CloudProviderExecution, make());
