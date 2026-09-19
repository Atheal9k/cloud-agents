import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_warm_guests (
      guest_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_by_allocation_id TEXT,
      guest_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_warm_guests_claim
    ON cloud_warm_guests(environment_id, version_id, profile_id, build_id, status, created_at, guest_id)
  `;

  yield* sql`
    CREATE TABLE cloud_warm_pool_timings (
      kind TEXT PRIMARY KEY,
      duration_ms INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
});
