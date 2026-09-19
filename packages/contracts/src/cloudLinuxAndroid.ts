import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  RunAllocationAttempt,
  RunAllocationId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { type CloudEnvironmentConfig } from "./cloudEnvironment.ts";

type LinuxAndroidWorkerProfile = {
  readonly id: string;
  readonly os: string;
  readonly arch: string;
  readonly device?: "android" | "ios" | undefined;
  readonly instanceType?: string | undefined;
};

export type LinuxAndroidRunWorkerProfile = {
  readonly id: typeof LINUX_ANDROID_WORKER_PROFILE_ID;
  readonly os: "linux";
  readonly arch: "x64";
  readonly device: "android";
  readonly instanceType: string;
};

type FlushComponent =
  | { readonly status: "flushed"; readonly detail: string }
  | { readonly status: "unavailable"; readonly reason: string };

type Resumption =
  | { readonly status: "resumed"; readonly detail: string }
  | { readonly status: "not-resumed"; readonly reason: string };

export const LINUX_ANDROID_WORKER_PROFILE_ID = "linux-android";

/**
 * 7th-generation-and-later Intel/AMD families that AWS documents for nested
 * virtualization. t3 and earlier Nitro types are not admitted.
 */
export const ANDROID_NESTED_VIRTUALIZATION_FAMILIES = [
  "c7a",
  "c7i",
  "c7i-flex",
  "c8a",
  "c8i",
  "c8i-flex",
  "m7a",
  "m7i",
  "m7i-flex",
  "m8a",
  "m8i",
  "m8i-flex",
  "r7a",
  "r7i",
  "r7i-flex",
  "r8a",
  "r8i",
  "r8i-flex",
] as const;

/** Sizes with enough memory for the emulator plus a debug Gradle/Expo build. */
const ANDROID_MINIMUM_SIZES = new Set([
  "xlarge",
  "2xlarge",
  "4xlarge",
  "8xlarge",
  "12xlarge",
  "16xlarge",
  "24xlarge",
  "32xlarge",
  "48xlarge",
  "metal",
  "metal-48xl",
]);

export const AndroidEmulatorJobState = Schema.Literals([
  "reserving",
  "booting",
  "building",
  "installing",
  "launching",
  "ready",
  "failed",
  "cleaned",
]);
export type AndroidEmulatorJobState = typeof AndroidEmulatorJobState.Type;

export const AndroidBuildWorkflow = Schema.Literals(["gradle", "expo", "unknown"]);
export type AndroidBuildWorkflow = typeof AndroidBuildWorkflow.Type;

export const AndroidSdkSelection = Schema.Struct({
  apiLevel: NonNegativeInt,
  abi: TrimmedNonEmptyString,
  buildTools: TrimmedNonEmptyString,
  systemImage: TrimmedNonEmptyString,
});
export type AndroidSdkSelection = typeof AndroidSdkSelection.Type;

export const AndroidPlacementInspection = Schema.Struct({
  region: TrimmedNonEmptyString,
  instanceType: TrimmedNonEmptyString,
  availabilityZones: Schema.Array(TrimmedNonEmptyString),
});
export type AndroidPlacementInspection = typeof AndroidPlacementInspection.Type;

export const AndroidHostProbe = Schema.Struct({
  nestedVirtualization: Schema.Boolean,
  kvm: Schema.Boolean,
  emulatorAcceleration: Schema.Literals(["kvm", "none"]),
});
export type AndroidHostProbe = typeof AndroidHostProbe.Type;

export const AndroidEmulatorJob = Schema.Struct({
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  avdName: TrimmedNonEmptyString,
  serial: TrimmedNonEmptyString,
  consolePort: NonNegativeInt,
  adbPort: NonNegativeInt,
  abi: TrimmedNonEmptyString,
  apiLevel: NonNegativeInt,
  workflow: AndroidBuildWorkflow,
  state: AndroidEmulatorJobState,
  dataDirectory: TrimmedNonEmptyString,
  artifactDirectory: TrimmedNonEmptyString,
  checkoutPath: TrimmedNonEmptyString,
});
export type AndroidEmulatorJob = typeof AndroidEmulatorJob.Type;

export type LinuxAndroidAdmissionFailure = {
  readonly status: "rejected";
  readonly message: string;
};

export type LinuxAndroidAdmissionSuccess = {
  readonly status: "accepted";
  readonly profile: LinuxAndroidWorkerProfile;
  readonly nestedVirtualizationLaunch: boolean;
};

export function androidInstanceFamily(instanceType: string): string {
  const separator = instanceType.lastIndexOf(".");
  return separator === -1 ? instanceType : instanceType.slice(0, separator);
}

