import {
  CLOUD_AGENTS_API_STREAM_RETENTION_BYTES,
  CLOUD_AGENTS_API_STREAM_RETENTION_EVENTS,
  CLOUD_AGENTS_API_STREAM_RETENTION_SECONDS,
  CloudAgentId,
  CloudRunId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunAllocationAttempt,
  RunAllocationId,
  ThreadId,
  type CloudAgent,
  type CloudAgentsApiStreamEvent,
  type CloudRun,
  type OrchestrationThreadDetailSnapshot,
  type RunAllocation,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendBoundedStreamEvent,
  emptyStreamBuffer,
  eventsFromThreadSnapshot,
  measureStreamRestore,
  mergeStreamSources,
  pageHistory,
  resumeBoundedStream,
  selectReconnectSource,
} from "./cloudAgentEventStream.ts";

const NOW = "2026-09-19T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const agent = (status: CloudAgent["status"]): CloudAgent => {
  const base = {
    id: CloudAgentId.make("agent-1"),
    allocationId: RunAllocationId.make("allocation-1"),
    conversation: { title: "Large history", runIds: [CloudRunId.make("run-1")] },
    repository: "acme/app",
    baseCommit: "main",
    environmentProfileId: "linux-web",
    branches: ["cloud/agent-1"],
    createdAt: NOW,
    updatedAt: NOW,
  };
  if (status === "ACTIVE") {
    return { ...base, status, activeRunId: CloudRunId.make("run-1") };
  }
  if (status === "ARCHIVED") {
    return { ...base, status, archivedAt: NOW };
  }
  return { ...base, status };
};

