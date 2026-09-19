// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CloudGithubTriggerDefinition,
  type CloudAgentsApiPrincipal,
  type CloudAgentsApiRun,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudGithubTriggers from "./CloudGithubTriggers.ts";
import { apiError } from "./cloudAgentsApiModel.ts";

const principal: CloudAgentsApiPrincipal = {
  principalId: "service:test",
  kind: "service_account",
  apiKeyName: "GitHub webhook",
  createdAt: "2026-09-19T00:00:00.000Z",
};

const definition = Schema.decodeSync(CloudGithubTriggerDefinition)({
  repository: "acme/app",
  agentId: "bc-durable",
  authorizedActors: ["octocat", "github-actions[bot]"],
  events: ["pull_request_review", "check_run"],
  limits: {
    maxAttempts: 1,
    runSeconds: 600,
    inputWaitSeconds: 60,
    maxComputeSeconds: 600,
  },
});

const calls: Array<Parameters<CloudAgentsApi.CloudAgentsApi["Service"]["createRun"]>[0]> = [];
const runs = new Map<string, CloudAgentsApiRun>();
const storedSecrets = new Map<string, Uint8Array>();

const getRun: CloudAgentsApi.CloudAgentsApi["Service"]["getRun"] = ({ runId }) => {
  const run = runs.get(runId);
  return run === undefined
    ? Effect.fail(apiError("run_not_found", `Run '${runId}' was not found.`))
    : Effect.succeed(run);
};

const createRun: CloudAgentsApi.CloudAgentsApi["Service"]["createRun"] = (input) =>
  Effect.sync(() => {
    calls.push(input);
    const now = "2026-09-19T00:00:00.000Z";
    const run: CloudAgentsApiRun = {
      id: `run-${input.requestId}`,
      agentId: input.agentId,
      status: "RUNNING",
      createdAt: now,
      updatedAt: now,
    };
    runs.set(run.id, run);
    return { run };
  });

const getAgent: CloudAgentsApi.CloudAgentsApi["Service"]["getAgent"] = () =>
  Effect.succeed({
    id: "bc-durable",
    name: "Durable repair agent",
    status: "IDLE",
    env: { type: "cloud" },
    repos: [{ url: "https://github.com/acme/app" }],
    url: "http://controller.test/cloud-agents/bc-durable",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  });

const apiLayer = Layer.mock(CloudAgentsApi.CloudAgentsApi)({ getAgent, getRun, createRun });

const secretLayer = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(storedSecrets.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        storedSecrets.set(name, Uint8Array.from(value));
      }),
    create: (name, value) =>
      Effect.sync(() => {
        storedSecrets.set(name, Uint8Array.from(value));
      }),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) =>
      Effect.sync(() => {
        storedSecrets.delete(name);
      }),
  }),
);

