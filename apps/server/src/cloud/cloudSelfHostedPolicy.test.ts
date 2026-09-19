import { describe, expect, it } from "vite-plus/test";

import {
  claimSelfHostedRequest,
  connectSelfHostedWorker,
  disconnectSelfHostedWorker,
  emptySelfHostedState,
  enqueueSelfHostedRequest,
  expireSelfHostedClaims,
  expireUnclaimedRequest,
  idleReleaseSelfHostedWorker,
  listSelfHostedPending,
  listSelfHostedPools,
  registerSelfHostedPool,
  releaseSelfHostedClaim,
  selfHostedLaunchPreview,
  setSelfHostedPolicy,
  watchSelfHostedPending,
  workerManagementBody,
  type CloudSelfHostedFailure,
} from "./cloudSelfHostedPolicy.ts";

const NOW = 1_737_306_880_000;
const user = { kind: "user" as const, principalId: "principal:user", userId: 321 };
const service = { kind: "service_account" as const, principalId: "sa_abc123" };

function isFailure(value: unknown): value is CloudSelfHostedFailure {
  return typeof value === "object" && value !== null && (value as { _tag?: string })._tag === "CloudSelfHostedFailure";
}

function unwrap<T>(value: T | CloudSelfHostedFailure): T {
  if (isFailure(value)) throw new Error(`${value.code}: ${value.message}`);
  return value;
}

