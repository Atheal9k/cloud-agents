/**
 * Turns what the controller already knows into the readiness report clients
 * render. Pure on purpose: the redaction rule (no credential ever leaves here)
 * is then a property of a function rather than of a request handler.
 */
import {
  CLOUD_READINESS_OPTIONAL_CHECK_IDS,
  DEFAULT_SNAPSHOT_RETENTION_DAYS,
  DEFAULT_STALE_BUILD_THRESHOLD_SECONDS,
  type CloudAllocationSnapshot,
  type CloudEnvironment,
  type CloudEnvironmentBuild,
  type CloudEnvironmentSource,
  type CloudReadinessCheck,
  type CloudReadinessCheckId,
  type CloudReadinessCheckOutcome,
  type CloudReadinessConfigSource,
  type CloudReadinessEnvironment,
  type CloudReadinessReport,
} from "@t3tools/contracts";

import type { ResolvedAwsWorkerConfig } from "./awsWorkerConfig.ts";
import { isCloudEnvironmentBuildStale } from "./cloudEnvironmentBuildPolicy.ts";
import { runtimeParity } from "./firecrackerPlacement.ts";

interface CheckDescriptor {
  readonly id: CloudReadinessCheckId;
  readonly title: string;
  readonly description: string;
}

/**
 * Wording lives with the check rather than in the UI so the same sentence
 * reaches the web screen, a future API consumer, and the logs.
 */
export const CLOUD_READINESS_CHECK_DESCRIPTORS = [
  {
    id: "execution-iam",
    title: "Execution IAM",
    description:
      "The controller's AWS credentials resolve and belong to the configured execution account.",
  },
  {
    id: "hypervisor-kvm",
    title: "KVM and Firecracker support",
    description: "Every hypervisor in the fleet reports usable KVM for Firecracker guests.",
  },
  {
    id: "image-access",
    title: "Image access",
    description:
      "Each worker profile resolves to exactly one launch template the controller can read.",
  },
  {
    id: "snapshot-access",
    title: "Snapshot access",
    description:
      "Snapshots are readable and every active Build still points at a snapshot a run can boot.",
  },
  {
    id: "artifact-storage",
    title: "Artifact storage",
    description: "The retained-results directory on the controller host exists and accepts writes.",
  },
  {
    id: "guest-registration",
    title: "Guest registration",
    description: "Workers are enumerable and running guests still carry a registration credential.",
  },
  {
    id: "ssm-diagnostics",
    title: "SSM diagnostics",
    description: "The optional recovery-diagnostics document is present for operational debugging.",
  },
] as const satisfies ReadonlyArray<CheckDescriptor>;

const OPTIONAL_CHECK_IDS: ReadonlySet<CloudReadinessCheckId> = new Set(
  CLOUD_READINESS_OPTIONAL_CHECK_IDS,
);

export function isOptionalCloudReadinessCheck(id: CloudReadinessCheckId): boolean {
  return OPTIONAL_CHECK_IDS.has(id);
}

function sourceRank(source: CloudEnvironmentSource): number {
  if (source.type === "repository") return 1;
  return source.scope === "personal" ? 2 : source.scope === "team" ? 3 : 4;
}

const CONFIG_PRECEDENCE = [
  {
    rank: 1,
    label: "Repository config",
    description: "`.cursor/environment.json` or `t3.cloud.json` on the resolved commit.",
  },
  {
    rank: 2,
    label: "Personal environment",
    description: "A saved environment owned by one operator.",
  },
  {
    rank: 3,
    label: "Team environment",
    description: "A saved environment shared by a team.",
  },
  {
    rank: 4,
    label: "Default environment",
    description: "The fallback used when nothing more specific matches.",
  },
] as const;

function environmentSummary(
  environment: CloudEnvironment,
  builds: ReadonlyArray<CloudEnvironmentBuild>,
  now: string,
): CloudReadinessEnvironment {
  const staleThresholdSeconds =
    environment.staleBuildThresholdSeconds ?? DEFAULT_STALE_BUILD_THRESHOLD_SECONDS;
  const activeBuild = builds.find((build) => build.id === environment.activeBuildId);
  const snapshotId =
    activeBuild?.outcome.status === "succeeded" ? activeBuild.outcome.snapshot.id : undefined;
  return {
    environmentId: environment.id,
    name: environment.current.name,
    version: environment.current.version,
    versionId: environment.current.id,
    source: environment.current.source,
    ...(environment.activeBuildId === undefined
      ? {}
      : { activeBuildId: environment.activeBuildId }),
    ...(activeBuild === undefined ? {} : { activeBuildVersion: activeBuild.version }),
    ...(snapshotId === undefined ? {} : { activeBuildSnapshotId: snapshotId }),
    ...(activeBuild?.freshAt === undefined ? {} : { activeBuildFreshAt: activeBuild.freshAt }),
    staleBuildThresholdSeconds: staleThresholdSeconds,
    buildStale: isCloudEnvironmentBuildStale({ build: activeBuild, staleThresholdSeconds, now }),
    egressMode: environment.current.effectivePolicy.egressMode,
    egressAllowlist: environment.current.effectivePolicy.egressAllowlist,
    secrets: environment.current.effectivePolicy.secrets,
  };
}

