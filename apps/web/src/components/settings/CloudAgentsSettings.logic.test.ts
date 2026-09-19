import {
  CloudAllocationSnapshot,
  CloudEnvironmentBuild,
  CloudGuidedSetupInput,
  type CloudEnvironment,
  type CloudReadinessReport,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  cloudBuildActions,
  cloudControllerDefaultsFromDraft,
  cloudFleetSummary,
  cloudReadinessCheckRows,
  cloudReadinessHeadline,
  createCloudGuidedSetupDraft,
  validateCloudBuildPolicyDraft,
  validateCloudGuidedSetupDraft,
  type CloudGuidedSetupDraft,
} from "./CloudAgentsSettings.logic";

const NOW = "2026-09-19T12:00:00.000Z";
const isGuidedSetupInput = Schema.is(CloudGuidedSetupInput);
const decodeBuild = Schema.decodeUnknownSync(CloudEnvironmentBuild);
const decodeSnapshot = Schema.decodeUnknownSync(CloudAllocationSnapshot);

function build(input: {
  readonly draft: boolean;
  readonly outcome:
    | { readonly status: "running" }
    | {
        readonly status: "succeeded";
        readonly snapshot: {
          readonly id: string;
          readonly digest: string;
          readonly sizeBytes: number;
          readonly createdAt: string;
        };
        readonly completedAt: string;
      };
}): CloudEnvironmentBuild {
  return decodeBuild({
    id: "build:primary:2",
    environmentId: "environment:primary",
    versionId: "version:primary:2",
    version: 2,
    trigger: "manual",
    draft: input.draft,
    base: { kind: "image", image: "ubuntu:24.04" },
    inputsFingerprint: "a".repeat(64),
    gitSetup: [],
    logs: [],
    timings: {},
    outcome: input.outcome,
    startedAt: NOW,
  });
}

function report(overrides: Partial<CloudReadinessReport> = {}): CloudReadinessReport {
  return {
    generatedAt: NOW,
    accounts: [],
    runtime: {
      kind: "firecracker",
      parity: "cursor-firecracker",
      hypervisors: [],
      slots: { hosts: 0, cpuMillis: 0, memoryMib: 0, diskGib: 0 },
      desiredHosts: 0,
      warmGuestsReady: 0,
    },
    environments: [],
    snapshotPolicy: {
      snapshotRetentionDays: 90,
      conversationRetentionDays: 0,
      idleReleaseSeconds: 300,
      hibernatedRuntimes: 0,
      recordedDeletions: 0,
    },
    health: {
      controller: {
        mode: "permanent",
        requiresHostOnline: false,
        admission: { status: "open" },
        writability: { status: "writable" },
      },
      activeRuns: 0,
      queuedRuns: 0,
      maxConcurrentWorkers: 4,
      requiredChecksPassing: true,
      failedCheckIds: [],
    },
    settings: { configPrecedence: [], defaults: {}, allowedInstanceTypes: [] },
    checks: [
      {
        id: "execution-iam",
        title: "Execution IAM",
        description: "Credentials resolve.",
        optional: false,
        outcome: { status: "passed", detail: "Authenticated.", checkedAt: NOW },
      },
      {
        id: "ssm-diagnostics",
        title: "SSM diagnostics",
        description: "Optional document.",
        optional: true,
        outcome: { status: "failed", detail: "missing", remedy: "create it", checkedAt: NOW },
      },
    ],
    ...overrides,
  };
}

function draft(overrides: Partial<CloudGuidedSetupDraft> = {}): CloudGuidedSetupDraft {
  return {
    environmentId: "environment:primary",
    name: "Primary",
    scope: "personal",
    owner: "victor",
    repository: "t3tools/t3code",
    defaultRef: "main",
    additionalRepositories: "",
    baseKind: "image",
    image: "ubuntu:24.04",
    dockerfile: "Dockerfile",
    install: "pnpm install",
    start: "",
    ...overrides,
  };
}

