import {
  CloudExpoMetroControlInput,
  CloudExpoMetroInspectInput,
  RunAllocation,
  emptyCloudSessionLeases,
  type CloudAllocationSnapshot,
  type RunAllocationCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CloudAllocationController from "./CloudAllocationController.ts";
import { make } from "./CloudExpoMetro.ts";
import { CloudRuntimeProvider, type CloudRuntimeProcess } from "./CloudRuntimeProvider.ts";

const NOW = "2026-09-21T04:00:00.000Z";
const decodeAllocation = Schema.decodeSync(RunAllocation);
const decodeControl = Schema.decodeSync(CloudExpoMetroControlInput);
const decodeInspect = Schema.decodeSync(CloudExpoMetroInspectInput);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function readyAllocation(options?: { readonly requestedAt?: string }) {
  return decodeAllocation({
    id: "allocation-expo-1",
    attempt: 1,
    target: {
      repository: "t3tools/mobile-demo",
      baseCommit: "a".repeat(40),
      branch: "cloud/expo-demo",
    },
    control: { agentId: "agent-expo-1", runId: "run-expo-1" },
    profile: { id: "linux-mobile", os: "linux", arch: "x64", instanceType: "small" },
    deadlines: {
      launchBy: "2026-09-21T03:01:00.000Z",
      bootBy: "2026-09-21T03:02:00.000Z",
      registerBy: "2026-09-21T03:03:00.000Z",
      expiresAt: "2026-09-21T08:00:00.000Z",
      cleanupBy: "2026-09-21T08:05:00.000Z",
    },
    allocationState: {
      status: "ready",
      instanceId: "sandbox-expo-1",
      managedRuntime: {
        provider: "daytona",
        runtimeId: "sandbox-expo-1",
        region: "us",
        resourceClass: "small",
        lifecycleState: "started",
        agentId: "agent-expo-1",
        runId: "run-expo-1",
        allocationId: "allocation-expo-1",
        attempt: 1,
        observedAt: "2026-09-21T03:03:00.000Z",
      },
      references: {
        workerId: "worker-expo-1",
        environmentId: "environment-expo-1",
        threadId: "thread-expo-1",
      },
      readyAt: "2026-09-21T03:03:00.000Z",
    },
    agentOutcome: { status: "running", startedAt: "2026-09-21T03:03:00.000Z" },
    previewState: { status: "unavailable" },
    leases: emptyCloudSessionLeases(),
    attemptPurpose: "run",
    idleState: { status: "busy" },
    ...(options?.requestedAt === undefined
      ? {}
      : {
          expoMetro: {
            status: "enabled",
            runId: "run-expo-1",
            platform: "android",
            requestedAt: options.requestedAt,
          },
        }),
    cleanupState: { status: "not-requested" },
    handledCommandIds: [],
    sequence: 4,
    createdAt: "2026-09-21T03:00:00.000Z",
    updatedAt: "2026-09-21T03:03:00.000Z",
  });
}

function fixture(options?: {
  readonly requestedAt?: string;
  readonly endpoint?: string;
  readonly portFree?: boolean;
  readonly processOutput?: string;
  readonly watchAllocations?: boolean;
}) {
  return Effect.gen(function* () {
    let allocation = readyAllocation(
      options?.requestedAt === undefined ? undefined : { requestedAt: options.requestedAt },
    );
    let endpoint = options?.endpoint;
    let process: CloudRuntimeProcess =
      options?.processOutput === undefined
        ? { status: "missing", sessionId: "t3-allocation-expo-1-1-expo-metro" }
        : {
            status: "running",
            sessionId: "t3-allocation-expo-1-1-expo-metro",
            commandId: "metro-process-1",
            command: "pnpm exec expo start --dev-client --tunnel --port 8081",
            output: options.processOutput,
          };
    const ensured: Array<{ readonly sessionId: string; readonly command: string }> = [];
    const deleted: string[] = [];
    const commands: RunAllocationCommand[] = [];

    const snapshot = (): CloudAllocationSnapshot =>
      ({
        controller: {
          mode: "local",
          requiresHostOnline: true,
          admission: { status: "open" },
          writability: { status: "writable" },
        },
        limits: {
          maxConcurrentWorkers: 1,
          maxQueueDepth: 8,
          maxRunSeconds: 7_200,
          maxInputWaitSeconds: 900,
          previewLeaseSeconds: 900,
          previewLeaseMaxSeconds: 3_600,
          idleReleaseSeconds: 3_600,
          conversationRetentionDays: 30,
          allowedInstanceTypes: ["small"],
        },
        workerPriceAssumptions: [],
        spendingControl: "estimate-only",
        allocations: [allocation],
        agents: [
          {
            id: "agent-expo-1",
            allocationId: "allocation-expo-1",
            conversation: { title: "Expo demo", runIds: ["run-expo-1"] },
            repository: "t3tools/mobile-demo",
            baseCommit: "a".repeat(40),
            environmentProfileId: "linux-mobile",
            branches: ["cloud/expo-demo"],
            status: "ACTIVE",
            activeRunId: "run-expo-1",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        runs: [],
        runtimeAttempts: [],
        environments: [],
        builds: [],
        usage: [],
      }) as unknown as CloudAllocationSnapshot;

    const controller = {
      snapshot: Effect.sync(snapshot),
      stream: Stream.empty,
      dispatch: (command: RunAllocationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "allocation.expo-metro-request") {
            allocation = {
              ...allocation,
              expoMetro: {
                status: "enabled",
                runId: command.runId,
                platform: command.platform,
                requestedAt: command.occurredAt,
              },
            };
          }
          if (command.type === "allocation.expo-metro-stop") {
            allocation = {
              ...allocation,
              expoMetro: { status: "disabled", stoppedAt: command.occurredAt },
            };
          }
          return allocation;
        }),
    } as unknown as CloudAllocationController.CloudAllocationController["Service"];

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
        Effect.sync(() => {
          if (input.command.includes("expo-dev-client")) {
            return {
              exitCode: 0,
              output: encodeJson({
                status: "found",
                root: "apps/mobile",
                packageManager: "pnpm@10.16.1",
                files: ["pnpm-lock.yaml", "apps/mobile/package.json"],
              }),
            };
          }
          if (input.command.includes('git", ["diff"')) {
            return { exitCode: 0, output: encodeJson(["apps/mobile/src/App.tsx"]) };
          }
          if (input.command.includes("/_expo/open")) {
            return endpoint === undefined
              ? { exitCode: 7, output: "connection refused" }
              : {
                  exitCode: 0,
                  output: encodeJson({
                    runtime: "custom",
                    url: endpoint,
                    scheme: "exp+mobile-demo",
                    availableRuntimes: ["custom"],
                    appId: "com.t3.mobile-demo",
                  }),
                };
          }
          if (input.command.includes("net.createServer")) {
            return { exitCode: options?.portFree === false ? 2 : 0, output: "" };
          }
          if (input.command.includes("if test -s")) {
            return { exitCode: 0, output: "2026-09-21T04:00:01.000Z\n" };
          }
          return { exitCode: 0, output: "" };
        }),
      ensureProcess: (input) =>
        Effect.sync(() => {
          ensured.push(input);
          process = {
            status: "running",
            sessionId: input.sessionId,
            commandId: "metro-process-1",
            command: input.command,
            output: "[2026-09-21T04:00:00.000Z] Metro waiting on port 8081",
          };
          return process;
        }),
      inspectProcess: (input) =>
        Effect.sync(() =>
          process.status === "missing"
            ? { status: "missing" as const, sessionId: input.sessionId }
            : process,
        ),
      deleteProcess: (input) =>
        Effect.sync(() => {
          deleted.push(input.sessionId);
          process = { status: "missing", sessionId: input.sessionId };
        }),
      preview: () => Effect.die("unused"),
      snapshot: () => Effect.die("unused"),
      desktop: () => Effect.die("unused"),
      resourceClass: "small",
    });

    const service = yield* make({ watchAllocations: options?.watchAllocations ?? false }).pipe(
      Effect.provideService(CloudAllocationController.CloudAllocationController, controller),
      Effect.provideService(CloudRuntimeProvider, runtime),
    );

    return {
      service,
      ensured,
      deleted,
      commands,
      setEndpoint: (value: string | undefined) => {
        endpoint = value;
      },
    };
  });
}

