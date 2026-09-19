/**
 * Bounded controller-side run stream. T3 on the live worker remains the only
 * writable thread authority; this log is a derived, size-capped projection for
 * API SSE resume and hibernated review.
 */
import {
  CLOUD_AGENTS_API_HISTORY_PAGE_BYTES,
  CLOUD_AGENTS_API_STREAM_HEARTBEAT_MS,
  CLOUD_AGENTS_API_STREAM_RETENTION_BYTES,
  CLOUD_AGENTS_API_STREAM_RETENTION_EVENTS,
  CLOUD_AGENTS_API_STREAM_RETENTION_SECONDS,
  type CloudAgentsApiHistoryItem,
  type CloudAgentsApiHistoryKind,
  type CloudAgentsApiHistoryPage,
  type CloudAgentsApiReconnectSource,
  type CloudAgentsApiStreamEvent,
  type CloudAgent,
  type CloudRun,
  type OrchestrationThreadDetailSnapshot,
  type RunAllocation,
} from "@t3tools/contracts";

import { apiError, type CloudAgentsApiFailure } from "./cloudAgentsApiModel.ts";

export interface CloudStreamBuffer {
  readonly events: ReadonlyArray<CloudAgentsApiStreamEvent>;
  readonly bytes: number;
  readonly droppedOldestId: string | undefined;
}

export interface CloudStreamRestoreReport {
  readonly bytes: number;
  readonly bufferEvents: number;
  readonly restoreMs: number;
  readonly duplicateCount: number;
}

export interface CloudReconnectPlan {
  readonly source: CloudAgentsApiReconnectSource;
  readonly wake: false;
  readonly afterSequence: number | undefined;
  readonly turnLimit: number | undefined;
}

const STREAM_EVENT_ID = /^(?:\d+-\d+|msg:.+|tool:.+|status:.+|think:.+)$/;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function emptyStreamBuffer(): CloudStreamBuffer {
  return { events: [], bytes: 0, droppedOldestId: undefined };
}

export function streamEventBytes(event: CloudAgentsApiStreamEvent): number {
  return utf8Bytes(JSON.stringify(event));
}

export function appendBoundedStreamEvent(
  buffer: CloudStreamBuffer,
  event: CloudAgentsApiStreamEvent,
  limits: {
    readonly maxEvents?: number;
    readonly maxBytes?: number;
  } = {},
): CloudStreamBuffer {
  const maxEvents = limits.maxEvents ?? CLOUD_AGENTS_API_STREAM_RETENTION_EVENTS;
  const maxBytes = limits.maxBytes ?? CLOUD_AGENTS_API_STREAM_RETENTION_BYTES;
  const nextEvents = [...buffer.events, event];
  let bytes = buffer.bytes + streamEventBytes(event);
  let droppedOldestId = buffer.droppedOldestId;
  while (nextEvents.length > maxEvents || bytes > maxBytes) {
    const removed = nextEvents.shift();
    if (removed === undefined) break;
    bytes = Math.max(0, bytes - streamEventBytes(removed));
    if (removed.id !== undefined) droppedOldestId = removed.id;
  }
  return { events: nextEvents, bytes, droppedOldestId };
}

export function resumeBoundedStream(input: {
  readonly buffer: CloudStreamBuffer;
  readonly lastEventId: string | undefined;
  readonly nowMs: number;
  readonly retentionSeconds?: number;
}):
  | { readonly ok: true; readonly events: ReadonlyArray<CloudAgentsApiStreamEvent> }
  | { readonly ok: false; readonly error: CloudAgentsApiFailure } {
  const retention = (input.retentionSeconds ?? CLOUD_AGENTS_API_STREAM_RETENTION_SECONDS) * 1000;
  const newest = input.buffer.events[input.buffer.events.length - 1];
  if (newest !== undefined && input.nowMs - newest.createdAtMs > retention) {
    return { ok: false, error: apiError("stream_expired", "The run event stream has expired.") };
  }
  if (input.lastEventId === undefined) return { ok: true, events: input.buffer.events };
  if (!STREAM_EVENT_ID.test(input.lastEventId)) {
    return {
      ok: false,
      error: apiError("invalid_last_event_id", "Last-Event-ID does not belong to this run."),
    };
  }
  const index = input.buffer.events.findIndex((event) => event.id === input.lastEventId);
  if (index === -1) {
    return {
      ok: false,
      error: apiError("stream_expired", "Last-Event-ID is outside the retained stream window."),
    };
  }
  return { ok: true, events: input.buffer.events.slice(index + 1) };
}

export function selectReconnectSource(input: {
  readonly agent: CloudAgent;
  readonly allocation: RunAllocation;
  readonly snapshotSequence?: number;
  readonly workerTurnLimit?: number;
}): CloudReconnectPlan {
  const live =
    input.agent.status === "ACTIVE" &&
    input.allocation.allocationState.status === "ready" &&
    input.allocation.allocationState.route !== undefined &&
    input.allocation.idleState.status !== "hibernated" &&
    input.allocation.cleanupState.status === "not-requested";
  if (live) {
    return {
      source: "worker-cursor",
      wake: false,
      afterSequence: input.snapshotSequence,
      turnLimit: input.workerTurnLimit,
    };
  }
  return {
    source: "controller-transcript",
    wake: false,
    afterSequence: undefined,
    turnLimit: undefined,
  };
}

