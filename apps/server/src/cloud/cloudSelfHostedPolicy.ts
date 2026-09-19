import {
  CLOUD_SELF_HOSTED_DEFAULT_IDLE_RELEASE_SECONDS,
  CLOUD_SELF_HOSTED_DEFAULT_PAGE_LIMIT,
  CLOUD_SELF_HOSTED_DEFAULT_PERSONAL_MAX_AGENTS,
  CLOUD_SELF_HOSTED_MAX_CONCURRENT_STREAMS,
  CLOUD_SELF_HOSTED_MAX_PAGE_LIMIT,
  CLOUD_SELF_HOSTED_MAX_WORKER_DIRS,
  CLOUD_SELF_HOSTED_MAX_WORKERS_PER_TEAM,
  CLOUD_SELF_HOSTED_MAX_WORKERS_PER_USER,
  CLOUD_SELF_HOSTED_STREAM_CURSOR_TTL_MS,
  CLOUD_SELF_HOSTED_TEAM_POOL_MAX_AGENTS,
  admitSelfHostedTarget as contractAdmitSelfHostedTarget,
  type CloudSelfHostedConnectWorkerRequest,
  type CloudSelfHostedErrorCode,
  type CloudSelfHostedLabel,
  type CloudSelfHostedListScope,
  type CloudSelfHostedPendingRequest,
  type CloudSelfHostedPolicyMode,
  type CloudSelfHostedPool,
  type CloudSelfHostedRegisterPoolRequest,
  type CloudSelfHostedWatchEvent,
  type CloudSelfHostedWorker,
  type CloudSelfHostedWorkerKind,
  type CloudSelfHostedWorkerStatusFilter,
} from "@t3tools/contracts";

export { selfHostedLaunchPreview } from "@t3tools/contracts";

export class CloudSelfHostedFailure {
  readonly _tag = "CloudSelfHostedFailure";
  readonly code: CloudSelfHostedErrorCode;
  readonly message: string;
  readonly status: number;
  constructor(code: CloudSelfHostedErrorCode, message: string, status: number) {
    this.code = code;
    this.message = message;
    this.status = status;
  }

  toBody() {
    return { code: this.code, message: this.message };
  }
}

export function selfHostedError(
  code: CloudSelfHostedErrorCode,
  message: string,
): CloudSelfHostedFailure {
  return new CloudSelfHostedFailure(code, message, statusForSelfHostedCode(code));
}

export function statusForSelfHostedCode(code: CloudSelfHostedErrorCode): number {
  switch (code) {
    case "unauthorized":
      return 401;
    case "invalid_request":
      return 400;
    case "cursor_expired":
      return 410;
    case "claim_conflict":
    case "worker_busy":
    case "self_hosted_disabled":
    case "self_hosted_required":
    case "pool_auth_required":
      return 409;
  }
}

export type CloudSelfHostedRequestRecord = CloudSelfHostedPendingRequest & {
  readonly poolName: string;
  readonly status: "queued" | "claimed" | "claimed_offline" | "assigned" | "expired";
  readonly claimExpiresAtMs?: number;
};

export type CloudSelfHostedCursor = {
  readonly token: string;
  readonly issuedAtMs: number;
  readonly seq: number;
  readonly repository?: string;
  readonly pool?: string;
};

export type CloudSelfHostedState = {
  readonly policy: CloudSelfHostedPolicyMode;
  readonly teamId: number;
  readonly pools: ReadonlyArray<CloudSelfHostedPool>;
  readonly workers: ReadonlyArray<CloudSelfHostedWorker>;
  readonly requests: ReadonlyArray<CloudSelfHostedRequestRecord>;
  readonly events: ReadonlyArray<CloudSelfHostedWatchEvent>;
  readonly cursors: ReadonlyArray<CloudSelfHostedCursor>;
  readonly openStreams: number;
  readonly nextSeq: number;
};

export function emptySelfHostedState(
  policy: CloudSelfHostedPolicyMode = "off",
  teamId = 1,
): CloudSelfHostedState {
  return {
    policy,
    teamId,
    pools: [],
    workers: [],
    requests: [],
    events: [],
    cursors: [],
    openStreams: 0,
    nextSeq: 1,
  };
}

export function admitSelfHostedTarget(input: {
  readonly policy: CloudSelfHostedPolicyMode;
  readonly target: "cloud" | "pool" | "machine";
}): CloudSelfHostedFailure | undefined {
  const denial = contractAdmitSelfHostedTarget(input);
  return denial === undefined ? undefined : selfHostedError(denial.code, denial.message);
}

function poolKey(pool: {
  readonly scope: string;
  readonly poolName: string;
  readonly repoOwner?: string;
  readonly repoName?: string;
}): string {
  return [pool.scope, pool.poolName, pool.repoOwner ?? "", pool.repoName ?? ""].join("\0");
}

