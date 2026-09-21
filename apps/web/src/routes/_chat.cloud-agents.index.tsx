import { createFileRoute } from "@tanstack/react-router";

import { CloudAgentReviewList } from "../components/cloud/CloudAgentReviewView";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { usePrimaryEnvironmentId } from "../state/environments";

function CloudAgentsIndexRoute() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader>
        <h1 className="text-sm font-medium">Cloud agents</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {environmentId === null ? (
          <p className="p-6 text-sm text-muted-foreground">
            Connect an environment to review agents.
          </p>
        ) : (
          <CloudAgentReviewList environmentId={environmentId} />
        )}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/cloud-agents/")({
  component: CloudAgentsIndexRoute,
});
