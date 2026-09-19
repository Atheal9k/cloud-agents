// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CLOUD_AGENTS_API_HISTORY_PAGE_BYTES,
  CLOUD_AGENTS_API_RESULT_SUMMARY_CHARS,
  CLOUD_AGENTS_API_WORKER_TURN_LIMIT,
  CloudAgentId,
  CloudAllocationControllerError,
  CloudProviderUnansweredRequestSeconds,
  CloudRunId,
  CommandId,
  MessageId,
  OrchestrationThreadDetailSnapshot,
  SELF_HOSTED_WORKER_PROFILE_ID,
  admitSelfHostedTarget,
  isCloudProviderEnabled,
  ProviderInstanceId,
  RunAllocationAttempt,
  RunAllocationId,
  ThreadId,
  type CloudAgent,
  type CloudAgentsApiAgent,
  type CloudAgentsApiAgentSummary,
  type CloudAgentsApiAgentUsage,
  type CloudAgentsApiCreateAgentRequest,
  type CloudAgentsApiCreateAgentResponse,
  type CloudAgentsApiCreateRunRequest,
  type CloudAgentsApiCreateRunResponse,
  type CloudAgentsApiEnvTarget,
  type CloudAgentsApiIdResponse,
  type CloudAgentsApiModel,
  type CloudAgentsApiPrincipal,
  type CloudAgentsApiHistoryKind,
  type CloudAgentsApiHistoryPage,
  type CloudAgentsApiReconnectSource,
  type CloudAgentsApiRepoInput,
  type CloudAgentsApiRepository,
  type CloudAgentsApiRun,
  type CloudAgentsApiStreamEvent,
  type CloudRun,
  type RunAllocation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudDiagnosticsCatalog from "./CloudDiagnosticsCatalog.ts";
import { principalFromApiKey } from "./cloudAccountingPolicy.ts";
import * as CloudRunPublication from "./CloudRunPublication.ts";
import * as CloudRunResults from "./CloudRunResults.ts";
import * as CloudSelfHosted from "./CloudSelfHosted.ts";
import * as CloudWorkerRunClient from "./CloudWorkerRunClient.ts";
import {
  appendBoundedStreamEvent,
  emptyStreamBuffer,
  eventsFromThreadSnapshot,
  historyItemsFromSnapshot,
  maybeHeartbeat,
  mergeStreamSources,
  pageHistory,
  resumeBoundedStream,
  selectReconnectSource,
  type CloudStreamBuffer,
} from "./cloudAgentEventStream.ts";
import { isDeletionPurgeReady } from "./cloudRetentionPolicy.ts";
import { admitCloudExtensibility, subagentUsageEvent } from "./cloudExtensibilityPolicy.ts";
import { cloudEgressExceptions, resolveCloudEgressPolicy } from "./cloudSecurityPolicy.ts";
import {
  agentUsageFromRuns,
  apiError,
  CloudAgentsApiFailure,
  interactionMode,
  isActiveRunStatus,
  isTerminalRunStatus,
  modelsFromProviders,
  paginateNewestFirst,
  parseRepositoryUrl,
  publicAgent,
  publicAgentSummary,
  publicGit,
  publicRun,
  streamEventId,
  titleFromPrompt,
  validateCreateAgentRequest,
  validateCreateRunRequest,
  type CloudAgentsApiAgentRecord,
} from "./cloudAgentsApiModel.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";

import * as CloudCollaboration from "./CloudCollaboration.ts";
import { mapCollaborationFailure, teamIdOf } from "./CloudCollaboration.ts";
import { resolveCloudBranchPlan, repositoryUrlForIdentity } from "./cloudCollaborationPolicy.ts";

const AgentIdRequest = Schema.Struct({ agentId: Schema.String });
const PrincipalRequest = Schema.Struct({ principalId: Schema.String });
const RecordRow = Schema.Struct({
  agentId: Schema.String,
  principalId: Schema.String,
  teamId: Schema.String,
  allocationId: Schema.String,
  recordJson: Schema.String,
});

const AgentRecordPayload = Schema.Struct({
  env: Schema.Struct({
    type: Schema.Literals(["cloud", "pool", "machine"]),
    name: Schema.optionalKey(Schema.String),
  }),
  repos: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        url: Schema.String,
        startingRef: Schema.optionalKey(Schema.String),
        prUrl: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  workOnCurrentBranch: Schema.optionalKey(Schema.Boolean),
  autoCreatePR: Schema.optionalKey(Schema.Boolean),
  skipReviewerRequest: Schema.optionalKey(Schema.Boolean),
  mcpServers: Schema.optionalKey(Schema.Unknown),
  customSubagents: Schema.optionalKey(Schema.Unknown),
});
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(AgentRecordPayload));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(AgentRecordPayload));

export interface CloudAgentsApiPage<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly nextCursor?: string;
}

