import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DeviceDisplayError,
  DeviceDisplayGrant,
  DeviceDisplaySession,
  deviceDisplayId,
  deviceDisplayTransportFor,
} from "./deviceDisplay.ts";

const decodeSession = Schema.decodeUnknownSync(DeviceDisplaySession);
const decodeGrant = Schema.decodeUnknownSync(DeviceDisplayGrant);

describe("device display contracts", () => {
  it("selects serve-emu for Android and serve-sim for iOS, never DCV", () => {
    expect(deviceDisplayTransportFor("android")).toBe("serve-emu");
    expect(deviceDisplayTransportFor("ios")).toBe("serve-sim");
  });

  it("identifies an Android session by serial", () => {
    const session = decodeSession({
      platform: "android",
      transport: "serve-emu",
      deviceName: "t3-android-allocation1-1",
      runtime: "Android 36",
      serial: "emulator-5554",
      buildRevision: "debug-1",
      connectionState: "booted",
    });
    expect(deviceDisplayId(session)).toBe("emulator-5554");
  });

  it("identifies an iOS session by UDID", () => {
    const session = decodeSession({
      platform: "ios",
      transport: "serve-sim",
      deviceName: "t3-ios-allocation1-1",
      runtime: "iOS 18.5",
      udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      buildRevision: "debug-1",
      connectionState: "app-running",
    });
    expect(deviceDisplayId(session)).toBe("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
  });

  it("rejects DCV and missing device identity per platform", () => {
    expect(() =>
      decodeSession({
        platform: "ios",
        transport: "serve-emu",
        deviceName: "phone",
        runtime: "iOS 18",
        udid: "udid-1",
        buildRevision: "1",
        connectionState: "booted",
      }),
    ).toThrow(/serve-sim/);
    expect(() =>
      decodeSession({
        platform: "android",
        transport: "serve-emu",
        deviceName: "phone",
        runtime: "Android 36",
        buildRevision: "1",
        connectionState: "booted",
      }),
    ).toThrow(/serial/);
  });

  it("keeps Android and iOS grants independently typed", () => {
    const android = decodeGrant({
      viewerId: "viewer-android",
      streamBasePath: "/api/device-display/token-android",
      attemptKey: "allocation-1:1",
      session: {
        platform: "android",
        transport: "serve-emu",
        deviceName: "Pixel",
        runtime: "Android 36",
        serial: "emulator-5554",
        buildRevision: "r1",
        connectionState: "booted",
      },
      expiresAt: "2026-09-19T12:00:00.000Z",
      control: { owner: "agent" },
    });
    const ios = decodeGrant({
      viewerId: "viewer-ios",
      streamBasePath: "/api/device-display/token-ios",
      attemptKey: "allocation-1:1",
      session: {
        platform: "ios",
        transport: "serve-sim",
        deviceName: "iPhone",
        runtime: "iOS 18.5",
        udid: "udid-1",
        buildRevision: "r1",
        connectionState: "booted",
      },
      expiresAt: "2026-09-19T12:00:00.000Z",
      control: { owner: "agent" },
    });
    expect(android.session.platform).toBe("android");
    expect(ios.session.platform).toBe("ios");
    expect(android.session.platform).not.toBe(ios.session.platform);
  });

  it("records hibernation as a control revocation reason", () => {
    const error = new DeviceDisplayError({
      reason: "hibernated",
      message: "The device display route was revoked when the runtime hibernated.",
    });
    expect(error.reason).toBe("hibernated");
  });
});
