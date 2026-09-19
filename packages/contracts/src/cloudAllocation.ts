import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CloudAgentId,
  CloudRunId,
  CommandId,
  CloudRunResultId,
  CloudRuntimeAttemptId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RunAllocationAttempt,
  RunAllocationId,
  RunWorkerId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatformArch, ExecutionEnvironmentPlatformOs } from "./environment.ts";
import { CloudProviderTurnInput, CloudProviderUnansweredRequestSeconds } from "./cloudExecution.ts";
import { CloudEnvironment, CloudEnvironmentVersionReference } from "./cloudEnvironment.ts";

export const RunWorkerDevice = Schema.Literals(["android", "ios"]);
export type RunWorkerDevice = typeof RunWorkerDevice.Type;

export const RunWorkerProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  device: Schema.optionalKey(RunWorkerDevice),
  /** Missing on allocation requests written before CA-18. New admissions require it. */
  instanceType: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RunWorkerProfile = typeof RunWorkerProfile.Type;

export const RunRepositoryTarget = Schema.Struct({
  repository: TrimmedNonEmptyString,
  baseCommit: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type RunRepositoryTarget = typeof RunRepositoryTarget.Type;

export const RunDeadlines = Schema.Struct({
  launchBy: IsoDateTime,
  bootBy: IsoDateTime,
  registerBy: IsoDateTime,
  expiresAt: IsoDateTime,
  cleanupBy: IsoDateTime,
});
export type RunDeadlines = typeof RunDeadlines.Type;

export const RunLaunchTemplate = Schema.Struct({
  id: TrimmedNonEmptyString,
  version: PositiveInt,
});
export type RunLaunchTemplate = typeof RunLaunchTemplate.Type;

export const RunLaunchRetry = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), failures: NonNegativeInt }),
  Schema.Struct({
    status: Schema.Literal("waiting"),
    failures: PositiveInt,
    retryAt: IsoDateTime,
    reason: TrimmedNonEmptyString,
  }),
]);
export type RunLaunchRetry = typeof RunLaunchRetry.Type;

export const RunWorkerReferences = Schema.Struct({
  workerId: RunWorkerId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type RunWorkerReferences = typeof RunWorkerReferences.Type;

export const RunWorkerRoute = Schema.Struct({
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  accessToken: TrimmedNonEmptyString,
});
export type RunWorkerRoute = typeof RunWorkerRoute.Type;

export const RunWorkerRegistrationInput = Schema.Struct({
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  references: RunWorkerReferences,
  route: RunWorkerRoute,
});
export type RunWorkerRegistrationInput = typeof RunWorkerRegistrationInput.Type;

export const RunResultLocation = Schema.Struct({
  uri: TrimmedNonEmptyString,
});
export type RunResultLocation = typeof RunResultLocation.Type;

export const RunPublicationIntent = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("review-only") }),
  Schema.Struct({
    mode: Schema.Literal("automatic-draft-pr"),
    baseBranch: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
    body: Schema.String,
  }),
]);
export type RunPublicationIntent = typeof RunPublicationIntent.Type;

export const RunExecutionIntent = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  selectedRef: TrimmedNonEmptyString,
  unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds,
  turn: CloudProviderTurnInput,
});
export type RunExecutionIntent = typeof RunExecutionIntent.Type;

export const RunControlPlaneLink = Schema.Struct({
  agentId: CloudAgentId,
  runId: CloudRunId,
});
export type RunControlPlaneLink = typeof RunControlPlaneLink.Type;

