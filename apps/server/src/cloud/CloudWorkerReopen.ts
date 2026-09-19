/**
 * Guest-side reopen. Waking a hibernated guest brings its disk back; it does
 * not bring the app back, because the environment's `start` is a per-boot
 * process that the stop killed. This runs it again, reports honestly whether
 * the browser came back logged in, and takes the baseline that the person's
 * own edits are later diffed against.
 *
 * Nothing here submits a turn, and nothing here talks to a remote: a reopened
 * preview is for looking and touching, not for rewriting a published branch.
 */
import {
  CheckpointRef,
  type CloudBrowserPersistence,
  type CloudRuntimeReopen,
  type CloudRuntimeReopenInput,
  type CloudSessionEdits,
  type CloudSessionEditsInput,
  cloudEnvironmentRuntimeServices,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as CloudEnvironmentRuntimeBoot from "./CloudEnvironmentRuntimeBoot.ts";

/** The baseline a reopened session is diffed against, one per runtime attempt. */
export function cloudSessionBaseRef(input: {
  readonly allocationId: string;
  readonly attempt: number;
}): CheckpointRef {
  return CheckpointRef.make(`refs/t3/cloud-session/${input.allocationId}/${input.attempt}/base`);
}

/** Where a reopened session's hand edits are captured. Never pushed anywhere. */
export function cloudSessionEditsRef(input: {
  readonly allocationId: string;
  readonly attempt: number;
}): CheckpointRef {
  return CheckpointRef.make(`refs/t3/cloud-session/${input.allocationId}/${input.attempt}/edits`);
}

/**
 * Whether a reopened browser comes back with the person still logged in. A
 * fresh profile is a real answer and has to be said out loud: a preview that
 * silently lost its session looks like a broken app. A profile that did
 * persist holds live cookies, so it stays on the guest disk and is never part
 * of a retained result.
 */
export function inspectBrowserPersistence(environment: {
  readonly [key: string]: string | undefined;
}): CloudBrowserPersistence {
  const profile = environment.T3_CLOUD_BROWSER_PROFILE ?? environment.CHROME_USER_DATA_DIR;
  if (profile === undefined || profile.trim().length === 0) {
    return {
      status: "fresh",
      reason:
        "This runtime declares no browser profile directory, so a reopened browser starts logged out.",
    };
  }
  const normalized = profile.replaceAll("\\", "/");
  if (normalized.startsWith("/run/") || normalized.startsWith("/tmp/")) {
    return {
      status: "fresh",
      reason: `The browser profile at ${profile} is in a runtime directory that a stop clears, so logins did not survive.`,
    };
  }
  return {
    status: "persisted",
    profilePath: profile,
    detail: `The browser profile at ${profile} was restored with the guest disk. It holds live session cookies and stays on the guest.`,
  };
}

const workspaceRoot = Effect.fn("CloudWorkerReopen.workspaceRoot")(function* (
  query: ProjectionSnapshotQuery["Service"],
  threadId: string,
) {
  const readModel = yield* query.getCommandReadModel();
  const thread = readModel.threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) return undefined;
  const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
  if (project === undefined) return undefined;
  return thread.worktreePath ?? project.workspaceRoot;
});

interface SessionDeps {
  readonly runtime: CloudEnvironmentRuntimeBoot.CloudEnvironmentRuntimeBoot["Service"];
  readonly environment: { readonly [key: string]: string | undefined };
}

/**
 * Runs the environment's per-boot services for a reopened guest. They outlive
 * the request that asked for them, so they start in the scope the caller owns
 * and stop when the caller closes it.
 */
export const reopenCloudRuntime = Effect.fn("CloudWorkerReopen.reopenCloudRuntime")(function* (
  deps: SessionDeps,
  input: CloudRuntimeReopenInput,
): Effect.fn.Return<
  CloudRuntimeReopen,
  CloudEnvironmentRuntimeBoot.CloudEnvironmentRuntimeBootError,
  Scope.Scope | ProjectionSnapshotQuery | CheckpointStore.CheckpointStore
> {
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const query = yield* ProjectionSnapshotQuery;
  const occurredAt = DateTime.formatIso(yield* DateTime.now);
  const cwd = yield* workspaceRoot(query, input.threadId).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not resolve the workspace to reopen.", { cause }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

  const environmentStart =
    cwd === undefined || cloudEnvironmentRuntimeServices(input.version.config).length === 0
      ? { services: [] }
      : yield* deps.runtime.boot({ version: input.version, cwd, occurredAt });

  // The baseline is taken before anyone can touch the workspace, so the diff
  // at stop time is exactly what the person changed and nothing the run left.
  const baseRef =
    cwd === undefined
      ? undefined
      : yield* Effect.gen(function* () {
          if (!(yield* checkpoints.isGitRepository(cwd))) return undefined;
          const ref = cloudSessionBaseRef(input);
          yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });
          return ref;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not take a reopen baseline checkpoint.", { cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        );

  return {
    environmentStart,
    browser: inspectBrowserPersistence(deps.environment),
    ...(baseRef === undefined ? {} : { baseRef }),
    reopenedAt: occurredAt,
    providerRunStarted: false,
  };
});

