import * as NodeCrypto from "node:crypto";

import {
  CloudCollaborationError,
  DEFAULT_CLOUD_TEAM_ID,
  type CloudAgentsApiPrincipal,
  type CloudRunEntryPoint,
  type CloudScmConnection,
  type CloudScmConnectionInput,
  type CloudSharedAgentViewMode,
  type CloudTeamFollowUpPolicy,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudAccountingCatalog from "./CloudAccountingCatalog.ts";
import { CloudAgentsApiFailure, apiError } from "./cloudAgentsApiModel.ts";
import { auditEvent } from "./cloudAccountingPolicy.ts";
import {
  cloudIdempotentRunKey,
  evaluateCloudSharedAgentView,
  evaluateCloudTeamFollowUp,
  intersectCloudScmAccess,
} from "./cloudCollaborationPolicy.ts";

const EmptyRequest = Schema.Struct({});
const ConnectionIdRequest = Schema.Struct({ connectionId: Schema.String });
const KeyRequest = Schema.Struct({ idempotencyKey: Schema.String });
const encodeInstalled = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeInstalled = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const ConnectionRow = Schema.Struct({
  connectionId: Schema.String,
  kind: Schema.Literals([
    "github",
    "github-enterprise",
    "gitlab",
    "gitlab-self-hosted",
    "bitbucket",
    "azure-devops",
  ]),
  displayName: Schema.String,
  baseUrl: Schema.String,
  installedJson: Schema.String,
  connectedAt: Schema.String,
});

const IdempotencyRow = Schema.Struct({
  entryPoint: Schema.String,
  deliveryId: Schema.String,
  agentId: Schema.String,
  runId: Schema.String,
  createdAt: Schema.String,
});

export class CloudCollaboration extends Context.Service<
  CloudCollaboration,
  {
    readonly listConnections: () => Effect.Effect<ReadonlyArray<CloudScmConnection>>;
    readonly connect: (
      input: CloudScmConnectionInput,
    ) => Effect.Effect<CloudScmConnection, CloudCollaborationError>;
    readonly disconnect: (connectionId: string) => Effect.Effect<void, CloudCollaborationError>;
    readonly installedRepositories: () => Effect.Effect<ReadonlyArray<string>>;
    readonly followUpPolicy: () => Effect.Effect<CloudTeamFollowUpPolicy>;
    readonly authorizeRepository: (input: {
      readonly repository: string;
      readonly actorRepositories: ReadonlyArray<string>;
      readonly configuredRepositories: ReadonlyArray<string>;
    }) => Effect.Effect<void, CloudCollaborationError>;
    readonly viewSharedAgent: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly ownerPrincipalId: string;
      readonly ownerTeamId: string;
      readonly agentRepositories: ReadonlyArray<string>;
      readonly viewerRepositories?: ReadonlyArray<string> | undefined;
    }) => Effect.Effect<{ readonly mode: CloudSharedAgentViewMode }, CloudCollaborationError>;
    readonly authorizeFollowUp: (input: {
      readonly principal: CloudAgentsApiPrincipal;
      readonly ownerPrincipalId: string;
      readonly ownerTeamId: string;
    }) => Effect.Effect<void, CloudCollaborationError>;
    readonly findIdempotentRun: (input: {
      readonly entryPoint: CloudRunEntryPoint;
      readonly deliveryId: string;
    }) => Effect.Effect<{ readonly agentId: string; readonly runId: string } | undefined>;
    readonly rememberIdempotentRun: (input: {
      readonly entryPoint: CloudRunEntryPoint;
      readonly deliveryId: string;
      readonly agentId: string;
      readonly runId: string;
    }) => Effect.Effect<void, CloudCollaborationError>;
  }
>()("t3/cloud/CloudCollaboration") {}

function collaborationError(
  reason: CloudCollaborationError["reason"],
  message: string,
): CloudCollaborationError {
  return new CloudCollaborationError({ reason, message });
}

export function teamIdOf(principal: CloudAgentsApiPrincipal): string {
  return principal.teamId ?? DEFAULT_CLOUD_TEAM_ID;
}

