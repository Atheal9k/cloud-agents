import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE cloud_controller_settings (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      admission_open INTEGER NOT NULL CHECK (admission_open IN (0, 1)),
      admission_updated_at TEXT
    )
  `;

  yield* sql`
    INSERT INTO cloud_controller_settings (
      singleton_id,
      admission_open,
      admission_updated_at
    ) VALUES (1, 1, NULL)
  `;
});