export const CloudAgentRuntimeReferences = Schema.Struct({
  runtimeAttemptId: CloudRuntimeAttemptId,
  workerId: RunWorkerId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type CloudAgentRuntimeReferences = typeof CloudAgentRuntimeReferences.Type;

export const CloudAgentConversation = Schema.Struct({
  title: TrimmedNonEmptyString,
  runIds: Schema.Array(CloudRunId),
});
export type CloudAgentConversation = typeof CloudAgentConversation.Type;

export const CloudAgentStatus = Schema.Literals(["ACTIVE", "IDLE", "ARCHIVED"]);
export type CloudAgentStatus = typeof CloudAgentStatus.Type;

const CloudAgentBase = {
  id: CloudAgentId,
  allocationId: RunAllocationId,
  conversation: CloudAgentConversation,
  repository: TrimmedNonEmptyString,
  baseCommit: TrimmedNonEmptyString,
  environmentProfileId: TrimmedNonEmptyString,
  /** Missing on agents created before versioned cloud environments. */
  environment: Schema.optionalKey(CloudEnvironmentVersionReference),
  branches: Schema.Array(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

export const CloudAgent = Schema.Union([
  Schema.Struct({
    ...CloudAgentBase,
    status: Schema.Literal("ACTIVE"),
    activeRunId: CloudRunId,
    runtime: Schema.optionalKey(CloudAgentRuntimeReferences),
  }),
  Schema.Struct({ ...CloudAgentBase, status: Schema.Literal("IDLE") }),
  Schema.Struct({
    ...CloudAgentBase,
    status: Schema.Literal("ARCHIVED"),
    archivedAt: IsoDateTime,
  }),
]);
export type CloudAgent = typeof CloudAgent.Type;

const CloudRunBase = {
  id: CloudRunId,
  agentId: CloudAgentId,
  allocationId: RunAllocationId,
  branch: TrimmedNonEmptyString,
  execution: Schema.optionalKey(RunExecutionIntent),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

export const CloudRunStatus = Schema.Literals([
  "CREATING",
  "RUNNING",
  "FINISHED",
  "ERROR",
  "CANCELLED",
  "EXPIRED",
]);
export type CloudRunStatus = typeof CloudRunStatus.Type;

export const CloudRun = Schema.Union([
  Schema.Struct({ ...CloudRunBase, status: Schema.Literal("CREATING") }),
  Schema.Struct({
    ...CloudRunBase,
    status: Schema.Literal("RUNNING"),
    startedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...CloudRunBase,
    status: Schema.Literal("FINISHED"),
    completedAt: IsoDateTime,
    resultLocation: RunResultLocation,
  }),
  Schema.Struct({
    ...CloudRunBase,
    status: Schema.Literal("ERROR"),
    completedAt: IsoDateTime,
    reason: TrimmedNonEmptyString,
    resultLocation: Schema.optionalKey(RunResultLocation),
  }),
  Schema.Struct({
    ...CloudRunBase,
    status: Schema.Literal("CANCELLED"),
    completedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...CloudRunBase,
    status: Schema.Literal("EXPIRED"),
    completedAt: IsoDateTime,
  }),
]);
export type CloudRun = typeof CloudRun.Type;

const CloudRuntimeAttemptBase = {
  id: CloudRuntimeAttemptId,
  agentId: CloudAgentId,
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  runIds: Schema.Array(CloudRunId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

export const CloudRuntimeAttemptStatus = Schema.Literals([
  "CREATING",
  "ACTIVE",
  "ERROR",
  "RELEASED",
  "FENCED",
]);
export type CloudRuntimeAttemptStatus = typeof CloudRuntimeAttemptStatus.Type;

export const CloudRuntimeAttempt = Schema.Union([
  Schema.Struct({ ...CloudRuntimeAttemptBase, status: Schema.Literal("CREATING") }),
  Schema.Struct({
    ...CloudRuntimeAttemptBase,
    status: Schema.Literal("ACTIVE"),
    references: RunWorkerReferences,
  }),
  Schema.Struct({
    ...CloudRuntimeAttemptBase,
    status: Schema.Literal("ERROR"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...CloudRuntimeAttemptBase, status: Schema.Literal("RELEASED") }),
  Schema.Struct({ ...CloudRuntimeAttemptBase, status: Schema.Literal("FENCED") }),
]);
export type CloudRuntimeAttempt = typeof CloudRuntimeAttempt.Type;

const defaultPublicationIntent = RunPublicationIntent.make({ mode: "review-only" });
const RunPublicationIntentWithDefault = RunPublicationIntent.pipe(
  Schema.withDecodingDefault(Effect.succeed(defaultPublicationIntent)),
);

export const RunRetryStartPoint = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("base-commit"),
    commit: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("retained-result"),
    resultId: CloudRunResultId,
  }),
]);
export type RunRetryStartPoint = typeof RunRetryStartPoint.Type;

export const RunPublicationReconciliation = Schema.Union([
  Schema.Struct({ status: Schema.Literal("not-attempted") }),
  Schema.Struct({
    status: Schema.Literal("reconciled-not-published"),
    checkedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("reconciled-published"),
    checkedAt: IsoDateTime,
    branch: TrimmedNonEmptyString,
    commit: TrimmedNonEmptyString,
    pullRequestUrl: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type RunPublicationReconciliation = typeof RunPublicationReconciliation.Type;

export const RunRetryRecord = Schema.Struct({
  previousAttempt: RunAllocationAttempt,
  startPoint: RunRetryStartPoint,
  publication: RunPublicationReconciliation,
});
export type RunRetryRecord = typeof RunRetryRecord.Type;

export const RunAllocationState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("queued") }),
  Schema.Struct({
    status: Schema.Literal("launching"),
    startedAt: IsoDateTime,
    launchTemplate: RunLaunchTemplate,
    retry: RunLaunchRetry,
  }),
  Schema.Struct({
    status: Schema.Literal("booting"),
    instanceId: TrimmedNonEmptyString,
    launchedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("registering"),
    instanceId: TrimmedNonEmptyString,
    bootedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    instanceId: TrimmedNonEmptyString,
    references: RunWorkerReferences,
    /** Absent on CA-08 events written before worker routing was introduced. */
    route: Schema.optionalKey(RunWorkerRoute),
    readyAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: TrimmedNonEmptyString,
    failedAt: IsoDateTime,
    instanceId: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type RunAllocationState = typeof RunAllocationState.Type;

export const RunAgentOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("not-started") }),
  Schema.Struct({ status: Schema.Literal("running"), startedAt: IsoDateTime }),
  Schema.Struct({
    status: Schema.Literal("succeeded"),
    resultLocation: RunResultLocation,
    completedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: TrimmedNonEmptyString,
    resultLocation: RunResultLocation,
    completedAt: IsoDateTime,
  }),
  Schema.Struct({ status: Schema.Literal("cancelled"), cancelledAt: IsoDateTime }),
  Schema.Struct({ status: Schema.Literal("expired"), expiredAt: IsoDateTime }),
]);
export type RunAgentOutcome = typeof RunAgentOutcome.Type;

export const RunPreviewState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable") }),
  Schema.Struct({
    status: Schema.Literal("available"),
    url: TrimmedNonEmptyString,
    publishedAt: IsoDateTime,
  }),
]);
export type RunPreviewState = typeof RunPreviewState.Type;

export const RunCleanupState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("not-requested") }),
  Schema.Struct({ status: Schema.Literal("requested"), requestedAt: IsoDateTime }),
  Schema.Struct({ status: Schema.Literal("running"), startedAt: IsoDateTime }),
  Schema.Struct({ status: Schema.Literal("succeeded"), completedAt: IsoDateTime }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: TrimmedNonEmptyString,
    failedAt: IsoDateTime,
  }),
]);
export type RunCleanupState = typeof RunCleanupState.Type;

