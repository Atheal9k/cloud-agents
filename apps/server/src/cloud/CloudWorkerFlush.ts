/**
 * Guest-side flush. When a turn settles the controller releases the guest on a
 * timer, so everything the conversation needs has to be on durable storage
 * before that timer starts rather than at the moment the guest is stopped.
 *
 * Each component is reported separately, and `unavailable` is a real answer: a
 * provider home on a runtime tmpfs cannot be made to survive a stop, and saying
 * so here is what lets the wake report say honestly that the filesystem came
 * back while the provider's native session did not.
 */
import {
  CheckpointRef,
  type RunRuntimeFlushComponent,
  type RunRuntimeFlushInput,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/** The ref a flushed workspace is captured at, one per runtime attempt. */
export function cloudIdleCheckpointRef(input: {
  readonly allocationId: string;
  readonly attempt: number;
}): CheckpointRef {
  return CheckpointRef.make(`refs/t3/cloud-idle/${input.allocationId}/${input.attempt}`);
}

function unavailable(reason: string): RunRuntimeFlushComponent {
  return { status: "unavailable", reason };
}

function flushed(detail: string): RunRuntimeFlushComponent {
  return { status: "flushed", detail };
}

/**
 * A runtime directory is wiped when the guest stops, so anything inside one is
 * reported as lost rather than flushed.
 */
function isRuntimeDirectory(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("/run/") || normalized.startsWith("/tmp/");
}

const flushUserdata = Effect.fn("CloudWorkerFlush.flushUserdata")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // TRUNCATE moves every committed page into the database file and empties the
  // write-ahead log, so the file alone is the whole state after a stop.
  const rows = yield* sql<{
    readonly busy: number;
    readonly log: number;
    readonly checkpointed: number;
  }>`PRAGMA wal_checkpoint(TRUNCATE)`;
  const row = rows[0];
  if (row === undefined) return flushed("Truncated the T3 database write-ahead log.");
  return row.busy === 0
    ? flushed(
        `Truncated the T3 database write-ahead log, moving ${row.checkpointed} of ${row.log} pages.`,
      )
    : unavailable("A writer held the T3 database open, so its write-ahead log was not truncated.");
});

const flushWorkspace = Effect.fn("CloudWorkerFlush.flushWorkspace")(function* (
  input: RunRuntimeFlushInput,
) {
  const query = yield* ProjectionSnapshotQuery;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const readModel = yield* query.getCommandReadModel();
  const thread = readModel.threads.find((candidate) => candidate.id === input.threadId);
  if (thread === undefined) {
    return unavailable(`Thread '${input.threadId}' is not present on this runtime.`);
  }
  const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
  if (project === undefined) {
    return unavailable(`Thread '${input.threadId}' has no project workspace on this runtime.`);
  }
  const cwd = thread.worktreePath ?? project.workspaceRoot;
  const isRepository = yield* checkpoints.isGitRepository(cwd);
  if (!isRepository) {
    return unavailable(
      `The workspace at ${cwd} is not a Git repository, so it cannot be captured.`,
    );
  }
  const checkpointRef = cloudIdleCheckpointRef(input);
  yield* checkpoints.captureCheckpoint({ cwd, checkpointRef });
  return flushed(`Captured the workspace at ${cwd} as ${checkpointRef}.`);
});

const flushProviderHome = Effect.fn("CloudWorkerFlush.flushProviderHome")(function* () {
  const environment = yield* HostProcessEnvironment;
  const homes = [environment.CODEX_HOME, environment.CLAUDE_CONFIG_DIR].filter(
    (value): value is string => value !== undefined && value.trim().length > 0,
  );
  if (homes.length === 0) {
    return unavailable("This runtime declares no provider home to flush.");
  }
  const runtimeHomes = homes.filter(isRuntimeDirectory);
  return runtimeHomes.length === 0
    ? flushed(`Provider homes are on durable storage: ${homes.join(", ")}.`)
    : unavailable(
        `Provider homes live in runtime directories that a stop clears: ${runtimeHomes.join(", ")}.`,
      );
});

/** Never fails: a component that could not be flushed is reported, not thrown. */
export const flushCloudRuntimeState = Effect.fn("CloudWorkerFlush.flushCloudRuntimeState")(
  function* (input: RunRuntimeFlushInput) {
    const [userdata, workspace, providerHome, now] = yield* Effect.all([
      flushUserdata().pipe(Effect.catchCause(reportFailure("the T3 database"))),
      flushWorkspace(input).pipe(Effect.catchCause(reportFailure("the workspace"))),
      flushProviderHome().pipe(Effect.catchCause(reportFailure("the provider home"))),
      DateTime.now,
    ]);
    const simulator =
      process.platform === "darwin"
        ? unavailable(
            "The iOS Simulator process is not restorable across hibernation. Wake creates a new reserved UDID.",
          )
        : undefined;
    const xcodeCache =
      process.platform === "darwin"
        ? unavailable(
            "Xcode caches stay on the Mac image and environment Build, not in the job snapshot.",
          )
        : undefined;
    return {
      userdata,
      workspace,
      providerHome,
      ...(simulator === undefined ? {} : { simulator }),
      ...(xcodeCache === undefined ? {} : { xcodeCache }),
      flushedAt: DateTime.formatIso(now),
    };
  },
);

function reportFailure(subject: string) {
  return (cause: unknown) =>
    Effect.logWarning("A cloud runtime flush component failed.", { subject, cause }).pipe(
      Effect.as(unavailable(`Flushing ${subject} failed on this runtime.`)),
    );
}
