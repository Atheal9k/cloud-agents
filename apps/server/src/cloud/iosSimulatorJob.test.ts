import { describe, expect, it } from "vite-plus/test";

import {
  iosJobCleanupTargets,
  parseSimctlDeviceList,
  planIosSimulatorJob,
  xcodebuildSimulatorArguments,
} from "./iosSimulatorJob.ts";

describe("iosSimulatorJob", () => {
  it("plans an Expo workflow and builds for the reserved simulator architecture", () => {
    const job = planIosSimulatorJob({
      allocationId: "allocation-1",
      attempt: 1,
      checkoutPath: "/work/repository",
      artifactDirectory: "/work/repository/artifacts/ios",
      paths: ["app.json", "ios/App.xcworkspace"],
      runtime: "iOS 18.5",
    });

    expect(job.workflow).toBe("expo");
    expect(job.deviceName).toBe("t3-ios-allocation1-1");
    expect(job.architecture).toBe("arm64");
    expect(
      xcodebuildSimulatorArguments({
        workspaceOrProject: "/work/repository/ios/App.xcworkspace",
        scheme: "App",
        udid: "UDID-1",
        derivedDataPath: "/work/repository/DerivedData",
        resultBundlePath: "/work/repository/artifacts/ios/TestResults.xcresult",
      }),
    ).toEqual(
      expect.arrayContaining([
        "-destination",
        "id=UDID-1",
        "ARCHS=arm64",
        "CODE_SIGNING_ALLOWED=NO",
        "build",
      ]),
    );
    expect(iosJobCleanupTargets({ udid: "UDID-1", checkoutPath: "/work/repository" })).toEqual(
      expect.arrayContaining(["simctl shutdown UDID-1", "simctl delete UDID-1"]),
    );
  });

  it("reads the exact reserved UDID from simctl JSON", () => {
    const listed = parseSimctlDeviceList(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
            { udid: "AAAA-BBBB", name: "iPhone 16", state: "Shutdown", isAvailable: true },
            { udid: "CCCC-DDDD", name: "t3-ios-allocation1-1", state: "Booted", isAvailable: true },
          ],
        },
      }),
      "t3-ios-allocation1-1",
    );

    expect(listed).toEqual({
      udid: "CCCC-DDDD",
      state: "Booted",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-5",
    });
  });
});
