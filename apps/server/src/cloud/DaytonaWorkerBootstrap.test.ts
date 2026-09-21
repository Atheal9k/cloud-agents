import { RunAllocation, emptyCloudSessionLeases } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { CloudRuntimeProvider } from "./CloudRuntimeProvider.ts";
import { make } from "./DaytonaWorkerBootstrap.ts";

const allocation = Schema.decodeSync(RunAllocation)({
  id: "allocation-daytona-worker",
  attempt: 1,
  target: {
    repository: "t3tools/t3code",
    baseCommit: "main",
    branch: "cloud/daytona-worker",
  },
  publication: { mode: "review-only" },
  execution: {
    threadId: "thread-daytona-worker",
    title: "Run inside Daytona",
    selectedRef: "main",
    unansweredRequestSeconds: 900,
    turn: {
      commandId: "command-daytona-worker",
      messageId: "message-daytona-worker",
      prompt: "Prove the worker path",
      attachments: [],
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-09-17T03:00:00.000Z",
    },
  },
  profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "small" },
  deadlines: {
    launchBy: "2026-09-17T03:05:00.000Z",
    bootBy: "2026-09-17T03:10:00.000Z",
    registerBy: "2026-09-17T03:15:00.000Z",
    expiresAt: "2026-09-17T05:00:00.000Z",
    cleanupBy: "2026-09-17T05:05:00.000Z",
  },
  allocationState: {
    status: "registering",
    instanceId: "sandbox-worker",
    managedRuntime: {
      provider: "daytona",
      runtimeId: "sandbox-worker",
      region: "us",
      resourceClass: "small",
      lifecycleState: "started",
      agentId: "agent-daytona-worker",
      runId: "run-daytona-worker",
      allocationId: "allocation-daytona-worker",
      attempt: 1,
      observedAt: "2026-09-17T03:01:00.000Z",
    },
    bootedAt: "2026-09-17T03:01:00.000Z",
  },
  agentOutcome: { status: "not-started" },
  previewState: { status: "unavailable" },
  leases: emptyCloudSessionLeases(),
  idleState: { status: "busy" },
  attemptPurpose: "run",
  cleanupState: { status: "not-requested" },
  handledCommandIds: [],
  sequence: 4,
  createdAt: "2026-09-17T03:00:00.000Z",
  updatedAt: "2026-09-17T03:01:00.000Z",
});

it.effect("reconciles named processes and registers through a signed Daytona route", () =>
  Effect.gen(function* () {
    const processCommands: string[] = [];
    const urls: string[] = [];
    const runtime = CloudRuntimeProvider.of({
      readiness: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      inspect: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      start: () => Effect.die("unused"),
      stop: () => Effect.die("unused"),
      archive: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      execute: (input) =>
        Effect.succeed(
          input.command.includes("auth pairing create")
            ? { exitCode: 0, output: '{"credential":"pairing-token"}' }
            : { exitCode: 0, output: "" },
        ),
      ensureProcess: (input) =>
        Effect.sync(() => {
          processCommands.push(input.command);
          return input.sessionId.endsWith("worker")
            ? {
                status: "running" as const,
                sessionId: input.sessionId,
                commandId: "worker-command",
                command: input.command,
                output: "",
              }
            : {
                status: "succeeded" as const,
                sessionId: input.sessionId,
                commandId: "completed-command",
                command: input.command,
                exitCode: 0,
                output: "ready",
              };
        }),
      inspectProcess: (input) =>
        Effect.succeed({
          status: "running",
          sessionId: input.sessionId,
          commandId: "worker-command",
          command: "t3 --host 0.0.0.0",
          output: "T3 Code listening",
        }),
      deleteProcess: () => Effect.die("unused"),
      preview: () =>
        Effect.succeed({
          url: "https://3773-sandbox.proxy.daytona.test/?token=preview-token",
          token: "preview-token",
        }),
      snapshot: () => Effect.die("unused"),
      desktop: () => Effect.die("unused"),
      resourceClass: "small",
    });
    const httpClient = HttpClient.make((request) => {
      urls.push(request.url);
      const body = request.url.includes("/.well-known/t3/environment")
        ? {
            environmentId: "environment-daytona-worker",
            label: "Daytona worker",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.42",
            orchestrationProtocolVersion: 1,
            capabilities: { repositoryIdentity: true },
          }
        : {
            access_token: "worker-access-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 7200,
            scope: "orchestration:read orchestration:write",
          };
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
    });
    const worker = yield* make().pipe(
      Effect.provideService(CloudRuntimeProvider, runtime),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

    expect((yield* worker.prepare({ allocation })).status).toBe("ready");
    const registration = yield* worker.registration({ allocation });

    expect(processCommands.some((command) => command.includes("git clone"))).toBe(true);
    expect(processCommands.some((command) => command.includes("codex --version"))).toBe(true);
    expect(processCommands.some((command) => command.includes("t3 --host 0.0.0.0"))).toBe(true);
    expect(urls).toEqual([
      "https://3773-sandbox.proxy.daytona.test/.well-known/t3/environment?token=preview-token",
      "https://3773-sandbox.proxy.daytona.test/oauth/token?token=preview-token",
    ]);
    expect(registration).toMatchObject({
      references: {
        workerId: "daytona:sandbox-worker",
        environmentId: "environment-daytona-worker",
        threadId: "thread-daytona-worker",
      },
      route: {
        httpBaseUrl: "https://3773-sandbox.proxy.daytona.test/?token=preview-token",
        wsBaseUrl: "wss://3773-sandbox.proxy.daytona.test/?token=preview-token",
        accessToken: "worker-access-token",
      },
    });
  }),
);
