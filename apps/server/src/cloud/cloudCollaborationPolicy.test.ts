import { describe, expect, it } from "vite-plus/test";

import {
  CLOUD_AGENT_BRANCH_PREFIX,
  CLOUD_TEAM_FOLLOW_UP_LATERAL_ACCESS_WARNING,
  CLOUD_TEAM_FOLLOW_UP_SECRET_RISK_WARNING,
  cloudIdempotentRunKey,
  cloudTeamFollowUpWarnings,
  evaluateCloudSharedAgentView,
  evaluateCloudTeamFollowUp,
  intersectCloudScmAccess,
  parseCloudRepositoryUrl,
  parseIntegrationDelivery,
  resolveCloudBranchPlan,
} from "./cloudCollaborationPolicy.ts";

describe("cloud SCM access intersection", () => {
  it("allows only repositories present in install, principal, and configured scope", () => {
    const sets = {
      installRepositories: ["acme/*", "gitlab.com/group/*"],
      principalRepositories: ["acme/app", "acme/other"],
      configuredRepositories: ["acme/app"],
    };
    expect(intersectCloudScmAccess({ ...sets, repository: "acme/app" })).toEqual({ allowed: true });
    expect(intersectCloudScmAccess({ ...sets, repository: "acme/other" })).toMatchObject({
      allowed: false,
    });
    expect(
      intersectCloudScmAccess({
        ...sets,
        principalRepositories: ["acme/app"],
        installRepositories: ["other/*"],
        repository: "acme/app",
      }),
    ).toMatchObject({ allowed: false, message: expect.stringContaining("installation") });
  });
});

describe("team follow-ups and shared URLs", () => {
  it("enforces disabled, service-account, and all policies", () => {
    const base = {
      ownerPrincipalId: "owner",
      actorPrincipalId: "teammate",
      actorKind: "user" as const,
      ownerTeamId: "team-a",
      actorTeamId: "team-a",
    };
    expect(evaluateCloudTeamFollowUp({ ...base, policy: "disabled" }).allowed).toBe(false);
    expect(
      evaluateCloudTeamFollowUp({ ...base, policy: "service-accounts", actorKind: "user" }).allowed,
    ).toBe(false);
    expect(
      evaluateCloudTeamFollowUp({
        ...base,
        policy: "service-accounts",
        actorKind: "service_account",
      }).allowed,
    ).toBe(true);
    expect(evaluateCloudTeamFollowUp({ ...base, policy: "all" }).allowed).toBe(true);
    expect(
      evaluateCloudTeamFollowUp({ ...base, policy: "all", actorTeamId: "other" }).allowed,
    ).toBe(false);
    expect(
      evaluateCloudTeamFollowUp({ ...base, policy: "disabled", actorPrincipalId: "owner" }).allowed,
    ).toBe(true);
  });

  it("surfaces lateral-access and secret-risk warnings when follow-ups are enabled", () => {
    expect(cloudTeamFollowUpWarnings("disabled")).toEqual([]);
    expect(cloudTeamFollowUpWarnings("all")).toEqual([
      CLOUD_TEAM_FOLLOW_UP_LATERAL_ACCESS_WARNING,
      CLOUD_TEAM_FOLLOW_UP_SECRET_RISK_WARNING,
    ]);
  });

  it("makes shared agent URLs team-and-SCM gated and read-only by default", () => {
    expect(
      evaluateCloudSharedAgentView({
        ownerPrincipalId: "owner",
        ownerTeamId: "team-a",
        viewerPrincipalId: "teammate",
        viewerTeamId: "team-a",
        viewerRepositories: ["acme/app"],
        agentRepositories: ["acme/app"],
      }),
    ).toEqual({ allowed: true, mode: "read-only" });
    expect(
      evaluateCloudSharedAgentView({
        ownerPrincipalId: "owner",
        ownerTeamId: "team-a",
        viewerPrincipalId: "owner",
        viewerTeamId: "team-a",
        viewerRepositories: [],
        agentRepositories: ["acme/app"],
      }),
    ).toEqual({ allowed: true, mode: "owner" });
    expect(
      evaluateCloudSharedAgentView({
        ownerPrincipalId: "owner",
        ownerTeamId: "team-a",
        viewerPrincipalId: "outsider",
        viewerTeamId: "team-b",
        viewerRepositories: ["acme/app"],
        agentRepositories: ["acme/app"],
      }).allowed,
    ).toBe(false);
    expect(
      evaluateCloudSharedAgentView({
        ownerPrincipalId: "owner",
        ownerTeamId: "team-a",
        viewerPrincipalId: "teammate",
        viewerTeamId: "team-a",
        viewerRepositories: ["acme/other"],
        agentRepositories: ["acme/app"],
      }).allowed,
    ).toBe(false);
  });
});

