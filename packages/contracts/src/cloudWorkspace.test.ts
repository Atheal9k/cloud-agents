import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  CLOUD_SCRATCH_WORKSPACE_REPOSITORY,
  CloudScratchDraftRepository,
  cloudWorkspaceIncompatibilities,
  cloudWorkspaceKind,
  cloudWorkspaceRepositorySegment,
  isCloudMultiRepoWorkspace,
  isCloudScratchRepository,
} from "./cloudWorkspace.ts";

describe("cloud workspace targeting", () => {
  it("treats an empty or placeholder list as start-from-scratch", () => {
    expect(cloudWorkspaceKind([])).toBe("scratch");
    expect(cloudWorkspaceKind([{ repository: CLOUD_SCRATCH_WORKSPACE_REPOSITORY }])).toBe(
      "scratch",
    );
    expect(isCloudScratchRepository("scratch/workspace")).toBe(true);
    expect(isCloudMultiRepoWorkspace([{ repository: "acme/web" }])).toBe(false);
  });

  it("marks multi-repo workspaces and withholds long-running until proven", () => {
    const repos = [{ repository: "acme/web" }, { repository: "acme/api" }];
    expect(cloudWorkspaceKind(repos)).toBe("repositories");
    expect(isCloudMultiRepoWorkspace(repos)).toBe(true);
    expect(cloudWorkspaceIncompatibilities(repos)).toEqual(["long-running"]);
    expect(cloudWorkspaceIncompatibilities([{ repository: "acme/web" }])).toEqual([]);
  });

  it("flattens repository names to one filesystem segment", () => {
    expect(cloudWorkspaceRepositorySegment("acme/web")).toBe("acme-web");
    expect(cloudWorkspaceRepositorySegment("github.com/acme/web")).toBe("github.com-acme-web");
  });

  it("accepts Cursor-shaped draft repository names and visibilities", () => {
    const decode = Schema.decodeUnknownExit(CloudScratchDraftRepository);
    expect(Exit.isSuccess(decode({ name: "hello-world", visibility: "private" }))).toBe(true);
    expect(Exit.isSuccess(decode({ name: "Team_App", visibility: "internal" }))).toBe(true);
    expect(Exit.isFailure(decode({ name: "has space", visibility: "private" }))).toBe(true);
    expect(Exit.isFailure(decode({ name: "-leading", visibility: "private" }))).toBe(true);
    expect(Exit.isFailure(decode({ name: "a".repeat(101), visibility: "private" }))).toBe(true);
  });
});