export class CloudAgentsApi extends Context.Service<
  CloudAgentsApi,
  {
    readonly me: (principal: CloudAgentsApiPrincipal) => Effect.Effect<{
      apiKeyName: string;
      createdAt: string;
      userId?: number;
      userEmail?: string;
      userFirstName?: string;
      userLastName?: string;
    }>;
    readonly createAgent: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly body: CloudAgentsApiCreateAgentRequest;
      readonly urlOrigin: string;
      readonly limits?: {
        readonly runSeconds: number;
        readonly inputWaitSeconds: number;
      };
    }) => Effect.Effect<CloudAgentsApiCreateAgentResponse, CloudAgentsApiFailure>;
    readonly listAgents: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly urlOrigin: string;
      readonly limit?: number;
      readonly cursor?: string;
      readonly includeArchived?: boolean;
      readonly prUrl?: string;
    }) => Effect.Effect<CloudAgentsApiPage<CloudAgentsApiAgentSummary>, CloudAgentsApiFailure>;
    readonly getAgent: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly urlOrigin: string;
    }) => Effect.Effect<CloudAgentsApiAgent, CloudAgentsApiFailure>;
    readonly createRun: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly body: CloudAgentsApiCreateRunRequest;
      /** Stable internal key used by scheduled admission retries. */
      readonly requestId?: string;
      /** Trusted controller override for webhook or schedule source revisions. */
      readonly selectedRef?: string;
      readonly limits?: {
        readonly runSeconds: number;
        readonly inputWaitSeconds: number;
      };
    }) => Effect.Effect<CloudAgentsApiCreateRunResponse, CloudAgentsApiFailure>;
    readonly listRuns: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly limit?: number;
      readonly cursor?: string;
    }) => Effect.Effect<CloudAgentsApiPage<CloudAgentsApiRun>, CloudAgentsApiFailure>;
    readonly getRun: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly runId: string;
    }) => Effect.Effect<CloudAgentsApiRun, CloudAgentsApiFailure>;
    readonly cancelRun: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly runId: string;
    }) => Effect.Effect<CloudAgentsApiIdResponse, CloudAgentsApiFailure>;
    readonly usage: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly runId?: string;
    }) => Effect.Effect<CloudAgentsApiAgentUsage, CloudAgentsApiFailure>;
    readonly usageReport: (input: {
      readonly periodStart: string;
      readonly periodEnd: string;
    }) => Effect.Effect<import("@t3tools/contracts").CloudUsageExport, CloudAgentsApiFailure>;
    readonly archive: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
    }) => Effect.Effect<CloudAgentsApiIdResponse, CloudAgentsApiFailure>;
    readonly unarchive: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
    }) => Effect.Effect<CloudAgentsApiIdResponse, CloudAgentsApiFailure>;
    readonly deleteAgent: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
    }) => Effect.Effect<CloudAgentsApiIdResponse, CloudAgentsApiFailure>;
    readonly streamRun: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly runId: string;
      readonly lastEventId?: string;
      readonly nowMs: number;
    }) => Effect.Effect<
      {
        readonly events: ReadonlyArray<CloudAgentsApiStreamEvent>;
        readonly reconnectSource: CloudAgentsApiReconnectSource;
      },
      CloudAgentsApiFailure
    >;
    readonly listHistory: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
      readonly runId: string;
      readonly kind: CloudAgentsApiHistoryKind;
      readonly cursor?: string;
    }) => Effect.Effect<CloudAgentsApiHistoryPage, CloudAgentsApiFailure>;
    readonly appendStreamEvent: (input: {
      readonly runId: string;
      readonly event: CloudAgentsApiStreamEvent["event"];
      readonly data: unknown;
      readonly nowMs: number;
      readonly id?: boolean;
    }) => Effect.Effect<CloudAgentsApiStreamEvent>;
    readonly listModels: Effect.Effect<ReadonlyArray<CloudAgentsApiModel>>;
    readonly listRepositories: Effect.Effect<ReadonlyArray<CloudAgentsApiRepository>>;
  }
>()("t3/cloud/CloudAgentsApi") {}

function mapControllerError(error: unknown): CloudAgentsApiFailure {
  if (Schema.is(CloudAllocationControllerError)(error)) {
    switch (error.reason) {
      case "agent_busy":
        return apiError("agent_busy", error.message);
      case "agent-archived":
        return apiError("agent_archived", error.message);
      case "agent-deleted":
        return apiError("agent_not_found", error.message);
      case "admission-stopped":
        return apiError("admission_stopped", error.message);
      case "spend-limit-exceeded":
        return apiError("spend_limit_exceeded", error.message);
      case "invalid-request":
        return error.message.includes("already exists")
          ? apiError("agent_id_conflict", error.message)
          : apiError("invalid_request", error.message);
      default:
        return apiError("internal_error", error.message);
    }
  }
  return apiError("internal_error", "The cloud agents API could not complete this request.");
}

function deadline(startMillis: number, seconds: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(startMillis + seconds * 1_000));
}

function epochNowMs(): number {
  return DateTime.toEpochMillis(DateTime.nowUnsafe());
}

function defaultEnv(body: CloudAgentsApiCreateAgentRequest): CloudAgentsApiEnvTarget {
  return body.env ?? { type: "cloud" };
}

