import type { CloudExpoMetroSession } from "@t3tools/contracts";

export function cloudExpoMetroLabels(session: CloudExpoMetroSession): {
  readonly metro: string;
  readonly tunnel: string;
} {
  switch (session.status) {
    case "stopped":
      return { metro: "Stopped", tunnel: "Unavailable" };
    case "starting":
      return { metro: "Starting", tunnel: "Connecting" };
    case "ready":
      return { metro: "Running", tunnel: "Ready" };
    case "metro-error":
      return { metro: "Error", tunnel: "Unavailable" };
    case "tunnel-error":
      return { metro: "Running", tunnel: "Error" };
    case "startup-error":
      return { metro: "Error", tunnel: "Error" };
  }
}

export function cloudExpoMetroCanRetry(session: CloudExpoMetroSession): boolean {
  switch (session.status) {
    case "metro-error":
      return session.metro.retryable;
    case "tunnel-error":
    case "startup-error":
      return session.tunnel.retryable;
    case "stopped":
    case "starting":
    case "ready":
      return false;
  }
}

export function cloudExpoStartupLabel(startupMs: number): string {
  return startupMs < 1_000 ? `${startupMs} ms` : `${Math.round((startupMs / 1_000) * 10) / 10} s`;
}
