import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  CloudMacHostId,
  IsoDateTime,
  NonNegativeInt,
  RunAllocationAttempt,
  RunAllocationId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { type CloudEnvironmentConfig } from "./cloudEnvironment.ts";

type MacIosWorkerProfile = {
  readonly id: string;
  readonly os: string;
  readonly arch: string;
  readonly device?: "android" | "ios" | undefined;
  readonly instanceType?: string | undefined;
};

export type SelectedRunWorkerProfile =
  | {
      readonly id: typeof MACOS_IOS_WORKER_PROFILE_ID;
      readonly os: "darwin";
      readonly arch: "arm64";
      readonly device: "ios";
      readonly instanceType: string;
    }
  | {
      readonly id: "linux-web";
      readonly os: "linux";
      readonly arch: "x64";
      readonly instanceType: string;
    };

type FlushComponent =
  | { readonly status: "flushed"; readonly detail: string }
  | { readonly status: "unavailable"; readonly reason: string };

type Resumption =
  | { readonly status: "resumed"; readonly detail: string }
  | { readonly status: "not-resumed"; readonly reason: string };

type HostCost =
  | { readonly status: "estimated"; readonly usd: number; readonly assumption: string }
  | { readonly status: "not-attributed"; readonly reason: string }
  | { readonly status: "unknown"; readonly reason: string };

export const MACOS_IOS_WORKER_PROFILE_ID = "macos-ios";

/** EC2 Mac Dedicated Hosts cannot be released before this window. */
export const MAC_DEDICATED_HOST_MINIMUM_SECONDS = 24 * 60 * 60;

/**
 * Regions where Apple Silicon EC2 Mac Dedicated Hosts are offered. The default
 * Linux stack region `us-west-1` is intentionally absent: never silently place
 * a Mac job in another region.
 */
export const MAC_IOS_SUPPORTED_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-west-1",
  "eu-central-1",
  "ap-northeast-1",
  "ap-southeast-1",
] as const;

export const MAC_IOS_APPLE_SILICON_INSTANCE_TYPES = [
  "mac2.metal",
  "mac2-m1ultra.metal",
  "mac2-m2.metal",
  "mac2-m2pro.metal",
] as const;

export const MacDedicatedHostAvailability = Schema.Literals([
  "allocating",
  "available",
  "occupied",
  "scrubbing",
  "release-requested",
  "releasing",
  "released",
]);
export type MacDedicatedHostAvailability = typeof MacDedicatedHostAvailability.Type;

