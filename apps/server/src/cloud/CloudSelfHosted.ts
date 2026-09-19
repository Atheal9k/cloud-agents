import {
  CloudSelfHostedConnectWorkerRequest,
  CloudSelfHostedRegisterPoolRequest,
  type CloudAgentsApiPrincipal,
  type CloudSelfHostedLaunchPreview,
  type CloudSelfHostedPendingRequest,
  type CloudSelfHostedPolicyMode,
  type CloudSelfHostedPool,
  type CloudSelfHostedWatchEvent,
  type CloudSelfHostedWorker,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  claimSelfHostedRequest,
  connectSelfHostedWorker,
  disconnectSelfHostedWorker,
  emptySelfHostedState,
  enqueueSelfHostedRequest,
  expireUnclaimedRequest,
  idleReleaseSelfHostedWorker,
  listSelfHostedPending,
  listSelfHostedPools,
  listSelfHostedWorkers,
  registerSelfHostedPool,
  deregisterSelfHostedPool,
  releaseSelfHostedClaim,
  selfHostedLaunchPreview,
  setSelfHostedPolicy,
  selfHostedWorkerSummary,
  watchSelfHostedPending,
  workerManagementBody,
  CloudSelfHostedFailure,
  type CloudSelfHostedState,
} from "./cloudSelfHostedPolicy.ts";

const StateJson = Schema.fromJsonString(Schema.Unknown);
const encodeState = Schema.encodeSync(StateJson);
const decodeState = Schema.decodeUnknownSync(StateJson);

export class CloudSelfHosted extends Context.Service<
  CloudSelfHosted,
  {
    readonly setPolicy: (
      policy: CloudSelfHostedPolicyMode,
    ) => Effect.Effect<CloudSelfHostedPolicyMode>;
    readonly policy: Effect.Effect<CloudSelfHostedPolicyMode>;
    readonly launchPreview: (target: "cloud" | "pool" | "machine") => Effect.Effect<CloudSelfHostedLaunchPreview>;
    readonly registerPool: (
      input: CloudSelfHostedRegisterPoolRequest,
      principal: CloudAgentsApiPrincipal,
    ) => Effect.Effect<{ readonly registered: boolean }, CloudSelfHostedFailure>;
    readonly listPools: (input: {
      readonly scope?: "all" | "team_pool" | "personal";
      readonly includeStale?: boolean;
    }) => Effect.Effect<{ readonly pools: ReadonlyArray<CloudSelfHostedPool> }>;
    readonly deregisterPool: (input: {
      readonly scope: "user" | "team";
      readonly poolName: string;
      readonly repoOwner?: string;
      readonly repoName?: string;
    }) => Effect.Effect<{ readonly deregistered: boolean }>;
    readonly connectWorker: (
      input: CloudSelfHostedConnectWorkerRequest,
      principal: CloudAgentsApiPrincipal,
    ) => Effect.Effect<CloudSelfHostedWorker, CloudSelfHostedFailure>;
    readonly disconnectWorker: (workerId: string) => Effect.Effect<void>;
    readonly idleRelease: (workerId: string) => Effect.Effect<void>;
    readonly listWorkers: (input: {
      readonly status?: "all" | "in_use" | "idle";
      readonly scope?: "all" | "team_pool" | "personal";
      readonly limit?: number;
      readonly pageToken?: string;
    }) => Effect.Effect<{
      readonly workers: ReadonlyArray<CloudSelfHostedWorker>;
      readonly totalCount: number;
      readonly nextPageToken?: string;
    }>;
    readonly summary: Effect.Effect<{
      readonly userSummary: { readonly totalConnected: number; readonly inUse: number };
      readonly teamSummary: { readonly totalConnected: number; readonly inUse: number };
    }>;
    readonly getWorker: (workerId: string) => Effect.Effect<CloudSelfHostedWorker | undefined>;
    readonly enqueue: (input: {
      readonly id: string;
      readonly target: "pool" | "machine";
      readonly poolName?: string;
      readonly principal: CloudAgentsApiPrincipal;
      readonly repoOwner?: string;
      readonly repoName?: string;
      readonly repoUrl?: string;
    }) => Effect.Effect<CloudSelfHostedPendingRequest, CloudSelfHostedFailure>;
    readonly listPending: (input: {
      readonly limit?: number;
      readonly pageToken?: string;
      readonly repository?: string;
      readonly pool?: string;
    }) => Effect.Effect<{
      readonly requests: ReadonlyArray<CloudSelfHostedPendingRequest>;
      readonly nextPageToken?: string;
      readonly streamCursor: string;
    }>;
    readonly watchPending: (input: {
      readonly cursor: string;
      readonly lastEventId?: string;
      readonly repository?: string;
      readonly pool?: string;
    }) => Effect.Effect<{ readonly events: ReadonlyArray<CloudSelfHostedWatchEvent> }, CloudSelfHostedFailure>;
    readonly claim: (input: {
      readonly id: string;
      readonly workerId: string;
    }) => Effect.Effect<{ readonly id: string; readonly workerId: string }, CloudSelfHostedFailure>;
    readonly release: (id: string) => Effect.Effect<{ readonly id: string; readonly released: boolean }>;
    readonly expire: (id: string) => Effect.Effect<void>;
    readonly management: (
      path: "/healthz" | "/readyz" | "/metrics",
      workerId: string | undefined,
    ) => Effect.Effect<{ readonly status: number; readonly body: string; readonly contentType: string }>;
  }
