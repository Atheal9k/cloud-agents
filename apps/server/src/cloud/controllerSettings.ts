/**
 * The controller's singleton settings row: admission, launch defaults, and the
 * cutover fence.
 *
 * Both the running controller and the offline `t3 cloud` commands read and
 * write this row, so the SQL lives here rather than inside either one.
 */
import type {
  CloudAllocationControllerWritability,
  CloudControllerDefaults,
} from "@t3tools/contracts";
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
  defaultModel: Schema.NullOr(Schema.String),
  defaultRepository: Schema.NullOr(Schema.String),
  defaultRef: Schema.NullOr(Schema.String),
  defaultContext: Schema.NullOr(Schema.String),
  defaultLongRunning: Schema.NullOr(Schema.Int),
  defaultComputerUse: Schema.NullOr(Schema.Int),
  defaultSummaries: Schema.NullOr(Schema.Int),
  defaultArtifactsToGit: Schema.NullOr(Schema.Int),
  defaultCollaboration: Schema.NullOr(Schema.String),
  defaultSelfHostedMode: Schema.NullOr(Schema.String),
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

const DefaultsUpdate = Schema.Struct({
  defaultModel: Schema.NullOr(Schema.String),
  defaultRepository: Schema.NullOr(Schema.String),
  defaultRef: Schema.NullOr(Schema.String),
  defaultContext: Schema.NullOr(Schema.String),
  defaultLongRunning: Schema.NullOr(Schema.Int),
  defaultComputerUse: Schema.NullOr(Schema.Int),
  defaultSummaries: Schema.NullOr(Schema.Int),
  defaultArtifactsToGit: Schema.NullOr(Schema.Int),
  defaultCollaboration: Schema.NullOr(Schema.String),
  defaultSelfHostedMode: Schema.NullOr(Schema.String),
});

/**
 * A blank column is the absence of a default, not a default of "". Trimming
 * here means the screen and the launcher agree about what "unset" looks like.
 */
export const defaultsFromRow = (row: ControllerSettingsRow): CloudControllerDefaults => {
  const value = (raw: string | null) => {
    const trimmed = raw?.trim() ?? "";
    return trimmed.length === 0 ? undefined : trimmed;
  };
  const flag = (raw: number | null): boolean | undefined =>
    raw === null ? undefined : raw === 1;
  const model = value(row.defaultModel);
  const context = value(row.defaultContext);
  const repository = value(row.defaultRepository);
  const ref = value(row.defaultRef);
  const collaboration = value(row.defaultCollaboration);
  const longRunning = flag(row.defaultLongRunning);
  const computerUse = flag(row.defaultComputerUse);
  const summaries = flag(row.defaultSummaries);
  const artifactsToGit = flag(row.defaultArtifactsToGit);
  return {
    ...(model === undefined ? {} : { model }),
    ...(context === undefined ? {} : { context }),
    ...(repository === undefined ? {} : { repository }),
    ...(ref === undefined ? {} : { ref }),
    ...(longRunning === undefined ? {} : { longRunning }),
    ...(computerUse === undefined ? {} : { computerUse }),
    ...(summaries === undefined ? {} : { summaries }),
    ...(artifactsToGit === undefined ? {} : { artifactsToGit }),
    ...(collaboration === "disabled" ||
    collaboration === "service-accounts" ||
    collaboration === "all"
      ? { collaboration }
      : {}),
    ...(row.defaultSelfHostedMode === "off" ||
    row.defaultSelfHostedMode === "allow" ||
    row.defaultSelfHostedMode === "require"
      ? { selfHostedMode: row.defaultSelfHostedMode }
      : {}),
  };
};

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
        fence_reason AS "fenceReason",
        default_model AS "defaultModel",
        default_repository AS "defaultRepository",
        default_ref AS "defaultRef",
        default_context AS "defaultContext",
        default_long_running AS "defaultLongRunning",
        default_computer_use AS "defaultComputerUse",
        default_summaries AS "defaultSummaries",
        default_artifacts_to_git AS "defaultArtifactsToGit",
        default_collaboration AS "defaultCollaboration",
        default_self_hosted_mode AS "defaultSelfHostedMode"
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

  const writeDefaults = SqlSchema.void({
    Request: DefaultsUpdate,
    execute: ({
      defaultModel,
      defaultRepository,
      defaultRef,
      defaultContext,
      defaultLongRunning,
      defaultComputerUse,
      defaultSummaries,
      defaultArtifactsToGit,
      defaultCollaboration,
      defaultSelfHostedMode,
    }) => sql`
      UPDATE cloud_controller_settings
      SET
        default_model = ${defaultModel},
        default_repository = ${defaultRepository},
        default_ref = ${defaultRef},
        default_context = ${defaultContext},
        default_long_running = ${defaultLongRunning},
        default_computer_use = ${defaultComputerUse},
        default_summaries = ${defaultSummaries},
        default_artifacts_to_git = ${defaultArtifactsToGit},
        default_collaboration = ${defaultCollaboration},
        default_self_hosted_mode = ${defaultSelfHostedMode}
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

  return { read, writeAdmission, writeDefaults, writeFence, clearFence } as const;
});