/**
 * Captures what a person changed by hand. It writes a checkpoint and a diff on
 * the guest and stops there: the branch and pull request the run published are
 * left exactly as the run left them.
 */
export const captureCloudSessionEdits = Effect.fn("CloudWorkerReopen.captureCloudSessionEdits")(
  function* (
    input: CloudSessionEditsInput,
  ): Effect.fn.Return<
    CloudSessionEdits,
    never,
    ProjectionSnapshotQuery | CheckpointStore.CheckpointStore
  > {
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const query = yield* ProjectionSnapshotQuery;
    const capturedAt = DateTime.formatIso(yield* DateTime.now);
    const baseRef = cloudSessionBaseRef(input);
    const editsRef = cloudSessionEditsRef(input);
    return yield* Effect.gen(function* () {
      const cwd = yield* workspaceRoot(query, input.threadId);
      if (cwd === undefined) {
        return {
          status: "unavailable",
          reason: `Thread '${input.threadId}' has no workspace on this runtime.`,
        } satisfies CloudSessionEdits;
      }
      if (!(yield* checkpoints.isGitRepository(cwd))) {
        return {
          status: "unavailable",
          reason: `The workspace at ${cwd} is not a Git repository, so hand edits cannot be captured.`,
        } satisfies CloudSessionEdits;
      }
      if (!(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef: baseRef }))) {
        return {
          status: "unavailable",
          reason: "This session has no baseline checkpoint to compare against.",
        } satisfies CloudSessionEdits;
      }
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: editsRef });
      const numstat = yield* checkpoints.diffCheckpoints({
        cwd,
        fromCheckpointRef: baseRef,
        toCheckpointRef: editsRef,
        ignoreWhitespace: false,
        format: "numstat",
      });
      // Numstat is NUL-delimited, so it has no lines to count.
      const changedFiles = parseTurnDiffFilesFromNumstat(numstat).length;
      if (changedFiles === 0) {
        return { status: "unchanged", capturedAt } satisfies CloudSessionEdits;
      }
      const patch = yield* checkpoints.diffCheckpoints({
        cwd,
        fromCheckpointRef: baseRef,
        toCheckpointRef: editsRef,
        ignoreWhitespace: false,
      });
      return {
        status: "captured",
        baseRef,
        editsRef,
        changedFiles,
        diffSizeChars: patch.length,
        capturedAt,
        publicationRewritten: false,
      } satisfies CloudSessionEdits;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not capture reopened-session edits.", { cause }).pipe(
          Effect.as({
            status: "unavailable",
            reason: "Capturing the hand edits failed on this runtime.",
          } satisfies CloudSessionEdits),
        ),
      ),
    );
  },
);

/**
 * Owns the processes a reopened session started. They have to outlive the
 * request that started them and die with the session, so exactly one scope is
 * kept per guest: reopening again replaces it, and the guest shutting down
 * closes it.
 */
export class CloudWorkerSession extends Context.Service<
  CloudWorkerSession,
  {
    /**
     * Resolves the guest's own workspace services from the caller's context
     * rather than holding them, so the session layer stays a scope owner and
     * nothing here has to be rebuilt to serve one request.
     */
    readonly reopen: (
      input: CloudRuntimeReopenInput,
    ) => Effect.Effect<
      CloudRuntimeReopen,
      CloudEnvironmentRuntimeBoot.CloudEnvironmentRuntimeBootError,
      ProjectionSnapshotQuery | CheckpointStore.CheckpointStore
    >;
  }
>()("t3/cloud/CloudWorkerReopen/CloudWorkerSession") {}

export const make = Effect.fn("CloudWorkerReopen.make")(function* () {
  const deps: SessionDeps = {
    runtime: yield* CloudEnvironmentRuntimeBoot.CloudEnvironmentRuntimeBoot,
    environment: yield* HostProcessEnvironment,
  };
  const open = yield* Ref.make<Scope.Closeable | undefined>(undefined);

  const closeCurrent = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(open, undefined);
    if (current !== undefined) yield* Scope.close(current, Exit.void);
  });
  yield* Effect.addFinalizer(() => closeCurrent);

  const reopen: CloudWorkerSession["Service"]["reopen"] = Effect.fn("CloudWorkerReopen.reopen")(
    function* (input) {
      yield* closeCurrent;
      const scope = yield* Scope.make();
      const record = yield* reopenCloudRuntime(deps, input).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      yield* Ref.set(open, scope);
      return record;
    },
  );

  return CloudWorkerSession.of({ reopen });
});

export const layer = Layer.effect(CloudWorkerSession, make());
