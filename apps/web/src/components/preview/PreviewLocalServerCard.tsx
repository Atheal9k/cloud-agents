import type { ScopedThreadRef } from "@t3tools/contracts";
import { Logs } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";
import type { PreviewableServer } from "./useDiscoveredLocalServers";

interface Props {
  threadRef: ScopedThreadRef;
  server: PreviewableServer;
  onOpen: () => void;
}

export function PreviewLocalServerCard({ threadRef, server, onOpen }: Props) {
  const subtitle = describeServer(server);
  const terminal = server.terminal?.threadId === threadRef.threadId ? server.terminal : null;
  return (
    <div className="group flex w-full items-center">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <PreviewFaviconIcon threadRef={threadRef} url={server.requestedUrl} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{subtitle}</span>
          <span className="truncate text-xs text-muted-foreground">
            {server.host}:{server.port}
          </span>
        </span>
      </button>
      {terminal ? (
        <button
          type="button"
          aria-label={`Open logs for ${subtitle}`}
          onClick={() => useRightPanelStore.getState().openTerminal(threadRef, terminal.terminalId)}
          className="mr-3 flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Logs className="size-3.5" />
          Logs
        </button>
      ) : null}
    </div>
  );
}

function describeServer(server: PreviewableServer): string {
  if (server.processName) return server.processName;
  return "Listening";
}
