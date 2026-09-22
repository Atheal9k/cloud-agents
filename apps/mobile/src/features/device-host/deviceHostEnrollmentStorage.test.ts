import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import {
  loadDeviceHostEnrollment,
  saveDeviceHostEnrollment,
  type DeviceHostEnrollmentStorage,
} from "./deviceHostEnrollmentStorage";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const storage: DeviceHostEnrollmentStorage = {
    getItem: async () => value,
    setItem: async (_key, next) => {
      value = next;
    },
  };
  return { storage, read: () => value };
}

describe("device host enrollment storage", () => {
  it("round trips the controller-bound enrollment", async () => {
    const memory = memoryStorage();
    await saveDeviceHostEnrollment(
      {
        version: 1,
        status: "enrolled",
        deviceHostId: "phone-1",
        name: "Pixel 9",
        environmentId: EnvironmentId.make("controller-1"),
        enrolledAt: "2026-09-22T00:00:00.000Z",
        paused: false,
        permissions: {
          screenCapture: "not-requested",
          accessibility: "not-requested",
          vpn: "not-requested",
          wirelessDebugging: "not-requested",
        },
      },
      memory.storage,
    );
    expect(memory.read()).toContain("controller-1");
    await expect(loadDeviceHostEnrollment(memory.storage)).resolves.toMatchObject({
      status: "enrolled",
      environmentId: "controller-1",
    });
  });

  it("fails closed when persisted data is invalid", async () => {
    const memory = memoryStorage('{"status":"enrolled","permissions":{"screenCapture":"granted"}}');
    await expect(loadDeviceHostEnrollment(memory.storage)).resolves.toEqual({
      version: 1,
      status: "unenrolled",
    });
  });
});
