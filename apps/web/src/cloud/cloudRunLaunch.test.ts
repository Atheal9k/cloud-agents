import {
  type CloudAllocationLimits,
  type CloudAllocationSnapshot,
  LINUX_ANDROID_WORKER_PROFILE_ID,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildCloudRunLaunchCommand,
  cloudRunDisplayState,
  cloudRunProjectOptions,
  controllerSummary,
  createInitialCloudRunDraft,
  reconcileCloudRunLaunchInstanceType,
  type CloudRunLaunchDraft,
} from "./cloudRunLaunch";

const limits: CloudAllocationLimits = {
  maxConcurrentWorkers: 1,
  maxQueueDepth: 4,
  maxRunSeconds: 7_200,
  maxInputWaitSeconds: 900,
  previewGraceSeconds: 900,
  idleReleaseSeconds: 3_600,
  conversationRetentionDays: 0,
  allowedInstanceTypes: ["t3.medium"],
};

const draft: CloudRunLaunchDraft = {
  repository: "Atheal9k/cloud-agents",
  selectedRef: "main",
  task: "Fix the flaky test",
  providerInstanceId: "codex",
  model: "gpt-5.6-sol",
  runtimeMode: "approval-required",
  runMinutes: "60",
  inputWaitMinutes: "15",
  instanceType: "t3.medium",
  workerProfile: "linux-web",
  publication: "automatic-draft-pr",
  baseBranch: "main",
  branchBehavior: "new-cursor-branch",
  skipReviewerRequest: false,
};

