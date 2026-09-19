import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN default_context TEXT`;
  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN default_long_running INTEGER`;
  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN default_computer_use INTEGER`;
  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN default_summaries INTEGER`;
  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN default_artifacts_to_git INTEGER`;
  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN default_collaboration TEXT`;

  yield* sql`
    CREATE TABLE cloud_spend_limits (
      principal_kind TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      period TEXT NOT NULL,
      cap_usd REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (principal_kind, principal_id, period)
    )
  `;

  yield* sql`
    CREATE TABLE cloud_spend_attributions (
      allocation_id TEXT PRIMARY KEY,
      principal_kind TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      attributed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE cloud_invoices (
      invoice_id TEXT PRIMARY KEY,
      invoice_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE cloud_audit_events (
      event_id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      event_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_audit_events_occurred_at
    ON cloud_audit_events(occurred_at DESC, event_id)
  `;
});
