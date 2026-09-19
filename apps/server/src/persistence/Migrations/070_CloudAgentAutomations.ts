import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_agent_automations (
      automation_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      owner_principal_json TEXT NOT NULL,
      actor_principal_json TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      url_origin TEXT NOT NULL,
      status TEXT NOT NULL,
      hook_id TEXT,
      webhook_token_hash TEXT,
      webhook_token_prefix TEXT,
      next_run_at TEXT,
      occurrence_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_cloud_agent_automations_hook
    ON cloud_agent_automations(hook_id)
    WHERE hook_id IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX idx_cloud_agent_automations_due
    ON cloud_agent_automations(status, next_run_at)
  `;

  yield* sql`
    CREATE TABLE cloud_agent_automation_runs (
      automation_id TEXT NOT NULL,
      occurrence_at TEXT NOT NULL,
      delivery_id TEXT,
      principal_id TEXT NOT NULL,
      principal_json TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      terminal_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (automation_id, occurrence_at)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_cloud_agent_automation_deliveries
    ON cloud_agent_automation_runs(automation_id, delivery_id)
    WHERE delivery_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE cloud_agent_automation_activities (
      activity_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      delivery_id TEXT,
      agent_id TEXT,
      run_id TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_agent_automation_activities_principal
    ON cloud_agent_automation_activities(principal_id, created_at DESC)
  `;

  yield* sql`
    CREATE TABLE cloud_agent_automation_memories (
      fact_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      source_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
