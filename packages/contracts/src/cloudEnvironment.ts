import * as Schema from "effect/Schema";

import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudEnvironmentVersionId,
  IsoDateTime,
  NonNegativeInt,
  PortSchema,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const CursorEnvironmentBuild = Schema.Struct({
  dockerfile: Schema.optionalKey(TrimmedNonEmptyString),
  dockerfileContents: Schema.optionalKey(TrimmedNonEmptyString),
  context: Schema.optionalKey(TrimmedNonEmptyString),
}).pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      (value.dockerfile === undefined) === (value.dockerfileContents === undefined)
        ? "Choose exactly one of dockerfile or dockerfileContents"
        : undefined,
    ),
  ),
);

export const CloudEnvironmentTerminal = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  command: TrimmedNonEmptyString,
  description: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudEnvironmentTerminal = typeof CloudEnvironmentTerminal.Type;

export const CloudEnvironmentMcpServer = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  serverUrl: Schema.optionalKey(TrimmedNonEmptyString),
  command: Schema.optionalKey(TrimmedNonEmptyString),
  toolAllowlist: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
}).pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      value.serverUrl === undefined && value.command === undefined
        ? "An MCP allowlist entry requires serverUrl or command"
        : undefined,
    ),
  ),
);

const CursorEnvironmentCommon = {
  name: Schema.optionalKey(TrimmedNonEmptyString),
  user: Schema.optionalKey(TrimmedNonEmptyString),
  install: Schema.optionalKey(Schema.String),
  start: Schema.optionalKey(Schema.String),
  repositoryDependencies: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  disableAllMcpServers: Schema.optionalKey(Schema.Boolean),
  mcpServerAllowlist: Schema.optionalKey(Schema.Array(CloudEnvironmentMcpServer)),
  egressAllowlist: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  egressMode: Schema.optionalKey(
    Schema.Literals([
      "allow_all",
      "parent_plus_network_settings",
      "default_with_network_settings",
      "network_settings_only",
    ]),
  ),
  chromeExecutablePath: Schema.optionalKey(TrimmedNonEmptyString),
  enable_testing: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Literals(["true", "false"])]),
  ),
  ports: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.optionalKey(TrimmedNonEmptyString),
        port: PortSchema,
      }),
    ),
  ),
  terminals: Schema.optionalKey(
    Schema.Array(Schema.Union([CloudEnvironmentTerminal, Schema.Array(CloudEnvironmentTerminal)])),
  ),
  agentCanUpdateSnapshot: Schema.optionalKey(Schema.Boolean),
};

/** Cursor-compatible environment.json shape, with CA-41's stricter single-base rule. */
export const CloudEnvironmentConfig = Schema.Struct({
  ...CursorEnvironmentCommon,
  build: Schema.optionalKey(CursorEnvironmentBuild),
  image: Schema.optionalKey(TrimmedNonEmptyString),
  snapshot: Schema.optionalKey(TrimmedNonEmptyString),
}).pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      [value.build, value.image, value.snapshot].filter((candidate) => candidate !== undefined)
        .length === 1
        ? undefined
        : "Choose exactly one of build, image, or snapshot",
    ),
  ),
);
export type CloudEnvironmentConfig = typeof CloudEnvironmentConfig.Type;

export const CloudEnvironmentRepository = Schema.Struct({
  repository: TrimmedNonEmptyString,
  defaultRef: TrimmedNonEmptyString,
});
export type CloudEnvironmentRepository = typeof CloudEnvironmentRepository.Type;

export const CloudEnvironmentSecretScope = Schema.Literals(["user", "team", "environment"]);
export type CloudEnvironmentSecretScope = typeof CloudEnvironmentSecretScope.Type;

export const CloudEnvironmentSecretReference = Schema.Struct({
  name: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
  /**
   * `runtime` is an ordinary environment variable. `runtime-redacted` is still
   * injected at boot but stripped from logs. `build` is Build-only.
   */
  availability: Schema.Literals(["build", "runtime", "runtime-redacted"]),
  /** Defaults to environment. User secrets never enter a shared Build. */
  scope: Schema.optionalKey(CloudEnvironmentSecretScope),
});
export type CloudEnvironmentSecretReference = typeof CloudEnvironmentSecretReference.Type;

export function cloudEnvironmentSecretScope(
  secret: CloudEnvironmentSecretReference,
): CloudEnvironmentSecretScope {
  return secret.scope ?? "environment";
}

export const CloudEnvironmentSavedSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("saved"),
    scope: Schema.Literal("personal"),
    owner: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("saved"),
    scope: Schema.Literal("team"),
    owner: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("saved"), scope: Schema.Literal("default") }),
]);
export type CloudEnvironmentSavedSource = typeof CloudEnvironmentSavedSource.Type;

export const CloudEnvironmentRepositorySource = Schema.Struct({
  type: Schema.Literal("repository"),
  repository: TrimmedNonEmptyString,
  path: Schema.Literals([".cursor/environment.json", "t3.cloud.json"]),
  commit: TrimmedNonEmptyString,
});
export type CloudEnvironmentRepositorySource = typeof CloudEnvironmentRepositorySource.Type;

export const CloudEnvironmentSource = Schema.Union([
  CloudEnvironmentRepositorySource,
  CloudEnvironmentSavedSource,
]);
export type CloudEnvironmentSource = typeof CloudEnvironmentSource.Type;

