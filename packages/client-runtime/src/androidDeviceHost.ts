import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const PermissionState = Schema.Literals(["not-requested", "denied", "granted"]);
export type AndroidDeviceHostPermissionState = typeof PermissionState.Type;

const Permissions = Schema.Struct({
  screenCapture: PermissionState,
  accessibility: PermissionState,
  vpn: PermissionState,
  wirelessDebugging: PermissionState,
});

const Unenrolled = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("unenrolled"),
});

const Enrolled = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("enrolled"),
  deviceHostId: Schema.String,
  name: Schema.String,
  environmentId: EnvironmentId,
  enrolledAt: Schema.String,
  paused: Schema.Boolean,
  permissions: Permissions,
});

export const AndroidDeviceHostEnrollment = Schema.Union([Unenrolled, Enrolled]);
export type AndroidDeviceHostEnrollment = typeof AndroidDeviceHostEnrollment.Type;

export const UNENROLLED_ANDROID_DEVICE_HOST: AndroidDeviceHostEnrollment = {
  version: 1,
  status: "unenrolled",
};

export function enrollAndroidDeviceHost(input: {
  readonly platform: string;
  readonly deviceHostId: string;
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly now: string;
}): AndroidDeviceHostEnrollment {
  if (input.platform !== "android") return UNENROLLED_ANDROID_DEVICE_HOST;
  return {
    version: 1,
    status: "enrolled",
    deviceHostId: input.deviceHostId,
    name: input.name.trim() || "Android phone",
    environmentId: input.environmentId,
    enrolledAt: input.now,
    paused: false,
    permissions: {
      screenCapture: "not-requested",
      accessibility: "not-requested",
      vpn: "not-requested",
      wirelessDebugging: "not-requested",
    },
  };
}

export function renameAndroidDeviceHost(
  enrollment: AndroidDeviceHostEnrollment,
  name: string,
): AndroidDeviceHostEnrollment {
  if (enrollment.status === "unenrolled" || name.trim().length === 0) return enrollment;
  return { ...enrollment, name: name.trim() };
}

export function setAndroidDeviceHostPaused(
  enrollment: AndroidDeviceHostEnrollment,
  paused: boolean,
): AndroidDeviceHostEnrollment {
  return enrollment.status === "unenrolled" ? enrollment : { ...enrollment, paused };
}

export function revokeAndroidDeviceHost(): AndroidDeviceHostEnrollment {
  return UNENROLLED_ANDROID_DEVICE_HOST;
}

export type AndroidDeviceControlRuntime =
  | { readonly status: "inactive" }
  | {
      readonly status: "active";
      readonly activity: "screen-capture" | "agent-input" | "screen-capture-and-agent-input";
      readonly environmentId: EnvironmentId;
      readonly threadId: string;
      readonly leaseId: string;
    };

export function stopAndroidDeviceControl(): AndroidDeviceControlRuntime {
  return { status: "inactive" };
}

export function androidDeviceHostIndicators(input: {
  readonly enrollment: AndroidDeviceHostEnrollment;
  readonly control: AndroidDeviceControlRuntime;
}) {
  if (input.enrollment.status === "unenrolled") {
    return {
      metro: "Not connected",
      device: "Not enrolled",
      permissions: "Not requested",
      lease: "No agent input lease",
    } as const;
  }
  const granted = Object.values(input.enrollment.permissions).filter(
    (permission) => permission === "granted",
  ).length;
  return {
    metro: "No Metro link published",
    device: input.enrollment.paused ? "Paused" : "Broker not installed",
    permissions: `${granted}/4 granted`,
    lease:
      input.control.status === "active"
        ? input.control.activity === "agent-input"
          ? "Agent input active"
          : input.control.activity === "screen-capture"
            ? "Screen capture active"
            : "Screen capture and agent input active"
        : "No agent input lease",
  } as const;
}