export interface CloudReadinessModelInput {
  readonly config: ResolvedAwsWorkerConfig;
  readonly snapshot: CloudAllocationSnapshot;
  readonly outcomes: ReadonlyMap<CloudReadinessCheckId, CloudReadinessCheckOutcome>;
  /** Account ids the IAM check actually observed, when it has run. */
  readonly observedAccountIds?: {
    readonly controller?: string;
    readonly execution?: string;
  };
  readonly now: string;
}

export function buildCloudReadinessReport(input: CloudReadinessModelInput): CloudReadinessReport {
  const { config, snapshot } = input;
  const builds = snapshot.builds ?? [];
  const environments = (snapshot.environments ?? []).map((environment) =>
    environmentSummary(environment, builds, input.now),
  );

  const checks: ReadonlyArray<CloudReadinessCheck> = CLOUD_READINESS_CHECK_DESCRIPTORS.map(
    (descriptor) => ({
      id: descriptor.id,
      title: descriptor.title,
      description: descriptor.description,
      optional: isOptionalCloudReadinessCheck(descriptor.id),
      outcome: input.outcomes.get(descriptor.id) ?? { status: "unchecked" },
    }),
  );
  const failedCheckIds = checks
    .filter((check) => !check.optional && check.outcome.status === "failed")
    .map((check) => check.id);

  const presentRanks = new Set(
    (snapshot.environments ?? []).map((environment) => sourceRank(environment.current.source)),
  );
  const configPrecedence: ReadonlyArray<CloudReadinessConfigSource> = CONFIG_PRECEDENCE.map(
    (entry) => ({ ...entry, present: presentRanks.has(entry.rank) }),
  );

  const activeRuns = (snapshot.runs ?? []).filter(
    (run) => run.status === "CREATING" || run.status === "RUNNING",
  ).length;
  const queuedRuns = snapshot.allocations.filter(
    (allocation) => allocation.allocationState.status === "queued",
  ).length;
  const hibernatedRuntimes = (snapshot.runtimeAttempts ?? []).filter(
    (runtime) => runtime.status === "HIBERNATED",
  ).length;

  return {
    generatedAt: input.now,
    accounts: [
      {
        role: "controller",
        region: config.region,
        project: config.project,
        ...(config.controllerAccountId === undefined
          ? {}
          : { accountId: config.controllerAccountId }),
        ...(input.observedAccountIds?.controller === undefined
          ? {}
          : { observedAccountId: input.observedAccountIds.controller }),
      },
      {
        role: "execution",
        region: config.region,
        project: config.project,
        ...(config.executionAccountId === undefined
          ? {}
          : { accountId: config.executionAccountId }),
        ...(input.observedAccountIds?.execution === undefined
          ? {}
          : { observedAccountId: input.observedAccountIds.execution }),
      },
    ],
    runtime: {
      kind: config.runtimeKind,
      parity: runtimeParity(config.runtimeKind),
      // `credentialsPath` is deliberately dropped: the fleet entry is the only
      // place a hypervisor credential location appears on the controller.
      hypervisors: config.hypervisors.map((host) => ({
        id: host.id,
        accountId: host.accountId,
        kvm: host.kvm,
        profiles: host.profiles,
        cpuMillis: host.cpuMillis,
        memoryMib: host.memoryMib,
        diskGib: host.diskGib,
        cpuOversubscribeRatio: host.cpuOversubscribeRatio,
        ...(host.guestImageVersion === undefined
          ? {}
          : { guestImageVersion: host.guestImageVersion }),
        ...(host.hypervisorImageVersion === undefined
          ? {}
          : { hypervisorImageVersion: host.hypervisorImageVersion }),
      })),
      slots: {
        hosts: config.hypervisors.length,
        cpuMillis: config.hypervisors.reduce((total, host) => total + host.cpuMillis, 0),
        memoryMib: config.hypervisors.reduce((total, host) => total + host.memoryMib, 0),
        diskGib: config.hypervisors.reduce((total, host) => total + host.diskGib, 0),
      },
      desiredHosts: snapshot.capacity?.desiredHosts ?? 0,
      warmGuestsReady: (snapshot.warmGuests ?? []).filter((guest) => guest.status === "ready")
        .length,
    },
    environments,
    snapshotPolicy: {
      snapshotRetentionDays: DEFAULT_SNAPSHOT_RETENTION_DAYS,
      conversationRetentionDays: snapshot.limits.conversationRetentionDays,
      idleReleaseSeconds: snapshot.limits.idleReleaseSeconds,
      hibernatedRuntimes,
      recordedDeletions: (snapshot.deletions ?? []).length,
    },
    health: {
      controller: snapshot.controller,
      activeRuns,
      queuedRuns,
      maxConcurrentWorkers: snapshot.limits.maxConcurrentWorkers,
      requiredChecksPassing: failedCheckIds.length === 0,
      failedCheckIds,
    },
    settings: {
      configPrecedence,
      defaults: snapshot.controller.defaults ?? {},
      allowedInstanceTypes: snapshot.limits.allowedInstanceTypes,
    },
    checks,
  };
}
