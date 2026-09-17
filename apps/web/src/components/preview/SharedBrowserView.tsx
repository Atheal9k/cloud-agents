"use client";

/* oxlint-disable react/iframe-missing-sandbox -- The cross-origin DCV client requires scripts and its own origin for storage and WebSockets. */

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { SharedBrowserViewerId, ScopedThreadRef } from "@t3tools/contracts";
import { MonitorUp, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { sharedBrowserGatewayUrl } from "~/browser/sharedBrowserGatewayUrl";
import { Button } from "~/components/ui/button";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { sharedBrowserEnvironment } from "~/state/sharedBrowser";
import { useAtomCommand } from "~/state/use-atom-command";

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
}

function messageFromFailure(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string"
  ) {
    return failure.message;
  }
  return "The agent browser is not available on this worker.";
}

export function SharedBrowserView({ threadRef, visible }: Props) {
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const issue = useAtomCommand(sharedBrowserEnvironment.issue, { reportFailure: false });
  const keepAlive = useAtomCommand(sharedBrowserEnvironment.keepAlive, { reportFailure: false });
  const release = useAtomCommand(sharedBrowserEnvironment.release, { reportFailure: false });
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<SharedBrowserViewerId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const onVisibilityChange = () => setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!visible || !documentVisible || environmentHttpBaseUrl === null) return;

    let disposed = false;
    let activeViewerId: SharedBrowserViewerId | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    queueMicrotask(() => {
      if (disposed) return;
      setError(null);
      setViewerUrl(null);
    });

    void issue({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }).then((result) => {
      if (disposed) {
        if (result._tag === "Success") {
          void release({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, viewerId: result.value.viewerId },
          });
        }
        return;
      }
      if (result._tag === "Failure") {
        setError(messageFromFailure(squashAtomCommandFailure(result)));
        return;
      }

      activeViewerId = result.value.viewerId;
      setViewerId(result.value.viewerId);
      setViewerUrl(sharedBrowserGatewayUrl(environmentHttpBaseUrl, result.value, retry));
      heartbeat = setInterval(() => {
        if (activeViewerId === null) return;
        void keepAlive({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, viewerId: activeViewerId },
        }).then((heartbeatResult) => {
          if (!disposed && heartbeatResult._tag === "Failure") {
            setRetry((current) => current + 1);
          }
        });
      }, 30_000);
    });

    return () => {
      disposed = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      setViewerUrl(null);
      setViewerId(null);
      if (activeViewerId !== null) {
        void release({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, viewerId: activeViewerId },
        });
      }
    };
  }, [
    documentVisible,
    environmentHttpBaseUrl,
    issue,
    keepAlive,
    release,
    retry,
    threadRef.environmentId,
    threadRef.threadId,
    visible,
  ]);

  if (!visible || !documentVisible) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <MonitorUp className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Agent browser</span>
        <span className="text-xs text-muted-foreground">View only</span>
        {viewerId !== null ? (
          <span className="ml-auto text-xs text-muted-foreground">Live</span>
        ) : null}
      </div>
      {viewerUrl !== null ? (
        <iframe
          className="min-h-0 flex-1 border-0 bg-black"
          src={viewerUrl}
          title="Agent browser"
          allow="fullscreen"
          referrerPolicy="no-referrer"
          sandbox="allow-downloads allow-forms allow-pointer-lock allow-popups allow-same-origin allow-scripts"
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-sm space-y-3">
            <MonitorUp className="mx-auto size-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">
                {error === null
                  ? "Connecting to the agent browser..."
                  : "Agent browser unavailable"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {error ?? "The viewer starts only while this panel is visible."}
              </p>
            </div>
            {error !== null ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRetry((current) => current + 1)}
              >
                <RefreshCw />
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
