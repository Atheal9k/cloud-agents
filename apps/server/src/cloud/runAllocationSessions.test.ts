import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  RunAllocationCommand,
  RunWorkerProfile,
  type RunAllocation,
  type RunAllocationEvent,
} from "@t3tools/contracts";

import { decideRunAllocationCommand, projectRunAllocationEvent } from "./runAllocation.ts";

const decodeCommand = Schema.decodeSync(RunAllocationCommand);

const target = {
  repository: "t3tools/t3code",
  baseCommit: "afd7667ed",
  branch: "ca-36-preview-leases",
};
const profile = {
  id: "linux-web",
  os: "linux",
  arch: "x64",
} satisfies typeof RunWorkerProfile.Encoded;
const deadlines = {
  launchBy: "2026-09-17T03:05:00.000Z",
  bootBy: "2026-09-17T03:10:00.000Z",
  registerBy: "2026-09-17T03:15:00.000Z",
  expiresAt: "2026-09-17T05:00:00.000Z",
  cleanupBy: "2026-09-17T05:05:00.000Z",
};
const reopenDeadlines = {
  launchBy: "2026-09-18T09:05:00.000Z",
  bootBy: "2026-09-18T09:10:00.000Z",
  registerBy: "2026-09-18T09:15:00.000Z",
  expiresAt: "2026-09-18T11:00:00.000Z",
  cleanupBy: "2026-09-18T11:05:00.000Z",
};
const references = { workerId: "worker-1", environmentId: "environment-1", threadId: "thread-1" };
const route = {
  httpBaseUrl: "https://worker.example.test/",
  wsBaseUrl: "wss://worker.example.test/",
  accessToken: "worker-access-token",
};
const execution = {
  threadId: "thread-1",
  title: "Preview leases",
  selectedRef: "main",
  unansweredRequestSeconds: 900,
  turn: {
    commandId: "command-turn",
    messageId: "message-1",
    prompt: "Add preview leases",
    attachments: [],
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: "2026-09-17T03:00:00.000Z",
  },
} as const;
const flush = {
  userdata: { status: "flushed", detail: "Truncated the write-ahead log." },
  workspace: { status: "flushed", detail: "Captured refs/t3/cloud-idle/allocation-1/1." },
  providerHome: { status: "unavailable", reason: "The provider home is on a runtime tmpfs." },
  flushedAt: "2026-09-17T03:10:01.000Z",
} as const;
const snapshot = {
  instanceId: "i-worker",
  attempt: 1,
  flush,
  capturedAt: "2026-09-17T04:10:02.000Z",
} as const;

function command(input: typeof RunAllocationCommand.Encoded): RunAllocationCommand {
  return decodeCommand(input);
}

function applyAccepted(
  allocation: RunAllocation | undefined,
  next: RunAllocationCommand,
): { readonly allocation: RunAllocation; readonly event: RunAllocationEvent } {
  const events = decideRunAllocationCommand(allocation, next);
  expect(events).toHaveLength(1);
  const event = events[0];
  if (event === undefined) throw new Error("Expected an allocation event");
  return { allocation: projectRunAllocationEvent(allocation, event), event };
}

function apply(
  allocation: RunAllocation | undefined,
  commands: ReadonlyArray<typeof RunAllocationCommand.Encoded>,
): RunAllocation {
  let current = allocation;
  for (const input of commands) {
    current = applyAccepted(current, command(input)).allocation;
  }
  if (current === undefined) throw new Error("Expected an allocation");
  return current;
}

function readyAt(attempt: number, at: string): ReadonlyArray<typeof RunAllocationCommand.Encoded> {
  const base = { allocationId: "allocation-1", attempt, occurredAt: at };
  return [
    {
      ...base,
      type: "allocation.launch-started",
      commandId: `command-launch-started-${attempt}`,
      launchTemplate: { id: "lt-worker", version: 7 },
    },
    {
      ...base,
      type: "allocation.instance-launched",
      commandId: `command-instance-launched-${attempt}`,
      instanceId: "i-worker",
    },
    { ...base, type: "allocation.worker-booted", commandId: `command-worker-booted-${attempt}` },
    {
      ...base,
      type: "allocation.worker-registered",
      commandId: `command-worker-registered-${attempt}`,
      references,
      route,
    },
  ];
}

function settled(): RunAllocation {
  return apply(undefined, [
    {
      type: "allocation.launch",
      commandId: "command-launch",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:00:00.000Z",
      target,
      execution,
      profile,
      deadlines,
    },
    ...readyAt(1, "2026-09-17T03:00:04.000Z"),
    {
      type: "allocation.agent-started",
      commandId: "command-agent-started",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:00:05.000Z",
    },
    {
      type: "allocation.agent-succeeded",
      commandId: "command-agent-succeeded",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:10:00.000Z",
      resultLocation: { uri: "t3://environment-1/thread-1" },
    },
  ]);
}

