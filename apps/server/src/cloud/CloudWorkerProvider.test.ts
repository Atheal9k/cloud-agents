import { RunAllocationAttempt, RunAllocationId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { make } from "./CloudWorkerProvider.ts";

const allocationId = Schema.decodeSync(RunAllocationId)("allocation-1");
const attempt = Schema.decodeSync(RunAllocationAttempt)(1);
const secondAttempt = Schema.decodeSync(RunAllocationAttempt)(2);
const secondAllocationId = Schema.decodeSync(RunAllocationId)("allocation-2");

function output(input: {
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

it.effect("pins the discovered template and reuses one AWS client token", () =>
  Effect.gen(function* () {
    const invocations: ProcessRunner.ProcessRunInput[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) => {
        invocations.push(input);
        const operation = input.args[1];
        if (operation === "describe-launch-templates") {
          return Effect.succeed(
            output({
              stdout: JSON.stringify({
                LaunchTemplates: [{ LaunchTemplateId: "lt-worker", DefaultVersionNumber: 7 }],
              }),
            }),
          );
        }
        return Effect.succeed(
          output({
            stdout: JSON.stringify({
              Instances: [{ InstanceId: "i-worker", State: { Name: "pending" } }],
            }),
          }),
        );
      },
    });
    const provider = yield* make({
      region: "us-west-1",
      project: "t3-cloud-agents",
      controllerUrl: "https://controller.example.test/",
      workerRouteUrl: "https://worker.example.test/",
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));
    const launchTemplate = yield* provider.resolveLaunchTemplate("linux-web");
    const launchInput = {
      allocationId,
      attempt,
      repository: "t3tools/t3code",
      selectedRef: "main",
      outputBranch: "cloud/allocation-1",
      expiresAt: "2026-09-17T05:00:00.000Z",
      instanceType: "t3.medium",
      maxInputWaitSeconds: 900,
      launchTemplate,
      registrationCredential: "registration-credential",
    };

    yield* provider.launch(launchInput);
    yield* provider.launch(launchInput);

    expect(launchTemplate).toEqual({ id: "lt-worker", version: 7 });
    const launches = invocations.filter((invocation) => invocation.args[1] === "run-instances");
    const tokens = launches.map((invocation) => {
      const index = invocation.args.indexOf("--client-token");
      return invocation.args[index + 1];
    });
    expect(tokens[0]).toMatch(/^t3-[0-9a-f]{61}$/);
    expect(tokens[1]).toBe(tokens[0]);
    expect(launches[0]?.args.join(" ")).toContain("CloudAgentAllocationId");
    expect(launches[0]?.args.join(" ")).toContain("CloudAgentExpiresAtEpoch");
    expect(launches[0]?.args.join(" ")).toContain("CloudAgentRegistrationCredential");
    expect(launches[0]?.args.join(" ")).toContain("CloudAgentMaxInputWaitSeconds");
    expect(launches[0]?.args.join(" ")).toContain("CloudAgentRepository");
    expect(launches[0]?.args.join(" ")).toContain("t3tools/t3code");
    expect(launches[0]?.args.join(" ")).toContain("CloudAgentSelectedRef");
    expect(launches[0]?.args.join(" ")).toContain("CloudAgentOutputBranch");
    expect(launches[0]?.args).toContain("--instance-type");
    expect(launches[0]?.args).toContain("t3.medium");
    expect(launches[0]?.args.join(" ")).toContain("ec2-fallback");
    expect(launches[0]?.args.join(" ")).toContain("ec2-migration-fallback");
    expect(launches[0]?.args.join(" ")).not.toContain("cursor-firecracker");
  }),
);

it.effect("classifies AWS capacity failures as retryable", () =>
  Effect.gen(function* () {
    const runner = ProcessRunner.ProcessRunner.of({
      run: () =>
        Effect.succeed(
          output({
            code: 255,
            stderr: "An error occurred (InsufficientInstanceCapacity) when calling RunInstances",
          }),
        ),
    });
    const provider = yield* make({
      region: "us-west-1",
      project: "t3-cloud-agents",
      controllerUrl: "https://controller.example.test/",
      workerRouteUrl: "https://worker.example.test/",
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));
    const error = yield* provider
      .launch({
        allocationId,
        attempt,
        repository: "t3tools/t3code",
        selectedRef: "main",
        outputBranch: "cloud/allocation-1",
        expiresAt: "2026-09-17T05:00:00.000Z",
        instanceType: "t3.medium",
        maxInputWaitSeconds: 900,
        launchTemplate: { id: "lt-worker", version: 7 },
        registrationCredential: "registration-credential",
      })
      .pipe(Effect.flip);

    expect(error.reason).toBe("retryable");
  }),
);

it.effect("resolves a stable, attempt-specific worker route", () =>
  Effect.gen(function* () {
    const invocations: ProcessRunner.ProcessRunInput[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) => {
        invocations.push(input);
        return Effect.succeed(
          output({
            stdout: JSON.stringify({
              Instances: [{ InstanceId: "i-worker", State: { Name: "pending" } }],
            }),
          }),
        );
      },
    });
    const provider = yield* make({
      region: "us-west-1",
      project: "t3-cloud-agents",
      controllerUrl: "https://controller.example.test/",
      workerRouteUrl: "https://{workerHostname}.tailnet.example.test/",
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));
    const launchInput = {
      allocationId,
      attempt,
      repository: "t3tools/t3code",
      selectedRef: "main",
      outputBranch: "cloud/allocation-1",
      expiresAt: "2026-09-17T05:00:00.000Z",
      instanceType: "t3.medium",
      maxInputWaitSeconds: 900,
      launchTemplate: { id: "lt-worker", version: 7 },
      registrationCredential: "registration-credential",
    };

    yield* provider.launch(launchInput);
    yield* provider.launch({ ...launchInput, attempt: secondAttempt });

    const routes = invocations.map(
      (invocation) =>
        invocation.args
          .join(" ")
          .match(/https:\/\/t3-worker-[0-9a-f]{16}\.tailnet\.example\.test\//)?.[0],
    );
    expect(routes[0]).toMatch(/^https:\/\/t3-worker-[0-9a-f]{16}\.tailnet\.example\.test\/$/);
    expect(routes[1]).toMatch(/^https:\/\/t3-worker-[0-9a-f]{16}\.tailnet\.example\.test\/$/);
    expect(routes[1]).not.toBe(routes[0]);
    expect(invocations[0]?.args.join(" ")).not.toContain("{workerHostname}");
  }),
);

