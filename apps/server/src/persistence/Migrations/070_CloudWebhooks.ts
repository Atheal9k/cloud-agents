import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_webhook_endpoints (
      endpoint_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events_json TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_webhook_endpoints_principal
    ON cloud_webhook_endpoints(principal_id, created_at DESC)
  `;

  yield* sql`
    CREATE TABLE cloud_webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      http_status INTEGER,
      last_error TEXT,
      payload_json TEXT NOT NULL,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_webhook_deliveries_due
    ON cloud_webhook_deliveries(status, next_attempt_at)
  `;

  yield* sql`
    CREATE INDEX idx_cloud_webhook_deliveries_endpoint
    ON cloud_webhook_deliveries(endpoint_id, created_at DESC)
  `;

  yield* sql`
    CREATE TABLE cloud_agents_api_idempotency (
      principal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (principal_id, idempotency_key)
    )
  `;
});