export const CloudMacHost = Schema.Struct({
  id: CloudMacHostId,
  awsHostId: TrimmedNonEmptyString,
  region: TrimmedNonEmptyString,
  availabilityZone: TrimmedNonEmptyString,
  instanceType: TrimmedNonEmptyString,
  macos: TrimmedNonEmptyString,
  xcode: TrimmedNonEmptyString,
  simulatorRuntime: TrimmedNonEmptyString,
  allocatedAt: IsoDateTime,
  earliestReleaseAt: IsoDateTime,
  availability: MacDedicatedHostAvailability,
  instanceId: Schema.optionalKey(TrimmedNonEmptyString),
  occupiedBy: Schema.optionalKey(
    Schema.Struct({
      allocationId: RunAllocationId,
      attempt: RunAllocationAttempt,
    }),
  ),
  releaseRequestedAt: Schema.optionalKey(IsoDateTime),
  releasedAt: Schema.optionalKey(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type CloudMacHost = typeof CloudMacHost.Type;

export const MacCapacityInspection = Schema.Struct({
  region: TrimmedNonEmptyString,
  instanceType: TrimmedNonEmptyString,
  appleSilicon: Schema.Boolean,
  dedicatedHostQuota: Schema.Struct({
    used: NonNegativeInt,
    limit: NonNegativeInt,
  }),
  availableHostIds: Schema.Array(TrimmedNonEmptyString),
  availabilityZones: Schema.Array(TrimmedNonEmptyString),
});
export type MacCapacityInspection = typeof MacCapacityInspection.Type;

export const IosSimulatorJobState = Schema.Literals([
  "reserving",
  "booting",
  "building",
  "installing",
  "launching",
  "ready",
  "failed",
  "cleaned",
]);
export type IosSimulatorJobState = typeof IosSimulatorJobState.Type;

export const IosBuildWorkflow = Schema.Literals(["xcode", "expo", "unknown"]);
export type IosBuildWorkflow = typeof IosBuildWorkflow.Type;

export const IosSimulatorJob = Schema.Struct({
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  udid: TrimmedNonEmptyString,
  deviceName: TrimmedNonEmptyString,
  runtime: TrimmedNonEmptyString,
  architecture: Schema.Literal("arm64"),
  workflow: IosBuildWorkflow,
  state: IosSimulatorJobState,
  checkoutPath: TrimmedNonEmptyString,
  artifactDirectory: TrimmedNonEmptyString,
});
export type IosSimulatorJob = typeof IosSimulatorJob.Type;

export type MacIosAdmissionFailure = {
  readonly status: "rejected";
  readonly message: string;
};

export type MacIosAdmissionSuccess = {
  readonly status: "accepted";
  readonly profile: MacIosWorkerProfile;
};

export function isAppleSiliconMacInstanceType(instanceType: string): boolean {
  return (MAC_IOS_APPLE_SILICON_INSTANCE_TYPES as ReadonlyArray<string>).includes(instanceType);
}

export function isMacIosSupportedRegion(region: string): boolean {
  return (MAC_IOS_SUPPORTED_REGIONS as ReadonlyArray<string>).includes(region);
}

export function isMacIosWorkerProfile(profile: MacIosWorkerProfile): boolean {
  return (
    profile.id === MACOS_IOS_WORKER_PROFILE_ID ||
    profile.device === "ios" ||
    (profile.os === "darwin" && isAppleSiliconMacInstanceType(profile.instanceType ?? ""))
  );
}

export function workerProfileForInstanceType(instanceType: string): SelectedRunWorkerProfile {
  if (isAppleSiliconMacInstanceType(instanceType)) {
    return {
      id: MACOS_IOS_WORKER_PROFILE_ID,
      os: "darwin",
      arch: "arm64",
      device: "ios",
      instanceType,
    };
  }
  return {
    id: "linux-web",
    os: "linux",
    arch: "x64",
    instanceType,
  };
}

export function macDedicatedHostEarliestReleaseAt(allocatedAt: string): string {
  const start = Date.parse(allocatedAt);
  if (!Number.isFinite(start)) return allocatedAt;
  return DateTime.formatIso(
    DateTime.makeUnsafe(start + MAC_DEDICATED_HOST_MINIMUM_SECONDS * 1_000),
  );
}

export function macDedicatedHostBilledThrough(input: {
  readonly allocatedAt: string;
  readonly earliestReleaseAt: string;
  readonly releasedAt?: string | undefined;
  readonly now: string;
}): string {
  const allocated = Date.parse(input.allocatedAt);
  const earliest = Date.parse(input.earliestReleaseAt);
  const now = Date.parse(input.now);
  const released = input.releasedAt === undefined ? undefined : Date.parse(input.releasedAt);
  const endCandidates = [earliest, Number.isFinite(now) ? now : earliest];
  if (released !== undefined && Number.isFinite(released)) endCandidates.push(released);
  const end = Math.max(...endCandidates.filter((value) => Number.isFinite(value)));
  if (!Number.isFinite(allocated)) return input.now;
  return DateTime.formatIso(DateTime.makeUnsafe(Math.max(allocated, end)));
}

export function macDedicatedHostCostSeconds(input: {
  readonly allocatedAt: string;
  readonly earliestReleaseAt: string;
  readonly releasedAt?: string | undefined;
  readonly now: string;
}): number {
  const start = Date.parse(input.allocatedAt);
  const end = Date.parse(macDedicatedHostBilledThrough(input));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - start) / 1_000));
}

export function canReleaseMacDedicatedHost(input: {
  readonly host: CloudMacHost;
  readonly now: string;
}): boolean {
  if (input.host.availability === "released") return false;
  if (input.host.occupiedBy !== undefined) return false;
  if (input.host.availability !== "release-requested" && input.host.availability !== "releasing") {
    return false;
  }
  const now = Date.parse(input.now);
  const earliest = Date.parse(input.host.earliestReleaseAt);
  return Number.isFinite(now) && Number.isFinite(earliest) && now >= earliest;
}

export function macJobCancelHostMessage(host: CloudMacHost): string {
  return `The iOS job ended. Dedicated Host ${host.awsHostId} remains allocated until ${host.earliestReleaseAt} and continues to accrue host charges until it is released.`;
}

