import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_agent_schedules (
      schedule_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      principal_json TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      url_origin TEXT NOT NULL,
      status TEXT NOT NULL,
      next_run_at TEXT,
      occurrence_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_agent_schedules_due
    ON cloud_agent_schedules(status, next_run_at)
  `;

  yield* sql`
    CREATE TABLE cloud_agent_schedule_runs (
      schedule_id TEXT NOT NULL,
      occurrence_at TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      principal_json TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      terminal_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (schedule_id, occurrence_at)
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_agent_schedule_runs_pending
    ON cloud_agent_schedule_runs(terminal_status, updated_at)
  `;

  yield* sql`
    CREATE TABLE cloud_agent_schedule_activities (
      activity_id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      agent_id TEXT,
      run_id TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_agent_schedule_activities_principal
    ON cloud_agent_schedule_activities(principal_id, created_at DESC)
  `;
});
