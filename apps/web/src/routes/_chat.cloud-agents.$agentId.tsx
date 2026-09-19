import { CloudAgentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { CloudAgentReviewView } from "../components/cloud/CloudAgentReviewView";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { usePrimaryEnvironmentId } from "../state/environments";

function CloudAgentReviewRoute() {
  const { agentId } = Route.useParams();
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarInset>
      <WorkspacePageHeader>
        <h1 className="text-sm font-medium">Cloud agent review</h1>
      </WorkspacePageHeader>
      {environmentId === null ? (
        <p className="p-6 text-sm text-muted-foreground">Connect an environment to review agents.</p>
      ) : (
        <CloudAgentReviewView environmentId={environmentId} agentId={CloudAgentId.make(agentId)} />
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/cloud-agents/$agentId")({
  component: CloudAgentReviewRoute,
});
