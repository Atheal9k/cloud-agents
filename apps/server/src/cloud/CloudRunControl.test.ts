import {
  CloudResultError,
  CloudResultManifest,
  CloudRunCancelInput,
  CloudRunRetryInput,
  RunAllocation,
  type RunAllocationCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudProviderExecution from "./CloudProviderExecution.ts";
import { make } from "./CloudRunControl.ts";
import * as CloudRunResults from "./CloudRunResults.ts";

const NOW = "2026-09-17T05:00:00.000Z";
const decodeAllocation = Schema.decodeSync(RunAllocation);
const decodeCancel = Schema.decodeSync(CloudRunCancelInput);
const decodeManifest = Schema.decodeSync(CloudResultManifest);
const decodeRetry = Schema.decodeSync(CloudRunRetryInput);

function runningAllocation() {
  return decodeAllocation({
    id: "allocation-control-1",
    attempt: 1,
    target: {
      repository: "Atheal9k/cloud-agents",
      baseCommit: "a".repeat(40),
      branch: "cloud/run/control-1",
    },
    profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
    deadlines: {
      launchBy: "2026-09-17T05:01:00.000Z",
      bootBy: "2026-09-17T05:02:00.000Z",
      registerBy: "2026-09-17T05:03:00.000Z",
      expiresAt: "2026-09-17T06:00:00.000Z",
      cleanupBy: "2026-09-17T06:05:00.000Z",
    },
    allocationState: {
      status: "ready",
      instanceId: "i-control-1",
      references: {
        workerId: "worker-control-1",
        environmentId: "environment-control-1",
        threadId: "thread-control-1",
      },
      readyAt: NOW,
    },
    agentOutcome: { status: "running", startedAt: NOW },
    previewState: { status: "unavailable" },
    idleState: { status: "busy" },
    cleanupState: { status: "not-requested" },
    handledCommandIds: [],
    sequence: 4,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function retainedManifest() {
  return decodeManifest({
    version: 1,
    resultId: "0".repeat(64),
    allocationId: "allocation-control-1",
    attempt: 1,
    sourceEnvironmentId: "environment-control-1",
    sourceThreadId: "thread-control-1",
    baseCommit: "a".repeat(40),
    outputBranch: "cloud/run/control-1",
    checkpointRef: "refs/t3/cloud-results/control-1/workspace",
    pagePath: `/cloud/results/${"0".repeat(64)}`,
    diffDownloadPath: `/api/cloud/results/${"0".repeat(64)}/downloads/diff`,
    transcriptDownloadPath: `/api/cloud/results/${"0".repeat(64)}/downloads/transcript`,
    verificationDownloadPath: `/api/cloud/results/${"0".repeat(64)}/downloads/verification`,
    workspaceDownloadPath: `/api/cloud/results/${"0".repeat(64)}/downloads/workspace`,
    artifacts: [],
    totalSizeBytes: 0,
    captureStartedAt: NOW,
    capturedAt: NOW,
    expiresAt: "2026-09-24T05:00:00.000Z",
  });
}

function cancelInput() {
  return decodeCancel({
    commandId: "cancel-control-1",
    allocationId: "allocation-control-1",
    attempt: 1,
    occurredAt: "2026-09-17T05:10:00.000Z",
    interrupt: {
      commandId: "interrupt-control-1",
      threadId: "thread-control-1",
      createdAt: "2026-09-17T05:09:59.000Z",
    },
    capture: {
      preparation: {
        allocationId: "allocation-control-1",
        attempt: 1,
        repository: "Atheal9k/cloud-agents",
        selectedRef: "main",
        resolvedCommit: "a".repeat(40),
        outputBranch: "cloud/run/control-1",
        workspacePath: "/work/control-1",
        instructionFiles: ["AGENTS.md"],
        setupResults: [],
        devServers: [],
        verification: [],
        permittedSecretReferences: [],
        preparedAt: NOW,
      },
      verification: {
        allocationId: "allocation-control-1",
        attempt: 1,
        results: [],
        completedAt: "2026-09-17T05:09:58.000Z",
      },
      sourceEnvironmentId: "environment-control-1",
      sourceThreadId: "thread-control-1",
      hardDeadline: "2026-09-17T05:15:00.000Z",
      artifacts: [],
    },
  });
}

function fixture(initial: RunAllocation, options?: { readonly captureFails?: boolean }) {
  return Effect.gen(function* () {
    let allocation = initial;
    const commands: RunAllocationCommand[] = [];
    let interruptCount = 0;
    let captureCount = 0;
    const manifest = retainedManifest();
    const controller = CloudAllocationController.CloudAllocationController.of({
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "allocation.cancel") {
            allocation = {
              ...allocation,
              agentOutcome:
                allocation.agentOutcome.status === "running"
                  ? { status: "cancelled", cancelledAt: command.occurredAt }
                  : allocation.agentOutcome,
              cleanupState:
                allocation.cleanupState.status === "not-requested"
                  ? { status: "requested", requestedAt: command.occurredAt }
                  : allocation.cleanupState,
            };
          }
          if (command.type === "allocation.retry") {
            allocation = {
              ...allocation,
              attempt: command.nextAttempt,
              deadlines: command.deadlines,
              retry: {
                previousAttempt: command.attempt,
                startPoint: command.startPoint,
                publication: command.publication,
              },
              allocationState: { status: "queued" },
              agentOutcome: { status: "not-started" },
              cleanupState: { status: "not-requested" },
            };
          }
          return allocation;
        }),
      snapshot: Effect.sync(() => ({
        controller: { mode: "local", requiresHostOnline: true, admission: { status: "open" } },
        limits: {
          maxConcurrentWorkers: 1,
          maxQueueDepth: 8,
          maxRunSeconds: 7_200,
          maxInputWaitSeconds: 900,
          previewGraceSeconds: 900,
          idleReleaseSeconds: 3_600,
          allowedInstanceTypes: ["t3.medium"],
        },
        workerPriceAssumptions: [],
        spendingControl: "estimate-only",
        allocations: [allocation],
        usage: [],
      })),
      stream: Stream.empty,
      setAdmission: () => Effect.die("unused"),
      refresh: Effect.die("unused"),
      saveBuild: () => Effect.die("unused"),
      cancelBuild: () => Effect.die("unused"),
      setBuildStaleThreshold: () => Effect.die("unused"),
      saveEnvironment: () => Effect.die("unused"),
      restoreEnvironment: () => Effect.die("unused"),
      resolveEnvironment: () => Effect.die("unused"),
    });
    const execution = CloudProviderExecution.CloudProviderExecution.of({
      start: () => Effect.die("unused"),
      followUp: () => Effect.die("unused"),
      interrupt: () =>
        Effect.sync(() => {
          interruptCount += 1;
          return { acceptedSequence: 1 };
        }),
      approve: () => Effect.die("unused"),
      answer: () => Effect.die("unused"),
    });
    const capture = Effect.fn("CloudRunControl.test.capture")(function* () {
      captureCount += 1;
      if (options?.captureFails === true) {
        return yield* new CloudResultError({
          reason: "capture-failed",
          message: "retained storage is unavailable",
          retryable: true,
        });
      }
      return manifest;
    });
    const results = CloudRunResults.CloudRunResults.of({
      capture,
      status: () => Effect.succeed({ status: "retained", manifest }),
      readText: () => Effect.die("unused"),
      resolveDownload: () => Effect.die("unused"),
      startContinuation: () => Effect.die("unused"),
      purge: () => Effect.die("unused"),
    });
    const control = yield* make().pipe(
      Effect.provideService(CloudAllocationController.CloudAllocationController, controller),
      Effect.provideService(CloudProviderExecution.CloudProviderExecution, execution),
      Effect.provideService(CloudRunResults.CloudRunResults, results),
    );
    return {
      commands,
      control,
      counts: () => ({ captureCount, interruptCount }),
      manifest,
    };
  });
}

it.effect("interrupts, retains, and schedules cleanup once across repeated cancellation", () =>
  Effect.gen(function* () {
    const { commands, control, counts, manifest } = yield* fixture(runningAllocation());
    const first = yield* control.cancel(cancelInput());
    const second = yield* control.cancel(cancelInput());

    expect(first.retention).toEqual({ status: "retained", manifest });
    expect(second.allocation.cleanupState.status).toBe("requested");
    expect(counts()).toEqual({ captureCount: 2, interruptCount: 1 });
    expect(commands.map((command) => command.type)).toEqual([
      "allocation.cancel",
      "allocation.cancel",
    ]);
  }),
);

it.effect("schedules cleanup when retaining the cancelled workspace fails", () =>
  Effect.gen(function* () {
    const { commands, control } = yield* fixture(runningAllocation(), { captureFails: true });
    const result = yield* control.cancel(cancelInput());

    expect(result.retention).toEqual({
      status: "failed",
      reason: "capture-failed",
      message: "retained storage is unavailable",
      retryable: true,
    });
    expect(result.allocation.cleanupState.status).toBe("requested");
    expect(commands.map((command) => command.type)).toEqual(["allocation.cancel"]);
  }),
);

it.effect("retries from a retained result with reconciled publication metadata", () =>
  Effect.gen(function* () {
    const previous = decodeAllocation({
      ...runningAllocation(),
      agentOutcome: {
        status: "failed",
        reason: "provider exited",
        resultLocation: { uri: `/cloud/results/${"0".repeat(64)}` },
        completedAt: NOW,
      },
      cleanupState: { status: "succeeded", completedAt: NOW },
    });
    const { commands, control, manifest } = yield* fixture(previous);
    const retried = yield* control.retry(
      decodeRetry({
        commandId: "retry-control-1",
        allocationId: "allocation-control-1",
        attempt: 1,
        nextAttempt: 2,
        deadlines: {
          launchBy: "2026-09-17T05:21:00.000Z",
          bootBy: "2026-09-17T05:22:00.000Z",
          registerBy: "2026-09-17T05:23:00.000Z",
          expiresAt: "2026-09-17T06:20:00.000Z",
          cleanupBy: "2026-09-17T06:25:00.000Z",
        },
        startPoint: { type: "retained-result", resultId: manifest.resultId },
        publication: {
          status: "reconciled-published",
          checkedAt: "2026-09-17T05:19:00.000Z",
          branch: "cloud/run/control-1",
          commit: "b".repeat(40),
          pullRequestUrl: "https://github.com/Atheal9k/cloud-agents/pull/15",
        },
        occurredAt: "2026-09-17T05:20:00.000Z",
      }),
    );

    expect(retried).toMatchObject({
      attempt: 2,
      retry: {
        previousAttempt: 1,
        startPoint: { type: "retained-result", resultId: manifest.resultId },
        publication: { status: "reconciled-published", commit: "b".repeat(40) },
      },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "allocation.retry", nextAttempt: 2 });
  }),
);
