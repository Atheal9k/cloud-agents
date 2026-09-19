import type { CloudAgentReview, CloudDiffInspection } from "@t3tools/contracts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function textBlock(inspection: CloudDiffInspection): string {
  switch (inspection.status) {
    case "text":
      return `<pre>${escapeHtml(inspection.preview)}</pre>`;
    case "binary":
      return `<p>${escapeHtml(inspection.reason)}</p>`;
    case "oversized":
      return `<p>${escapeHtml(inspection.reason)}</p>`;
    case "missing":
      return `<p>${escapeHtml(inspection.reason)}</p>`;
  }
}

function snapshotLabel(review: CloudAgentReview): string {
  switch (review.snapshot.status) {
    case "present":
      return `Snapshot ${review.snapshot.instanceId} captured ${review.snapshot.capturedAt}`;
    case "idle-guest":
      return `Idle guest releases at ${review.snapshot.releaseAt}`;
    case "expired":
    case "missing":
      return review.snapshot.reason;
  }
}

export function renderCloudAgentReviewPage(review: CloudAgentReview): string {
  const title = escapeHtml(review.agent.conversation.title);
  const runRows = review.runs
    .map(
      (entry) =>
        `<li><code>${escapeHtml(entry.run.id)}</code> · ${escapeHtml(entry.terminalStatus)}</li>`,
    )
    .join("");
  const artifactRows = review.artifacts
    .map((artifact) => {
      if (artifact.status === "missing") {
        return `<li>${escapeHtml(artifact.name)}: ${escapeHtml(artifact.reason)}</li>`;
      }
      const untrusted = artifact.htmlUntrusted
        ? " Untrusted HTML is download-only and cannot run with application privileges."
        : "";
      return `<li><a href="${escapeHtml(artifact.entry.url)}">${escapeHtml(artifact.entry.name)}</a>${untrusted}</li>`;
    })
    .join("");
  const build =
    review.build.status === "present"
      ? review.build.failed
        ? `Build failed at ${review.build.build.outcome.status === "failed" ? review.build.build.outcome.stage : "unknown"}`
        : `Build ${review.build.build.id} · ${review.build.build.outcome.status}`
      : review.build.reason;
  const publication =
    review.publication.status === "present"
      ? review.publication.outcome.status === "published"
        ? `<a href="${escapeHtml(review.publication.outcome.pullRequestUrl)}">${escapeHtml(review.publication.outcome.pullRequestUrl)}</a>`
        : review.publication.outcome.status
      : review.publication.reason;
  const provenance =
    review.publication.status === "present" && review.publication.provenance !== undefined
      ? `${review.publication.provenance.principal.kind}:${review.publication.provenance.principal.id} · ${review.publication.provenance.provider ?? "unknown"}/${review.publication.provenance.model ?? "unknown"} · ${review.publication.provenance.signature?.fingerprint ?? "unsigned"}`
      : "None";
  const usage =
    review.usage === undefined
      ? "Unknown"
      : `${review.usage.elapsedWorkerSeconds} worker seconds`;
  const environmentName =
    review.environment?.current.name ?? review.environmentReference?.environmentId ?? "None";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>This page inspects retained results. It does not wake a runtime.</p><dl><dt>Agent status</dt><dd>${escapeHtml(review.agentStatus)}</dd><dt>Latest run</dt><dd>${escapeHtml(review.latestRun.status)}</dd><dt>Preview</dt><dd>${escapeHtml(review.previewAvailability)}</dd><dt>Terminal</dt><dd>${escapeHtml(review.terminalAvailability)}</dd><dt>Usage</dt><dd>${escapeHtml(usage)}</dd><dt>Environment</dt><dd>${escapeHtml(environmentName)}</dd><dt>Build</dt><dd>${escapeHtml(build)}</dd><dt>Runtime snapshot</dt><dd>${escapeHtml(snapshotLabel(review))}</dd><dt>Pull request</dt><dd>${publication}</dd><dt>Provenance</dt><dd>${escapeHtml(provenance)}</dd></dl><h2>Runs</h2><ul>${runRows}</ul><h2>Changes</h2>${textBlock(review.diff)}<h2>Verification</h2>${textBlock(review.verification)}<h2>Transcript</h2>${textBlock(review.transcript)}<h2>Artifacts</h2><ul>${artifactRows}</ul></main></body></html>`;
}
