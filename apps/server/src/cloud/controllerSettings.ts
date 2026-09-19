/**
 * The controller's singleton settings row: admission, and the cutover fence.
 *
 * Both the running controller and the offline `t3 cloud` commands read and
 * write this row, so the SQL lives here rather than inside either one.
 */
import type { CloudAllocationControllerWritability } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const EmptyRequest = Schema.Struct({});

export const ControllerSettingsRow = Schema.Struct({
  admissionOpen: Schema.Int,
  admissionUpdatedAt: Schema.NullOr(Schema.String),
  fencedAt: Schema.NullOr(Schema.String),
  fenceReason: Schema.NullOr(Schema.String),
});
export type ControllerSettingsRow = typeof ControllerSettingsRow.Type;

const AdmissionUpdate = Schema.Struct({
  admissionOpen: Schema.Boolean,
  occurredAt: Schema.String,
});

const FenceUpdate = Schema.Struct({
  fencedAt: Schema.String,
  reason: Schema.String,
});

/**
 * A fence with no timestamp is not a fence: the marker is what a cutover
 * writes, and only `t3 cloud adopt` removes it.
 */
export const writabilityFromRow = (
  row: ControllerSettingsRow,
): CloudAllocationControllerWritability =>
  row.fencedAt === null
    ? { status: "writable" }
    : {
        status: "fenced",
        fencedAt: row.fencedAt,
        reason:
          row.fenceReason === null || row.fenceReason.trim().length === 0
            ? "This controller state was fenced by a cutover."
            : row.fenceReason,
      };

export const make = Effect.fn("cloud.controllerSettings.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const read = SqlSchema.findOne({
    Request: EmptyRequest,
    Result: ControllerSettingsRow,
    execute: () => sql`
      SELECT
        admission_open AS "admissionOpen",
        admission_updated_at AS "admissionUpdatedAt",
        fenced_at AS "fencedAt",
        fence_reason AS "fenceReason"
      FROM cloud_controller_settings
      WHERE singleton_id = 1
    `,
  });

  const writeAdmission = SqlSchema.void({
    Request: AdmissionUpdate,
    execute: ({ admissionOpen, occurredAt }) => sql`
      UPDATE cloud_controller_settings
      SET
        admission_open = ${admissionOpen ? 1 : 0},
        admission_updated_at = ${occurredAt}
      WHERE singleton_id = 1
    `,
  });

  /** Fencing also stops admission so a restored copy cannot accept work
      between starting up and being adopted. */
  const writeFence = SqlSchema.void({
    Request: FenceUpdate,
    execute: ({ fencedAt, reason }) => sql`
      UPDATE cloud_controller_settings
      SET
        admission_open = 0,
        admission_updated_at = ${fencedAt},
        fenced_at = ${fencedAt},
        fence_reason = ${reason}
      WHERE singleton_id = 1
    `,
  });

  const clearFence = SqlSchema.void({
    Request: EmptyRequest,
    execute: () => sql`
      UPDATE cloud_controller_settings
      SET fenced_at = NULL, fence_reason = NULL
      WHERE singleton_id = 1
    `,
  });

  return { read, writeAdmission, writeFence, clearFence } as const;
});
