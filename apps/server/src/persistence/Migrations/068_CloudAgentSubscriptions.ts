import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_agent_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      principal_json TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      url_origin TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_json TEXT NOT NULL,
      prompt_json TEXT,
      status TEXT NOT NULL,
      disabled_reason TEXT,
      coalesce_window_ms INTEGER NOT NULL,
      wake_max_days INTEGER NOT NULL,
      repair_count INTEGER NOT NULL DEFAULT 0,
      next_fire_at TEXT,
      last_delivery_at TEXT,
      last_run_id TEXT,
      retry_delivery_id TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cancelled_at TEXT,
      disabled_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_agent_subscriptions_agent
    ON cloud_agent_subscriptions(agent_id, created_at DESC)
  `;

  yield* sql`
    CREATE INDEX idx_cloud_agent_subscriptions_due
    ON cloud_agent_subscriptions(status, next_fire_at)
  `;

  yield* sql`
    CREATE TABLE cloud_agent_subscription_deliveries (
      subscription_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      status TEXT NOT NULL,
      acknowledged INTEGER NOT NULL,
      receipt_id TEXT NOT NULL,
      run_id TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subscription_id, delivery_id)
    )
  `;

  yield* sql`
    CREATE TABLE cloud_agent_subscription_receipts (
      receipt_id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      acknowledged INTEGER NOT NULL,
      message TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_agent_subscription_receipts_subscription
    ON cloud_agent_subscription_receipts(subscription_id, created_at DESC)
  `;
});