it.effect("rejects controller-local routing before launching a worker", () =>
  Effect.gen(function* () {
    const runner = ProcessRunner.ProcessRunner.of({
      run: () => Effect.die("AWS must not be called for invalid routing"),
    });
    const provider = yield* make({
      region: "us-west-1",
      project: "t3-cloud-agents",
      controllerUrl: "https://localhost:3773/",
      workerRouteUrl: "https://worker.example.test/",
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));

    const error = yield* provider
      .launch({
        allocationId,
        attempt,
        repository: "t3tools/t3code",
        selectedRef: "main",
        outputBranch: "cloud/allocation-1",
        expiresAt: "2026-09-17T05:00:00.000Z",
        instanceType: "t3.medium",
        maxInputWaitSeconds: 900,
        launchTemplate: { id: "lt-worker", version: 7 },
        registrationCredential: "registration-credential",
      })
      .pipe(Effect.flip);

    expect(error.reason).toBe("invalid-config");
  }),
);

it.effect("lists attempt identities and revokes only the registration credential tag", () =>
  Effect.gen(function* () {
    const invocations: ProcessRunner.ProcessRunInput[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) => {
        invocations.push(input);
        if (input.args[1] === "describe-instances") {
          return Effect.succeed(
            output({
              stdout: JSON.stringify({
                Reservations: [
                  {
                    Instances: [
                      {
                        InstanceId: "i-matched",
                        State: { Name: "running" },
                        Tags: [
                          { Key: "CloudAgentAllocationId", Value: "allocation-1" },
                          { Key: "CloudAgentAttempt", Value: "1" },
                          {
                            Key: "CloudAgentRegistrationCredential",
                            Value: "must-not-escape",
                          },
                        ],
                      },
                      {
                        InstanceId: "i-unmatched",
                        State: { Name: "pending" },
                        Tags: [{ Key: "CloudAgentAttempt", Value: "invalid" }],
                      },
                    ],
                  },
                ],
              }),
            }),
          );
        }
        return Effect.succeed(output({ stdout: "{}" }));
      },
    });
    const provider = yield* make({
      region: "us-west-1",
      project: "t3-cloud-agents",
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));

    const resources = yield* provider.listWorkers();
    yield* provider.revokeRegistrationCredential("i-matched");

    expect(resources).toEqual([
      {
        instanceId: "i-matched",
        state: "running",
        identity: { status: "matched", allocationId: "allocation-1", attempt: 1 },
        registrationCredentialPresent: true,
      },
      {
        instanceId: "i-unmatched",
        state: "pending",
        identity: { status: "unmatched" },
        registrationCredentialPresent: false,
      },
    ]);
    const revoke = invocations.find((invocation) => invocation.args[1] === "delete-tags");
    expect(revoke?.args).toContain("i-matched");
    expect(revoke?.args).toContain("Key=CloudAgentRegistrationCredential");
    expect(revoke?.args.join(" ")).not.toContain("must-not-escape");
  }),
);

