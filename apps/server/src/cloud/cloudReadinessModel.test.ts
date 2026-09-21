import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentVersionId,
  DEFAULT_STALE_BUILD_THRESHOLD_SECONDS,
  type CloudAllocationSnapshot,
  type CloudEnvironment,
  type CloudEnvironmentBuild,
  type CloudReadinessCheckId,
  type CloudReadinessCheckOutcome,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  defaultCloudControllerSecurityConfig,
  type ResolvedAwsWorkerConfig,
} from "./awsWorkerConfig.ts";
import { buildCloudReadinessReport } from "./cloudReadinessModel.ts";

const NOW = "2026-09-19T12:00:00.000Z";
const environmentId = CloudEnvironmentId.make("environment:primary");
const versionId = CloudEnvironmentVersionId.make("version:primary:1");
const buildId = CloudEnvironmentBuildId.make("build:primary:1");

const CREDENTIALS_PATH = "/etc/t3/hypervisor-1.credentials.json";

function config(overrides: Partial<ResolvedAwsWorkerConfig> = {}): ResolvedAwsWorkerConfig {
  return {
    region: "us-west-1",
    project: "t3-cloud-agents",
    runtimeKind: "firecracker",
    security: defaultCloudControllerSecurityConfig({
      region: "us-west-1",
      runtimeKind: "firecracker",
    }),
    controllerAccountId: "111111111111",
    executionAccountId: "222222222222",
    hypervisors: [
      {
        id: "hypervisor-1",
        accountId: "222222222222",
        cpuMillis: 16_000,
        memoryMib: 65_536,
        diskGib: 400,
        cpuOversubscribeRatio: 2,
        profiles: ["linux-web"],
        credentialsPath: CREDENTIALS_PATH,
        kvm: true,
        guestImageVersion: "guest-2026.09.01",
        hypervisorImageVersion: "host-2026.09.02",
      },
    ],
    ...overrides,
  };
}

