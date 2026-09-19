import {
  CloudResultManifest,
  type CloudResultRetentionStatus,
  CloudRunResultId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { CLOUD_ARTIFACT_ACCESS_PREFIX, make } from "./CloudArtifactAccess.ts";
import * as CloudRunResults from "./CloudRunResults.ts";

const NOW = "2026-09-17T05:00:00.000Z";
const RESULT_ID = CloudRunResultId.make("0".repeat(64));
const decodeManifest = Schema.decodeSync(CloudResultManifest);

function retainedManifest() {
  return decodeManifest({
    version: 1,
    resultId: RESULT_ID,
    allocationId: "allocation-artifact-1",
    attempt: 1,
    sourceEnvironmentId: "environment-artifact-1",
    sourceThreadId: "thread-artifact-1",
    baseCommit: "a".repeat(40),
    outputBranch: "cloud/run/artifact-1",
    checkpointRef: "refs/t3/cloud-results/artifact-1/workspace",
    pagePath: `/cloud/results/${RESULT_ID}`,
    diffDownloadPath: `/api/cloud/results/${RESULT_ID}/downloads/diff`,
    transcriptDownloadPath: `/api/cloud/results/${RESULT_ID}/downloads/transcript`,
    verificationDownloadPath: `/api/cloud/results/${RESULT_ID}/downloads/verification`,
    workspaceDownloadPath: `/api/cloud/results/${RESULT_ID}/downloads/workspace`,
    artifacts: [
      {
        id: "001-report",
        name: "report.png",
        relativePath: "artifacts/report.png",
        mediaType: "image/png",
        sizeBytes: 2048,
        sha256: "b".repeat(64),
        downloadPath: `/api/cloud/results/${RESULT_ID}/downloads/001-report`,
      },
    ],
    totalSizeBytes: 2048,
    captureStartedAt: NOW,
    capturedAt: NOW,
    expiresAt: "2026-09-24T05:00:00.000Z",
  });
}

function withAccess(status: CloudResultRetentionStatus) {
  return make().pipe(
    Effect.provideService(
      CloudRunResults.CloudRunResults,
      CloudRunResults.CloudRunResults.of({
        capture: () => Effect.die("unused"),
        status: () => Effect.succeed(status),
        readText: () => Effect.die("unused"),
        resolveDownload: () => Effect.die("unused"),
        startContinuation: () => Effect.die("unused"),
        purgeAllocation: () => Effect.die("unused"),
        purgeExpired: Effect.die("unused"),
      }),
    ),
  );
}

it.effect("grants short-lived authorized URLs for each retained file and artifact", () =>
  Effect.gen(function* () {
    const manifest = retainedManifest();
    const access = yield* withAccess({ status: "retained", manifest });

    const grant = yield* access.grant({ resultId: RESULT_ID });

    expect(grant.resultId).toBe(RESULT_ID);
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grant.entries.map((entry) => entry.kind)).toEqual([
      "diff",
      "transcript",
      "verification",
      "workspace",
      "artifact",
    ]);
    for (const entry of grant.entries) {
      expect(entry.url).toBe(`${CLOUD_ARTIFACT_ACCESS_PREFIX}${grant.token}/${entry.fileId}`);
    }
    const artifact = grant.entries.find((entry) => entry.kind === "artifact");
    expect(artifact).toMatchObject({
      fileId: "001-report",
      name: "report.png",
      relativePath: "artifacts/report.png",
      mediaType: "image/png",
      sizeBytes: 2048,
    });

    const resolved = yield* access.resolve(grant.token);
    expect(resolved).toBe(RESULT_ID);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("stops resolving a grant token after it expires", () =>
  Effect.gen(function* () {
    const access = yield* withAccess({ status: "retained", manifest: retainedManifest() });
    const grant = yield* access.grant({ resultId: RESULT_ID });

    expect(yield* access.resolve(grant.token)).toBe(RESULT_ID);
    yield* TestClock.adjust(Duration.seconds(301));
    expect(yield* access.resolve(grant.token)).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("rejects malformed tokens without consulting stored grants", () =>
  Effect.gen(function* () {
    const access = yield* withAccess({ status: "retained", manifest: retainedManifest() });
    expect(yield* access.resolve("not-a-real-token")).toBeNull();
    expect(yield* access.resolve("")).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("refuses to grant access before a result is retained", () =>
  Effect.gen(function* () {
    const access = yield* withAccess({
      status: "retaining",
      resultId: RESULT_ID,
      startedAt: NOW,
      hardDeadline: "2026-09-17T05:15:00.000Z",
    });

    const failure = yield* access.grant({ resultId: RESULT_ID }).pipe(Effect.flip);
    expect(failure.reason).toBe("result-not-found");
    expect(failure.retryable).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);