describe("cloud run launch", () => {
  it("offers each saved GitHub repository once", () => {
    const githubIdentity: RepositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/pingdotgg/t3code.git",
      },
      provider: "github",
      owner: "pingdotgg",
      name: "t3code",
      displayName: "pingdotgg/t3code",
    };

    expect(
      cloudRunProjectOptions([
        {
          title: "T3 Code",
          repositoryIdentity: githubIdentity,
        },
        {
          title: "Duplicate checkout",
          repositoryIdentity: githubIdentity,
        },
        {
          title: "Local only",
          repositoryIdentity: null,
        },
      ]),
    ).toEqual([
      {
        title: "T3 Code",
        repository: "pingdotgg/t3code",
      },
    ]);
  });

  it("starts new cloud threads with the requested defaults", () => {
    expect(createInitialCloudRunDraft(null, [], "pingdotgg/t3code")).toMatchObject({
      repository: "pingdotgg/t3code",
      runtimeMode: "full-access",
      runMinutes: "4320",
      publication: "automatic-draft-pr",
    });
  });

  it("starts a draft from the controller's saved defaults", () => {
    const snapshot = {
      controller: {
        mode: "permanent",
        requiresHostOnline: false,
        admission: { status: "open" },
        defaults: { model: "gpt-5.6-sol", repository: "t3tools/t3code", ref: "release" },
      },
      limits,
      workerPriceAssumptions: [],
      spendingControl: "estimate-only",
      allocations: [],
      usage: [],
    } as unknown as CloudAllocationSnapshot;
    const providers = [
      {
        instanceId: "codex",
        models: [
          { slug: "gpt-5.6-sol", isDefault: false, isCustom: false },
          { slug: "other", isDefault: true, isCustom: false },
        ],
      },
    ] as unknown as Parameters<typeof createInitialCloudRunDraft>[1];

    expect(createInitialCloudRunDraft(snapshot, providers)).toMatchObject({
      repository: "t3tools/t3code",
      selectedRef: "release",
      baseBranch: "release",
      model: "gpt-5.6-sol",
    });
    // An explicit repository still wins: the default only fills a blank.
    expect(createInitialCloudRunDraft(snapshot, providers, "pingdotgg/t3code").repository).toBe(
      "pingdotgg/t3code",
    );
  });

  it("ignores a default model the selected provider does not offer", () => {
    const snapshot = {
      controller: {
        mode: "permanent",
        requiresHostOnline: false,
        admission: { status: "open" },
        defaults: { model: "retired-model" },
      },
      limits,
      workerPriceAssumptions: [],
      spendingControl: "estimate-only",
      allocations: [],
      usage: [],
    } as unknown as CloudAllocationSnapshot;
    const providers = [
      { instanceId: "codex", models: [{ slug: "other", isDefault: true, isCustom: false }] },
    ] as unknown as Parameters<typeof createInitialCloudRunDraft>[1];

    expect(createInitialCloudRunDraft(snapshot, providers).model).toBe("other");
  });

  it("requires a saved GitHub project", () => {
    expect(
      buildCloudRunLaunchCommand({
        draft: { ...draft, repository: "" },
        limits,
        now: new Date("2026-09-17T10:00:00.000Z"),
        requestId: "request-19",
      }),
    ).toEqual({
      status: "invalid",
      message: "Choose a project linked to a source-control repository.",
    });
  });

  it("caps the initial run limit to a controller's lower maximum", () => {
    expect(
      createInitialCloudRunDraft(
        {
          controller: {
            mode: "local",
            requiresHostOnline: true,
            admission: { status: "open" },
          },
          limits,
          workerPriceAssumptions: [],
          spendingControl: "estimate-only",
          allocations: [],
          usage: [],
        },
        [],
      ).runMinutes,
    ).toBe("120");
  });

  it("promises a permanent controller outlives this computer, and a local one does not", () => {
    const snapshot = (requiresHostOnline: boolean) => ({
      controller: {
        mode: requiresHostOnline ? ("local" as const) : ("permanent" as const),
        requiresHostOnline,
        admission: { status: "open" as const },
        writability: { status: "writable" as const },
      },
      limits,
      workerPriceAssumptions: [],
      spendingControl: "estimate-only" as const,
      allocations: [],
      usage: [],
    });

    expect(controllerSummary(snapshot(true))).toContain("as long as its machine stays online");
    expect(controllerSummary(snapshot(false))).toContain("with this computer switched off");
    expect(controllerSummary(null)).toContain("Connecting");
  });

  it("selects an allowed worker when controller limits arrive after the draft", () => {
    const pendingDraft = { ...draft, instanceType: "" };
    const reconciled = reconcileCloudRunLaunchInstanceType(pendingDraft, limits);

    expect(reconciled.instanceType).toBe("t3.medium");
    expect(reconcileCloudRunLaunchInstanceType(reconciled, limits)).toBe(reconciled);
  });

  it("builds one durable request identity with the selected task policy", () => {
    const result = buildCloudRunLaunchCommand({
      draft,
      limits,
      now: new Date("2026-09-17T10:00:00.000Z"),
      requestId: "request-19",
    });

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.command.type !== "allocation.launch") return;
    expect(result.command).toMatchObject({
      commandId: "cloud-launch:request-19",
      allocationId: "request-19",
      control: { agentId: "agent:request-19", runId: "run:request-19:1" },
      target: {
        repository: "Atheal9k/cloud-agents",
        baseCommit: "main",
        branch: "cursor/request-19",
      },
      publication: { mode: "automatic-draft-pr", baseBranch: "main" },
      profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
      execution: {
        threadId: "thread-request-19-1",
        selectedRef: "main",
        unansweredRequestSeconds: 900,
        turn: {
          commandId: "cloud-launch:request-19",
          prompt: "Fix the flaky test",
          modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        },
      },
    });
  });

  it("continues an existing PR on the selected head without requesting reviewers", () => {
    const result = buildCloudRunLaunchCommand({
      draft: {
        ...draft,
        selectedRef: "cursor/existing",
        branchBehavior: "continue-pr",
        skipReviewerRequest: true,
      },
      limits,
      now: new Date("2026-09-17T10:00:00.000Z"),
      requestId: "request-19",
    });

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.command.type !== "allocation.launch") return;
    expect(result.command.target.branch).toBe("cursor/existing");
    expect(result.command.publication).toMatchObject({
      mode: "automatic-draft-pr",
      skipReviewerRequest: true,
    });
  });

  it("selects the macos-ios profile for Apple Silicon instance types", () => {
    const result = buildCloudRunLaunchCommand({
      draft: { ...draft, instanceType: "mac2-m2.metal" },
      limits: { ...limits, allowedInstanceTypes: ["mac2-m2.metal"] },
      now: new Date("2026-09-17T10:00:00.000Z"),
      requestId: "request-ios",
    });

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.command.type !== "allocation.launch") return;
    expect(result.command.profile).toEqual({
      id: "macos-ios",
      os: "darwin",
      arch: "arm64",
      device: "ios",
      instanceType: "mac2-m2.metal",
    });
  });

  it("selects linux-android only when the launch asks for the Android profile", () => {
    const result = buildCloudRunLaunchCommand({
      draft: {
        ...draft,
        instanceType: "m7i.xlarge",
        workerProfile: "linux-android",
      },
      limits: { ...limits, allowedInstanceTypes: ["m7i.xlarge"] },
      now: new Date("2026-09-17T10:00:00.000Z"),
      requestId: "request-android",
    });

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.command.type !== "allocation.launch") return;
    expect(result.command.profile).toEqual({
      id: LINUX_ANDROID_WORKER_PROFILE_ID,
      os: "linux",
      arch: "x64",
      device: "android",
      instanceType: "m7i.xlarge",
    });
    expect(
      buildCloudRunLaunchCommand({
        draft: { ...draft, workerProfile: "linux-android" },
        limits,
        now: new Date("2026-09-17T10:00:00.000Z"),
        requestId: "request-android-t3",
      }).status,
    ).toBe("invalid");
  });

  it("rejects limits before dispatch", () => {
    expect(
      buildCloudRunLaunchCommand({
        draft: { ...draft, runMinutes: "121" },
        limits,
        now: new Date("2026-09-17T10:00:00.000Z"),
        requestId: "request-19",
      }),
    ).toEqual({ status: "invalid", message: "Run time must be between 1 and 120 minutes." });
  });

  const displayCases: ReadonlyArray<
    readonly [
      "queued" | "registering" | "ready",
      "not-started" | "running" | "succeeded",
      "not-requested" | "running" | "succeeded",
      "busy" | "idle" | "hibernated" | "waking",
      (
        | "provisioning"
        | "setup"
        | "waiting"
        | "running"
        | "finalizing"
        | "cleanup"
        | "idle"
        | "hibernated"
        | "waking"
        | "complete"
      ),
    ]
  > = [
    ["queued", "not-started", "not-requested", "busy", "provisioning"],
    ["registering", "not-started", "not-requested", "busy", "setup"],
    ["ready", "not-started", "not-requested", "busy", "waiting"],
    ["ready", "running", "not-requested", "busy", "running"],
    ["ready", "succeeded", "not-requested", "busy", "finalizing"],
    ["ready", "succeeded", "not-requested", "idle", "idle"],
    ["ready", "succeeded", "not-requested", "hibernated", "hibernated"],
    ["queued", "not-started", "not-requested", "waking", "waking"],
    ["ready", "succeeded", "running", "busy", "cleanup"],
    ["ready", "succeeded", "succeeded", "busy", "complete"],
  ];

  it.each(displayCases)(
    "maps %s/%s/%s/%s to %s",
    (allocationState, agentOutcome, cleanupState, idleState, expected) => {
      expect(
        cloudRunDisplayState({
          allocationState: { status: allocationState },
          agentOutcome: { status: agentOutcome },
          cleanupState: { status: cleanupState },
          idleState: { status: idleState },
        }),
      ).toBe(expected);
    },
  );

  it("keeps a run visibly failed while cleanup proceeds", () => {
    expect(
      cloudRunDisplayState({
        allocationState: { status: "ready" },
        agentOutcome: { status: "failed" },
        cleanupState: { status: "running" },
        idleState: { status: "busy" },
      }),
    ).toBe("failed");
  });

  it("reports a cancelled hibernated agent as cleaning up, not hibernated", () => {
    expect(
      cloudRunDisplayState({
        allocationState: { status: "ready" },
        agentOutcome: { status: "succeeded" },
        cleanupState: { status: "requested" },
        idleState: { status: "hibernated" },
      }),
    ).toBe("cleanup");
  });
});
