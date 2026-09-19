import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DevicePlatform } from "./device.ts";

export const DeviceDisplayViewerId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type DeviceDisplayViewerId = typeof DeviceDisplayViewerId.Type;

export const DeviceDisplayTransport = Schema.Literals(["serve-emu", "serve-sim"]);
export type DeviceDisplayTransport = typeof DeviceDisplayTransport.Type;

export const DeviceDisplayConnectionState = Schema.Literals([
  "connecting",
  "booted",
  "app-running",
  "unavailable",
]);
export type DeviceDisplayConnectionState = typeof DeviceDisplayConnectionState.Type;

export const DeviceDisplaySession = Schema.Struct({
  platform: DevicePlatform,
  transport: DeviceDisplayTransport,
  deviceName: TrimmedNonEmptyString,
  runtime: TrimmedNonEmptyString,
  serial: Schema.optionalKey(TrimmedNonEmptyString),
  udid: Schema.optionalKey(TrimmedNonEmptyString),
  buildRevision: TrimmedNonEmptyString,
  connectionState: DeviceDisplayConnectionState,
}).check(
  Schema.makeFilter((session) => {
    if (session.platform === "android") {
      if (session.transport !== "serve-emu") {
        return "Android device display uses the serve-emu transport, not DCV.";
      }
      if (session.serial === undefined) return "Android device display requires an ADB serial.";
    } else {
      if (session.transport !== "serve-sim") {
        return "iOS device display uses the serve-sim transport, not DCV.";
      }
      if (session.udid === undefined) return "iOS device display requires a Simulator UDID.";
    }
    return true;
  }),
);
export type DeviceDisplaySession = typeof DeviceDisplaySession.Type;

export function deviceDisplayId(session: DeviceDisplaySession): string {
  return session.platform === "android" ? (session.serial ?? "") : (session.udid ?? "");
}

export function deviceDisplayTransportFor(
  platform: DeviceDisplaySession["platform"],
): DeviceDisplayTransport {
  return platform === "android" ? "serve-emu" : "serve-sim";
}

export const DeviceDisplayIssueInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeviceDisplayIssueInput = typeof DeviceDisplayIssueInput.Type;

export const DeviceDisplayViewerInput = Schema.Struct({
  threadId: ThreadId,
  viewerId: DeviceDisplayViewerId,
});
export type DeviceDisplayViewerInput = typeof DeviceDisplayViewerInput.Type;

export const DeviceDisplayControlState = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("agent"),
  }),
  Schema.Struct({
    owner: Schema.Literal("human"),
    viewerId: DeviceDisplayViewerId,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    owner: Schema.Literal("none"),
    reason: Schema.Literals([
      "viewer-disconnected",
      "viewer-expired",
      "handoff-failed",
      "hibernated",
    ]),
  }),
]);
export type DeviceDisplayControlState = typeof DeviceDisplayControlState.Type;

export const DeviceDisplayGrant = Schema.Struct({
  viewerId: DeviceDisplayViewerId,
  streamBasePath: TrimmedNonEmptyString,
  attemptKey: TrimmedNonEmptyString,
  session: DeviceDisplaySession,
  expiresAt: IsoDateTime,
  control: DeviceDisplayControlState,
});
export type DeviceDisplayGrant = typeof DeviceDisplayGrant.Type;

export const DeviceDisplayReleaseResult = Schema.Struct({
  released: Schema.Boolean,
});
export type DeviceDisplayReleaseResult = typeof DeviceDisplayReleaseResult.Type;

export class DeviceDisplayError extends Schema.TaggedError<DeviceDisplayError>()(
  "DeviceDisplayError",
  {
    reason: Schema.Literals([
      "unavailable",
      "wrong-thread",
      "lifecycle-failed",
      "viewer-expired",
      "control-busy",
      "control-not-owned",
      "handoff-failed",
      "hibernated",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
