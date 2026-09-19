import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_assistants (
      assistant_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      workspace_owner TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      data_key TEXT NOT NULL,
      agent_id TEXT,
      status TEXT NOT NULL,
      credentials TEXT NOT NULL,
      snapshots TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_assistants_principal
    ON cloud_assistants(principal_id, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE cloud_assistant_memory (
      fact_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      text TEXT NOT NULL,
      source_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_assistant_memory_assistant
    ON cloud_assistant_memory(assistant_id, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE cloud_assistant_persistence (
      assistant_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (assistant_id, kind)
    )
  `;

  yield* sql`
    CREATE TABLE cloud_assistant_subscriptions (
      assistant_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (assistant_id, subscription_id)
    )
  `;
});
