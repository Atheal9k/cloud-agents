import { describe, expect, it } from "@effect/vitest";

import {
  admitLinuxAndroidWorker,
  androidAvdName,
  androidControlEndpoints,
  androidEmulatorArtifactRequests,
  androidEmulatorSerial,
  androidJobPorts,
  androidMetroEndpoint,
  androidNeedsNestedVirtualizationLaunch,
  androidRetentionLayers,
  androidSdkPackageAbi,
  detectAndroidBuildWorkflow,
  emulatorWakeResumption,
  expoGoIsInsufficientNativeProof,
  isAndroidAcceleratedInstanceType,
  isLinuxAndroidWorkerProfile,
  LINUX_ANDROID_WORKER_PROFILE_ID,
  linuxAndroidWorkerProfile,
  proveAndroidAcceleration,
  selectAndroidSdkFromProject,
} from "./cloudLinuxAndroid.ts";

const profile = linuxAndroidWorkerProfile("m7i.xlarge");

describe("linux-android admission", () => {
  it("rejects the web worker t3.medium before a costly build", () => {
    const result = admitLinuxAndroidWorker({
      profile: { ...profile, instanceType: "t3.medium" },
      region: "us-west-1",
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.message).toContain("t3.medium");
    expect(result.message).toContain("m7i.xlarge");
  });

  it("rejects instance types without nested virtualization", () => {
    const result = admitLinuxAndroidWorker({
      profile: { ...profile, instanceType: "m5.xlarge" },
      region: "us-west-1",
    });
    expect(result.status).toBe("rejected");
  });

  it("accepts a nested-virtualization type in the configured region", () => {
    const result = admitLinuxAndroidWorker({
      profile,
      region: "us-west-1",
      probe: {
        nestedVirtualization: true,
        kvm: true,
        emulatorAcceleration: "kvm",
      },
    });
    expect(result).toMatchObject({
      status: "accepted",
      nestedVirtualizationLaunch: true,
      profile: { id: LINUX_ANDROID_WORKER_PROFILE_ID, device: "android" },
    });
    expect(androidNeedsNestedVirtualizationLaunch("m7i.xlarge")).toBe(true);
    expect(androidNeedsNestedVirtualizationLaunch("m7i.metal")).toBe(false);
    expect(isAndroidAcceleratedInstanceType("t3.medium")).toBe(false);
  });

  it("does not silently place in another region when the type is missing", () => {
    const result = admitLinuxAndroidWorker({
      profile,
      region: "us-west-1",
      placement: {
        region: "us-west-1",
        instanceType: "m7i.xlarge",
        availabilityZones: [],
      },
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.message).toContain("us-west-1");
    expect(result.message).toContain("T3CODE_CLOUD_AWS_REGION");
  });

  it("rejects a host without KVM or emulator acceleration", () => {
    const kvm = admitLinuxAndroidWorker({
      profile,
      region: "us-west-1",
      probe: {
        nestedVirtualization: true,
        kvm: false,
        emulatorAcceleration: "none",
      },
    });
    expect(kvm.status).toBe("rejected");
  });

  it("validates the installed system-image ABI against the project", () => {
    const required = selectAndroidSdkFromProject({
      compileSdk: 36,
      ndkAbiFilters: ["arm64-v8a"],
    });
    expect(required.abi).toBe("arm64-v8a");
    expect(androidSdkPackageAbi(required.systemImage)).toBe("arm64-v8a");
    const mismatch = admitLinuxAndroidWorker({
      profile,
      region: "us-west-1",
      requiredSdk: required,
      installedPackages: ["system-images;android-36;google_apis;x86_64"],
    });
    expect(mismatch.status).toBe("rejected");
  });
});

describe("android emulator jobs", () => {
  it("owns a unique AVD, serial, and loopback ADB endpoint per attempt", () => {
    const ports = androidJobPorts(2);
    expect(androidAvdName({ allocationId: "allocation-1", attempt: 2 })).toBe(
      "t3-android-allocation1-2",
    );
    expect(androidEmulatorSerial(ports.consolePort)).toBe("emulator-5556");
    expect(androidControlEndpoints("emulator-5556").public).toBe(false);
    expect(isLinuxAndroidWorkerProfile(profile)).toBe(true);
  });

  it("detects Expo vs Gradle and refuses Expo Go as native proof", () => {
    expect(detectAndroidBuildWorkflow(["app.json", "android/app/build.gradle"])).toBe("expo");
    expect(detectAndroidBuildWorkflow(["android/app/build.gradle"])).toBe("gradle");
    expect(
      expoGoIsInsufficientNativeProof({ usesExpoGo: true, nativeFingerprintChanged: true }).ok,
    ).toBe(false);
    expect(androidMetroEndpoint({ serial: "emulator-5554" }).hostLoopback).toBe("10.0.2.2");
  });

  it("keeps emulator snapshots separate from Builds and reports unrestorable AVD data", () => {
    expect(androidRetentionLayers().map((layer) => layer.layer)).toEqual([
      "agent-snapshot",
      "emulator-data",
      "environment-build",
    ]);
    expect(
      emulatorWakeResumption({
        emulatorFlush: { status: "unavailable", reason: "The AVD directory was empty." },
        avdDataPresent: false,
      }).status,
    ).toBe("not-resumed");
    expect(
      emulatorWakeResumption({
        emulatorFlush: { status: "flushed", detail: "Copied AVD userdata." },
        avdDataPresent: true,
      }).status,
    ).toBe("resumed");
    expect(
      androidEmulatorArtifactRequests({ artifactDirectory: "/work/artifacts/android" }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "logcat" }),
        expect.objectContaining({ name: "emulator screenshot" }),
        expect.objectContaining({ name: "emulator video" }),
      ]),
    );
  });

  it("proves acceleration from KVM and emulator -accel-check", () => {
    expect(
      proveAndroidAcceleration({
        kvmPathExists: true,
        nestedVirtualization: true,
        metal: false,
        emulatorAccel: "accel: 0\nKVM (version 12) is installed and usable.",
      }).ok,
    ).toBe(true);
    expect(
      proveAndroidAcceleration({
        kvmPathExists: false,
        nestedVirtualization: false,
        metal: false,
        emulatorAccel: "WHPX is not installed",
      }).ok,
    ).toBe(false);
  });
});
