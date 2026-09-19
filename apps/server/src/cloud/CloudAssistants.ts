// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CloudAssistantCreateRequest,
  CloudAssistantDefinition,
  CloudAssistantMemorySource,
  type CloudAgentStatus,
  type CloudAgentsApiCreateRunRequest,
  type CloudAgentsApiPrincipal,
  type CloudAssistant,
  type CloudAssistantCredentialEffect,
  type CloudAssistantLifecycleAction,
  type CloudAssistantMemoryFact,
  type CloudAssistantMemoryWrite,
  type CloudAssistantPersistenceKind,
  type CloudAssistantSnapshotEffect,
  type CloudAssistantSubscription,
  type CloudAssistantSubscriptionKind,
  type CloudAssistantSubscriptionStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import { CloudAgentsApiFailure, apiError, isActiveRunStatus } from "./cloudAgentsApiModel.ts";
import {
  assertPersistenceIsolation,
  assertWorkspaceOwner,
  cloudAssistantLifecycleEffects,
  composeAssistantRunPrompt,
  decryptCloudAssistantBlob,
  encryptCloudAssistantBlob,
  mintCloudAssistantDataKey,
  persistenceOptedIn,
  validateCloudAssistantDefinition,
  validateCloudAssistantMemory,
} from "./cloudAssistantPolicy.ts";

type AssistantRow = {
  readonly assistantId: string;
  readonly principalId: string;
  readonly workspaceOwner: string;
  readonly definitionJson: string;
  readonly dataKey: string;
  readonly agentId: string | null;
  readonly status: CloudAgentStatus;
  readonly credentials: CloudAssistantCredentialEffect;
  readonly snapshots: CloudAssistantSnapshotEffect;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type MemoryRow = {
  readonly factId: string;
  readonly assistantId: string;
  readonly text: string;
  readonly sourceJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type PersistenceRow = {
  readonly assistantId: string;
  readonly kind: CloudAssistantPersistenceKind;
  readonly ciphertext: string;
  readonly updatedAt: string;
};

type SubscriptionRow = {
  readonly subscriptionId: string;
  readonly kind: CloudAssistantSubscriptionKind;
  readonly status: CloudAssistantSubscriptionStatus;
};

const decodeDefinition = Schema.decodeUnknownSync(Schema.fromJsonString(CloudAssistantDefinition));
const encodeDefinition = Schema.encodeSync(Schema.fromJsonString(CloudAssistantDefinition));
const decodeSource = Schema.decodeUnknownSync(Schema.fromJsonString(CloudAssistantMemorySource));
const encodeSource = Schema.encodeSync(Schema.fromJsonString(CloudAssistantMemorySource));
const decodeCreate = Schema.decodeUnknownSync(CloudAssistantCreateRequest);

export class CloudAssistants extends Context.Service<
  CloudAssistants,
  {
    readonly create: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly definition: CloudAssistantCreateRequest;
    }) => Effect.Effect<CloudAssistant, CloudAgentsApiFailure>;
    readonly list: (input: {
      readonly principal: CloudAgentsApiPrincipal;
    }) => Effect.Effect<{ readonly items: ReadonlyArray<CloudAssistant> }, CloudAgentsApiFailure>;
    readonly get: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
    }) => Effect.Effect<CloudAssistant, CloudAgentsApiFailure>;
    readonly replace: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
      readonly definition: CloudAssistantCreateRequest;
    }) => Effect.Effect<CloudAssistant, CloudAgentsApiFailure>;
    readonly listMemory: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<CloudAssistantMemoryFact> },
      CloudAgentsApiFailure
    >;
    readonly writeMemory: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
      readonly fact: CloudAssistantMemoryWrite;
    }) => Effect.Effect<CloudAssistantMemoryFact, CloudAgentsApiFailure>;
    readonly replaceMemory: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
      readonly factId: string;
      readonly fact: CloudAssistantMemoryWrite;
    }) => Effect.Effect<CloudAssistantMemoryFact, CloudAgentsApiFailure>;
    readonly deleteMemory: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
      readonly factId: string;
    }) => Effect.Effect<{ readonly id: string }, CloudAgentsApiFailure>;
    readonly putPersistence: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
      readonly kind: CloudAssistantPersistenceKind;
      readonly plaintext: string;
    }) => Effect.Effect<{ readonly kind: CloudAssistantPersistenceKind }, CloudAgentsApiFailure>;
    readonly getPersistence: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
      readonly kind: CloudAssistantPersistenceKind;
    }) => Effect.Effect<{ readonly plaintext: string }, CloudAgentsApiFailure>;
    readonly attachSubscription: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
      readonly subscription: CloudAssistantSubscription;
    }) => Effect.Effect<CloudAssistant, CloudAgentsApiFailure>;
    readonly archive: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
    }) => Effect.Effect<CloudAssistant, CloudAgentsApiFailure>;
    readonly unarchive: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
    }) => Effect.Effect<CloudAssistant, CloudAgentsApiFailure>;
    readonly reset: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
    }) => Effect.Effect<CloudAssistant, CloudAgentsApiFailure>;
    readonly remove: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
    }) => Effect.Effect<{ readonly id: string }, CloudAgentsApiFailure>;
    readonly createRun: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly assistantId: string;
      readonly body: CloudAgentsApiCreateRunRequest;
      readonly urlOrigin: string;
    }) => Effect.Effect<
      { readonly assistant: CloudAssistant; readonly agentId: string; readonly runId: string },
      CloudAgentsApiFailure
    >;
  }