const hypervisor = {
  id: "hv-1",
  accountId: "999999999999",
  cpuMillis: 16_000,
  memoryMib: 65_536,
  diskGib: 1_024,
  cpuOversubscribeRatio: 2,
  profiles: ["linux-web"],
  credentialsPath: "/var/lib/t3-hypervisor/hv-1/credentials",
  kvm: true,
} as const;

it.effect("places a Mac guest on a Dedicated Host and inspects Apple Silicon capacity", () =>
  Effect.gen(function* () {
    const invocations: ProcessRunner.ProcessRunInput[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) => {
        invocations.push(input);
        const operation = input.args[1];
        if (operation === "describe-instance-type-offerings") {
          return Effect.succeed(
            output({
              stdout: JSON.stringify({
                InstanceTypeOfferings: [{ InstanceType: "mac2-m2.metal", Location: "us-west-2a" }],
              }),
            }),
          );
        }
        if (operation === "describe-hosts") {
          return Effect.succeed(output({ stdout: JSON.stringify({ Hosts: [] }) }));
        }
        if (operation === "allocate-hosts") {
          return Effect.succeed(output({ stdout: JSON.stringify({ HostIds: ["h-mac"] }) }));
        }
        if (operation === "describe-launch-templates") {
          return Effect.succeed(
            output({
              stdout: JSON.stringify({
                LaunchTemplates: [{ LaunchTemplateId: "lt-mac", DefaultVersionNumber: 1 }],
              }),
            }),
          );
        }
        return Effect.succeed(
          output({
            stdout: JSON.stringify({
              Instances: [{ InstanceId: "i-mac", State: { Name: "pending" } }],
            }),
          }),
        );
      },
    });
    const provider = yield* make({
      region: "us-west-2",
      project: "t3-cloud-agents",
      controllerUrl: "https://controller.example.test/",
      workerRouteUrl: "https://worker.example.test/",
      runtimeKind: "firecracker",
      hypervisors: [hypervisor],
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));

    const capacity = yield* provider.inspectMacCapacity({ instanceType: "mac2-m2.metal" });
    const host = yield* provider.allocateDedicatedHost({
      instanceType: "mac2-m2.metal",
      availabilityZone: "us-west-2a",
    });
    const launchTemplate = yield* provider.resolveLaunchTemplate("macos-ios");
    yield* provider.launch({
      allocationId,
      attempt,
      repository: "acme/ios",
      selectedRef: "main",
      outputBranch: "cloud/allocation-1",
      expiresAt: "2026-09-17T05:00:00.000Z",
      instanceType: "mac2-m2.metal",
      maxInputWaitSeconds: 900,
      launchTemplate,
      registrationCredential: "registration-credential",
      placementHostId: host.hostId,
    });

    expect(capacity).toMatchObject({
      region: "us-west-2",
      appleSilicon: true,
      availabilityZones: ["us-west-2a"],
    });
    expect(host).toEqual({ hostId: "h-mac" });
    const launch = invocations.find((invocation) => invocation.args[1] === "run-instances");
    expect(launch?.args.join(" ")).toContain("Tenancy=host,HostId=h-mac");
    expect(launch?.args.join(" ")).toContain("CloudAgentDedicatedHost");
    expect(launch?.args.join(" ")).toContain("CloudAgentRuntimeKind");
  }),
);

