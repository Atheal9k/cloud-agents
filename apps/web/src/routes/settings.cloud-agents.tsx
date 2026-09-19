import { createFileRoute } from "@tanstack/react-router";

import { CloudAgentsSettingsPanel } from "../components/settings/CloudAgentsSettings";

export const Route = createFileRoute("/settings/cloud-agents")({
  component: CloudAgentsSettingsPanel,
});
