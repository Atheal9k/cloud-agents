import { emptyCloudSessionLeases, type RunAllocation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CLOUD_COMMIT_SIGNING_SERVICE_IDENTITY,
  authorizeCloudCommitSigner,
  cloudCommitMessageWithProvenance,
  cloudCommitProviderVerification,
  cloudPullRequestBodyWithProvenance,
  collectCloudCommitProvenance,
  decideCloudCommitSigning,
} from "./cloudCommitSigningPolicy.ts";

const allocation = {
  id: "allocation-1",
  attempt: 1,
  target: { repository: "acme/app", baseCommit: "abc123", branch: "cursor/change" },
  publication: { mode: "review-only" },
  execution: {
    threadId: "thread-1",
    title: "Ship it",
    selectedRef: "main",
    unansweredRequestSeconds: 900,
    turn: {
      commandId: "turn-1",
      messageId: "message-1",
      prompt: "Do not put this prompt in git metadata",
      attachments: [],
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-09-19T01:00:00.000Z",
    },
  },
  control: { agentId: "agent-1", runId: "run-1" },
  environment: {
    environmentId: "env-1",
    versionId: "ver-1",
    version: 3,
    source: "dashboard",
  },
  build: {
    buildId: "bld-1",
    environmentId: "env-1",
    versionId: "ver-1",
    snapshot: { kind: "local", path: "/tmp/snap" },
    gitSetup: [],
  },
  profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
  deadlines: {
    launchBy: "2026-09-19T01:00:00.000Z",
    bootBy: "2026-09-19T01:00:00.000Z",
    registerBy: "2026-09-19T01:00:00.000Z",
    expiresAt: "2026-09-19T03:00:00.000Z",
    cleanupBy: "2026-09-19T03:05:00.000Z",
  },
  allocationState: { status: "queued" },
  agentOutcome: { status: "not-started" },
  previewState: { status: "unavailable" },
  leases: emptyCloudSessionLeases(),
  idleState: { status: "busy" },
  cleanupState: { status: "not-requested" },
  handledCommandIds: [],
  sequence: 1,
  createdAt: "2026-09-19T01:00:00.000Z",
  updatedAt: "2026-09-19T01:00:00.000Z",
} as unknown as RunAllocation;

describe("cloud commit signing authorization", () => {
  it("allows only controller publication for the recorded repository and service identity", () => {
    expect(
      authorizeCloudCommitSigner({
        caller: {
          kind: "trusted-publication",
          repository: "acme/app",
          identity: CLOUD_COMMIT_SIGNING_SERVICE_IDENTITY,
        },
        allowedRepository: "acme/app",
      }).allowed,
    ).toBe(true);
    expect(
      authorizeCloudCommitSigner({
        caller: { kind: "task-code" },
        allowedRepository: "acme/app",
      }),
    ).toMatchObject({ allowed: false });
    expect(
      authorizeCloudCommitSigner({
        caller: {
          kind: "trusted-publication",
          repository: "acme/other",
          identity: CLOUD_COMMIT_SIGNING_SERVICE_IDENTITY,
        },
        allowedRepository: "acme/app",
      }),
    ).toMatchObject({ allowed: false });
    expect(
      authorizeCloudCommitSigner({
        caller: { kind: "arbitrary", repository: "acme/app", identity: "agent-guest" },
        allowedRepository: "acme/app",
      }),
    ).toMatchObject({ allowed: false });
  });
});

describe("cloud commit signing decisions", () => {
  it("reuses a published or already-signed commit and never force-pushes", () => {
    expect(
      decideCloudCommitSigning({
        remoteCommit: "aaa",
        localCommit: "aaa",
        published: true,
        existingSignedCommit: "aaa",
        existingKeyId: "k1",
        currentKeyId: "k1",
        signerAvailable: true,
      }),
    ).toEqual({ action: "reuse", commit: "aaa" });
    expect(
      decideCloudCommitSigning({
        remoteCommit: "bbb",
        localCommit: "aaa",
        published: false,
        currentKeyId: "k1",
        signerAvailable: true,
      }),
    ).toMatchObject({ action: "reject-force-push" });
    expect(
      decideCloudCommitSigning({
        remoteCommit: null,
        localCommit: null,
        published: false,
        currentKeyId: "k1",
        signerAvailable: false,
      }),
    ).toMatchObject({ action: "retry-outage" });
    expect(
      decideCloudCommitSigning({
        remoteCommit: null,
        localCommit: "old",
        published: false,
        existingSignedCommit: "old",
        existingKeyId: "k1",
        currentKeyId: "k2",
        signerAvailable: true,
      }),
    ).toEqual({ action: "resign" });
    expect(
      decideCloudCommitSigning({
        remoteCommit: null,
        localCommit: null,
        published: false,
        currentKeyId: "k1",
        signerAvailable: true,
        forcePush: true,
      }),
    ).toMatchObject({ action: "reject-force-push" });
  });
});

describe("cloud commit provenance metadata", () => {
  it("links agent, run, environment, Build, base, provider, and principal without the prompt", () => {
    const provenance = collectCloudCommitProvenance({
      allocation,
      repository: "acme/app",
      principal: { kind: "user", id: "alice" },
    });
    expect(provenance).toMatchObject({
      agentId: "agent-1",
      runId: "run-1",
      environmentVersion: "env-1:3",
      buildId: "bld-1",
      baseCommit: "abc123",
      provider: "codex",
      model: "gpt-5.6-sol",
      principal: { kind: "user", id: "alice" },
    });
    const message = cloudCommitMessageWithProvenance("feat: ship it", provenance);
    const body = cloudPullRequestBodyWithProvenance("Controller-owned publication.", provenance);
    expect(message).toContain("T3-Cloud-Agent: agent-1");
    expect(message).not.toContain("Do not put this prompt");
    expect(body).toContain("Build: bld-1");
    expect(body).not.toContain("Do not put this prompt");
    expect(JSON.stringify(provenance)).not.toContain("prompt");
    expect(cloudCommitProviderVerification({ publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:x" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "github", method: "ssh-commit-signature" }),
        expect.objectContaining({ provider: "azure-devops" }),
      ]),
    );
  });
});
