import {
  CloudManagedRuntime,
  CloudRuntimeCleanupQueueItem,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const EmptyRequest = Schema.Struct({});
const QueueRow = Schema.Struct({ item: Schema.fromJsonString(CloudRuntimeCleanupQueueItem) });
const encodeItem = Schema.encodeSync(Schema.fromJsonString(CloudRuntimeCleanupQueueItem));

export class CloudRuntimeCleanupQueueError extends Schema.TaggedError<CloudRuntimeCleanupQueueError>()(
  "CloudRuntimeCleanupQueueError",
  { message: TrimmedNonEmptyString },
) {}

function persistenceError(): CloudRuntimeCleanupQueueError {
  return new CloudRuntimeCleanupQueueError({
    message: "The managed runtime cleanup queue is unavailable.",
  });
}

export const make = Effect.fn("CloudRuntimeCleanupQueue.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readAll = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: QueueRow,
    execute: () => sql`
      SELECT item_json AS item
      FROM cloud_runtime_cleanup_queue
      ORDER BY next_retry_at ASC, runtime_id ASC
    `,
  });

  const list = readAll({}).pipe(
    Effect.map((rows) => rows.map((row) => row.item)),
    Effect.mapError(persistenceError),
  );

  const due = (now: string) =>
    list.pipe(Effect.map((items) => items.filter((item) => item.nextRetryAt <= now)));

  const recordFailure = Effect.fn("CloudRuntimeCleanupQueue.recordFailure")(function* (input: {
    readonly runtime: CloudManagedRuntime;
    readonly error: string;
    readonly occurredAt: string;
  }) {
    const existing = (yield* list).find(
      (item) => item.runtime.runtimeId === input.runtime.runtimeId,
    );
    const attempts = (existing?.attempts ?? 0) + 1;
    const delaySeconds = Math.min(30 * 2 ** Math.min(attempts - 1, 7), 60 * 60);
    const nextRetryAt = DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe(input.occurredAt), { seconds: delaySeconds }),
    );
    const item: CloudRuntimeCleanupQueueItem = {
      runtime: input.runtime,
      status: "pending",
      attempts,
      firstSeenAt: existing?.firstSeenAt ?? input.occurredAt,
      updatedAt: input.occurredAt,
      nextRetryAt,
      lastError: input.error.trim() || "Managed runtime deletion failed.",
    };
    yield* sql`
      INSERT INTO cloud_runtime_cleanup_queue (
        runtime_id, allocation_id, attempt, status, attempts,
        next_retry_at, item_json, first_seen_at, updated_at
      ) VALUES (
        ${input.runtime.runtimeId}, ${input.runtime.allocationId}, ${input.runtime.attempt},
        ${item.status}, ${attempts}, ${nextRetryAt}, ${encodeItem(item)},
        ${item.firstSeenAt}, ${item.updatedAt}
      )
      ON CONFLICT(runtime_id) DO UPDATE SET
        allocation_id = excluded.allocation_id,
        attempt = excluded.attempt,
        status = excluded.status,
        attempts = excluded.attempts,
        next_retry_at = excluded.next_retry_at,
        item_json = excluded.item_json,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(persistenceError));
    return item;
  });

  const markRetrying = Effect.fn("CloudRuntimeCleanupQueue.markRetrying")(function* (
    item: CloudRuntimeCleanupQueueItem,
    occurredAt: string,
  ) {
    const retrying: CloudRuntimeCleanupQueueItem = {
      ...item,
      status: "retrying",
      updatedAt: occurredAt,
    };
    yield* sql`
      UPDATE cloud_runtime_cleanup_queue
      SET status = ${retrying.status}, item_json = ${encodeItem(retrying)}, updated_at = ${occurredAt}
      WHERE runtime_id = ${item.runtime.runtimeId}
    `.pipe(Effect.mapError(persistenceError));
    return retrying;
  });

  const resolve = (runtimeId: string) =>
    sql`
      DELETE FROM cloud_runtime_cleanup_queue
      WHERE runtime_id = ${runtimeId}
    `.pipe(Effect.asVoid, Effect.mapError(persistenceError));

  return { list, due, recordFailure, markRetrying, resolve } as const;
});