it.effect("places Firecracker guests without calling RunInstances", () =>
  Effect.gen(function* () {
    const runner = ProcessRunner.ProcessRunner.of({
      run: () => Effect.die("AWS must not launch per-thread instances on the Firecracker path"),
    });
    const provider = yield* make({
      region: "us-west-1",
      project: "t3-cloud-agents",
      controllerUrl: "https://controller.example.test/",
      workerRouteUrl: "https://worker.example.test/",
      runtimeKind: "firecracker",
      hypervisors: [hypervisor],
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));
    const launchTemplate = yield* provider.resolveLaunchTemplate("linux-web");
    const first = yield* provider.launch({
      allocationId,
      attempt,
      repository: "t3tools/t3code",
      selectedRef: "main",
      outputBranch: "cloud/allocation-1",
      expiresAt: "2026-09-17T05:00:00.000Z",
      instanceType: "t3.medium",
      maxInputWaitSeconds: 900,
      launchTemplate,
      registrationCredential: "registration-credential",
    });
    const second = yield* provider.launch({
      allocationId: secondAllocationId,
      attempt,
      repository: "t3tools/t3code",
      selectedRef: "main",
      outputBranch: "cloud/allocation-2",
      expiresAt: "2026-09-17T05:00:00.000Z",
      instanceType: "t3.medium",
      maxInputWaitSeconds: 900,
      launchTemplate,
      registrationCredential: "registration-credential",
    });

    expect(provider.runtimeKind).toBe("firecracker");
    expect(launchTemplate.id).toBe("fc-linux-web");
    expect(first.runtimeKind).toBe("firecracker");
    expect(first.instanceId).toMatch(/^fc:/);
    expect(second.instanceId).not.toBe(first.instanceId);
    const found = yield* provider.findAttemptResources({ allocationId, attempt });
    expect(found).toHaveLength(1);
    expect(found[0]?.instanceId).toBe(first.instanceId);
    yield* provider.hibernate(first.instanceId);
    const hibernated = yield* provider.findAttemptResources({ allocationId, attempt });
    expect(hibernated[0]?.state).toBe("stopped");
    const restored = yield* provider.restore({
      instanceId: first.instanceId,
      allocationId,
      attempt: secondAttempt,
      selectedRef: "main",
      outputBranch: "cloud/allocation-1",
      expiresAt: "2026-09-18T05:00:00.000Z",
      maxInputWaitSeconds: 900,
      registrationCredential: "next-credential",
    });
    expect(restored.instanceId).toBe(first.instanceId);
    expect(restored.runtimeKind).toBe("firecracker");
  }),
);

it.effect("enables nested virtualization when launching an Android emulator worker", () =>
  Effect.gen(function* () {
    const invocations: ProcessRunner.ProcessRunInput[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) => {
        invocations.push(input);
        return Effect.succeed(
          output({
            stdout: JSON.stringify({
              Instances: [{ InstanceId: "i-android", State: { Name: "pending" } }],
            }),
          }),
        );
      },
    });
    const provider = yield* make({
      region: "us-west-1",
      project: "t3-cloud-agents",
      controllerUrl: "https://controller.example.test/",
      workerRouteUrl: "https://worker.example.test/",
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));

    yield* provider.launch({
      allocationId,
      attempt,
      repository: "acme/android",
      selectedRef: "main",
      outputBranch: "cloud/allocation-1",
      expiresAt: "2026-09-17T05:00:00.000Z",
      instanceType: "m7i.xlarge",
      maxInputWaitSeconds: 900,
      launchTemplate: { id: "lt-android", version: 1 },
      registrationCredential: "registration-credential",
      nestedVirtualization: true,
    });

    const launch = invocations.find((invocation) => invocation.args[1] === "run-instances");
    expect(launch?.args).toContain("--cpu-options");
    expect(launch?.args).toContain("NestedVirtualization=enabled");
    expect(launch?.args.join(" ")).toContain("CloudAgentNestedVirtualization");
    expect(launch?.args).toContain("m7i.xlarge");
  }),
);