function createdAtMs(iso: string, fallback: number): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function eventsFromThreadSnapshot(input: {
  readonly snapshot: OrchestrationThreadDetailSnapshot;
  readonly run: CloudRun;
  readonly nowMs: number;
}): ReadonlyArray<CloudAgentsApiStreamEvent> {
  const events: CloudAgentsApiStreamEvent[] = [
    {
      id: `status:${input.run.id}`,
      event: "status",
      data: { runId: input.run.id, status: input.run.status },
      createdAtMs: createdAtMs(input.run.createdAt, input.nowMs),
    },
  ];
  for (const message of input.snapshot.thread.messages) {
    const thinking = message.role === "assistant" && message.streaming === true;
    events.push({
      id: thinking ? `think:${message.id}` : `msg:${message.id}`,
      event: thinking ? "thinking" : "assistant",
      data: { messageId: message.id, role: message.role, text: message.text },
      createdAtMs: createdAtMs(message.createdAt, input.nowMs),
    });
  }
  for (const activity of input.snapshot.thread.activities) {
    if (activity.tone !== "tool") continue;
    events.push({
      id: `tool:${activity.id}`,
      event: "tool_call",
      data: { callId: activity.id, name: activity.kind, summary: activity.summary },
      createdAtMs: createdAtMs(activity.createdAt, input.nowMs),
    });
  }
  return events;
}

export function mergeStreamSources(input: {
  readonly live: ReadonlyArray<CloudAgentsApiStreamEvent>;
  readonly worker: ReadonlyArray<CloudAgentsApiStreamEvent>;
  readonly controller: ReadonlyArray<CloudAgentsApiStreamEvent>;
}): ReadonlyArray<CloudAgentsApiStreamEvent> {
  const seen = new Set<string>();
  const merged: CloudAgentsApiStreamEvent[] = [];
  for (const event of [...input.live, ...input.worker, ...input.controller]) {
    if (event.id !== undefined) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
    }
    merged.push(event);
  }
  return merged.sort((left, right) => {
    if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
    return (left.id ?? "").localeCompare(right.id ?? "");
  });
}

export function maybeHeartbeat(input: {
  readonly events: ReadonlyArray<CloudAgentsApiStreamEvent>;
  readonly nowMs: number;
  readonly active: boolean;
}): ReadonlyArray<CloudAgentsApiStreamEvent> {
  if (!input.active) return input.events;
  const last = [...input.events].reverse().find((event) => event.event === "heartbeat");
  if (last !== undefined && input.nowMs - last.createdAtMs < CLOUD_AGENTS_API_STREAM_HEARTBEAT_MS) {
    return input.events;
  }
  return [
    ...input.events,
    {
      id: `${input.nowMs}-heartbeat`,
      event: "heartbeat",
      data: {},
      createdAtMs: input.nowMs,
    },
  ];
}

export function pageHistory(input: {
  readonly items: ReadonlyArray<CloudAgentsApiHistoryItem>;
  readonly cursor?: string;
  readonly byteBudget?: number;
}): CloudAgentsApiHistoryPage {
  const budget = input.byteBudget ?? CLOUD_AGENTS_API_HISTORY_PAGE_BYTES;
  const start =
    input.cursor === undefined
      ? 0
      : Math.max(0, input.items.findIndex((item) => item.id === input.cursor) + 1);
  const items: CloudAgentsApiHistoryItem[] = [];
  let bytes = 0;
  for (let index = start; index < input.items.length; index += 1) {
    const item = input.items[index];
    if (item === undefined) break;
    if (items.length > 0 && bytes + item.bytes > budget) {
      return { items, nextCursor: item.id, truncated: true, bytes };
    }
    items.push(item);
    bytes += item.bytes;
  }
  return { items, truncated: false, bytes };
}

export function historyItemsFromSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
  kind: CloudAgentsApiHistoryKind,
): ReadonlyArray<CloudAgentsApiHistoryItem> {
  if (kind === "transcript") {
    return snapshot.thread.messages.map((message) => ({
      id: `msg:${message.id}`,
      kind,
      summary: message.text.slice(0, 240),
      bytes: utf8Bytes(message.text),
    }));
  }
  if (kind === "tool") {
    return snapshot.thread.activities
      .filter((activity) => activity.tone === "tool")
      .map((activity) => ({
        id: `tool:${activity.id}`,
        kind,
        summary: activity.summary,
        bytes: utf8Bytes(JSON.stringify(activity.payload ?? activity.summary)),
      }));
  }
  return [];
}

export function measureStreamRestore(input: {
  readonly events: ReadonlyArray<CloudAgentsApiStreamEvent>;
  readonly lastEventId?: string;
  readonly nowMs: number;
}): CloudStreamRestoreReport {
  const started = performance.now();
  let buffer = emptyStreamBuffer();
  for (const event of input.events) {
    buffer = appendBoundedStreamEvent(buffer, event);
  }
  const resumed = resumeBoundedStream({
    buffer,
    lastEventId: input.lastEventId,
    nowMs: input.nowMs,
  });
  const restored = resumed.ok ? resumed.events : [];
  const ids = restored.flatMap((event) => (event.id === undefined ? [] : [event.id]));
  return {
    bytes: buffer.bytes,
    bufferEvents: buffer.events.length,
    restoreMs: performance.now() - started,
    duplicateCount: ids.length - new Set(ids).size,
  };
}
