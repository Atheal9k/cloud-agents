import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CLOUD_AGENT_BRANCH_PREFIX,
  CloudCollaborationAdmitInput,
  CloudScmConnection,
  DEFAULT_CLOUD_TEAM_ID,
} from "./cloudCollaboration.ts";

const decodeConnection = Schema.decodeUnknownSync(CloudScmConnection);
const decodeAdmit = Schema.decodeUnknownSync(CloudCollaborationAdmitInput);

describe("cloud collaboration contracts", () => {
  it("decodes incremental SCM connections and an admit request", () => {
    expect(
      decodeConnection({
        id: "scm-1",
        kind: "gitlab-self-hosted",
        displayName: "GitLab",
        baseUrl: "https://gitlab.example",
        installedRepositories: ["group/app"],
        connectedAt: "2026-09-19T00:00:00.000Z",
      }).kind,
    ).toBe("gitlab-self-hosted");
    expect(
      decodeAdmit({
        entryPoint: "slack",
        deliveryId: "evt-1",
        teamId: DEFAULT_CLOUD_TEAM_ID,
        actorId: "principal:1",
        actorKind: "user",
        actorRepositories: ["acme/app"],
        prompt: { text: "Fix the flaky test" },
      }).entryPoint,
    ).toBe("slack");
    expect(CLOUD_AGENT_BRANCH_PREFIX).toBe("cursor/");
  });
});
