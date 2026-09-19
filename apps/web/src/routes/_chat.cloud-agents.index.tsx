import { createFileRoute } from "@tanstack/react-router";

import { CloudAgentReviewList } from "../components/cloud/CloudAgentReviewView";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { usePrimaryEnvironmentId } from "../state/environments";

function CloudAgentsIndexRoute() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarInset>
      <WorkspacePageHeader>
        <h1 className="text-sm font-medium">Cloud agents</h1>
      </WorkspacePageHeader>
      {environmentId === null ? (
        <p className="p-6 text-sm text-muted-foreground">Connect an environment to review agents.</p>
      ) : (
        <CloudAgentReviewList environmentId={environmentId} />
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/cloud-agents/")({
  component: CloudAgentsIndexRoute,
});