export const RunAllocation = Schema.Struct({
  id: RunAllocationId,
  attempt: RunAllocationAttempt,
  target: RunRepositoryTarget,
  publication: RunPublicationIntentWithDefault,
  /** Missing on allocations requested before the web launch flow was added. */
  execution: Schema.optionalKey(RunExecutionIntent),
  /** Missing on allocations created before durable cloud agents and runs. */
  control: Schema.optionalKey(RunControlPlaneLink),
  profile: RunWorkerProfile,
  /** Missing on allocations created before versioned cloud environments. */
  environment: Schema.optionalKey(CloudEnvironmentVersionReference),
  deadlines: RunDeadlines,
  allocationState: RunAllocationState,
  agentOutcome: RunAgentOutcome,
  previewState: RunPreviewState,
  cleanupState: RunCleanupState,
  retry: Schema.optionalKey(RunRetryRecord),
  archivedAt: Schema.optionalKey(IsoDateTime),
  handledCommandIds: Schema.Array(CommandId),
  sequence: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RunAllocation = typeof RunAllocation.Type;

const CommandBase = {
  commandId: CommandId,
  allocationId: RunAllocationId,
  occurredAt: IsoDateTime,
};

const AttemptCommandBase = {
  ...CommandBase,
  attempt: RunAllocationAttempt,
};

export const RunAllocationCommand = Schema.Union([
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.launch"),
    target: RunRepositoryTarget,
    publication: RunPublicationIntentWithDefault,
    execution: Schema.optionalKey(RunExecutionIntent),
    control: Schema.optionalKey(RunControlPlaneLink),
    profile: RunWorkerProfile,
    deadlines: RunDeadlines,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.launch-started"),
    launchTemplate: RunLaunchTemplate,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.launch-retry-scheduled"),
    failures: PositiveInt,
    retryAt: IsoDateTime,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.instance-launched"),
    instanceId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.worker-booted") }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.worker-assigned"),
    references: RunWorkerReferences,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.worker-registered"),
    references: RunWorkerReferences,
    route: RunWorkerRoute,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.launch-failed"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.agent-started") }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.agent-succeeded"),
    resultLocation: RunResultLocation,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.agent-failed"),
    reason: TrimmedNonEmptyString,
    resultLocation: RunResultLocation,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.preview-published"),
    url: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.preview-withdrawn") }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.cancel") }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.expire") }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.follow-up"),
    runId: CloudRunId,
    execution: RunExecutionIntent,
    deadlines: RunDeadlines,
  }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.agent-archive") }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.agent-unarchive") }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.cleanup-started") }),
  Schema.Struct({ ...AttemptCommandBase, type: Schema.Literal("allocation.cleanup-succeeded") }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.cleanup-failed"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...AttemptCommandBase,
    type: Schema.Literal("allocation.retry"),
    nextAttempt: RunAllocationAttempt,
    deadlines: RunDeadlines,
    startPoint: RunRetryStartPoint,
    publication: RunPublicationReconciliation,
  }),
]);
export type RunAllocationCommand = typeof RunAllocationCommand.Type;

