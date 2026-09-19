import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_environments (
      environment_id TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL CHECK (current_version > 0),
      active_build_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE cloud_environment_versions (
      environment_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      version_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (environment_id, version),
      FOREIGN KEY (environment_id) REFERENCES cloud_environments(environment_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_environment_versions_created_at
    ON cloud_environment_versions(created_at, environment_id, version)
  `;
});
