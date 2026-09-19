import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * A permanently deleted agent keeps no events, so this row is the only
   * record it leaves. It makes the delete idempotent and visible without
   * retaining any of the conversation it erased.
   */
  yield* sql`
    CREATE TABLE cloud_agent_deletions (
      allocation_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      deletion_json TEXT NOT NULL
    )
  `;
});
