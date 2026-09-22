import { AsyncResult } from "effect/unstable/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SmartphoneIcon,
  SquareIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  CloudAgentId,
  CommandId,
  type CloudExpoMetroControlInput,
  type CloudExpoMetroStatus,
  type EnvironmentId,
} from "@t3tools/contracts";

import {
  cloudExpoMetroCanRetry,
  cloudExpoMetroLabels,
  cloudExpoStartupLabel,
} from "../../cloud/cloudExpoMetroPresentation";
import { randomUUID } from "../../lib/utils";
import { cloudAllocations } from "../../state/cloudAllocations";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";

function StatusItem(props: {
  readonly label: string;
  readonly value: string;
  readonly error?: boolean;
  readonly ready?: boolean;
}) {
  const Icon = props.error ? CircleAlertIcon : props.ready ? CircleCheckIcon : RefreshCwIcon;
  return (
    <div className="flex min-w-32 items-center gap-2 rounded-lg bg-muted/48 px-3 py-2">
      <Icon
        aria-hidden
        strokeWidth={1.5}
        className={props.error ? "size-4 text-destructive" : "size-4 text-muted-foreground"}
      />
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground">{props.label}</div>
        <div className="truncate text-sm font-medium">{props.value}</div>
      </div>
    </div>
  );
}