const allocation = (idle: RunAllocation["idleState"]["status"]): RunAllocation =>
  ({
    id: RunAllocationId.make("allocation-1"),
    attempt: RunAllocationAttempt.make(1),
    target: { repository: "acme/app", baseCommit: "main", branch: "cloud/agent-1" },
    profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
    deadlines: {
      launchBy: NOW,
      bootBy: NOW,
      registerBy: NOW,
      expiresAt: NOW,
      cleanupBy: NOW,
    },
    allocationState: {
      status: "ready",
      instanceId: "i-live",
      references: {
        workerId: "worker-1",
        environmentId: "environment-1",
        threadId: "thread-1",
      },
      ...(idle === "hibernated"
        ? {}
        : {
            route: {
              httpBaseUrl: "https://worker.example.test/",
              wsBaseUrl: "wss://worker.example.test/",
              accessToken: "token",
            },
          }),
      readyAt: NOW,
    },
    agentOutcome:
      idle === "hibernated"
        ? { status: "succeeded", resultLocation: { uri: "/cloud/results/x" }, completedAt: NOW }
        : { status: "running", startedAt: NOW },
    previewState: { status: "unavailable" },
    idleState:
      idle === "hibernated"
        ? {
            status: "hibernated",
            hibernatedAt: NOW,
            snapshot: { instanceId: "i-stopped", capturedAt: NOW },
          }
        : { status: "busy" },
    cleanupState: { status: "not-requested" },
    handledCommandIds: [],
    sequence: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as RunAllocation;

const run: CloudRun = {
  id: CloudRunId.make("run-1"),
  agentId: CloudAgentId.make("agent-1"),
  allocationId: RunAllocationId.make("allocation-1"),
  branch: "cloud/agent-1",
  status: "RUNNING",
  startedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const snapshot = (messages: number): OrchestrationThreadDetailSnapshot => ({
  snapshotSequence: messages,
  thread: {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Large history",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "cloud/agent-1",
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    pullRequests: [],
    messages: Array.from({ length: messages }, (_, index) => ({
      id: MessageId.make(`message-${index}`),
      role: index % 2 === 0 ? "user" : "assistant",
      text: `Message ${index}`,
      turnId: null,
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    proposedPlans: [],
    activities: [
      {
        id: EventId.make("activity-tool"),
        tone: "tool",
        kind: "read_file",
        summary: "Read README",
        payload: { output: "huge tool output ".repeat(50) },
        turnId: null,
        createdAt: NOW,
      },
    ],
    checkpoints: [],
    session: null,
  },
});

function event(
  index: number,
  extra: Partial<CloudAgentsApiStreamEvent> = {},
): CloudAgentsApiStreamEvent {
  return {
    id: `${NOW_MS}-${index}`,
    event: "assistant",
    data: { text: `n=${index}` },
    createdAtMs: NOW_MS,
    ...extra,
  };
}

describe("cloud agent event stream", () => {
  it("resumes from Last-Event-ID and expires ids that fell out of the ring", () => {
    let buffer = emptyStreamBuffer();
    buffer = appendBoundedStreamEvent(buffer, event(1), { maxEvents: 2, maxBytes: 10_000 });
    buffer = appendBoundedStreamEvent(buffer, event(2), { maxEvents: 2, maxBytes: 10_000 });
    buffer = appendBoundedStreamEvent(buffer, event(3), { maxEvents: 2, maxBytes: 10_000 });
    const resumed = resumeBoundedStream({
      buffer,
      lastEventId: `${NOW_MS}-2`,
      nowMs: NOW_MS,
    });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.events.map((item) => item.id)).toEqual([`${NOW_MS}-3`]);
    }
    expect(
      resumeBoundedStream({ buffer, lastEventId: `${NOW_MS}-1`, nowMs: NOW_MS }),
    ).toMatchObject({ ok: false, error: { code: "stream_expired" } });
    expect(
      resumeBoundedStream({
        buffer,
        lastEventId: `${NOW_MS}-3`,
        nowMs: NOW_MS + (CLOUD_AGENTS_API_STREAM_RETENTION_SECONDS + 1) * 1_000,
      }),
    ).toMatchObject({ ok: false, error: { code: "stream_expired" } });
    expect(resumeBoundedStream({ buffer, lastEventId: "not-an-id", nowMs: NOW_MS })).toMatchObject({
      ok: false,
      error: { code: "invalid_last_event_id" },
    });
  });

  it("reconnects live workers with T3 cursors and reads hibernated transcripts without waking", () => {
    const live = selectReconnectSource({
      agent: agent("ACTIVE"),
      allocation: allocation("busy"),
      snapshotSequence: 42,
      workerTurnLimit: 20,
    });
    expect(live).toEqual({
      source: "worker-cursor",
      wake: false,
      afterSequence: 42,
      turnLimit: 20,
    });
    const hibernated = selectReconnectSource({
      agent: agent("IDLE"),
      allocation: allocation("hibernated"),
    });
    expect(hibernated).toEqual({
      source: "controller-transcript",
      wake: false,
      afterSequence: undefined,
      turnLimit: undefined,
    });
  });

  it("dedupes worker, controller, and live run-stream identities", () => {
    const fromWorker = eventsFromThreadSnapshot({
      snapshot: snapshot(2),
      run,
      nowMs: NOW_MS,
    });
    const fromController = eventsFromThreadSnapshot({
      snapshot: snapshot(2),
      run,
      nowMs: NOW_MS,
    });
    const live: CloudAgentsApiStreamEvent[] = [
      {
        id: "msg:message-1",
        event: "assistant",
        data: { text: "duplicate from live log" },
        createdAtMs: NOW_MS,
      },
    ];
    const merged = mergeStreamSources({ live, worker: fromWorker, controller: fromController });
    const ids = merged.flatMap((item) => (item.id === undefined ? [] : [item.id]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("msg:message-1");
    expect(ids).toContain("tool:activity-tool");
    expect(merged.find((item) => item.id === "tool:activity-tool")?.data).toMatchObject({
      summary: "Read README",
    });
  });

  it("pages histories under a byte budget instead of returning the whole log", () => {
    const page = pageHistory({
      items: [
        { id: "a", kind: "transcript", summary: "one", bytes: 80 },
        { id: "b", kind: "transcript", summary: "two", bytes: 80 },
        { id: "c", kind: "tool", summary: "tool", bytes: 80 },
      ],
      byteBudget: 150,
    });
    expect(page.items.map((item) => item.id)).toEqual(["a"]);
    expect(page.nextCursor).toBe("b");
    expect(page.truncated).toBe(true);
    expect(
      pageHistory({
        items: [
          { id: "a", kind: "transcript", summary: "one", bytes: 80 },
          { id: "b", kind: "transcript", summary: "two", bytes: 80 },
          { id: "c", kind: "tool", summary: "tool", bytes: 80 },
        ],
        cursor: "a",
        byteBudget: 150,
      }).items.map((item) => item.id),
    ).toEqual(["b"]);
  });

  it("measures restore cost for a large history against bounded buffers", () => {
    const events = Array.from({ length: 20_000 }, (_, index) =>
      event(index, { data: { text: "x".repeat(80) } }),
    );
    const lastEventId = events[events.length - 50]?.id;
    const report = measureStreamRestore({
      events,
      nowMs: NOW_MS,
      ...(lastEventId === undefined ? {} : { lastEventId }),
    });
    expect(report.bufferEvents).toBeLessThanOrEqual(CLOUD_AGENTS_API_STREAM_RETENTION_EVENTS);
    expect(report.bytes).toBeLessThanOrEqual(CLOUD_AGENTS_API_STREAM_RETENTION_BYTES);
    expect(report.duplicateCount).toBe(0);
    expect(report.restoreMs).toBeLessThan(2_000);
  });
});
