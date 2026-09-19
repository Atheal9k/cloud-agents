import type {
  CloudAgentsApiCreateAgentRequest,
  CloudAgentsApiPrincipal,
  CloudRunEntryPoint,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CloudAgentsApi from "./CloudAgentsApi.ts";
import * as CloudCollaboration from "./CloudCollaboration.ts";
import { CloudAgentsApiFailure, apiError } from "./cloudAgentsApiModel.ts";
import { parseCloudRepositoryUrl } from "./cloudCollaborationPolicy.ts";

export const admitCloudRun = Effect.fn("admitCloudRun")(function* (input: {
  readonly principal: CloudAgentsApiPrincipal;
  readonly urlOrigin: string;
  readonly entryPoint: CloudRunEntryPoint;
  readonly deliveryId: string;
  readonly prompt: { readonly text: string };
  readonly agentId?: string | undefined;
  readonly create?: CloudAgentsApiCreateAgentRequest | undefined;
  readonly actorRepositories?: ReadonlyArray<string> | undefined;
}) {
  const api = yield* CloudAgentsApi.CloudAgentsApi;
  const collaboration = yield* CloudCollaboration.CloudCollaboration;
  const existing = yield* collaboration.findIdempotentRun({
    entryPoint: input.entryPoint,
    deliveryId: input.deliveryId,
  });
  if (existing !== undefined) {
    return { agentId: existing.agentId, runId: existing.runId, reused: true };
  }

  const createBody: CloudAgentsApiCreateAgentRequest =
    input.create ??
    ({
      prompt: input.prompt,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    } as CloudAgentsApiCreateAgentRequest);
  const repos = createBody.repos ?? [];
  const installed = yield* collaboration.installedRepositories();
  const actorRepositories =
    input.actorRepositories ?? (installed.length === 0 ? ["*"] : installed);
  const configured = repos.flatMap((repo) => {
    const parsed = parseCloudRepositoryUrl(repo.url);
    return parsed === undefined ? [] : [parsed.repository];
  });
  for (const repo of repos) {
    const parsed = parseCloudRepositoryUrl(repo.url);
    if (parsed === undefined) {
      return yield* Effect.fail(
        apiError("invalid_request", `Unsupported repository URL '${repo.url}'.`),
      );
    }
    yield* collaboration.authorizeRepository({
      repository: parsed.repository,
      actorRepositories,
      configuredRepositories: configured,
    });
  }

  if (input.agentId !== undefined && input.create === undefined) {
    const created = yield* api.createRun({
      principal: input.principal,
      agentId: input.agentId,
      body: { prompt: input.prompt },
    });
    yield* collaboration.rememberIdempotentRun({
      entryPoint: input.entryPoint,
      deliveryId: input.deliveryId,
      agentId: input.agentId,
      runId: created.run.id,
    });
    return { agentId: input.agentId, runId: created.run.id, reused: false };
  }

  const created = yield* api.createAgent({
    principal: input.principal,
    urlOrigin: input.urlOrigin,
    body: createBody,
  });
  yield* collaboration.rememberIdempotentRun({
    entryPoint: input.entryPoint,
    deliveryId: input.deliveryId,
    agentId: created.agent.id,
    runId: created.run.id,
  });
  return { agentId: created.agent.id, runId: created.run.id, reused: false };
});
