"use client";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  DeviceDisplayControlState,
  DeviceDisplayGrant,
  DeviceDisplayViewerId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { deviceDisplayId } from "@t3tools/contracts";
import { MonitorSmartphone, MousePointer2, RefreshCw, RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { deviceDisplayEnvironment } from "~/state/deviceDisplay";
import { useAtomCommand } from "~/state/use-atom-command";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";

import { DeviceStreamView, type DeviceStreamHandle } from "../device/DeviceStreamView";

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
  return "The device display is not available on this worker.";
}

function accessForGrant(environmentHttpBaseUrl: string, grant: DeviceDisplayGrant): DeviceHubAccess {
  const httpBase = new URL(grant.streamBasePath, environmentHttpBaseUrl).toString().replace(/\/$/, "");
  return {
    httpBase,
    wsBase: httpBase.replace(/^http/, "ws"),
    query: {},
    credentials: true,
  };
}

function sessionLabel(grant: DeviceDisplayGrant): string {
  const identity =
    grant.session.platform === "android" ? grant.session.serial : grant.session.udid;
  return `${grant.session.deviceName} · ${grant.session.runtime} · ${identity} · ${grant.session.buildRevision} · ${grant.session.connectionState}`;
}

export function DeviceDisplayView({ threadRef, visible }: Props) {
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const issue = useAtomCommand(deviceDisplayEnvironment.issue, { reportFailure: false });
  const keepAlive = useAtomCommand(deviceDisplayEnvironment.keepAlive, { reportFailure: false });
  const takeControl = useAtomCommand(deviceDisplayEnvironment.takeControl, {
    reportFailure: false,
  });
  const returnControl = useAtomCommand(deviceDisplayEnvironment.returnControl, {
    reportFailure: false,
  });
  const release = useAtomCommand(deviceDisplayEnvironment.release, { reportFailure: false });
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  const [grant, setGrant] = useState<DeviceDisplayGrant | null>(null);
  const [viewerId, setViewerId] = useState<DeviceDisplayViewerId | null>(null);
  const [control, setControl] = useState<DeviceDisplayControlState | null>(null);
  const [handoffPending, setHandoffPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [handle, setHandle] = useState<DeviceStreamHandle | null>(null);

  useEffect(() => {
    const onVisibilityChange = () => setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const watching = visible && documentVisible;

  useEffect(() => {
    if (!watching || environmentHttpBaseUrl === null) return;

    let disposed = false;
    let activeViewerId: DeviceDisplayViewerId | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    queueMicrotask(() => {
      if (disposed) return;
      setError(null);
      setGrant(null);
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
      setControl(result.value.control);
      setGrant(result.value);
      heartbeat = setInterval(() => {
        if (activeViewerId === null) return;
        void keepAlive({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, viewerId: activeViewerId },
        }).then((heartbeatResult) => {
          if (!disposed && heartbeatResult._tag === "Failure") {
            setRetry((current) => current + 1);
          } else if (!disposed && heartbeatResult._tag === "Success") {
            setControl(heartbeatResult.value.control);
            setGrant(heartbeatResult.value);
          }
        });
      }, 30_000);
    });

    return () => {
      disposed = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      setGrant(null);
      setViewerId(null);
      setControl(null);
      if (activeViewerId !== null) {
        void release({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, viewerId: activeViewerId },
        });
      }
    };
  }, [
    environmentHttpBaseUrl,
    issue,
    keepAlive,
    release,
    retry,
    threadRef.environmentId,
    threadRef.threadId,
    watching,
  ]);

  const ownsControl =
    control?.owner === "human" && viewerId !== null && control.viewerId === viewerId;
  const controlledElsewhere = control?.owner === "human" && !ownsControl;
  const ownerLabel = ownsControl
    ? "You have control"
    : controlledElsewhere
      ? "Controlled elsewhere"
      : control?.owner === "none"
        ? "Agent paused"
        : "Agent has control";

  const access = useMemo(() => {
    if (grant === null || environmentHttpBaseUrl === null) return null;
    return accessForGrant(environmentHttpBaseUrl, grant);
  }, [environmentHttpBaseUrl, grant]);

  const changeControl = async () => {
    if (viewerId === null || handoffPending) return;
    setHandoffPending(true);
    setError(null);
    const command = ownsControl ? returnControl : takeControl;
    const result = await command({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, viewerId },
    });
    if (result._tag === "Success") {
      setControl(result.value.control);
      setGrant(result.value);
    } else {
      setError(messageFromFailure(squashAtomCommandFailure(result)));
    }
    setHandoffPending(false);
  };

  if (!watching) return null;

  const title = grant?.session.platform === "ios" ? "iOS Simulator" : "Android emulator";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <MonitorSmartphone className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{title}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {grant !== null ? sessionLabel(grant) : ownerLabel}
        </span>
        {grant !== null && error !== null ? (
          <span className="text-xs text-destructive">Handoff failed</span>
        ) : null}
        {ownsControl ? (
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => handle?.rotate()}
            disabled={handle === null}
          >
            <RotateCw />
            Rotate
          </Button>
        ) : null}
        <Button
          size="xs"
          variant={ownsControl ? "secondary" : "outline"}
          className="ml-auto"
          disabled={handoffPending || controlledElsewhere || viewerId === null}
          onClick={() => void changeControl()}
        >
          <MousePointer2 />
          {handoffPending ? "Switching..." : ownsControl ? "Return control" : "Take control"}
        </Button>
      </div>
      {grant !== null && access !== null ? (
        <DeviceStreamView
          environmentId={threadRef.environmentId}
          platform={grant.session.platform}
          deviceId={deviceDisplayId(grant.session)}
          deviceName={grant.session.deviceName}
          deviceDescription={sessionLabel(grant)}
          visible={watching}
          hostId="local"
          access={access}
          interactive={ownsControl}
          onHandle={setHandle}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-sm space-y-3">
            <MonitorSmartphone className="mx-auto size-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">
                {error === null ? `Connecting to the ${title.toLowerCase()}...` : `${title} unavailable`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {error ?? "The viewer starts only while this panel is visible."}
              </p>
            </div>
            {error !== null ? (
              <Button size="sm" variant="outline" onClick={() => setRetry((current) => current + 1)}>
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
