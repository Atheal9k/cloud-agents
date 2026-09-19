import {
  CLOUD_AGENT_BRANCH_PREFIX,
  CLOUD_TEAM_FOLLOW_UP_LATERAL_ACCESS_WARNING,
  CLOUD_TEAM_FOLLOW_UP_SECRET_RISK_WARNING,
  DEFAULT_CLOUD_TEAM_ID,
  type CloudBranchBehavior,
  type CloudBranchPlan,
  type CloudParsedRepository,
  type CloudRunEntryPoint,
  type CloudScmHostKind,
  type CloudSharedAgentViewMode,
  type CloudTeamFollowUpPolicy,
} from "@t3tools/contracts";

export {
  CLOUD_AGENT_BRANCH_PREFIX,
  CLOUD_TEAM_FOLLOW_UP_LATERAL_ACCESS_WARNING,
  CLOUD_TEAM_FOLLOW_UP_SECRET_RISK_WARNING,
  DEFAULT_CLOUD_TEAM_ID,
};

const GITHUB_HOST = /(^|\.)github\.com$/i;
const GITLAB_HOST = /(^|\.)gitlab\.com$/i;
const BITBUCKET_HOST = /(^|\.)bitbucket\.org$/i;

export function cloudTeamFollowUpWarnings(
  policy: CloudTeamFollowUpPolicy,
): ReadonlyArray<string> {
  if (policy === "disabled") return [];
  return [CLOUD_TEAM_FOLLOW_UP_LATERAL_ACCESS_WARNING, CLOUD_TEAM_FOLLOW_UP_SECRET_RISK_WARNING];
}

export function evaluateCloudTeamFollowUp(input: {
  readonly policy: CloudTeamFollowUpPolicy;
  readonly ownerPrincipalId: string;
  readonly actorPrincipalId: string;
  readonly actorKind: "user" | "service_account";
  readonly ownerTeamId: string;
  readonly actorTeamId: string;
}): { readonly allowed: true } | { readonly allowed: false; readonly message: string } {
  if (input.actorPrincipalId === input.ownerPrincipalId) return { allowed: true };
  if (input.ownerTeamId !== input.actorTeamId) {
    return { allowed: false, message: "Follow-ups require membership of the agent's team." };
  }
  switch (input.policy) {
    case "disabled":
      return {
        allowed: false,
        message: "Team follow-ups are disabled. Only the owner can continue this agent.",
      };
    case "service-accounts":
      return input.actorKind === "service_account"
        ? { allowed: true }
        : {
            allowed: false,
            message: "Team follow-ups are limited to service accounts.",
          };
    case "all":
      return { allowed: true };
  }
}

function listed(list: ReadonlyArray<string>, repository: string): boolean {
  const normalized = repository.trim().toLowerCase();
  return list.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (candidate === normalized) return true;
    return candidate.endsWith("*") && normalized.startsWith(candidate.slice(0, -1));
  });
}

/**
 * App install, triggering principal, and configured agent scope. Empty configured
 * scope means "whatever the other two already share".
 */
export function intersectCloudScmAccess(input: {
  readonly installRepositories: ReadonlyArray<string>;
  readonly principalRepositories: ReadonlyArray<string>;
  readonly configuredRepositories: ReadonlyArray<string>;
  readonly repository: string;
}): { readonly allowed: true } | { readonly allowed: false; readonly message: string } {
  const repository = input.repository.trim();
  if (!listed(input.installRepositories, repository)) {
    return {
      allowed: false,
      message: `'${repository}' is outside the connected source-control installation.`,
    };
  }
  if (!listed(input.principalRepositories, repository)) {
    return {
      allowed: false,
      message: `The triggering principal cannot reach '${repository}'.`,
    };
  }
  if (
    input.configuredRepositories.length > 0 &&
    !listed(input.configuredRepositories, repository)
  ) {
    return {
      allowed: false,
      message: `'${repository}' is outside this agent's configured repository scope.`,
    };
  }
  return { allowed: true };
}