export const make = Effect.fn("CloudAgentsApi.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const allocations = yield* CloudAllocationController.CloudAllocationController;
  const resultsOption = yield* Effect.serviceOption(CloudRunResults.CloudRunResults);
  const publicationOption = yield* Effect.serviceOption(CloudRunPublication.CloudRunPublication);
  const providersOption = yield* Effect.serviceOption(ProviderRegistry);
  const projectionOption = yield* Effect.serviceOption(ProjectionSnapshotQuery);
  const results = Option.getOrUndefined(resultsOption);
  const publication = Option.getOrUndefined(publicationOption);
  const providers = Option.getOrUndefined(providersOption);
  const projection = Option.getOrUndefined(projectionOption);
  const collaborationOption = yield* Effect.serviceOption(CloudCollaboration.CloudCollaboration);
  const collaboration = Option.getOrUndefined(collaborationOption);
  const workerClient = Option.getOrUndefined(
    yield* Effect.serviceOption(CloudWorkerRunClient.CloudWorkerRunClient),
  );
  const diagnostics = Option.getOrUndefined(
    yield* Effect.serviceOption(CloudDiagnosticsCatalog.CloudDiagnosticsCatalog),
  );
  const selfHosted = Option.getOrUndefined(
    yield* Effect.serviceOption(CloudSelfHosted.CloudSelfHosted),
  );
  const streams = yield* Ref.make<ReadonlyMap<string, CloudStreamBuffer>>(new Map());
  const decodeThreadSnapshot = Schema.decodeUnknownOption(
    Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
  );

  const readRecord = SqlSchema.findAll({
    Request: AgentIdRequest,
    Result: RecordRow,
    execute: ({ agentId }) => sql`
      SELECT agent_id AS "agentId", principal_id AS "principalId",
             team_id AS "teamId", allocation_id AS "allocationId", record_json AS "recordJson"
      FROM cloud_agents_api_records
      WHERE agent_id = ${agentId}
    `,
  });
  const readOwned = SqlSchema.findAll({
    Request: PrincipalRequest,
    Result: RecordRow,
    execute: ({ principalId }) => sql`
      SELECT agent_id AS "agentId", principal_id AS "principalId",
             team_id AS "teamId", allocation_id AS "allocationId", record_json AS "recordJson"
      FROM cloud_agents_api_records
      WHERE principal_id = ${principalId}
    `,
  });

  const appendStreamEvent: CloudAgentsApi["Service"]["appendStreamEvent"] = (input) =>
    Ref.modify(streams, (current) => {
      const existing = current.get(input.runId) ?? emptyStreamBuffer();
      const event: CloudAgentsApiStreamEvent = {
        ...(input.id === false ? {} : { id: streamEventId(input.nowMs, existing.events.length) }),
        event: input.event,
        data: input.data,
        createdAtMs: input.nowMs,
      };
      const next = new Map(current);
      next.set(input.runId, appendBoundedStreamEvent(existing, event));
      return [event, next] as const;
    });

  const snapshot = allocations.snapshot.pipe(Effect.mapError(mapControllerError));

  const locate = Effect.fn("CloudAgentsApi.locate")(function* (
    principal: CloudAgentsApiPrincipal,
    agentId: string,
    access: "read" | "follow-up" | "owner" = "read",
  ) {
    const owned = (yield* readRecord({ agentId }).pipe(
      Effect.mapError(() => apiError("internal_error", "The API catalog is unavailable.")),
    ))[0];
    if (owned === undefined) {
      return yield* Effect.fail(apiError("agent_not_found", `Agent '${agentId}' was not found.`));
    }
    const isOwner = owned.principalId === principal.principalId;
    if (!isOwner) {
      if (collaboration === undefined) {
        return yield* Effect.fail(apiError("agent_not_found", `Agent '${agentId}' was not found.`));
      }
      const payloadPreview = decodeRecord(owned.recordJson);
      const agentRepositories = (payloadPreview.repos ?? []).flatMap((repo) => {
        const parsed = parseRepositoryUrl(repo.url);
        return parsed === undefined ? [] : [parsed.ownerName];
      });
      const viewed = yield* collaboration
        .viewSharedAgent({
          principal,
          ownerPrincipalId: owned.principalId,
          ownerTeamId: owned.teamId,
          agentRepositories,
        })
        .pipe(Effect.mapError(mapCollaborationFailure));
      if (access === "owner" || (access === "follow-up" && viewed.mode === "read-only")) {
        if (access === "follow-up") {
          yield* collaboration
            .authorizeFollowUp({
              principal,
              ownerPrincipalId: owned.principalId,
              ownerTeamId: owned.teamId,
            })
            .pipe(Effect.mapError(mapCollaborationFailure));
        } else {
          return yield* Effect.fail(
            apiError("scm_access_denied", `Agent '${agentId}' is read-only for this viewer.`),
          );
        }
      }
    }
    const current = yield* snapshot;
    const agent = current.agents?.find((candidate) => candidate.id === agentId);
    const allocation = current.allocations.find((candidate) => candidate.id === owned.allocationId);
    if (allocation?.deletion !== undefined) {
      return yield* Effect.fail(apiError("agent_not_found", `Agent '${agentId}' was not found.`));
    }
    if (agent === undefined || allocation === undefined) {
      const deleted = current.deletions?.some((row) => row.agentId === agentId) === true;
      return yield* Effect.fail(
        apiError(
          "agent_not_found",
          deleted ? `Agent '${agentId}' was not found.` : `Agent '${agentId}' was not found.`,
        ),
      );
    }
    const runs = (current.runs ?? []).filter((run) => run.agentId === agentId);
    const payload = decodeRecord(owned.recordJson);
    const record: CloudAgentsApiAgentRecord = {
      env: payload.env,
      ...(payload.repos === undefined ? {} : { repos: payload.repos }),
      ...(payload.workOnCurrentBranch === undefined
        ? {}
        : { workOnCurrentBranch: payload.workOnCurrentBranch }),
      ...(payload.autoCreatePR === undefined ? {} : { autoCreatePR: payload.autoCreatePR }),
      ...(payload.skipReviewerRequest === undefined
        ? {}
        : { skipReviewerRequest: payload.skipReviewerRequest }),
      urlOrigin: "",
    };
    return { current, agent, allocation, runs, record, payload };
  });

  const gitFor = Effect.fn("CloudAgentsApi.gitFor")(function* (
    agent: CloudAgent,
    allocation: RunAllocation,
    repos: ReadonlyArray<CloudAgentsApiRepoInput> | undefined,
  ) {
    const published =
      publication === undefined
        ? undefined
        : Option.getOrUndefined(
            yield* publication.status(allocation.id, allocation.attempt).pipe(Effect.option),
          );
    const prUrl =
      published?.outcome.status === "published"
        ? published.outcome.pullRequestUrl
        : repos?.[0]?.prUrl;
    return {
      git: publicGit(agent, repos, prUrl),
      provenance: published?.provenance,
    };
  });

  const seedStatus = (run: CloudRun, nowMs: number) =>
    appendStreamEvent({
      runId: run.id,
      event: "status",
      data: { runId: run.id, status: run.status },
      nowMs,
      id: false,
    });

  const me: CloudAgentsApi["Service"]["me"] = (principal) =>
    Effect.succeed({
      apiKeyName: principal.apiKeyName,
      createdAt: principal.createdAt,
      ...(principal.kind === "service_account"
        ? {}
        : {
            ...(principal.userId === undefined ? {} : { userId: principal.userId }),
            ...(principal.userEmail === undefined ? {} : { userEmail: principal.userEmail }),
            ...(principal.userFirstName === undefined
              ? {}
              : { userFirstName: principal.userFirstName }),
            ...(principal.userLastName === undefined
              ? {}
              : { userLastName: principal.userLastName }),
          }),
    });

  const listModels: CloudAgentsApi["Service"]["listModels"] = Effect.gen(function* () {
    if (providers === undefined) return [];
    const snapshots = yield* providers.getProviders;
    return modelsFromProviders(snapshots.filter((snapshot) => isCloudProviderEnabled(snapshot.driver)));
  });

  const listRepositories: CloudAgentsApi["Service"]["listRepositories"] = Effect.gen(function* () {
    if (projection === undefined) return [];
    const shells = yield* projection.getProjectShells().pipe(Effect.orElseSucceed(() => []));
    const seen = new Set<string>();
    const items: CloudAgentsApiRepository[] = [];
    for (const shell of shells) {
      const provider = shell.repositoryIdentity?.provider;
      if (
        provider !== "github" &&
        provider !== "gitlab" &&
        provider !== "bitbucket" &&
        provider !== "azure-devops"
      ) {
        continue;
      }
      const selector = sourceControlRepositorySelector(shell.repositoryIdentity);
      if (selector === null) continue;
      const url = repositoryUrlForIdentity({
        provider,
        selector,
        ...(shell.repositoryIdentity?.canonicalKey === undefined
          ? {}
          : { canonicalKey: shell.repositoryIdentity.canonicalKey }),
      });
      if (url === undefined) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      items.push({ url });
    }
    return items;
  });

  const createAgent: CloudAgentsApi["Service"]["createAgent"] = (input) =>
    Effect.gen(function* () {
      const invalid = validateCreateAgentRequest(input.body);
      if (invalid !== undefined) return yield* Effect.fail(invalid);
      const current = yield* snapshot;
      if (input.body.agentId !== undefined) {
        const existing = current.agents?.find((agent) => agent.id === input.body.agentId);
        if (existing !== undefined) {
          return yield* Effect.fail(
            apiError("agent_id_conflict", `Agent '${input.body.agentId}' already exists.`),
          );
        }
      }
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      const startedAt = Date.parse(occurredAt);
      const defaults = current.controller.defaults ?? {};
      const agentId = CloudAgentId.make(input.body.agentId ?? `bc-${NodeCrypto.randomUUID()}`);
      const runId = CloudRunId.make(`run-${NodeCrypto.randomUUID()}`);
      const allocationId = RunAllocationId.make(`alloc-${agentId}`);
      const commandId = CommandId.make(`cmd-${NodeCrypto.randomUUID()}`);
      const messageId = MessageId.make(`msg-${NodeCrypto.randomUUID()}`);
      const threadId = ThreadId.make(`thread-${agentId}`);
      const title = titleFromPrompt(input.body.prompt.text, input.body.name);
      const repos = input.body.repos ?? [];
      const parsedRepos = repos.flatMap((candidate) => {
        const parsed = parseRepositoryUrl(candidate.url);
        return parsed === undefined ? [] : [{ input: candidate, parsed }];
      });
      if (repos.length > 0 && parsedRepos.length !== repos.length) {
        const bad = repos.find((candidate) => parseRepositoryUrl(candidate.url) === undefined);
        return yield* Effect.fail(
          apiError("invalid_request", `Unsupported repository URL '${bad?.url ?? ""}'.`),
        );
      }
      if (collaboration !== undefined) {
        const configured = parsedRepos.map((candidate) => candidate.parsed.ownerName);
        for (const candidate of parsedRepos) {
          yield* collaboration
            .authorizeRepository({
              repository: candidate.parsed.ownerName,
              actorRepositories: [],
              configuredRepositories: configured,
            })
            .pipe(Effect.mapError(mapCollaborationFailure));
        }
      }
      const scratchRequested =
        input.body.scratch !== undefined ||
        (repos.length === 0 &&
          (defaults.repository === undefined || defaults.repository.length === 0));
      const primaryRepo = parsedRepos[0];
      const repository = scratchRequested
        ? "scratch/workspace"
        : (primaryRepo?.parsed.ownerName ?? defaults.repository ?? "scratch/workspace");
      const selectedRef = primaryRepo?.input.startingRef ?? defaults.ref ?? "main";
      const plan = resolveCloudBranchPlan({
        agentId,
        startingRef: selectedRef,
        currentBranch: selectedRef,
        ...(primaryRepo?.input.prUrl === undefined ? {} : { prUrl: primaryRepo.input.prUrl }),
        ...(input.body.workOnCurrentBranch === undefined
          ? {}
          : { workOnCurrentBranch: input.body.workOnCurrentBranch }),
        ...(input.body.autoCreatePR === undefined ? {} : { autoCreatePR: input.body.autoCreatePR }),
        ...(input.body.skipReviewerRequest === undefined
          ? {}
          : { skipReviewerRequest: input.body.skipReviewerRequest }),
      });
      const branch = plan.branch;
      const env = defaultEnv(input.body);
      const policy =
        defaults.selfHostedMode ?? (selfHosted === undefined ? "off" : yield* selfHosted.policy);
      if (selfHosted !== undefined && defaults.selfHostedMode !== undefined) {
        yield* selfHosted.setPolicy(defaults.selfHostedMode);
      }
      const denied = admitSelfHostedTarget({ policy, target: env.type });
      if (denied !== undefined) {
        return yield* Effect.fail(apiError(denied.code, denied.message));
      }
      const models = yield* listModels;
      const modelId = input.body.model?.id ?? defaults.model ?? models[0]?.id ?? "default";
      const instanceType = current.limits.allowedInstanceTypes[0] ?? "t3.medium";
      const runSeconds = Math.min(
        current.limits.maxRunSeconds,
        input.limits?.runSeconds ?? 3 * 24 * 60 * 60,
      );
      yield* allocations
        .dispatch({
          type: "allocation.launch",
          commandId,
          allocationId,
          attempt: RunAllocationAttempt.make(1),
          occurredAt,
          target: {
            repository,
            baseCommit: selectedRef,
            branch,
            ...(scratchRequested ? { workspaceKind: "scratch" as const } : {}),
            ...(input.body.scratch?.name === undefined
              ? {}
              : {
                  scratchDraft: {
                    name: input.body.scratch.name,
                    visibility: input.body.scratch.visibility ?? "private",
                  },
                }),
            ...(parsedRepos.length > 1
              ? {
                  additionalRepositories: parsedRepos.slice(1).map((candidate) => ({
                    repository: candidate.parsed.ownerName,
                    baseCommit: candidate.input.startingRef ?? selectedRef,
                    branch:
                      plan.branch === selectedRef
                        ? (candidate.input.startingRef ?? selectedRef)
                        : plan.branch,
                  })),
                }
              : {}),
          },
          publication:
            plan.autoCreatePR && !scratchRequested
              ? {
                  mode: "automatic-draft-pr",
                  baseBranch: selectedRef,
                  title,
                  body: "Started from the Cloud Agents API.",
                  ...(plan.skipReviewerRequest ? { skipReviewerRequest: true } : {}),
                }
              : { mode: "review-only" },
          control: { agentId, runId },
          execution: {
            threadId,
            title,
            selectedRef,
            unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds.make(
              Math.min(input.limits?.inputWaitSeconds ?? 900, current.limits.maxInputWaitSeconds),
            ),
            turn: {
              commandId,
              messageId,
              prompt: input.body.prompt.text,
              attachments: [],
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: modelId,
                ...(input.body.model?.params === undefined
                  ? {}
                  : {
                      options: input.body.model.params.map((param) => ({
                        id: param.id,
                        value: param.value,
                      })),
                    }),
              },
              runtimeMode: "full-access",
              interactionMode: interactionMode(input.body.mode),
              createdAt: occurredAt,
            },
          },
          profile:
            env.type === "cloud"
              ? { id: "linux-web", os: "linux", arch: "x64", instanceType }
              : {
                  id: SELF_HOSTED_WORKER_PROFILE_ID,
                  os: "linux",
                  arch: "x64",
                  instanceType: "self-hosted",
                },
          principal: principalFromApiKey(input.principal),
          deadlines: {
            launchBy: deadline(startedAt, Math.min(120, runSeconds)),
            bootBy: deadline(startedAt, Math.min(300, runSeconds)),
            registerBy: deadline(startedAt, Math.min(420, runSeconds)),
            expiresAt: deadline(startedAt, runSeconds),
            cleanupBy: deadline(startedAt, runSeconds + 600),
          },
        })
        .pipe(Effect.mapError(mapControllerError));
      yield* sql`
        INSERT INTO cloud_agents_api_records (agent_id, principal_id, team_id, allocation_id, record_json, created_at)
        VALUES (
          ${agentId},
          ${input.principal.principalId},
          ${teamIdOf(input.principal)},
          ${allocationId},
          ${encodeRecord({
            env: defaultEnv(input.body),
            ...(input.body.repos === undefined ? {} : { repos: input.body.repos }),
            ...(input.body.workOnCurrentBranch === undefined
              ? {}
              : { workOnCurrentBranch: input.body.workOnCurrentBranch }),
            ...(input.body.autoCreatePR === undefined
              ? {}
              : { autoCreatePR: input.body.autoCreatePR }),
            ...(input.body.skipReviewerRequest === undefined
              ? {}
              : { skipReviewerRequest: input.body.skipReviewerRequest }),
            ...(input.body.mcpServers === undefined ? {} : { mcpServers: input.body.mcpServers }),
            ...(input.body.customSubagents === undefined
              ? {}
              : { customSubagents: input.body.customSubagents }),
          })},
          ${occurredAt}
        )
      `.pipe(
        Effect.mapError(() => apiError("internal_error", "Could not persist the agent record.")),
      );
      const located = yield* locate(input.principal, agentId);
      const run = located.runs.find((candidate) => candidate.id === runId) ?? located.runs[0];
      if (run === undefined) {
        return yield* Effect.fail(apiError("internal_error", "The initial run was not recorded."));
      }
      const nowMs = Date.parse(occurredAt);
      yield* seedStatus(run, Number.isFinite(nowMs) ? nowMs : epochNowMs());
      if (selfHosted !== undefined && env.type !== "cloud") {
        const [repoOwner, repoName] = (primaryRepo?.parsed.ownerName ?? "").split("/");
        yield* selfHosted
          .enqueue({
            id: agentId,
            target: env.type,
            principal: input.principal,
            ...(env.name === undefined ? {} : { poolName: env.name }),
            ...(repoOwner === undefined || repoOwner.length === 0 ? {} : { repoOwner }),
            ...(repoName === undefined || repoName.length === 0 ? {} : { repoName }),
            ...(primaryRepo?.input.url === undefined ? {} : { repoUrl: primaryRepo.input.url }),
          })
          .pipe(
            Effect.mapError((error) =>
              apiError(
                error.code === "self_hosted_disabled" || error.code === "self_hosted_required"
                  ? error.code
                  : "invalid_request",
                error.message,
              ),
            ),
          );
      }
      if (diagnostics !== undefined) {
        const admission = admitCloudExtensibility(
          {
            teamMcp: [],
            personalMcp: [],
            apiMcp: input.body.mcpServers ?? [],
            customSubagents: input.body.customSubagents ?? [],
          },
          {
            disableAllMcpServers: false,
            mcpServerAllowlist: [],
            egress: resolveCloudEgressPolicy({
              environment: { mode: "allow_all", allowlist: [] },
              exceptions: cloudEgressExceptions({
                controllerHost: "controller.internal",
                scmHosts: ["github.com"],
                artifactHosts: [],
              }),
            }),
            controllerMcpOrigin: input.urlOrigin,
            phase: "runtime",
            parentPermissions: {
              filesystem: true,
              network: true,
              secrets: true,
            },
          },
        );
        yield* diagnostics.bindRun({
          agentId,
          runId,
          repository,
          admission,
        });
        yield* Effect.forEach(admission.subagents, (subagent) =>
          diagnostics.recordSubagentUsage(subagentUsageEvent({ runId, subagent })),
        );
      }
      const record = { ...located.record, urlOrigin: input.urlOrigin };
      return {
        agent: publicAgent(located.agent, record),
        run: publicRun(run),
      };
    });

  const listAgents: CloudAgentsApi["Service"]["listAgents"] = (input) =>
    Effect.gen(function* () {
      const owned = yield* readOwned({ principalId: input.principal.principalId }).pipe(
        Effect.mapError(() => apiError("internal_error", "The API catalog is unavailable.")),
      );
      const current = yield* snapshot;
      const byId = new Map(owned.map((row) => [row.agentId, row]));
      const items = [...(current.agents ?? [])]
        .filter((agent) => byId.has(agent.id))
        .filter((agent) => {
          const allocation = current.allocations.find((row) => row.id === agent.allocationId);
          return allocation?.deletion === undefined;
        })
        .filter((agent) => input.includeArchived !== false || agent.status !== "ARCHIVED")
        .filter((agent) => {
          if (input.prUrl === undefined) return true;
          const row = byId.get(agent.id);
          if (row === undefined) return false;
          const payload = decodeRecord(row.recordJson);
          return payload.repos?.some((repo) => repo.prUrl === input.prUrl) === true;
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const page = paginateNewestFirst(items, {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        items: page.items.map((agent) => {
          const row = byId.get(agent.id)!;
          const payload = decodeRecord(row.recordJson);
          return publicAgentSummary(agent, {
            env: payload.env,
            urlOrigin: input.urlOrigin,
          });
        }),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    });

  const getAgent: CloudAgentsApi["Service"]["getAgent"] = (input) =>
    Effect.gen(function* () {
      const located = yield* locate(input.principal, input.agentId);
      return publicAgent(located.agent, { ...located.record, urlOrigin: input.urlOrigin });
    });

  const createRun: CloudAgentsApi["Service"]["createRun"] = (input) =>
    Effect.gen(function* () {
      const invalid = validateCreateRunRequest(input.body);
      if (invalid !== undefined) return yield* Effect.fail(invalid);
      const located = yield* locate(input.principal, input.agentId, "follow-up");
      if (located.agent.status === "ARCHIVED") {
        return yield* Effect.fail(
          apiError("agent_archived", `Agent '${input.agentId}' is archived.`),
        );
      }
      if (located.runs.some((run) => isActiveRunStatus(run.status))) {
        return yield* Effect.fail(
          apiError("agent_busy", `Agent '${input.agentId}' already has an active run.`),
        );
      }
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      const requestedLimits = input.limits;
      const controller = requestedLimits === undefined ? undefined : yield* snapshot;
      const startedAt = Date.parse(occurredAt);
      const runSeconds =
        controller === undefined || requestedLimits === undefined
          ? undefined
          : Math.min(controller.limits.maxRunSeconds, requestedLimits.runSeconds);
      const runId = CloudRunId.make(`run-${input.requestId ?? NodeCrypto.randomUUID()}`);
      const commandId = CommandId.make(`cmd-${input.requestId ?? NodeCrypto.randomUUID()}`);
      const messageId = MessageId.make(`msg-${input.requestId ?? NodeCrypto.randomUUID()}`);
      const title = titleFromPrompt(input.body.prompt.text);
      const previous = located.allocation.execution;
      yield* allocations
        .dispatch({
          type: "allocation.follow-up",
          commandId,
          allocationId: located.allocation.id,
          attempt: located.allocation.attempt,
          occurredAt,
          runId,
          execution: {
            threadId: previous?.threadId ?? ThreadId.make(`thread-${input.agentId}`),
            title,
            selectedRef: input.selectedRef ?? previous?.selectedRef ?? located.agent.baseCommit,
            unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds.make(
              controller === undefined || requestedLimits === undefined
                ? (previous?.unansweredRequestSeconds ?? 900)
                : Math.min(controller.limits.maxInputWaitSeconds, requestedLimits.inputWaitSeconds),
            ),
            turn: {
              commandId,
              messageId,
              prompt: input.body.prompt.text,
              attachments: [],
              modelSelection: previous?.turn.modelSelection ?? {
                instanceId: ProviderInstanceId.make("codex"),
                model: "default",
              },
              runtimeMode: previous?.turn.runtimeMode ?? "full-access",
              interactionMode: interactionMode(input.body.mode),
              createdAt: occurredAt,
            },
          },
          deadlines:
            runSeconds === undefined
              ? located.allocation.deadlines
              : {
                  launchBy: deadline(startedAt, Math.min(120, runSeconds)),
                  bootBy: deadline(startedAt, Math.min(300, runSeconds)),
                  registerBy: deadline(startedAt, Math.min(420, runSeconds)),
                  expiresAt: deadline(startedAt, runSeconds),
                  cleanupBy: deadline(startedAt, runSeconds + 600),
                },
          principal: principalFromApiKey(input.principal),
        })
        .pipe(Effect.mapError(mapControllerError));
      if (selfHosted !== undefined && located.record.env.type !== "cloud") {
        yield* selfHosted
          .enqueue({
            id: input.agentId,
            target: located.record.env.type,
            principal: input.principal,
            ...(located.record.env.name === undefined ? {} : { poolName: located.record.env.name }),
          })
          .pipe(
            Effect.mapError((error) =>
              apiError(
                error.code === "self_hosted_disabled" || error.code === "self_hosted_required"
                  ? error.code
                  : "invalid_request",
                error.message,
              ),
            ),
          );
      }
      const refreshed = yield* locate(input.principal, input.agentId);
      const run = refreshed.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* Effect.fail(
          apiError("internal_error", "The follow-up run was not recorded."),
        );
      }
      yield* seedStatus(run, Date.parse(occurredAt) || epochNowMs());
      return { run: publicRun(run) };
    });

  const listRuns: CloudAgentsApi["Service"]["listRuns"] = (input) =>
    Effect.gen(function* () {
      const located = yield* locate(input.principal, input.agentId);
      const published = yield* gitFor(located.agent, located.allocation, located.record.repos);
      const items = [...located.runs]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((run) =>
          publicRun(run, {
            ...(published.git === undefined ? {} : { git: published.git }),
            ...(published.provenance === undefined ? {} : { provenance: published.provenance }),
          }),
        );
      return paginateNewestFirst(items, {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
    });

  const getRun: CloudAgentsApi["Service"]["getRun"] = (input) =>
    Effect.gen(function* () {
      const located = yield* locate(input.principal, input.agentId);
      const run = located.runs.find((candidate) => candidate.id === input.runId);
      if (run === undefined) {
        return yield* Effect.fail(apiError("run_not_found", `Run '${input.runId}' was not found.`));
      }
      const published = yield* gitFor(located.agent, located.allocation, located.record.repos);
      let result: string | undefined;
      if (results !== undefined && isTerminalRunStatus(run.status)) {
        const resultId = CloudRunResults.cloudResultIdFor(
          located.allocation.id,
          located.allocation.attempt,
        );
        const text = Option.getOrUndefined(
          yield* results
            .readTextPrefix(resultId, "transcript", CLOUD_AGENTS_API_RESULT_SUMMARY_CHARS)
            .pipe(Effect.option),
        );
        result = text?.text;
      }
      return publicRun(run, {
        ...(published.git === undefined ? {} : { git: published.git }),
        ...(published.provenance === undefined ? {} : { provenance: published.provenance }),
        ...(result === undefined ? {} : { result }),
      });
    });

  const cancelRun: CloudAgentsApi["Service"]["cancelRun"] = (input) =>
    Effect.gen(function* () {
      const located = yield* locate(input.principal, input.agentId, "owner");
      const run = located.runs.find((candidate) => candidate.id === input.runId);
      if (run === undefined) {
        return yield* Effect.fail(apiError("run_not_found", `Run '${input.runId}' was not found.`));
      }
      if (!isActiveRunStatus(run.status)) {
        return yield* Effect.fail(
          apiError("run_not_cancellable", `Run '${input.runId}' cannot be cancelled.`),
        );
      }
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      yield* allocations
        .dispatch({
          type: "allocation.cancel",
          commandId: CommandId.make(`cmd-${NodeCrypto.randomUUID()}`),
          allocationId: located.allocation.id,
          attempt: located.allocation.attempt,
          occurredAt,
        })
        .pipe(Effect.mapError(mapControllerError));
      const nowMs = Date.parse(occurredAt) || epochNowMs();
      yield* appendStreamEvent({
        runId: run.id,
        event: "result",
        data: { runId: run.id, status: "CANCELLED" },
        nowMs,
      });
      yield* appendStreamEvent({ runId: run.id, event: "done", data: {}, nowMs });
      return { id: run.id };
    });

  const usage: CloudAgentsApi["Service"]["usage"] = (input) =>
    Effect.gen(function* () {
      const located = yield* locate(input.principal, input.agentId);
      const selected =
        input.runId === undefined
          ? located.runs
          : located.runs.filter((run) => run.id === input.runId);
      if (input.runId !== undefined && selected.length === 0) {
        return yield* Effect.fail(apiError("run_not_found", `Run '${input.runId}' was not found.`));
      }
      const newestFirst = [...selected].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
      return agentUsageFromRuns(newestFirst.map((run) => ({ id: run.id })));
    });

  const usageReport: CloudAgentsApi["Service"]["usageReport"] = (input) =>
    Effect.gen(function* () {
      const report = yield* allocations
        .exportUsage({ periodStart: input.periodStart, periodEnd: input.periodEnd })
        .pipe(Effect.mapError(mapControllerError));
      if (publication === undefined) return report;
      const records = yield* publication.list().pipe(Effect.orElseSucceed(() => []));
      const provenance = records.flatMap((record) =>
        record.provenance === undefined ? [] : [record.provenance],
      );
      return provenance.length === 0 ? report : { ...report, provenance };
    });

  const mutateLifecycle = (
    type: "allocation.agent-archive" | "allocation.agent-unarchive" | "allocation.agent-delete",
  ) =>
    Effect.fn("CloudAgentsApi.lifecycle")(function* (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly agentId: string;
    }) {
      const located = yield* locate(input.principal, input.agentId, "owner");
      if (
        type === "allocation.agent-delete" &&
        located.runs.some((run) => isActiveRunStatus(run.status))
      ) {
        return yield* Effect.fail(
          apiError("agent_busy", `Agent '${input.agentId}' still has an active run.`),
        );
      }
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      yield* allocations
        .dispatch({
          type,
          commandId: CommandId.make(`cmd-${NodeCrypto.randomUUID()}`),
          allocationId: located.allocation.id,
          attempt: located.allocation.attempt,
          occurredAt,
        })
        .pipe(Effect.mapError(mapControllerError));
      if (type === "allocation.agent-delete" && results !== undefined) {
        const after = yield* snapshot;
        const allocation = after.allocations.find((row) => row.id === located.allocation.id);
        if (allocation !== undefined && isDeletionPurgeReady(allocation)) {
          const purged = yield* results
            .purgeAllocation({
              allocationId: allocation.id,
              attempts: Array.from({ length: allocation.attempt }, (_, index) => index + 1),
            })
            .pipe(Effect.orElseSucceed(() => []));
          yield* allocations
            .purgeAllocation({
              allocationId: allocation.id,
              deletedAt: occurredAt,
              purgedResultIds: purged,
            })
            .pipe(Effect.mapError(mapControllerError));
        }
      }
      return { id: input.agentId };
    });

  const retainedSnapshot = Effect.fn("CloudAgentsApi.retainedSnapshot")(function* (
    allocation: RunAllocation,
  ) {
    if (results === undefined) return undefined;
    const resultId = CloudRunResults.cloudResultIdFor(allocation.id, allocation.attempt);
    const prefix = Option.getOrUndefined(
      yield* results
        .readTextPrefix(resultId, "transcript", CLOUD_AGENTS_API_HISTORY_PAGE_BYTES)
        .pipe(Effect.option),
    );
    if (prefix === undefined || prefix.truncated) return undefined;
    return Option.getOrUndefined(decodeThreadSnapshot(prefix.text));
  });

  const streamRun: CloudAgentsApi["Service"]["streamRun"] = (input) =>
    Effect.gen(function* () {
      const located = yield* locate(input.principal, input.agentId);
      const run = located.runs.find((candidate) => candidate.id === input.runId);
      if (run === undefined) {
        return yield* Effect.fail(apiError("run_not_found", `Run '${input.runId}' was not found.`));
      }
      const reconnect = selectReconnectSource({
        agent: located.agent,
        allocation: located.allocation,
        workerTurnLimit: CLOUD_AGENTS_API_WORKER_TURN_LIMIT,
      });
      const workerWindow =
        reconnect.turnLimit === undefined ? undefined : { turnLimit: reconnect.turnLimit };
      let workerEvents: ReadonlyArray<CloudAgentsApiStreamEvent> = [];
      if (reconnect.source === "worker-cursor" && workerClient !== undefined) {
        const detail = yield* workerClient
          .threadDetail(located.allocation, workerWindow)
          .pipe(Effect.option);
        if (Option.isSome(detail)) {
          workerEvents = eventsFromThreadSnapshot({
            snapshot: detail.value,
            run,
            nowMs: input.nowMs,
          });
        }
      }
      let controllerEvents: ReadonlyArray<CloudAgentsApiStreamEvent> = [];
      if (reconnect.source === "controller-transcript") {
        const snapshot = yield* retainedSnapshot(located.allocation);
        if (snapshot !== undefined) {
          controllerEvents = eventsFromThreadSnapshot({
            snapshot,
            run,
            nowMs: input.nowMs,
          });
        }
      }
      const log = (yield* Ref.get(streams)).get(run.id) ?? emptyStreamBuffer();
      const merged = mergeStreamSources({
        live: log.events,
        worker: workerEvents,
        controller: controllerEvents,
      });
      const withStatus = merged.some((event) => event.event === "status")
        ? merged
        : [
            {
              event: "status" as const,
              data: { runId: run.id, status: run.status },
              createdAtMs: Date.parse(run.createdAt) || input.nowMs,
            },
            ...merged,
          ];
      let events = maybeHeartbeat({
        events: withStatus,
        nowMs: input.nowMs,
        active: isActiveRunStatus(run.status),
      });
      if (run.status === "ERROR" && !events.some((event) => event.event === "error")) {
        events = [
          ...events,
          {
            id: streamEventId(input.nowMs, events.length),
            event: "error",
            data: { code: "internal_error", message: "The run failed." },
            createdAtMs: input.nowMs,
          },
        ];
      }
      if (isTerminalRunStatus(run.status) && !events.some((event) => event.event === "done")) {
        const completedMs = Date.parse(run.updatedAt) || input.nowMs;
        events = [
          ...events,
          {
            id: streamEventId(completedMs, events.length),
            event: "result",
            data: { runId: run.id, status: run.status },
            createdAtMs: completedMs,
          },
          {
            id: streamEventId(completedMs, events.length + 1),
            event: "done",
            data: {},
            createdAtMs: completedMs,
          },
        ];
      }
      let buffer = emptyStreamBuffer();
      for (const event of events) buffer = appendBoundedStreamEvent(buffer, event);
      const resumed = resumeBoundedStream({
        buffer,
        lastEventId: input.lastEventId,
        nowMs: input.nowMs,
      });
      if (!resumed.ok) return yield* Effect.fail(resumed.error);
      return { events: resumed.events, reconnectSource: reconnect.source };
    });

  const listHistory: CloudAgentsApi["Service"]["listHistory"] = (input) =>
    Effect.gen(function* () {
      const located = yield* locate(input.principal, input.agentId);
      const run = located.runs.find((candidate) => candidate.id === input.runId);
      if (run === undefined) {
        return yield* Effect.fail(apiError("run_not_found", `Run '${input.runId}' was not found.`));
      }
      const reconnect = selectReconnectSource({
        agent: located.agent,
        allocation: located.allocation,
        workerTurnLimit: CLOUD_AGENTS_API_WORKER_TURN_LIMIT,
      });
      const workerWindow =
        reconnect.turnLimit === undefined ? undefined : { turnLimit: reconnect.turnLimit };
      if (input.kind === "artifacts") {
        if (results === undefined) {
          return pageHistory({ items: [] });
        }
        const resultId = CloudRunResults.cloudResultIdFor(
          located.allocation.id,
          located.allocation.attempt,
        );
        const status = Option.getOrUndefined(yield* results.status(resultId).pipe(Effect.option));
        const artifacts =
          status?.status === "retained"
            ? status.manifest.artifacts.map((artifact) => ({
                id: artifact.id,
                kind: "artifacts" as const,
                summary: artifact.name,
                bytes: artifact.sizeBytes,
              }))
            : [];
        return pageHistory({
          items: artifacts,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
      }
      if (input.kind === "setup") {
        const setup = located.allocation.execution;
        const summary = setup === undefined ? located.agent.repository : `${setup.selectedRef}`;
        return pageHistory({
          items: [
            {
              id: `setup:${located.allocation.id}:${located.allocation.attempt}`,
              kind: "setup",
              summary,
              bytes: Buffer.byteLength(summary, "utf8"),
            },
          ],
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
      }
      let snapshot: OrchestrationThreadDetailSnapshot | undefined;
      if (reconnect.source === "worker-cursor" && workerClient !== undefined) {
        snapshot = Option.getOrUndefined(
          yield* workerClient.threadDetail(located.allocation, workerWindow).pipe(Effect.option),
        );
      } else {
        snapshot = yield* retainedSnapshot(located.allocation);
      }
      return pageHistory({
        items: snapshot === undefined ? [] : historyItemsFromSnapshot(snapshot, input.kind),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        byteBudget: CLOUD_AGENTS_API_HISTORY_PAGE_BYTES,
      });
    });

  return CloudAgentsApi.of({
    me,
    createAgent,
    listAgents,
    getAgent,
    createRun,
    listRuns,
    getRun,
    cancelRun,
    usage,
    usageReport,
    archive: mutateLifecycle("allocation.agent-archive"),
    unarchive: mutateLifecycle("allocation.agent-unarchive"),
    deleteAgent: mutateLifecycle("allocation.agent-delete"),
    streamRun,
    listHistory,
    appendStreamEvent,
    listModels,
    listRepositories,
  });
});

export const layer = Layer.effect(CloudAgentsApi, make());
