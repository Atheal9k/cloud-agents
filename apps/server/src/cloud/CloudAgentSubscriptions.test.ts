import {
  type CloudAgentsApiPrincipal,
  type CloudAgentsApiRun,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudAgentSubscriptions from "./CloudAgentSubscriptions.ts";
import { apiError } from "./cloudAgentsApiModel.ts";

const principal: CloudAgentsApiPrincipal = {
  principalId: "service:test",
  kind: "service_account",
  apiKeyName: "Subscriptions",
  createdAt: "2026-09-19T00:00:00.000Z",
};

const origin = "http://controller.test";

it.effect("wakes an idle agent from subscriptions with idempotent receipts", () =>
  Effect.gen(function* () {
    const runs = yield* Ref.make(new Map<string, CloudAgentsApiRun>());
    const calls = yield* Ref.make(0);
    const agentStatus = yield* Ref.make<"IDLE" | "ACTIVE" | "ARCHIVED">("IDLE");
    const failPlacement = yield* Ref.make(false);
    const hidePersistedRun = yield* Ref.make(false);

    const getAgent: CloudAgentsApi.CloudAgentsApi["Service"]["getAgent"] = () =>
      Effect.gen(function* () {
        const status = yield* Ref.get(agentStatus);
        return {
          id: "bc-durable",
          name: "Durable agent",
          status,
          env: { type: "cloud" as const },
          repos: [{ url: "https://github.com/acme/app" }],
          url: `${origin}/cloud-agents/bc-durable`,
          createdAt: "2026-09-19T00:00:00.000Z",
          updatedAt: "2026-09-19T00:00:00.000Z",
          ...(status === "ACTIVE" ? { latestRunId: "run-live" } : {}),
        };
      });

    const getRun: CloudAgentsApi.CloudAgentsApi["Service"]["getRun"] = ({ runId }) =>
      Effect.gen(function* () {
        if (yield* Ref.get(hidePersistedRun)) {
          return yield* Effect.fail(apiError("run_not_found", `Run '${runId}' was not found.`));
        }
        const run = (yield* Ref.get(runs)).get(runId);
        return run === undefined
          ? yield* Effect.fail(apiError("run_not_found", `Run '${runId}' was not found.`))
          : run;
      });

    const createRun: CloudAgentsApi.CloudAgentsApi["Service"]["createRun"] = (input) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (count) => count + 1);
        if (yield* Ref.get(failPlacement)) {
          return yield* Effect.fail(apiError("internal_error", "placement failed"));
        }
        const now = "2026-09-19T00:01:00.000Z";
        const run: CloudAgentsApiRun = {
          id: `run-${input.requestId}`,
          agentId: input.agentId,
          status: "CREATING",
          createdAt: now,
          updatedAt: now,
        };
        yield* Ref.update(runs, (current) => new Map(current).set(run.id, run));
        return { run };
      });

    yield* Effect.gen(function* () {
      const subscriptions = yield* CloudAgentSubscriptions.CloudAgentSubscriptions;
      const created = yield* subscriptions.create({
        principal,
        agentId: "bc-durable",
        urlOrigin: origin,
        definition: {
          kind: "github_pr",
          target: { type: "github_pr", repository: "acme/app", pullRequest: 12 },
        },
      });
      expect(created.status).toBe("active");

      const first = yield* subscriptions.deliver({
        principal,
        agentId: "bc-durable",
        subscriptionId: created.id,
        urlOrigin: origin,
        delivery: { deliveryId: "evt-1" },
      });
      expect(first).toMatchObject({ kind: "persisted", acknowledged: true, agentId: "bc-durable" });
      expect(first.runId).toBeDefined();
      expect(yield* Ref.get(calls)).toBe(1);

      const replay = yield* subscriptions.deliver({
        principal,
        agentId: "bc-durable",
        subscriptionId: created.id,
        urlOrigin: origin,
        delivery: { deliveryId: "evt-1" },
      });
      expect(replay.id).toBe(first.id);
      expect(yield* Ref.get(calls)).toBe(1);

      const burst = yield* subscriptions.deliver({
        principal,
        agentId: "bc-durable",
        subscriptionId: created.id,
        urlOrigin: origin,
        delivery: { deliveryId: "evt-2" },
      });
      expect(burst).toMatchObject({ kind: "coalesced", acknowledged: true, runId: first.runId });
      expect(yield* Ref.get(calls)).toBe(1);

      yield* Ref.set(agentStatus, "ARCHIVED");
      const afterArchive = yield* subscriptions.list({
        principal,
        agentId: "bc-durable",
        urlOrigin: origin,
      });
      expect(afterArchive.items[0]?.status).toBe("disabled");
      const archivedDelivery = yield* subscriptions.deliver({
        principal,
        agentId: "bc-durable",
        subscriptionId: created.id,
        urlOrigin: origin,
        delivery: { deliveryId: "evt-archived" },
      });
      expect(archivedDelivery).toMatchObject({ kind: "skipped", acknowledged: false });

      yield* Ref.set(agentStatus, "IDLE");
      expect(
        (yield* subscriptions.list({ principal, agentId: "bc-durable", urlOrigin: origin }))
          .items[0]?.status,
      ).toBe("active");

      yield* subscriptions.remove({
        principal,
        agentId: "bc-durable",
        subscriptionId: created.id,
        urlOrigin: origin,
      });
      expect(
        (yield* subscriptions.list({ principal, agentId: "bc-durable", urlOrigin: origin }))
          .items[0]?.status,
      ).toBe("cancelled");
      expect(
        (
          yield* subscriptions.listReceipts({
            principal,
            agentId: "bc-durable",
            subscriptionId: created.id,
            limit: 20,
          })
        ).items.some((receipt) => receipt.kind === "persisted" && receipt.acknowledged),
      ).toBe(true);

      const ci = yield* subscriptions.create({
        principal,
        agentId: "bc-durable",
        urlOrigin: origin,
        definition: {
          kind: "github_ci",
          target: { type: "github_ci", repository: "acme/app", pullRequest: 12 },
        },
      });
      const skippedHuman = yield* subscriptions.deliver({
        principal,
        agentId: "bc-durable",
        subscriptionId: ci.id,
        urlOrigin: origin,
        delivery: {
          deliveryId: "ci-human",
          ci: {
            prCreatedByAgent: true,
            pusher: "human",
            explicitUserFollowUp: false,
            preExistingBaseFailure: false,
          },
        },
      });
      expect(skippedHuman).toMatchObject({
        kind: "skipped",
        acknowledged: false,
        message: "CI autofix skips human pushes.",
      });

      yield* Ref.set(failPlacement, true);
      const retryable = yield* subscriptions.deliver({
        principal,
        agentId: "bc-durable",
        subscriptionId: ci.id,
        urlOrigin: origin,
        delivery: {
          deliveryId: "ci-fail",
          ci: {
            prCreatedByAgent: true,
            pusher: "agent",
            explicitUserFollowUp: false,
            preExistingBaseFailure: false,
          },
        },
      });
      expect(retryable).toMatchObject({ kind: "retryable", acknowledged: false });
      expect(retryable).not.toHaveProperty("runId");

      yield* Ref.set(failPlacement, false);
      yield* Ref.set(hidePersistedRun, true);
      const unacked = yield* subscriptions.deliver({
        principal,
        agentId: "bc-durable",
        subscriptionId: ci.id,
        urlOrigin: origin,
        delivery: {
          deliveryId: "ci-unacked",
          ci: {
            prCreatedByAgent: true,
            pusher: "agent",
            explicitUserFollowUp: false,
            preExistingBaseFailure: false,
          },
        },
      });
      expect(unacked).toMatchObject({ kind: "retryable", acknowledged: false });

      yield* Ref.set(hidePersistedRun, false);
      const timer = yield* subscriptions.create({
        principal,
        agentId: "bc-durable",
        urlOrigin: origin,
        definition: {
          kind: "timer",
          target: { type: "timer", runAt: "2026-09-18T00:00:00.000Z" },
          prompt: { text: "Check the idle agent." },
        },
      });
      yield* subscriptions.reconcile(Date.parse("2026-09-19T00:00:00.000Z"));
      expect(
        (
          yield* subscriptions.listReceipts({
            principal,
            agentId: "bc-durable",
            subscriptionId: timer.id,
            limit: 10,
          })
        ).items[0],
      ).toMatchObject({ kind: "persisted", acknowledged: true });
    }).pipe(
      Effect.provide(
        CloudAgentSubscriptions.layer.pipe(
          Layer.provideMerge(
            Layer.mock(CloudAgentsApi.CloudAgentsApi)({ getAgent, getRun, createRun }),
          ),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ),
    );
  }),
);