describe("cloudReadinessCheckRows", () => {
  it("keeps an optional failure out of the problem tone", () => {
    const rows = cloudReadinessCheckRows(report());

    expect(rows[0]).toMatchObject({ statusLabel: "Passing", tone: "ok", remedy: null });
    expect(rows[1]).toMatchObject({
      statusLabel: "Failing",
      tone: "muted",
      remedy: "create it",
    });
  });

  it("shows an unrun check as neither passing nor failing", () => {
    const rows = cloudReadinessCheckRows(
      report({
        checks: [
          {
            id: "hypervisor-kvm",
            title: "KVM",
            description: "KVM support.",
            optional: false,
            outcome: { status: "unchecked" },
          },
        ],
      }),
    );

    expect(rows[0]).toMatchObject({
      statusLabel: "Not run",
      tone: "muted",
      detail: null,
      checkedAt: null,
    });
  });
});

describe("cloudReadinessHeadline", () => {
  it("says a fence outranks everything else", () => {
    const headline = cloudReadinessHeadline(
      report({
        health: {
          ...report().health,
          requiredChecksPassing: false,
          failedCheckIds: ["execution-iam"],
          controller: {
            mode: "permanent",
            requiresHostOnline: false,
            admission: { status: "stopped", stoppedAt: NOW },
            writability: { status: "fenced", fencedAt: NOW, reason: "cutover" },
          },
        },
      }),
    );

    expect(headline).toEqual({
      tone: "problem",
      label: "Fenced for a cutover. Adopt this host to write again.",
    });
  });

  it("says stopped admission keeps runs, snapshots, cleanup, and review available", () => {
    const headline = cloudReadinessHeadline(
      report({
        health: {
          ...report().health,
          controller: {
            mode: "permanent",
            requiresHostOnline: false,
            admission: { status: "stopped", stoppedAt: NOW },
            writability: { status: "writable" },
          },
        },
      }),
    );

    expect(headline).toEqual({
      tone: "muted",
      label: "Admission stopped. Active runs, snapshots, cleanup, and review continue.",
    });
  });

  it("counts required checks that have not been run", () => {
    expect(cloudReadinessHeadline(report()).label).toBe("Accepting runs.");
    expect(
      cloudReadinessHeadline(
        report({
          checks: [
            {
              id: "hypervisor-kvm",
              title: "KVM",
              description: "KVM support.",
              optional: false,
              outcome: { status: "unchecked" },
            },
          ],
        }),
      ),
    ).toEqual({ tone: "muted", label: "1 required checks have not been run yet." });
  });
});

describe("validateCloudGuidedSetupDraft", () => {
  it("produces an input the contract accepts", () => {
    const result = validateCloudGuidedSetupDraft({
      draft: draft(),
      buildId: "build:primary:2",
      expectedVersion: 1,
      occurredAt: NOW,
    });

    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(isGuidedSetupInput(result.input)).toBe(true);
    expect(result.input.repository).toBe("t3tools/t3code");
    expect(result.input).toMatchObject({
      expectedVersion: 1,
      base: { kind: "image", image: "ubuntu:24.04" },
      install: "pnpm install",
    });
    expect(result.input).not.toHaveProperty("start");
  });

  it("parses additional repositories that share the environment Build", () => {
    const result = validateCloudGuidedSetupDraft({
      draft: draft({ additionalRepositories: "t3tools/api main\nt3tools/infra release" }),
      buildId: "build:primary:2",
      expectedVersion: 1,
      occurredAt: NOW,
    });

    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.input.additionalRepositories).toEqual([
      { repository: "t3tools/api", defaultRef: "main" },
      { repository: "t3tools/infra", defaultRef: "release" },
    ]);
  });

  it("refuses an owned scope with no owner", () => {
    expect(
      validateCloudGuidedSetupDraft({
        draft: draft({ owner: "  " }),
        buildId: "build:primary:2",
        expectedVersion: undefined,
        occurredAt: NOW,
      }),
    ).toEqual({ status: "invalid", message: "A personal environment needs an owner." });
  });

  it("does not ask the default scope for an owner", () => {
    const result = validateCloudGuidedSetupDraft({
      draft: draft({ scope: "default", owner: "" }),
      buildId: "build:primary:2",
      expectedVersion: undefined,
      occurredAt: NOW,
    });

    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.input).not.toHaveProperty("owner");
  });

  it("refuses a dockerfile base with no path", () => {
    expect(
      validateCloudGuidedSetupDraft({
        draft: draft({ baseKind: "dockerfile", dockerfile: "" }),
        buildId: "build:primary:2",
        expectedVersion: undefined,
        occurredAt: NOW,
      }),
    ).toEqual({ status: "invalid", message: "Give the Dockerfile path to build from." });
  });
});

