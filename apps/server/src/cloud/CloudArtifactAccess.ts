// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CLOUD_ARTIFACT_ACCESS_TTL_SECONDS,
  CloudResultError,
  type CloudArtifactAccessGrant,
  type CloudArtifactAccessInput,
  type CloudArtifactEntry,
  type CloudResultManifest,
  type CloudRunResultId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import * as CloudRunResults from "./CloudRunResults.ts";

export const CLOUD_ARTIFACT_ACCESS_PREFIX = "/api/cloud/artifacts/";
const TTL_MILLIS = CLOUD_ARTIFACT_ACCESS_TTL_SECONDS * 1000;
// 32 random bytes rendered base64url are 43 characters. Match the shared-browser
// token shape so proxies and log scrubbers treat both the same way.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface ArtifactAccessGrant {
  readonly resultId: CloudRunResultId;
  readonly expiresAtMillis: number;
}

export class CloudArtifactAccess extends Context.Service<
  CloudArtifactAccess,
  {
    readonly grant: (
      input: CloudArtifactAccessInput,
    ) => Effect.Effect<CloudArtifactAccessGrant, CloudResultError>;
    readonly resolve: (token: string) => Effect.Effect<CloudRunResultId | null>;
  }
>()("t3/cloud/CloudArtifactAccess") {}

function accessUrl(token: string, fileId: string): string {
  return `${CLOUD_ARTIFACT_ACCESS_PREFIX}${token}/${fileId}`;
}

function manifestEntries(manifest: CloudResultManifest, token: string): Array<CloudArtifactEntry> {
  const entries: Array<CloudArtifactEntry> = [
    {
      fileId: "diff",
      kind: "diff",
      name: "changes.patch",
      mediaType: "text/x-diff; charset=utf-8",
      url: accessUrl(token, "diff"),
    },
    {
      fileId: "transcript",
      kind: "transcript",
      name: "transcript.json",
      mediaType: "application/json",
      url: accessUrl(token, "transcript"),
    },
    {
      fileId: "verification",
      kind: "verification",
      name: "verification.json",
      mediaType: "application/json",
      url: accessUrl(token, "verification"),
    },
    {
      fileId: "workspace",
      kind: "workspace",
      name: "workspace.bundle",
      mediaType: "application/octet-stream",
      url: accessUrl(token, "workspace"),
    },
  ];
  for (const artifact of manifest.artifacts) {
    entries.push({
      fileId: artifact.id,
      kind: "artifact",
      name: artifact.name,
      ...(artifact.relativePath === undefined ? {} : { relativePath: artifact.relativePath }),
      ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
      sizeBytes: artifact.sizeBytes,
      url: accessUrl(token, artifact.id),
    });
  }
  return entries;
}

export const make = Effect.fn("CloudArtifactAccess.make")(function* () {
  const results = yield* CloudRunResults.CloudRunResults;
  const state = yield* Ref.make<ReadonlyMap<string, ArtifactAccessGrant>>(new Map());

  const purgeExpired = Effect.fn("CloudArtifactAccess.purgeExpired")(function* () {
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Ref.update(state, (current) => {
      const live = [...current].filter(([, grant]) => grant.expiresAtMillis > nowMillis);
      return live.length === current.size ? current : new Map(live);
    });
  });
  yield* Effect.forkScoped(purgeExpired().pipe(Effect.repeat(Schedule.spaced("30 seconds"))));

  const grant: CloudArtifactAccess["Service"]["grant"] = (input) =>
    Effect.gen(function* () {
      const status = yield* results.status(input.resultId);
      if (status.status !== "retained") {
        return yield* new CloudResultError({
          reason: "result-not-found",
          message:
            status.status === "retaining"
              ? "The cloud result is still being retained."
              : "The cloud result is not available for download.",
          retryable: status.status === "retaining",
        });
      }
      const manifest = status.manifest;
      const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      const expiresAtMillis = nowMillis + TTL_MILLIS;
      yield* Ref.update(state, (current) => {
        const next = new Map(
          [...current].filter(([, existing]) => existing.expiresAtMillis > nowMillis),
        );
        next.set(token, { resultId: manifest.resultId, expiresAtMillis });
        return next;
      });
      return {
        resultId: manifest.resultId,
        token,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMillis)),
        entries: manifestEntries(manifest, token),
      };
    });

  const resolve: CloudArtifactAccess["Service"]["resolve"] = (token) =>
    Effect.gen(function* () {
      if (!TOKEN_PATTERN.test(token)) return null;
      const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
      const current = yield* Ref.get(state);
      const found = current.get(token);
      return found === undefined || found.expiresAtMillis <= nowMillis ? null : found.resultId;
    });

  return CloudArtifactAccess.of({ grant, resolve });
});

export const layer = Layer.effect(CloudArtifactAccess, make());
