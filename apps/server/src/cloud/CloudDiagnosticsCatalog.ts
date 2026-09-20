/**
 * Controller-side cloud diagnostics used by the built-in MCP. Environment and
 * Build records stay in their catalogs; this store only holds setup-session
 * snapshots, proposals, requested actions, and extensibility audit/usage.
 */
import {
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudRunId,
  cloudEnvironmentBase,
  type CloudAllocationSnapshot,
  type CloudEnvironment,
  type CloudEnvironmentBuild,
  type CloudEnvironmentConfig,
  type CloudEnvironmentInfo,
  type CloudEnvironmentSetupAction,
  type CloudEnvironmentSnapshotRecord,
  type CloudExtensibilityAdmission,
  type CloudExtensibilityAuditEvent,
  type CloudRunDiagnostics,
  type CloudSubagentUsageEvent,
  CloudEnvironmentVersion,
  CloudDiagnosticsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudEnvironmentBuildCatalog from "./CloudEnvironmentBuildCatalog.ts";
import * as CloudEnvironmentCatalog from "./CloudEnvironmentCatalog.ts";
import { cloudEnvironmentBuildFingerprint } from "./cloudEnvironmentBuildPolicy.ts";

export { CloudDiagnosticsError } from "@t3tools/contracts";

export interface CloudDiagnosticsBindInput {
  readonly agentId: string;
  readonly runId: CloudRunId;
  readonly environmentId?: CloudEnvironmentId | undefined;
  readonly repository?: string | undefined;
  readonly admission: CloudExtensibilityAdmission;
}

interface DiagnosticsState {
  readonly snapshots: ReadonlyMap<string, CloudEnvironmentSnapshotRecord>;
  readonly proposals: ReadonlyMap<
    string,
    { readonly environmentJson: CloudEnvironmentConfig; readonly buildId?: string }
  >;
  readonly setupActions: ReadonlyArray<CloudEnvironmentSetupAction>;
  readonly bindings: ReadonlyMap<string, CloudDiagnosticsBindInput>;
  readonly usage: ReadonlyArray<CloudSubagentUsageEvent>;
}

const emptyState = (): DiagnosticsState => ({
  snapshots: new Map(),
  proposals: new Map(),
  setupActions: [],
  bindings: new Map(),
  usage: [],
});

export class CloudDiagnosticsCatalog extends Context.Service<
  CloudDiagnosticsCatalog,
  {
    readonly bindRun: (input: CloudDiagnosticsBindInput) => Effect.Effect<void>;
    readonly environmentInfo: (input: {
      readonly environmentId?: string | undefined;
      readonly repository?: string | undefined;
    }) => Effect.Effect<CloudEnvironmentInfo, CloudDiagnosticsError>;
    readonly takeSnapshot: (input: {
      readonly environmentId?: string | undefined;
    }) => Effect.Effect<CloudEnvironmentSnapshotRecord, CloudDiagnosticsError>;
    readonly completeSnapshot: (
      snapshotId: string,
      outcome: { readonly status: "ready" | "failed"; readonly message?: string },
    ) => Effect.Effect<CloudEnvironmentSnapshotRecord, CloudDiagnosticsError>;
    readonly checkSnapshot: (
      snapshotId: string,
    ) => Effect.Effect<CloudEnvironmentSnapshotRecord, CloudDiagnosticsError>;
    readonly triggerBuild: (input: {
      readonly environmentId?: string | undefined;
      readonly environmentJson?: CloudEnvironmentConfig | undefined;
      readonly setupThreadId?: ThreadId | undefined;
      readonly occurredAt: string;
    }) => Effect.Effect<CloudEnvironmentBuild, CloudDiagnosticsError>;
    readonly listBuilds: (input: {
      readonly environmentId?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<CloudEnvironmentBuild>, CloudDiagnosticsError>;
    readonly buildLogs: (input: {
      readonly buildId: string;
    }) => Effect.Effect<CloudEnvironmentBuild, CloudDiagnosticsError>;
    readonly proposeEnvironmentJson: (input: {
      readonly environmentId?: string | undefined;
      readonly environmentJson: CloudEnvironmentConfig;
      readonly buildId?: string | undefined;
      readonly occurredAt?: string | undefined;
    }) => Effect.Effect<
      { readonly proposed: true; readonly buildId?: string },
      CloudDiagnosticsError
    >;
    readonly requestSetupActions: (input: {
      readonly actions: ReadonlyArray<CloudEnvironmentSetupAction>;
    }) => Effect.Effect<{ readonly accepted: number }>;
    readonly outstandingSetupActions: Effect.Effect<ReadonlyArray<CloudEnvironmentSetupAction>>;
    readonly resolveSetupActions: Effect.Effect<void>;
    readonly readProposal: (
      environmentId?: string,
    ) => Effect.Effect<
      { readonly environmentJson: CloudEnvironmentConfig; readonly buildId?: string } | undefined
    >;
    readonly runInfo: (input: {
      readonly runId?: string | undefined;
      readonly agentId?: string | undefined;
    }) => Effect.Effect<CloudRunDiagnostics, CloudDiagnosticsError>;
    readonly runTranscript: (input: {
      readonly runId: string;
    }) => Effect.Effect<{ readonly events: ReadonlyArray<unknown> }, CloudDiagnosticsError>;
    readonly runEvents: (input: {
      readonly runId: string;
    }) => Effect.Effect<{ readonly events: ReadonlyArray<unknown> }, CloudDiagnosticsError>;
    readonly fleetDiagnostics: (input: {
      readonly authorized: boolean;
    }) => Effect.Effect<
      Pick<CloudAllocationSnapshot, "allocations" | "macHosts" | "warmGuests" | "capacity">,
      CloudDiagnosticsError
    >;
    readonly recordSubagentUsage: (event: CloudSubagentUsageEvent) => Effect.Effect<void>;
    readonly auditsForRun: (
      runId: string,
    ) => Effect.Effect<ReadonlyArray<CloudExtensibilityAuditEvent>>;
    readonly usageForRun: (runId: string) => Effect.Effect<ReadonlyArray<CloudSubagentUsageEvent>>;
  }
>()("t3/cloud/CloudDiagnosticsCatalog") {}

function diagnosticsError(
  reason: CloudDiagnosticsError["reason"],
  message: string,
): CloudDiagnosticsError {
  return new CloudDiagnosticsError({ reason, message });
}

function environmentInfoOf(environment: CloudEnvironment): CloudEnvironmentInfo {
  const source = environment.current.source;
  const defaultRevision = environment.current.repositories[0]?.defaultRef;
  return {
    environmentId: environment.id,
    environmentJsonPath: source.type === "repository" ? source.path : null,
    name: environment.current.name,
    sourceType: source.type === "repository" ? "repository" : source.scope,
    ...(environment.activeBuildId === undefined
      ? {}
      : { activeBuildId: environment.activeBuildId }),
    ...(defaultRevision === undefined ? {} : { defaultRevision }),
    config: environment.current.config,
  };
}

export const make = Effect.fn("CloudDiagnosticsCatalog.make")(function* () {
  const state = yield* Ref.make(emptyState());

  const snapshot = Effect.flatMap(
    Effect.serviceOption(CloudAllocationController.CloudAllocationController),
    Option.match({
      onNone: () =>
        Effect.fail(
          diagnosticsError("unavailable", "The cloud allocation catalog is unavailable."),
        ),
      onSome: (controller) =>
        controller.snapshot.pipe(
          Effect.mapError(() =>
            diagnosticsError("unavailable", "The cloud allocation catalog is unavailable."),
          ),
        ),
    }),
  );

  const listEnvironments = Effect.flatMap(
    Effect.serviceOption(CloudEnvironmentCatalog.CloudEnvironmentCatalog),
    Option.match({
      onNone: () => Effect.succeed<ReadonlyArray<CloudEnvironment>>([]),
      onSome: (catalog) =>
        catalog.list.pipe(
          Effect.mapError(() =>
            diagnosticsError("persistence-failed", "The environment catalog is unavailable."),
          ),
        ),
    }),
  );

  const environmentCatalog = Effect.flatMap(
    Effect.serviceOption(CloudEnvironmentCatalog.CloudEnvironmentCatalog),
    Option.match({
      onNone: () =>
        Effect.fail(diagnosticsError("unavailable", "Environment Builds are unavailable.")),
      onSome: (catalog) => Effect.succeed(catalog),
    }),
  );

  const buildCatalog = Effect.flatMap(
    Effect.serviceOption(CloudEnvironmentBuildCatalog.CloudEnvironmentBuildCatalog),
    Option.match({
      onNone: () =>
        Effect.fail(diagnosticsError("unavailable", "Environment Builds are unavailable.")),
      onSome: (catalog) => Effect.succeed(catalog),
    }),
  );

  const environmentInfo: CloudDiagnosticsCatalog["Service"]["environmentInfo"] = (input) =>
    Effect.gen(function* () {
      const listed = yield* listEnvironments;
      const match =
        input.environmentId === undefined
          ? listed.find((environment) =>
              input.repository === undefined
                ? true
                : environment.current.repositories.some(
                    (entry) => entry.repository === input.repository,
                  ),
            )
          : listed.find((environment) => environment.id === input.environmentId);
      if (match === undefined) {
        return {
          ...(input.environmentId === undefined
            ? {}
            : { environmentId: CloudEnvironmentId.make(input.environmentId) }),
          environmentJsonPath: null,
        } satisfies CloudEnvironmentInfo;
      }
      return environmentInfoOf(match);
    });

  const takeSnapshot: CloudDiagnosticsCatalog["Service"]["takeSnapshot"] = (input) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const snapshotId = `snap-${now.replaceAll(/[^\d]/g, "").slice(0, 14)}`;
      const record: CloudEnvironmentSnapshotRecord = {
        snapshotId,
        status: "creating",
        createdAt: now,
        ...(input.environmentId === undefined
          ? {}
          : { environmentId: CloudEnvironmentId.make(input.environmentId) }),
      };
      yield* Ref.update(state, (current) => ({
        ...current,
        snapshots: new Map(current.snapshots).set(snapshotId, record),
      }));
      return record;
    });

  const completeSnapshot: CloudDiagnosticsCatalog["Service"]["completeSnapshot"] = (
    snapshotId,
    outcome,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const existing = current.snapshots.get(snapshotId);
      if (existing === undefined) {
        return yield* diagnosticsError("not-found", `Snapshot '${snapshotId}' was not found.`);
      }
      const next: CloudEnvironmentSnapshotRecord = {
        ...existing,
        status: outcome.status,
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      };
      yield* Ref.update(state, (value) => ({
        ...value,
        snapshots: new Map(value.snapshots).set(snapshotId, next),
      }));
      return next;
    });

  const checkSnapshot: CloudDiagnosticsCatalog["Service"]["checkSnapshot"] = (snapshotId) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const existing = current.snapshots.get(snapshotId);
      return existing === undefined
        ? yield* diagnosticsError("not-found", `Snapshot '${snapshotId}' was not found.`)
        : existing;
    });

  const triggerBuild: CloudDiagnosticsCatalog["Service"]["triggerBuild"] = (input) =>
    Effect.gen(function* () {
      const environments = yield* environmentCatalog;
      const builds = yield* buildCatalog;
      const allocationSnapshot =
        input.setupThreadId === undefined
          ? Option.none<CloudAllocationSnapshot>()
          : yield* snapshot.pipe(Effect.option);
      const setupAllocation = Option.getOrUndefined(allocationSnapshot)?.allocations.find(
        (allocation) => allocation.execution?.threadId === input.setupThreadId,
      );
      const setupIntent = setupAllocation?.execution?.environmentSetup;
      let environment: CloudEnvironment | undefined;
      if (input.environmentId !== undefined) {
        const listed = yield* environments.list.pipe(
          Effect.mapError(() =>
            diagnosticsError("persistence-failed", "The environment catalog is unavailable."),
          ),
        );
        environment = listed.find((entry) => entry.id === input.environmentId);
      }
      if (environment === undefined && input.environmentJson !== undefined) {
        environment = yield* environments
          .save({
            environmentId: CloudEnvironmentId.make(
              `environment-draft-${input.occurredAt.replaceAll(/[^\d]/g, "").slice(0, 14)}`,
            ),
            name: setupIntent?.name ?? input.environmentJson.name ?? "Draft environment",
            source: {
              type: "saved",
              scope: setupIntent?.scope ?? "personal",
              owner: setupIntent?.scope === "team" ? "team" : "cloud-agent",
            },
            repositories:
              setupAllocation === undefined
                ? [{ repository: "local/none", defaultRef: "main" }]
                : [
                    {
                      repository: setupAllocation.target.repository,
                      defaultRef: setupAllocation.target.baseCommit,
                    },
                    ...(setupAllocation.target.additionalRepositories ?? []).map((repository) => ({
                      repository: repository.repository,
                      defaultRef: repository.baseCommit,
                    })),
                  ],
            config: input.environmentJson,
            secretReferences: [],
            occurredAt: input.occurredAt,
          })
          .pipe(
            Effect.mapError(() =>
              diagnosticsError("persistence-failed", "The draft environment could not be saved."),
            ),
          );
      }
      if (environment === undefined) {
        return yield* diagnosticsError(
          "not-found",
          "No environment is linked; pass environmentJson to create a personal draft.",
        );
      }
      const version: CloudEnvironmentVersion =
        input.environmentJson === undefined
          ? environment.current
          : { ...environment.current, config: input.environmentJson };
      const buildId = CloudEnvironmentBuildId.make(
        `bld-${input.occurredAt.replaceAll(/[^\d]/g, "").slice(0, 14)}`,
      );
      return yield* builds
        .start({
          buildId,
          version,
          trigger: "agent-requested",
          draft: true,
          ...(input.setupThreadId === undefined ? {} : { setupThreadId: input.setupThreadId }),
          base: cloudEnvironmentBase(version.config),
          inputsFingerprint: cloudEnvironmentBuildFingerprint({
            versionId: version.id,
            config: version.config,
            secretReferences: version.secretReferences,
            gitSetup: [],
          }),
          startedAt: input.occurredAt,
        })
        .pipe(
          Effect.mapError(() =>
            diagnosticsError("persistence-failed", "The draft Build could not be started."),
          ),
        );
    });

  const listBuilds: CloudDiagnosticsCatalog["Service"]["listBuilds"] = (input) =>
    Effect.gen(function* () {
      const builds = yield* buildCatalog;
      const listed = yield* builds.list.pipe(
        Effect.mapError(() =>
          diagnosticsError("persistence-failed", "The Build catalog is unavailable."),
        ),
      );
      return input.environmentId === undefined
        ? listed
        : listed.filter((build) => build.environmentId === input.environmentId);
    });

  const buildLogs: CloudDiagnosticsCatalog["Service"]["buildLogs"] = (input) =>
    Effect.gen(function* () {
      const builds = yield* buildCatalog;
      const build = yield* builds
        .read(CloudEnvironmentBuildId.make(input.buildId))
        .pipe(
          Effect.mapError(() =>
            diagnosticsError("persistence-failed", "The Build catalog is unavailable."),
          ),
        );
      return build === undefined
        ? yield* diagnosticsError("not-found", `Build '${input.buildId}' was not found.`)
        : build;
    });

  const proposeEnvironmentJson: CloudDiagnosticsCatalog["Service"]["proposeEnvironmentJson"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current.setupActions.length > 0) {
        return yield* diagnosticsError(
          "invalid-request",
          "Required environment setup actions are outstanding. Do not propose or ask the user to Save.",
        );
      }
      const key = input.environmentId ?? "greenfield";
      if (input.buildId !== undefined && input.occurredAt !== undefined) {
        const builds = yield* buildCatalog;
        yield* builds
          .markSetupReady({
            buildId: CloudEnvironmentBuildId.make(input.buildId),
            occurredAt: input.occurredAt,
          })
          .pipe(Effect.mapError((error) => diagnosticsError("invalid-request", error.message)));
      }
      yield* Ref.update(state, (value) => ({
        ...value,
        proposals: new Map(value.proposals).set(key, {
          environmentJson: input.environmentJson,
          ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
        }),
      }));
      if (input.buildId !== undefined) {
        yield* Effect.serviceOption(CloudAllocationController.CloudAllocationController).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (controller) => controller.refresh.pipe(Effect.ignore),
            }),
          ),
        );
      }
      return {
        proposed: true as const,
        ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
      };
    });

  const requestSetupActions: CloudDiagnosticsCatalog["Service"]["requestSetupActions"] = (input) =>
    Ref.update(state, (current) => ({
      ...current,
      setupActions: [...current.setupActions, ...input.actions],
    })).pipe(Effect.as({ accepted: input.actions.length }));

  const outstandingSetupActions: CloudDiagnosticsCatalog["Service"]["outstandingSetupActions"] =
    Ref.get(state).pipe(Effect.map((current) => current.setupActions));

  const resolveSetupActions: CloudDiagnosticsCatalog["Service"]["resolveSetupActions"] = Ref.update(
    state,
    (current) => ({ ...current, setupActions: [] }),
  ).pipe(Effect.asVoid);

  const readProposal: CloudDiagnosticsCatalog["Service"]["readProposal"] = (environmentId) =>
    Ref.get(state).pipe(
      Effect.map((current) => current.proposals.get(environmentId ?? "greenfield")),
    );

  const runInfo: CloudDiagnosticsCatalog["Service"]["runInfo"] = (input) =>
    Effect.gen(function* () {
      const current = yield* snapshot;
      const run =
        input.runId === undefined
          ? current.runs?.find((candidate) => candidate.agentId === input.agentId)
          : current.runs?.find((candidate) => candidate.id === input.runId);
      if (run === undefined) {
        return yield* diagnosticsError("not-found", "The requested run was not found.");
      }
      const agent = current.agents?.find((candidate) => candidate.id === run.agentId);
      return {
        agentId: run.agentId,
        runId: run.id,
        status: run.status,
        ...(agent === undefined ? {} : { repository: agent.repository }),
        ...(agent?.environment === undefined
          ? {}
          : { environmentId: agent.environment.environmentId }),
      };
    });

  const emptyEvents = { events: [] as ReadonlyArray<unknown> };

  const runTranscript: CloudDiagnosticsCatalog["Service"]["runTranscript"] = () =>
    Effect.succeed(emptyEvents);
  const runEvents: CloudDiagnosticsCatalog["Service"]["runEvents"] = () =>
    Effect.succeed(emptyEvents);

  const fleetDiagnostics: CloudDiagnosticsCatalog["Service"]["fleetDiagnostics"] = (input) =>
    Effect.gen(function* () {
      if (!input.authorized) {
        return yield* diagnosticsError(
          "unauthorized",
          "Fleet diagnostics require an authorized credential.",
        );
      }
      const current = yield* snapshot;
      return {
        allocations: current.allocations,
        ...(current.macHosts === undefined ? {} : { macHosts: current.macHosts }),
        ...(current.warmGuests === undefined ? {} : { warmGuests: current.warmGuests }),
        ...(current.capacity === undefined ? {} : { capacity: current.capacity }),
      };
    });

  const bindRun: CloudDiagnosticsCatalog["Service"]["bindRun"] = (input) =>
    Ref.update(state, (current) => ({
      ...current,
      bindings: new Map(current.bindings).set(input.runId, input),
    })).pipe(Effect.asVoid);

  const recordSubagentUsage: CloudDiagnosticsCatalog["Service"]["recordSubagentUsage"] = (event) =>
    Ref.update(state, (current) => ({
      ...current,
      usage: [...current.usage, event],
    })).pipe(Effect.asVoid);

  const auditsForRun: CloudDiagnosticsCatalog["Service"]["auditsForRun"] = (runId) =>
    Ref.get(state).pipe(
      Effect.map((current) => current.bindings.get(runId)?.admission.audits ?? []),
    );

  const usageForRun: CloudDiagnosticsCatalog["Service"]["usageForRun"] = (runId) =>
    Ref.get(state).pipe(
      Effect.map((current) => current.usage.filter((event) => event.runId === runId)),
    );

  return CloudDiagnosticsCatalog.of({
    bindRun,
    environmentInfo,
    takeSnapshot,
    completeSnapshot,
    checkSnapshot,
    triggerBuild,
    listBuilds,
    buildLogs,
    proposeEnvironmentJson,
    requestSetupActions,
    outstandingSetupActions,
    resolveSetupActions,
    readProposal,
    runInfo,
    runTranscript,
    runEvents,
    fleetDiagnostics,
    recordSubagentUsage,
    auditsForRun,
    usageForRun,
  });
});

export const layer = Layer.effect(CloudDiagnosticsCatalog, make());
