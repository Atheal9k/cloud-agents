import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  CLOUD_RUNTIME_IDENTITY_JWKS_PATH,
  CLOUD_RUNTIME_IDENTITY_METADATA_PATH,
  CLOUD_RUNTIME_IDENTITY_RATE_LIMIT_PER_MINUTE,
  CLOUD_RUNTIME_IDENTITY_TOKEN_PATH,
  CloudAgentId,
  CloudEnvironmentId,
  CloudJsonWebKeySet,
  CloudRunId,
  CloudRuntimeMetadata,
  CloudRuntimeToken,
  CloudSecurityError,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  cloudRuntimeIdentitySocketPath,
  requestCloudRuntimeIdentity,
  serveCloudRuntimeIdentity,
  type CloudRuntimeIdentitySession,
} from "./CloudRuntimeIdentity.ts";
import { verifyCloudRuntimeTokenSignature } from "./cloudRuntimeIdentityToken.ts";
import {
  cloudEgressExceptions,
  resolveCloudEgressPolicy,
  verifyCloudRuntimeIdentityClaims,
} from "./cloudSecurityPolicy.ts";

const decodeMetadata = Schema.decodeUnknownSync(CloudRuntimeMetadata);
const decodeToken = Schema.decodeUnknownSync(CloudRuntimeToken);
const decodeJwks = Schema.decodeUnknownSync(CloudJsonWebKeySet);
const isSecurityError = Schema.is(CloudSecurityError);

const ISSUER = "https://cloud.t3.codes";
const AUDIENCE = "t3-cloud-runtime";

function keyPair() {
  const generated = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return { privateKey: generated.privateKey, publicKey: generated.publicKey };
}

const session: CloudRuntimeIdentitySession = {
  subject: {
    agentId: CloudAgentId.make("agent-identity-1"),
    ownerId: "user-identity-1",
    runId: CloudRunId.make("run-identity-1"),
    workspaceId: "workspace-identity-1",
    environmentId: CloudEnvironmentId.make("env-identity-1"),
    repositories: ["acme/app"],
    hosting: "managed",
  },
  egress: resolveCloudEgressPolicy({
    environment: { mode: "allowlist_only", allowlist: ["api.example.com"] },
    exceptions: cloudEgressExceptions({
      controllerHost: "controller.internal",
      scmHosts: ["github.com"],
      artifactHosts: ["artifacts.internal"],
    }),
  }),
  secrets: [
    {
      name: "DB_PASSWORD",
      reference: "ref/db",
      scope: "environment",
      availability: "runtime-redacted",
      phase: "runtime",
      redacted: true,
    },
  ],
};

const withIdentity = <A, E, R>(
  run: (socketPath: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CloudSecurityError, R> =>
  Effect.gen(function* () {
    const socketPath = cloudRuntimeIdentitySocketPath({
      runtimeId: `test-${NodeCrypto.randomUUID()}`,
      directory: NodeOS.tmpdir(),
    });
    yield* serveCloudRuntimeIdentity({ socketPath, session, keyPair: keyPair() });
    return yield* run(socketPath);
  }).pipe(Effect.scoped);

it.effect("serves runtime metadata without any secret value", () =>
  withIdentity((socketPath) =>
    Effect.gen(function* () {
      const response = yield* requestCloudRuntimeIdentity({
        socketPath,
        path: CLOUD_RUNTIME_IDENTITY_METADATA_PATH,
      });

      expect(response.status).toBe(200);
      const metadata = decodeMetadata(response.body);
      expect(metadata).toMatchObject({
        agentId: "agent-identity-1",
        runId: "run-identity-1",
        ownerId: "user-identity-1",
        workspaceId: "workspace-identity-1",
        repositories: ["acme/app"],
        hosting: "managed",
        tokenTtlSeconds: 300,
      });
      expect(metadata.egress.mode).toBe("allowlist_only");
      expect(metadata.secrets).toEqual([
        {
          name: "DB_PASSWORD",
          reference: "ref/db",
          scope: "environment",
          availability: "runtime-redacted",
          phase: "runtime",
          redacted: true,
        },
      ]);
    }),
  ),
);

it.effect("mints a five-minute token that verifies against the published JWKS", () =>
  withIdentity((socketPath) =>
    Effect.gen(function* () {
      const tokenResponse = yield* requestCloudRuntimeIdentity({
        socketPath,
        path: CLOUD_RUNTIME_IDENTITY_TOKEN_PATH,
        method: "POST",
      });
      const jwksResponse = yield* requestCloudRuntimeIdentity({
        socketPath,
        path: CLOUD_RUNTIME_IDENTITY_JWKS_PATH,
      });

      expect(tokenResponse.status).toBe(200);
      const token = decodeToken(tokenResponse.body);
      expect(token).toMatchObject({ tokenType: "Bearer", expiresIn: 300 });

      const jwks = decodeJwks(jwksResponse.body);
      expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });

      const verified = verifyCloudRuntimeTokenSignature({ token: token.token, jwks });
      expect(isSecurityError(verified)).toBe(false);
      if (isSecurityError(verified)) return;
      expect(verified).toEqual(token.claims);
      expect(
        verifyCloudRuntimeIdentityClaims({
          claims: verified,
          issuer: ISSUER,
          audience: AUDIENCE,
          nowSeconds: verified.iat,
        }),
      ).toBeUndefined();
    }),
  ),
);

it.effect("refuses a token signed by another controller's key", () =>
  withIdentity((socketPath) =>
    Effect.gen(function* () {
      const tokenResponse = yield* requestCloudRuntimeIdentity({
        socketPath,
        path: CLOUD_RUNTIME_IDENTITY_TOKEN_PATH,
      });
      const token = decodeToken(tokenResponse.body);
      const [header, payload, signature] = token.token.split(".");
      const signatureText = signature ?? "";
      const tampered = `${header}.${payload}.${signatureText.startsWith("A") ? "B" : "A"}${signatureText.slice(1)}`;
      const jwks = decodeJwks(
        (yield* requestCloudRuntimeIdentity({
          socketPath,
          path: CLOUD_RUNTIME_IDENTITY_JWKS_PATH,
        })).body,
      );

      expect(isSecurityError(verifyCloudRuntimeTokenSignature({ token: tampered, jwks }))).toBe(
        true,
      );
      expect(
        verifyCloudRuntimeTokenSignature({
          token: token.token,
          jwks: { keys: [{ ...jwks.keys[0]!, kid: "someone-else" }] },
        }),
      ).toMatchObject({ reason: "unknown-key" });
    }),
  ),
);

it.effect("rate limits token requests and answers nothing else", () =>
  withIdentity((socketPath) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < CLOUD_RUNTIME_IDENTITY_RATE_LIMIT_PER_MINUTE; attempt += 1) {
        const allowed = yield* requestCloudRuntimeIdentity({
          socketPath,
          path: CLOUD_RUNTIME_IDENTITY_TOKEN_PATH,
        });
        expect(allowed.status).toBe(200);
      }

      const limited = yield* requestCloudRuntimeIdentity({
        socketPath,
        path: CLOUD_RUNTIME_IDENTITY_TOKEN_PATH,
      });
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();

      const unknown = yield* requestCloudRuntimeIdentity({ socketPath, path: "/credentials" });
      expect(unknown.status).toBe(404);
    }),
  ),
);
