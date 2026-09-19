import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A fence marker travels with the controller's state directory, so a copy taken
 * during a cutover is fenced too. Only an explicit `t3 cloud adopt` clears it,
 * which is what keeps exactly one writable controller after the move.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN fenced_at TEXT`;
  yield* sql`ALTER TABLE cloud_controller_settings ADD COLUMN fence_reason TEXT`;
});
