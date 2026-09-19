import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE cloud_agents_api_keys
    ADD COLUMN team_id TEXT NOT NULL DEFAULT 'local-team'
  `;

  yield* sql`
    ALTER TABLE cloud_agents_api_records
    ADD COLUMN team_id TEXT NOT NULL DEFAULT 'local-team'
  `;

  yield* sql`
    CREATE TABLE cloud_scm_connections (
      connection_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      installed_json TEXT NOT NULL,
      connected_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE cloud_run_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      entry_point TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
