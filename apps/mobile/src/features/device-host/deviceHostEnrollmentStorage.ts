import {
  AndroidDeviceHostEnrollment,
  UNENROLLED_ANDROID_DEVICE_HOST,
  type AndroidDeviceHostEnrollment as AndroidDeviceHostEnrollmentValue,
} from "@t3tools/client-runtime/android-device-host";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";

const STORAGE_KEY = "t3.android-device-host-enrollment.v1";
const decodeEnrollment = Schema.decodeUnknownSync(AndroidDeviceHostEnrollment);

export interface DeviceHostEnrollmentStorage {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

const secureStorage: DeviceHostEnrollmentStorage = {
  getItem: SecureStore.getItemAsync,
  setItem: SecureStore.setItemAsync,
};

export async function loadDeviceHostEnrollment(
  storage: DeviceHostEnrollmentStorage = secureStorage,
): Promise<AndroidDeviceHostEnrollmentValue> {
  const persisted = await storage.getItem(STORAGE_KEY);
  if (persisted === null) return UNENROLLED_ANDROID_DEVICE_HOST;
  try {
    return decodeEnrollment(JSON.parse(persisted));
  } catch {
    return UNENROLLED_ANDROID_DEVICE_HOST;
  }
}

export async function saveDeviceHostEnrollment(
  enrollment: AndroidDeviceHostEnrollmentValue,
  storage: DeviceHostEnrollmentStorage = secureStorage,
): Promise<void> {
  await storage.setItem(STORAGE_KEY, JSON.stringify(enrollment));
}