export function evaluateCloudSharedAgentView(input: {
  readonly ownerPrincipalId: string;
  readonly ownerTeamId: string;
  readonly viewerPrincipalId: string;
  readonly viewerTeamId: string;
  readonly viewerRepositories: ReadonlyArray<string>;
  readonly agentRepositories: ReadonlyArray<string>;
}):
  | { readonly allowed: true; readonly mode: CloudSharedAgentViewMode }
  | { readonly allowed: false; readonly message: string } {
  if (input.viewerPrincipalId === input.ownerPrincipalId) {
    return { allowed: true, mode: "owner" };
  }
  if (input.ownerTeamId !== input.viewerTeamId) {
    return { allowed: false, message: "Shared agent URLs require same-team membership." };
  }
  for (const repository of input.agentRepositories) {
    if (!listed(input.viewerRepositories, repository)) {
      return {
        allowed: false,
        message: `Shared agent URLs also require the viewer's own access to '${repository}'.`,
      };
    }
  }
  return { allowed: true, mode: "read-only" };
}

export function cloudIdempotentRunKey(entryPoint: CloudRunEntryPoint, deliveryId: string): string {
  return `${entryPoint}:${deliveryId.trim()}`;
}

export function resolveCloudBranchPlan(input: {
  readonly agentId: string;
  readonly startingRef: string;
  readonly currentBranch?: string | undefined;
  readonly prHead?: string | undefined;
  readonly prUrl?: string | undefined;
  readonly workOnCurrentBranch?: boolean | undefined;
  readonly behavior?: CloudBranchBehavior | undefined;
  readonly autoCreatePR?: boolean | undefined;
  readonly skipReviewerRequest?: boolean | undefined;
}): CloudBranchPlan {
  const startingRef = input.startingRef.trim() || "main";
  const behavior: CloudBranchBehavior =
    input.behavior ??
    (input.prUrl !== undefined || input.prHead !== undefined
      ? "continue-pr"
      : input.workOnCurrentBranch === true
        ? "current-branch"
        : "new-cursor-branch");
  const slug = input.agentId.replace(/[^A-Za-z0-9-]/gu, "").slice(-12) || "agent";
  switch (behavior) {
    case "new-cursor-branch":
      return {
        behavior,
        branch: `${CLOUD_AGENT_BRANCH_PREFIX}${slug}`,
        selectedRef: startingRef,
        skipReviewerRequest: input.skipReviewerRequest === true,
        autoCreatePR: input.autoCreatePR === true,
      };
    case "current-branch": {
      const branch = (input.currentBranch ?? startingRef).trim() || startingRef;
      return {
        behavior,
        branch,
        selectedRef: branch,
        skipReviewerRequest: input.skipReviewerRequest === true,
        autoCreatePR: input.autoCreatePR === true,
      };
    }
    case "starting-ref":
      return {
        behavior,
        branch: startingRef,
        selectedRef: startingRef,
        skipReviewerRequest: input.skipReviewerRequest === true,
        autoCreatePR: input.autoCreatePR === true,
      };
    case "continue-pr": {
      const branch = (input.prHead ?? startingRef).trim() || startingRef;
      return {
        behavior,
        branch,
        selectedRef: branch,
        skipReviewerRequest: input.skipReviewerRequest === true,
        autoCreatePR: input.autoCreatePR === true,
      };
    }
  }
}

function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase();
}

function pathSegments(url: URL): string[] {
  return url.pathname
    .replace(/\.git$/u, "")
    .split("/")
    .filter((part) => part.length > 0);
}