const EventBase = {
  sequence: NonNegativeInt,
  commandId: CommandId,
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  occurredAt: IsoDateTime,
};

export const RunAllocationEvent = Schema.Union([
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.requested"),
    target: RunRepositoryTarget,
    /** Missing on allocation events written before CA-16. */
    publication: Schema.optionalKey(RunPublicationIntent),
    /** Missing on allocation events written before CA-19. */
    execution: Schema.optionalKey(RunExecutionIntent),
    /** Missing on allocation events written before CA-40. */
    control: Schema.optionalKey(RunControlPlaneLink),
    profile: RunWorkerProfile,
    /** Missing on allocation events written before CA-41. */
    environment: Schema.optionalKey(CloudEnvironmentVersionReference),
    deadlines: RunDeadlines,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.launch-started"),
    launchTemplate: RunLaunchTemplate,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.launch-retry-scheduled"),
    failures: PositiveInt,
    retryAt: IsoDateTime,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.instance-launched"),
    instanceId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.worker-booted") }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.worker-assigned"),
    references: RunWorkerReferences,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.worker-registered"),
    references: RunWorkerReferences,
    route: RunWorkerRoute,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.launch-failed"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.agent-started") }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.agent-succeeded"),
    resultLocation: RunResultLocation,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.agent-failed"),
    reason: TrimmedNonEmptyString,
    resultLocation: RunResultLocation,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.preview-published"),
    url: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.preview-withdrawn") }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.cancellation-requested") }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.expired") }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.follow-up-requested"),
    runId: CloudRunId,
    execution: RunExecutionIntent,
    deadlines: RunDeadlines,
  }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.agent-archived") }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.agent-unarchived") }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.cleanup-started") }),
  Schema.Struct({ ...EventBase, type: Schema.Literal("allocation.cleanup-succeeded") }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.cleanup-failed"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("allocation.retry-requested"),
    deadlines: RunDeadlines,
    startPoint: Schema.optionalKey(RunRetryStartPoint),
    publication: Schema.optionalKey(RunPublicationReconciliation),
  }),
]);
export type RunAllocationEvent = typeof RunAllocationEvent.Type;

/** `local` runs the controller in the operator's own T3 environment; `permanent`
    runs the same code on an always-on host that survives that computer. */
export const CloudAllocationControllerMode = Schema.Literals(["local", "permanent"]);
export type CloudAllocationControllerMode = typeof CloudAllocationControllerMode.Type;

/** A fenced controller still serves reads so retained results stay reviewable,
    but it refuses every write so a cutover cannot leave two writers behind. */
export const CloudAllocationControllerWritability = Schema.Union([
  Schema.Struct({ status: Schema.Literal("writable") }),
  Schema.Struct({
    status: Schema.Literal("fenced"),
    fencedAt: IsoDateTime,
    reason: TrimmedNonEmptyString,
  }),
]);
export type CloudAllocationControllerWritability = typeof CloudAllocationControllerWritability.Type;

