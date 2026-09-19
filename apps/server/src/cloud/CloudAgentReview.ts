// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CLOUD_AGENT_REVIEW_SHARE_PREFIX,
  CLOUD_REVIEW_DIFF_PREVIEW_CHARS,
  CloudAgentReviewError,
  CloudAllocationControllerError,
  RunAllocationAttempt,
  type CloudAgentId,
  type CloudAgentReview,
  type CloudAgentReviewActInput,
  type CloudAgentReviewInspectInput,
  type CloudAgentReviewLeaseInput,
  type CloudAgentReviewShareGrant,
  type CloudAgentReviewShareInput,
  type CloudArtifactAccessGrant,
  type CloudRunPublicationRecord,
  type RunAllocation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudArtifactAccess from "./CloudArtifactAccess.ts";
import * as CloudRunPublication from "./CloudRunPublication.ts";
import * as CloudRunResults from "./CloudRunResults.ts";
import { assembleCloudAgentReview } from "./cloudAgentReviewModel.ts";
import { openedLeaseDeadlines } from "./cloudPreviewLeasePolicy.ts";

const SHARE_TTL_MILLIS = 5 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class CloudAgentReviewService extends Context.Service<
  CloudAgentReviewService,
  {
    readonly inspect: (
      input: CloudAgentReviewInspectInput,
    ) => Effect.Effect<CloudAgentReview, CloudAgentReviewError>;
    readonly act: (
      input: CloudAgentReviewActInput,
    ) => Effect.Effect<CloudAgentReview, CloudAgentReviewError>;
    /** Opens, renews, or releases one viewing session on the agent's runtime. */
    readonly lease: (
      input: CloudAgentReviewLeaseInput,
    ) => Effect.Effect<CloudAgentReview, CloudAgentReviewError>;
    readonly share: (
      input: CloudAgentReviewShareInput,
    ) => Effect.Effect<CloudAgentReviewShareGrant, CloudAgentReviewError>;
    readonly resolveShare: (token: string) => Effect.Effect<CloudAgentId | null>;
  }
>()("t3/cloud/CloudAgentReview/CloudAgentReviewService") {}

function reviewError(
  reason: CloudAgentReviewError["reason"],
  message: string,
): CloudAgentReviewError {
  return new CloudAgentReviewError({ reason, message });
}

interface ShareGrant {
  readonly agentId: CloudAgentId;
  readonly expiresAtMillis: number;
}

const isCloudAgentReviewError = Schema.is(CloudAgentReviewError);
const isCloudAllocationControllerError = Schema.is(CloudAllocationControllerError);

function mapControllerError(error: unknown): CloudAgentReviewError {
  if (isCloudAgentReviewError(error)) return error;
  if (isCloudAllocationControllerError(error)) {
    if (error.reason === "agent_busy") {
      return reviewError("agent_busy", error.message);
    }
    if (error.reason === "agent-archived") {
      return reviewError("agent-archived", error.message);
    }
    if (error.reason === "agent-deleted") {
      return reviewError("agent-deleted", error.message);
    }
    return reviewError("controller-failed", error.message);
  }
  return reviewError("controller-failed", "The controller refused the review action.");
}