export function androidInstanceSize(instanceType: string): string {
  const separator = instanceType.lastIndexOf(".");
  return separator === -1 ? "" : instanceType.slice(separator + 1);
}

export function isAndroidMetalInstanceType(instanceType: string): boolean {
  return androidInstanceSize(instanceType).startsWith("metal");
}

export function isAndroidAcceleratedInstanceType(instanceType: string): boolean {
  const family = androidInstanceFamily(instanceType);
  const size = androidInstanceSize(instanceType);
  return (
    (ANDROID_NESTED_VIRTUALIZATION_FAMILIES as ReadonlyArray<string>).includes(family) &&
    ANDROID_MINIMUM_SIZES.has(size)
  );
}

export function androidNeedsNestedVirtualizationLaunch(instanceType: string): boolean {
  return (
    isAndroidAcceleratedInstanceType(instanceType) && !isAndroidMetalInstanceType(instanceType)
  );
}

export function isLinuxAndroidWorkerProfile(profile: LinuxAndroidWorkerProfile): boolean {
  return profile.id === LINUX_ANDROID_WORKER_PROFILE_ID || profile.device === "android";
}

export function linuxAndroidWorkerProfile(instanceType: string): LinuxAndroidRunWorkerProfile {
  return {
    id: LINUX_ANDROID_WORKER_PROFILE_ID,
    os: "linux",
    arch: "x64",
    device: "android",
    instanceType,
  };
}

export function defaultAndroidSdkSelection(
  architecture: "x64" | "arm64" = "x64",
): AndroidSdkSelection {
  const abi = architecture === "arm64" ? "arm64-v8a" : "x86_64";
  return {
    apiLevel: 36,
    abi,
    buildTools: "36.0.0",
    systemImage: `system-images;android-36;google_apis;${abi === "arm64-v8a" ? "arm64-v8a" : "x86_64"}`,
  };
}

export function androidSdkPackageAbi(packageId: string): string | undefined {
  const parts = packageId.split(";");
  return parts.at(-1);
}

export function selectAndroidSdkFromProject(input: {
  readonly compileSdk?: number | undefined;
  readonly ndkAbiFilters?: ReadonlyArray<string> | undefined;
  readonly architecture?: "x64" | "arm64" | undefined;
}): AndroidSdkSelection {
  const defaults = defaultAndroidSdkSelection(input.architecture ?? "x64");
  const requestedAbi = input.ndkAbiFilters?.find(
    (abi) => abi === "x86_64" || abi === "arm64-v8a" || abi === "x86" || abi === "armeabi-v7a",
  );
  const abi = requestedAbi ?? defaults.abi;
  const apiLevel =
    input.compileSdk !== undefined && input.compileSdk >= 24 ? input.compileSdk : defaults.apiLevel;
  return {
    apiLevel,
    abi,
    buildTools: `${apiLevel}.0.0`,
    systemImage: `system-images;android-${apiLevel};google_apis;${abi}`,
  };
}

