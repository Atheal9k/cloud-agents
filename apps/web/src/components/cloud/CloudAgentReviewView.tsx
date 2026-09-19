import { useAtomValue } from "@effect/atom-react";
import {
  CloudAgentId,
  CommandId,
  type CloudAgentReview,
  type CloudAgentReviewAction,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { CloudHandoffPanel } from "./CloudHandoffPanel";
import { cloudAllocations } from "../../state/cloudAllocations";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import {
  cloudAgentStatusLabel,
  cloudDiffInspectionLabel,
  cloudReviewActionLabel,
  cloudSessionAvailabilityLabel,
} from "../../cloud/cloudAgentReviewPresentation";

function inspectionBody(inspection: CloudAgentReview["diff"]): string {
  switch (inspection.status) {
    case "text":
      return inspection.preview;
    case "binary":
    case "oversized":
    case "missing":
      return inspection.reason;
  }
}

export function CloudAgentReviewView(props: {
  readonly environmentId: EnvironmentId;
  readonly agentId: CloudAgentId;
}) {
  const inspect = useAtomCommand(cloudAllocations.inspectAgentReview, { reportFailure: false });
  const act = useAtomCommand(cloudAllocations.actAgentReview, { reportFailure: false });
  const share = useAtomCommand(cloudAllocations.shareAgentReview, { reportFailure: false });
  const [review, setReview] = useState<CloudAgentReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const loaded = await inspect({
      environmentId: props.environmentId,
      input: { agentId: props.agentId },
    });
    if (AsyncResult.isSuccess(loaded)) {
      setReview(loaded.value);
      setError(null);
      return;
    }
    setReview(null);
    setError("This cloud agent is not available for offline review.");
  };

  useEffect(() => {
    void load();
  }, [props.agentId, props.environmentId]);

  const runAction = async (action: CloudAgentReviewAction) => {
    setBusy(true);
    const result = await act({
      environmentId: props.environmentId,
      input: {
        agentId: props.agentId,
        action,
        commandId: CommandId.make(randomUUID()),
        occurredAt: new Date().toISOString(),
      },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      setReview(result.value);
      setError(null);
      return;
    }
    setError("The controller rejected that review action.");
    await load();
  };

  const copyShareLink = async () => {
    const granted = await share({
      environmentId: props.environmentId,
      input: { agentId: props.agentId },
    });
    if (AsyncResult.isSuccess(granted)) {
      setShareUrl(granted.value.url);
    }
  };

  if (review === null) {
    return <p className="text-sm text-muted-foreground">{error ?? "Loading retained review…"}</p>;
  }

  return (
    <div className="flex flex-col gap-6 p-6" data-testid="cloud-agent-review">
      <div>
        <h1 className="text-lg font-semibold">{review.agent.conversation.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Agent {cloudAgentStatusLabel(review.agentStatus)} · Run {review.latestRun.status} ·{" "}
          {cloudSessionAvailabilityLabel("Preview", review.previewAvailability)} ·{" "}
          {cloudSessionAvailabilityLabel("Terminal", review.terminalAvailability)}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Reviewing retained results does not wake a runtime.
        </p>
      </div>
      {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="text-muted-foreground">Usage</dt>
          <dd>
            {review.usage === undefined
              ? "Unknown"
              : `${review.usage.elapsedWorkerSeconds} worker seconds`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Environment</dt>
          <dd>
            {review.environment?.current.name ??
              review.environmentReference?.environmentId ??
              "None"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Build</dt>
          <dd>
            {review.build.status === "present"
              ? review.build.failed
                ? `Failed · ${review.build.build.id}`
                : review.build.build.id
              : review.build.reason}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Snapshot</dt>
          <dd>
            {review.snapshot.status === "present"
              ? `${review.snapshot.instanceId} at ${review.snapshot.capturedAt}`
              : review.snapshot.status === "idle-guest"
                ? `Idle until ${review.snapshot.releaseAt}`
                : review.snapshot.reason}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Pull request</dt>
          <dd>
            {review.publication.status === "present" &&
            review.publication.outcome.status === "published" ? (
              <a className="underline" href={review.publication.outcome.pullRequestUrl}>
                {review.publication.outcome.pullRequestUrl}
              </a>
            ) : review.publication.status === "present" ? (
              review.publication.outcome.status
            ) : (
              review.publication.reason
            )}
          </dd>
        </div>
      </dl>
      <section>
        <h2 className="text-sm font-medium">Runs</h2>
        <ul className="mt-2 text-sm">
          {review.runs.map((entry) => (
            <li key={entry.run.id}>
              {entry.run.id} · {entry.terminalStatus}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="text-sm font-medium">Changes ({cloudDiffInspectionLabel(review.diff)})</h2>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs">
          {inspectionBody(review.diff)}
        </pre>
      </section>
      <section>
        <h2 className="text-sm font-medium">
          Verification ({cloudDiffInspectionLabel(review.verification)})
        </h2>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs">
          {inspectionBody(review.verification)}
        </pre>
      </section>
      <section>
        <h2 className="text-sm font-medium">
          Transcript ({cloudDiffInspectionLabel(review.transcript)})
        </h2>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs">
          {inspectionBody(review.transcript)}
        </pre>
      </section>
      <section>
        <h2 className="text-sm font-medium">Artifacts</h2>
        <ul className="mt-2 text-sm">
          {review.artifacts.map((artifact, index) =>
            artifact.status === "missing" ? (
              <li key={index}>{artifact.reason}</li>
            ) : (
              <li key={artifact.entry.fileId}>
                {artifact.htmlUntrusted ? (
                  <a className="underline" href={artifact.entry.url} download>
                    {artifact.entry.name} (untrusted HTML, download only)
                  </a>
                ) : (
                  <a className="underline" href={artifact.entry.url}>
                    {artifact.entry.name}
                  </a>
                )}
              </li>
            ),
          )}
        </ul>
      </section>
      <div className="flex flex-wrap gap-2">
        {review.actions.map((entry) => (
          <Button
            key={entry.action}
            size="sm"
            variant={entry.action === "delete" ? "destructive" : "outline"}
            disabled={busy || !entry.available}
            title={entry.blockedReason}
            onClick={() => void runAction(entry.action)}
          >
            {cloudReviewActionLabel(entry.action)}
          </Button>
        ))}
        <Button size="sm" variant="outline" onClick={() => void copyShareLink()}>
          Authorized share link
        </Button>
      </div>
      {shareUrl === null ? null : <p className="text-xs text-muted-foreground">{shareUrl}</p>}
      <CloudHandoffPanel
        environmentId={props.environmentId}
        agentId={props.agentId}
        defaultDirection="cloud-to-local"
      />
    </div>
  );
}

export function CloudAgentReviewList(props: { readonly environmentId: EnvironmentId }) {
  const snapshotResult = useAtomValue(
    cloudAllocations.snapshot({ environmentId: props.environmentId, input: {} }),
  );
  const snapshot = AsyncResult.getOrElse(snapshotResult, () => null);
  const agents = snapshot?.agents ?? [];
  return (
    <div className="flex flex-col gap-6">
      {agents.length === 0 ? (
        <p className="p-6 pb-0 text-sm text-muted-foreground">No cloud agents to review.</p>
      ) : (
        <ul className="flex flex-col gap-2 p-6 pb-0">
          {agents.map((agent) => (
            <li key={agent.id}>
              <Link
                to="/cloud-agents/$agentId"
                params={{ agentId: agent.id }}
                className="text-sm underline"
              >
                {agent.conversation.title} · {cloudAgentStatusLabel(agent.status)}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="p-6 pt-0">
        <CloudHandoffPanel environmentId={props.environmentId} defaultDirection="local-to-cloud" />
      </div>
    </div>
  );
}