export const CloudEnvironmentEffectivePolicy = Schema.Struct({
  runtimeUser: TrimmedNonEmptyString,
  egressMode: Schema.Literals([
    "allow_all",
    "parent_plus_network_settings",
    "default_with_network_settings",
    "network_settings_only",
  ]),
  egressAllowlist: Schema.Array(TrimmedNonEmptyString),
  testingEnabled: Schema.Boolean,
  disableAllMcpServers: Schema.Boolean,
  mcpServerAllowlist: Schema.Array(CloudEnvironmentMcpServer),
  ports: Schema.Array(
    Schema.Struct({ name: Schema.optionalKey(TrimmedNonEmptyString), port: PortSchema }),
  ),
  secrets: Schema.Array(CloudEnvironmentSecretReference),
});
export type CloudEnvironmentEffectivePolicy = typeof CloudEnvironmentEffectivePolicy.Type;

export const CloudEnvironmentVersion = Schema.Struct({
  id: CloudEnvironmentVersionId,
  environmentId: CloudEnvironmentId,
  version: PositiveInt,
  name: TrimmedNonEmptyString,
  source: CloudEnvironmentSource,
  repositories: Schema.Array(CloudEnvironmentRepository).pipe(Schema.check(Schema.isMinLength(1))),
  config: CloudEnvironmentConfig,
  secretReferences: Schema.Array(CloudEnvironmentSecretReference),
  effectivePolicy: CloudEnvironmentEffectivePolicy,
  restoredFromVersion: Schema.optionalKey(PositiveInt),
  createdAt: IsoDateTime,
});
export type CloudEnvironmentVersion = typeof CloudEnvironmentVersion.Type;

export const CloudEnvironmentBase = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("dockerfile") }),
  Schema.Struct({ kind: Schema.Literal("image"), image: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: TrimmedNonEmptyString }),
]);
export type CloudEnvironmentBase = typeof CloudEnvironmentBase.Type;

/** The config guarantees exactly one base, so this never has to guess. */
export function cloudEnvironmentBase(config: CloudEnvironmentConfig): CloudEnvironmentBase {
  if (config.image !== undefined) return { kind: "image", image: config.image };
  if (config.snapshot !== undefined) return { kind: "snapshot", snapshot: config.snapshot };
  return { kind: "dockerfile" };
}

/**
 * History entry for the dashboard. Versions accumulate forever and the snapshot
 * is republished on every allocation change, so history stays summary-sized and
 * only the current version travels in full.
 */
export const CloudEnvironmentVersionSummary = Schema.Struct({
  id: CloudEnvironmentVersionId,
  version: PositiveInt,
  name: TrimmedNonEmptyString,
  source: CloudEnvironmentSource,
  base: CloudEnvironmentBase,
  restoredFromVersion: Schema.optionalKey(PositiveInt),
  createdAt: IsoDateTime,
});
export type CloudEnvironmentVersionSummary = typeof CloudEnvironmentVersionSummary.Type;

export function cloudEnvironmentVersionSummary(
  version: CloudEnvironmentVersion,
): CloudEnvironmentVersionSummary {
  return {
    id: version.id,
    version: version.version,
    name: version.name,
    source: version.source,
    base: cloudEnvironmentBase(version.config),
    ...(version.restoredFromVersion === undefined
      ? {}
      : { restoredFromVersion: version.restoredFromVersion }),
    createdAt: version.createdAt,
  };
}

export const CloudEnvironment = Schema.Struct({
  id: CloudEnvironmentId,
  current: CloudEnvironmentVersion,
  /** Newest first, including the current version. */
  history: Schema.Array(CloudEnvironmentVersionSummary).pipe(Schema.check(Schema.isMinLength(1))),
  activeBuildId: Schema.optionalKey(CloudEnvironmentBuildId),
  /**
   * How long an active Build stays usable before a run refreshes it. Absent
   * when decoding snapshots from controllers older than CA-05, which means the
   * shipped default applies.
   */
  staleBuildThresholdSeconds: Schema.optionalKey(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CloudEnvironment = typeof CloudEnvironment.Type;

export const CloudEnvironmentVersionReference = Schema.Struct({
  environmentId: CloudEnvironmentId,
  versionId: CloudEnvironmentVersionId,
  version: PositiveInt,
  source: CloudEnvironmentSource,
});
export type CloudEnvironmentVersionReference = typeof CloudEnvironmentVersionReference.Type;

export const CloudEnvironmentResolutionInput = Schema.Struct({
  repository: TrimmedNonEmptyString,
});
export type CloudEnvironmentResolutionInput = typeof CloudEnvironmentResolutionInput.Type;

export const CloudEnvironmentResolution = Schema.Struct({
  version: CloudEnvironmentVersion,
  reference: CloudEnvironmentVersionReference,
});
export type CloudEnvironmentResolution = typeof CloudEnvironmentResolution.Type;

export const CloudEnvironmentSaveInput = Schema.Struct({
  environmentId: CloudEnvironmentId,
  expectedVersion: Schema.optionalKey(PositiveInt),
  name: TrimmedNonEmptyString,
  source: CloudEnvironmentSource,
  repositories: Schema.Array(CloudEnvironmentRepository).pipe(Schema.check(Schema.isMinLength(1))),
  config: CloudEnvironmentConfig,
  secretReferences: Schema.Array(CloudEnvironmentSecretReference),
  occurredAt: IsoDateTime,
});
export type CloudEnvironmentSaveInput = typeof CloudEnvironmentSaveInput.Type;

export const CloudEnvironmentRestoreInput = Schema.Struct({
  environmentId: CloudEnvironmentId,
  expectedVersion: PositiveInt,
  restoreVersion: PositiveInt,
  occurredAt: IsoDateTime,
});
export type CloudEnvironmentRestoreInput = typeof CloudEnvironmentRestoreInput.Type;

export class CloudEnvironmentError extends Schema.TaggedError<CloudEnvironmentError>()(
  "CloudEnvironmentError",
  {
    reason: Schema.Literals([
      "environment-not-found",
      "version-not-found",
      "version-conflict",
      "persistence-failed",
      "invalid-environment",
      "repository-environment-exists",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