function stripUserinfo(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function withRepoUrl<T extends object>(record: T, url: string | undefined): T {
  const repoUrl = stripUserinfo(url);
  return repoUrl === undefined ? record : { ...record, repoUrl };
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function publicPending(request: CloudSelfHostedRequestRecord, nowMs: number): CloudSelfHostedPendingRequest {
  const wakeTimeoutMs =
    request.status === "claimed_offline" && request.claimExpiresAtMs !== undefined
      ? Math.max(0, request.claimExpiresAtMs - nowMs)
      : undefined;
  return withRepoUrl(
    {
      id: request.id,
      userId: request.userId,
      createdAtMs: request.createdAtMs,
      labels: request.labels,
      ...(request.userEmail === undefined ? {} : { userEmail: request.userEmail }),
      ...(request.serviceAccountId === undefined ? {} : { serviceAccountId: request.serviceAccountId }),
      ...(request.repoOwner === undefined ? {} : { repoOwner: request.repoOwner }),
      ...(request.repoName === undefined ? {} : { repoName: request.repoName }),
      ...(request.claimedWorkerId === undefined ? {} : { claimedWorkerId: request.claimedWorkerId }),
      ...(wakeTimeoutMs === undefined ? {} : { wakeTimeoutMs }),
    },
    request.repoUrl,
  );
}

function emit(
  state: CloudSelfHostedState,
  event: CloudSelfHostedWatchEvent["event"],
  data: unknown,
  nowMs: number,
): CloudSelfHostedState {
  const id = `v4.${nowMs}.${state.nextSeq}`;
  return {
    ...state,
    nextSeq: state.nextSeq + 1,
    events: [
      ...state.events.slice(-2_000),
      { id, event, data, createdAtMs: nowMs },
    ],
  };
}

function replacePool(state: CloudSelfHostedState, pool: CloudSelfHostedPool): CloudSelfHostedState {
  const key = poolKey(pool);
  return {
    ...state,
    pools: [...state.pools.filter((candidate) => poolKey(candidate) !== key), pool],
  };
}

function recountPool(state: CloudSelfHostedState, pool: CloudSelfHostedPool): CloudSelfHostedPool {
  const members = state.workers.filter(
    (worker) =>
      worker.connected &&
      worker.kind === "team_pool" &&
      worker.poolName === pool.poolName,
  );
  return {
    ...pool,
    connectedWorkerCount: members.length,
    inUseWorkerCount: members.filter((worker) => worker.isInUse).length,
    lastSeenAtMs: members.reduce((latest, worker) => Math.max(latest, worker.lastSeenAtMs), pool.lastSeenAtMs),
  };
}

function refreshPools(state: CloudSelfHostedState): CloudSelfHostedState {
  return {
    ...state,
    pools: state.pools.map((pool) => recountPool(state, pool)),
  };
}

export function setSelfHostedPolicy(
  state: CloudSelfHostedState,
  policy: CloudSelfHostedPolicyMode,
): CloudSelfHostedState {
  return { ...state, policy };
}

export function registerSelfHostedPool(
  state: CloudSelfHostedState,
  input: CloudSelfHostedRegisterPoolRequest,
  nowMs: number,
  ownerId: number,
): { readonly state: CloudSelfHostedState } | CloudSelfHostedFailure {
  if ((input.repoOwner === undefined) !== (input.repoName === undefined)) {
    return selfHostedError("invalid_request", "Provide repoOwner and repoName together, or omit both.");
  }
  if (input.repoUrl !== undefined && (input.repoOwner === undefined || input.repoName === undefined)) {
    return selfHostedError("invalid_request", "repoUrl requires repoOwner and repoName.");
  }
  const existing = state.pools.find(
    (pool) =>
      pool.scope === input.scope &&
      pool.poolName === input.poolName &&
      pool.repoOwner === input.repoOwner &&
      pool.repoName === input.repoName,
  );
  const pool = withRepoUrl(
    {
      scope: input.scope,
      ownerId,
      poolName: input.poolName,
      connectedWorkerCount: existing?.connectedWorkerCount ?? 0,
      inUseWorkerCount: existing?.inUseWorkerCount ?? 0,
      firstSeenAtMs: existing?.firstSeenAtMs ?? nowMs,
      lastSeenAtMs: nowMs,
      isStale: false,
      deleted: false,
      workerReadyTimeoutSeconds: input.workerReadyTimeoutSeconds ?? 0,
      ...(input.repoOwner === undefined ? {} : { repoOwner: input.repoOwner }),
      ...(input.repoName === undefined ? {} : { repoName: input.repoName }),
    },
    input.repoUrl,
  );
  return { state: replacePool(state, pool) };
}

export function deregisterSelfHostedPool(
  state: CloudSelfHostedState,
  input: { readonly scope: "user" | "team"; readonly poolName: string; readonly repoOwner?: string; readonly repoName?: string },
): { readonly state: CloudSelfHostedState; readonly deregistered: boolean } {
  const key = poolKey(input);
  const pools = state.pools.map((pool) =>
    poolKey(pool) === key ? { ...pool, deleted: true, isStale: true } : pool,
  );
  return { state: { ...state, pools }, deregistered: state.pools.some((pool) => poolKey(pool) === key) };
}

export function listSelfHostedPools(
  state: CloudSelfHostedState,
  input: { readonly scope?: CloudSelfHostedListScope; readonly includeStale?: boolean } = {},
): ReadonlyArray<CloudSelfHostedPool> {
  return refreshPools(state).pools.filter((pool) => {
    if (pool.deleted && input.includeStale !== true) return false;
    if (pool.isStale && input.includeStale !== true) return false;
    if (input.scope === "personal") return pool.scope === "user";
    if (input.scope === "team_pool") return pool.scope === "team";
    return true;
  });
}

function ensurePoolForWorker(
  state: CloudSelfHostedState,
  worker: CloudSelfHostedWorker,
  nowMs: number,
): CloudSelfHostedState {
  if (worker.kind !== "team_pool" || worker.poolName === undefined) return state;
  const scope = "team" as const;
  const existing = state.pools.find(
    (pool) => pool.scope === scope && pool.poolName === worker.poolName && !pool.deleted,
  );
  if (existing !== undefined) return state;
  return replacePool(state, {
    scope,
    ownerId: worker.teamId ?? state.teamId,
    poolName: worker.poolName,
    connectedWorkerCount: 0,
    inUseWorkerCount: 0,
    firstSeenAtMs: nowMs,
    lastSeenAtMs: nowMs,
    isStale: false,
    deleted: false,
    workerReadyTimeoutSeconds: 0,
    ...(worker.repoOwner.length === 0 ? {} : { repoOwner: worker.repoOwner }),
    ...(worker.repoName.length === 0 ? {} : { repoName: worker.repoName }),
    ...(worker.repoUrl === undefined ? {} : { repoUrl: worker.repoUrl }),
  });
}

export function connectSelfHostedWorker(
  state: CloudSelfHostedState,
  input: CloudSelfHostedConnectWorkerRequest,
  nowMs: number,
  principal: {
    readonly kind: "user" | "service_account";
    readonly principalId: string;
    readonly userId?: number;
  },
): { readonly state: CloudSelfHostedState; readonly worker: CloudSelfHostedWorker } | CloudSelfHostedFailure {
  if (input.kind === "team_pool" && principal.kind !== "service_account") {
    return selfHostedError("pool_auth_required", "Team pool workers must authenticate with a service account API key.");
  }
  if (input.kind === "personal" && principal.kind !== "user") {
    return selfHostedError("invalid_request", "Personal machines authenticate with a user API key.");
  }
  if (input.workspaceRoots.length === 0) {
    return selfHostedError("invalid_request", "A worker needs at least one workspace root.");
  }
  if (input.workspaceRoots.length > CLOUD_SELF_HOSTED_MAX_WORKER_DIRS) {
    return selfHostedError(
      "invalid_request",
      `A worker may register at most ${CLOUD_SELF_HOSTED_MAX_WORKER_DIRS} workspace roots.`,
    );
  }
  if (input.workspaceRoots.some((root) => !isAbsolutePath(root))) {
    return selfHostedError("invalid_request", "Workspace roots must be absolute paths.");
  }
  if (new Set(input.workspaceRoots).size !== input.workspaceRoots.length) {
    return selfHostedError("invalid_request", "Workspace roots must be unique.");
  }
  const workerId = input.workerId ?? `pw_${nowMs.toString(16)}`;
  const kind: CloudSelfHostedWorkerKind = input.kind;
  const maxAgents =
    kind === "team_pool"
      ? CLOUD_SELF_HOSTED_TEAM_POOL_MAX_AGENTS
      : (input.maxAgents ?? CLOUD_SELF_HOSTED_DEFAULT_PERSONAL_MAX_AGENTS);
  const connectedPersonal = state.workers.filter((worker) => worker.kind === "personal" && worker.connected).length;
  const connectedTeam = state.workers.filter((worker) => worker.kind === "team_pool" && worker.connected).length;
  const existing = state.workers.find((worker) => worker.workerId === workerId);
  if (existing === undefined) {
    if (kind === "personal" && connectedPersonal >= CLOUD_SELF_HOSTED_MAX_WORKERS_PER_USER) {
      return selfHostedError("invalid_request", "Personal worker limit reached.");
    }
    if (kind === "team_pool" && connectedTeam >= CLOUD_SELF_HOSTED_MAX_WORKERS_PER_TEAM) {
      return selfHostedError("invalid_request", "Team pool worker limit reached.");
    }
  }
  const primary = input.workspaceRoots[0]!;
  const worker: CloudSelfHostedWorker = withRepoUrl(
    {
      workerId,
      kind,
      isInUse: existing?.isInUse ?? false,
      connected: true,
      repoOwner: input.repoOwner ?? existing?.repoOwner ?? "",
      repoName: input.repoName ?? existing?.repoName ?? "",
      workspaceRootPath: primary,
      workspaceRoots: input.workspaceRoots,
      connectedAtMs: existing?.connectedAtMs ?? nowMs,
      lastSeenAtMs: nowMs,
      userId: kind === "team_pool" ? 0 : (principal.userId ?? 1),
      labels: input.labels ?? existing?.labels ?? [],
      maxAgents,
      activeAgentIds: existing?.activeAgentIds ?? [],
      outboundOnly: true as const,
      cloneGitRepos: input.cloneGitRepos === true,
      mintGithubToken: input.mintGithubToken === true || input.cloneGitRepos === true,
      secretSync: input.secretSync === true,
      identitySocket: input.identitySocket !== false,
      computerUse: input.computerUse === true,
      ...(input.managementAddr === undefined ? {} : { managementAddr: input.managementAddr }),
      ...(kind === "team_pool" ? { poolName: input.poolName ?? "default" } : {}),
      ...(kind === "team_pool" ? { teamId: state.teamId, serviceAccountId: principal.principalId } : {}),
      ...(existing?.activeBcId === undefined ? {} : { activeBcId: existing.activeBcId }),
      ...(input.name === undefined ? {} : { name: input.name }),
    },
    input.repoUrl,
  );
  let next: CloudSelfHostedState = {
    ...state,
    workers: [...state.workers.filter((candidate) => candidate.workerId !== workerId), worker],
  };
  next = ensurePoolForWorker(next, worker, nowMs);
  next = resumeClaimedOffline(next, worker, nowMs);
  return { state: refreshPools(next), worker };
}

function resumeClaimedOffline(
  state: CloudSelfHostedState,
  worker: CloudSelfHostedWorker,
  nowMs: number,
): CloudSelfHostedState {
  const resumed = state.requests.find(
    (request) =>
      request.status === "claimed_offline" &&
      request.claimedWorkerId === worker.workerId &&
      (request.claimExpiresAtMs === undefined || request.claimExpiresAtMs >= nowMs),
  );
  if (resumed === undefined) return state;
  return assignRequest(state, resumed, worker, nowMs);
}

function assignRequest(
  state: CloudSelfHostedState,
  request: CloudSelfHostedRequestRecord,
  worker: CloudSelfHostedWorker,
  nowMs: number,
): CloudSelfHostedState {
  const activeAgentIds = [...new Set([...worker.activeAgentIds, request.id])];
  const assignedWorker: CloudSelfHostedWorker = {
    ...worker,
    isInUse: true,
    activeAgentIds,
    activeBcId: request.id,
    lastSeenAtMs: nowMs,
  };
  const assignedRequest: CloudSelfHostedRequestRecord = {
    ...request,
    status: "assigned",
    claimedWorkerId: worker.workerId,
  };
  const next = {
    ...state,
    workers: state.workers.map((candidate) =>
      candidate.workerId === worker.workerId ? assignedWorker : candidate,
    ),
    requests: state.requests.map((candidate) => (candidate.id === request.id ? assignedRequest : candidate)),
  };
  return refreshPools(emit(next, "claimed", { id: request.id }, nowMs));
}

export function disconnectSelfHostedWorker(
  state: CloudSelfHostedState,
  workerId: string,
  nowMs: number,
): CloudSelfHostedState {
  const worker = state.workers.find((candidate) => candidate.workerId === workerId);
  if (worker === undefined) return state;
  const pool = state.pools.find((candidate) => candidate.poolName === worker.poolName && candidate.scope === "team");
  const timeoutSeconds = pool?.workerReadyTimeoutSeconds ?? 0;
  let next: CloudSelfHostedState = {
    ...state,
    workers: state.workers.map((candidate) =>
      candidate.workerId === workerId
        ? { ...candidate, connected: false, lastSeenAtMs: nowMs, isInUse: false }
        : candidate,
    ),
  };
  if (timeoutSeconds > 0) {
    const assigned = next.requests.filter(
      (request) => request.claimedWorkerId === workerId && request.status === "assigned",
    );
    for (const request of assigned) {
      const offline: CloudSelfHostedRequestRecord = {
        ...request,
        status: "claimed_offline",
        claimExpiresAtMs: nowMs + timeoutSeconds * 1_000,
      };
      next = {
        ...next,
        requests: next.requests.map((candidate) => (candidate.id === request.id ? offline : candidate)),
      };
      next = emit(next, "claimed_offline", publicPending(offline, nowMs), nowMs);
    }
  }
  return refreshPools(next);
}

/** The worker process exited after idle. The reconnect window, if any, is the hibernate path. */
export function idleReleaseSelfHostedWorker(
  state: CloudSelfHostedState,
  workerId: string,
  nowMs: number,
): CloudSelfHostedState {
  return disconnectSelfHostedWorker(state, workerId, nowMs);
}

export function heartbeatSelfHostedWorker(
  state: CloudSelfHostedState,
  workerId: string,
  nowMs: number,
): CloudSelfHostedState {
  return {
    ...state,
    workers: state.workers.map((worker) =>
      worker.workerId === workerId ? { ...worker, lastSeenAtMs: nowMs, connected: true } : worker,
    ),
  };
}

export function enqueueSelfHostedRequest(
  state: CloudSelfHostedState,
  input: {
    readonly id: string;
    readonly target: "pool" | "machine";
    readonly poolName?: string;
    readonly userId: number;
    readonly userEmail?: string;
    readonly serviceAccountId?: string;
    readonly repoOwner?: string;
    readonly repoName?: string;
    readonly repoUrl?: string;
    readonly labels?: ReadonlyArray<CloudSelfHostedLabel>;
  },
  nowMs: number,
): { readonly state: CloudSelfHostedState; readonly request: CloudSelfHostedPendingRequest } | CloudSelfHostedFailure {
  const denied = admitSelfHostedTarget({ policy: state.policy, target: input.target });
  if (denied !== undefined) return denied;
  const poolName = input.poolName ?? (input.target === "pool" ? "default" : undefined);
  const pool =
    poolName === undefined
      ? undefined
      : state.pools.find((candidate) => candidate.poolName === poolName && !candidate.deleted);
  const previous = state.requests.find((request) => request.id === input.id);
  const previousWorkerId = previous?.claimedWorkerId;
  const previousWorker = previousWorkerId === undefined
    ? undefined
    : state.workers.find((worker) => worker.workerId === previousWorkerId);
  const labels: CloudSelfHostedLabel[] = [
    ...(input.labels ?? []),
    ...(poolName === undefined ? [] : [{ key: "pool", value: poolName }]),
    ...(input.repoOwner !== undefined && input.repoName !== undefined
      ? [{ key: "repo", value: `${input.repoOwner}/${input.repoName}` }]
      : []),
  ];
  const record: CloudSelfHostedRequestRecord = withRepoUrl(
    {
      id: input.id,
      userId: input.userId,
      createdAtMs: nowMs,
      labels,
      poolName: poolName ?? "personal",
      status: "queued",
      ...(input.userEmail === undefined ? {} : { userEmail: input.userEmail }),
      ...(input.serviceAccountId === undefined ? {} : { serviceAccountId: input.serviceAccountId }),
      ...(input.repoOwner === undefined ? {} : { repoOwner: input.repoOwner }),
      ...(input.repoName === undefined ? {} : { repoName: input.repoName }),
    },
    input.repoUrl,
  );
  let next: CloudSelfHostedState = {
    ...state,
    requests: [...state.requests.filter((request) => request.id !== input.id), record],
  };
  if (
    previousWorker !== undefined &&
    previousWorker.connected &&
    previousWorker.activeAgentIds.includes(input.id)
  ) {
    return { state, request: publicPending({ ...record, status: "assigned", claimedWorkerId: previousWorker.workerId }, nowMs) };
  }
  if (
    previousWorker !== undefined &&
    !previousWorker.connected &&
    (pool?.workerReadyTimeoutSeconds ?? 0) > 0
  ) {
    const offline: CloudSelfHostedRequestRecord = {
      ...record,
      status: "claimed_offline",
      claimedWorkerId: previousWorker.workerId,
      claimExpiresAtMs: nowMs + (pool?.workerReadyTimeoutSeconds ?? 0) * 1_000,
    };
    next = {
      ...next,
      requests: next.requests.map((request) => (request.id === offline.id ? offline : request)),
    };
    next = emit(next, "claimed_offline", publicPending(offline, nowMs), nowMs);
    return { state: next, request: publicPending(offline, nowMs) };
  }
  next = emit(next, "created", publicPending(record, nowMs), nowMs);
  return { state: next, request: publicPending(record, nowMs) };
}

export function listSelfHostedPending(
  state: CloudSelfHostedState,
  input: {
    readonly nowMs: number;
    readonly limit?: number;
    readonly pageToken?: string;
    readonly repository?: string;
    readonly pool?: string;
  },
): {
  readonly state: CloudSelfHostedState;
  readonly requests: ReadonlyArray<CloudSelfHostedPendingRequest>;
  readonly nextPageToken?: string;
  readonly streamCursor: string;
} {
  const ticked = expireSelfHostedClaims(state, input.nowMs);
  const limit = Math.min(
    CLOUD_SELF_HOSTED_MAX_PAGE_LIMIT,
    Math.max(1, input.limit ?? CLOUD_SELF_HOSTED_DEFAULT_PAGE_LIMIT),
  );
  const visible = ticked.requests.filter((request) => {
    if (request.status !== "queued" && request.status !== "claimed_offline") return false;
    if (input.pool !== undefined && request.poolName !== input.pool) return false;
    if (input.repository !== undefined && request.repoUrl !== input.repository) return false;
    return true;
  });
  const offset = input.pageToken === undefined ? 0 : Number.parseInt(input.pageToken, 10) || 0;
  const page = visible.slice(offset, offset + limit);
  const cursor: CloudSelfHostedCursor = {
    token: `v4.${input.nowMs}.${ticked.nextSeq}`,
    issuedAtMs: input.nowMs,
    seq: ticked.nextSeq - 1,
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    ...(input.pool === undefined ? {} : { pool: input.pool }),
  };
  const next: CloudSelfHostedState = { ...ticked, cursors: [...ticked.cursors.slice(-32), cursor] };
  return {
    state: next,
    requests: page.map((request) => publicPending(request, input.nowMs)),
    ...(offset + limit < visible.length ? { nextPageToken: String(offset + limit) } : {}),
    streamCursor: cursor.token,
  };
}

export function watchSelfHostedPending(
  state: CloudSelfHostedState,
  input: {
    readonly cursor: string;
    readonly nowMs: number;
    readonly lastEventId?: string;
    readonly repository?: string;
    readonly pool?: string;
  },
):
  | { readonly state: CloudSelfHostedState; readonly events: ReadonlyArray<CloudSelfHostedWatchEvent> }
  | CloudSelfHostedFailure {
  if (state.openStreams >= CLOUD_SELF_HOSTED_MAX_CONCURRENT_STREAMS) {
    return selfHostedError("invalid_request", "A service account may hold at most four concurrent pool watches.");
  }
  const token = input.lastEventId && input.lastEventId.length > 0 ? input.lastEventId : input.cursor;
  const listed = state.cursors.find((cursor) => cursor.token === token) ?? parseCursorToken(token);
  if (listed === undefined) {
    return selfHostedError("cursor_expired", "The watch cursor expired. Relist pending requests.");
  }
  if (input.repository !== undefined && listed.repository !== undefined && listed.repository !== input.repository) {
    return selfHostedError("invalid_request", "Watch filters must match the list that issued the cursor.");
  }
  if (input.pool !== undefined && listed.pool !== undefined && listed.pool !== input.pool) {
    return selfHostedError("invalid_request", "Watch filters must match the list that issued the cursor.");
  }
  if (input.nowMs - listed.issuedAtMs > CLOUD_SELF_HOSTED_STREAM_CURSOR_TTL_MS) {
    return selfHostedError("cursor_expired", "The watch cursor expired. Relist pending requests.");
  }
  const afterSeq = seqFromEventId(token) ?? listed.seq;
  const retained = state.events.filter((event) => {
    const seq = seqFromEventId(event.id) ?? 0;
    if (seq <= afterSeq) return false;
    if (input.pool === undefined) return true;
    if (event.event === "heartbeat") return true;
    const data = event.data as { poolName?: string; labels?: ReadonlyArray<CloudSelfHostedLabel> };
    if (typeof data.poolName === "string") return data.poolName === input.pool;
    return data.labels?.some((label) => label.key === "pool" && label.value === input.pool) === true;
  });
  const heartbeat: CloudSelfHostedWatchEvent = {
    id: `v4.${listed.issuedAtMs}.${state.nextSeq}`,
    event: "heartbeat",
    data: {},
    createdAtMs: input.nowMs,
  };
  return {
    state: { ...state, nextSeq: state.nextSeq + 1, openStreams: state.openStreams + 1 },
    events: [...retained, heartbeat],
  };
}

function parseCursorToken(token: string): CloudSelfHostedCursor | undefined {
  const match = /^v4\.(\d+)\.(\d+)$/.exec(token);
  if (match === null) return undefined;
  return {
    token,
    issuedAtMs: Number(match[1]),
    seq: Number(match[2]),
  };
}

function seqFromEventId(id: string): number | undefined {
  const parsed = parseCursorToken(id);
  return parsed?.seq;
}

export function claimSelfHostedRequest(
  state: CloudSelfHostedState,
  input: { readonly id: string; readonly workerId: string },
  nowMs: number,
): { readonly state: CloudSelfHostedState; readonly id: string; readonly workerId: string } | CloudSelfHostedFailure {
  const ticked = expireSelfHostedClaims(state, nowMs);
  const request = ticked.requests.find((candidate) => candidate.id === input.id);
  if (request === undefined) {
    return selfHostedError("invalid_request", `Pending request '${input.id}' was not found.`);
  }
  if (request.status === "assigned" || request.status === "claimed") {
    if (request.claimedWorkerId !== undefined && request.claimedWorkerId !== input.workerId) {
      return selfHostedError("claim_conflict", "Release the live claim before assigning a new worker.");
    }
    if (request.status === "assigned") {
      return selfHostedError("claim_conflict", "Release the live claim before assigning a new worker.");
    }
  }
  if (request.status !== "queued" && request.status !== "claimed_offline" && request.status !== "claimed") {
    return selfHostedError("invalid_request", `Pending request '${input.id}' was not found.`);
  }
  if (
    request.status === "claimed_offline" &&
    request.claimedWorkerId !== undefined &&
    request.claimedWorkerId !== input.workerId
  ) {
    return selfHostedError("claim_conflict", "Release the live claim before assigning a new worker.");
  }
  const worker = ticked.workers.find((candidate) => candidate.workerId === input.workerId);
  const claimed: CloudSelfHostedRequestRecord = {
    ...request,
    status: worker?.connected === true ? "assigned" : "claimed",
    claimedWorkerId: input.workerId,
  };
  let next: CloudSelfHostedState = {
    ...ticked,
    requests: ticked.requests.map((candidate) => (candidate.id === input.id ? claimed : candidate)),
  };
  if (worker?.connected === true) {
    if (worker.activeAgentIds.length >= worker.maxAgents) {
      return selfHostedError("worker_busy", "This worker already has its maximum number of agents.");
    }
    next = assignRequest(next, claimed, worker, nowMs);
  } else {
    next = emit(next, "claimed", { id: input.id }, nowMs);
  }
  return { state: refreshPools(next), id: input.id, workerId: input.workerId };
}

export function releaseSelfHostedClaim(
  state: CloudSelfHostedState,
  input: { readonly id?: string; readonly nowMs: number; readonly idle?: boolean },
): { readonly state: CloudSelfHostedState; readonly id?: string; readonly released: boolean } {
  const request =
    input.id === undefined
      ? undefined
      : state.requests.find((candidate) => candidate.id === input.id);
  if (request === undefined) return { state, released: false };
  const workerId = request.claimedWorkerId;
  const queued: CloudSelfHostedRequestRecord = {
    id: request.id,
    userId: request.userId,
    createdAtMs: request.createdAtMs,
    labels: request.labels,
    poolName: request.poolName,
    status: "queued",
    ...(request.userEmail === undefined ? {} : { userEmail: request.userEmail }),
    ...(request.serviceAccountId === undefined ? {} : { serviceAccountId: request.serviceAccountId }),
    ...(request.repoOwner === undefined ? {} : { repoOwner: request.repoOwner }),
    ...(request.repoName === undefined ? {} : { repoName: request.repoName }),
    ...(request.repoUrl === undefined ? {} : { repoUrl: request.repoUrl }),
  };
  let next: CloudSelfHostedState = {
    ...state,
    requests: state.requests.map((candidate) => (candidate.id === request.id ? queued : candidate)),
    workers: state.workers.map((worker) => {
      if (worker.workerId !== workerId) return worker;
      const activeAgentIds = worker.activeAgentIds.filter((id) => id !== request.id);
      return {
        ...worker,
        activeAgentIds,
        isInUse: activeAgentIds.length > 0,
        ...(activeAgentIds[0] === undefined ? {} : { activeBcId: activeAgentIds[0] }),
      };
    }),
  };
  next = emit(next, "created", publicPending(queued, input.nowMs), input.nowMs);
  return { state: refreshPools(next), id: request.id, released: true };
}

export function expireSelfHostedClaims(state: CloudSelfHostedState, nowMs: number): CloudSelfHostedState {
  let next = state;
  for (const request of state.requests) {
    if (request.status !== "claimed_offline" || request.claimExpiresAtMs === undefined) continue;
    if (request.claimExpiresAtMs > nowMs) continue;
    const queued: CloudSelfHostedRequestRecord = {
      ...request,
      status: "queued",
    };
    delete (queued as { claimedWorkerId?: string }).claimedWorkerId;
    delete (queued as { claimExpiresAtMs?: number }).claimExpiresAtMs;
    delete (queued as { wakeTimeoutMs?: number }).wakeTimeoutMs;
    const cleaned: CloudSelfHostedRequestRecord = {
      id: request.id,
      userId: request.userId,
      createdAtMs: request.createdAtMs,
      labels: request.labels,
      poolName: request.poolName,
      status: "queued",
      ...(request.userEmail === undefined ? {} : { userEmail: request.userEmail }),
      ...(request.serviceAccountId === undefined ? {} : { serviceAccountId: request.serviceAccountId }),
      ...(request.repoOwner === undefined ? {} : { repoOwner: request.repoOwner }),
      ...(request.repoName === undefined ? {} : { repoName: request.repoName }),
      ...(request.repoUrl === undefined ? {} : { repoUrl: request.repoUrl }),
    };
    next = {
      ...next,
      requests: next.requests.map((candidate) => (candidate.id === request.id ? cleaned : candidate)),
    };
    next = emit(next, "created", publicPending(cleaned, nowMs), nowMs);
  }
  return next;
}

export function expireUnclaimedRequest(
  state: CloudSelfHostedState,
  id: string,
  nowMs: number,
): CloudSelfHostedState {
  const request = state.requests.find((candidate) => candidate.id === id);
  if (request === undefined) return state;
  const next = {
    ...state,
    requests: state.requests.map((candidate) =>
      candidate.id === id ? { ...candidate, status: "expired" as const } : candidate,
    ),
  };
  return emit(next, "expired", { id }, nowMs);
}

export function listSelfHostedWorkers(
  state: CloudSelfHostedState,
  input: {
    readonly status?: CloudSelfHostedWorkerStatusFilter;
    readonly scope?: CloudSelfHostedListScope;
    readonly limit?: number;
    readonly pageToken?: string;
  } = {},
): {
  readonly workers: ReadonlyArray<CloudSelfHostedWorker>;
  readonly totalCount: number;
  readonly nextPageToken?: string;
} {
  const matched = state.workers.filter((worker) => {
    if (!worker.connected) return false;
    if (input.scope === "personal" && worker.kind !== "personal") return false;
    if (input.scope === "team_pool" && worker.kind !== "team_pool") return false;
    if (input.status === "in_use" && !worker.isInUse) return false;
    if (input.status === "idle" && worker.isInUse) return false;
    return true;
  });
  const limit = Math.min(
    CLOUD_SELF_HOSTED_MAX_PAGE_LIMIT,
    Math.max(1, input.limit ?? CLOUD_SELF_HOSTED_DEFAULT_PAGE_LIMIT),
  );
  const offset = input.pageToken === undefined ? 0 : Number.parseInt(input.pageToken, 10) || 0;
  const workers = matched.slice(offset, offset + limit);
  return {
    workers,
    totalCount: matched.length,
    ...(offset + limit < matched.length ? { nextPageToken: String(offset + limit) } : {}),
  };
}

export function selfHostedWorkerSummary(state: CloudSelfHostedState): {
  readonly userSummary: { readonly totalConnected: number; readonly inUse: number };
  readonly teamSummary: { readonly totalConnected: number; readonly inUse: number };
} {
  const ofKind = (kind: CloudSelfHostedWorkerKind) => {
    const workers = state.workers.filter((worker) => worker.connected && worker.kind === kind);
    return {
      totalConnected: workers.length,
      inUse: workers.filter((worker) => worker.isInUse).length,
    };
  };
  return { userSummary: ofKind("personal"), teamSummary: ofKind("team_pool") };
}

export function workerManagementBody(
  path: "/healthz" | "/readyz" | "/metrics",
  worker: CloudSelfHostedWorker | undefined,
): { readonly status: number; readonly body: string; readonly contentType: string } {
  if (path === "/healthz") {
    return { status: 200, body: "ok\n", contentType: "text/plain" };
  }
  if (path === "/readyz") {
    const ready = worker?.connected === true;
    return {
      status: ready ? 200 : 503,
      body: ready ? "ready\n" : "not ready\n",
      contentType: "text/plain",
    };
  }
  const lines = [
    "# HELP t3_self_hosted_worker_connected 1 when the worker holds an outbound controller session.",
    "# TYPE t3_self_hosted_worker_connected gauge",
    `t3_self_hosted_worker_connected ${worker?.connected === true ? 1 : 0}`,
    "# HELP t3_self_hosted_worker_in_use 1 when the worker has a claimed agent.",
    "# TYPE t3_self_hosted_worker_in_use gauge",
    `t3_self_hosted_worker_in_use ${worker?.isInUse === true ? 1 : 0}`,
    "# HELP t3_self_hosted_worker_agents Number of agents assigned to this worker.",
    "# TYPE t3_self_hosted_worker_agents gauge",
    `t3_self_hosted_worker_agents ${worker?.activeAgentIds.length ?? 0}`,
    "# HELP t3_self_hosted_worker_computer_use 1 when computer use is enabled.",
    "# TYPE t3_self_hosted_worker_computer_use gauge",
    `t3_self_hosted_worker_computer_use ${worker?.computerUse === true ? 1 : 0}`,
  ];
  return { status: 200, body: `${lines.join("\n")}\n`, contentType: "text/plain; version=0.0.4" };
}

export function defaultIdleReleaseSeconds(
  override: number | undefined,
): number {
  return override ?? CLOUD_SELF_HOSTED_DEFAULT_IDLE_RELEASE_SECONDS;
}
