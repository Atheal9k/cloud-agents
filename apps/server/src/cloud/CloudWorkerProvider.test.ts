import { RunAllocationAttempt, RunAllocationId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { make } from "./CloudWorkerProvider.ts";

const allocationId = Schema.decodeSync(RunAllocationId)("allocation-1");
const attempt = Schema.decodeSync(RunAllocationAttempt)(1);

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
      expiresAt: "2026-09-17T05:00:00.000Z",
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
        expiresAt: "2026-09-17T05:00:00.000Z",
        launchTemplate: { id: "lt-worker", version: 7 },
        registrationCredential: "registration-credential",
      })
      .pipe(Effect.flip);

    expect(error.reason).toBe("retryable");
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
        expiresAt: "2026-09-17T05:00:00.000Z",
        launchTemplate: { id: "lt-worker", version: 7 },
        registrationCredential: "registration-credential",
      })
      .pipe(Effect.flip);

    expect(error.reason).toBe("invalid-config");
  }),
);
