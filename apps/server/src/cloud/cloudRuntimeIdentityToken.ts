// @effect-diagnostics nodeBuiltinImport:off
/**
 * EdDSA identity tokens for cloud runtimes. The controller already keeps an
 * Ed25519 key pair for environment links (see `environmentKeys.ts`), so the
 * same material publishes a JWKS and signs the five-minute tokens a guest asks
 * for. Verification here is deliberately JWKS-first: a consumer needs nothing
 * but the published key set.
 */
import * as NodeCrypto from "node:crypto";

import {
  CLOUD_RUNTIME_IDENTITY_AUDIENCE,
  CLOUD_RUNTIME_IDENTITY_ISSUER,
  CloudRuntimeIdentityClaims,
  CloudSecurityError,
  type CloudJsonWebKey,
  type CloudJsonWebKeySet,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeClaims = Schema.decodeUnknownSync(CloudRuntimeIdentityClaims);

export interface CloudRuntimeSigningKey {
  readonly kid: string;
  readonly jwk: CloudJsonWebKey;
  readonly privateKey: NodeCrypto.KeyObject;
}

function base64UrlEncode(value: Uint8Array | string): string {
  return Buffer.from(value as never)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

/** RFC 7638 thumbprint, so a key's id follows the key rather than a counter. */
function thumbprint(x: string): string {
  const canonical = JSON.stringify({ crv: "Ed25519", kty: "OKP", x });
  return base64UrlEncode(NodeCrypto.createHash("sha256").update(canonical).digest());
}

export function cloudRuntimeSigningKey(keyPair: {
  readonly privateKey: string;
  readonly publicKey: string;
}): CloudRuntimeSigningKey {
  const publicKey = NodeCrypto.createPublicKey(keyPair.publicKey);
  const exported = publicKey.export({ format: "jwk" }) as { x?: string; crv?: string };
  if (exported.crv !== "Ed25519" || typeof exported.x !== "string") {
    throw new Error("Cloud runtime identity requires an Ed25519 key pair.");
  }
  const kid = thumbprint(exported.x);
  return {
    kid,
    jwk: { kty: "OKP", crv: "Ed25519", x: exported.x, kid, use: "sig", alg: "EdDSA" },
    privateKey: NodeCrypto.createPrivateKey(keyPair.privateKey),
  };
}

export function cloudRuntimeJwks(keys: ReadonlyArray<CloudRuntimeSigningKey>): CloudJsonWebKeySet {
  return { keys: keys.map((key) => key.jwk) };
}

export function signCloudRuntimeToken(input: {
  readonly claims: CloudRuntimeIdentityClaims;
  readonly key: CloudRuntimeSigningKey;
}): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: input.key.kid }));
  const payload = base64UrlEncode(JSON.stringify(input.claims));
  const signingInput = `${header}.${payload}`;
  const signature = NodeCrypto.sign(null, Buffer.from(signingInput), input.key.privateKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function invalid(message: string): CloudSecurityError {
  return new CloudSecurityError({ reason: "invalid-token", message });
}

/**
 * Verifies the signature against the published key set and decodes the claim
 * shape. Time and audience checks stay in `cloudSecurityPolicy` so they can be
 * exercised without crypto.
 */
export function verifyCloudRuntimeTokenSignature(input: {
  readonly token: string;
  readonly jwks: CloudJsonWebKeySet;
}): CloudRuntimeIdentityClaims | CloudSecurityError {
  const parts = input.token.split(".");
  if (parts.length !== 3) return invalid("The identity token is not a compact JWS.");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8")) as typeof header;
  } catch {
    return invalid("The identity token header is not JSON.");
  }
  if (header.alg !== "EdDSA")
    return invalid(`Unsupported token algorithm '${String(header.alg)}'.`);

  const key = input.jwks.keys.find((candidate) => candidate.kid === header.kid);
  if (key === undefined) {
    return new CloudSecurityError({
      reason: "unknown-key",
      message: `No published key matches kid '${String(header.kid)}'.`,
    });
  }

  const verified = NodeCrypto.verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    NodeCrypto.createPublicKey({ key: key as unknown as NodeCrypto.JsonWebKey, format: "jwk" }),
    base64UrlDecode(encodedSignature),
  );
  if (!verified) return invalid("The identity token signature does not verify.");

  try {
    return decodeClaims(JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")));
  } catch {
    return invalid("The identity token payload is not a runtime identity.");
  }
}

export const CLOUD_RUNTIME_IDENTITY_DEFAULTS = {
  issuer: CLOUD_RUNTIME_IDENTITY_ISSUER,
  audience: CLOUD_RUNTIME_IDENTITY_AUDIENCE,
} as const;