function idle(): RunAllocation {
  return apply(settled(), [
    {
      type: "allocation.idle",
      commandId: "command-idle",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T03:10:01.000Z",
      releaseAt: "2026-09-17T04:10:01.000Z",
      flush,
    },
  ]);
}

function hibernated(): RunAllocation {
  return apply(idle(), [
    {
      type: "allocation.hibernate",
      commandId: "command-hibernate",
      allocationId: "allocation-1",
      attempt: 1,
      occurredAt: "2026-09-17T04:10:02.000Z",
      snapshot,
    },
  ]);
}

function held(
  allocation: RunAllocation,
  kind: "app-preview" | "desktop-viewer" | "input",
): RunAllocation {
  return apply(allocation, [
    {
      type: "allocation.session-lease-open",
      commandId: `command-open-${kind}`,
      allocationId: "allocation-1",
      attempt: allocation.attempt,
      occurredAt: "2026-09-17T03:11:00.000Z",
      kind,
      expiresAt: "2026-09-17T03:26:00.000Z",
      hardExpiresAt: "2026-09-17T07:11:00.000Z",
    },
  ]);
}

describe("preview leases", () => {
  it("gives each held session its own deadline and moves neither the run nor the runtime", () => {
    const both = held(held(idle(), "app-preview"), "desktop-viewer");

    expect(both.leases.appPreview).toEqual({
      status: "held",
      attempt: 1,
      openedAt: "2026-09-17T03:11:00.000Z",
      heartbeatAt: "2026-09-17T03:11:00.000Z",
      expiresAt: "2026-09-17T03:26:00.000Z",
      hardExpiresAt: "2026-09-17T07:11:00.000Z",
    });
    expect(both.leases.desktopViewer.status).toBe("held");
    expect(both.leases.input.status).toBe("released");
    expect(both.agentOutcome.status).toBe("succeeded");
    expect(both.idleState).toMatchObject({ status: "idle", releaseAt: "2026-09-17T04:10:01.000Z" });
  });

  it("clamps a heartbeat to the cap the lease opened with and then stops buying time", () => {
    const renewed = apply(held(idle(), "app-preview"), [
      {
        type: "allocation.session-lease-renew",
        commandId: "command-renew",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T07:00:00.000Z",
        kind: "app-preview",
        expiresAt: "2026-09-17T07:15:00.000Z",
      },
    ]);

    expect(renewed.leases.appPreview).toMatchObject({
      heartbeatAt: "2026-09-17T07:00:00.000Z",
      expiresAt: "2026-09-17T07:11:00.000Z",
    });
    expect(
      decideRunAllocationCommand(
        renewed,
        command({
          type: "allocation.session-lease-renew",
          commandId: "command-renew-late",
          allocationId: "allocation-1",
          attempt: 1,
          occurredAt: "2026-09-17T07:11:00.000Z",
          kind: "app-preview",
          expiresAt: "2026-09-17T07:26:00.000Z",
        }),
      ),
    ).toEqual([]);
  });

  it("ends the preview when its own lease is released", () => {
    const published = apply(held(settled(), "app-preview"), [
      {
        type: "allocation.preview-published",
        commandId: "command-preview",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:12:00.000Z",
        url: "https://preview.example.test/",
      },
    ]);
    const released = apply(published, [
      {
        type: "allocation.session-lease-release",
        commandId: "command-release",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:30:00.000Z",
        kind: "app-preview",
        reason: "The session lease expired without a heartbeat.",
      },
    ]);

    expect(released.leases.appPreview).toEqual({
      status: "released",
      releasedAt: "2026-09-17T03:30:00.000Z",
      reason: "The session lease expired without a heartbeat.",
    });
    expect(released.previewState).toEqual({ status: "unavailable" });
  });

  it("brings the release forward when a person stops the session", () => {
    const stopped = apply(held(idle(), "app-preview"), [
      {
        type: "allocation.session-stop",
        commandId: "command-stop",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:20:00.000Z",
      },
    ]);

    expect(stopped.stopRequestedAt).toBe("2026-09-17T03:20:00.000Z");
    expect(stopped.leases.appPreview.status).toBe("released");
    expect(stopped.idleState).toMatchObject({ releaseAt: "2026-09-17T03:20:00.000Z" });
  });

  it("refuses to stop a session out from under a running turn", () => {
    const running = apply(undefined, [
      {
        type: "allocation.launch",
        commandId: "command-launch",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:00.000Z",
        target,
        execution,
        profile,
        deadlines,
      },
      ...readyAt(1, "2026-09-17T03:00:04.000Z"),
      {
        type: "allocation.agent-started",
        commandId: "command-agent-started",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T03:00:05.000Z",
      },
    ]);

    expect(
      decideRunAllocationCommand(
        running,
        command({
          type: "allocation.session-stop",
          commandId: "command-stop-running",
          allocationId: "allocation-1",
          attempt: 1,
          occurredAt: "2026-09-17T03:05:00.000Z",
        }),
      ),
    ).toEqual([]);
  });

  it("voids every session when the guest is hibernated", () => {
    const stopped = apply(held(idle(), "app-preview"), [
      {
        type: "allocation.hibernate",
        commandId: "command-hibernate-leased",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-17T04:10:02.000Z",
        snapshot,
      },
    ]);

    expect(stopped.leases.appPreview).toMatchObject({ status: "released" });
    expect(stopped.previewState).toEqual({ status: "unavailable" });
    expect(stopped.stopRequestedAt).toBeUndefined();
  });

  it("refuses a lease against a runtime that is not up", () => {
    expect(
      decideRunAllocationCommand(
        hibernated(),
        command({
          type: "allocation.session-lease-open",
          commandId: "command-open-hibernated",
          allocationId: "allocation-1",
          attempt: 1,
          occurredAt: "2026-09-18T09:00:00.000Z",
          kind: "app-preview",
          expiresAt: "2026-09-18T09:15:00.000Z",
          hardExpiresAt: "2026-09-18T13:00:00.000Z",
        }),
      ),
    ).toEqual([]);
  });
});

