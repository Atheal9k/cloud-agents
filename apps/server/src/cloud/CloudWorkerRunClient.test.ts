import { ClientOrchestrationCommand, RunAllocation } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { make } from "./CloudWorkerRunClient.ts";

const decodeAllocation = Schema.decodeSync(RunAllocation);
const decodeCommandJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ClientOrchestrationCommand),
);

const allocation = decodeAllocation({
  id: "allocation-1",
  attempt: 1,
  target: {
    repository: "t3tools/t3code",
    baseCommit: "main",
    branch: "cloud/allocation-1",
  },
  publication: { mode: "review-only" },
  execution: {
    threadId: "thread-allocation-1-1",
    title: "Fix the failing test",
    selectedRef: "main",
    unansweredRequestSeconds: 900,
    turn: {
      commandId: "cloud-launch:allocation-1",
      messageId: "message-allocation-1",
      prompt: "Fix the failing test",
      attachments: [],
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-09-17T03:00:00.000Z",
    },
  },
  profile: {
    id: "linux-web",
    os: "linux",
    arch: "x64",
    instanceType: "t3.medium",
  },
  deadlines: {
    launchBy: "2026-09-17T03:02:00.000Z",
    bootBy: "2026-09-17T03:05:00.000Z",
    registerBy: "2026-09-17T03:07:00.000Z",
    expiresAt: "2026-09-17T04:00:00.000Z",
    cleanupBy: "2026-09-17T04:10:00.000Z",
  },
  allocationState: {
    status: "ready",
    instanceId: "i-worker",
    references: {
      workerId: "worker-1",
      environmentId: "environment-1",
      threadId: "thread-allocation-1-1",
    },
    route: {
      httpBaseUrl: "https://worker.example.test/",
      wsBaseUrl: "wss://worker.example.test/",
      accessToken: "worker-access-token",
    },
    readyAt: "2026-09-17T03:01:00.000Z",
  },
  agentOutcome: { status: "not-started" },
  previewState: { status: "unavailable" },
  cleanupState: { status: "not-requested" },
  handledCommandIds: [],
  sequence: 1,
  createdAt: "2026-09-17T03:00:00.000Z",
  updatedAt: "2026-09-17T03:01:00.000Z",
});

it.effect("starts the ordinary project and provider turn through the registered worker route", () =>
  Effect.gen(function* () {
    const commands: Array<ClientOrchestrationCommand> = [];
    const urls: Array<string> = [];
    const client = HttpClient.make((request) => {
      urls.push(request.url);
      expect(request.headers.authorization).toBe("Bearer worker-access-token");
      expect(request.body._tag).toBe("Uint8Array");
      if (request.body._tag === "Uint8Array") {
        commands.push(decodeCommandJson(new TextDecoder().decode(request.body.body)));
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ sequence: 1 })));
    });
    const runClient = yield* make().pipe(Effect.provideService(HttpClient.HttpClient, client));

    yield* runClient.start(allocation);

    expect(urls).toEqual([
      "https://worker.example.test/api/orchestration/dispatch",
      "https://worker.example.test/api/orchestration/dispatch",
    ]);
    expect(commands).toMatchObject([
      {
        type: "project.create",
        projectId: "cloud:allocation-1:1",
        workspaceRoot: "/work",
      },
      {
        type: "thread.turn.start",
        commandId: "cloud-launch:allocation-1",
        threadId: "thread-allocation-1-1",
        message: {
          text: expect.stringContaining("Prepare t3tools/t3code at main"),
        },
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        bootstrap: {
          createThread: {
            projectId: "cloud:allocation-1:1",
            branch: "cloud/allocation-1",
          },
        },
      },
    ]);
  }),
);