export function CloudExpoMetroCard(props: {
  readonly environmentId: EnvironmentId;
  readonly agentId: CloudAgentId;
}) {
  const inspect = useAtomCommand(cloudAllocations.inspectExpoMetro, { reportFailure: false });
  const control = useAtomCommand(cloudAllocations.controlExpoMetro, { reportFailure: false });
  const [status, setStatus] = useState<CloudExpoMetroStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await inspect({
      environmentId: props.environmentId,
      input: { agentId: props.agentId },
    });
    if (AsyncResult.isSuccess(result)) {
      setStatus(result.value);
      setError(null);
      return;
    }
    setError("Metro status could not be loaded from the Daytona sandbox.");
  }, [inspect, props.agentId, props.environmentId]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The RPC completes asynchronously before publishing remote status.
    void load();
  }, [load]);

  useEffect(() => {
    if (
      status?.status !== "available" ||
      (status.session.status !== "starting" &&
        !(
          status.session.status === "ready" &&
          status.session.metro.lastClientConnectionAt === undefined
        ))
    ) {
      return;
    }
    const interval = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(interval);
  }, [load, status]);

  const runControl = async (
    input:
      | { readonly action: "start" | "restart"; readonly platform: "android" | "ios" }
      | { readonly action: "stop" },
  ) => {
    setBusy(true);
    const base = {
      agentId: props.agentId,
      commandId: CommandId.make(randomUUID()),
      occurredAt: new Date().toISOString(),
    };
    const command: CloudExpoMetroControlInput =
      input.action === "stop" ? { ...base, action: "stop" } : { ...base, ...input };
    const result = await control({
      environmentId: props.environmentId,
      input: command,
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      setStatus(result.value);
      setError(null);
      return;
    }
    setError("The controller rejected that Metro action.");
    await load();
  };

  if (status === null) {
    return (
      <section className="rounded-xl border bg-muted/16 p-4">
        <p className="text-sm text-muted-foreground">{error ?? "Loading Metro status..."}</p>
      </section>
    );
  }

  if (status.status === "unavailable") {
    if (status.reasonCode === "not-expo-development-client") return null;
    return (
      <section className="rounded-xl border bg-muted/16 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <SmartphoneIcon aria-hidden className="size-4" strokeWidth={2} />
              <h2 className="text-sm font-semibold">Expo development build</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{status.reason}</p>
          </div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
            <RefreshCwIcon aria-hidden />
            Refresh
          </Button>
        </div>
      </section>
    );
  }

  const labels = cloudExpoMetroLabels(status.session);
  const compatibility = status.compatibility;
  const buildError = compatibility.status === "rebuild-required";
  const sessionError =
    status.session.status === "metro-error" ||
    status.session.status === "tunnel-error" ||
    status.session.status === "startup-error";
  const ready = status.session.status === "ready";
  const canOpen = ready && !buildError;
  const sessionErrorReason =
    status.session.status === "metro-error"
      ? status.session.metro.reason
      : status.session.status === "tunnel-error" || status.session.status === "startup-error"
        ? status.session.tunnel.reason
        : undefined;

  return (
    <section className="rounded-xl border bg-muted/16 p-4" data-testid="cloud-expo-metro">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <SmartphoneIcon aria-hidden className="size-4" strokeWidth={2} />
            <h2 className="text-sm font-semibold">Expo development build</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {status.project.root} · {status.project.packageManager} · Daytona attempt{" "}
            {status.attempt}
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
          <RefreshCwIcon aria-hidden />
          Refresh
        </Button>
      </div>

      {error === null ? null : <p className="mt-3 text-sm text-destructive">{error}</p>}

      {sessionErrorReason === undefined ? null : (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive"
        >
          <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
          <p>{sessionErrorReason}</p>
        </div>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <StatusItem
          label="Metro"
          value={labels.metro}
          error={status.session.metro.status === "error"}
          ready={status.session.metro.status === "running"}
        />
        <StatusItem
          label="Tunnel"
          value={labels.tunnel}
          error={status.session.tunnel.status === "error"}
          ready={status.session.tunnel.status === "ready"}
        />
        <StatusItem
          label="Development build"
          value={buildError ? "Rebuild required" : "Compatible"}
          error={buildError}
          ready={!buildError}
        />
      </div>

      <p
        className={
          buildError ? "mt-3 text-sm text-destructive" : "mt-3 text-sm text-muted-foreground"
        }
      >
        {compatibility.detail}
      </p>
      {compatibility.status === "unsupported" ||
      compatibility.fastRefreshPaths.length === 0 ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          Fast Refresh changes: {compatibility.fastRefreshPaths.slice(0, 4).join(", ")}
          {compatibility.fastRefreshPaths.length > 4 ? " and more" : ""}
        </p>
      )}
      {compatibility.status !== "rebuild-required" ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          Native changes: {compatibility.nativePaths.slice(0, 4).join(", ")}
          {compatibility.nativePaths.length > 4 ? " and more" : ""}
        </p>
      )}

      {ready ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0 text-sm">
            <p>
              Started in {cloudExpoStartupLabel(status.session.metro.startupMs)}
              {status.session.metro.lastClientConnectionAt === undefined
                ? " · waiting for the phone"
                : ` · phone connected ${formatRelativeTimeLabel(status.session.metro.lastClientConnectionAt)}`}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {status.session.tunnel.appId ?? status.session.tunnel.scheme}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                render={
                  <a
                    href={canOpen ? status.session.tunnel.deepLink : undefined}
                    aria-disabled={!canOpen}
                  />
                }
                size="sm"
                disabled={!canOpen}
              >
                <ExternalLinkIcon aria-hidden />
                {status.session.metro.lastClientConnectionAt === undefined
                  ? "Open on phone"
                  : "Reconnect"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void runControl({ action: "restart", platform: status.platform ?? "android" })
                }
              >
                <RotateCwIcon aria-hidden />
                Restart
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void runControl({ action: "stop" })}
              >
                <SquareIcon aria-hidden />
                Stop
              </Button>
            </div>
          </div>
          <div className="rounded-xl bg-white p-2 shadow-sm outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">
            <QRCodeSvg
              value={status.session.tunnel.deepLink}
              size={128}
              marginSize={2}
              title="Scan to open this Metro session in the installed Expo development build"
              className="rounded-lg"
            />
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {status.session.status === "stopped" ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void runControl({ action: "start", platform: "android" })}
              >
                Start for Android
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void runControl({ action: "start", platform: "ios" })}
              >
                Start for iOS
              </Button>
            </>
          ) : null}
          {cloudExpoMetroCanRetry(status.session) ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void runControl({ action: "restart", platform: status.platform ?? "android" })
              }
            >
              <RotateCwIcon aria-hidden />
              Retry
            </Button>
          ) : null}
          {status.session.status === "starting" || sessionError ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void runControl({ action: "stop" })}
            >
              <SquareIcon aria-hidden />
              Stop
            </Button>
          ) : null}
        </div>
      )}

      {status.session.logs.length === 0 ? null : (
        <details className="mt-4 rounded-lg bg-muted/48 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Metro logs</summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
            {status.session.logs}
          </pre>
        </details>
      )}
    </section>
  );
}
