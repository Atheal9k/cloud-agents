/**
 * Job-scoped iOS Simulator reservation, build, install, and launch. The
 * commands target one UDID and never require device distribution signing.
 */
import {
  detectIosBuildWorkflow,
  iosSimulatorArtifactRequests,
  iosSimulatorDeviceName,
  iosSimulatorSigningSettings,
  type IosBuildWorkflow,
  type IosSimulatorJob,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

export class IosSimulatorJobError extends Schema.TaggedError<IosSimulatorJobError>()(
  "IosSimulatorJobError",
  {
    stage: Schema.Literals(["reserve", "boot", "build", "install", "launch", "cleanup"]),
    message: Schema.String,
  },
) {}

export function parseSimctlDeviceList(
  stdout: string,
  deviceName: string,
): { readonly udid: string; readonly state: string; readonly runtime: string } | undefined {
  let runtime = "unknown";
  try {
    const parsed = JSON.parse(stdout) as {
      readonly devices?: Record<
        string,
        ReadonlyArray<{
          readonly udid?: string;
          readonly name?: string;
          readonly state?: string;
          readonly isAvailable?: boolean;
        }>
      >;
    };
    for (const [runtimeKey, devices] of Object.entries(parsed.devices ?? {})) {
      const match = devices.find((device) => device.name === deviceName);
      if (match?.udid !== undefined) {
        return {
          udid: match.udid,
          state: match.state ?? "Shutdown",
          runtime: runtimeKey,
        };
      }
      runtime = runtimeKey;
    }
  } catch {
    return undefined;
  }
  return runtime === "unknown" ? undefined : undefined;
}

export function xcodebuildSimulatorArguments(input: {
  readonly workspaceOrProject: string;
  readonly scheme: string;
  readonly udid: string;
  readonly derivedDataPath: string;
  readonly resultBundlePath: string;
}): ReadonlyArray<string> {
  const projectFlag = input.workspaceOrProject.endsWith(".xcworkspace") ? "-workspace" : "-project";
  return [
    "xcodebuild",
    projectFlag,
    input.workspaceOrProject,
    "-scheme",
    input.scheme,
    "-destination",
    `id=${input.udid}`,
    "-derivedDataPath",
    input.derivedDataPath,
    "-resultBundlePath",
    input.resultBundlePath,
    "-configuration",
    "Debug",
    "ARCHS=arm64",
    "ONLY_ACTIVE_ARCH=YES",
    ...iosSimulatorSigningSettings(),
    "build",
  ];
}

export function iosJobCleanupTargets(input: {
  readonly udid: string;
  readonly checkoutPath: string;
}): ReadonlyArray<string> {
  return [
    `simctl shutdown ${input.udid}`,
    `simctl delete ${input.udid}`,
    `rm -rf ${input.checkoutPath}/DerivedData`,
  ];
}

export const planIosSimulatorJob = (input: {
  readonly allocationId: string;
  readonly attempt: number;
  readonly checkoutPath: string;
  readonly artifactDirectory: string;
  readonly paths: ReadonlyArray<string>;
  readonly runtime: string;
}): Omit<IosSimulatorJob, "udid"> & { readonly udid?: string } => {
  const workflow: IosBuildWorkflow = detectIosBuildWorkflow(input.paths);
  return {
    allocationId: input.allocationId as IosSimulatorJob["allocationId"],
    attempt: input.attempt as IosSimulatorJob["attempt"],
    deviceName: iosSimulatorDeviceName(input),
    runtime: input.runtime,
    architecture: "arm64",
    workflow,
    state: "reserving",
    checkoutPath: input.checkoutPath,
    artifactDirectory: input.artifactDirectory,
  };
};

export const runSimctl = Effect.fn("iosSimulatorJob.runSimctl")(function* (
  args: ReadonlyArray<string>,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({
    command: "xcrun",
    args: ["simctl", ...args],
    timeout: "120 seconds",
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (result.code !== 0) {
    return yield* new IosSimulatorJobError({
      stage: args[0] === "create" ? "reserve" : args[0] === "boot" ? "boot" : "cleanup",
      message: result.stderr.trim() || `simctl ${args[0] ?? "command"} failed.`,
    });
  }
  return result.stdout;
});

export { iosSimulatorArtifactRequests, iosSimulatorSigningSettings };
