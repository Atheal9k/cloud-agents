import { RunAllocationCommand } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudAllocationReconciler from "./CloudAllocationReconciler.ts";
import { CloudRuntimeProvider } from "./CloudRuntimeProvider.ts";
import { CloudWorkerRegistration } from "./CloudWorkerRegistration.ts";
import { CloudWorkerRunClient } from "./CloudWorkerRunClient.ts";
import {
  CloudWorkerProvider,
  CloudWorkerProviderError,
  type CloudWorkerResource,
} from "./CloudWorkerProvider.ts";

const decodeCommand = Schema.decodeSync(RunAllocationCommand);
const startAt = Date.parse("2026-09-19T00:00:00.000Z");

it.effect("cleans a historical Mac allocation without releasing its Dedicated Host", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startAt);
    const state: {
      instance: CloudWorkerResource | undefined;
      terminateCalls: number;
      allocateCalls: number;
      launchHostIds: Array<string | undefined>;
    } = {
      instance: undefined,
      terminateCalls: 0,
      allocateCalls: 0,
      launchHostIds: [],
    };
    const controller = yield* CloudAllocationController.make({
      enabled: true,
      region: "us-west-2",
      limits: {
        maxConcurrentWorkers: 1,
        maxQueueDepth: 8,
        maxRunSeconds: 7_200,
        maxInputWaitSeconds: 900,
        previewLeaseSeconds: 900,
        previewLeaseMaxSeconds: 3600,
        idleReleaseSeconds: 3_600,
        conversationRetentionDays: 30,
        allowedInstanceTypes: ["mac2-m2.metal"],
      },
      workerPriceAssumptions: [
        {
          instanceType: "mac2-m2.metal",
          hourlyUsd: 1.0832,
          region: "us-west-2",
          description: "EC2 Mac Dedicated Host hourly rate.",
        },
      ],
    });
    const provider = CloudWorkerProvider.of({
      runtimeKind: "ec2-fallback",
      resolveLaunchTemplate: () => Effect.succeed({ id: "lt-mac", version: 1 }),
      findAttemptResources: () =>
        Effect.sync(() => (state.instance === undefined ? [] : [state.instance])),
      listWorkers: () => Effect.succeed([]),
      inspectMacCapacity: () =>
        Effect.succeed({
          region: "us-west-2",
          instanceType: "mac2-m2.metal",
          appleSilicon: true,
          dedicatedHostQuota: { used: 0, limit: 2 },
          availableHostIds: [],
          availabilityZones: ["us-west-2a"],
        }),
      allocateDedicatedHost: () =>
        Effect.sync(() => {
          state.allocateCalls += 1;
          return { hostId: "h-mac" };
        }),
      releaseDedicatedHost: () =>
        Effect.fail(
          new CloudWorkerProviderError({
            reason: "fatal",
            message: "Host is within its 24-hour allocation minimum.",
          }),
        ),
      launch: (launchInput) =>
        Effect.sync(() => {
          state.launchHostIds.push(launchInput.placementHostId);
          state.instance = {
            instanceId: "i-mac",
            state: "running",
            identity: {
              status: "matched",
              allocationId: launchInput.allocationId,
              attempt: launchInput.attempt,
            },
            registrationCredentialPresent: true,
          };
          return { instanceId: "i-mac", state: "running" as const };
        }),
      revokeRegistrationCredential: () =>
        Effect.sync(() => {
          if (state.instance !== undefined) {
            state.instance = { ...state.instance, registrationCredentialPresent: false };
          }
        }),
      hibernate: () => Effect.void,
      restore: () => Effect.succeed({ instanceId: "i-mac", state: "running" as const }),
      terminate: () =>
        Effect.sync(() => {
          state.terminateCalls += 1;
        }),
    });
    const runtimes = CloudRuntimeProvider.of({
      readiness: () =>
        Effect.succeed({
          provider: "daytona",
          admission: "disabled",
          authentication: "missing",
          reachability: "unchecked",
          region: "us",
          resourceClass: "default",
          observedSandboxes: 0,
          readySandboxes: 0,
          detail: "Daytona admission is disabled.",
        }),
      create: () => Effect.die("unused"),
      inspect: () => Effect.succeed(undefined),
      list: () => Effect.succeed([]),
      start: () => Effect.die("unused"),
      stop: () => Effect.die("unused"),
      archive: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      execute: () => Effect.die("unused"),
      ensureProcess: () => Effect.die("unused"),
      inspectProcess: () => Effect.die("unused"),
      deleteProcess: () => Effect.die("unused"),
      preview: () => Effect.die("unused"),
      snapshot: () => Effect.die("unused"),
      desktop: () => Effect.die("unused"),
      resourceClass: "default",
    });
    const reconciler = yield* CloudAllocationReconciler.make().pipe(
      Effect.provideService(CloudAllocationController.CloudAllocationController, controller),
      Effect.provideService(
        CloudWorkerRegistration,
        CloudWorkerRegistration.of({
          issueCredential: () => Effect.succeed("registration-credential"),
          register: () => Effect.die("unused"),
        }),
      ),
      Effect.provideService(CloudWorkerProvider, provider),
      Effect.provideService(CloudRuntimeProvider, runtimes),
      Effect.provideService(
        CloudWorkerRunClient,
        CloudWorkerRunClient.of({
          start: () => Effect.void,
          status: () => Effect.succeed("succeeded" as const),
          flush: () =>
            Effect.succeed({
              userdata: { status: "flushed", detail: "ok" },
              workspace: { status: "flushed", detail: "ok" },
              providerHome: { status: "unavailable", reason: "runtime" },
              flushedAt: "2026-09-19T00:20:00.000Z",
            }),
          threadDetail: () => Effect.die("unused"),
          reopen: () => Effect.die("unused"),
          sessionEdits: () => Effect.die("unused"),
        }),
      ),
    );

    const allocation = yield* controller.dispatch(
      decodeCommand({
        type: "allocation.launch",
        commandId: "launch-ios-1",
        allocationId: "allocation-ios-1",
        attempt: 1,
        occurredAt: "2026-09-19T00:00:00.000Z",
        target: {
          repository: "acme/ios",
          baseCommit: "abc",
          branch: "cloud/ios-1",
        },
        profile: {
          id: "macos-ios",
          os: "darwin",
          arch: "arm64",
          device: "ios",
          instanceType: "mac2-m2.metal",
        },
        deadlines: {
          launchBy: "2026-09-19T00:05:00.000Z",
          bootBy: "2026-09-19T00:10:00.000Z",
          registerBy: "2026-09-19T00:15:00.000Z",
          expiresAt: "2026-09-19T02:00:00.000Z",
          cleanupBy: "2026-09-19T02:10:00.000Z",
        },
      }),
    );
    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.launch-started",
        commandId: "launch-started-ios-1",
        allocationId: allocation.id,
        attempt: allocation.attempt,
        occurredAt: "2026-09-19T00:00:00.000Z",
        launchTemplate: { id: "lt-mac", version: 1 },
      }),
    );

    yield* reconciler.reconcileOnce();

    const launched = (yield* controller.snapshot).allocations[0];
    expect(launched?.allocationState.status).toBe("booting");
    expect(launched?.placement).toMatchObject({
      warmFork: "cold",
      fallbackReason: "dedicated-host",
    });
    expect(state.allocateCalls).toBe(1);
    expect(state.launchHostIds).toEqual(["h-mac"]);

    yield* controller.dispatch(
      decodeCommand({
        type: "allocation.cancel",
        commandId: "cancel-ios-1",
        allocationId: "allocation-ios-1",
        attempt: 1,
        occurredAt: "2026-09-19T02:00:00.000Z",
      }),
    );
    yield* TestClock.setTime(Date.parse("2026-09-19T02:00:00.000Z"));
    yield* reconciler.reconcileOnce();
    yield* reconciler.reconcileOnce();

    const snapshot = yield* controller.snapshot;
    expect(snapshot.allocations[0]?.cleanupState.status).toBe("succeeded");
    expect(state.terminateCalls).toBe(0);
    expect(snapshot.macHosts?.[0]?.availability).not.toBe("released");
    expect(snapshot.macHosts?.[0]?.earliestReleaseAt).toBe("2026-09-20T00:00:00.000Z");
    const dedicatedHost = snapshot.usage[0]?.costs.dedicatedHost;
    const workerCompute = snapshot.usage[0]?.costs.workerCompute;
    expect(dedicatedHost?.status).toBe("estimated");
    expect(workerCompute?.status === "estimated" ? workerCompute.assumption : "").toContain(
      "Dedicated Host",
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
