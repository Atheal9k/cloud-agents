/**
 * Multi-repo and start-from-scratch decisions that do not touch disk: which
 * repositories a Build may clone, whether long-running is allowed, and which
 * scratch capabilities stay inside the existing preview/artifact boundary.
 */
import {
  type CloudScratchCapability,
  type CloudScratchDraftRepository,
  type CloudScmAccessPolicy,
  type CloudScmAccessRequest,
  type CloudWorkspaceKind,
  CLOUD_SCRATCH_WORKSPACE_REPOSITORY,
  cloudWorkspaceIncompatibilities,
  cloudWorkspaceKind,
  isCloudMultiRepoWorkspace,
  isCloudScratchRepository,
} from "@t3tools/contracts";

import { evaluateCloudScmAccess } from "./cloudSecurityPolicy.ts";

export type CloudWorkspaceAdmission =
  | { readonly status: "accepted"; readonly kind: CloudWorkspaceKind }
  | { readonly status: "rejected"; readonly message: string };

export interface CloudWorkspaceRepositoryRef {
  readonly repository: string;
  readonly defaultRef?: string;
}

/**
 * Git remotes discovered after clone (submodules, LFS remotes, extra origins).
 * They are checked against the same intersection as configured repos so a
 * nested checkout cannot smuggle in a repository the triggering user cannot
 * already reach.
 */
export interface CloudDiscoveredGitDependency {
  readonly kind: "submodule" | "lfs" | "named";
  readonly repository: string;
}

export function parseCloudGitDependencyRepository(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return undefined;
  const ssh = /^git@[^:]+:(.+?)(?:\.git)?$/i.exec(trimmed);
  const path =
    ssh?.[1] ??
    (() => {
      try {
        return new URL(trimmed.replace(/^git\+/, "")).pathname
          .replace(/^\//, "")
          .replace(/\.git$/i, "");
      } catch {
        return trimmed.replace(/\.git$/i, "");
      }
    })();
  const segments = path.split("/").filter((part) => part.length > 0);
  if (segments.length < 2) return undefined;
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

export function cloudWorkspaceLaunchRepositories(input: {
  readonly primary: string;
  readonly additional?: ReadonlyArray<{ readonly repository: string }>;
}): ReadonlyArray<CloudWorkspaceRepositoryRef> {
  const seen = new Set<string>();
  const entries: Array<CloudWorkspaceRepositoryRef> = [];
  for (const repository of [
    input.primary,
    ...(input.additional ?? []).map((entry) => entry.repository),
  ]) {
    const key = repository.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    entries.push({ repository: repository.trim() });
  }
  return entries;
}

/**
 * Empty or placeholder targeting is start-from-scratch. Multi-repo targeting
 * withholds long-running. Every listed repository, plus any discovered
 * submodule or named private dependency, is checked against the triggering
 * user's intersection with the install and the environment's configured set.
 */
export function admitCloudWorkspaceLaunch(input: {
  readonly repositories: ReadonlyArray<CloudWorkspaceRepositoryRef>;
  readonly longRunning?: boolean;
  readonly discoveredDependencies?: ReadonlyArray<CloudDiscoveredGitDependency>;
  readonly scm?: {
    readonly policy: CloudScmAccessPolicy;
    readonly request: Omit<CloudScmAccessRequest, "repository">;
  };
}): CloudWorkspaceAdmission {
  const repositories = input.repositories.filter((entry) => entry.repository.trim().length > 0);
  const kind = cloudWorkspaceKind(repositories);
  if (kind === "scratch") {
    if (isCloudMultiRepoWorkspace(repositories)) {
      return {
        status: "rejected",
        message:
          "Start-from-scratch cannot mix an isolated workspace with configured repositories.",
      };
    }
    return { status: "accepted", kind };
  }

  if (input.scm !== undefined) {
    const configured = input.scm.request.configuredRepositories;
    const extra = (input.discoveredDependencies ?? []).flatMap((dependency) => {
      const repository =
        parseCloudGitDependencyRepository(dependency.repository) ?? dependency.repository;
      return repository.trim().length === 0 ? [] : [repository];
    });
    const targets = [...repositories.map((entry) => entry.repository), ...extra];
    const seen = new Set<string>();
    for (const repository of targets) {
      const key = repository.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (isCloudScratchRepository(repository)) continue;
      if (
        extra.some((candidate) => candidate.trim().toLowerCase() === key) &&
        configured !== undefined &&
        configured.length > 0 &&
        !repositories.some((entry) => entry.repository.trim().toLowerCase() === key)
      ) {
        return {
          status: "rejected",
          message: `Dependent repository '${repository}' is not listed as an environment repository and cannot widen this run's scope.`,
        };
      }
      const decision = evaluateCloudScmAccess({
        policy: input.scm.policy,
        request: { ...input.scm.request, repository },
      });
      if (!decision.allowed) return { status: "rejected", message: decision.message };
    }
  }

  if (
    input.longRunning === true &&
    cloudWorkspaceIncompatibilities(repositories).includes("long-running")
  ) {
    return {
      status: "rejected",
      message:
        "Long-running is not available for multi-repo environments. Select one repository or turn long-running off.",
    };
  }

  return { status: "accepted", kind };
}

/**
 * Scratch port-forward and Design Mode reuse the existing preview lease and
 * artifact boundary. Deploy waits until a draft repository exists so there is
 * a trusted publication target.
 */
export function admitCloudScratchCapability(input: {
  readonly kind: CloudWorkspaceKind;
  readonly capability: CloudScratchCapability;
  readonly draftPublished: boolean;
  readonly previewAllowed: boolean;
}): CloudWorkspaceAdmission {
  if (input.kind !== "scratch") return { status: "accepted", kind: input.kind };
  switch (input.capability) {
    case "port-forward":
    case "design-mode":
      return input.previewAllowed
        ? { status: "accepted", kind: "scratch" }
        : {
            status: "rejected",
            message: `${input.capability === "design-mode" ? "Design Mode" : "Port forwarding"} uses the same preview lease and artifact boundary as other cloud runs.`,
          };
    case "deploy":
      return input.draftPublished
        ? { status: "accepted", kind: "scratch" }
        : {
            status: "rejected",
            message: "Create a draft repository before deploying from scratch.",
          };
  }
}

export function cloudScratchLaunchTarget(draft?: CloudScratchDraftRepository): {
  readonly repository: string;
  readonly workspaceKind: CloudWorkspaceKind;
  readonly scratchDraft?: CloudScratchDraftRepository;
} {
  return {
    repository: CLOUD_SCRATCH_WORKSPACE_REPOSITORY,
    workspaceKind: "scratch",
    ...(draft === undefined ? {} : { scratchDraft: draft }),
  };
}