export function admitMacIosWorker(input: {
  readonly profile: MacIosWorkerProfile;
  readonly region: string;
  readonly environmentConfig?: CloudEnvironmentConfig | undefined;
  readonly requiredMacos?: string | undefined;
  readonly requiredXcode?: string | undefined;
  readonly requiredSimulatorRuntime?: string | undefined;
  readonly installed?:
    | {
        readonly macos: string;
        readonly xcode: string;
        readonly simulatorRuntime: string;
      }
    | undefined;
  readonly capacity?: MacCapacityInspection | undefined;
}): MacIosAdmissionSuccess | MacIosAdmissionFailure {
  const instanceType = input.profile.instanceType;
  if (instanceType === undefined) {
    return {
      status: "rejected",
      message: "macOS iOS workers must select an EC2 Mac instance type.",
    };
  }
  if (!isAppleSiliconMacInstanceType(instanceType)) {
    return {
      status: "rejected",
      message: `Instance type '${instanceType}' is not Apple Silicon EC2 Mac hardware. Intel mac1.metal is not admitted.`,
    };
  }
  if (!isMacIosSupportedRegion(input.region)) {
    return {
      status: "rejected",
      message: `EC2 Mac Dedicated Hosts are not configured for region '${input.region}'. Set T3CODE_CLOUD_AWS_REGION to a supported Mac region rather than placing the job elsewhere.`,
    };
  }
  if (input.profile.os !== "darwin" || input.profile.arch !== "arm64") {
    return {
      status: "rejected",
      message: "macOS iOS workers require darwin/arm64. They cannot run on the Linux web worker.",
    };
  }
  if (input.profile.device !== undefined && input.profile.device !== "ios") {
    return {
      status: "rejected",
      message: "The macos-ios worker profile only runs iOS Simulator jobs.",
    };
  }
  if (input.capacity !== undefined) {
    if (input.capacity.region !== input.region || input.capacity.instanceType !== instanceType) {
      return {
        status: "rejected",
        message: "Mac capacity was inspected for a different region or instance type.",
      };
    }
    if (!input.capacity.appleSilicon) {
      return {
        status: "rejected",
        message: "Inspected Mac capacity is not Apple Silicon.",
      };
    }
    if (
      input.capacity.availableHostIds.length === 0 &&
      input.capacity.dedicatedHostQuota.used >= input.capacity.dedicatedHostQuota.limit
    ) {
      return {
        status: "rejected",
        message: `Dedicated Host quota is exhausted in ${input.region} (${input.capacity.dedicatedHostQuota.used}/${input.capacity.dedicatedHostQuota.limit}).`,
      };
    }
    if (input.capacity.availabilityZones.length === 0) {
      return {
        status: "rejected",
        message: `Region ${input.region} has no availability zone offering ${instanceType}.`,
      };
    }
  }
  const missingDependencies = (input.environmentConfig?.repositoryDependencies ?? []).filter(
    (dependency) => dependency.trim().length === 0,
  );
  if (missingDependencies.length > 0) {
    return {
      status: "rejected",
      message: "Repository dependencies must be named before a macOS iOS worker is admitted.",
    };
  }
  if (input.installed !== undefined) {
    if (input.requiredMacos !== undefined && input.installed.macos !== input.requiredMacos) {
      return {
        status: "rejected",
        message: `This Mac image provides macOS ${input.installed.macos}, but the environment requires ${input.requiredMacos}.`,
      };
    }
    if (input.requiredXcode !== undefined && input.installed.xcode !== input.requiredXcode) {
      return {
        status: "rejected",
        message: `This Mac image provides Xcode ${input.installed.xcode}, but the environment requires ${input.requiredXcode}.`,
      };
    }
    if (
      input.requiredSimulatorRuntime !== undefined &&
      input.installed.simulatorRuntime !== input.requiredSimulatorRuntime
    ) {
      return {
        status: "rejected",
        message: `This Mac image provides simulator runtime ${input.installed.simulatorRuntime}, but the environment requires ${input.requiredSimulatorRuntime}.`,
      };
    }
  }
  return {
    status: "accepted",
    profile: {
      ...input.profile,
      id: MACOS_IOS_WORKER_PROFILE_ID,
      os: "darwin",
      arch: "arm64",
      device: "ios",
      instanceType,
    },
  };
}

export function iosSimulatorDeviceName(input: {
  readonly allocationId: string;
  readonly attempt: number;
}): string {
  const suffix = input.allocationId.replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  return `t3-ios-${suffix}-${input.attempt}`;
}

export function detectIosBuildWorkflow(paths: ReadonlyArray<string>): IosBuildWorkflow {
  const normalized = paths.map((path) => path.replaceAll("\\", "/"));
  const hasXcode = normalized.some(
    (path) => path.endsWith(".xcodeproj") || path.endsWith(".xcworkspace") || path === "ios",
  );
  const hasExpo = normalized.some(
    (path) =>
      path.endsWith("app.json") ||
      path.endsWith("app.config.ts") ||
      path.endsWith("app.config.js") ||
      path.includes("node_modules/expo/"),
  );
  if (hasExpo) return "expo";
  if (hasXcode) return "xcode";
  return "unknown";
}

/** Simulator-only signing. Device or App Store certificates are not required. */
export function iosSimulatorSigningSettings(): ReadonlyArray<string> {
  return [
    "CODE_SIGNING_ALLOWED=NO",
    "CODE_SIGNING_REQUIRED=NO",
    "CODE_SIGN_IDENTITY=-",
    "CODE_SIGN_ENTITLEMENTS=",
    "DEVELOPMENT_TEAM=",
  ];
}

