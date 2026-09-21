import {
  CLOUD_RUNTIME_REOPEN_PATH,
  CLOUD_SESSION_EDITS_PATH,
  CloudRuntimeReopen,
  CloudSessionEdits,
  CommandId,
  DispatchResult,
  OrchestrationThreadDetailSnapshot,
  ProjectId,
  RunRuntimeFlush,
  type ClientOrchestrationCommand,
  type CloudEnvironmentVersion,
  type RunAllocation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

export type CloudWorkerTurnStatus = "running" | "succeeded" | "failed";

export class CloudWorkerRunClientError extends Schema.TaggedError<CloudWorkerRunClientError>()(
  "CloudWorkerRunClientError",
  {
    stage: Schema.Literals(["start", "status", "flush", "reopen", "session-edits"]),
    message: Schema.String,
  },
) {}

export class CloudWorkerRunClient extends Context.Service<
  CloudWorkerRunClient,
  {
    readonly start: (allocation: RunAllocation) => Effect.Effect<void, CloudWorkerRunClientError>;
    readonly status: (
      allocation: RunAllocation,
    ) => Effect.Effect<CloudWorkerTurnStatus, CloudWorkerRunClientError>;
    /** Windowed T3 thread snapshot. Callers pass turnLimit so reconnect stays bounded. */
    readonly threadDetail: (
      allocation: RunAllocation,
      window?: { readonly turnLimit?: number; readonly beforeCursor?: string },
    ) => Effect.Effect<OrchestrationThreadDetailSnapshot, CloudWorkerRunClientError>;
    /** Brings the guest's durable state to a consistent point after a settle. */
    readonly flush: (
      allocation: RunAllocation,
    ) => Effect.Effect<RunRuntimeFlush, CloudWorkerRunClientError>;
    /** Runs the environment's per-boot `start` on a woken guest. Submits no turn. */
    readonly reopen: (
      allocation: RunAllocation,
      version: CloudEnvironmentVersion,
    ) => Effect.Effect<CloudRuntimeReopen, CloudWorkerRunClientError>;
    /** Captures the edits a person made by hand during a reopened session. */
    readonly sessionEdits: (
      allocation: RunAllocation,
    ) => Effect.Effect<CloudSessionEdits, CloudWorkerRunClientError>;
  }
>()("t3/cloud/CloudWorkerRunClient") {}

function clientError(
  stage: CloudWorkerRunClientError["stage"],
  message: string,
): CloudWorkerRunClientError {
  return new CloudWorkerRunClientError({ stage, message });
}

function readyRun(allocation: RunAllocation) {
  if (
    allocation.allocationState.status !== "ready" ||
    allocation.allocationState.route === undefined ||
    allocation.execution === undefined
  ) {
    return null;
  }
  return {
    route: allocation.allocationState.route,
    execution: allocation.execution,
  };
}

function projectId(allocation: RunAllocation) {
  return ProjectId.make(`cloud:${allocation.id}:${allocation.attempt}`);
}

function taskPrompt(allocation: RunAllocation): string {
  const execution = allocation.execution;
  if (execution === undefined) return "";
  const ios =
    allocation.profile.device === "ios"
      ? [
          "This runtime is a macOS iOS worker. Reserve one Simulator UDID for this job, build with simulator signing, and keep artifacts under artifacts/ios.",
          "Do not require device distribution certificates. Do not treat Dedicated Host billing as ended if the job is cancelled.",
          "",
        ]
      : [];
  return [
    ...ios,
    `${allocation.target.repository} is prepared at ${execution.selectedRef} in /work/repository.`,
    `Work on the checked-out output branch ${allocation.target.branch}.`,
    "",
    execution.turn.prompt,
  ].join("\n");
}

function requestUrl(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.hash = "";
  return url.toString();
}

export const make = Effect.fn("CloudWorkerRunClient.make")(function* () {
  const client = yield* HttpClient.HttpClient;

  const execute = Effect.fn("CloudWorkerRunClient.execute")(function* (input: {
    readonly allocation: RunAllocation;
    readonly command: ClientOrchestrationCommand;
  }) {
    const run = readyRun(input.allocation);
    if (run === null) {
      return yield* clientError("start", "The allocation has no ready worker execution route.");
    }
    yield* HttpClientRequest.post(
      requestUrl(run.route.httpBaseUrl, "/api/orchestration/dispatch"),
    ).pipe(
      HttpClientRequest.bearerToken(run.route.accessToken),
      HttpClientRequest.bodyJson(input.command),
      Effect.flatMap(client.execute),
      Effect.timeout("20 seconds"),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(DispatchResult)),
      Effect.mapError(() =>
        clientError("start", "The worker rejected the cloud thread start request."),
      ),
    );
  });

  const start: CloudWorkerRunClient["Service"]["start"] = Effect.fn("CloudWorkerRunClient.start")(
    function* (allocation) {
      const run = readyRun(allocation);
      if (run === null) {
        return yield* clientError("start", "The allocation has no ready worker execution route.");
      }
      const execution = run.execution;
      const executionProjectId = projectId(allocation);
      yield* execute({
        allocation,
        command: {
          type: "project.create",
          commandId: CommandId.make(`${execution.turn.commandId}:project`),
          projectId: executionProjectId,
          title: allocation.target.repository,
          workspaceRoot: "/work/repository",
          createdAt: execution.turn.createdAt,
        },
      });
      yield* execute({
        allocation,
        command: {
          type: "thread.create",
          commandId: CommandId.make(`${execution.turn.commandId}:thread`),
          threadId: execution.threadId,
          projectId: executionProjectId,
          title: execution.title,
          modelSelection: execution.turn.modelSelection,
          runtimeMode: execution.turn.runtimeMode,
          interactionMode: execution.turn.interactionMode,
          branch: allocation.target.branch,
          worktreePath: null,
          createdAt: execution.turn.createdAt,
        },
      });
      yield* execute({
        allocation,
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make(`${execution.turn.commandId}:worker-turn`),
          threadId: execution.threadId,
          message: {
            messageId: execution.turn.messageId,
            role: "user",
            text: taskPrompt(allocation),
            attachments: execution.turn.attachments,
          },
          modelSelection: execution.turn.modelSelection,
          titleSeed: execution.title,
          runtimeMode: execution.turn.runtimeMode,
          interactionMode: execution.turn.interactionMode,
          createdAt: execution.turn.createdAt,
        },
      });
    },
  );

  const threadDetail: CloudWorkerRunClient["Service"]["threadDetail"] = Effect.fn(
    "CloudWorkerRunClient.threadDetail",
  )(function* (allocation, window) {
    const run = readyRun(allocation);
    if (run === null) {
      return yield* clientError("status", "The allocation has no ready worker execution route.");
    }
    const url = new URL(
      requestUrl(
        run.route.httpBaseUrl,
        `/api/orchestration/threads/${encodeURIComponent(run.execution.threadId)}`,
      ),
    );
    if (window?.turnLimit !== undefined)
      url.searchParams.set("turnLimit", String(window.turnLimit));
    if (window?.beforeCursor !== undefined) {
      url.searchParams.set("beforeCursor", window.beforeCursor);
    }
    return yield* client
      .execute(
        HttpClientRequest.get(url.toString()).pipe(
          HttpClientRequest.bearerToken(run.route.accessToken),
        ),
      )
      .pipe(
        Effect.timeout("20 seconds"),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(OrchestrationThreadDetailSnapshot)),
        Effect.mapError(() => clientError("status", "The worker thread status is unavailable.")),
      );
  });

  const status: CloudWorkerRunClient["Service"]["status"] = Effect.fn(
    "CloudWorkerRunClient.status",
  )(function* (allocation) {
    const snapshot = yield* threadDetail(allocation, { turnLimit: 1 });
    const turn = snapshot.thread.latestTurn;
    if (turn === null || turn.state === "running") return "running";
    return turn.state === "completed" ? "succeeded" : "failed";
  });

  const flush: CloudWorkerRunClient["Service"]["flush"] = Effect.fn("CloudWorkerRunClient.flush")(
    function* (allocation) {
      const run = readyRun(allocation);
      if (run === null) {
        return yield* clientError("flush", "The allocation has no ready worker execution route.");
      }
      return yield* HttpClientRequest.post(
        requestUrl(run.route.httpBaseUrl, "/api/cloud/workers/flush"),
      ).pipe(
        HttpClientRequest.bearerToken(run.route.accessToken),
        HttpClientRequest.bodyJson({
          allocationId: allocation.id,
          attempt: allocation.attempt,
          threadId: run.execution.threadId,
        }),
        Effect.flatMap(client.execute),
        Effect.timeout("60 seconds"),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RunRuntimeFlush)),
        Effect.mapError(() =>
          clientError("flush", "The worker could not flush its runtime state."),
        ),
      );
    },
  );

  const reopen: CloudWorkerRunClient["Service"]["reopen"] = Effect.fn(
    "CloudWorkerRunClient.reopen",
  )(function* (allocation, version) {
    const run = readyRun(allocation);
    if (run === null) {
      return yield* clientError("reopen", "The allocation has no ready worker execution route.");
    }
    return yield* HttpClientRequest.post(
      requestUrl(run.route.httpBaseUrl, CLOUD_RUNTIME_REOPEN_PATH),
    ).pipe(
      HttpClientRequest.bearerToken(run.route.accessToken),
      HttpClientRequest.bodyJson({
        allocationId: allocation.id,
        attempt: allocation.attempt,
        threadId: run.execution.threadId,
        version,
      }),
      Effect.flatMap(client.execute),
      Effect.timeout("60 seconds"),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(CloudRuntimeReopen)),
      Effect.mapError(() =>
        clientError("reopen", "The worker could not reopen its environment services."),
      ),
    );
  });

  const sessionEdits: CloudWorkerRunClient["Service"]["sessionEdits"] = Effect.fn(
    "CloudWorkerRunClient.sessionEdits",
  )(function* (allocation) {
    const run = readyRun(allocation);
    if (run === null) {
      return yield* clientError(
        "session-edits",
        "The allocation has no ready worker execution route.",
      );
    }
    return yield* HttpClientRequest.post(
      requestUrl(run.route.httpBaseUrl, CLOUD_SESSION_EDITS_PATH),
    ).pipe(
      HttpClientRequest.bearerToken(run.route.accessToken),
      HttpClientRequest.bodyJson({
        allocationId: allocation.id,
        attempt: allocation.attempt,
        threadId: run.execution.threadId,
      }),
      Effect.flatMap(client.execute),
      Effect.timeout("60 seconds"),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(CloudSessionEdits)),
      Effect.mapError(() =>
        clientError("session-edits", "The worker could not capture the session edits."),
      ),
    );
  });

  return CloudWorkerRunClient.of({ start, status, threadDetail, flush, reopen, sessionEdits });
});

export const layer = Layer.effect(CloudWorkerRunClient, make());
