import * as Schema from "effect/Schema";

import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentVersionId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { CloudAllocationControllerStatus, CloudControllerDefaults } from "./cloudAllocation.ts";
import { CloudEnvironmentSecretReference, CloudEnvironmentSource } from "./cloudEnvironment.ts";
import { CloudSecurityReport } from "./cloudSecurity.ts";

/**
 * Each check probes one thing an operator can fix on its own, so a failing
 * IAM policy never hides a missing KVM host. They are always reported
 * together and always run separately.
 */
export const CloudReadinessCheckId = Schema.Literals([
  "execution-iam",
  "hypervisor-kvm",
  "image-access",
  "snapshot-access",
  "artifact-storage",
  "guest-registration",
  "ssm-diagnostics",
]);
export type CloudReadinessCheckId = typeof CloudReadinessCheckId.Type;

export const CLOUD_READINESS_CHECK_IDS = [
  "execution-iam",
  "hypervisor-kvm",
  "image-access",
  "snapshot-access",
  "artifact-storage",
  "guest-registration",
  "ssm-diagnostics",
] as const satisfies ReadonlyArray<CloudReadinessCheckId>;

/** Only `ssm-diagnostics` is optional; the rest gate a working allocation. */
export const CLOUD_READINESS_OPTIONAL_CHECK_IDS = [
  "ssm-diagnostics",
] as const satisfies ReadonlyArray<CloudReadinessCheckId>;

export const CloudReadinessCheckOutcome = Schema.Union([
  /** Nothing has probed this yet on this controller process. */
  Schema.Struct({ status: Schema.Literal("unchecked") }),
  Schema.Struct({
    status: Schema.Literal("passed"),
    detail: TrimmedNonEmptyString,
    checkedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: TrimmedNonEmptyString,
    remedy: TrimmedNonEmptyString,
    checkedAt: IsoDateTime,
  }),
  /** Not applicable to this deployment, such as KVM on the EC2 fallback. */
  Schema.Struct({
    status: Schema.Literal("skipped"),
    detail: TrimmedNonEmptyString,
    checkedAt: IsoDateTime,
  }),
]);
export type CloudReadinessCheckOutcome = typeof CloudReadinessCheckOutcome.Type;

export const CloudReadinessCheck = Schema.Struct({
  id: CloudReadinessCheckId,
  title: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  optional: Schema.Boolean,
  outcome: CloudReadinessCheckOutcome,
});
export type CloudReadinessCheck = typeof CloudReadinessCheck.Type;

export const CloudReadinessAccountRole = Schema.Literals(["controller", "execution"]);
export type CloudReadinessAccountRole = typeof CloudReadinessAccountRole.Type;

/**
 * Identity only. The controller never puts an access key, a session token, or
 * a hypervisor credential path into this report, because every client that can
 * read settings would receive it.
 */
