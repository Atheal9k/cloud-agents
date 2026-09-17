import {
  ApprovalRequestId,
  type CloudProviderApprovalInput,
  CloudProviderExecutionError,
  type CloudProviderExecutionRecord,
  type CloudProviderExecutionStartInput,
  type CloudProviderFollowUpInput,
  type CloudProviderInterruptInput,
  type CloudProviderUserInput,
  CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProjectId,
  ProviderDriverKind,
  type ProjectScript,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

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
    readonly approve: (
      input: CloudProviderApprovalInput,
    ) => Effect.Effect<{ readonly acceptedSequence: number }, CloudProviderExecutionError>;
    readonly answer: (
      input: CloudProviderUserInput,
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

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

function quotePosixShellWord(value: string): string {
  return SAFE_SHELL_WORD.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function devServerScripts(
  preparation: CloudProviderExecutionStartInput["preparation"],
): ReadonlyArray<ProjectScript> {
  return preparation.devServers.map((server, index) => ({
    id: `cloud-dev-${index + 1}`,
    name: server.name,
    command: [server.command.command, ...server.command.args].map(quotePosixShellWord).join(" "),
    icon: "play",
    runOnWorktreeCreate: false,
    previewUrl: `http://localhost:${server.port}`,
  }));
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

function activityRequestId(event: OrchestrationEvent): ApprovalRequestId | undefined {
  if (event.type !== "thread.activity-appended") return undefined;
  const payload = event.payload.activity.payload;
  if (!Predicate.isObject(payload) || !Predicate.isString(payload.requestId)) return undefined;
  return ApprovalRequestId.make(payload.requestId);
}

const build = Effect.fn("CloudProviderExecution.build")(function* (input?: {
  readonly maxInputWaitSeconds?: number;
}) {
  const orchestration = yield* OrchestrationEngineService;
  const providers = yield* ProviderRegistry;
  const requestPolicies = new Map<
    CloudProviderExecutionStartInput["threadId"],
    CloudProviderExecutionStartInput["unansweredRequestSeconds"]
  >();
  const pendingRequests = new Map<
    string,
    {
      readonly threadId: CloudProviderExecutionStartInput["threadId"];
      readonly resolved: Deferred.Deferred<void>;
    }
  >();

  const requestKey = (threadId: CloudProviderExecutionStartInput["threadId"], requestId: string) =>
    `${threadId}:${requestId}`;

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

  const resolveRequest = (
    threadId: CloudProviderExecutionStartInput["threadId"],
    requestId: ApprovalRequestId,
  ) => {
    const pending = pendingRequests.get(requestKey(threadId, requestId));
    return pending === undefined ? Effect.void : Deferred.succeed(pending.resolved, undefined);
  };

  const resolveThreadRequests = (threadId: CloudProviderExecutionStartInput["threadId"]) =>
    Effect.forEach(
      pendingRequests.values(),
      (pending) =>
        pending.threadId === threadId ? Deferred.succeed(pending.resolved, undefined) : Effect.void,
      { discard: true },
    );

  const processEvent = Effect.fn("CloudProviderExecution.processEvent")(function* (
    event: OrchestrationEvent,
  ) {
    if (
      event.type === "thread.approval-response-requested" ||
      event.type === "thread.user-input-response-requested"
    ) {
      yield* resolveRequest(event.payload.threadId, event.payload.requestId);
      return;
    }
    if (event.type === "thread.turn-interrupt-requested" || event.type === "thread.settled") {
      yield* resolveThreadRequests(event.payload.threadId);
      return;
    }
    if (event.type !== "thread.activity-appended") return;

    const activity = event.payload.activity;
    if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      const requestId = activityRequestId(event);
      if (requestId !== undefined) yield* resolveRequest(event.payload.threadId, requestId);
      return;
    }
    if (activity.kind !== "approval.requested" && activity.kind !== "user-input.requested") return;

    const requestId = activityRequestId(event);
    const timeoutSeconds = requestPolicies.get(event.payload.threadId);
    if (requestId === undefined || timeoutSeconds === undefined) return;
    const key = requestKey(event.payload.threadId, requestId);
    if (pendingRequests.has(key)) return;

    const resolved = yield* Deferred.make<void>();
    pendingRequests.set(key, { threadId: event.payload.threadId, resolved });
    const expire = Effect.gen(function* () {
      yield* Effect.sleep(Duration.seconds(timeoutSeconds));
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      if (activity.kind === "approval.requested") {
        yield* dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make(`cloud-request-timeout:${requestId}`),
          threadId: event.payload.threadId,
          requestId,
          decision: "decline",
          createdAt,
        }).pipe(Effect.ignore);
        return;
      }
      yield* dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(`cloud-request-timeout:${requestId}`),
        threadId: event.payload.threadId,
        ...(activity.turnId === null ? {} : { turnId: activity.turnId }),
        createdAt,
      }).pipe(Effect.ignore);
    });
    yield* Effect.race(Deferred.await(resolved), expire).pipe(
      Effect.ensuring(Effect.sync(() => pendingRequests.delete(key))),
      Effect.forkScoped,
    );
  });

  const start: CloudProviderExecution["Service"]["start"] = Effect.fn(
    "CloudProviderExecution.start",
  )(function* (request) {
    const maxInputWaitSeconds = input?.maxInputWaitSeconds ?? 15 * 60;
    if (request.unansweredRequestSeconds > maxInputWaitSeconds) {
      return yield* executionError(
        "invalid-execution-policy",
        `Input may wait at most ${maxInputWaitSeconds} seconds on this worker.`,
      );
    }
    yield* preflightTurn(request.turn);
    requestPolicies.set(request.threadId, request.unansweredRequestSeconds);

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
    yield* dispatch({
      type: "project.meta.update",
      commandId: CommandId.make(
        `cloud:${request.preparation.allocationId}:${request.preparation.attempt}:preview-scripts`,
      ),
      projectId: executionProjectId,
      scripts: [...devServerScripts(request.preparation)],
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

    yield* Effect.logInfo("Cloud provider execution started.", {
      allocationId: request.preparation.allocationId,
      attempt: request.preparation.attempt,
      threadId: request.threadId,
      providerInstanceId: request.turn.modelSelection.instanceId,
    });

    return {
      allocationId: request.preparation.allocationId,
      attempt: request.preparation.attempt,
      projectId: executionProjectId,
      threadId: request.threadId,
      modelSelection: request.turn.modelSelection,
      runtimeMode: request.turn.runtimeMode,
      interactionMode: request.turn.interactionMode,
      unansweredRequestSeconds: request.unansweredRequestSeconds,
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

  const approve: CloudProviderExecution["Service"]["approve"] = Effect.fn(
    "CloudProviderExecution.approve",
  )(function* (request) {
    const receipt = yield* dispatch({
      type: "thread.approval.respond",
      commandId: request.commandId,
      threadId: request.threadId,
      requestId: request.requestId,
      decision: request.decision,
      createdAt: request.createdAt,
    });
    return { acceptedSequence: receipt.sequence };
  });

  const answer: CloudProviderExecution["Service"]["answer"] = Effect.fn(
    "CloudProviderExecution.answer",
  )(function* (request) {
    const receipt = yield* dispatch({
      type: "thread.user-input.respond",
      commandId: request.commandId,
      threadId: request.threadId,
      requestId: request.requestId,
      answers: request.answers,
      ...(request.attachmentsByQuestionId === undefined
        ? {}
        : { attachmentsByQuestionId: request.attachmentsByQuestionId }),
      createdAt: request.createdAt,
    });
    return { acceptedSequence: receipt.sequence };
  });

  return {
    service: CloudProviderExecution.of({ start, followUp, interrupt, approve, answer }),
    processEvent,
  };
});

export const make = Effect.fn("CloudProviderExecution.make")(function* (input?: {
  readonly maxInputWaitSeconds?: number;
}) {
  return (yield* build(input)).service;
});

export const layer = Layer.effect(
  CloudProviderExecution,
  Effect.gen(function* () {
    const orchestration = yield* OrchestrationEngineService;
    const events = yield* orchestration.subscribeDomainEvents;
    const maxInputWaitSeconds = yield* Config.int("T3CODE_CLOUD_MAX_INPUT_WAIT_SECONDS").pipe(
      Config.withDefault(15 * 60),
    );
    const built = yield* build({ maxInputWaitSeconds });
    yield* Stream.runForEach(events, built.processEvent).pipe(Effect.forkScoped);
    return built.service;
  }),
);
