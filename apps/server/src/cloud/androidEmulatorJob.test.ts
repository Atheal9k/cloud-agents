import { describe, expect, it } from "vite-plus/test";

import {
  adbSerialArguments,
  androidJobCleanupTargets,
  crashLeavesActionableResult,
  emulatorLaunchArguments,
  expoNativeRebuildRequired,
  gradleDebugBuildArguments,
  planAndroidEmulatorJob,
} from "./androidEmulatorJob.ts";

describe("androidEmulatorJob", () => {
  it("plans a debug install for the owned serial and isolates AVD data", () => {
    const job = planAndroidEmulatorJob({
      allocationId: "allocation-1",
      attempt: 1,
      checkoutPath: "/work/repository",
      artifactDirectory: "/work/repository/artifacts/android",
      paths: ["android/app/build.gradle", "package.json"],
      abi: "x86_64",
      apiLevel: 36,
    });

    expect(job.workflow).toBe("gradle");
    expect(job.serial).toBe("emulator-5554");
    expect(job.dataDirectory).toBe("/var/lib/t3-worker/android/allocation-1/1");
    expect(emulatorLaunchArguments(job)).toEqual(
      expect.arrayContaining(["-avd", job.avdName, "-port", "5554", "-datadir", job.dataDirectory]),
    );
    expect(adbSerialArguments(job.serial)).toEqual(["-s", "emulator-5554"]);
    expect(gradleDebugBuildArguments({ abi: "x86_64" })).toEqual(
      expect.arrayContaining([":app:assembleDebug", "-PreactNativeArchitectures=x86_64"]),
    );
  });

  it("rebuilds native clients when Expo native inputs change", () => {
    expect(
      expoNativeRebuildRequired({
        nativeFingerprintChanged: true,
        installedPackage: "host.exp.exponent",
      }),
    ).toBe(true);
    expect(
      androidJobCleanupTargets({
        serial: "emulator-5554",
        dataDirectory: "/var/lib/t3-worker/android/allocation-1/1",
        ownedPids: [441, 442],
      }).pids,
    ).toEqual([441, 442]);
    expect(
      crashLeavesActionableResult({
        state: "building",
        diagnosticsPath: "/work/artifacts/android/diagnostics.txt",
      }).unboundedHost,
    ).toBe(false);
  });
});
