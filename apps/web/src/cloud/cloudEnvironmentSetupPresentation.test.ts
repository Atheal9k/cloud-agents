import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentVersionId,
  RunAllocationAttempt,
  RunAllocationId,
  ThreadId,
  type CloudEnvironmentBuild,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  canStopCloudEnvironmentSetup,
  cloudEnvironmentSetupAllocation,
  cloudEnvironmentSetupProgressLabel,
  cloudEnvironmentSetupState,
  latestPendingCloudEnvironmentSetupAllocation,
  type CloudEnvironmentSetupAllocation,
} from "./cloudEnvironmentSetupPresentation";

const THREAD_ID = ThreadId.make("thread-setup");

function build(overrides: Partial<CloudEnvironmentBuild> = {}): CloudEnvironmentBuild {
  return {
    id: CloudEnvironmentBuildId.make("build-setup"),
    environmentId: CloudEnvironmentId.make("environment-setup"),
    versionId: CloudEnvironmentVersionId.make("version-setup"),
    version: 1,
    trigger: "agent-requested",
    draft: true,
    setupThreadId: THREAD_ID,
    base: { kind: "image", image: "ubuntu:24.04" },
    inputsFingerprint: "a".repeat(64),
    gitSetup: [],
    logs: [],
    timings: {},
    outcome: { status: "running" },
    startedAt: "2026-09-20T01:00:00.000Z",
    ...overrides,
  };
}

describe("cloudEnvironmentSetupState", () => {
  it("selects only the newest Build for this setup chat", () => {
    const other = build({
      id: CloudEnvironmentBuildId.make("build-other"),
      setupThreadId: ThreadId.make("thread-other"),
      startedAt: "2026-09-20T03:00:00.000Z",
    });
    const newer = build({
      id: CloudEnvironmentBuildId.make("build-newer"),
      readyToSaveAt: "2026-09-20T02:10:00.000Z",
      outcome: {
        status: "succeeded",
        snapshot: {
          id: "snapshot-newer",
          digest: "b".repeat(64),
          sizeBytes: 1024,
          createdAt: "2026-09-20T02:00:00.000Z",
        },
        completedAt: "2026-09-20T02:00:00.000Z",
      },
      startedAt: "2026-09-20T01:30:00.000Z",
    });

    expect(cloudEnvironmentSetupState([other, build(), newer], THREAD_ID)).toMatchObject({
      kind: "ready",
      build: { id: "build-newer" },
    });
  });

  it("does not offer Save before the final proposal", () => {
    const succeeded = build({
      outcome: {
        status: "succeeded",
        snapshot: {
          id: "snapshot-setup",
          digest: "b".repeat(64),
          sizeBytes: 1024,
          createdAt: "2026-09-20T02:00:00.000Z",
        },
        completedAt: "2026-09-20T02:00:00.000Z",
      },
    });

    expect(cloudEnvironmentSetupState([succeeded], THREAD_ID)?.kind).toBe("verifying");
    expect(
      cloudEnvironmentSetupState(
        [{ ...succeeded, readyToSaveAt: "2026-09-20T02:10:00.000Z" }],
        THREAD_ID,
      )?.kind,
    ).toBe("ready");
  });
});

describe("cloudEnvironmentSetupAllocation", () => {
  const allocation = (
    overrides: Partial<CloudEnvironmentSetupAllocation> = {},
  ): CloudEnvironmentSetupAllocation => ({
    id: RunAllocationId.make("allocation-setup"),
    attempt: RunAllocationAttempt.make(1),
    allocationState: { status: "queued" },
    agentOutcome: { status: "not-started" },
    idleState: { status: "busy" },
    cleanupState: { status: "not-requested" },
    target: { repository: "acme/setup", baseCommit: "main", branch: "cursor/setup" },
    createdAt: "2026-09-20T01:00:00.000Z",
    updatedAt: "2026-09-20T01:00:00.000Z",
    execution: {
      threadId: THREAD_ID,
      environmentSetup: { name: "Cloud agents", scope: "personal" },
    },
    ...overrides,
  });

  it("finds the setup allocation before a Build exists", () => {
    const ordinary = allocation({
      id: RunAllocationId.make("allocation-ordinary"),
      execution: { threadId: THREAD_ID },
    });
    const setup = allocation();

    expect(cloudEnvironmentSetupAllocation([ordinary, setup], THREAD_ID)?.id).toBe(setup.id);
  });

  it("keeps controller cancellation available after cleanup fails", () => {
    expect(canStopCloudEnvironmentSetup(allocation())).toBe(true);
    expect(
      canStopCloudEnvironmentSetup(
        allocation({
          cleanupState: {
            status: "failed",
            reason: "worker unreachable",
            failedAt: "2026-09-20T02:00:00.000Z",
          },
        }),
      ),
    ).toBe(true);
    expect(
      canStopCloudEnvironmentSetup(
        allocation({
          cleanupState: {
            status: "requested",
            requestedAt: "2026-09-20T02:00:00.000Z",
          },
        }),
      ),
    ).toBe(false);
  });

  it("explains when setup is waiting for worker capacity", () => {
    expect(cloudEnvironmentSetupProgressLabel(allocation())).toBe(
      "Queued. Waiting for an available cloud worker.",
    );
  });

  it("shows controller cancellation progress", () => {
    expect(
      cloudEnvironmentSetupProgressLabel(
        allocation({
          cleanupState: {
            status: "requested",
            requestedAt: "2026-09-20T02:00:00.000Z",
          },
        }),
      ),
    ).toBe("Stopping setup...");
  });

  it("restores the latest unfinished setup after a reload", () => {
    const older = allocation({
      id: RunAllocationId.make("allocation-older"),
      updatedAt: "2026-09-20T01:30:00.000Z",
    });
    const latest = allocation({
      id: RunAllocationId.make("allocation-latest"),
      updatedAt: "2026-09-20T02:00:00.000Z",
    });
    const stopped = allocation({
      id: RunAllocationId.make("allocation-stopped"),
      updatedAt: "2026-09-20T03:00:00.000Z",
      cleanupState: {
        status: "succeeded",
        completedAt: "2026-09-20T03:00:00.000Z",
      },
    });

    expect(latestPendingCloudEnvironmentSetupAllocation([older, stopped, latest])?.id).toBe(
      latest.id,
    );
    expect(
      latestPendingCloudEnvironmentSetupAllocation([latest], "acme/another-repository"),
    ).toBeNull();
  });
});