function environment(overrides: Partial<CloudEnvironment> = {}): CloudEnvironment {
  return {
    id: environmentId,
    current: {
      id: versionId,
      environmentId,
      version: 1,
      name: "Primary",
      source: { type: "saved", scope: "personal", owner: "victor" },
      repositories: [{ repository: "t3tools/t3code", defaultRef: "main" }],
      config: { image: "ubuntu:24.04" },
      secretReferences: [{ name: "NPM_TOKEN", reference: "secret://npm", availability: "build" }],
      effectivePolicy: {
        runtimeUser: "ubuntu",
        egressMode: "network_settings_only",
        egressAllowlist: ["registry.npmjs.org"],
        testingEnabled: false,
        disableAllMcpServers: false,
        mcpServerAllowlist: [],
        ports: [],
        secrets: [{ name: "NPM_TOKEN", reference: "secret://npm", availability: "build" }],
      },
      createdAt: NOW,
    },
    history: [
      {
        id: versionId,
        version: 1,
        name: "Primary",
        source: { type: "saved", scope: "personal", owner: "victor" },
        base: { kind: "image", image: "ubuntu:24.04" },
        createdAt: NOW,
      },
    ],
    activeBuildId: buildId,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function succeededBuild(freshAt: string): CloudEnvironmentBuild {
  return {
    id: buildId,
    environmentId,
    versionId,
    version: 1,
    trigger: "manual",
    draft: false,
    base: { kind: "image", image: "ubuntu:24.04" },
    inputsFingerprint: "a".repeat(64),
    gitSetup: [],
    logs: [],
    timings: {},
    outcome: {
      status: "succeeded",
      snapshot: {
        id: "snapshot-1",
        digest: "b".repeat(64),
        sizeBytes: 1024,
        createdAt: freshAt,
      },
      completedAt: freshAt,
    },
    startedAt: freshAt,
    freshAt,
  };
}

function snapshot(overrides: Partial<CloudAllocationSnapshot> = {}): CloudAllocationSnapshot {
  return {
    controller: {
      mode: "permanent",
      requiresHostOnline: false,
      admission: { status: "open" },
      writability: { status: "writable" },
      defaults: { repository: "t3tools/t3code", ref: "main" },
    },
    limits: {
      maxConcurrentWorkers: 4,
      maxQueueDepth: 8,
      maxRunSeconds: 3600,
      maxInputWaitSeconds: 900,
      previewLeaseSeconds: 60,
      previewLeaseMaxSeconds: 240,
      idleReleaseSeconds: 300,
      conversationRetentionDays: 30,
      allowedInstanceTypes: ["c7i.2xlarge"],
    },
    workerPriceAssumptions: [],
    spendingControl: "estimate-only",
    allocations: [],
    environments: [environment()],
    builds: [succeededBuild(NOW)],
    usage: [],
    ...overrides,
  };
}

function outcomes(
  entries: ReadonlyArray<readonly [CloudReadinessCheckId, CloudReadinessCheckOutcome]>,
): ReadonlyMap<CloudReadinessCheckId, CloudReadinessCheckOutcome> {
  return new Map(entries);
}

describe("buildCloudReadinessReport", () => {
  it("never carries a hypervisor credential path into the report", () => {
    const report = buildCloudReadinessReport({
      config: config(),
      snapshot: snapshot(),
      outcomes: outcomes([]),
      now: NOW,
    });

    expect(JSON.stringify(report)).not.toContain(CREDENTIALS_PATH);
    expect(report.runtime.hypervisors[0]).toMatchObject({
      id: "hypervisor-1",
      kvm: true,
      guestImageVersion: "guest-2026.09.01",
      hypervisorImageVersion: "host-2026.09.02",
    });
    expect(report.runtime.hypervisors[0]).not.toHaveProperty("credentialsPath");
  });

  it("reports both accounts, their regions, and the fleet's slot capacity", () => {
    const report = buildCloudReadinessReport({
      config: config(),
      snapshot: snapshot(),
      outcomes: outcomes([]),
      observedAccountIds: { execution: "222222222222" },
      now: NOW,
    });

    expect(report.accounts).toEqual([
      {
        role: "controller",
        region: "us-west-1",
        project: "t3-cloud-agents",
        accountId: "111111111111",
      },
      {
        role: "execution",
        region: "us-west-1",
        project: "t3-cloud-agents",
        accountId: "222222222222",
        observedAccountId: "222222222222",
      },
    ]);
    expect(report.runtime.slots).toEqual({
      hosts: 1,
      cpuMillis: 16_000,
      memoryMib: 65_536,
      diskGib: 400,
    });
    expect(report.runtime.parity).toBe("cursor-firecracker");
  });

  it("marks an environment's Build stale once its threshold has passed", () => {
    const stale = buildCloudReadinessReport({
      config: config(),
      snapshot: snapshot({
        environments: [environment({ staleBuildThresholdSeconds: 60 })],
        builds: [succeededBuild("2026-09-19T11:00:00.000Z")],
      }),
      outcomes: outcomes([]),
      now: NOW,
    });
    const fresh = buildCloudReadinessReport({
      config: config(),
      snapshot: snapshot(),
      outcomes: outcomes([]),
      now: NOW,
    });

    expect(stale.environments[0]?.buildStale).toBe(true);
    expect(stale.environments[0]?.staleBuildThresholdSeconds).toBe(60);
    expect(fresh.environments[0]?.buildStale).toBe(false);
    expect(fresh.environments[0]?.staleBuildThresholdSeconds).toBe(
      DEFAULT_STALE_BUILD_THRESHOLD_SECONDS,
    );
    expect(fresh.environments[0]?.activeBuildSnapshotId).toBe("snapshot-1");
  });

  it("exposes the settings a run resolves from without leaking secret values", () => {
    const report = buildCloudReadinessReport({
      config: config(),
      snapshot: snapshot(),
      outcomes: outcomes([]),
      now: NOW,
    });

    expect(report.settings.configPrecedence.map((entry) => [entry.label, entry.present])).toEqual([
      ["Repository config", false],
      ["Personal environment", true],
      ["Team environment", false],
      ["Default environment", false],
    ]);
    expect(report.settings.defaults).toEqual({ repository: "t3tools/t3code", ref: "main" });
    expect(report.environments[0]?.secrets).toEqual([
      { name: "NPM_TOKEN", reference: "secret://npm", availability: "build" },
    ]);
    expect(report.environments[0]?.egressMode).toBe("network_settings_only");
    expect(report.environments[0]?.egressAllowlist).toEqual(["registry.npmjs.org"]);
  });

  it("holds health down for a failed Daytona readiness check", () => {
    const requiredFailure = buildCloudReadinessReport({
      config: config(),
      snapshot: snapshot(),
      outcomes: outcomes([
        [
          "daytona-authentication",
          { status: "failed", detail: "denied", remedy: "fix it", checkedAt: NOW },
        ],
      ]),
      now: NOW,
    });

    expect(requiredFailure.health.requiredChecksPassing).toBe(false);
    expect(requiredFailure.health.failedCheckIds).toEqual(["daytona-authentication"]);
    // A check nobody has run yet is not a failure, only an unknown.
    expect(requiredFailure.checks.find((check) => check.id === "daytona-api")?.outcome.status).toBe(
      "unchecked",
    );
  });

  it("reports the EC2 fallback with no packing capacity", () => {
    const report = buildCloudReadinessReport({
      config: config({ runtimeKind: "ec2-fallback", hypervisors: [] }),
      snapshot: snapshot(),
      outcomes: outcomes([]),
      now: NOW,
    });

    expect(report.runtime.kind).toBe("ec2-fallback");
    expect(report.runtime.parity).toBe("ec2-migration-fallback");
    expect(report.runtime.slots.hosts).toBe(0);
  });
});

describe("security posture", () => {
  it("resolves each environment's egress against the controller ceiling", () => {
    const report = buildCloudReadinessReport({
      config: config({
        controllerUrl: "https://controller.example.com",
        security: {
          ...defaultCloudControllerSecurityConfig({
            region: "us-west-1",
            runtimeKind: "firecracker",
          }),
          egress: {
            mode: "default_with_allowlist",
            allowlist: ["registry.npmjs.org"],
            adminLocked: true,
          },
        },
      }),
      snapshot: snapshot(),
      outcomes: new Map(),
      now: NOW,
    });

    const posture = report.security?.environments[0];
    expect(posture?.egress).toMatchObject({
      mode: "allowlist_only",
      allowlist: ["registry.npmjs.org"],
      adminLocked: true,
    });
    expect(posture?.egress.exceptions.map((entry) => entry.host)).toContain(
      "controller.example.com",
    );
    expect(posture?.scm.grantedRepositories).toEqual(["t3tools/t3code"]);
  });

  it("splits build-time secrets from runtime secrets and never sends a value", () => {
    const report = buildCloudReadinessReport({
      config: config(),
      snapshot: snapshot(),
      outcomes: new Map(),
      now: NOW,
    });

    const posture = report.security?.environments[0];
    expect(posture?.buildSecrets.map((secret) => secret.name)).toEqual(["NPM_TOKEN"]);
    expect(posture?.runtimeSecrets).toEqual([]);
    expect(posture?.buildSecrets[0]).toMatchObject({
      reference: "secret://npm",
      scope: "environment",
      redacted: false,
    });
  });

  it("reports the EC2 fallback's missing per-agent disk key as blocking", () => {
    const firecracker = buildCloudReadinessReport({
      config: config(),
      snapshot: snapshot(),
      outcomes: new Map(),
      now: NOW,
    });
    const fallback = buildCloudReadinessReport({
      config: config({
        runtimeKind: "ec2-fallback",
        hypervisors: [],
        security: defaultCloudControllerSecurityConfig({
          region: "us-west-1",
          runtimeKind: "ec2-fallback",
        }),
      }),
      snapshot: snapshot(),
      outcomes: new Map(),
      now: NOW,
    });

    expect(firecracker.security?.encryption.ok).toBe(true);
    expect(fallback.security?.encryption.ok).toBe(false);
    expect(fallback.security?.encryption.findings.map((finding) => finding.id)).toContain(
      "missing-per-agent-key",
    );
  });
});