describe("reopen", () => {
  function reopened(): RunAllocation {
    return apply(hibernated(), [
      {
        type: "allocation.reopen",
        commandId: "command-reopen",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-18T09:00:00.000Z",
        nextAttempt: 2,
        deadlines: reopenDeadlines,
      },
    ]);
  }

  it("takes a new attempt that restores the snapshot and creates no run", () => {
    const before = hibernated();
    const after = reopened();

    expect(after.attempt).toBe(2);
    expect(after.attemptPurpose).toBe("reopen");
    expect(after.idleState).toMatchObject({
      status: "waking",
      snapshot: { instanceId: "i-worker", attempt: 1 },
    });
    expect(after.agentOutcome).toEqual(before.agentOutcome);
    expect(after.control?.runId).toBe(before.control?.runId);
    expect(after.execution).toEqual(before.execution);
    expect(after.leases.appPreview.status).toBe("released");
  });

  it("is refused while a turn is in flight and while the agent is archived", () => {
    const archived = apply(hibernated(), [
      {
        type: "allocation.agent-archive",
        commandId: "command-archive",
        allocationId: "allocation-1",
        attempt: 1,
        occurredAt: "2026-09-18T08:00:00.000Z",
      },
    ]);

    expect(
      decideRunAllocationCommand(
        archived,
        command({
          type: "allocation.reopen",
          commandId: "command-reopen-archived",
          allocationId: "allocation-1",
          attempt: 1,
          occurredAt: "2026-09-18T09:00:00.000Z",
          nextAttempt: 2,
          deadlines: reopenDeadlines,
        }),
      ),
    ).toEqual([]);
  });

  it("records the reopen receipt and the hand edits the session ends with", () => {
    const restored = apply(reopened(), readyAt(2, "2026-09-18T09:00:04.000Z"));
    const reported = apply(restored, [
      {
        type: "allocation.reopened",
        commandId: "command-reopened",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-18T09:00:05.000Z",
        reopen: {
          environmentStart: { services: [] },
          browser: {
            status: "fresh",
            reason: "The browser profile is in a runtime directory that a stop clears.",
          },
          reopenedAt: "2026-09-18T09:00:05.000Z",
          providerRunStarted: false,
        },
      },
    ]);

    expect(reported.reopen?.providerRunStarted).toBe(false);
    expect(reported.reopen?.browser.status).toBe("fresh");

    const edited = apply(reported, [
      {
        type: "allocation.session-edits-captured",
        commandId: "command-session-edits",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-18T09:30:00.000Z",
        edits: {
          status: "captured",
          baseRef: "refs/t3/cloud-session/allocation-1/2/base",
          editsRef: "refs/t3/cloud-session/allocation-1/2/edits",
          changedFiles: 2,
          diffSizeChars: 412,
          capturedAt: "2026-09-18T09:30:00.000Z",
          publicationRewritten: false,
        },
      },
    ]);

    expect(edited.sessionEdits).toMatchObject({
      status: "captured",
      changedFiles: 2,
      publicationRewritten: false,
    });
  });

  it("returns to ordinary run work when a follow-up arrives", () => {
    const followedUp = apply(apply(reopened(), readyAt(2, "2026-09-18T09:00:04.000Z")), [
      {
        type: "allocation.follow-up",
        commandId: "command-follow-up",
        allocationId: "allocation-1",
        attempt: 2,
        occurredAt: "2026-09-18T10:00:00.000Z",
        runId: "run-2",
        execution,
        deadlines: reopenDeadlines,
      },
    ]);

    expect(followedUp.attemptPurpose).toBe("run");
    expect(followedUp.agentOutcome.status).toBe("not-started");
    expect(followedUp.reopen).toBeUndefined();
    expect(followedUp.stopRequestedAt).toBeUndefined();
  });
});
