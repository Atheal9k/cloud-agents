/**
 * Retention, archive, and permanent deletion for cloud agents.
 *
 * The sweep only ever records intent and erases retained storage. Terminating
 * guests stays with `CloudAllocationReconciler`, so there is exactly one thing
 * in the system that talks to the worker provider and a collection pass can
 * never reach a running guest.
 */
import { RunAllocationCommand, type RunAllocation } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import {
  isConversationRetentionExpired,
  isDeletionPurgeReady,
  isSnapshotRetentionExpired,
} from "./cloudRetentionPolicy.ts";
import * as CloudRunResults from "./CloudRunResults.ts";

const decodeCommand = Schema.decodeUnknownEffect(RunAllocationCommand);

/** Stable per action and attempt, so a repeated sweep is a no-op. */
function commandId(allocation: RunAllocation, action: string): string {
  return ["ca46", allocation.id, allocation.attempt, action].join(":");
}

/** Every attempt an allocation has retained a result under. */
function attemptsOf(allocation: RunAllocation): ReadonlyArray<number> {
  return Array.from({ length: allocation.attempt }, (_, index) => index + 1);
}

export const make = Effect.fn("CloudAgentRetention.make")(function* () {
  const controller = yield* CloudAllocationController.CloudAllocationController;
  const results = yield* CloudRunResults.CloudRunResults;

  const dispatch = Effect.fn("CloudAgentRetention.dispatch")(function* (
    allocation: RunAllocation,
    occurredAt: string,
    type: "allocation.snapshot-expire" | "allocation.agent-delete",
    action: string,
  ) {
    const command = yield* decodeCommand({
      type,
      commandId: commandId(allocation, action),
      allocationId: allocation.id,
      attempt: allocation.attempt,
      occurredAt,
    });
    return yield* controller.dispatch(command);
  });

  /**
   * Erasure runs after the compute claim is gone, and the tombstone is written
   * after the files are. A crash in between leaves a delete still requested,
   * and the next sweep repeats a purge that has nothing left to remove.
   */
  const purge = Effect.fn("CloudAgentRetention.purge")(function* (
    allocation: RunAllocation,
    occurredAt: string,
  ) {
    const purgedResultIds = yield* results.purgeAllocation({
      allocationId: allocation.id,
      attempts: attemptsOf(allocation),
    });
    const deletion = yield* controller.purgeAllocation({
      allocationId: allocation.id,
      deletedAt: occurredAt,
      purgedResultIds,
    });
    yield* Effect.logInfo("Cloud agent transcript and artifacts erased.", {
      allocationId: deletion.allocationId,
      agentId: deletion.agentId,
      purgedResults: deletion.purgedResultIds.length,
      // An immutable disk snapshot is removed by retention expiry, not by this
      // delete, and the record says so rather than implying otherwise.
      snapshots: deletion.snapshots,
    });
    return deletion;
  });

  const sweepOnce = Effect.fn("CloudAgentRetention.sweepOnce")(function* () {
    const snapshot = yield* controller.snapshot;
    // A fenced controller has handed its state to another host. Collecting
    // from here would erase data the live controller still owns.
    if (snapshot.controller.writability?.status === "fenced") return;
    const occurredAt = DateTime.formatIso(yield* DateTime.now);

    for (const allocation of snapshot.allocations) {
      if (isDeletionPurgeReady(allocation)) {
        yield* purge(allocation, occurredAt);
        continue;
      }
      if (isSnapshotRetentionExpired({ allocation, now: occurredAt })) {
        yield* dispatch(
          allocation,
          occurredAt,
          "allocation.snapshot-expire",
          "snapshot-retention-expired",
        );
        yield* Effect.logInfo("Cloud agent snapshot passed its inactivity retention.", {
          allocationId: allocation.id,
          attempt: allocation.attempt,
          lastActiveAt: allocation.snapshotRetention?.lastActiveAt,
        });
        continue;
      }
      if (
        isConversationRetentionExpired({
          allocation,
          retentionDays: snapshot.limits.conversationRetentionDays,
          now: occurredAt,
        })
      ) {
        yield* dispatch(
          allocation,
          occurredAt,
          "allocation.agent-delete",
          "conversation-retention-expired",
        );
        yield* Effect.logInfo("Cloud conversation passed the administrative retention cap.", {
          allocationId: allocation.id,
          retentionDays: snapshot.limits.conversationRetentionDays,
        });
      }
    }

    const expired = yield* results.purgeExpired;
    if (expired.length > 0) {
      yield* Effect.logInfo("Expired cloud results removed by their declared policy.", {
        purgedResults: expired.length,
      });
    }
  });

  return { sweepOnce } as const;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (config.cloudControllerEnabled !== true) return;
    const retention = yield* make();
    yield* retention.sweepOnce().pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Cloud agent retention sweep failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced("5 minutes")),
      Effect.forkScoped,
    );
  }),
);
