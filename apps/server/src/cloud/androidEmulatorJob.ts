/**
 * Job-scoped Android emulator reservation, debug build, install, and launch.
 * Agent commands target one ADB serial. ADB and gRPC stay on loopback.
 */
import {
  androidAvdName,
  androidControlEndpoints,
  androidEmulatorArtifactRequests,
  androidEmulatorSerial,
  androidJobDataDirectory,
  androidJobPorts,
  androidMetroEndpoint,
  detectAndroidBuildWorkflow,
  expoGoIsInsufficientNativeProof,
  type AndroidBuildWorkflow,
  type AndroidEmulatorJob,
} from "@t3tools/contracts";

export function planAndroidEmulatorJob(input: {
  readonly allocationId: string;
  readonly attempt: number;
  readonly checkoutPath: string;
  readonly artifactDirectory: string;
  readonly paths: ReadonlyArray<string>;
  readonly abi: string;
  readonly apiLevel: number;
}): Omit<AndroidEmulatorJob, "allocationId" | "attempt"> & {
  readonly allocationId: string;
  readonly attempt: number;
} {
  const ports = androidJobPorts(input.attempt);
  const workflow: AndroidBuildWorkflow = detectAndroidBuildWorkflow(input.paths);
  const dataDirectory = androidJobDataDirectory(input);
  return {
    allocationId: input.allocationId,
    attempt: input.attempt,
    avdName: androidAvdName(input),
    serial: androidEmulatorSerial(ports.consolePort),
    consolePort: ports.consolePort,
    adbPort: ports.adbPort,
    abi: input.abi,
    apiLevel: input.apiLevel,
    workflow,
    state: "reserving",
    dataDirectory,
    artifactDirectory: input.artifactDirectory,
    checkoutPath: input.checkoutPath,
  };
}

export function emulatorLaunchArguments(input: {
  readonly avdName: string;
  readonly dataDirectory: string;
  readonly consolePort: number;
  readonly adbPort: number;
}): ReadonlyArray<string> {
  return [
    "-avd",
    input.avdName,
    "-port",
    String(input.consolePort),
    "-grpc",
    "0",
    "-no-metrics",
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-accel",
    "on",
    "-gpu",
    "swiftshader_indirect",
    "-writable-system",
    "-sysdir",
    input.dataDirectory,
    "-datadir",
    input.dataDirectory,
    "-no-listen-tcp",
  ];
}

export function adbSerialArguments(serial: string): ReadonlyArray<string> {
  return ["-s", serial];
}

export function gradleDebugBuildArguments(input: { readonly abi: string }): ReadonlyArray<string> {
  return [
    "./gradlew",
    ":app:assembleDebug",
    `-PreactNativeArchitectures=${input.abi}`,
    "--console=plain",
  ];
}

export function expoNativeRebuildRequired(input: {
  readonly nativeFingerprintChanged: boolean;
  readonly installedPackage: string | undefined;
}): boolean {
  if (input.nativeFingerprintChanged) return true;
  return input.installedPackage === "host.exp.exponent";
}

export function androidJobCleanupTargets(input: {
  readonly serial: string;
  readonly dataDirectory: string;
  readonly ownedPids: ReadonlyArray<number>;
}): {
  readonly serial: string;
  readonly dataDirectory: string;
  readonly pids: ReadonlyArray<number>;
  readonly publicEndpoints: false;
} {
  return {
    serial: input.serial,
    dataDirectory: input.dataDirectory,
    pids: input.ownedPids,
    publicEndpoints: false,
  };
}

export function crashLeavesActionableResult(input: {
  readonly state: AndroidEmulatorJob["state"];
  readonly diagnosticsPath: string;
}): { readonly result: "failed"; readonly unboundedHost: false; readonly diagnosticsPath: string } {
  return {
    result: "failed",
    unboundedHost: false,
    diagnosticsPath: input.diagnosticsPath,
  };
}

export {
  androidControlEndpoints,
  androidEmulatorArtifactRequests,
  androidMetroEndpoint,
  expoGoIsInsufficientNativeProof,
};
