import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_mac_hosts (
      host_id TEXT PRIMARY KEY,
      host_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_cloud_mac_hosts_updated_at
    ON cloud_mac_hosts(updated_at DESC, host_id)
  `;
});
