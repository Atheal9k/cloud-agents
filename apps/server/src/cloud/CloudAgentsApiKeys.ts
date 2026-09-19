// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  type CloudAgentsApiCreateKeyRequest,
  type CloudAgentsApiCreatedKey,
  type CloudAgentsApiPrincipal,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const HashRequest = Schema.Struct({ tokenHash: Schema.String });
const KeyRow = Schema.Struct({
  keyId: Schema.String,
  principalId: Schema.String,
  kind: Schema.Literals(["user", "service_account"]),
  name: Schema.String,
  createdAt: Schema.String,
  userEmail: Schema.NullOr(Schema.String),
  userFirstName: Schema.NullOr(Schema.String),
  userLastName: Schema.NullOr(Schema.String),
});

function hashToken(token: string): string {
  return NodeCrypto.createHash("sha256").update(token).digest("hex");
}

function mintToken(): string {
  return `t3ca_${NodeCrypto.randomBytes(32).toString("base64url")}`;
}

/** Stable numeric id for user-scoped keys so /v1/me can report userId. */
function numericUserId(keyId: string): number {
  return Number.parseInt(keyId.replaceAll("-", "").slice(0, 8), 16) || 1;
}

export class CloudAgentsApiKeys extends Context.Service<
  CloudAgentsApiKeys,
  {
    readonly create: (
      input: CloudAgentsApiCreateKeyRequest,
    ) => Effect.Effect<CloudAgentsApiCreatedKey>;
    readonly authenticate: (token: string) => Effect.Effect<CloudAgentsApiPrincipal | null>;
  }
>()("t3/cloud/CloudAgentsApiKeys") {}

export const make = Effect.fn("CloudAgentsApiKeys.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);

  const findByHash = SqlSchema.findAll({
    Request: HashRequest,
    Result: KeyRow,
    execute: ({ tokenHash }) => sql`
      SELECT
        key_id AS "keyId",
        principal_id AS "principalId",
        kind,
        name,
        created_at AS "createdAt",
        user_email AS "userEmail",
        user_first_name AS "userFirstName",
        user_last_name AS "userLastName"
      FROM cloud_agents_api_keys
      WHERE token_hash = ${tokenHash}
    `,
  });

  const create: CloudAgentsApiKeys["Service"]["create"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const token = mintToken();
        const keyId = NodeCrypto.randomUUID();
        const principalId = `principal:${keyId}`;
        yield* sql`
          INSERT INTO cloud_agents_api_keys (
            key_id, principal_id, kind, name, token_hash, token_prefix, created_at,
            user_email, user_first_name, user_last_name
          ) VALUES (
            ${keyId},
            ${principalId},
            ${input.kind},
            ${input.name},
            ${hashToken(token)},
            ${token.slice(0, 12)},
            ${createdAt},
            ${input.userEmail ?? null},
            ${input.userFirstName ?? null},
            ${input.userLastName ?? null}
          )
        `.pipe(Effect.orDie);
        return {
          id: keyId,
          name: input.name,
          kind: input.kind,
          token,
          createdAt,
        } satisfies CloudAgentsApiCreatedKey;
      }),
    );

  const authenticate: CloudAgentsApiKeys["Service"]["authenticate"] = (token) =>
    findByHash({ tokenHash: hashToken(token) }).pipe(
      Effect.orDie,
      Effect.map((rows) => {
        const row = rows[0];
        if (row === undefined) return null;
        return {
          principalId: row.principalId,
          kind: row.kind,
          apiKeyName: row.name,
          createdAt: row.createdAt,
          ...(row.kind === "user" ? { userId: numericUserId(row.keyId) } : {}),
          ...(row.userEmail === null ? {} : { userEmail: row.userEmail }),
          ...(row.userFirstName === null ? {} : { userFirstName: row.userFirstName }),
          ...(row.userLastName === null ? {} : { userLastName: row.userLastName }),
        } satisfies CloudAgentsApiPrincipal;
      }),
    );

  return CloudAgentsApiKeys.of({ create, authenticate });
});

export const layer = Layer.effect(CloudAgentsApiKeys, make());