export function iosSimulatorArtifactRequests(input: {
  readonly artifactDirectory: string;
}): ReadonlyArray<{
  readonly relativePath: string;
  readonly name: string;
  readonly mediaType: string;
}> {
  const root = input.artifactDirectory.replace(/\/+$/, "");
  return [
    {
      relativePath: `${root}/xcodebuild.log`,
      name: "xcodebuild log",
      mediaType: "text/plain",
    },
    {
      relativePath: `${root}/TestResults.xcresult`,
      name: "xcodebuild result bundle",
      mediaType: "application/octet-stream",
    },
    {
      relativePath: `${root}/simulator.log`,
      name: "simulator log",
      mediaType: "text/plain",
    },
    {
      relativePath: `${root}/screenshot.png`,
      name: "simulator screenshot",
      mediaType: "image/png",
    },
    {
      relativePath: `${root}/recording.mp4`,
      name: "simulator video",
      mediaType: "video/mp4",
    },
  ];
}

export function macRetentionLayers(): ReadonlyArray<{
  readonly layer: "agent-snapshot" | "simulator-data" | "xcode-cache" | "environment-build";
  readonly retention: string;
}> {
  return [
    {
      layer: "agent-snapshot",
      retention:
        "Idle hibernation keeps T3 userdata and the workspace checkpoint with the guest disk.",
    },
    {
      layer: "simulator-data",
      retention:
        "Simulator CoreSimulator data is job-scoped and wiped on cleanup. Wake never claims the Simulator process resumed.",
    },
    {
      layer: "xcode-cache",
      retention:
        "DerivedData and Xcode caches stay on the Mac image or Build layer, not in a job checkout.",
    },
    {
      layer: "environment-build",
      retention:
        "Prepared environment Builds are independent of Simulator state and Dedicated Host billing.",
    },
  ];
}

export function simulatorWakeResumption(input: {
  readonly simulatorFlush?: FlushComponent | undefined;
}): Resumption {
  if (input.simulatorFlush?.status === "flushed") {
    return {
      status: "resumed",
      detail: input.simulatorFlush.detail,
    };
  }
  return {
    status: "not-resumed",
    reason:
      input.simulatorFlush?.status === "unavailable"
        ? input.simulatorFlush.reason
        : "The iOS Simulator process is not restorable across hibernation. Wake creates a new reserved UDID.",
  };
}

export function macDedicatedHostUsageCost(input: {
  readonly host: CloudMacHost;
  readonly hourlyUsd: number;
  readonly region: string;
  readonly now: string;
}): HostCost {
  const seconds = macDedicatedHostCostSeconds({
    allocatedAt: input.host.allocatedAt,
    earliestReleaseAt: input.host.earliestReleaseAt,
    releasedAt: input.host.releasedAt,
    now: input.now,
  });
  return {
    status: "estimated",
    usd: Math.round(((seconds / 3_600) * input.hourlyUsd + Number.EPSILON) * 1e6) / 1e6,
    assumption: `${input.region} Dedicated Host ${input.host.instanceType} at $${input.hourlyUsd}/hour from ${input.host.allocatedAt}; 24-hour minimum through ${input.host.earliestReleaseAt}. Job cancellation does not end this charge.`,
  };
}

export type MacHostPlacement =
  | { readonly action: "occupy"; readonly host: CloudMacHost }
  | { readonly action: "allocate" }
  | { readonly action: "wait"; readonly reason: string }
  | { readonly action: "reject"; readonly reason: string };

export function placeMacIosJob(input: {
  readonly hosts: ReadonlyArray<CloudMacHost>;
  readonly region: string;
  readonly instanceType: string;
  readonly releaseRequested: boolean;
}): MacHostPlacement {
  if (input.releaseRequested && input.hosts.every((host) => host.availability !== "occupied")) {
    return {
      action: "reject",
      reason: "Mac Dedicated Host release was requested, so no new iOS jobs are admitted.",
    };
  }
  const reusable = input.hosts.find(
    (host) =>
      host.region === input.region &&
      host.instanceType === input.instanceType &&
      host.occupiedBy === undefined &&
      (host.availability === "available" || host.availability === "scrubbing") &&
      host.releasedAt === undefined,
  );
  if (reusable !== undefined) {
    if (reusable.availability === "scrubbing") {
      return {
        action: "wait",
        reason: `Dedicated Host ${reusable.awsHostId} is still scrubbing the previous job's Simulator data.`,
      };
    }
    return { action: "occupy", host: reusable };
  }
  const occupied = input.hosts.find(
    (host) =>
      host.region === input.region &&
      host.instanceType === input.instanceType &&
      host.availability === "occupied",
  );
  if (occupied !== undefined) {
    return {
      action: "wait",
      reason: `Dedicated Host ${occupied.awsHostId} still has an active iOS job. Queued work waits until that job is cleaned.`,
    };
  }
  return { action: "allocate" };
}
