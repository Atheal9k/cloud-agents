import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_allocation_events (
      allocation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      command_id TEXT NOT NULL UNIQUE,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      occurred_at TEXT NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (allocation_id, sequence)
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_allocation_events_occurred_at
    ON cloud_allocation_events(occurred_at, allocation_id, sequence)
  `;
});
