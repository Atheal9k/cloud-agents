import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_github_triggers (
      trigger_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      principal_json TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      url_origin TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_github_triggers_principal
    ON cloud_github_triggers(principal_id, created_at DESC)
  `;

  yield* sql`
    CREATE TABLE cloud_github_trigger_activities (
      trigger_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_json TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      reserved_compute_seconds INTEGER NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      agent_id TEXT,
      run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (trigger_id, delivery_id)
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_github_trigger_activities_principal
    ON cloud_github_trigger_activities(principal_id, created_at DESC)
  `;

  yield* sql`
    CREATE INDEX idx_cloud_github_trigger_attempts
    ON cloud_github_trigger_activities(trigger_id, source_key, status)
  `;
});
