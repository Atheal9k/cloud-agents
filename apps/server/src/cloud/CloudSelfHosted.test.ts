import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudSelfHosted from "./CloudSelfHosted.ts";

const live = CloudSelfHosted.layer.pipe(
  Layer.provideMerge(CloudAgentsApiKeys.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect("persists a pool at scale-to-zero and recovers a claimed-offline follow-up", () =>
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const hosted = yield* CloudSelfHosted.CloudSelfHosted;
    const service = yield* keys.create({ name: "pools", kind: "service_account" });
    const principal = (yield* keys.authenticate(service.token))!;
    yield* hosted.setPolicy("allow");
    yield* hosted.registerPool(
      { scope: "team", poolName: "gpu", workerReadyTimeoutSeconds: 5 },
      principal,
    );
    yield* hosted.connectWorker(
      { kind: "team_pool", poolName: "gpu", workerId: "pw_1", workspaceRoots: ["/work/app"] },
      principal,
    );
    const user = yield* keys.create({ name: "dev", kind: "user", userEmail: "dev@example.com" });
    const userPrincipal = (yield* keys.authenticate(user.token))!;
    yield* hosted.enqueue({
      id: "bc-1",
      target: "pool",
      poolName: "gpu",
      principal: userPrincipal,
    });
    yield* hosted.claim({ id: "bc-1", workerId: "pw_1" });
    yield* hosted.idleRelease("pw_1");
    const follow = yield* hosted.enqueue({
      id: "bc-1",
      target: "pool",
      poolName: "gpu",
      principal: userPrincipal,
    });
    expect(follow.claimedWorkerId).toBe("pw_1");
    expect(follow.wakeTimeoutMs).toBeGreaterThan(0);
    const pools = yield* hosted.listPools({});
    expect(pools.pools[0]).toMatchObject({ poolName: "gpu", connectedWorkerCount: 0 });
  }).pipe(Effect.provide(live)),
);