>()("t3/cloud/CloudAssistants") {}

function nowIso(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}

function persistenceFailure(): CloudAgentsApiFailure {
  return apiError("internal_error", "The cloud assistant catalog is unavailable.");
}

function missing(assistantId: string): CloudAgentsApiFailure {
  return apiError("assistant_not_found", `Assistant '${assistantId}' was not found.`);
}

function invalid(message: string): CloudAgentsApiFailure {
  return apiError("invalid_request", message);
}

const make = Effect.fn("CloudAssistants.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const api = yield* CloudAgentsApi.CloudAgentsApi;
  const mutex = yield* Semaphore.make(1);

  const load = (principalId: string, assistantId: string) =>
    sql<AssistantRow>`
      SELECT assistant_id AS "assistantId", principal_id AS "principalId",
             workspace_owner AS "workspaceOwner", definition_json AS "definitionJson",
             data_key AS "dataKey", agent_id AS "agentId", status, credentials, snapshots,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM cloud_assistants
      WHERE assistant_id = ${assistantId} AND principal_id = ${principalId}
    `.pipe(
      Effect.mapError(() => persistenceFailure()),
      Effect.flatMap((rows) => {
        const row = rows[0];
        return row === undefined ? Effect.fail(missing(assistantId)) : Effect.succeed(row);
      }),
    );

  const loadMemory = (assistantId: string) =>
    sql<MemoryRow>`
      SELECT fact_id AS "factId", assistant_id AS "assistantId", text,
             source_json AS "sourceJson", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM cloud_assistant_memory
      WHERE assistant_id = ${assistantId}
      ORDER BY updated_at DESC
    `.pipe(Effect.orElseSucceed(() => [] as MemoryRow[]));

  const loadSubscriptions = (assistantId: string) =>
    sql<SubscriptionRow>`
      SELECT subscription_id AS "subscriptionId", kind, status
      FROM cloud_assistant_subscriptions
      WHERE assistant_id = ${assistantId}
      ORDER BY subscription_id ASC
    `.pipe(Effect.orElseSucceed(() => [] as SubscriptionRow[]));

  const publicMemory = (row: MemoryRow): CloudAssistantMemoryFact => ({
    id: row.factId,
    text: row.text,
    source: decodeSource(row.sourceJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const publicAssistant = (row: AssistantRow, subscriptions: ReadonlyArray<SubscriptionRow>) => {
    const definition = decodeDefinition(row.definitionJson);
    const action: CloudAssistantLifecycleAction =
      row.status === "ARCHIVED" ? "archive" : row.credentials === "revoked" ? "delete" : "idle";
    return {
      id: row.assistantId,
      status: row.status,
      definition,
      workspaceOwner: row.workspaceOwner,
      ...(row.agentId === null ? {} : { agentId: row.agentId }),
      subscriptions: subscriptions.map((item) => ({
        id: item.subscriptionId,
        kind: item.kind,
        status: item.status,
      })),
      credentials: row.credentials,
      snapshots: row.snapshots,
      lifecycle: cloudAssistantLifecycleEffects({ action, definition }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies CloudAssistant;
  };

  const requireOwner = (row: AssistantRow, principal: CloudAgentsApiPrincipal) => {
    const denied = assertWorkspaceOwner({
      workspaceOwner: row.workspaceOwner,
      principalId: principal.principalId,
    });
    return denied === undefined
      ? Effect.void
      : Effect.fail(apiError("follow_up_forbidden", denied));
  };

  const locate = (principal: CloudAgentsApiPrincipal, assistantId: string) =>
    Effect.gen(function* () {
      const row = yield* load(principal.principalId, assistantId);
      yield* requireOwner(row, principal);
      const subscriptions = yield* loadSubscriptions(assistantId);
      return { row, subscriptions, assistant: publicAssistant(row, subscriptions) };
    });

  const create: CloudAssistants["Service"]["create"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const definition = decodeCreate(input.definition);
        const invalidDefinition = validateCloudAssistantDefinition(definition);
        if (invalidDefinition !== undefined) {
          return yield* Effect.fail(invalid(invalidDefinition));
        }
        const now = nowIso();
        const assistantId = `asst-${NodeCrypto.randomUUID()}`;
        yield* sql`
          INSERT INTO cloud_assistants (
            assistant_id, principal_id, workspace_owner, definition_json, data_key,
            agent_id, status, credentials, snapshots, created_at, updated_at
          ) VALUES (
            ${assistantId}, ${input.principal.principalId}, ${input.principal.principalId},
            ${encodeDefinition(definition)}, ${mintCloudAssistantDataKey()},
            NULL, ${"IDLE"}, ${"retained"}, ${"retained"}, ${now}, ${now}
          )
        `.pipe(Effect.mapError(() => persistenceFailure()));
        return (yield* locate(input.principal, assistantId)).assistant;
      }),
    );

  const list: CloudAssistants["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<AssistantRow>`
        SELECT assistant_id AS "assistantId", principal_id AS "principalId",
               workspace_owner AS "workspaceOwner", definition_json AS "definitionJson",
               data_key AS "dataKey", agent_id AS "agentId", status, credentials, snapshots,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM cloud_assistants
        WHERE principal_id = ${input.principal.principalId}
        ORDER BY updated_at DESC
      `.pipe(Effect.mapError(() => persistenceFailure()));
      const items = yield* Effect.forEach(rows, (row) =>
        loadSubscriptions(row.assistantId).pipe(
          Effect.map((subscriptions) => publicAssistant(row, subscriptions)),
        ),
      );
      return { items };
    });

  const get: CloudAssistants["Service"]["get"] = (input) =>
    locate(input.principal, input.assistantId).pipe(Effect.map((found) => found.assistant));

  const replace: CloudAssistants["Service"]["replace"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* locate(input.principal, input.assistantId);
        if (found.row.status === "ARCHIVED") {
          return yield* Effect.fail(
            apiError("agent_archived", `Assistant '${input.assistantId}' is archived.`),
          );
        }
        const definition = decodeCreate(input.definition);
        const invalidDefinition = validateCloudAssistantDefinition(definition);
        if (invalidDefinition !== undefined) {
          return yield* Effect.fail(invalid(invalidDefinition));
        }
        const now = nowIso();
        yield* sql`
          UPDATE cloud_assistants
          SET definition_json = ${encodeDefinition(definition)}, updated_at = ${now}
          WHERE assistant_id = ${input.assistantId}
        `.pipe(Effect.mapError(() => persistenceFailure()));
        if (!definition.persistence.files) {
          yield* sql`
            DELETE FROM cloud_assistant_persistence
            WHERE assistant_id = ${input.assistantId} AND kind = 'files'
          `.pipe(Effect.catch(() => Effect.void));
        }
        if (!definition.persistence.browser) {
          yield* sql`
            DELETE FROM cloud_assistant_persistence
            WHERE assistant_id = ${input.assistantId} AND kind = 'browser'
          `.pipe(Effect.catch(() => Effect.void));
        }
        return (yield* locate(input.principal, input.assistantId)).assistant;
      }),
    );

  const listMemory: CloudAssistants["Service"]["listMemory"] = (input) =>
    Effect.gen(function* () {
      yield* locate(input.principal, input.assistantId);
      const rows = yield* loadMemory(input.assistantId);
      return { items: rows.map(publicMemory) };
    });

  const writeMemory: CloudAssistants["Service"]["writeMemory"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* locate(input.principal, input.assistantId);
        if (found.row.status === "ARCHIVED") {
          return yield* Effect.fail(
            apiError("agent_archived", `Assistant '${input.assistantId}' is archived.`),
          );
        }
        const invalidMemory = validateCloudAssistantMemory(input.fact);
        if (invalidMemory !== undefined) return yield* Effect.fail(invalid(invalidMemory));
        const now = nowIso();
        const factId = `mem-${NodeCrypto.randomUUID()}`;
        yield* sql`
          INSERT INTO cloud_assistant_memory (
            fact_id, assistant_id, principal_id, text, source_json, created_at, updated_at
          ) VALUES (
            ${factId}, ${input.assistantId}, ${input.principal.principalId},
            ${input.fact.text}, ${encodeSource(input.fact.source)}, ${now}, ${now}
          )
        `.pipe(Effect.mapError(() => persistenceFailure()));
        return {
          id: factId,
          text: input.fact.text,
          source: input.fact.source,
          createdAt: now,
          updatedAt: now,
        };
      }),
    );

  const replaceMemory: CloudAssistants["Service"]["replaceMemory"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* locate(input.principal, input.assistantId);
        const invalidMemory = validateCloudAssistantMemory(input.fact);
        if (invalidMemory !== undefined) return yield* Effect.fail(invalid(invalidMemory));
        const now = nowIso();
        const updated = yield* sql<{ readonly factId: string }>`
          UPDATE cloud_assistant_memory
          SET text = ${input.fact.text}, source_json = ${encodeSource(input.fact.source)},
              updated_at = ${now}
          WHERE fact_id = ${input.factId} AND assistant_id = ${input.assistantId}
          RETURNING fact_id AS "factId"
        `.pipe(Effect.mapError(() => persistenceFailure()));
        if (updated[0] === undefined) {
          return yield* Effect.fail(invalid(`Memory fact '${input.factId}' was not found.`));
        }
        const row = (yield* loadMemory(input.assistantId)).find(
          (item) => item.factId === input.factId,
        );
        return row === undefined
          ? yield* Effect.fail(invalid(`Memory fact '${input.factId}' was not found.`))
          : publicMemory(row);
      }),
    );

  const deleteMemory: CloudAssistants["Service"]["deleteMemory"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* locate(input.principal, input.assistantId);
        const deleted = yield* sql<{ readonly factId: string }>`
          DELETE FROM cloud_assistant_memory
          WHERE fact_id = ${input.factId} AND assistant_id = ${input.assistantId}
          RETURNING fact_id AS "factId"
        `.pipe(Effect.mapError(() => persistenceFailure()));
        if (deleted[0] === undefined) {
          return yield* Effect.fail(invalid(`Memory fact '${input.factId}' was not found.`));
        }
        return { id: input.factId };
      }),
    );

  const putPersistence: CloudAssistants["Service"]["putPersistence"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* locate(input.principal, input.assistantId);
        const isolated = assertPersistenceIsolation({
          ownerAssistantId: found.row.assistantId,
          requestedAssistantId: input.assistantId,
        });
        if (isolated !== undefined) return yield* Effect.fail(invalid(isolated));
        if (!persistenceOptedIn(found.assistant.definition, input.kind)) {
          return yield* Effect.fail(
            invalid(`Persistent ${input.kind} state is opt-in for this assistant.`),
          );
        }
        const encrypted = encryptCloudAssistantBlob({
          dataKey: found.row.dataKey,
          plaintext: input.plaintext,
        });
        if ("message" in encrypted) return yield* Effect.fail(invalid(encrypted.message));
        const now = nowIso();
        yield* sql`
          INSERT INTO cloud_assistant_persistence (assistant_id, kind, ciphertext, updated_at)
          VALUES (${input.assistantId}, ${input.kind}, ${encrypted.ciphertext}, ${now})
          ON CONFLICT(assistant_id, kind) DO UPDATE SET
            ciphertext = excluded.ciphertext,
            updated_at = excluded.updated_at
        `.pipe(Effect.mapError(() => persistenceFailure()));
        return { kind: input.kind };
      }),
    );

  const getPersistence: CloudAssistants["Service"]["getPersistence"] = (input) =>
    Effect.gen(function* () {
      const found = yield* locate(input.principal, input.assistantId);
      const isolated = assertPersistenceIsolation({
        ownerAssistantId: found.row.assistantId,
        requestedAssistantId: input.assistantId,
      });
      if (isolated !== undefined) return yield* Effect.fail(invalid(isolated));
      const rows = yield* sql<PersistenceRow>`
        SELECT assistant_id AS "assistantId", kind, ciphertext, updated_at AS "updatedAt"
        FROM cloud_assistant_persistence
        WHERE assistant_id = ${input.assistantId} AND kind = ${input.kind}
      `.pipe(Effect.mapError(() => persistenceFailure()));
      const row = rows[0];
      if (row === undefined) {
        return yield* Effect.fail(invalid(`No persistent ${input.kind} state is stored.`));
      }
      const decrypted = decryptCloudAssistantBlob({
        dataKey: found.row.dataKey,
        ciphertext: row.ciphertext,
      });
      if ("message" in decrypted) return yield* Effect.fail(invalid(decrypted.message));
      return { plaintext: decrypted.plaintext };
    });

  const attachSubscription: CloudAssistants["Service"]["attachSubscription"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* locate(input.principal, input.assistantId);
        if (found.row.status === "ARCHIVED") {
          return yield* Effect.fail(
            apiError("agent_archived", `Assistant '${input.assistantId}' is archived.`),
          );
        }
        const now = nowIso();
        const subscription = input.subscription;
        yield* sql`
          INSERT INTO cloud_assistant_subscriptions (
            assistant_id, subscription_id, kind, status, updated_at
          ) VALUES (
            ${input.assistantId}, ${subscription.id}, ${subscription.kind},
            ${subscription.status}, ${now}
          )
          ON CONFLICT(assistant_id, subscription_id) DO UPDATE SET
            kind = excluded.kind,
            status = excluded.status,
            updated_at = excluded.updated_at
        `.pipe(Effect.mapError(() => persistenceFailure()));
        return (yield* locate(input.principal, input.assistantId)).assistant;
      }),
    );

  const setSubscriptionStatus = (assistantId: string, status: CloudAssistantSubscriptionStatus) =>
    sql`
      UPDATE cloud_assistant_subscriptions
      SET status = ${status}, updated_at = ${nowIso()}
      WHERE assistant_id = ${assistantId} AND status != 'disabled'
    `.pipe(Effect.catch(() => Effect.void));

  const settleBoundAgent = (input: {
    readonly principal: CloudAgentsApiPrincipal;
    readonly agentId: string;
  }) =>
    Effect.gen(function* () {
      const runs = yield* api.listRuns({ principal: input.principal, agentId: input.agentId });
      yield* Effect.forEach(
        runs.items.filter((run) => isActiveRunStatus(run.status)),
        (run) =>
          api
            .cancelRun({
              principal: input.principal,
              agentId: input.agentId,
              runId: run.id,
            })
            .pipe(Effect.catch(() => Effect.void)),
        { discard: true },
      );
    });

  const archive: CloudAssistants["Service"]["archive"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* locate(input.principal, input.assistantId);
        if (found.row.agentId !== null) {
          yield* settleBoundAgent({ principal: input.principal, agentId: found.row.agentId });
          yield* api.archive({ principal: input.principal, agentId: found.row.agentId });
        }
        const now = nowIso();
        yield* sql`
          UPDATE cloud_assistants
          SET status = ${"ARCHIVED"}, updated_at = ${now}
          WHERE assistant_id = ${input.assistantId}
        `.pipe(Effect.mapError(() => persistenceFailure()));
        yield* setSubscriptionStatus(input.assistantId, "paused");
        return (yield* locate(input.principal, input.assistantId)).assistant;
      }),
    );

  const unarchive: CloudAssistants["Service"]["unarchive"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* locate(input.principal, input.assistantId);
        if (found.row.agentId !== null) {
          yield* api.unarchive({ principal: input.principal, agentId: found.row.agentId });
        }
        const now = nowIso();
        yield* sql`
          UPDATE cloud_assistants
          SET status = ${"IDLE"}, updated_at = ${now}
          WHERE assistant_id = ${input.assistantId}
        `.pipe(Effect.mapError(() => persistenceFailure()));
        yield* setSubscriptionStatus(input.assistantId, "enabled");
        return (yield* locate(input.principal, input.assistantId)).assistant;
      }),
    );

  const reset: CloudAssistants["Service"]["reset"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* locate(input.principal, input.assistantId);
        yield* sql`
          DELETE FROM cloud_assistant_memory WHERE assistant_id = ${input.assistantId}
        `.pipe(Effect.mapError(() => persistenceFailure()));
        yield* sql`
          DELETE FROM cloud_assistant_persistence WHERE assistant_id = ${input.assistantId}
        `.pipe(Effect.mapError(() => persistenceFailure()));
        yield* sql`
          UPDATE cloud_assistants SET updated_at = ${nowIso()}
          WHERE assistant_id = ${input.assistantId}
        `.pipe(Effect.catch(() => Effect.void));
        return (yield* locate(input.principal, input.assistantId)).assistant;
      }),
    );

  const remove: CloudAssistants["Service"]["remove"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* locate(input.principal, input.assistantId);
        if (found.row.agentId !== null) {
          yield* settleBoundAgent({ principal: input.principal, agentId: found.row.agentId });
          yield* api.deleteAgent({ principal: input.principal, agentId: found.row.agentId });
        }
        yield* sql`DELETE FROM cloud_assistant_memory WHERE assistant_id = ${input.assistantId}`.pipe(
          Effect.catch(() => Effect.void),
        );
        yield* sql`
          DELETE FROM cloud_assistant_persistence WHERE assistant_id = ${input.assistantId}
        `.pipe(Effect.catch(() => Effect.void));
        yield* sql`
          UPDATE cloud_assistant_subscriptions
          SET status = ${"disabled"}, updated_at = ${nowIso()}
          WHERE assistant_id = ${input.assistantId}
        `.pipe(Effect.catch(() => Effect.void));
        yield* sql`DELETE FROM cloud_assistant_subscriptions WHERE assistant_id = ${input.assistantId}`.pipe(
          Effect.catch(() => Effect.void),
        );
        yield* sql`DELETE FROM cloud_assistants WHERE assistant_id = ${input.assistantId}`.pipe(
          Effect.mapError(() => persistenceFailure()),
        );
        return { id: input.assistantId };
      }),
    );

  const createRun: CloudAssistants["Service"]["createRun"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* locate(input.principal, input.assistantId);
        if (found.row.status === "ARCHIVED") {
          return yield* Effect.fail(
            apiError("agent_archived", `Assistant '${input.assistantId}' is archived.`),
          );
        }
        const memory = (yield* loadMemory(input.assistantId)).map(publicMemory);
        const prompt = composeAssistantRunPrompt({
          instructions: found.assistant.definition.instructions,
          memory,
          prompt: input.body.prompt.text,
        });
        const limits = found.assistant.definition.limits;
        const model = found.assistant.definition.provider.model;
        const repos = found.assistant.definition.repositories.map((repository) => ({
          url: repository.url,
          ...(repository.startingRef === undefined ? {} : { startingRef: repository.startingRef }),
        }));
        if (found.row.agentId === null) {
          const created = yield* api.createAgent({
            principal: input.principal,
            urlOrigin: input.urlOrigin,
            body: {
              prompt: {
                text: prompt,
                ...(input.body.prompt.images === undefined
                  ? {}
                  : { images: input.body.prompt.images }),
              },
              name: found.assistant.definition.name,
              model,
              ...(repos.length === 0 ? {} : { repos }),
              ...(input.body.mode === undefined ? {} : { mode: input.body.mode }),
              ...(input.body.mcpServers === undefined ? {} : { mcpServers: input.body.mcpServers }),
            },
            limits,
          });
          const now = nowIso();
          const agentStatus = created.agent.status;
          yield* sql`
            UPDATE cloud_assistants
            SET agent_id = ${created.agent.id}, status = ${agentStatus}, updated_at = ${now}
            WHERE assistant_id = ${input.assistantId}
          `.pipe(Effect.mapError(() => persistenceFailure()));
          return {
            assistant: (yield* locate(input.principal, input.assistantId)).assistant,
            agentId: created.agent.id,
            runId: created.run.id,
          };
        }
        const created = yield* api.createRun({
          principal: input.principal,
          agentId: found.row.agentId,
          body: { ...input.body, prompt: { ...input.body.prompt, text: prompt } },
          limits,
        });
        const now = nowIso();
        yield* sql`
          UPDATE cloud_assistants
          SET status = ${"ACTIVE"}, updated_at = ${now}
          WHERE assistant_id = ${input.assistantId}
        `.pipe(Effect.catch(() => Effect.void));
        return {
          assistant: (yield* locate(input.principal, input.assistantId)).assistant,
          agentId: found.row.agentId,
          runId: created.run.id,
        };
      }),
    );

  return CloudAssistants.of({
    create,
    list,
    get,
    replace,
    listMemory,
    writeMemory,
    replaceMemory,
    deleteMemory,
    putPersistence,
    getPersistence,
    attachSubscription,
    archive,
    unarchive,
    reset,
    remove,
    createRun,
  });
});

export const layer = Layer.effect(CloudAssistants, make());
