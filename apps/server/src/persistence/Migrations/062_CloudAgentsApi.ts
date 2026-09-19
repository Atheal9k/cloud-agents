import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_agents_api_keys (
      key_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL,
      user_email TEXT,
      user_first_name TEXT,
      user_last_name TEXT
    )
  `;

  yield* sql`
    CREATE TABLE cloud_agents_api_records (
      agent_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      allocation_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_agents_api_records_principal
    ON cloud_agents_api_records(principal_id, created_at DESC)
  `;
});
