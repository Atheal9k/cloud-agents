import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentVersionId,
  type CloudAllocationSnapshot,
  type CloudEnvironment,
  type CloudEnvironmentBuild,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import { make } from "./CloudReadiness.ts";
import * as CloudWorkerProvider from "./CloudWorkerProvider.ts";

const NOW = "2026-09-19T12:00:00.000Z";
const environmentId = CloudEnvironmentId.make("environment:primary");
const versionId = CloudEnvironmentVersionId.make("version:primary:1");
const buildId = CloudEnvironmentBuildId.make("build:primary:1");

const FIRECRACKER_FLEET = JSON.stringify([
  {
    id: "hypervisor-1",
    accountId: "222222222222",
    cpuMillis: 16000,
    memoryMib: 65536,
    diskGib: 400,
    cpuOversubscribeRatio: 2,
    profiles: ["linux-web"],
    credentialsPath: "/etc/t3/hypervisor-1.credentials.json",
    kvm: true,
  },
  {
    id: "hypervisor-2",
    accountId: "222222222222",
    cpuMillis: 16000,
    memoryMib: 65536,
    diskGib: 400,
    cpuOversubscribeRatio: 2,
    profiles: ["linux-web"],
    credentialsPath: "/etc/t3/hypervisor-2.credentials.json",
    kvm: false,
  },
]);

function processOutput(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  return {
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    code: ChildProcessSpawner.ExitCode(input.code ?? 0),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  } satisfies ProcessRunner.ProcessRunOutput;
}

function environment(): CloudEnvironment {
  return {
    id: environmentId,
    current: {
      id: versionId,
      environmentId,
      version: 1,
      name: "Primary",
      source: { type: "saved", scope: "personal", owner: "victor" },
      repositories: [{ repository: "t3tools/t3code", defaultRef: "main" }],
      config: { image: "ubuntu:24.04" },
      secretReferences: [],
      effectivePolicy: {
        runtimeUser: "ubuntu",
        egressMode: "allow_all",
        egressAllowlist: [],
        testingEnabled: false,
        disableAllMcpServers: false,
        mcpServerAllowlist: [],
        ports: [],
        secrets: [],
      },
      createdAt: NOW,
    },
    history: [
      {
        id: versionId,
        version: 1,
        name: "Primary",
        source: { type: "saved", scope: "personal", owner: "victor" },
        base: { kind: "image", image: "ubuntu:24.04" },
        createdAt: NOW,
      },
    ],
    activeBuildId: buildId,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function build(): CloudEnvironmentBuild {
  return {
    id: buildId,
    environmentId,
    versionId,
    version: 1,
    trigger: "manual",
    draft: false,
    base: { kind: "image", image: "ubuntu:24.04" },
    inputsFingerprint: "a".repeat(64),
    gitSetup: [],
    logs: [],
    timings: {},
    outcome: {
      status: "succeeded",
      snapshot: { id: "snapshot-1", digest: "b".repeat(64), sizeBytes: 1024, createdAt: NOW },
      completedAt: NOW,
    },
    startedAt: NOW,
    freshAt: NOW,
  };
}

function snapshot(): CloudAllocationSnapshot {
  return {
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
      allowedInstanceTypes: ["c7i.2xlarge"],
    },
    workerPriceAssumptions: [],
    spendingControl: "estimate-only",
    allocations: [],
    environments: [environment()],
    builds: [build()],
    usage: [],
  };
}

interface Harness {
  readonly env?: Record<string, string>;
  readonly aws?: (input: ProcessRunner.ProcessRunInput) => ProcessRunner.ProcessRunOutput;
  readonly listWorkers?: () => Effect.Effect<
    ReadonlyArray<CloudWorkerProvider.CloudWorkerResource>,
    CloudWorkerProvider.CloudWorkerProviderError
  >;
  readonly resolveLaunchTemplate?: (
    profileId: string,
  ) => Effect.Effect<
    { readonly id: string; readonly version: number },
    CloudWorkerProvider.CloudWorkerProviderError
  >;
}

const readiness = (harness: Harness = {}) =>
  Effect.gen(function* () {
    const invocations: Array<ReadonlyArray<string>> = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) => {
        invocations.push(input.args);
        return Effect.succeed(harness.aws?.(input) ?? processOutput({ stdout: "{}" }));
      },
    });
    const provider = {
      resolveLaunchTemplate:
        harness.resolveLaunchTemplate ??
        ((profileId: string) => Effect.succeed({ id: `lt-${profileId}`, version: 1 })),
      listWorkers: harness.listWorkers ?? (() => Effect.succeed([])),
    } as unknown as CloudWorkerProvider.CloudWorkerProvider["Service"];
    const controller = {
      snapshot: Effect.succeed(snapshot()),
    } as unknown as CloudAllocationController.CloudAllocationController["Service"];

    const service = yield* make({ enabled: true }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(CloudWorkerProvider.CloudWorkerProvider, provider),
      Effect.provideService(CloudAllocationController.CloudAllocationController, controller),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: harness.env ?? {} }))),
    );
    return { service, invocations };
  });

const TestConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cloud-readiness-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestConfigLayer)("CloudReadiness", (it) => {
  describe("check", () => {
    it.effect("runs only the requested check and leaves the rest unchecked", () =>
      Effect.gen(function* () {
        const { service, invocations } = yield* readiness({
          env: { T3CODE_CLOUD_HYPERVISOR_FLEET: FIRECRACKER_FLEET },
        });

        const report = yield* service.check({ checks: ["hypervisor-kvm"] });

        expect(report.checks.find((check) => check.id === "hypervisor-kvm")?.outcome).toMatchObject(
          {
            status: "failed",
            detail: "These hypervisors do not report KVM: hypervisor-2.",
          },
        );
        expect(
          report.checks.filter((check) => check.outcome.status === "unchecked").map((c) => c.id),
        ).toEqual([
          "execution-iam",
          "image-access",
          "snapshot-access",
          "artifact-storage",
          "guest-registration",
          "ssm-diagnostics",
        ]);
        // A fleet-only check must not spend an AWS call.
        expect(invocations).toEqual([]);
      }),
    );

    it.effect("keeps an earlier outcome when a later check is re-run", () =>
      Effect.gen(function* () {
        const { service } = yield* readiness({
          env: { T3CODE_CLOUD_HYPERVISOR_FLEET: FIRECRACKER_FLEET },
        });

        yield* service.check({ checks: ["hypervisor-kvm"] });
        const report = yield* service.check({ checks: ["artifact-storage"] });

        expect(report.checks.find((check) => check.id === "hypervisor-kvm")?.outcome.status).toBe(
          "failed",
        );
        expect(report.checks.find((check) => check.id === "artifact-storage")?.outcome.status).toBe(
          "passed",
        );
        expect(report.health.requiredChecksPassing).toBe(false);
      }),
    );

    it.effect("skips KVM on the EC2 fallback instead of failing it", () =>
      Effect.gen(function* () {
        const { service } = yield* readiness();

        const report = yield* service.check({ checks: ["hypervisor-kvm"] });

        expect(report.checks.find((check) => check.id === "hypervisor-kvm")?.outcome).toMatchObject(
          {
            status: "skipped",
          },
        );
        expect(report.health.requiredChecksPassing).toBe(true);
      }),
    );

    it.effect("fails the IAM check when the credentials belong to another account", () =>
      Effect.gen(function* () {
        const { service } = yield* readiness({
          env: { T3CODE_CLOUD_EXECUTION_ACCOUNT_ID: "222222222222" },
          aws: () =>
            processOutput({
              stdout: JSON.stringify({
                Account: "999999999999",
                Arn: "arn:aws:iam::999999999999:user/other",
              }),
            }),
        });

        const report = yield* service.check({ checks: ["execution-iam"] });

        expect(report.checks.find((check) => check.id === "execution-iam")?.outcome).toMatchObject({
          status: "failed",
          detail:
            "The controller's credentials belong to account 999999999999, not the configured execution account 222222222222.",
        });
        expect(report.accounts[1]?.observedAccountId).toBe("999999999999");
      }),
    );

    it.effect("passes the IAM check and records the account it observed", () =>
      Effect.gen(function* () {
        const { service } = yield* readiness({
          env: { T3CODE_CLOUD_EXECUTION_ACCOUNT_ID: "222222222222" },
          aws: () =>
            processOutput({
              stdout: JSON.stringify({
                Account: "222222222222",
                Arn: "arn:aws:iam::222222222222:role/controller",
              }),
            }),
        });

        const report = yield* service.check({ checks: ["execution-iam"] });

        expect(report.checks.find((check) => check.id === "execution-iam")?.outcome).toMatchObject({
          status: "passed",
          detail: "Authenticated as arn:aws:iam::222222222222:role/controller.",
        });
      }),
    );

    it.effect("reports the profile that could not resolve a launch template", () =>
      Effect.gen(function* () {
        const { service } = yield* readiness({
          env: { T3CODE_CLOUD_HYPERVISOR_FLEET: FIRECRACKER_FLEET },
          resolveLaunchTemplate: (profileId) =>
            Effect.fail(
              new CloudWorkerProvider.CloudWorkerProviderError({
                reason: "invalid-config",
                message: `No hypervisor advertises '${profileId}'.`,
              }),
            ),
        });

        const report = yield* service.check({ checks: ["image-access"] });

        expect(report.checks.find((check) => check.id === "image-access")?.outcome).toMatchObject({
          status: "failed",
          detail: "linux-web: No hypervisor advertises 'linux-web'.",
        });
      }),
    );

    it.effect("fails guest registration when a running guest lost its credential", () =>
      Effect.gen(function* () {
        const { service } = yield* readiness({
          listWorkers: () =>
            Effect.succeed([
              {
                instanceId: "i-running",
                state: "running",
                identity: { status: "unmatched" },
                registrationCredentialPresent: false,
              },
              {
                instanceId: "i-stopped",
                state: "stopped",
                identity: { status: "unmatched" },
                registrationCredentialPresent: false,
              },
            ]),
        });

        const report = yield* service.check({ checks: ["guest-registration"] });

        expect(
          report.checks.find((check) => check.id === "guest-registration")?.outcome,
        ).toMatchObject({
          status: "failed",
          detail: "1 running guest carry no registration credential: i-running.",
        });
      }),
    );

    it.effect("skips SSM diagnostics until a document is configured", () =>
      Effect.gen(function* () {
        const { service, invocations } = yield* readiness();

        const report = yield* service.check({ checks: ["ssm-diagnostics"] });

        expect(
          report.checks.find((check) => check.id === "ssm-diagnostics")?.outcome,
        ).toMatchObject({ status: "skipped" });
        expect(invocations).toEqual([]);
      }),
    );
  });

  describe("report", () => {
    it.effect("refuses to report when this environment does not host the controller", () =>
      Effect.gen(function* () {
        const runner = ProcessRunner.ProcessRunner.of({
          run: () => Effect.succeed(processOutput({})),
        });
        const service = yield* make({ enabled: false }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.provideService(
            CloudWorkerProvider.CloudWorkerProvider,
            {} as unknown as CloudWorkerProvider.CloudWorkerProvider["Service"],
          ),
          Effect.provideService(CloudAllocationController.CloudAllocationController, {
            snapshot: Effect.succeed(snapshot()),
          } as unknown as CloudAllocationController.CloudAllocationController["Service"]),
        );

        const failure = yield* service.report.pipe(Effect.flip);

        expect(failure.reason).toBe("controller-disabled");
      }),
    );
  });
});