const live = CloudGithubTriggers.layer.pipe(
  Layer.provideMerge(apiLayer),
  Layer.provideMerge(secretLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

function reviewBody(input: {
  readonly delivery: string;
  readonly sha: string;
  readonly actor?: string;
  readonly actorType?: string;
  readonly repository?: string;
  readonly number?: number;
}): string {
  const number = input.number ?? 42;
  return JSON.stringify({
    action: "submitted",
    sender: { login: input.actor ?? "octocat", type: input.actorType ?? "User" },
    repository: {
      full_name: input.repository ?? "acme/app",
      html_url: "https://github.com/acme/app",
      default_branch: "main",
    },
    pull_request: {
      number,
      title: "Fix checkout",
      body: "Keep the change small.",
      html_url: `https://github.com/acme/app/pull/${number}`,
      head: { sha: input.sha, ref: "fix/checkout" },
    },
    review: {
      id: input.delivery,
      body: "Please cover the retry path.",
      state: "changes_requested",
      html_url: `https://github.com/acme/app/pull/${number}#review-${input.delivery}`,
    },
  });
}

function signature(secret: string, body: string): string {
  return `sha256=${NodeCrypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function checkRunBody(): string {
  return JSON.stringify({
    action: "completed",
    sender: { login: "github-actions[bot]", type: "Bot" },
    repository: {
      full_name: "acme/app",
      html_url: "https://github.com/acme/app",
      default_branch: "main",
    },
    check_run: {
      id: 99,
      name: "test",
      head_sha: "head-check",
      html_url: "https://github.com/acme/app/actions/runs/99",
      conclusion: "failure",
      pull_requests: [{ number: 43 }],
    },
  });
}

it.effect("authenticates, bounds, deduplicates, controls, and reports GitHub repairs", () =>
  Effect.gen(function* () {
    calls.length = 0;
    runs.clear();
    storedSecrets.clear();
    const triggers = yield* CloudGithubTriggers.CloudGithubTriggers;
    const created = yield* triggers.create({
      principal,
      definition,
      urlOrigin: "https://controller.test",
    });
    expect(created.trigger.webhookUrl).toBe(
      `https://controller.test/v1/integrations/github/webhooks/${created.trigger.id}`,
    );
    expect((yield* triggers.list({ principal })).items[0]).not.toHaveProperty("secret");

    const body = reviewBody({ delivery: "review-1", sha: "head-one" });
    const invalidSignature = yield* triggers
      .receive({
        triggerId: created.trigger.id,
        deliveryId: "delivery-invalid",
        event: "pull_request_review",
        signature: "sha256=invalid",
        body,
      })
      .pipe(Effect.flip);
    expect(invalidSignature.code).toBe("unauthorized");

    const admitted = yield* triggers.receive({
      triggerId: created.trigger.id,
      deliveryId: "delivery-1",
      event: "pull_request_review",
      signature: signature(created.secret, body),
      body,
    });
    expect(admitted).toMatchObject({ status: "triggered", reused: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agentId: "bc-durable",
      selectedRef: "head-one",
      limits: { runSeconds: 600, inputWaitSeconds: 60 },
    });
    expect(calls[0]?.body.prompt.text).toContain("Do not widen credentials or permissions");

    const duplicate = yield* triggers.receive({
      triggerId: created.trigger.id,
      deliveryId: "delivery-1",
      event: "pull_request_review",
      signature: signature(created.secret, body),
      body,
    });
    expect(duplicate.reused).toBe(true);
    expect(calls).toHaveLength(1);

    const strangerBody = reviewBody({
      delivery: "review-stranger",
      sha: "head-one",
      actor: "stranger",
    });
    expect(
      yield* triggers.receive({
        triggerId: created.trigger.id,
        deliveryId: "delivery-stranger",
        event: "pull_request_review",
        signature: signature(created.secret, strangerBody),
        body: strangerBody,
      }),
    ).toMatchObject({
      status: "ignored",
      message: expect.stringContaining("not authorized"),
    });

    const wrongRepositoryBody = reviewBody({
      delivery: "review-wrong-repository",
      sha: "head-one",
      repository: "other/app",
    });
    expect(
      yield* triggers.receive({
        triggerId: created.trigger.id,
        deliveryId: "delivery-wrong-repository",
        event: "pull_request_review",
        signature: signature(created.secret, wrongRepositoryBody),
        body: wrongRepositoryBody,
      }),
    ).toMatchObject({
      status: "ignored",
      message: expect.stringContaining("not authorized"),
    });

    const botBody = reviewBody({
      delivery: "review-bot",
      sha: "head-one",
      actor: "github-actions[bot]",
      actorType: "Bot",
    });
    expect(
      yield* triggers.receive({
        triggerId: created.trigger.id,
        deliveryId: "delivery-bot",
        event: "pull_request_review",
        signature: signature(created.secret, botBody),
        body: botBody,
      }),
    ).toMatchObject({ status: "ignored", message: expect.stringContaining("Bot actor") });

    const boundedBody = reviewBody({ delivery: "review-2", sha: "head-one" });
    expect(
      yield* triggers.receive({
        triggerId: created.trigger.id,
        deliveryId: "delivery-2",
        event: "pull_request_review",
        signature: signature(created.secret, boundedBody),
        body: boundedBody,
      }),
    ).toMatchObject({
      status: "unresolved",
      message: expect.stringContaining("attempt limit"),
    });
    expect(calls).toHaveLength(1);

    yield* triggers.disable({ principal, triggerId: created.trigger.id });
    expect(
      yield* triggers.receive({
        triggerId: created.trigger.id,
        deliveryId: "delivery-1",
        event: "pull_request_review",
        signature: signature(created.secret, body),
        body,
      }),
    ).toMatchObject({ status: "triggered", reused: true });
    const disabled = yield* triggers
      .receive({
        triggerId: created.trigger.id,
        deliveryId: "delivery-disabled",
        event: "pull_request_review",
        signature: signature(created.secret, boundedBody),
        body: boundedBody,
      })
      .pipe(Effect.flip);
    expect(disabled.message).toContain("disabled");

    yield* triggers.enable({ principal, triggerId: created.trigger.id });
    const failedCheck = checkRunBody();
    expect(
      yield* triggers.receive({
        triggerId: created.trigger.id,
        deliveryId: "delivery-check",
        event: "check_run",
        signature: signature(created.secret, failedCheck),
        body: failedCheck,
      }),
    ).toMatchObject({ status: "triggered" });
    const nextBody = reviewBody({ delivery: "review-3", sha: "head-two", number: 44 });
    const next = yield* triggers.receive({
      triggerId: created.trigger.id,
      deliveryId: "delivery-3",
      event: "pull_request_review",
      signature: signature(created.secret, nextBody),
      body: nextBody,
    });
    expect(next.status).toBe("triggered");
    if (next.runId === undefined) throw new Error("Expected the admitted run id.");
    const nextRun = runs.get(next.runId);
    if (nextRun === undefined) throw new Error("Expected the admitted run.");
    runs.set(nextRun.id, { ...nextRun, status: "ERROR" });
    expect(
      (yield* triggers.listActivities({
        principal,
        triggerId: created.trigger.id,
        limit: 20,
      })).items.find((item) => item.deliveryId === "delivery-3"),
    ).toMatchObject({ status: "unresolved", message: expect.stringContaining("ERROR") });

    yield* triggers.remove({ principal, triggerId: created.trigger.id });
    expect((yield* triggers.list({ principal })).items[0]?.status).toBe("revoked");
    expect(
      (yield* triggers.listActivities({
        principal,
        triggerId: created.trigger.id,
        limit: 20,
      })).items.length,
    ).toBeGreaterThan(0);
    expect(storedSecrets.size).toBe(0);
    const revoked = yield* triggers
      .enable({ principal, triggerId: created.trigger.id })
      .pipe(Effect.flip);
    expect(revoked.message).toContain("revoked");
  }).pipe(Effect.provide(live)),
);
