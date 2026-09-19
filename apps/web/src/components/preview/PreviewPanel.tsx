"use client";

import type { PreviewAnnotationPayload, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { Button } from "~/components/ui/button";
import { useServerConfigs } from "~/state/entities";
import { DeviceDisplayView } from "./DeviceDisplayView";
import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";
import { previewPanelKind } from "./previewPanelKind";
import { SharedBrowserView } from "./SharedBrowserView";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

export function PreviewPanel({
  mode,
  threadRef,
  tabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  const [surface, setSurface] = useState<"direct" | "agent">("direct");
  const serverConfigs = useServerConfigs();
  const kind = previewPanelKind(
    serverConfigs.get(threadRef.environmentId)?.environment.capabilities.deviceDisplay,
  );

  if (kind === "android" || kind === "ios") {
    return (
      <PreviewPanelShell mode={mode}>
        <DeviceDisplayView threadRef={threadRef} visible={visible} />
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2">
        <Button
          size="xs"
          variant={surface === "direct" ? "secondary" : "ghost-muted"}
          aria-pressed={surface === "direct"}
          onClick={() => setSurface("direct")}
        >
          App preview
        </Button>
        <Button
          size="xs"
          variant={surface === "agent" ? "secondary" : "ghost-muted"}
          aria-pressed={surface === "agent"}
          onClick={() => setSurface("agent")}
        >
          Agent browser
        </Button>
      </div>
      {surface === "direct" ? (
        <PreviewView
          threadRef={threadRef}
          {...(tabId !== undefined ? { tabId } : {})}
          configuredUrls={configuredUrls}
          visible={visible}
          {...(onSendAnnotation ? { onSendAnnotation } : {})}
        />
      ) : (
        <SharedBrowserView threadRef={threadRef} visible={visible} />
      )}
    </PreviewPanelShell>
  );
}
