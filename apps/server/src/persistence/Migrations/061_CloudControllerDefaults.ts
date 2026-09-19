import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Launch defaults live beside admission because they are the same kind of
 * thing: one operator decision that every client reads and no client owns.
 * NULL means "no default", which is not the same as an empty string.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN default_model TEXT`;
  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN default_repository TEXT`;
  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN default_ref TEXT`;
});