it.effect("starts a named Expo development-client process and reads its structured deep link", () =>
  Effect.gen(function* () {
    const state = yield* fixture({
      endpoint: "exp+mobile-demo://expo-development-client/?url=one",
    });
    const result = yield* state.service.control(
      decodeControl({
        action: "start",
        platform: "android",
        agentId: "agent-expo-1",
        commandId: "start-expo-1",
        occurredAt: NOW,
      }),
    );

    expect(state.ensured).toHaveLength(1);
    expect(state.ensured[0]?.sessionId).toBe("t3-allocation-expo-1-1-expo-metro");
    expect(state.ensured[0]?.command).toContain(
      "pnpm exec expo start --dev-client --tunnel --port 8081",
    );
    expect(state.ensured[0]?.command).toContain(
      "npm install --global --no-audit --no-fund @expo/ngrok@4.1.3",
    );
    expect(state.ensured[0]?.command).not.toContain("--go");
    expect(state.ensured[0]?.command).not.toContain("CI=1");
    expect(state.ensured[0]?.command).toContain("rm -f -- .expo/settings.json");
    expect(result.status).toBe("available");
    if (result.status !== "available" || result.session.status !== "ready") return;
    expect(result.platform).toBe("android");
    expect(result.session.tunnel.deepLink).toBe(
      "exp+mobile-demo://expo-development-client/?url=one",
    );
  }),
);