export const CloudReadinessAccount = Schema.Struct({
  role: CloudReadinessAccountRole,
  region: TrimmedNonEmptyString,
  project: TrimmedNonEmptyString,
  accountId: Schema.optionalKey(TrimmedNonEmptyString),
  /** Reported by `sts get-caller-identity` during the IAM check. */
  observedAccountId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudReadinessAccount = typeof CloudReadinessAccount.Type;

export const CloudReadinessHypervisor = Schema.Struct({
  id: TrimmedNonEmptyString,
  accountId: TrimmedNonEmptyString,
  kvm: Schema.Boolean,
  profiles: Schema.Array(TrimmedNonEmptyString),
  cpuMillis: NonNegativeInt,
  memoryMib: NonNegativeInt,
  diskGib: NonNegativeInt,
  cpuOversubscribeRatio: Schema.Finite,
  guestImageVersion: Schema.optionalKey(TrimmedNonEmptyString),
  hypervisorImageVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudReadinessHypervisor = typeof CloudReadinessHypervisor.Type;

export const CloudReadinessRuntime = Schema.Struct({
  kind: Schema.Literals(["firecracker", "ec2-fallback"]),
  parity: Schema.Literals(["cursor-firecracker", "ec2-migration-fallback"]),
  hypervisors: Schema.Array(CloudReadinessHypervisor),
  /** Slot capacity across the fleet, before oversubscription. */
  slots: Schema.Struct({
    hosts: NonNegativeInt,
    cpuMillis: NonNegativeInt,
    memoryMib: NonNegativeInt,
    diskGib: NonNegativeInt,
  }),
  desiredHosts: NonNegativeInt,
  warmGuestsReady: NonNegativeInt,
});
export type CloudReadinessRuntime = typeof CloudReadinessRuntime.Type;

export const CloudReadinessEnvironment = Schema.Struct({
  environmentId: CloudEnvironmentId,
  name: TrimmedNonEmptyString,
  version: PositiveInt,
  versionId: CloudEnvironmentVersionId,
  source: CloudEnvironmentSource,
  activeBuildId: Schema.optionalKey(CloudEnvironmentBuildId),
  activeBuildVersion: Schema.optionalKey(PositiveInt),
  activeBuildSnapshotId: Schema.optionalKey(TrimmedNonEmptyString),
  activeBuildFreshAt: Schema.optionalKey(IsoDateTime),
  staleBuildThresholdSeconds: NonNegativeInt,
  buildStale: Schema.Boolean,
  egressMode: Schema.Literals([
    "allow_all",
    "parent_plus_network_settings",
    "default_with_network_settings",
    "network_settings_only",
  ]),
  egressAllowlist: Schema.Array(TrimmedNonEmptyString),
  /** Names and references only; the controller never sends secret values. */
  secrets: Schema.Array(CloudEnvironmentSecretReference),
});
export type CloudReadinessEnvironment = typeof CloudReadinessEnvironment.Type;

export const CloudReadinessSnapshotPolicy = Schema.Struct({
  snapshotRetentionDays: NonNegativeInt,
  conversationRetentionDays: NonNegativeInt,
  idleReleaseSeconds: NonNegativeInt,
  hibernatedRuntimes: NonNegativeInt,
  /** Agents whose disks were permanently deleted under CA-46. */
  recordedDeletions: NonNegativeInt,
});
export type CloudReadinessSnapshotPolicy = typeof CloudReadinessSnapshotPolicy.Type;

export const CloudReadinessHealth = Schema.Struct({
  controller: CloudAllocationControllerStatus,
  activeRuns: NonNegativeInt,
  queuedRuns: NonNegativeInt,
  maxConcurrentWorkers: PositiveInt,
  /** False while any required check has failed. Unchecked is not a failure. */
  requiredChecksPassing: Schema.Boolean,
  failedCheckIds: Schema.Array(CloudReadinessCheckId),
});
export type CloudReadinessHealth = typeof CloudReadinessHealth.Type;

/**
 * Where a run's environment comes from, most specific first. The same order
 * the controller resolves in, so the screen cannot drift from the resolver.
 */
export const CloudReadinessConfigSource = Schema.Struct({
  rank: PositiveInt,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  /** Whether at least one environment currently resolves from this source. */
  present: Schema.Boolean,
});
export type CloudReadinessConfigSource = typeof CloudReadinessConfigSource.Type;

export const CloudReadinessSettings = Schema.Struct({
  configPrecedence: Schema.Array(CloudReadinessConfigSource),
  defaults: CloudControllerDefaults,
  allowedInstanceTypes: Schema.Array(TrimmedNonEmptyString),
});
export type CloudReadinessSettings = typeof CloudReadinessSettings.Type;

export const CloudReadinessReport = Schema.Struct({
  generatedAt: IsoDateTime,
  accounts: Schema.Array(CloudReadinessAccount),
  runtime: CloudReadinessRuntime,
  environments: Schema.Array(CloudReadinessEnvironment),
  snapshotPolicy: CloudReadinessSnapshotPolicy,
  health: CloudReadinessHealth,
  settings: CloudReadinessSettings,
  /** Absent when decoding a report from a controller older than CA-49. */
  security: Schema.optionalKey(CloudSecurityReport),
  checks: Schema.Array(CloudReadinessCheck),
});
export type CloudReadinessReport = typeof CloudReadinessReport.Type;

export const CloudReadinessCheckInput = Schema.Struct({
  checks: Schema.Array(CloudReadinessCheckId).pipe(Schema.check(Schema.isMinLength(1))),
});
export type CloudReadinessCheckInput = typeof CloudReadinessCheckInput.Type;

/**
 * One pass of guided setup: save a version and start the Build that tests it.
 *
 * Activation is the Build catalog's job, and only a successful, saved Build
 * repoints an environment. That is what keeps the last good snapshot serving
 * runs while a new version is still being proved, so this call returns the
 * Build that stays active if the new one fails.
 *
 * A repository-owned environment is created by the agent-led setup flow, never
 * by this form, so `scope` covers only the saved scopes.
 */
export const CloudGuidedSetupBase = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("image"), image: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("dockerfile"), dockerfile: TrimmedNonEmptyString }),
]);
export type CloudGuidedSetupBase = typeof CloudGuidedSetupBase.Type;

export const CloudGuidedSetupInput = Schema.Struct({
  environmentId: CloudEnvironmentId,
  buildId: CloudEnvironmentBuildId,
  /** Omitted when creating; required to add a version to an existing one. */
  expectedVersion: Schema.optionalKey(PositiveInt),
  name: TrimmedNonEmptyString,
  scope: Schema.Literals(["personal", "team", "default"]),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  repository: TrimmedNonEmptyString,
  defaultRef: TrimmedNonEmptyString,
  base: CloudGuidedSetupBase,
  install: Schema.optionalKey(Schema.String),
  start: Schema.optionalKey(Schema.String),
  secretReferences: Schema.Array(CloudEnvironmentSecretReference),
  occurredAt: IsoDateTime,
});
export type CloudGuidedSetupInput = typeof CloudGuidedSetupInput.Type;

export const CloudGuidedSetupResult = Schema.Struct({
  environmentId: CloudEnvironmentId,
  versionId: CloudEnvironmentVersionId,
  version: PositiveInt,
  buildId: CloudEnvironmentBuildId,
  /** Keeps serving runs unless and until the new Build succeeds. */
  retainedBuildId: Schema.optionalKey(CloudEnvironmentBuildId),
});
export type CloudGuidedSetupResult = typeof CloudGuidedSetupResult.Type;

export class CloudReadinessError extends Schema.TaggedError<CloudReadinessError>()(
  "CloudReadinessError",
  {
    reason: Schema.Literals([
      "controller-disabled",
      "controller-unavailable",
      "invalid-request",
      "check-failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