>()("t3/cloud/CloudSelfHosted") {}

function nowMs(): number {
  return DateTime.toEpochMillis(DateTime.nowUnsafe());
}

function ownerId(principal: CloudAgentsApiPrincipal): number {
  return principal.kind === "user" ? (principal.userId ?? 1) : 1;
}

export const make = Effect.fn("CloudSelfHosted.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);
  const loaded = yield* sql<{ state_json: string }>`
    SELECT state_json AS state_json FROM cloud_self_hosted_state WHERE singleton_id = 1
  `.pipe(Effect.orElseSucceed(() => [] as { state_json: string }[]));
  const initial = loaded[0] === undefined
    ? emptySelfHostedState()
    : ((decodeState(loaded[0].state_json) as CloudSelfHostedState | undefined) ?? emptySelfHostedState());
  const store = yield* Ref.make(initial);

  const persist = (state: CloudSelfHostedState) =>
    sql`
      INSERT INTO cloud_self_hosted_state (singleton_id, state_json)
      VALUES (1, ${encodeState(state)})
      ON CONFLICT(singleton_id) DO UPDATE SET state_json = excluded.state_json
    `.pipe(Effect.orDie);

  const modify = <A>(fn: (state: CloudSelfHostedState) => { state: CloudSelfHostedState; value: A }) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(store);
        const next = fn(current);
        yield* Ref.set(store, next.state);
        yield* persist(next.state);
        return next.value;
      }),
    );

  const tryModify = <A>(fn: (state: CloudSelfHostedState) => { state: CloudSelfHostedState; value: A } | CloudSelfHostedFailure) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(store);
        const next = fn(current);
        if (next instanceof CloudSelfHostedFailure) return yield* Effect.fail(next);
        yield* Ref.set(store, next.state);
        yield* persist(next.state);
        return next.value;
      }),
    );

  return CloudSelfHosted.of({
    setPolicy: (policy) => modify((state) => ({ state: setSelfHostedPolicy(state, policy), value: policy })),
    policy: Ref.get(store).pipe(Effect.map((state) => state.policy)),
    launchPreview: (target) =>
      Ref.get(store).pipe(Effect.map((state) => selfHostedLaunchPreview({ policy: state.policy, target }))),
    registerPool: (input, principal) =>
      tryModify((state) => {
        const result = registerSelfHostedPool(state, input, nowMs(), ownerId(principal));
        if (result instanceof CloudSelfHostedFailure) return result;
        return { state: result.state, value: { registered: true } };
      }),
    listPools: (input) =>
      Ref.get(store).pipe(Effect.map((state) => ({ pools: listSelfHostedPools(state, input) }))),
    deregisterPool: (input) =>
      modify((state) => {
        const result = deregisterSelfHostedPool(state, input);
        return { state: result.state, value: { deregistered: result.deregistered } };
      }),
    connectWorker: (input, principal) =>
      tryModify((state) => {
        const result = connectSelfHostedWorker(state, input, nowMs(), {
          kind: principal.kind,
          principalId: principal.principalId,
          ...(principal.userId === undefined ? {} : { userId: principal.userId }),
        });
        if (result instanceof CloudSelfHostedFailure) return result;
        return { state: result.state, value: result.worker };
      }),
    disconnectWorker: (workerId) =>
      modify((state) => ({ state: disconnectSelfHostedWorker(state, workerId, nowMs()), value: undefined })),
    idleRelease: (workerId) =>
      modify((state) => ({ state: idleReleaseSelfHostedWorker(state, workerId, nowMs()), value: undefined })),
    listWorkers: (input) => Ref.get(store).pipe(Effect.map((state) => listSelfHostedWorkers(state, input))),
    summary: Ref.get(store).pipe(Effect.map(selfHostedWorkerSummary)),
    getWorker: (workerId) =>
      Ref.get(store).pipe(Effect.map((state) => state.workers.find((worker) => worker.workerId === workerId))),
    enqueue: (input) =>
      tryModify((state) => {
        const result = enqueueSelfHostedRequest(
          state,
          {
            id: input.id,
            target: input.target,
            ...(input.poolName === undefined ? {} : { poolName: input.poolName }),
            userId: input.principal.userId ?? 0,
            ...(input.principal.userEmail === undefined ? {} : { userEmail: input.principal.userEmail }),
            ...(input.principal.kind === "service_account"
              ? { serviceAccountId: input.principal.principalId }
              : {}),
            ...(input.repoOwner === undefined ? {} : { repoOwner: input.repoOwner }),
            ...(input.repoName === undefined ? {} : { repoName: input.repoName }),
            ...(input.repoUrl === undefined ? {} : { repoUrl: input.repoUrl }),
          },
          nowMs(),
        );
        if (result instanceof CloudSelfHostedFailure) return result;
        return { state: result.state, value: result.request };
      }),
    listPending: (input) =>
      modify((state) => {
        const result = listSelfHostedPending(state, { ...input, nowMs: nowMs() });
        return {
          state: result.state,
          value: {
            requests: result.requests,
            streamCursor: result.streamCursor,
            ...(result.nextPageToken === undefined ? {} : { nextPageToken: result.nextPageToken }),
          },
        };
      }),
    watchPending: (input) =>
      tryModify((state) => {
        const result = watchSelfHostedPending(state, { ...input, nowMs: nowMs() });
        if (result instanceof CloudSelfHostedFailure) return result;
        return { state: result.state, value: { events: result.events } };
      }),
    claim: (input) =>
      tryModify((state) => {
        const result = claimSelfHostedRequest(state, input, nowMs());
        if (result instanceof CloudSelfHostedFailure) return result;
        return { state: result.state, value: { id: result.id, workerId: result.workerId } };
      }),
    release: (id) =>
      modify((state) => {
        const result = releaseSelfHostedClaim(state, { id, nowMs: nowMs() });
        return { state: result.state, value: { id: result.id ?? id, released: result.released } };
      }),
    expire: (id) => modify((state) => ({ state: expireUnclaimedRequest(state, id, nowMs()), value: undefined })),
    management: (path, workerId) =>
      Ref.get(store).pipe(
        Effect.map((state) =>
          workerManagementBody(
            path,
            workerId === undefined ? undefined : state.workers.find((worker) => worker.workerId === workerId),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(CloudSelfHosted, make());
