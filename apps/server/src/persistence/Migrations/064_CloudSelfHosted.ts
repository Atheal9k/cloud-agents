import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN default_self_hosted_mode TEXT`;

  yield* sql`
    CREATE TABLE cloud_self_hosted_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      state_json TEXT NOT NULL
    )
  `;
});