export const make = Effect.fn("CloudAgentReview.make")(function* () {
  const allocations = yield* CloudAllocationController.CloudAllocationController;
  const results = yield* CloudRunResults.CloudRunResults;
  const artifacts = yield* CloudArtifactAccess.CloudArtifactAccess;
  const publication = yield* CloudRunPublication.CloudRunPublication;
  const shares = yield* Ref.make<ReadonlyMap<string, ShareGrant>>(new Map());

  const purgeShares = Effect.fn("CloudAgentReview.purgeShares")(function* () {
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Ref.update(shares, (current) => {
      const live = [...current].filter(([, grant]) => grant.expiresAtMillis > nowMillis);
      return live.length === current.size ? current : new Map(live);
    });
  });
  yield* Effect.forkScoped(purgeShares().pipe(Effect.repeat(Schedule.spaced("30 seconds"))));

  const locate = Effect.fn("CloudAgentReview.locate")(function* (agentId: CloudAgentId) {
    const snapshot = yield* allocations.snapshot.pipe(
      Effect.mapError(() =>
        reviewError("controller-failed", "The cloud allocation catalog is unavailable."),
      ),
    );
    const agent = snapshot.agents?.find((candidate) => candidate.id === agentId);
    if (agent === undefined) {
      return yield* reviewError("agent-not-found", `Cloud agent '${agentId}' was not found.`);
    }
    const allocation = snapshot.allocations.find(
      (candidate) => candidate.id === agent.allocationId,
    );
    if (allocation === undefined) {
      return yield* reviewError(
        "agent-not-found",
        `Cloud agent '${agentId}' has no allocation record.`,
      );
    }
    const runs = (snapshot.runs ?? []).filter((run) => run.agentId === agentId);
    return { snapshot, agent, allocation, runs };
  });

  const loadReview = Effect.fn("CloudAgentReview.load")(function* (
    allocation: RunAllocation,
    agentId: CloudAgentId,
  ) {
    const located = yield* locate(agentId);
    const resultId = CloudRunResults.cloudResultIdFor(allocation.id, allocation.attempt);
    const status = yield* results.status(resultId).pipe(Effect.option);
    const retained =
      Option.isSome(status) && status.value.status === "retained" ? status.value : undefined;
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const expired = retained !== undefined && Date.parse(retained.manifest.expiresAt) <= nowMillis;
    const missingResult = retained === undefined || expired;
    const texts = missingResult
      ? ([undefined, undefined, undefined] as const)
      : yield* Effect.all(
          [
            results
              .readTextPrefix(resultId, "diff", CLOUD_REVIEW_DIFF_PREVIEW_CHARS)
              .pipe(Effect.option),
            results
              .readTextPrefix(resultId, "verification", CLOUD_REVIEW_DIFF_PREVIEW_CHARS)
              .pipe(Effect.option),
            results
              .readTextPrefix(resultId, "transcript", CLOUD_REVIEW_DIFF_PREVIEW_CHARS)
              .pipe(Effect.option),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(([diff, verification, transcript]) => {
            const preview = (value: typeof diff) => {
              if (Option.isNone(value)) return undefined;
              if (value.value.truncated) {
                return `${value.value.text.slice(0, CLOUD_REVIEW_DIFF_PREVIEW_CHARS)}x`;
              }
              return value.value.text;
            };
            return [preview(diff), preview(verification), preview(transcript)] as const;
          }),
        );
    const grant: CloudArtifactAccessGrant | undefined = missingResult
      ? undefined
      : Option.getOrUndefined(yield* artifacts.grant({ resultId }).pipe(Effect.option));
    const publicationRecord: CloudRunPublicationRecord | undefined = Option.getOrUndefined(
      yield* publication.status(allocation.id, allocation.attempt).pipe(Effect.option),
    );
    const settled =
      allocation.agentOutcome.status !== "not-started" &&
      allocation.agentOutcome.status !== "running";
    return assembleCloudAgentReview({
      agent: located.agent,
      allocation: located.allocation,
      runs: located.runs,
      snapshot: located.snapshot,
      publication: publicationRecord,
      grant,
      diff: texts[0],
      verification: texts[1],
      transcript: texts[2],
      resultExpired: expired || (Option.isNone(status) && settled),
    });
  });

  const inspect = Effect.fn("CloudAgentReview.inspect")(function* (
    input: CloudAgentReviewInspectInput,
  ) {
    const located = yield* locate(input.agentId);
    return yield* loadReview(located.allocation, input.agentId);
  });

  const dispatch = (
    allocation: RunAllocation,
    type:
      | "allocation.cancel"
      | "allocation.agent-archive"
      | "allocation.agent-unarchive"
      | "allocation.agent-delete",
    commandId: CloudAgentReviewActInput["commandId"],
    occurredAt: string,
  ) =>
    allocations
      .dispatch({
        type,
        commandId,
        allocationId: allocation.id,
        attempt: allocation.attempt,
        occurredAt,
      })
      .pipe(Effect.mapError(mapControllerError));

  const act = Effect.fn("CloudAgentReview.act")(function* (input: CloudAgentReviewActInput) {
    const located = yield* locate(input.agentId);
    const { allocation, agent } = located;
    switch (input.action) {
      case "archive":
        yield* dispatch(allocation, "allocation.agent-archive", input.commandId, input.occurredAt);
        break;
      case "unarchive":
        yield* dispatch(
          allocation,
          "allocation.agent-unarchive",
          input.commandId,
          input.occurredAt,
        );
        break;
      case "cancel":
        yield* dispatch(allocation, "allocation.cancel", input.commandId, input.occurredAt);
        break;
      case "delete": {
        if (agent.status === "ACTIVE") {
          return yield* reviewError(
            "agent_busy",
            `Cloud agent '${agent.id}' still has an active run.`,
          );
        }
        // Review only records the intent. Retention releases the compute claim
        // and erases the retained files, so the page never deletes data a live
        // guest still owns.
        yield* dispatch(allocation, "allocation.agent-delete", input.commandId, input.occurredAt);
        return yield* reviewError(
          "agent-deleted",
          `Cloud agent '${agent.id}' is being permanently deleted.`,
        );
      }
      case "delete-pr":
        yield* publication
          .deletePullRequest(allocation.id, allocation.attempt)
          .pipe(
            Effect.mapError((error) =>
              error.reason === "publication-not-found" || error.reason === "pr-not-published"
                ? reviewError("publication-not-found", error.message)
                : reviewError("github-failed", error.message),
            ),
          );
        break;
      /**
       * Reopen restores the snapshot and runs the environment's `start`. It
       * deliberately does not submit a turn: looking at the app again is not a
       * reason to spend a provider run, and a synthetic prompt would put a run
       * the person never asked for into their history.
       */
      case "reopen": {
        if (agent.status === "ARCHIVED") {
          return yield* reviewError(
            "agent-archived",
            `Unarchive cloud agent '${agent.id}' before reopening it.`,
          );
        }
        if (agent.status === "ACTIVE") {
          return yield* reviewError(
            "agent_busy",
            `Cloud agent '${agent.id}' already has an active run.`,
          );
        }
        if (
          allocation.idleState.status !== "hibernated" &&
          allocation.cleanupState.status !== "succeeded"
        ) {
          return yield* reviewError(
            "snapshot-unavailable",
            allocation.idleState.status === "idle"
              ? "The guest is still running. Open a preview lease instead of reopening it."
              : "No hibernated snapshot is available to reopen.",
          );
        }
        yield* allocations
          .dispatch({
            type: "allocation.reopen",
            commandId: input.commandId,
            allocationId: allocation.id,
            attempt: allocation.attempt,
            occurredAt: input.occurredAt,
            nextAttempt: RunAllocationAttempt.make(allocation.attempt + 1),
            deadlines: allocation.deadlines,
          })
          .pipe(Effect.mapError(mapControllerError));
        break;
      }
      case "stop":
        yield* allocations
          .dispatch({
            type: "allocation.session-stop",
            commandId: input.commandId,
            allocationId: allocation.id,
            attempt: allocation.attempt,
            occurredAt: input.occurredAt,
          })
          .pipe(Effect.mapError(mapControllerError));
        break;
      default: {
        const _never: never = input.action;
        return _never;
      }
    }
    const next = yield* locate(input.agentId);
    return yield* loadReview(next.allocation, input.agentId);
  });

  const lease = Effect.fn("CloudAgentReview.lease")(function* (input: CloudAgentReviewLeaseInput) {
    const located = yield* locate(input.agentId);
    const { allocation } = located;
    const limits = located.snapshot.limits;
    if (input.operation === "open" && allocation.allocationState.status !== "ready") {
      return yield* reviewError(
        "lease-unavailable",
        "This agent has no running runtime to open a session on. Reopen it first.",
      );
    }
    const command =
      input.operation === "release"
        ? ({
            type: "allocation.session-lease-release",
            kind: input.kind,
            reason: "The person closed this session.",
          } as const)
        : input.operation === "open"
          ? ({
              type: "allocation.session-lease-open",
              kind: input.kind,
              ...openedLeaseDeadlines({
                openedAt: input.occurredAt,
                leaseSeconds: limits.previewLeaseSeconds,
                maxLeaseSeconds: limits.previewLeaseMaxSeconds,
              }),
            } as const)
          : ({
              type: "allocation.session-lease-renew",
              kind: input.kind,
              expiresAt: openedLeaseDeadlines({
                openedAt: input.occurredAt,
                leaseSeconds: limits.previewLeaseSeconds,
                maxLeaseSeconds: limits.previewLeaseMaxSeconds,
              }).expiresAt,
            } as const);
    yield* allocations
      .dispatch({
        ...command,
        commandId: input.commandId,
        allocationId: allocation.id,
        attempt: allocation.attempt,
        occurredAt: input.occurredAt,
      })
      .pipe(Effect.mapError(mapControllerError));
    const next = yield* locate(input.agentId);
    return yield* loadReview(next.allocation, input.agentId);
  });

  const share = Effect.fn("CloudAgentReview.share")(function* (input: CloudAgentReviewShareInput) {
    yield* locate(input.agentId);
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    if (!TOKEN_PATTERN.test(token)) {
      return yield* reviewError("controller-failed", "The review share token was malformed.");
    }
    const expiresAtMillis = nowMillis + SHARE_TTL_MILLIS;
    yield* Ref.update(shares, (current) => {
      const next = new Map([...current].filter(([, grant]) => grant.expiresAtMillis > nowMillis));
      next.set(token, { agentId: input.agentId, expiresAtMillis });
      return next;
    });
    return {
      agentId: input.agentId,
      token,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMillis)),
      url: `${CLOUD_AGENT_REVIEW_SHARE_PREFIX}${token}`,
    };
  });

  const resolveShare = Effect.fn("CloudAgentReview.resolveShare")(function* (token: string) {
    if (!TOKEN_PATTERN.test(token)) return null;
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const found = (yield* Ref.get(shares)).get(token);
    return found === undefined || found.expiresAtMillis <= nowMillis ? null : found.agentId;
  });

  return CloudAgentReviewService.of({ inspect, act, lease, share, resolveShare });
});

export const layer = Layer.effect(CloudAgentReviewService, make());
