import { CloudResultRetentionStatus } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { renderCloudResultPage } from "../http.ts";

const decodeStatus = Schema.decodeSync(CloudResultRetentionStatus);

describe("cloud result page", () => {
  it("renders retained downloads and escapes captured output", () => {
    const status = decodeStatus({
      status: "retained",
      manifest: {
        version: 1,
        resultId: "a".repeat(64),
        allocationId: "allocation-1",
        attempt: 1,
        sourceEnvironmentId: "environment-1",
        sourceThreadId: "thread-1",
        baseCommit: "0123456789abcdef",
        outputBranch: "cloud/run/result",
        checkpointRef: "refs/t3/cloud-results/result/workspace",
        pagePath: `/cloud/results/${"a".repeat(64)}`,
        diffDownloadPath: `/api/cloud/results/${"a".repeat(64)}/downloads/diff`,
        transcriptDownloadPath: `/api/cloud/results/${"a".repeat(64)}/downloads/transcript`,
        verificationDownloadPath: `/api/cloud/results/${"a".repeat(64)}/downloads/verification`,
        workspaceDownloadPath: `/api/cloud/results/${"a".repeat(64)}/downloads/workspace`,
        artifacts: [
          {
            id: "001-report",
            name: "report<script>.txt",
            mediaType: "text/plain",
            sizeBytes: 12,
            sha256: "b".repeat(64),
            downloadPath: `/api/cloud/results/${"a".repeat(64)}/downloads/001-report`,
          },
        ],
        totalSizeBytes: 100,
        captureStartedAt: "2026-09-17T03:00:00.000Z",
        capturedAt: "2026-09-17T03:00:05.000Z",
        expiresAt: "2026-09-24T03:00:05.000Z",
      },
    });

    const html = renderCloudResultPage({
      status,
      diff: "<script>alert('diff')</script>",
      verification: '{"status":"passed"}',
    });

    expect(html).toContain("Download workspace checkpoint");
    expect(html).toContain("report&lt;script&gt;.txt");
    expect(html).toContain("&lt;script&gt;alert(&#39;diff&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("states whether a failed capture can be retried", () => {
    const html = renderCloudResultPage({
      status: decodeStatus({
        status: "failed",
        resultId: "c".repeat(64),
        reason: "capture-failed",
        message: "Object storage is unavailable.",
        retryable: true,
        failedAt: "2026-09-17T03:00:05.000Z",
      }),
    });

    expect(html).toContain("Retention failed.");
    expect(html).toContain("The controller can retry this capture.");
  });
});
