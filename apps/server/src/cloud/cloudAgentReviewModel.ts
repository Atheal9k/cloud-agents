import {
  CLOUD_AGENT_REVIEW_PAGE_PREFIX,
  CLOUD_REVIEW_DIFF_PREVIEW_CHARS,
  type CloudAgent,
  type CloudAgentReview,
  type CloudAgentReviewAction,
  type CloudAgentReviewActionAvailability,
  type CloudAllocationSnapshot,
  type CloudArtifactAccessGrant,
  type CloudArtifactInspection,
  type CloudBuildInspection,
  type CloudDiffInspection,
  type CloudEnvironmentBuild,
  type CloudPublicationInspection,
  type CloudRun,
  type CloudRunPublicationRecord,
  type CloudSessionAvailability,
  type CloudSnapshotInspection,
  type RunAllocation,
} from "@t3tools/contracts";

const HTML_MEDIA_TYPE = /(?:^text\/html$|\/xml(?:$|-)|\+xml$)/i;

export function inspectRetainedText(input: {
  readonly value: string | undefined;
  readonly missingReason: string;
  readonly truncated?: boolean;
  readonly sizeChars?: number;
}): CloudDiffInspection {
  if (input.value === undefined) {
    return { status: "missing", reason: input.missingReason };
  }
  if (input.value.includes("\0")) {
    return { status: "binary", reason: "The retained file contains binary data." };
  }
  const sizeChars = input.sizeChars ?? input.value.length;
  if (input.truncated === true || input.value.length > CLOUD_REVIEW_DIFF_PREVIEW_CHARS) {
    return {
      status: "oversized",
      reason: "The retained file is larger than the inline review limit. Download it instead.",
      sizeChars,
    };
  }
  return {
    status: "text",
    preview: input.value,
    truncated: false,
    sizeChars,
  };
}

export function inspectRuntimeSnapshot(allocation: RunAllocation): CloudSnapshotInspection {
  const idle = allocation.idleState;
  if (idle.status === "hibernated") {
    return {
      status: "present",
      instanceId: idle.snapshot.instanceId,
      capturedAt: idle.snapshot.capturedAt,
    };
  }
  if (idle.status === "waking") {
    return {
      status: "present",
      instanceId: idle.snapshot.instanceId,
      capturedAt: idle.snapshot.capturedAt,
    };
  }
  if (idle.status === "idle") {
    return { status: "idle-guest", releaseAt: idle.releaseAt };
  }
  if (allocation.cleanupState.status === "succeeded") {
    return {
      status: "missing",
      reason: "This agent has no retained runtime snapshot. Review does not restore compute.",
    };
  }
  return {
    status: "missing",
    reason: "No idle snapshot has been captured yet.",
  };
}

export function inspectSessionAvailability(allocation: RunAllocation): {
  readonly preview: CloudSessionAvailability;
  readonly terminal: CloudSessionAvailability;
} {
  const live =
    allocation.allocationState.status === "ready" &&
    allocation.allocationState.route !== undefined &&
    allocation.idleState.status !== "hibernated" &&
    allocation.cleanupState.status === "not-requested";
  return {
    preview: live && allocation.previewState.status === "available" ? "available" : "unavailable",
    terminal: live ? "available" : "unavailable",
  };
}

export function inspectBuild(
  allocation: RunAllocation,
  builds: ReadonlyArray<CloudEnvironmentBuild>,
): CloudBuildInspection {
  const pinned = allocation.build;
  if (pinned === undefined) {
    return {
      status: "none",
      reason: "This agent did not boot from a prepared environment Build.",
    };
  }
  const build = builds.find((candidate) => candidate.id === pinned.buildId);
  if (build === undefined) {
    return {
      status: "none",
      reason: `Build ${pinned.buildId} is no longer in the catalog.`,
    };
  }
  return {
    status: "present",
    build,
    failed: build.outcome.status === "failed",
  };
}

export function inspectPublication(
  record: CloudRunPublicationRecord | undefined,
): CloudPublicationInspection {
  if (record === undefined) {
    return { status: "none", reason: "This run has no publication record." };
  }
  return {
    status: "present",
    outcome: record.outcome,
    ...(record.outcome.status === "published"
      ? { pullRequestUrl: record.outcome.pullRequestUrl }
      : {}),
  };
}

export function inspectArtifacts(
  grant: CloudArtifactAccessGrant | undefined,
  expired: boolean,
): ReadonlyArray<CloudArtifactInspection> {
  if (grant === undefined) {
    return [
      {
        status: "missing",
        name: "artifacts",
        reason: expired
          ? "The retained artifacts have expired."
          : "No retained artifacts are available.",
      },
    ];
  }
  return grant.entries.map((entry) => ({
    status: "available" as const,
    entry,
    htmlUntrusted: entry.mediaType !== undefined && HTML_MEDIA_TYPE.test(entry.mediaType.trim()),
  }));
}

function action(
  name: CloudAgentReviewAction,
  available: boolean,
  blockedReason?: string,
): CloudAgentReviewActionAvailability {
  return available
    ? { action: name, available: true }
    : { action: name, available: false, ...(blockedReason === undefined ? {} : { blockedReason }) };
}