export function parseCloudRepositoryUrl(raw: string): CloudParsedRepository | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = hostnameOf(url);
  const parts = pathSegments(url);
  if (parts.length < 2) return undefined;

  const azure =
    host === "dev.azure.com" || host.endsWith(".dev.azure.com") || host.endsWith(".visualstudio.com");
  if (azure) {
    const gitIndex = parts.indexOf("_git");
    if (gitIndex === -1 || parts[gitIndex + 1] === undefined) return undefined;
    const repository = parts.slice(0, gitIndex + 2).join("/");
    return {
      kind: "azure-devops",
      repository,
      hostPath: `${url.host}/${repository}`,
      url: url.toString(),
    };
  }

  if (BITBUCKET_HOST.test(host) || host.split(".").includes("bitbucket")) {
    const repository = `${parts[0]}/${parts[1]}`;
    return {
      kind: "bitbucket",
      repository,
      hostPath: `${url.host}/${repository}`,
      url: url.toString(),
    };
  }

  if (GITLAB_HOST.test(host) || host.split(".").includes("gitlab")) {
    const repository = parts.join("/");
    return {
      kind: host === "gitlab.com" ? "gitlab" : "gitlab-self-hosted",
      repository,
      hostPath: `${url.host}/${repository}`,
      url: url.toString(),
    };
  }

  if (GITHUB_HOST.test(host) || host.split(".").includes("github")) {
    const repository = `${parts[0]}/${parts[1]}`;
    return {
      kind: host === "github.com" ? "github" : "github-enterprise",
      repository,
      hostPath: `${url.host}/${repository}`,
      url: url.toString(),
    };
  }

  return undefined;
}

export function repositoryUrlForIdentity(input: {
  readonly provider: string;
  readonly selector: string;
  readonly canonicalKey?: string | undefined;
}): string | undefined {
  if (input.canonicalKey !== undefined && input.canonicalKey.includes("/")) {
    return `https://${input.canonicalKey}`;
  }
  switch (input.provider) {
    case "github":
      return `https://github.com/${input.selector}`;
    case "gitlab":
      return `https://gitlab.com/${input.selector}`;
    case "bitbucket":
      return `https://bitbucket.org/${input.selector}`;
    case "azure-devops":
      return undefined;
    default:
      return undefined;
  }
}

export function parseIntegrationDelivery(input: {
  readonly entryPoint: CloudRunEntryPoint;
  readonly payload: unknown;
}): { readonly deliveryId: string; readonly prompt: string; readonly agentId?: string } | undefined {
  if (input.payload === null || typeof input.payload !== "object") return undefined;
  const payload = input.payload as Record<string, unknown>;
  switch (input.entryPoint) {
    case "slack": {
      const event = payload.event;
      if (event === null || typeof event !== "object") return undefined;
      const body = event as Record<string, unknown>;
      const deliveryId =
        (typeof payload.event_id === "string" && payload.event_id) ||
        (typeof body.client_msg_id === "string" && body.client_msg_id) ||
        (typeof body.ts === "string" && body.ts) ||
        undefined;
      const text = typeof body.text === "string" ? body.text.replace(/<@[^>]+>/gu, "").trim() : "";
      if (deliveryId === undefined || text.length === 0) return undefined;
      return { deliveryId, prompt: text };
    }
    case "github-mention":
    case "bitbucket-mention": {
      const comment = payload.comment;
      if (comment === null || typeof comment !== "object") return undefined;
      const body = comment as Record<string, unknown>;
      const id = body.id;
      const text = typeof body.body === "string" ? body.body.trim() : "";
      if ((typeof id !== "number" && typeof id !== "string") || text.length === 0) return undefined;
      return { deliveryId: String(id), prompt: text };
    }
    case "linear": {
      const data = payload.data;
      if (data === null || typeof data !== "object") return undefined;
      const body = data as Record<string, unknown>;
      const id = typeof body.id === "string" ? body.id : undefined;
      const text = typeof body.body === "string" ? body.body.trim() : "";
      if (id === undefined || text.length === 0) return undefined;
      return { deliveryId: id, prompt: text };
    }
    default: {
      const deliveryId = typeof payload.deliveryId === "string" ? payload.deliveryId.trim() : "";
      const prompt =
        typeof payload.prompt === "string"
          ? payload.prompt.trim()
          : typeof (payload.prompt as { text?: unknown } | undefined)?.text === "string"
            ? String((payload.prompt as { text: string }).text).trim()
            : "";
      if (deliveryId.length === 0 || prompt.length === 0) return undefined;
      const agentId =
        typeof payload.agentId === "string" && payload.agentId.trim().length > 0
          ? payload.agentId.trim()
          : undefined;
      return { deliveryId, prompt, ...(agentId === undefined ? {} : { agentId }) };
    }
  }
}
