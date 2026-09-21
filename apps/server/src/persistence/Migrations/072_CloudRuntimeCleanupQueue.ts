import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_runtime_cleanup_queue (
      runtime_id TEXT PRIMARY KEY,
      allocation_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_retry_at TEXT NOT NULL,
      item_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_runtime_cleanup_queue_due
    ON cloud_runtime_cleanup_queue(status, next_retry_at, runtime_id)
  `;
});
