import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudAccountingCatalog from "./CloudAccountingCatalog.ts";
import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudAgentsApiKeys from "./CloudAgentsApiKeys.ts";
import * as CloudCollaboration from "./CloudCollaboration.ts";
import { admitCloudRun } from "./cloudCollaborationAdmit.ts";

const live = CloudCollaboration.layer.pipe(
  Layer.provideMerge(CloudAgentsApi.layer),
  Layer.provideMerge(CloudAgentsApiKeys.layer),
  Layer.provideMerge(
    Layer.effect(
      CloudAllocationController.CloudAllocationController,
      CloudAllocationController.make({ enabled: true }),
    ),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect("connects SCM hosts and reuses one idempotent run path", () =>
  Effect.gen(function* () {
    const keys = yield* CloudAgentsApiKeys.CloudAgentsApiKeys;
    const collaboration = yield* CloudCollaboration.CloudCollaboration;
    const api = yield* CloudAgentsApi.CloudAgentsApi;
    const createdKey = yield* keys.create({ name: "User key", kind: "user" });
    const principal = (yield* keys.authenticate(createdKey.token))!;

    const github = yield* collaboration.connect({
      kind: "github",
      displayName: "GitHub",
      baseUrl: "https://github.com",
      installedRepositories: ["acme/app"],
    });
    yield* collaboration.connect({
      kind: "gitlab",
      displayName: "GitLab",
      baseUrl: "https://gitlab.com",
      installedRepositories: ["group/sub/app"],
    });
    yield* collaboration.connect({
      kind: "bitbucket",
      displayName: "Bitbucket",
      baseUrl: "https://bitbucket.org",
      installedRepositories: ["ws/repo"],
    });
    yield* collaboration.connect({
      kind: "azure-devops",
      displayName: "Azure DevOps",
      baseUrl: "https://dev.azure.com",
      installedRepositories: ["org/project/_git/repo"],
    });
    expect((yield* collaboration.listConnections()).map((row) => row.kind)).toEqual([
      "github",
      "gitlab",
      "bitbucket",
      "azure-devops",
    ]);

    const first = yield* admitCloudRun({
      principal,
      urlOrigin: "http://localhost",
      entryPoint: "slack",
      deliveryId: "Ev1",
      prompt: { text: "Fix the flaky test" },
      create: {
        prompt: { text: "Fix the flaky test" },
        repos: [{ url: "https://github.com/acme/app", startingRef: "main" }],
        autoCreatePR: true,
        skipReviewerRequest: true,
      },
    });
    const replay = yield* admitCloudRun({
      principal,
      urlOrigin: "http://localhost",
      entryPoint: "slack",
      deliveryId: "Ev1",
      prompt: { text: "Fix the flaky test" },
    });
    expect(replay).toEqual({ ...first, reused: true });
    expect(first.reused).toBe(false);

    const created = yield* api.getAgent({
      principal,
      agentId: first.agentId,
      urlOrigin: "http://localhost",
    });
    expect(created.autoCreatePR).toBe(true);

    const denied = yield* admitCloudRun({
      principal,
      urlOrigin: "http://localhost",
      entryPoint: "linear",
      deliveryId: "comment-1",
      prompt: { text: "Other repo" },
      create: {
        prompt: { text: "Other repo" },
        repos: [{ url: "https://github.com/other/app" }],
      },
    }).pipe(Effect.flip);
    expect(denied).toMatchObject({ reason: "scm-access-denied" });

    const shared = yield* collaboration.viewSharedAgent({
      principal,
      ownerPrincipalId: principal.principalId,
      ownerTeamId: "local-team",
      agentRepositories: ["acme/app"],
    });
    expect(shared.mode).toBe("owner");

    const teammate = {
      ...principal,
      principalId: "principal:teammate",
    };
    const readOnly = yield* collaboration.viewSharedAgent({
      principal: teammate,
      ownerPrincipalId: principal.principalId,
      ownerTeamId: "local-team",
      agentRepositories: ["acme/app"],
    });
    expect(readOnly.mode).toBe("read-only");
    const followUp = yield* collaboration
      .authorizeFollowUp({
        principal: teammate,
        ownerPrincipalId: principal.principalId,
        ownerTeamId: "local-team",
      })
      .pipe(Effect.flip);
    expect(followUp).toMatchObject({ reason: "follow-up-forbidden" });

    yield* collaboration.disconnect(github.id);
    expect((yield* collaboration.listConnections()).map((row) => row.kind)).toEqual([
      "gitlab",
      "bitbucket",
      "azure-devops",
    ]);
    const audit = yield* (yield* CloudAccountingCatalog.make()).listAudit();
    expect(audit.map((event) => event.resourceId)).toContain(github.id);
    expect(
      audit.filter((event) => event.resourceId === github.id).map((event) => event.action),
    ).toEqual(["auth", "auth"]);
  }).pipe(Effect.provide(live)),
);
