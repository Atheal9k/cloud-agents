import {
  CloudEnvironment,
  CloudEnvironmentBuildId,
  CloudEnvironmentError,
  CloudEnvironmentId,
  cloudEnvironmentSecretValidationMessage,
  cloudEnvironmentVersionSummary,
  cloudNetworkProfileDetails,
  type CloudEnvironmentResolution,
  type CloudEnvironmentResolutionInput,
  type CloudEnvironmentRestoreInput,
  type CloudEnvironmentSaveInput,
  CloudEnvironmentVersion,
  CloudEnvironmentVersionId,
  PositiveInt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const EmptyRequest = Schema.Struct({});
const EnvironmentIdRequest = Schema.Struct({ environmentId: CloudEnvironmentId });
const EnvironmentHeadRow = Schema.Struct({
  environmentId: CloudEnvironmentId,
  currentVersion: PositiveInt,
  activeBuildId: Schema.NullOr(CloudEnvironmentBuildId),
  staleBuildThresholdSeconds: Schema.NullOr(Schema.Int),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const EnvironmentVersionRow = Schema.Struct({
  environmentId: CloudEnvironmentId,
  version: PositiveInt,
  value: Schema.fromJsonString(CloudEnvironmentVersion),
});
const encodeVersion = Schema.encodeSync(Schema.fromJsonString(CloudEnvironmentVersion));

export class CloudEnvironmentCatalog extends Context.Service<
  CloudEnvironmentCatalog,
  {
    readonly list: Effect.Effect<ReadonlyArray<CloudEnvironment>, CloudEnvironmentError>;
    readonly save: (
      input: CloudEnvironmentSaveInput,
    ) => Effect.Effect<CloudEnvironment, CloudEnvironmentError>;
    readonly restore: (
      input: CloudEnvironmentRestoreInput,
    ) => Effect.Effect<CloudEnvironment, CloudEnvironmentError>;
    readonly resolve: (
      input: CloudEnvironmentResolutionInput,
    ) => Effect.Effect<CloudEnvironmentResolution | null, CloudEnvironmentError>;
  }
>()("t3/cloud/CloudEnvironmentCatalog") {}

function catalogError(
  reason: CloudEnvironmentError["reason"],
  message: string,
): CloudEnvironmentError {
  return new CloudEnvironmentError({ reason, message });
}

function persistenceError(): CloudEnvironmentError {
  return catalogError("persistence-failed", "The cloud environment catalog is unavailable.");
}

function effectivePolicy(
  config: CloudEnvironmentVersion["config"],
  secrets: CloudEnvironmentVersion["secretReferences"],
): CloudEnvironmentVersion["effectivePolicy"] {
  return {
    runtimeUser: config.user ?? "root",
    egressMode: config.egressMode ?? "default_with_network_settings",
    egressAllowlist: config.egressAllowlist ?? [],
    testingEnabled: config.enable_testing !== false && config.enable_testing !== "false",
    disableAllMcpServers: config.disableAllMcpServers ?? false,
    mcpServerAllowlist: config.mcpServerAllowlist ?? [],
    ports: config.ports ?? [],
    secrets,
    privateDependencies: config.privateDependencies ?? [],
    networkProfile: cloudNetworkProfileDetails(config.networkProfile),
  };
}

function scopePriority(version: CloudEnvironmentVersion): number {
  switch (version.source.type) {
    case "repository":
      return 0;
    case "saved":
      switch (version.source.scope) {
        case "personal":
          return 1;
        case "team":
          return 2;
        case "default":
          return 3;
      }
  }
}

/** Committed repository config wins, then personal, then team, then default. */
function pickForRepository(
  environments: ReadonlyArray<CloudEnvironment>,
  repository: string,
): CloudEnvironmentVersion | undefined {
  return environments
    .map((environment) => environment.current)
    .filter((version) => version.repositories.some((entry) => entry.repository === repository))
    .sort((left, right) => scopePriority(left) - scopePriority(right))[0];
}

function reference(version: CloudEnvironmentVersion): CloudEnvironmentResolution["reference"] {
  return {
    environmentId: version.environmentId,
    versionId: version.id,
    version: version.version,
    source: version.source,
  };
}

export const make = Effect.fn("CloudEnvironmentCatalog.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);

  const readHeads = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: EnvironmentHeadRow,
    execute: () => sql`
      SELECT
        environment_id AS "environmentId",
        current_version AS "currentVersion",
        active_build_id AS "activeBuildId",
        stale_build_threshold_seconds AS "staleBuildThresholdSeconds",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM cloud_environments
      ORDER BY updated_at DESC, environment_id ASC
    `,
  });

  const readVersions = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: EnvironmentVersionRow,
    execute: () => sql`
      SELECT
        environment_id AS "environmentId",
        version,
        version_json AS value
      FROM cloud_environment_versions
      ORDER BY environment_id ASC, version DESC
    `,
  });

  const readVersionsForEnvironment = SqlSchema.findAll({
    Request: EnvironmentIdRequest,
    Result: EnvironmentVersionRow,
    execute: ({ environmentId }) => sql`
      SELECT
        environment_id AS "environmentId",
        version,
        version_json AS value
      FROM cloud_environment_versions
      WHERE environment_id = ${environmentId}
      ORDER BY version DESC
    `,
  });

  const listUnlocked = Effect.fn("CloudEnvironmentCatalog.listUnlocked")(function* () {
    const [heads, rows] = yield* Effect.all([readHeads({}), readVersions({})]).pipe(
      Effect.mapError(persistenceError),
    );
    const versions = new Map<CloudEnvironmentId, Array<CloudEnvironmentVersion>>();
    for (const row of rows) {
      const values = versions.get(row.environmentId) ?? [];
      values.push(row.value);
      versions.set(row.environmentId, values);
    }
    return heads.flatMap<CloudEnvironment>((head) => {
      // Ordered version DESC by the query, so the newest is first.
      const all = versions.get(head.environmentId) ?? [];
      const current = all.find((version) => version.version === head.currentVersion) ?? all[0];
      if (current === undefined) return [];
      return [
        {
          id: head.environmentId,
          current,
          history: all.map(cloudEnvironmentVersionSummary),
          ...(head.activeBuildId === null ? {} : { activeBuildId: head.activeBuildId }),
          ...(head.staleBuildThresholdSeconds === null
            ? {}
            : { staleBuildThresholdSeconds: head.staleBuildThresholdSeconds }),
          createdAt: head.createdAt,
          updatedAt: head.updatedAt,
        },
      ];
    });
  });

  const readEnvironment = Effect.fn("CloudEnvironmentCatalog.readEnvironment")(function* (
    environmentId: CloudEnvironmentId,
  ) {
    return (yield* listUnlocked()).find((environment) => environment.id === environmentId);
  });

  const insertVersion = Effect.fn("CloudEnvironmentCatalog.insertVersion")(function* (input: {
    readonly value: CloudEnvironmentVersion;
    readonly createdAt: string;
    readonly isNew: boolean;
  }) {
    const version = input.value;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (input.isNew) {
          yield* sql`
            INSERT INTO cloud_environments (
              environment_id, current_version, active_build_id, created_at, updated_at
            ) VALUES (${version.environmentId}, ${version.version}, NULL, ${input.createdAt}, ${input.createdAt})
          `;
        } else {
          yield* sql`
            UPDATE cloud_environments
            SET current_version = ${version.version}, updated_at = ${input.createdAt}
            WHERE environment_id = ${version.environmentId}
          `;
        }
        yield* sql`
          INSERT INTO cloud_environment_versions (
            environment_id, version, version_json, created_at
          ) VALUES (
            ${version.environmentId}, ${version.version}, ${encodeVersion(version)}, ${input.createdAt}
          )
        `;
      }),
    );
  });

  const list = mutex.withPermits(1)(listUnlocked().pipe(Effect.mapError(persistenceError)));

  const save: CloudEnvironmentCatalog["Service"]["save"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const environments = yield* listUnlocked();
        const existing = environments.find((environment) => environment.id === input.environmentId);
        if (existing !== undefined && input.expectedVersion !== existing.current.version) {
          return yield* catalogError(
            "version-conflict",
            `Environment '${input.environmentId}' is at version ${existing.current.version}.`,
          );
        }
        if (existing === undefined && input.expectedVersion !== undefined) {
          return yield* catalogError(
            "version-conflict",
            `Environment '${input.environmentId}' does not have version ${input.expectedVersion}.`,
          );
        }
        const secretError = cloudEnvironmentSecretValidationMessage(input.secretReferences);
        if (secretError !== undefined) {
          return yield* catalogError("invalid-environment", secretError);
        }
        if (input.source.type !== "repository") {
          for (const entry of input.repositories) {
            const resolved = pickForRepository(environments, entry.repository);
            if (
              resolved !== undefined &&
              resolved.source.type === "repository" &&
              resolved.environmentId !== input.environmentId
            ) {
              return yield* catalogError(
                "repository-environment-exists",
                `'${entry.repository}' already commits ${resolved.source.path}. Edit that file instead of saving a competing environment.`,
              );
            }
          }
        }
        const versionNumber = PositiveInt.make((existing?.current.version ?? 0) + 1);
        const value: CloudEnvironmentVersion = {
          id: CloudEnvironmentVersionId.make(`${input.environmentId}:${versionNumber}`),
          environmentId: input.environmentId,
          version: versionNumber,
          name: input.name,
          source: input.source,
          repositories: input.repositories,
          config: input.config,
          secretReferences: input.secretReferences,
          effectivePolicy: effectivePolicy(input.config, input.secretReferences),
          createdAt: input.occurredAt,
        };
        yield* insertVersion({
          value,
          createdAt: input.occurredAt,
          isNew: existing === undefined,
        }).pipe(Effect.mapError(persistenceError));
        return yield* readEnvironment(input.environmentId).pipe(
          Effect.flatMap((environment) =>
            environment === undefined
              ? Effect.fail(persistenceError())
              : Effect.succeed(environment),
          ),
        );
      }),
    );

  const restore: CloudEnvironmentCatalog["Service"]["restore"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* readEnvironment(input.environmentId);
        if (existing === undefined) {
          return yield* catalogError(
            "environment-not-found",
            `Environment '${input.environmentId}' does not exist.`,
          );
        }
        if (existing.current.version !== input.expectedVersion) {
          return yield* catalogError(
            "version-conflict",
            `Environment '${input.environmentId}' is at version ${existing.current.version}.`,
          );
        }
        const rows = yield* readVersionsForEnvironment({ environmentId: input.environmentId }).pipe(
          Effect.mapError(persistenceError),
        );
        const restored = rows.find((row) => row.version === input.restoreVersion)?.value;
        if (restored === undefined) {
          return yield* catalogError(
            "version-not-found",
            `Environment '${input.environmentId}' has no version ${input.restoreVersion}.`,
          );
        }
        const versionNumber = PositiveInt.make(existing.current.version + 1);
        const value: CloudEnvironmentVersion = {
          ...restored,
          id: CloudEnvironmentVersionId.make(`${input.environmentId}:${versionNumber}`),
          version: versionNumber,
          restoredFromVersion: input.restoreVersion,
          createdAt: input.occurredAt,
        };
        yield* insertVersion({ value, createdAt: input.occurredAt, isNew: false }).pipe(
          Effect.mapError(persistenceError),
        );
        return yield* readEnvironment(input.environmentId).pipe(
          Effect.flatMap((environment) =>
            environment === undefined
              ? Effect.fail(persistenceError())
              : Effect.succeed(environment),
          ),
        );
      }),
    );

  const resolve: CloudEnvironmentCatalog["Service"]["resolve"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const version = pickForRepository(yield* listUnlocked(), input.repository);
        return version === undefined ? null : { version, reference: reference(version) };
      }).pipe(Effect.mapError(persistenceError)),
    );

  return CloudEnvironmentCatalog.of({ list, save, restore, resolve });
});

export const layer = Layer.effect(CloudEnvironmentCatalog, make());
