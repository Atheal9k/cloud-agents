import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CloudAllocationSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import { make } from "./CloudReadiness.ts";
import {
  CloudRuntimeProvider,
  type CloudRuntimeProviderReadiness,
} from "./CloudRuntimeProvider.ts";
import * as CloudWorkerProvider from "./CloudWorkerProvider.ts";

const snapshot = (): CloudAllocationSnapshot => ({
  controller: {
    mode: "permanent",
    requiresHostOnline: false,
    admission: { status: "open" },
    writability: { status: "writable" },
    defaults: {},
  },
  limits: {
    maxConcurrentWorkers: 4,
    maxQueueDepth: 8,
    maxRunSeconds: 3600,
    maxInputWaitSeconds: 900,
    previewLeaseSeconds: 60,
    previewLeaseMaxSeconds: 240,
    idleReleaseSeconds: 300,
    conversationRetentionDays: 30,
    allowedInstanceTypes: ["daytona:small"],
  },
  workerPriceAssumptions: [],
  spendingControl: "estimate-only",
  allocations: [],
  environments: [],
  builds: [],
  usage: [],
});

const readyProvider: CloudRuntimeProviderReadiness = {
  provider: "daytona",
  admission: "enabled",
  authentication: "configured",
  reachability: "reachable",
  region: "us",
  resourceClass: "small",
  observedSandboxes: 3,
  readySandboxes: 2,
  detail: "Daytona is ready.",
};

function runtimeProvider(readiness: CloudRuntimeProviderReadiness) {
  return CloudRuntimeProvider.of({
    readiness: () => Effect.succeed(readiness),
    create: () => Effect.die("unused"),
    inspect: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
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
    resourceClass: readiness.resourceClass,
  });
}

const service = (readiness: CloudRuntimeProviderReadiness, enabled = true) =>
  Effect.gen(function* () {
    const controller = {
      snapshot: Effect.succeed(snapshot()),
    } as unknown as CloudAllocationController.CloudAllocationController["Service"];
    const workers = {
      resolveLaunchTemplate: () => Effect.die("unused"),
      listWorkers: () => Effect.die("unused"),
    } as unknown as CloudWorkerProvider.CloudWorkerProvider["Service"];
    const runner = ProcessRunner.ProcessRunner.of({ run: () => Effect.die("unused") });
    return yield* make({ enabled }).pipe(
      Effect.provideService(CloudAllocationController.CloudAllocationController, controller),
      Effect.provideService(CloudRuntimeProvider, runtimeProvider(readiness)),
      Effect.provideService(CloudWorkerProvider.CloudWorkerProvider, workers),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    );
  });

const TestConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cloud-readiness-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestConfigLayer)("CloudReadiness", (it) => {
  describe("report", () => {
    it.effect("reports Daytona auth, API, limits, and observed sandbox readiness", () =>
      Effect.gen(function* () {
        const report = yield* (yield* service(readyProvider)).report;

        expect(report.managedProvider).toEqual({
          provider: "daytona",
          admission: "enabled",
          authentication: "configured",
          reachability: "reachable",
          region: "us",
          resourceClass: "small",
          maxConcurrentWorkers: 4,
          observedSandboxes: 3,
          readySandboxes: 2,
          detail: "Daytona is ready.",
        });
        expect(report.checks.map((check) => check.id)).toEqual([
          "daytona-authentication",
          "daytona-api",
          "daytona-capacity",
          "daytona-sandbox-readiness",
        ]);
      }),
    );

    it.effect("refuses to report when this environment does not host the controller", () =>
      Effect.gen(function* () {
        const failure = yield* (yield* service(readyProvider, false)).report.pipe(Effect.flip);
        expect(failure.reason).toBe("controller-disabled");
      }),
    );
  });

  describe("check", () => {
    it.effect("runs only the requested check and retains earlier outcomes", () =>
      Effect.gen(function* () {
        const cloudReadiness = yield* service(readyProvider);
        const auth = yield* cloudReadiness.check({ checks: ["daytona-authentication"] });
        expect(
          auth.checks.find((check) => check.id === "daytona-authentication")?.outcome.status,
        ).toBe("passed");
        expect(auth.checks.find((check) => check.id === "daytona-api")?.outcome.status).toBe(
          "unchecked",
        );

        const api = yield* cloudReadiness.check({ checks: ["daytona-api"] });
        expect(
          api.checks.find((check) => check.id === "daytona-authentication")?.outcome.status,
        ).toBe("passed");
        expect(api.checks.find((check) => check.id === "daytona-api")?.outcome.status).toBe(
          "passed",
        );
      }),
    );

    it.effect("fails authentication immediately when the controller key is missing", () =>
      Effect.gen(function* () {
        const cloudReadiness = yield* service({
          ...readyProvider,
          authentication: "missing",
          reachability: "unchecked",
          detail: "DAYTONA_API_KEY is not configured.",
        });
        const report = yield* cloudReadiness.check({ checks: ["daytona-authentication"] });
        expect(
          report.checks.find((check) => check.id === "daytona-authentication")?.outcome,
        ).toMatchObject({
          status: "failed",
          detail: "DAYTONA_API_KEY is not configured.",
        });
        expect(report.health.requiredChecksPassing).toBe(false);
      }),
    );
  });
});