it.effect("reconciles durable Metro intent when the controller starts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* fixture({
        requestedAt: NOW,
        endpoint: "exp+mobile-demo://expo-development-client/?url=restored",
        watchAllocations: true,
      });
      yield* Effect.yieldNow;

      expect(state.ensured).toHaveLength(1);
      expect(state.ensured[0]?.sessionId).toBe("t3-allocation-expo-1-1-expo-metro");
    }),
  ),
);

it.effect("does not retain a stale deep link between inspections", () =>
  Effect.gen(function* () {
    const state = yield* fixture({
      requestedAt: NOW,
      endpoint: "exp+mobile-demo://expo-development-client/?url=one",
      processOutput: "[2026-09-21T04:01:02.000Z] Android Bundled 315ms index.ts",
    });
    const input = decodeInspect({ agentId: "agent-expo-1" });
    const first = yield* state.service.inspect(input);
    state.setEndpoint("exp+mobile-demo://expo-development-client/?url=two");
    const second = yield* state.service.inspect(input);

    expect(
      first.status === "available" && first.session.status === "ready"
        ? first.session.tunnel.deepLink
        : undefined,
    ).toContain("url=one");
    expect(
      second.status === "available" && second.session.status === "ready"
        ? second.session.tunnel.deepLink
        : undefined,
    ).toContain("url=two");
  }),
);

it.effect("reports tunnel timeout and port conflict independently", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-21T04:10:00.000Z"));
    const timedOut = yield* fixture({
      requestedAt: "2020-01-01T00:00:00.000Z",
      processOutput: "[2020-01-01T00:00:00.000Z] Starting Metro",
    });
    const timeoutStatus = yield* timedOut.service.inspect(
      decodeInspect({ agentId: "agent-expo-1" }),
    );
    expect(timeoutStatus.status === "available" ? timeoutStatus.session.status : undefined).toBe(
      "tunnel-error",
    );

    const occupied = yield* fixture({ requestedAt: NOW, portFree: false });
    const occupiedStatus = yield* occupied.service.inspect(
      decodeInspect({ agentId: "agent-expo-1" }),
    );
    expect(occupiedStatus.status === "available" ? occupiedStatus.session.status : undefined).toBe(
      "metro-error",
    );
  }),
);

it.effect("restarts and cancels the named process while updating durable intent", () =>
  Effect.gen(function* () {
    const state = yield* fixture({
      requestedAt: NOW,
      endpoint: "exp+mobile-demo://expo-development-client/?url=one",
      processOutput: "[2026-09-21T04:00:00.000Z] Metro ready",
    });
    yield* state.service.control(
      decodeControl({
        action: "restart",
        platform: "ios",
        agentId: "agent-expo-1",
        commandId: "restart-expo-1",
        occurredAt: "2026-09-21T04:02:00.000Z",
      }),
    );
    expect(state.deleted).toEqual(["t3-allocation-expo-1-1-expo-metro"]);
    expect(state.ensured).toHaveLength(1);
    expect(state.commands.at(-1)?.type).toBe("allocation.expo-metro-request");

    const stopped = yield* state.service.control(
      decodeControl({
        action: "stop",
        agentId: "agent-expo-1",
        commandId: "stop-expo-1",
        occurredAt: "2026-09-21T04:03:00.000Z",
      }),
    );
    expect(state.deleted).toHaveLength(2);
    expect(state.commands.at(-1)?.type).toBe("allocation.expo-metro-stop");
    expect(stopped.status === "available" ? stopped.session.status : undefined).toBe("stopped");
  }),
);
