import * as Schema from "effect/Schema";

import {
  CheckpointRef,
  IsoDateTime,
  NonNegativeInt,
  RunAllocationAttempt,
  RunAllocationId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { CloudEnvironmentVersion } from "./cloudEnvironment.ts";
import { CloudEnvironmentRuntimeBootRecord } from "./cloudEnvironmentRecipe.ts";

/**
 * What a person can hold open on a runtime. Each kind is leased separately
 * because they end at different times: closing the app preview says nothing
 * about the desktop someone is still watching, and a question waiting on an
 * answer outlives both.
 */
export const CloudSessionLeaseKind = Schema.Literals(["app-preview", "desktop-viewer", "input"]);
export type CloudSessionLeaseKind = typeof CloudSessionLeaseKind.Type;

export const CLOUD_SESSION_LEASE_KINDS = [
  "app-preview",
  "desktop-viewer",
  "input",
] as const satisfies ReadonlyArray<CloudSessionLeaseKind>;

/** 15 minutes. One lease term; a heartbeat buys another one, not an extension. */
export const DEFAULT_PREVIEW_LEASE_SECONDS = 15 * 60;

/**
 * 4 hours. The ceiling every renewal is clamped to, measured from when the
 * lease was first opened. This is the whole point of leasing rather than
 * heartbeating: a forgotten tab cannot hold a guest indefinitely.
 */
export const DEFAULT_PREVIEW_LEASE_MAX_SECONDS = 4 * 60 * 60;

/**
 * One held session. `hardExpiresAt` never moves, so the difference between it
 * and `expiresAt` is exactly how much more life a heartbeat can still buy.
 */
export const CloudSessionLease = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("released"),
    /** Absent before the lease has ever been held. */
    releasedAt: Schema.optionalKey(IsoDateTime),
    reason: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    status: Schema.Literal("held"),
    /** The runtime attempt the lease was opened against. A replacement voids it. */
    attempt: RunAllocationAttempt,
    openedAt: IsoDateTime,
    heartbeatAt: IsoDateTime,
    expiresAt: IsoDateTime,
    hardExpiresAt: IsoDateTime,
  }),
]);
export type CloudSessionLease = typeof CloudSessionLease.Type;

export const CloudSessionLeases = Schema.Struct({
  appPreview: CloudSessionLease,
  desktopViewer: CloudSessionLease,
  input: CloudSessionLease,
});
export type CloudSessionLeases = typeof CloudSessionLeases.Type;

const released: CloudSessionLease = { status: "released" };

export function emptyCloudSessionLeases(): CloudSessionLeases {
  return { appPreview: released, desktopViewer: released, input: released };
}

const LEASE_FIELD_BY_KIND = {
  "app-preview": "appPreview",
  "desktop-viewer": "desktopViewer",
  input: "input",
} as const satisfies Record<CloudSessionLeaseKind, keyof CloudSessionLeases>;

export function cloudSessionLeaseField(kind: CloudSessionLeaseKind): keyof CloudSessionLeases {
  return LEASE_FIELD_BY_KIND[kind];
}

export function cloudSessionLease(
  leases: CloudSessionLeases,
  kind: CloudSessionLeaseKind,
): CloudSessionLease {
  return leases[LEASE_FIELD_BY_KIND[kind]];
}

/**
 * Whether a reopened browser came back with the person still logged in. A
 * fresh profile is a real answer and has to be said out loud: a preview that
 * silently lost its session looks like a broken app, and a profile that did
 * persist carries live cookies, so it is never part of a retained result.
 */
export const CloudBrowserPersistence = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("persisted"),
    profilePath: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  }),
  Schema.Struct({ status: Schema.Literal("fresh"), reason: TrimmedNonEmptyString }),
]);
export type CloudBrowserPersistence = typeof CloudBrowserPersistence.Type;

/**
 * What a person changed by hand while the preview was open. The edits land as
 * a checkpoint and a diff, never as a push: a reopened preview is not allowed
 * to rewrite the pull request the run already published.
 */
export const CloudSessionEdits = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("captured"),
    baseRef: CheckpointRef,
    editsRef: CheckpointRef,
    changedFiles: NonNegativeInt,
    diffSizeChars: NonNegativeInt,
    capturedAt: IsoDateTime,
    /** False by construction: this path never talks to a remote. */
    publicationRewritten: Schema.Literal(false),
  }),
  Schema.Struct({ status: Schema.Literal("unchanged"), capturedAt: IsoDateTime }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: TrimmedNonEmptyString }),
]);
export type CloudSessionEdits = typeof CloudSessionEdits.Type;

/** Guest-served routes. The controller is the only caller. */
export const CLOUD_RUNTIME_REOPEN_PATH = "/api/cloud/workers/reopen";
export const CLOUD_SESSION_EDITS_PATH = "/api/cloud/workers/session-edits";

/**
 * Asks a woken guest to make itself viewable again: run the environment's
 * per-boot `start`, report whether the browser kept its logins, and take the
 * baseline the person's own edits will be diffed against.
 */
export const CloudRuntimeReopenInput = Schema.Struct({
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  threadId: ThreadId,
  version: CloudEnvironmentVersion,
});
export type CloudRuntimeReopenInput = typeof CloudRuntimeReopenInput.Type;

export const CloudRuntimeReopen = Schema.Struct({
  environmentStart: CloudEnvironmentRuntimeBootRecord,
  browser: CloudBrowserPersistence,
  baseRef: Schema.optionalKey(CheckpointRef),
  reopenedAt: IsoDateTime,
  /** False by construction: reopening never submits a turn to the provider. */
  providerRunStarted: Schema.Literal(false),
});
export type CloudRuntimeReopen = typeof CloudRuntimeReopen.Type;

/** Asks a reopened guest to capture the edits a person made before it stops. */
export const CloudSessionEditsInput = Schema.Struct({
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  threadId: ThreadId,
});
export type CloudSessionEditsInput = typeof CloudSessionEditsInput.Type;