export function admitLinuxAndroidWorker(input: {
  readonly profile: LinuxAndroidWorkerProfile;
  readonly region: string;
  readonly environmentConfig?: CloudEnvironmentConfig | undefined;
  readonly requiredSdk?: AndroidSdkSelection | undefined;
  readonly installedPackages?: ReadonlyArray<string> | undefined;
  readonly placement?: AndroidPlacementInspection | undefined;
  readonly probe?: AndroidHostProbe | undefined;
}): LinuxAndroidAdmissionSuccess | LinuxAndroidAdmissionFailure {
  const instanceType = input.profile.instanceType;
  if (instanceType === undefined) {
    return {
      status: "rejected",
      message: "Android emulator workers must select a nested-virtualization instance type.",
    };
  }
  if (instanceType.startsWith("t3.") || instanceType.startsWith("t2.")) {
    return {
      status: "rejected",
      message: `Instance type '${instanceType}' is the web-worker size and cannot accelerate an Android emulator. Choose a nested-virtualization type such as m7i.xlarge.`,
    };
  }
  if (!isAndroidAcceleratedInstanceType(instanceType)) {
    return {
      status: "rejected",
      message: `Instance type '${instanceType}' is not documented for nested virtualization and emulator KVM. Rejecting before a costly Android build.`,
    };
  }
  if (input.profile.os !== "linux") {
    return {
      status: "rejected",
      message: "Android emulator workers run on Linux. They cannot use the macOS iOS profile.",
    };
  }
  if (input.profile.device !== undefined && input.profile.device !== "android") {
    return {
      status: "rejected",
      message: "The linux-android worker profile only runs Android emulator jobs.",
    };
  }
  if (input.region.trim().length === 0) {
    return {
      status: "rejected",
      message:
        "Android workers require an explicit region. They are not placed in another region automatically.",
    };
  }
  if (input.placement !== undefined) {
    if (input.placement.region !== input.region || input.placement.instanceType !== instanceType) {
      return {
        status: "rejected",
        message: "Android capacity was inspected for a different region or instance type.",
      };
    }
    if (input.placement.availabilityZones.length === 0) {
      return {
        status: "rejected",
        message: `Region ${input.region} does not offer ${instanceType}. Configure T3CODE_CLOUD_AWS_REGION for a region that has this type; do not place the job elsewhere.`,
      };
    }
  }
  if (input.probe !== undefined) {
    if (!input.probe.kvm) {
      return {
        status: "rejected",
        message:
          "The selected instance does not expose /dev/kvm, so emulator acceleration is unavailable.",
      };
    }
    if (!isAndroidMetalInstanceType(instanceType) && !input.probe.nestedVirtualization) {
      return {
        status: "rejected",
        message:
          "Nested virtualization is off on this instance. Enable the NestedVirtualization launch option before building.",
      };
    }
    if (input.probe.emulatorAcceleration !== "kvm") {
      return {
        status: "rejected",
        message: "The Android emulator is not using KVM acceleration on this host.",
      };
    }
  }
  const missingDependencies = (input.environmentConfig?.repositoryDependencies ?? []).filter(
    (dependency) => dependency.trim().length === 0,
  );
  if (missingDependencies.length > 0) {
    return {
      status: "rejected",
      message: "Repository dependencies must be named before an Android worker is admitted.",
    };
  }
  if (input.requiredSdk !== undefined && input.installedPackages !== undefined) {
    const abi = androidSdkPackageAbi(input.requiredSdk.systemImage);
    const installedImage = input.installedPackages.find((packageId) =>
      packageId.includes(input.requiredSdk!.systemImage),
    );
    if (installedImage === undefined) {
      return {
        status: "rejected",
        message: `The worker image does not include ${input.requiredSdk.systemImage}.`,
      };
    }
    if (abi !== undefined && androidSdkPackageAbi(installedImage) !== abi) {
      return {
        status: "rejected",
        message: `Installed system image ABI '${androidSdkPackageAbi(installedImage)}' does not match required '${abi}'.`,
      };
    }
  }
  return {
    status: "accepted",
    nestedVirtualizationLaunch: androidNeedsNestedVirtualizationLaunch(instanceType),
    profile: {
      ...input.profile,
      id: LINUX_ANDROID_WORKER_PROFILE_ID,
      os: "linux",
      arch: "x64",
      device: "android",
      instanceType,
    },
  };
}

export function androidAvdName(input: {
  readonly allocationId: string;
  readonly attempt: number;
}): string {
  const suffix = input.allocationId.replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  return `t3-android-${suffix}-${input.attempt}`;
}

export function androidEmulatorSerial(consolePort: number): string {
  return `emulator-${consolePort}`;
}

export function androidJobPorts(attempt: number): {
  readonly consolePort: number;
  readonly adbPort: number;
} {
  const consolePort = 5554 + (Math.max(1, attempt) - 1) * 2;
  return { consolePort, adbPort: consolePort + 1 };
}

export function androidJobDataDirectory(input: {
  readonly allocationId: string;
  readonly attempt: number;
}): string {
  return `/var/lib/t3-worker/android/${input.allocationId}/${input.attempt}`;
}

export function detectAndroidBuildWorkflow(paths: ReadonlyArray<string>): AndroidBuildWorkflow {
  const normalized = paths.map((path) => path.replaceAll("\\", "/"));
  const hasExpo = normalized.some(
    (path) =>
      path.endsWith("app.json") ||
      path.endsWith("app.config.ts") ||
      path.endsWith("app.config.js") ||
      path.includes("node_modules/expo/"),
  );
  if (hasExpo) return "expo";
  const hasGradle = normalized.some(
    (path) =>
      path.endsWith("build.gradle") ||
      path.endsWith("build.gradle.kts") ||
      path.endsWith("settings.gradle") ||
      path.endsWith("settings.gradle.kts") ||
      path === "android",
  );
  if (hasGradle) return "gradle";
  return "unknown";
}