export const make = Effect.fn("CloudCollaboration.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const allocations = yield* CloudAllocationController.CloudAllocationController;
  const accounting = yield* CloudAccountingCatalog.make();

  const listConnectionRows = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: ConnectionRow,
    execute: () => sql`
      SELECT
        connection_id AS "connectionId",
        kind,
        display_name AS "displayName",
        base_url AS "baseUrl",
        installed_json AS "installedJson",
        connected_at AS "connectedAt"
      FROM cloud_scm_connections
      ORDER BY connected_at ASC
    `,
  });

  const insertConnection = SqlSchema.void({
    Request: Schema.Struct({
      connectionId: Schema.String,
      kind: Schema.String,
      displayName: Schema.String,
      baseUrl: Schema.String,
      installedJson: Schema.String,
      connectedAt: Schema.String,
    }),
    execute: (input) => sql`
      INSERT INTO cloud_scm_connections (
        connection_id, kind, display_name, base_url, installed_json, connected_at
      ) VALUES (
        ${input.connectionId},
        ${input.kind},
        ${input.displayName},
        ${input.baseUrl},
        ${input.installedJson},
        ${input.connectedAt}
      )
    `,
  });

  const deleteConnection = SqlSchema.void({
    Request: ConnectionIdRequest,
    execute: ({ connectionId }) => sql`
      DELETE FROM cloud_scm_connections WHERE connection_id = ${connectionId}
    `,
  });

  const findIdempotency = SqlSchema.findAll({
    Request: KeyRequest,
    Result: IdempotencyRow,
    execute: ({ idempotencyKey }) => sql`
      SELECT
        entry_point AS "entryPoint",
        delivery_id AS "deliveryId",
        agent_id AS "agentId",
        run_id AS "runId",
        created_at AS "createdAt"
      FROM cloud_run_idempotency
      WHERE idempotency_key = ${idempotencyKey}
    `,
  });

  const insertIdempotency = SqlSchema.void({
    Request: Schema.Struct({
      idempotencyKey: Schema.String,
      entryPoint: Schema.String,
      deliveryId: Schema.String,
      agentId: Schema.String,
      runId: Schema.String,
      createdAt: Schema.String,
    }),
    execute: (input) => sql`
      INSERT INTO cloud_run_idempotency (
        idempotency_key, entry_point, delivery_id, agent_id, run_id, created_at
      ) VALUES (
        ${input.idempotencyKey},
        ${input.entryPoint},
        ${input.deliveryId},
        ${input.agentId},
        ${input.runId},
        ${input.createdAt}
      )
    `,
  });

  const toConnection = (row: typeof ConnectionRow.Type): CloudScmConnection => ({
    id: row.connectionId,
    kind: row.kind,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    installedRepositories: decodeInstalled(row.installedJson),
    connectedAt: row.connectedAt,
  });

  const listConnections: CloudCollaboration["Service"]["listConnections"] = () =>
    listConnectionRows({}).pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(toConnection)),
    );

  const installedRepositories: CloudCollaboration["Service"]["installedRepositories"] = () =>
    listConnections().pipe(
      Effect.map((connections) =>
        connections.flatMap((connection) => connection.installedRepositories),
      ),
    );

  const followUpPolicy: CloudCollaboration["Service"]["followUpPolicy"] = () =>
    allocations.snapshot.pipe(
      Effect.map((snapshot) => snapshot.controller.defaults?.collaboration ?? "disabled"),
      Effect.orElseSucceed(() => "disabled" as const),
    );

  const connect: CloudCollaboration["Service"]["connect"] = (input) =>
    Effect.gen(function* () {
      const connectedAt = DateTime.formatIso(yield* DateTime.now);
      const connection: CloudScmConnection = {
        id: `scm-${NodeCrypto.randomUUID()}`,
        kind: input.kind,
        displayName: input.displayName,
        baseUrl: input.baseUrl,
        installedRepositories: [...input.installedRepositories],
        connectedAt,
      };
      yield* insertConnection({
        connectionId: connection.id,
        kind: connection.kind,
        displayName: connection.displayName,
        baseUrl: connection.baseUrl,
        installedJson: encodeInstalled([...connection.installedRepositories]),
        connectedAt,
      }).pipe(
        Effect.mapError(() =>
          collaborationError(
            "persistence-failed",
            "Could not persist the source-control connection.",
          ),
        ),
      );
      yield* accounting
        .appendAudit(
          auditEvent({
            id: `audit:scm-connect:${connection.id}`,
            occurredAt: connectedAt,
            action: "auth",
            resourceType: "scm-connection",
            resourceId: connection.id,
            summary: `Connected ${connection.displayName}.`,
          }),
        )
        .pipe(Effect.ignore);
      yield* allocations.refresh.pipe(Effect.ignore);
      return connection;
    });

  const disconnect: CloudCollaboration["Service"]["disconnect"] = (connectionId) =>
    Effect.gen(function* () {
      yield* deleteConnection({ connectionId }).pipe(
        Effect.mapError(() =>
          collaborationError(
            "persistence-failed",
            "Could not remove the source-control connection.",
          ),
        ),
      );
      const disconnectedAt = DateTime.formatIso(yield* DateTime.now);
      yield* accounting
        .appendAudit(
          auditEvent({
            id: `audit:scm-disconnect:${connectionId}:${disconnectedAt}`,
            occurredAt: disconnectedAt,
            action: "auth",
            resourceType: "scm-connection",
            resourceId: connectionId,
            summary: "Disconnected a source-control connection.",
          }),
        )
        .pipe(Effect.ignore);
      yield* allocations.refresh.pipe(Effect.ignore);
    });

  const authorizeRepository: CloudCollaboration["Service"]["authorizeRepository"] = (input) =>
    Effect.gen(function* () {
      const installed = yield* installedRepositories();
      const installRepositories = installed.length === 0 ? ["*"] : installed;
      const allowed = intersectCloudScmAccess({
        installRepositories,
        principalRepositories:
          input.actorRepositories.length === 0 ? installRepositories : input.actorRepositories,
        configuredRepositories: input.configuredRepositories,
        repository: input.repository,
      });
      if (!allowed.allowed) {
        return yield* collaborationError("scm-access-denied", allowed.message);
      }
    });

  const viewSharedAgent: CloudCollaboration["Service"]["viewSharedAgent"] = (input) =>
    Effect.gen(function* () {
      const installed = yield* installedRepositories();
      const viewerRepositories =
        input.viewerRepositories !== undefined && input.viewerRepositories.length > 0
          ? input.viewerRepositories
          : installed.length === 0
            ? input.agentRepositories
            : installed;
      const decision = evaluateCloudSharedAgentView({
        ownerPrincipalId: input.ownerPrincipalId,
        ownerTeamId: input.ownerTeamId,
        viewerPrincipalId: input.principal.principalId,
        viewerTeamId: teamIdOf(input.principal),
        viewerRepositories,
        agentRepositories: input.agentRepositories,
      });
      if (!decision.allowed) {
        return yield* collaborationError("share-forbidden", decision.message);
      }
      return { mode: decision.mode };
    });

  const authorizeFollowUp: CloudCollaboration["Service"]["authorizeFollowUp"] = (input) =>
    Effect.gen(function* () {
      const policy = yield* followUpPolicy();
      const decision = evaluateCloudTeamFollowUp({
        policy,
        ownerPrincipalId: input.ownerPrincipalId,
        actorPrincipalId: input.principal.principalId,
        actorKind: input.principal.kind,
        ownerTeamId: input.ownerTeamId,
        actorTeamId: teamIdOf(input.principal),
      });
      if (!decision.allowed) {
        return yield* collaborationError("follow-up-forbidden", decision.message);
      }
    });

  const findIdempotentRun: CloudCollaboration["Service"]["findIdempotentRun"] = (input) =>
    findIdempotency({
      idempotencyKey: cloudIdempotentRunKey(input.entryPoint, input.deliveryId),
    }).pipe(
      Effect.orDie,
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined ? undefined : { agentId: row.agentId, runId: row.runId };
      }),
    );

  const rememberIdempotentRun: CloudCollaboration["Service"]["rememberIdempotentRun"] = (input) =>
    Effect.gen(function* () {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* insertIdempotency({
        idempotencyKey: cloudIdempotentRunKey(input.entryPoint, input.deliveryId),
        entryPoint: input.entryPoint,
        deliveryId: input.deliveryId,
        agentId: input.agentId,
        runId: input.runId,
        createdAt,
      }).pipe(
        Effect.mapError(() =>
          collaborationError("persistence-failed", "Could not persist run idempotency."),
        ),
      );
    });

  return CloudCollaboration.of({
    listConnections,
    connect,
    disconnect,
    installedRepositories,
    followUpPolicy,
    authorizeRepository,
    viewSharedAgent,
    authorizeFollowUp,
    findIdempotentRun,
    rememberIdempotentRun,
  });
});

export const layer = Layer.effect(CloudCollaboration, make());

export function mapCollaborationFailure(
  error: CloudCollaborationError | CloudAgentsApiFailure,
): CloudAgentsApiFailure {
  if (error instanceof CloudAgentsApiFailure) return error;
  switch (error.reason) {
    case "follow-up-forbidden":
      return apiError("follow_up_forbidden", error.message);
    case "scm-access-denied":
    case "share-forbidden":
      return apiError("scm_access_denied", error.message);
    case "invalid-delivery":
      return apiError("invalid_request", error.message);
    default:
      return apiError("internal_error", error.message);
  }
}
