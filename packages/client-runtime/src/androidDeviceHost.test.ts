import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  androidDeviceHostIndicators,
  enrollAndroidDeviceHost,
  revokeAndroidDeviceHost,
  setAndroidDeviceHostPaused,
} from "./androidDeviceHost.ts";

describe("Android device host enrollment", () => {
  it("binds an Android phone without granting privileged permissions", () => {
    const enrolled = enrollAndroidDeviceHost({
      platform: "android",
      deviceHostId: "phone-1",
      name: "Pixel 9",
      environmentId: EnvironmentId.make("controller-1"),
      now: "2026-09-22T00:00:00.000Z",
    });
    expect(enrolled).toMatchObject({
      status: "enrolled",
      paused: false,
      permissions: {
        screenCapture: "not-requested",
        accessibility: "not-requested",
        vpn: "not-requested",
        wirelessDebugging: "not-requested",
      },
    });
  });

  it("reports Metro, broker, permission, and lease state separately", () => {
    const enrollment = enrollAndroidDeviceHost({
      platform: "android",
      deviceHostId: "phone-1",
      name: "Pixel 9",
      environmentId: EnvironmentId.make("controller-1"),
      now: "2026-09-22T00:00:00.000Z",
    });
    expect(androidDeviceHostIndicators({ enrollment, control: { status: "inactive" } })).toEqual({
      metro: "No Metro link published",
      device: "Broker not installed",
      permissions: "0/4 granted",
      lease: "No agent input lease",
    });
  });

  it("pauses and revokes locally without a controller round trip", () => {
    const enrollment = enrollAndroidDeviceHost({
      platform: "android",
      deviceHostId: "phone-1",
      name: "Pixel 9",
      environmentId: EnvironmentId.make("controller-1"),
      now: "2026-09-22T00:00:00.000Z",
    });
    expect(setAndroidDeviceHostPaused(enrollment, true)).toMatchObject({ paused: true });
    expect(revokeAndroidDeviceHost()).toEqual({ version: 1, status: "unenrolled" });
  });

  it("does not enroll unsupported platforms", () => {
    expect(
      enrollAndroidDeviceHost({
        platform: "ios",
        deviceHostId: "phone-1",
        name: "iPhone",
        environmentId: EnvironmentId.make("controller-1"),
        now: "2026-09-22T00:00:00.000Z",
      }),
    ).toEqual({ version: 1, status: "unenrolled" });
  });
});