export function reviewActions(input: {
  readonly agent: CloudAgent;
  readonly allocation: RunAllocation;
  readonly publication: CloudPublicationInspection;
}): ReadonlyArray<CloudAgentReviewActionAvailability> {
  // A requested delete is irreversible once retention starts erasing, so it
  // blocks every other action rather than racing them.
  const deleting = input.allocation.deletion !== undefined;
  const busy =
    deleting ||
    input.agent.status === "ACTIVE" ||
    input.allocation.agentOutcome.status === "running" ||
    input.allocation.idleState.status === "waking";
  const archived = input.agent.status === "ARCHIVED";
  const canWake =
    !archived &&
    !busy &&
    (input.allocation.idleState.status === "hibernated" ||
      input.allocation.idleState.status === "idle" ||
      input.allocation.cleanupState.status === "succeeded");
  const hasPr =
    input.publication.status === "present" && input.publication.outcome.status === "published";
  return [
    action(
      "archive",
      !archived && !busy,
      deleting
        ? "This agent is being permanently deleted."
        : busy
          ? "An active run must finish or be cancelled first."
          : "Already archived.",
    ),
    action("unarchive", archived && !deleting, "The agent is not archived."),
    action(
      "cancel",
      !deleting &&
        input.allocation.cleanupState.status === "not-requested" &&
        input.allocation.agentOutcome.status !== "cancelled" &&
        input.allocation.agentOutcome.status !== "expired" &&
        (busy || input.allocation.agentOutcome.status === "not-started"),
      "There is no in-flight run to cancel.",
    ),
    action(
      "wake",
      canWake && input.allocation.idleState.status === "hibernated",
      input.allocation.idleState.status === "idle"
        ? "The guest is still idle and does not need a snapshot restore."
        : archived
          ? "Unarchive the agent before waking it."
          : busy
            ? "The agent already has an active run."
            : "No hibernated snapshot is available to restore.",
    ),
    action(
      "delete",
      !busy,
      deleting
        ? "A permanent delete is already in progress."
        : "Cancel or wait for the active run before permanently deleting.",
    ),
    action("delete-pr", hasPr && !deleting, "There is no published pull request to delete."),
  ];
}

export function assembleCloudAgentReview(input: {
  readonly agent: CloudAgent;
  readonly allocation: RunAllocation;
  readonly runs: ReadonlyArray<CloudRun>;
  readonly snapshot: CloudAllocationSnapshot;
  readonly publication: CloudRunPublicationRecord | undefined;
  readonly grant: CloudArtifactAccessGrant | undefined;
  readonly diff: string | undefined;
  readonly verification: string | undefined;
  readonly transcript: string | undefined;
  readonly resultExpired: boolean;
}): CloudAgentReview {
  const session = inspectSessionAvailability(input.allocation);
  const latestRunId =
    input.agent.status === "ACTIVE"
      ? input.agent.activeRunId
      : input.agent.conversation.runIds[input.agent.conversation.runIds.length - 1];
  const latestRun = input.runs.find((run) => run.id === latestRunId) ?? input.runs.at(-1);
  if (latestRun === undefined) {
    throw new Error("A cloud agent review requires at least one run");
  }
  const usage = input.snapshot.usage.find((entry) => entry.allocationId === input.allocation.id);
  const environment =
    input.allocation.environment === undefined
      ? undefined
      : input.snapshot.environments?.find(
          (candidate) => candidate.id === input.allocation.environment?.environmentId,
        );
  return {
    agent: input.agent,
    agentStatus: input.agent.status,
    latestRun,
    runs: input.runs.map((run) => ({ run, terminalStatus: run.status })),
    allocationId: input.allocation.id,
    previewAvailability: session.preview,
    terminalAvailability: session.terminal,
    previewState: input.allocation.previewState,
    idleState: input.allocation.idleState,
    ...(usage === undefined ? {} : { usage }),
    ...(environment === undefined ? {} : { environment }),
    ...(input.allocation.environment === undefined
      ? {}
      : { environmentReference: input.allocation.environment }),
    build: inspectBuild(input.allocation, input.snapshot.builds ?? []),
    snapshot: inspectRuntimeSnapshot(input.allocation),
    diff: inspectRetainedText({
      value: input.diff,
      missingReason: input.resultExpired
        ? "The retained diff has expired."
        : "No retained diff is available.",
    }),
    verification: inspectRetainedText({
      value: input.verification,
      missingReason: input.resultExpired
        ? "The retained verification log has expired."
        : "No retained verification log is available.",
    }),
    transcript: inspectRetainedText({
      value: input.transcript,
      missingReason: input.resultExpired
        ? "The retained transcript has expired."
        : "No retained transcript is available.",
    }),
    artifacts: inspectArtifacts(input.grant, input.resultExpired),
    publication: inspectPublication(input.publication),
    pagePath: `${CLOUD_AGENT_REVIEW_PAGE_PREFIX}${input.agent.id}`,
    reviewWakesRuntime: false,
    actions: reviewActions({
      agent: input.agent,
      allocation: input.allocation,
      publication: inspectPublication(input.publication),
    }),
  };
}