describe("branch plans and SCM URLs", () => {
  it("opens new cursor branches, continues PRs, and never invents a force-push flag", () => {
    expect(
      resolveCloudBranchPlan({
        agentId: "bc-1234567890ab",
        startingRef: "main",
        autoCreatePR: true,
        skipReviewerRequest: true,
      }),
    ).toMatchObject({
      behavior: "new-cursor-branch",
      branch: `${CLOUD_AGENT_BRANCH_PREFIX}1234567890ab`,
      selectedRef: "main",
      skipReviewerRequest: true,
      autoCreatePR: true,
    });
    expect(
      resolveCloudBranchPlan({
        agentId: "bc-1",
        startingRef: "main",
        workOnCurrentBranch: true,
        currentBranch: "release",
      }),
    ).toMatchObject({ behavior: "current-branch", branch: "release", selectedRef: "release" });
    expect(
      resolveCloudBranchPlan({
        agentId: "bc-1",
        startingRef: "main",
        prUrl: "https://github.com/acme/app/pull/12",
        prHead: "cursor/continue",
      }),
    ).toMatchObject({ behavior: "continue-pr", branch: "cursor/continue" });
    expect(
      resolveCloudBranchPlan({
        agentId: "bc-1",
        startingRef: "develop",
        behavior: "starting-ref",
      }),
    ).toMatchObject({ behavior: "starting-ref", branch: "develop" });
  });

  it("parses GitHub, GHES, GitLab nested groups, Bitbucket, and Azure DevOps URLs", () => {
    expect(parseCloudRepositoryUrl("https://github.com/acme/app.git")).toMatchObject({
      kind: "github",
      repository: "acme/app",
    });
    expect(parseCloudRepositoryUrl("https://github.myco.test/acme/app")).toMatchObject({
      kind: "github-enterprise",
      repository: "acme/app",
    });
    expect(parseCloudRepositoryUrl("https://gitlab.com/group/sub/app.git")).toMatchObject({
      kind: "gitlab",
      repository: "group/sub/app",
    });
    expect(parseCloudRepositoryUrl("https://gitlab.internal/group/app")).toMatchObject({
      kind: "gitlab-self-hosted",
      repository: "group/app",
    });
    expect(parseCloudRepositoryUrl("https://bitbucket.org/ws/repo")).toMatchObject({
      kind: "bitbucket",
      repository: "ws/repo",
    });
    expect(parseCloudRepositoryUrl("https://dev.azure.com/org/project/_git/repo")).toMatchObject({
      kind: "azure-devops",
      repository: "org/project/_git/repo",
    });
  });

  it("extracts a stable delivery id from Slack, GitHub, Bitbucket, and Linear payloads", () => {
    expect(
      parseIntegrationDelivery({
        entryPoint: "slack",
        payload: { event_id: "Ev1", event: { text: "<@U1> ship it", ts: "1.2" } },
      }),
    ).toEqual({ deliveryId: "Ev1", prompt: "ship it" });
    expect(
      parseIntegrationDelivery({
        entryPoint: "github-mention",
        payload: { comment: { id: 99, body: "@t3 fix this" } },
      }),
    ).toEqual({ deliveryId: "99", prompt: "@t3 fix this" });
    expect(
      parseIntegrationDelivery({
        entryPoint: "bitbucket-mention",
        payload: { comment: { id: "c-1", body: "please continue" } },
      }),
    ).toEqual({ deliveryId: "c-1", prompt: "please continue" });
    expect(
      parseIntegrationDelivery({
        entryPoint: "linear",
        payload: { data: { id: "comment-1", body: "follow up" } },
      }),
    ).toEqual({ deliveryId: "comment-1", prompt: "follow up" });
    expect(cloudIdempotentRunKey("slack", "Ev1")).toBe("slack:Ev1");
  });
});