describe("createCloudGuidedSetupDraft", () => {
  it("starts from an existing environment's current version", () => {
    const environment = {
      id: "environment:primary",
      current: {
        id: "version:primary:1",
        environmentId: "environment:primary",
        version: 1,
        name: "Primary",
        source: { type: "saved", scope: "team", owner: "platform" },
        repositories: [{ repository: "t3tools/t3code", defaultRef: "release" }],
        config: { image: "ubuntu:24.04", install: "pnpm install" },
        secretReferences: [],
        effectivePolicy: {
          runtimeUser: "ubuntu",
          egressMode: "allow_all",
          egressAllowlist: [],
          testingEnabled: false,
          disableAllMcpServers: false,
          mcpServerAllowlist: [],
          ports: [],
          secrets: [],
        },
        createdAt: NOW,
      },
      history: [],
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as CloudEnvironment;

    expect(createCloudGuidedSetupDraft(environment, "unused")).toMatchObject({
      environmentId: "environment:primary",
      name: "Primary",
      scope: "team",
      owner: "platform",
      defaultRef: "release",
      baseKind: "image",
      image: "ubuntu:24.04",
      install: "pnpm install",
    });
  });

  it("falls back to a new personal environment when there is nothing to edit", () => {
    expect(createCloudGuidedSetupDraft(undefined, "environment:new")).toMatchObject({
      environmentId: "environment:new",
      name: "",
      scope: "personal",
      defaultRef: "main",
      baseKind: "dockerfile",
    });
  });
});

describe("cloudControllerDefaultsFromDraft", () => {
  it("clears a blank field instead of storing an empty default", () => {
    expect(
      cloudControllerDefaultsFromDraft({
        model: " ",
        context: "",
        repository: "t3tools/t3code",
        ref: "",
        longRunning: false,
        computerUse: false,
        summaries: false,
        artifactsToGit: false,
        collaboration: "disabled",
        selfHostedMode: "off",
      }),
    ).toEqual({
      repository: "t3tools/t3code",
      longRunning: false,
      computerUse: false,
      summaries: false,
      artifactsToGit: false,
      collaboration: "disabled",
      selfHostedMode: "off",
    });
  });
});

describe("cloudBuildActions", () => {
  it("offers only actions the Build catalog can accept", () => {
    expect(cloudBuildActions(build({ draft: false, outcome: { status: "running" } }))).toEqual([
      "cancel",
    ]);
    expect(
      cloudBuildActions(
        build({
          draft: true,
          outcome: {
            status: "succeeded",
            snapshot: {
              id: "snapshot:primary:2",
              digest: "b".repeat(64),
              sizeBytes: 1_024,
              createdAt: NOW,
            },
            completedAt: NOW,
          },
        }),
      ),
    ).toEqual(["activate"]);
    expect(
      cloudBuildActions(
        build({
          draft: false,
          outcome: {
            status: "succeeded",
            snapshot: {
              id: "snapshot:primary:2",
              digest: "b".repeat(64),
              sizeBytes: 1_024,
              createdAt: NOW,
            },
            completedAt: NOW,
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe("validateCloudBuildPolicyDraft", () => {
  it("accepts every-run and recurring refresh windows", () => {
    expect(validateCloudBuildPolicyDraft("0")).toEqual({
      status: "valid",
      staleThresholdSeconds: 0,
    });
    expect(validateCloudBuildPolicyDraft("86400")).toEqual({
      status: "valid",
      staleThresholdSeconds: 86_400,
    });
  });

  it("rejects empty, negative, fractional, and unsafe refresh windows", () => {
    expect(validateCloudBuildPolicyDraft(" ").status).toBe("invalid");
    expect(validateCloudBuildPolicyDraft("-1").status).toBe("invalid");
    expect(validateCloudBuildPolicyDraft("1.5").status).toBe("invalid");
    expect(validateCloudBuildPolicyDraft(String(Number.MAX_SAFE_INTEGER + 1)).status).toBe(
      "invalid",
    );
  });
});

describe("cloudFleetSummary", () => {
  it("separates queue, placement, snapshot, warm inventory, and cleanup state", () => {
    const snapshot = decodeSnapshot({
      controller: {
        mode: "permanent",
        requiresHostOnline: false,
        admission: { status: "open" },
      },
      limits: {
        maxConcurrentWorkers: 4,
        maxQueueDepth: 8,
        maxRunSeconds: 3_600,
        maxInputWaitSeconds: 300,
        previewLeaseSeconds: 300,
        previewLeaseMaxSeconds: 3_600,
        idleReleaseSeconds: 300,
        conversationRetentionDays: 0,
        allowedInstanceTypes: ["c7i.large"],
      },
      workerPriceAssumptions: [],
      spendingControl: "estimate-only",
      allocations: [
        {
          id: "allocation:queued",
          attempt: 1,
          target: {
            repository: "t3tools/t3code",
            baseCommit: "c".repeat(40),
            branch: "cursor/queued",
          },
          publication: { mode: "review-only" },
          profile: {
            id: "linux-web",
            os: "linux",
            arch: "x64",
            instanceType: "c7i.large",
          },
          placement: {
            warmFork: "warm",
            buildId: "build:primary:1",
            claimLatencyMs: 40,
            bootTimeMs: 2_000,
          },
          deadlines: {
            launchBy: NOW,
            bootBy: NOW,
            registerBy: NOW,
            expiresAt: NOW,
            cleanupBy: NOW,
          },
          allocationState: { status: "queued" },
          agentOutcome: { status: "not-started" },
          previewState: { status: "unavailable" },
          leases: {
            appPreview: { status: "released" },
            desktopViewer: { status: "released" },
            input: { status: "released" },
          },
          idleState: { status: "busy" },
          cleanupState: { status: "failed", reason: "timeout", failedAt: NOW },
          handledCommandIds: [],
          sequence: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      runtimeAttempts: [
        {
          id: "runtime:active",
          agentId: "agent:active",
          allocationId: "allocation:active",
          attempt: 1,
          runIds: [],
          createdAt: NOW,
          updatedAt: NOW,
          status: "CREATING",
        },
        {
          id: "runtime:hibernated",
          agentId: "agent:hibernated",
          allocationId: "allocation:hibernated",
          attempt: 1,
          runIds: [],
          createdAt: NOW,
          updatedAt: NOW,
          status: "HIBERNATED",
          snapshot: {
            instanceId: "guest:hibernated",
            attempt: 1,
            flush: {
              userdata: { status: "flushed", detail: "saved" },
              workspace: { status: "flushed", detail: "saved" },
              providerHome: { status: "flushed", detail: "saved" },
              flushedAt: NOW,
            },
            capturedAt: NOW,
          },
        },
      ],
      warmGuests: [
        {
          id: "warm:ready",
          environmentId: "environment:primary",
          versionId: "version:primary:1",
          profileId: "linux-web",
          buildId: "build:primary:1",
          snapshotId: "snapshot:primary:1",
          status: "ready",
          bootTimeMs: 5_000,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      usage: [],
    });

    expect(cloudFleetSummary(snapshot)).toMatchObject({
      queuedAllocations: 1,
      activeRuntimeAttempts: 1,
      hibernatedRuntimeAttempts: 1,
      warmPlacements: 1,
      coldPlacements: 0,
      cleanupPending: 0,
      cleanupFailed: 1,
      warmGuests: { warming: 0, ready: 1, claimed: 0, draining: 0 },
    });
  });
});