describe("self-hosted policy", () => {
  it("keeps a team pool registered at scale-to-zero", () => {
    let state = setSelfHostedPolicy(emptySelfHostedState(), "allow");
    state = unwrap(
      registerSelfHostedPool(
        state,
        { scope: "team", poolName: "gpu", workerReadyTimeoutSeconds: 900 },
        NOW,
        456,
      ),
    ).state;
    const connected = unwrap(
      connectSelfHostedWorker(
        state,
        {
          kind: "team_pool",
          poolName: "gpu",
          workerId: "pw_1",
          workspaceRoots: ["/home/agent/app"],
          repoOwner: "acme",
          repoName: "app",
        },
        NOW,
        service,
      ),
    );
    const scaled = disconnectSelfHostedWorker(connected.state, "pw_1", NOW + 1_000);
    const pools = listSelfHostedPools(scaled);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      poolName: "gpu",
      connectedWorkerCount: 0,
      inUseWorkerCount: 0,
      workerReadyTimeoutSeconds: 900,
      deleted: false,
    });
  });

  it("lets a personal machine take two agents and a team worker only one", () => {
    let state = setSelfHostedPolicy(emptySelfHostedState(), "allow");
    const personal = unwrap(
      connectSelfHostedWorker(
        state,
        {
          kind: "personal",
          workerId: "home",
          workspaceRoots: ["/Users/dev/app"],
          maxAgents: 2,
        },
        NOW,
        user,
      ),
    );
    state = personal.state;
    const first = unwrap(enqueueSelfHostedRequest(state, { id: "bc-1", target: "machine", userId: 321 }, NOW));
    state = unwrap(claimSelfHostedRequest(first.state, { id: "bc-1", workerId: "home" }, NOW)).state;
    const second = unwrap(enqueueSelfHostedRequest(state, { id: "bc-2", target: "machine", userId: 321 }, NOW));
    state = unwrap(claimSelfHostedRequest(second.state, { id: "bc-2", workerId: "home" }, NOW)).state;
    expect(state.workers[0]?.activeAgentIds).toEqual(["bc-1", "bc-2"]);

    const pool = unwrap(
      connectSelfHostedWorker(
        state,
        { kind: "team_pool", poolName: "gpu", workerId: "gpu-1", workspaceRoots: ["/work/app"] },
        NOW,
        service,
      ),
    );
    state = unwrap(
      enqueueSelfHostedRequest(pool.state, { id: "bc-3", target: "pool", poolName: "gpu", userId: 321 }, NOW),
    ).state;
    state = unwrap(claimSelfHostedRequest(state, { id: "bc-3", workerId: "gpu-1" }, NOW)).state;
    state = unwrap(
      enqueueSelfHostedRequest(state, { id: "bc-4", target: "pool", poolName: "gpu", userId: 322 }, NOW),
    ).state;
    const busy = claimSelfHostedRequest(state, { id: "bc-4", workerId: "gpu-1" }, NOW);
    expect(isFailure(busy) && busy.code).toBe("worker_busy");
  });

  it("emits created, claimed, claimed_offline, expired, and heartbeat, then recovers from an expired cursor", () => {
    let state = setSelfHostedPolicy(emptySelfHostedState(), "allow");
    state = unwrap(
      registerSelfHostedPool(
        state,
        { scope: "team", poolName: "gpu", workerReadyTimeoutSeconds: 2 },
        NOW,
        456,
      ),
    ).state;
    const queued = unwrap(
      enqueueSelfHostedRequest(
        state,
        {
          id: "bc-offline",
          target: "pool",
          poolName: "gpu",
          userId: 321,
          userEmail: "owner@acme.example",
          repoOwner: "acme",
          repoName: "app",
          repoUrl: "https://user:token@github.com/acme/app.git",
        },
        NOW,
      ),
    );
    state = queued.state;
    expect(queued.request.repoUrl).toBe("https://github.com/acme/app.git");
    expect(queued.request.labels.some((label) => label.key === "pool" && label.value === "gpu")).toBe(
      true,
    );

    const listed = listSelfHostedPending(state, { nowMs: NOW, pool: "gpu" });
    state = listed.state;
    expect(listed.requests).toHaveLength(1);
    const watched = unwrap(
      watchSelfHostedPending(state, { cursor: listed.streamCursor, nowMs: NOW, pool: "gpu" }),
    );
    expect(watched.events.at(-1)?.event).toBe("heartbeat");
    expect(watched.events.some((event) => event.event === "created")).toBe(false);

    state = unwrap(
      connectSelfHostedWorker(
        watched.state,
        { kind: "team_pool", poolName: "gpu", workerId: "pw_gpu", workspaceRoots: ["/work/app"] },
        NOW + 10,
        service,
      ),
    ).state;
    state = unwrap(claimSelfHostedRequest(state, { id: "bc-offline", workerId: "pw_gpu" }, NOW + 10)).state;
    expect(state.events.some((event) => event.event === "claimed")).toBe(true);

    state = idleReleaseSelfHostedWorker(state, "pw_gpu", NOW + 20);
    const follow = unwrap(
      enqueueSelfHostedRequest(
        state,
        { id: "bc-offline", target: "pool", poolName: "gpu", userId: 321 },
        NOW + 30,
      ),
    );
    state = follow.state;
    expect(follow.request.claimedWorkerId).toBe("pw_gpu");
    expect(follow.request.wakeTimeoutMs).toBe(2_000);
    expect(state.events.some((event) => event.event === "claimed_offline")).toBe(true);

    state = expireSelfHostedClaims(state, NOW + 30 + 2_001);
    expect(
      state.events.filter((event) => event.event === "created").length,
    ).toBeGreaterThanOrEqual(2);

    const abandoned = unwrap(
      enqueueSelfHostedRequest(state, { id: "bc-gone", target: "pool", poolName: "gpu", userId: 1 }, NOW + 40),
    );
    state = expireUnclaimedRequest(abandoned.state, "bc-gone", NOW + 50);
    expect(state.events.some((event) => event.event === "expired" && (event.data as { id: string }).id === "bc-gone")).toBe(
      true,
    );

    const expired = watchSelfHostedPending(state, {
      cursor: listed.streamCursor,
      nowMs: NOW + CLOUD_CURSOR_TTL,
      pool: "gpu",
    });
    expect(isFailure(expired) && expired.code).toBe("cursor_expired");
    const relisted = listSelfHostedPending(state, { nowMs: NOW + CLOUD_CURSOR_TTL, pool: "gpu" });
    expect(relisted.streamCursor).not.toBe(listed.streamCursor);
  });

  it("rejects a second claim until release, then lets a fresh worker take the request", () => {
    let state = setSelfHostedPolicy(emptySelfHostedState(), "allow");
    state = unwrap(
      enqueueSelfHostedRequest(state, { id: "bc-claim", target: "pool", poolName: "default", userId: 1 }, NOW),
    ).state;
    state = unwrap(claimSelfHostedRequest(state, { id: "bc-claim", workerId: "pw_a" }, NOW)).state;
    const conflict = claimSelfHostedRequest(state, { id: "bc-claim", workerId: "pw_b" }, NOW);
    expect(isFailure(conflict) && conflict.code).toBe("claim_conflict");
    state = releaseSelfHostedClaim(state, { id: "bc-claim", nowMs: NOW + 1 }).state;
    const claimed = unwrap(claimSelfHostedRequest(state, { id: "bc-claim", workerId: "pw_b" }, NOW + 2));
    expect(claimed.workerId).toBe("pw_b");
  });

  it("requires an admin allow/require decision and shows billing, network, artifact, and secret differences", () => {
    expect(selfHostedLaunchPreview({ policy: "off", target: "pool" }).allowed).toBe(false);
    expect(selfHostedLaunchPreview({ policy: "require", target: "cloud" }).allowed).toBe(false);
    const preview = selfHostedLaunchPreview({ policy: "allow", target: "pool" });
    expect(preview.allowed).toBe(true);
    expect(preview.hosting).toBe("self-hosted");
    expect(preview.differences.map((row) => row.area)).toEqual([
      "permission",
      "billing",
      "network",
      "artifact",
      "secret",
    ]);
    expect(preview.differences.find((row) => row.area === "billing")?.billedDimensions).toEqual([
      "model-tokens",
      "artifacts-transfer",
    ]);
    expect(preview.differences.find((row) => row.area === "network")?.selfHosted).toMatch(/outbound only/i);
  });

  it("answers health, readiness, and metrics for an outbound worker", () => {
    const state = unwrap(
      connectSelfHostedWorker(
        setSelfHostedPolicy(emptySelfHostedState(), "allow"),
        {
          kind: "personal",
          workerId: "desk",
          workspaceRoots: ["/Users/dev/app", "/Users/dev/infra"],
          computerUse: true,
          identitySocket: true,
          secretSync: true,
          cloneGitRepos: true,
          managementAddr: "127.0.0.1:8080",
        },
        NOW,
        user,
      ),
    );
    expect(state.worker.outboundOnly).toBe(true);
    expect(state.worker.workspaceRoots).toHaveLength(2);
    expect(state.worker.mintGithubToken).toBe(true);
    expect(state.worker.identitySocket).toBe(true);
    expect(workerManagementBody("/healthz", state.worker).status).toBe(200);
    expect(workerManagementBody("/readyz", state.worker).body).toBe("ready\n");
    expect(workerManagementBody("/metrics", state.worker).body).toMatch(/t3_self_hosted_worker_computer_use 1/);
  });
});

const CLOUD_CURSOR_TTL = 5 * 60 * 1000 + 1;
