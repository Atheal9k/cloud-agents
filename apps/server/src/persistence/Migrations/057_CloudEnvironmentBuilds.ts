import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_environment_builds (
      build_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      status TEXT NOT NULL,
      draft INTEGER NOT NULL,
      inputs_fingerprint TEXT NOT NULL,
      build_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (environment_id) REFERENCES cloud_environments(environment_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_environment_builds_environment
    ON cloud_environment_builds(environment_id, started_at DESC, build_id)
  `;

  /** NULL keeps the 24 hour default rather than freezing it into every row. */
  yield* sql`
    ALTER TABLE cloud_environments
    ADD COLUMN stale_build_threshold_seconds INTEGER
  `;
});