export const CloudAllocationControllerStatus = Schema.Struct({
  mode: CloudAllocationControllerMode,
  /** A local controller can outlive clients, but not the machine hosting T3.
      A permanent controller keeps working with that computer switched off. */
  requiresHostOnline: Schema.Boolean,
  admission: Schema.Union([
    Schema.Struct({ status: Schema.Literal("open") }),
    Schema.Struct({ status: Schema.Literal("stopped"), stoppedAt: IsoDateTime }),
  ]),
  /** Absent when decoding snapshots from controllers older than CA-04B. */
  writability: Schema.optionalKey(CloudAllocationControllerWritability),
});
export type CloudAllocationControllerStatus = typeof CloudAllocationControllerStatus.Type;

export const CloudAllocationLimits = Schema.Struct({
  maxConcurrentWorkers: Schema.Literal(1),
  maxQueueDepth: NonNegativeInt,
  maxRunSeconds: PositiveInt,
  maxInputWaitSeconds: PositiveInt,
  previewGraceSeconds: NonNegativeInt,
  allowedInstanceTypes: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.check(Schema.isMinLength(1)),
  ),
});
export type CloudAllocationLimits = typeof CloudAllocationLimits.Type;

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const CloudWorkerPriceAssumption = Schema.Struct({
  instanceType: TrimmedNonEmptyString,
  hourlyUsd: NonNegativeFinite,
  region: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type CloudWorkerPriceAssumption = typeof CloudWorkerPriceAssumption.Type;

export const CloudRunCostCategory = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("estimated"),
    usd: NonNegativeFinite,
    assumption: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("not-attributed"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({ status: Schema.Literal("unknown"), reason: TrimmedNonEmptyString }),
]);
export type CloudRunCostCategory = typeof CloudRunCostCategory.Type;

export const CloudRunUsage = Schema.Struct({
  allocationId: RunAllocationId,
  attempt: RunAllocationAttempt,
  calculatedAt: IsoDateTime,
  elapsedWorkerSeconds: NonNegativeInt,
  instanceType: Schema.optionalKey(TrimmedNonEmptyString),
  deadlines: RunDeadlines,
  costs: Schema.Struct({
    controllerHost: CloudRunCostCategory,
    workerCompute: CloudRunCostCategory,
    storage: CloudRunCostCategory,
    provider: CloudRunCostCategory,
    streamingTransfer: CloudRunCostCategory,
  }),
});
export type CloudRunUsage = typeof CloudRunUsage.Type;

export const CloudAdmissionControlInput = Schema.Struct({
  admissionOpen: Schema.Boolean,
  occurredAt: IsoDateTime,
});
export type CloudAdmissionControlInput = typeof CloudAdmissionControlInput.Type;

export const CloudAllocationSnapshot = Schema.Struct({
  controller: CloudAllocationControllerStatus,
  limits: CloudAllocationLimits,
  workerPriceAssumptions: Schema.Array(CloudWorkerPriceAssumption),
  /** Billing alerts can lag and are not an exact live spending cap. */
  spendingControl: Schema.Literal("estimate-only"),
  allocations: Schema.Array(RunAllocation),
  /** Absent when decoding snapshots from controllers older than CA-40. */
  agents: Schema.optionalKey(Schema.Array(CloudAgent)),
  /** Absent when decoding snapshots from controllers older than CA-40. */
  runs: Schema.optionalKey(Schema.Array(CloudRun)),
  /** Absent when decoding snapshots from controllers older than CA-40. */
  runtimeAttempts: Schema.optionalKey(Schema.Array(CloudRuntimeAttempt)),
  /** Absent when decoding snapshots from controllers older than CA-41. */
  environments: Schema.optionalKey(Schema.Array(CloudEnvironment)),
  usage: Schema.Array(CloudRunUsage),
});
export type CloudAllocationSnapshot = typeof CloudAllocationSnapshot.Type;

export class CloudAllocationControllerError extends Schema.TaggedError<CloudAllocationControllerError>()(
  "CloudAllocationControllerError",
  {
    reason: Schema.Literals([
      "controller-disabled",
      "controller-fenced",
      "admission-stopped",
      "allocation-not-found",
      "agent_busy",
      "agent-archived",
      "run-already-exists",
      "invalid-request",
      "queue-full",
      "persistence-failed",
      "invalid-persisted-event",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