export function expoGoIsInsufficientNativeProof(input: {
  readonly usesExpoGo: boolean;
  readonly nativeFingerprintChanged: boolean;
}): { readonly ok: boolean; readonly message: string } {
  if (input.usesExpoGo && input.nativeFingerprintChanged) {
    return {
      ok: false,
      message:
        "Native inputs changed. Rebuild the development client; Expo Go does not prove arbitrary native-module support.",
    };
  }
  if (input.usesExpoGo) {
    return {
      ok: false,
      message:
        "Expo Go is not proof of a native Android worker. Install a debug development build.",
    };
  }
  return { ok: true, message: "Using a debug development build on the owned emulator." };
}

export function androidMetroEndpoint(input: {
  readonly serial: string;
  readonly metroPort?: number | undefined;
}): {
  readonly serial: string;
  readonly hostLoopback: string;
  readonly reverse: string;
} {
  const port = input.metroPort ?? 8081;
  return {
    serial: input.serial,
    hostLoopback: "10.0.2.2",
    reverse: `adb -s ${input.serial} reverse tcp:${port} tcp:${port}`,
  };
}

export function androidEmulatorArtifactRequests(input: {
  readonly artifactDirectory: string;
}): ReadonlyArray<{
  readonly relativePath: string;
  readonly name: string;
  readonly mediaType: string;
}> {
  const root = input.artifactDirectory.replace(/\/+$/, "");
  return [
    { relativePath: `${root}/build.log`, name: "Android build log", mediaType: "text/plain" },
    { relativePath: `${root}/logcat.txt`, name: "logcat", mediaType: "text/plain" },
    { relativePath: `${root}/screenshot.png`, name: "emulator screenshot", mediaType: "image/png" },
    { relativePath: `${root}/recording.mp4`, name: "emulator video", mediaType: "video/mp4" },
    {
      relativePath: `${root}/diagnostics.txt`,
      name: "failure diagnostics",
      mediaType: "text/plain",
    },
  ];
}

export function androidRetentionLayers(): ReadonlyArray<{
  readonly layer: "agent-snapshot" | "emulator-data" | "environment-build";
  readonly retention: string;
}> {
  return [
    {
      layer: "agent-snapshot",
      retention:
        "Idle hibernation keeps T3 userdata and the workspace checkpoint with the guest disk.",
    },
    {
      layer: "emulator-data",
      retention:
        "AVD userdata is job-scoped under /var/lib/t3-worker/android and snapshotted separately from the environment Build. Wake proves whether that directory restored.",
    },
    {
      layer: "environment-build",
      retention:
        "Prepared environment Builds hold the SDK and template AVD, not a job's app or login state.",
    },
  ];
}

export function emulatorWakeResumption(input: {
  readonly emulatorFlush?: FlushComponent | undefined;
  readonly avdDataPresent?: boolean | undefined;
}): Resumption {
  if (input.emulatorFlush?.status === "flushed" && input.avdDataPresent === true) {
    return {
      status: "resumed",
      detail: input.emulatorFlush.detail,
    };
  }
  return {
    status: "not-resumed",
    reason:
      input.emulatorFlush?.status === "unavailable"
        ? `${input.emulatorFlush.reason} Wake created a new AVD; app and login state did not persist.`
        : "AVD data was not restorable. Wake created a new AVD and app/login state did not persist.",
  };
}

export const AndroidEmulatorControlEndpoint = Schema.Struct({
  kind: Schema.Literal("loopback"),
  adb: TrimmedNonEmptyString,
  grpc: Schema.optionalKey(TrimmedNonEmptyString),
  public: Schema.Boolean,
});
export type AndroidEmulatorControlEndpoint = typeof AndroidEmulatorControlEndpoint.Type;

export function androidControlEndpoints(serial: string): AndroidEmulatorControlEndpoint {
  return {
    kind: "loopback",
    adb: `127.0.0.1:${serial.replace("emulator-", "")}`,
    public: false,
  };
}

export function proveAndroidAcceleration(probe: {
  readonly kvmPathExists: boolean;
  readonly nestedVirtualization: boolean;
  readonly metal: boolean;
  readonly emulatorAccel: string;
}): { readonly ok: boolean; readonly reason?: string; readonly acceleration: "kvm" | "none" } {
  if (!probe.kvmPathExists) {
    return { ok: false, acceleration: "none", reason: "Linux KVM is not available at /dev/kvm." };
  }
  if (!probe.metal && !probe.nestedVirtualization) {
    return {
      ok: false,
      acceleration: "none",
      reason: "Nested virtualization is required on this virtual instance type.",
    };
  }
  if (!probe.emulatorAccel.toLowerCase().includes("kvm")) {
    return {
      ok: false,
      acceleration: "none",
      reason: "emulator -accel-check did not report KVM.",
    };
  }
  return { ok: true, acceleration: "kvm" };
}
