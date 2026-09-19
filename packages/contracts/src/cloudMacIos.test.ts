import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CloudMacHostId, RunAllocationAttempt, RunAllocationId } from "./baseSchemas.ts";
import {
  admitMacIosWorker,
  canReleaseMacDedicatedHost,
  detectIosBuildWorkflow,
  iosSimulatorArtifactRequests,
  iosSimulatorDeviceName,
  iosSimulatorSigningSettings,
  isAppleSiliconMacInstanceType,
  MAC_DEDICATED_HOST_MINIMUM_SECONDS,
  MACOS_IOS_WORKER_PROFILE_ID,
  macDedicatedHostCostSeconds,
  macDedicatedHostEarliestReleaseAt,
  macJobCancelHostMessage,
  placeMacIosJob,
  simulatorWakeResumption,
  workerProfileForInstanceType,
  type CloudMacHost,
} from "./cloudMacIos.ts";

const decodeHostId = Schema.decodeSync(CloudMacHostId);
const decodeAllocationId = Schema.decodeSync(RunAllocationId);
const decodeAttempt = Schema.decodeSync(RunAllocationAttempt);

function host(input: Partial<CloudMacHost> = {}): CloudMacHost {
  return {
    id: decodeHostId("host-1"),
    awsHostId: "h-mac",
    region: "us-west-2",
    availabilityZone: "us-west-2a",
    instanceType: "mac2-m2.metal",
    macos: "15.6",
    xcode: "16.4",
    simulatorRuntime: "iOS 18.5",
    allocatedAt: "2026-09-19T00:00:00.000Z",
    earliestReleaseAt: "2026-09-20T00:00:00.000Z",
    availability: "available",
    updatedAt: "2026-09-19T00:00:00.000Z",
    ...input,
  };
}

describe("workerProfileForInstanceType", () => {
  it("selects the macos-ios profile only for Apple Silicon Mac types", () => {
    expect(workerProfileForInstanceType("mac2-m2.metal")).toEqual({
      id: MACOS_IOS_WORKER_PROFILE_ID,
      os: "darwin",
      arch: "arm64",
      device: "ios",
      instanceType: "mac2-m2.metal",
    });
    expect(isAppleSiliconMacInstanceType("mac1.metal")).toBe(false);
    expect(workerProfileForInstanceType("t3.medium").id).toBe("linux-web");
  });
});

describe("admitMacIosWorker", () => {
  const profile = workerProfileForInstanceType("mac2-m2.metal");

  it("rejects the default Linux region instead of placing elsewhere", () => {
    const result = admitMacIosWorker({ profile, region: "us-west-1" });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.message).toContain("us-west-1");
    expect(result.message).toContain("T3CODE_CLOUD_AWS_REGION");
  });

  it("rejects Intel Mac hardware", () => {
    const result = admitMacIosWorker({
      profile: { ...profile, instanceType: "mac1.metal" },
      region: "us-west-2",
    });
    expect(result.status).toBe("rejected");
  });

  it("accepts Apple Silicon in a supported region when quota remains", () => {
    const result = admitMacIosWorker({
      profile,
      region: "us-west-2",
      environmentConfig: {
        image: "macos-ios-xcode16",
        repositoryDependencies: ["github.com/acme/ios-app"],
      },
      capacity: {
        region: "us-west-2",
        instanceType: "mac2-m2.metal",
        appleSilicon: true,
        dedicatedHostQuota: { used: 0, limit: 2 },
        availableHostIds: [],
        availabilityZones: ["us-west-2a"],
      },
    });
    expect(result).toMatchObject({
      status: "accepted",
      profile: { id: MACOS_IOS_WORKER_PROFILE_ID },
    });
  });

  it("rejects exhausted Dedicated Host quota when no host is reusable", () => {
    const result = admitMacIosWorker({
      profile,
      region: "us-west-2",
      capacity: {
        region: "us-west-2",
        instanceType: "mac2-m2.metal",
        appleSilicon: true,
        dedicatedHostQuota: { used: 1, limit: 1 },
        availableHostIds: [],
        availabilityZones: ["us-west-2a"],
      },
    });
    expect(result.status).toBe("rejected");
  });
});

describe("Dedicated Host economics", () => {
  it("keeps the 24-hour minimum after a two-hour job cancel", () => {
    expect(MAC_DEDICATED_HOST_MINIMUM_SECONDS).toBe(86_400);
    expect(macDedicatedHostEarliestReleaseAt("2026-09-19T00:00:00.000Z")).toBe(
      "2026-09-20T00:00:00.000Z",
    );
    const allocated = host();
    expect(
      macDedicatedHostCostSeconds({
        allocatedAt: allocated.allocatedAt,
        earliestReleaseAt: allocated.earliestReleaseAt,
        now: "2026-09-19T02:00:00.000Z",
      }),
    ).toBe(86_400);
    expect(macJobCancelHostMessage(allocated)).toContain("continues to accrue");
    expect(
      canReleaseMacDedicatedHost({
        host: { ...allocated, availability: "release-requested" },
        now: "2026-09-19T02:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      canReleaseMacDedicatedHost({
        host: { ...allocated, availability: "release-requested" },
        now: "2026-09-20T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("reuses one cleaned host and waits while a job occupies it", () => {
    expect(
      placeMacIosJob({
        hosts: [host()],
        region: "us-west-2",
        instanceType: "mac2-m2.metal",
        releaseRequested: false,
      }),
    ).toMatchObject({ action: "occupy", host: { awsHostId: "h-mac" } });
    expect(
      placeMacIosJob({
        hosts: [
          host({
            availability: "occupied",
            occupiedBy: {
              allocationId: decodeAllocationId("allocation-1"),
              attempt: decodeAttempt(1),
            },
          }),
        ],
        region: "us-west-2",
        instanceType: "mac2-m2.metal",
        releaseRequested: false,
      }),
    ).toMatchObject({ action: "wait" });
    expect(
      placeMacIosJob({
        hosts: [],
        region: "us-west-2",
        instanceType: "mac2-m2.metal",
        releaseRequested: true,
      }),
    ).toMatchObject({ action: "reject" });
  });
});

describe("iOS Simulator jobs", () => {
  it("reserves a job-scoped UDID name and simulator signing flags", () => {
    expect(iosSimulatorDeviceName({ allocationId: "allocation-1", attempt: 2 })).toBe(
      "t3-ios-allocation1-2",
    );
    expect(iosSimulatorSigningSettings()).toContain("CODE_SIGNING_ALLOWED=NO");
    expect(detectIosBuildWorkflow(["app.json", "ios/App.xcworkspace"])).toBe("expo");
    expect(detectIosBuildWorkflow(["App.xcodeproj"])).toBe("xcode");
    expect(iosSimulatorArtifactRequests({ artifactDirectory: "artifacts/ios" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "xcodebuild log" }),
        expect.objectContaining({ name: "simulator screenshot" }),
        expect.objectContaining({ name: "simulator video" }),
      ]),
    );
  });

  it("does not claim Simulator resume unless that process was flushed", () => {
    expect(simulatorWakeResumption({})).toMatchObject({ status: "not-resumed" });
    expect(
      simulatorWakeResumption({
        simulatorFlush: { status: "flushed", detail: "Simulator UDID stayed booted." },
      }),
    ).toMatchObject({ status: "resumed" });
  });
});
