import {
  CommandId,
  DispatchResult,
  OrchestrationThreadDetailSnapshot,
  ProjectId,
  type ClientOrchestrationCommand,
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
    stage: Schema.Literals(["start", "status"]),
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
  return [
    `Prepare ${allocation.target.repository} at ${execution.selectedRef} in /work/repository before changing files.`,
    `Use the output branch ${allocation.target.branch}. Do not print or copy credentials into the workspace.`,
    "",
    execution.turn.prompt,
  ].join("\n");
}

function requestUrl(baseUrl: string, pathname: string): string {
  return new URL(pathname, baseUrl).toString();
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
          workspaceRoot: "/work",
          createdAt: execution.turn.createdAt,
        },
      });
      yield* execute({
        allocation,
        command: {
          type: "thread.turn.start",
          commandId: execution.turn.commandId,
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
          bootstrap: {
            createThread: {
              projectId: executionProjectId,
              title: execution.title,
              modelSelection: execution.turn.modelSelection,
              runtimeMode: execution.turn.runtimeMode,
              interactionMode: execution.turn.interactionMode,
              branch: allocation.target.branch,
              worktreePath: null,
              createdAt: execution.turn.createdAt,
            },
          },
          createdAt: execution.turn.createdAt,
        },
      });
    },
  );

  const status: CloudWorkerRunClient["Service"]["status"] = Effect.fn(
    "CloudWorkerRunClient.status",
  )(function* (allocation) {
    const run = readyRun(allocation);
    if (run === null) {
      return yield* clientError("status", "The allocation has no ready worker execution route.");
    }
    const snapshot = yield* client
      .execute(
        HttpClientRequest.get(
          requestUrl(
            run.route.httpBaseUrl,
            `/api/orchestration/threads/${encodeURIComponent(run.execution.threadId)}`,
          ),
        ).pipe(HttpClientRequest.bearerToken(run.route.accessToken)),
      )
      .pipe(
        Effect.timeout("20 seconds"),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(OrchestrationThreadDetailSnapshot)),
        Effect.mapError(() => clientError("status", "The worker thread status is unavailable.")),
      );
    const turn = snapshot.thread.latestTurn;
    if (turn === null || turn.state === "running") return "running";
    return turn.state === "completed" ? "succeeded" : "failed";
  });

  return CloudWorkerRunClient.of({ start, status });
});

export const layer = Layer.effect(CloudWorkerRunClient, make());
