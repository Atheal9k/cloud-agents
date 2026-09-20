/**
 * Build records and the one place a Build becomes an environment's active
 * snapshot. Activation happens in the same transaction that settles the Build,
 * so a failed, cancelled, or still-draft Build can never replace the last
 * active one.
 */
import {
  CloudEnvironmentBuild,
  CloudEnvironmentBuildError,
  CloudEnvironmentBuildId,
  type CloudEnvironmentBuildActivateInput,
  type CloudEnvironmentBuildCancelInput,
  type CloudEnvironmentBuildGitSetup,
  type CloudEnvironmentBuildOutcome,
  type CloudEnvironmentBuildSaveInput,
  type CloudEnvironmentBuildStaleThresholdInput,
  type CloudEnvironmentBuildTimings,
  type CloudEnvironmentBuildTrigger,
  type CloudEnvironmentBase,
  CloudEnvironmentId,
  type CloudEnvironmentVersion,
  type CloudRepositoryCommandResult,
  NonNegativeInt,
  PositiveInt,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const EmptyRequest = Schema.Struct({});
const BuildIdRequest = Schema.Struct({ buildId: CloudEnvironmentBuildId });
const EnvironmentIdRequest = Schema.Struct({ environmentId: CloudEnvironmentId });
const BuildRow = Schema.Struct({ value: Schema.fromJsonString(CloudEnvironmentBuild) });
const ChangedRow = Schema.Struct({ changed: Schema.Int });
const StaleThresholdRow = Schema.Struct({
  staleThresholdSeconds: Schema.NullOr(NonNegativeInt),
});
const encodeBuild = Schema.encodeSync(Schema.fromJsonString(CloudEnvironmentBuild));

export interface CloudEnvironmentBuildStart {
  readonly buildId: CloudEnvironmentBuildId;
  readonly version: CloudEnvironmentVersion;
  readonly trigger: CloudEnvironmentBuildTrigger;
  readonly draft: boolean;
  readonly setupThreadId?: ThreadId | undefined;
  readonly base: CloudEnvironmentBase;
  readonly inputsFingerprint: string;
  readonly startedAt: string;
}

export interface CloudEnvironmentBuildCompletion {
  readonly buildId: CloudEnvironmentBuildId;
  readonly gitSetup: ReadonlyArray<CloudEnvironmentBuildGitSetup>;
  readonly logs: ReadonlyArray<CloudRepositoryCommandResult>;
  readonly timings: CloudEnvironmentBuildTimings;
  readonly outcome: CloudEnvironmentBuildOutcome;
}

export class CloudEnvironmentBuildCatalog extends Context.Service<
  CloudEnvironmentBuildCatalog,
  {
    readonly list: Effect.Effect<ReadonlyArray<CloudEnvironmentBuild>, CloudEnvironmentBuildError>;
    readonly read: (
      buildId: CloudEnvironmentBuildId,
    ) => Effect.Effect<CloudEnvironmentBuild | undefined, CloudEnvironmentBuildError>;
    readonly activeBuild: (
      environmentId: CloudEnvironmentId,
    ) => Effect.Effect<CloudEnvironmentBuild | undefined, CloudEnvironmentBuildError>;
    readonly staleThresholdSeconds: (
      environmentId: CloudEnvironmentId,
    ) => Effect.Effect<number | undefined, CloudEnvironmentBuildError>;
    readonly start: (
      input: CloudEnvironmentBuildStart,
    ) => Effect.Effect<CloudEnvironmentBuild, CloudEnvironmentBuildError>;
    readonly complete: (
      input: CloudEnvironmentBuildCompletion,
    ) => Effect.Effect<CloudEnvironmentBuild, CloudEnvironmentBuildError>;
    readonly cancel: (
      input: CloudEnvironmentBuildCancelInput,
    ) => Effect.Effect<CloudEnvironmentBuild, CloudEnvironmentBuildError>;
    readonly save: (
      input: CloudEnvironmentBuildSaveInput,
    ) => Effect.Effect<CloudEnvironmentBuild, CloudEnvironmentBuildError>;
    readonly markSetupReady: (input: {
      readonly buildId: CloudEnvironmentBuildId;
      readonly occurredAt: string;
    }) => Effect.Effect<CloudEnvironmentBuild, CloudEnvironmentBuildError>;
    readonly activate: (
      input: CloudEnvironmentBuildActivateInput,
    ) => Effect.Effect<CloudEnvironmentBuild, CloudEnvironmentBuildError>;
    readonly setStaleThreshold: (
      input: CloudEnvironmentBuildStaleThresholdInput,
    ) => Effect.Effect<void, CloudEnvironmentBuildError>;
  }
>()("t3/cloud/CloudEnvironmentBuildCatalog") {}

function buildError(
  reason: CloudEnvironmentBuildError["reason"],
  message: string,
): CloudEnvironmentBuildError {
  return new CloudEnvironmentBuildError({ reason, message });
}

function persistenceError(): CloudEnvironmentBuildError {
  return buildError("persistence-failed", "The cloud environment Build catalog is unavailable.");
}

/** A conditional write raises this itself; anything else is a storage fault. */
function isBuildError(cause: unknown): cause is CloudEnvironmentBuildError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "CloudEnvironmentBuildError"
  );
}

