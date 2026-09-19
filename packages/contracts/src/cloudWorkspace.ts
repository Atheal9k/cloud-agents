import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

/**
 * Placeholder target while a no-repository agent works in an isolated tree.
 * Publication waits until a draft repository is created through the T3 Git
 * provider path.
 */
export const CLOUD_SCRATCH_WORKSPACE_REPOSITORY = "scratch/workspace";

export const CLOUD_SCRATCH_DRAFT_NAME_MAX_CHARS = 100;
export const CLOUD_SCRATCH_DRAFT_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;

export const CloudWorkspaceKind = Schema.Literals(["repositories", "scratch"]);
export type CloudWorkspaceKind = typeof CloudWorkspaceKind.Type;

export const CloudWorkspaceIncompatibility = Schema.Literals(["long-running"]);
export type CloudWorkspaceIncompatibility = typeof CloudWorkspaceIncompatibility.Type;

export const CloudScratchCapability = Schema.Literals(["port-forward", "design-mode", "deploy"]);
export type CloudScratchCapability = typeof CloudScratchCapability.Type;

export const CloudScratchDraftVisibility = Schema.Literals(["private", "internal"]);
export type CloudScratchDraftVisibility = typeof CloudScratchDraftVisibility.Type;

export const CloudScratchDraftName = TrimmedNonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(CLOUD_SCRATCH_DRAFT_NAME_MAX_CHARS)),
  Schema.check(Schema.isPattern(CLOUD_SCRATCH_DRAFT_NAME_PATTERN)),
);
export type CloudScratchDraftName = typeof CloudScratchDraftName.Type;

export const CloudScratchDraftRepository = Schema.Struct({
  name: CloudScratchDraftName,
  visibility: CloudScratchDraftVisibility,
  provider: Schema.optionalKey(SourceControlProviderKind),
});
export type CloudScratchDraftRepository = typeof CloudScratchDraftRepository.Type;

export const CloudWorkspaceRepository = Schema.Struct({
  repository: TrimmedNonEmptyString,
  defaultRef: TrimmedNonEmptyString,
});
export type CloudWorkspaceRepository = typeof CloudWorkspaceRepository.Type;

export function isCloudScratchRepository(repository: string): boolean {
  return repository.trim().toLowerCase() === CLOUD_SCRATCH_WORKSPACE_REPOSITORY;
}

export function cloudWorkspaceKind(
  repositories: ReadonlyArray<{ readonly repository: string }>,
): CloudWorkspaceKind {
  if (repositories.length === 0) return "scratch";
  if (repositories.length === 1 && isCloudScratchRepository(repositories[0]!.repository)) {
    return "scratch";
  }
  return "repositories";
}

export function isCloudMultiRepoWorkspace(
  repositories: ReadonlyArray<{ readonly repository: string }>,
): boolean {
  return cloudWorkspaceKind(repositories) === "repositories" && repositories.length > 1;
}

/** Flatten a GitHub-style name so it can sit as a sibling directory. */
export function cloudWorkspaceRepositorySegment(repository: string): string {
  return repository.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
}

export function cloudWorkspaceIncompatibilities(
  repositories: ReadonlyArray<{ readonly repository: string }>,
): ReadonlyArray<CloudWorkspaceIncompatibility> {
  return isCloudMultiRepoWorkspace(repositories) ? ["long-running"] : [];
}
