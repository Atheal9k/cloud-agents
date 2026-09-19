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
  type CloudSecretDefinition,
  type CloudSecurityPosture,
  type CloudSecurityReport,
} from "@t3tools/contracts";

import type { CloudControllerSecurityConfig, ResolvedAwsWorkerConfig } from "./awsWorkerConfig.ts";
import { isCloudEnvironmentBuildStale } from "./cloudEnvironmentBuildPolicy.ts";
import {
  cloudEgressExceptions,
  cloudEgressPolicyInputFromConfig,
  resolveCloudEgressPolicy,
  resolveCloudSecretBindings,
  verifyCloudEncryptionPosture,
} from "./cloudSecurityPolicy.ts";
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

/**
 * An environment's saved scope says who its secrets belong to: a personal
 * environment resolves the owner's `user` secrets, a team one the team's.
 */
function secretPrincipals(source: CloudEnvironmentSource): {
  readonly userId: string;
  readonly teamId?: string;
} {
  if (source.type === "saved" && source.scope === "personal") return { userId: source.owner };
  if (source.type === "saved" && source.scope === "team") {
    return { userId: "", teamId: source.owner };
  }
  return { userId: "" };
}

function securityPosture(
  environment: CloudEnvironment,
  security: CloudControllerSecurityConfig,
  controllerUrl: string | undefined,
): CloudSecurityPosture {
  const version = environment.current;
  const definitions: ReadonlyArray<CloudSecretDefinition> = version.secretReferences.map(
    (secret) => ({
      name: secret.name,
      reference: secret.reference,
      availability: secret.availability,
      scope: secret.scope ?? "environment",
      ...(secret.owner === undefined ? {} : { owner: secret.owner }),
      ...(secret.scope === undefined || secret.scope === "environment"
        ? { environmentId: version.environmentId }
        : {}),
    }),
  );
  const principals = secretPrincipals(version.source);
  const resolveFor = (phase: "build" | "runtime") =>
    resolveCloudSecretBindings({
      definitions,
      phase,
      environmentId: version.environmentId,
      userId: principals.userId,
      ...(principals.teamId === undefined ? {} : { teamId: principals.teamId }),
    }).bindings;

  return {
    environmentId: environment.id,
    egress: resolveCloudEgressPolicy({
      team: security.egress,
      // The catalog has already applied the config's defaults, so reading the
      // effective policy keeps this from defaulting a second time.
      environment: cloudEgressPolicyInputFromConfig(version.effectivePolicy),
      exceptions: cloudEgressExceptions({
        controllerHost: controllerHostOf(controllerUrl),
        scmHosts: security.scmHosts,
        artifactHosts: security.artifactHosts,
      }),
    }),
    buildSecrets: resolveFor("build"),
    runtimeSecrets: resolveFor("runtime"),
    // An environment's own repositories are what its agents are granted; a
    // protected repository outside that list still needs an explicit grant.
    scm: {
      ...security.scm,
      grantedRepositories: version.repositories.map((entry) => entry.repository),
    },
  };
}

/** A missing or unparsable controller URL still needs a name to refuse on. */
function controllerHostOf(controllerUrl: string | undefined): string {
  if (controllerUrl === undefined) return "controller.invalid";
  try {
    return new URL(controllerUrl).host;
  } catch {
    return "controller.invalid";
  }
}

export function buildCloudSecurityReport(input: {
  readonly config: ResolvedAwsWorkerConfig;
  readonly environments: ReadonlyArray<CloudEnvironment>;
}): CloudSecurityReport {
  return {
    encryption: verifyCloudEncryptionPosture(input.config.security.encryption),
    environments: input.environments.map((environment) =>
      securityPosture(environment, input.config.security, input.config.controllerUrl),
    ),
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
    security: buildCloudSecurityReport({
      config,
      environments: snapshot.environments ?? [],
    }),
    checks,
  };
}