/** Only a saved, successful Build has a snapshot worth booting. */
function activatesEnvironment(build: CloudEnvironmentBuild): boolean {
  return !build.draft && build.outcome.status === "succeeded";
}

export const make = Effect.fn("CloudEnvironmentBuildCatalog.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);

  const readAll = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: BuildRow,
    execute: () => sql`
      SELECT build_json AS value
      FROM cloud_environment_builds
      ORDER BY started_at DESC, build_id ASC
    `,
  });

  const readOne = SqlSchema.findAll({
    Request: BuildIdRequest,
    Result: BuildRow,
    execute: ({ buildId }) => sql`
      SELECT build_json AS value
      FROM cloud_environment_builds
      WHERE build_id = ${buildId}
    `,
  });

  const readActive = SqlSchema.findAll({
    Request: EnvironmentIdRequest,
    Result: BuildRow,
    execute: ({ environmentId }) => sql`
      SELECT builds.build_json AS value
      FROM cloud_environment_builds AS builds
      JOIN cloud_environments AS environments
        ON environments.active_build_id = builds.build_id
      WHERE environments.environment_id = ${environmentId}
    `,
  });

  const readStaleThreshold = SqlSchema.findAll({
    Request: EnvironmentIdRequest,
    Result: StaleThresholdRow,
    execute: ({ environmentId }) => sql`
      SELECT stale_build_threshold_seconds AS "staleThresholdSeconds"
      FROM cloud_environments
      WHERE environment_id = ${environmentId}
    `,
  });

  const readChanged = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: ChangedRow,
    execute: () => sql`SELECT changes() AS changed`,
  });

  const readBuild = Effect.fn("CloudEnvironmentBuildCatalog.readBuild")(function* (
    buildId: CloudEnvironmentBuildId,
  ) {
    const rows = yield* readOne({ buildId }).pipe(Effect.mapError(persistenceError));
    return rows[0]?.value;
  });

  const requireBuild = Effect.fn("CloudEnvironmentBuildCatalog.requireBuild")(function* (
    buildId: CloudEnvironmentBuildId,
  ) {
    const build = yield* readBuild(buildId);
    if (build === undefined) {
      return yield* buildError("build-not-found", `Build '${buildId}' does not exist.`);
    }
    return build;
  });

  /**
   * Writes the record and, when it earns activation, repoints the environment
   * in the same transaction. `freshAt` on a skipped Build's reused snapshot is
   * bumped here too, so a skipped recurring trigger still resets staleness.
   *
   * Updates match on the status the caller read, so two writers racing to
   * settle the same Build cannot both win and a cancelled Build can never be
   * overwritten by a late success.
   */
  const persist = Effect.fn("CloudEnvironmentBuildCatalog.persist")(function* (input: {
    readonly build: CloudEnvironmentBuild;
    readonly expected: "new" | { readonly status: string; readonly draft: boolean };
    readonly updatedAt: string;
  }): Effect.fn.Return<void, CloudEnvironmentBuildError> {
    const build = input.build;
    const expected = input.expected;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (expected === "new") {
            yield* sql`
            INSERT INTO cloud_environment_builds (
              build_id, environment_id, version, status, draft,
              inputs_fingerprint, build_json, started_at, updated_at
            ) VALUES (
              ${build.id}, ${build.environmentId}, ${build.version}, ${build.outcome.status},
              ${build.draft ? 1 : 0}, ${build.inputsFingerprint}, ${encodeBuild(build)},
              ${build.startedAt}, ${input.updatedAt}
            )
          `;
          } else {
            yield* sql`
            UPDATE cloud_environment_builds
            SET
              status = ${build.outcome.status},
              draft = ${build.draft ? 1 : 0},
              build_json = ${encodeBuild(build)},
              updated_at = ${input.updatedAt}
            WHERE build_id = ${build.id}
              AND status = ${expected.status}
              AND draft = ${expected.draft ? 1 : 0}
          `;
            const changed = yield* readChanged({});
            if ((changed[0]?.changed ?? 0) === 0) {
              return yield* buildError(
                "build-already-settled",
                `Build '${build.id}' changed while it was being settled.`,
              );
            }
          }
          if (build.outcome.status === "skipped") {
            yield* sql`
            UPDATE cloud_environment_builds
            SET build_json = json_set(build_json, '$.freshAt', ${input.updatedAt})
            WHERE build_id = ${build.outcome.reusedBuildId}
          `;
            return;
          }
          if (!activatesEnvironment(build)) return;
          yield* sql`
          UPDATE cloud_environments
          SET active_build_id = ${build.id}, updated_at = ${input.updatedAt}
          WHERE environment_id = ${build.environmentId}
        `;
        }),
      )
      .pipe(Effect.catch((cause) => Effect.fail(isBuildError(cause) ? cause : persistenceError())));
  });

  const list = mutex.withPermits(1)(
    readAll({}).pipe(
      Effect.map((rows) => rows.map((row) => row.value)),
      Effect.mapError(persistenceError),
    ),
  );

  const read: CloudEnvironmentBuildCatalog["Service"]["read"] = (buildId) =>
    mutex.withPermits(1)(readBuild(buildId));

  const activeBuild: CloudEnvironmentBuildCatalog["Service"]["activeBuild"] = (environmentId) =>
    mutex.withPermits(1)(
      readActive({ environmentId }).pipe(
        Effect.map((rows) => rows[0]?.value),
        Effect.mapError(persistenceError),
      ),
    );

  const staleThresholdSeconds: CloudEnvironmentBuildCatalog["Service"]["staleThresholdSeconds"] = (
    environmentId,
  ) =>
    mutex.withPermits(1)(
      readStaleThreshold({ environmentId }).pipe(
        Effect.map((rows) => rows[0]?.staleThresholdSeconds ?? undefined),
        Effect.mapError(persistenceError),
      ),
    );

  const start: CloudEnvironmentBuildCatalog["Service"]["start"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* readBuild(input.buildId);
        if (existing !== undefined) return existing;
        const build: CloudEnvironmentBuild = {
          id: input.buildId,
          environmentId: input.version.environmentId,
          versionId: input.version.id,
          version: PositiveInt.make(input.version.version),
          trigger: input.trigger,
          draft: input.draft,
          ...(input.setupThreadId === undefined ? {} : { setupThreadId: input.setupThreadId }),
          base: input.base,
          inputsFingerprint: input.inputsFingerprint,
          gitSetup: [],
          logs: [],
          timings: {},
          outcome: { status: "running" },
          startedAt: input.startedAt,
        };
        yield* persist({ build, expected: "new", updatedAt: input.startedAt });
        return build;
      }),
    );

  const complete: CloudEnvironmentBuildCatalog["Service"]["complete"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* requireBuild(input.buildId);
        if (existing.outcome.status !== "running") {
          return yield* buildError(
            "build-already-settled",
            `Build '${input.buildId}' already finished as '${existing.outcome.status}'.`,
          );
        }
        const settledAt =
          input.outcome.status === "running" ? existing.startedAt : input.outcome.completedAt;
        const build: CloudEnvironmentBuild = {
          ...existing,
          gitSetup: input.gitSetup,
          logs: input.logs,
          timings: input.timings,
          outcome: input.outcome,
          ...(input.outcome.status === "succeeded" ? { freshAt: settledAt } : {}),
        };
        yield* persist({
          build,
          expected: { status: "running", draft: existing.draft },
          updatedAt: settledAt,
        });
        return build;
      }),
    );

  const cancel: CloudEnvironmentBuildCatalog["Service"]["cancel"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* requireBuild(input.buildId);
        if (existing.outcome.status !== "running") {
          return yield* buildError(
            "build-already-settled",
            `Build '${input.buildId}' already finished as '${existing.outcome.status}'.`,
          );
        }
        const build: CloudEnvironmentBuild = {
          ...existing,
          outcome: { status: "cancelled", completedAt: input.occurredAt },
        };
        yield* persist({
          build,
          expected: { status: "running", draft: existing.draft },
          updatedAt: input.occurredAt,
        });
        return build;
      }),
    );

  const save: CloudEnvironmentBuildCatalog["Service"]["save"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* requireBuild(input.buildId);
        if (!existing.draft) {
          return yield* buildError("build-not-draft", `Build '${input.buildId}' is already saved.`);
        }
        if (existing.outcome.status === "running") {
          return yield* buildError(
            "build-in-progress",
            `Build '${input.buildId}' is still running.`,
          );
        }
        if (existing.outcome.status !== "succeeded") {
          return yield* buildError(
            "build-unsuccessful",
            `Build '${input.buildId}' finished as '${existing.outcome.status}' and cannot become active.`,
          );
        }
        const build: CloudEnvironmentBuild = {
          ...existing,
          draft: false,
          freshAt: input.occurredAt,
        };
        yield* persist({
          build,
          expected: { status: "succeeded", draft: true },
          updatedAt: input.occurredAt,
        });
        return build;
      }),
    );

  const markSetupReady: CloudEnvironmentBuildCatalog["Service"]["markSetupReady"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* requireBuild(input.buildId);
        if (!existing.draft || existing.outcome.status !== "succeeded") {
          return yield* buildError(
            "build-unsuccessful",
            `Build '${input.buildId}' must be a successful draft before setup can be saved.`,
          );
        }
        const build: CloudEnvironmentBuild = {
          ...existing,
          readyToSaveAt: input.occurredAt,
        };
        yield* persist({
          build,
          expected: { status: "succeeded", draft: true },
          updatedAt: input.occurredAt,
        });
        return build;
      }),
    );

  const activate: CloudEnvironmentBuildCatalog["Service"]["activate"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* requireBuild(input.buildId);
        if (existing.draft) {
          return yield* buildError(
            "build-not-saved",
            `Build '${input.buildId}' is still a draft and cannot become active.`,
          );
        }
        if (existing.outcome.status !== "succeeded") {
          return yield* buildError(
            "build-unsuccessful",
            `Build '${input.buildId}' finished as '${existing.outcome.status}' and cannot become active.`,
          );
        }
        yield* sql`
          UPDATE cloud_environments
          SET active_build_id = ${existing.id}, updated_at = ${input.occurredAt}
          WHERE environment_id = ${existing.environmentId}
        `.pipe(Effect.mapError(persistenceError));
        return existing;
      }),
    );

  const setStaleThreshold: CloudEnvironmentBuildCatalog["Service"]["setStaleThreshold"] = (input) =>
    mutex.withPermits(1)(
      sql`
        UPDATE cloud_environments
        SET stale_build_threshold_seconds = ${input.staleThresholdSeconds},
            updated_at = ${input.occurredAt}
        WHERE environment_id = ${input.environmentId}
      `.pipe(Effect.asVoid, Effect.mapError(persistenceError)),
    );

  return CloudEnvironmentBuildCatalog.of({
    list,
    read,
    activeBuild,
    staleThresholdSeconds,
    start,
    complete,
    cancel,
    save,
    markSetupReady,
    activate,
    setStaleThreshold,
  });
});

export const layer = Layer.effect(CloudEnvironmentBuildCatalog, make());
