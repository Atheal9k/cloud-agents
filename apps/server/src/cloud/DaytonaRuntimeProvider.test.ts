import {
  CloudAgentId,
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudRunId,
  RunAllocationAttempt,
  RunAllocationId,
} from "@t3tools/contracts";
import {
  DaytonaConnectionTimeoutError,
  DaytonaProcessNotFoundError,
  DaytonaRateLimitError,
  DaytonaServiceUnavailableError,
  DaytonaUnprocessableEntityError,
} from "@daytona/sdk";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ResolvedDaytonaConfig } from "./daytonaConfig.ts";
import { make } from "./DaytonaRuntimeProvider.ts";

const allocationId = RunAllocationId.make("allocation-daytona");
const attempt = RunAllocationAttempt.make(1);

const assignment = {
  allocationId,
  attempt,
  agentId: CloudAgentId.make("agent-daytona"),
  runId: CloudRunId.make("run-daytona"),
  environmentId: CloudEnvironmentId.make("environment-daytona"),
  buildId: CloudEnvironmentBuildId.make("build-daytona"),
  snapshotId: "snapshot-daytona",
  environmentVariables: {
    T3CODE_CLOUD_REGISTRATION_CREDENTIAL: "registration-only",
  },
} as const;

function config(overrides: Partial<ResolvedDaytonaConfig> = {}): ResolvedDaytonaConfig {
  return {
    admission: "daytona",
    apiKey: "controller-secret-key",
    apiUrl: "https://app.daytona.io/api",
    target: "us",
    resourceClass: "small",
    project: "t3-cloud-agents",
    ...overrides,
  };
}

function fakeSandbox(id = "sandbox-daytona") {
  const state = {
    lifecycle: "started",
    labels: {} as Record<string, string>,
    environment: {} as Record<string, string>,
    deleted: false,
    snapshots: [] as string[],
    revokedTokens: [] as string[],
    statusFiles: new Map<string, number>(),
    sessions: new Map<
      string,
      { sessionId: string; commands: Array<{ id: string; command: string; exitCode?: number }> }
    >(),
    desktopStatus: "stopped",
    lifecycleCalls: { start: 0, stop: 0, archive: 0, delete: 0 },
    policyCalls: [] as Array<readonly [string, number]>,
  };
  const sandbox = {
    id,
    target: "us",
    get labels() {
      return state.labels;
    },
    get state() {
      return state.lifecycle;
    },
    process: {
      executeCommand: async (command: string) => {
        const statusPath = /cat '([^']+)'$/u.exec(command)?.[1];
        return {
          exitCode: 0,
          result:
            statusPath === undefined
              ? "command output"
              : String(state.statusFiles.get(statusPath) ?? ""),
        };
      },
      createSession: async (sessionId: string) => {
        if (!state.sessions.has(sessionId))
          state.sessions.set(sessionId, { sessionId, commands: [] });
      },
      getSession: async (sessionId: string) => {
        const session = state.sessions.get(sessionId);
        if (session === undefined) throw new DaytonaProcessNotFoundError("session not found", 404);
        return session;
      },
      executeSessionCommand: async (sessionId: string, request: { command: string }) => {
        const session = state.sessions.get(sessionId);
        if (session === undefined) throw new DaytonaProcessNotFoundError("session not found", 404);
        const command = { id: `command-${session.commands.length + 1}`, command: request.command };
        session.commands.push(command);
        return { cmdId: command.id };
      },
      getSessionCommandLogs: async () => ({ output: "process output" }),
      deleteSession: async (sessionId: string) => {
        if (!state.sessions.delete(sessionId))
          throw new DaytonaProcessNotFoundError("session not found", 404);
      },
    },
    computerUse: {
      start: async () => {
        state.desktopStatus = "started";
        return { status: state.desktopStatus };
      },
      stop: async () => {
        state.desktopStatus = "stopped";
        return { status: state.desktopStatus };
      },
      getStatus: async () => ({ status: state.desktopStatus }),
    },
    start: async () => {
      state.lifecycleCalls.start += 1;
      state.lifecycle = "started";
    },
    stop: async () => {
      state.lifecycleCalls.stop += 1;
      state.lifecycle = "stopped";
    },
    archive: async () => {
      state.lifecycleCalls.archive += 1;
      state.lifecycle = "archived";
    },
    setAutostopInterval: async (minutes: number) => {
      state.policyCalls.push(["stop", minutes]);
    },
    setAutoPauseInterval: async (minutes: number) => {
      state.policyCalls.push(["pause", minutes]);
    },
    setAutoArchiveInterval: async (minutes: number) => {
      state.policyCalls.push(["archive", minutes]);
    },
    setAutoDeleteInterval: async (minutes: number) => {
      state.policyCalls.push(["delete", minutes]);
    },
    setTtl: async (minutes: number) => {
      state.policyCalls.push(["ttl", minutes]);
    },
    delete: async () => {
      state.lifecycleCalls.delete += 1;
      state.lifecycle = "destroyed";
      state.deleted = true;
    },
    setLabels: async (labels: Record<string, string>) => {
      state.labels = labels;
      return labels;
    },
    updateEnv: async (environment: Record<string, string>) => {
      state.environment = environment;
    },
    createSnapshot: async (name: string) => {
      state.snapshots.push(name);
    },
    getSignedPreviewUrl: async () => ({
      url: "https://3000-sandbox.proxy.daytona.test/?token=preview-token",
      token: "preview-token",
    }),
    expireSignedPreviewUrl: async (_port: number, token: string) => {
      state.revokedTokens.push(token);
    },
  };
  return { sandbox, state };
}

function fakeClient(
  input: {
    readonly createError?: Error;
    readonly listError?: Error;
    readonly rememberBeforeCreateError?: boolean;
    readonly omitLabelsFromCreateResponse?: boolean;
  } = {},
) {
  const sandboxes: Array<ReturnType<typeof fakeSandbox>["sandbox"]> = [];
  let latestSandboxState: ReturnType<typeof fakeSandbox>["state"] | undefined;
  let createCalls = 0;
  let lastCreateParams:
    | {
        readonly image?: unknown;
        readonly snapshot?: string;
        readonly user: "root";
        readonly envVars: Record<string, string>;
        readonly labels: Record<string, string>;
        readonly public: false;
        readonly autoStopInterval: number;
        readonly autoPauseInterval: number;
        readonly autoArchiveInterval: number;
        readonly autoDeleteInterval: number;
        readonly ttlMinutes: number;
      }
    | undefined;
  return {
    state: {
      sandboxes,
      get createCalls() {
        return createCalls;
      },
      get lastCreateParams() {
        return lastCreateParams;
      },
      get latestSandboxState() {
        return latestSandboxState;
      },
    },
    client: {
      create: async (params: {
        readonly image?: unknown;
        readonly snapshot?: string;
        readonly user: "root";
        readonly envVars: Record<string, string>;
        readonly labels: Record<string, string>;
        readonly public: false;
        readonly autoStopInterval: number;
        readonly autoPauseInterval: number;
        readonly autoArchiveInterval: number;
        readonly autoDeleteInterval: number;
        readonly ttlMinutes: number;
      }) => {
        createCalls += 1;
        lastCreateParams = params;
        const created = fakeSandbox();
        latestSandboxState = created.state;
        created.state.labels = { ...params.labels };
        created.state.environment = { ...params.envVars };
        if (input.rememberBeforeCreateError === true) sandboxes.push(created.sandbox);
        if (input.createError !== undefined) throw input.createError;
        if (input.rememberBeforeCreateError !== true) sandboxes.push(created.sandbox);
        return input.omitLabelsFromCreateResponse
          ? { ...created.sandbox, labels: {} }
          : created.sandbox;
      },
      get: async (runtimeId: string) => {
        const sandbox = sandboxes.find((candidate) => candidate.id === runtimeId);
        if (sandbox === undefined) throw new Error("missing sandbox");
        return sandbox;
      },
      list: async function* (query: { readonly labels: Record<string, string> }) {
        if (input.listError !== undefined) throw input.listError;
        for (const sandbox of sandboxes) {
          if (Object.entries(query.labels).every(([key, value]) => sandbox.labels[key] === value)) {
            yield sandbox;
          }
        }
      },
    },
  };
}

it.effect("fails disabled and unauthenticated admission before create", () =>
  Effect.gen(function* () {
    const disabled = yield* make({ config: config({ admission: "disabled" }) });
    expect((yield* disabled.readiness()).admission).toBe("disabled");
    expect((yield* disabled.create(assignment).pipe(Effect.flip)).reason).toBe("disabled");

    const unauthenticated = yield* make({
      config: {
        admission: "daytona",
        apiUrl: "https://app.daytona.io/api",
        target: "us",
        resourceClass: "small",
        project: "t3-cloud-agents",
      },
    });
    expect((yield* unauthenticated.readiness()).authentication).toBe("missing");
    expect((yield* unauthenticated.create(assignment).pipe(Effect.flip)).reason).toBe(
      "unauthenticated",
    );
  }),
);

it.effect.each([
  [new DaytonaRateLimitError("quota exceeded", 429), "quota"],
  [new DaytonaUnprocessableEntityError("no runner capacity", 422), "capacity"],
] as const)("classifies Daytona admission failures", ([failure, reason]) =>
  Effect.gen(function* () {
    const fake = fakeClient({ createError: failure });
    const provider = yield* make({ config: config(), client: fake.client });
    expect((yield* provider.create(assignment).pipe(Effect.flip)).reason).toBe(reason);
  }),
);

it.effect("recovers a lost create response by allocation labels", () =>
  Effect.gen(function* () {
    const fake = fakeClient({
      createError: new DaytonaConnectionTimeoutError("response lost"),
      rememberBeforeCreateError: true,
    });
    const provider = yield* make({ config: config(), client: fake.client });

    expect((yield* provider.create(assignment).pipe(Effect.flip)).reason).toBe("provider-outage");
    const recovered = yield* provider.create(assignment);

    expect(recovered.runtimeId).toBe("sandbox-daytona");
    expect(recovered.allocationId).toBe(allocationId);
    expect(recovered.environmentId).toBe(assignment.environmentId);
    expect(recovered.buildId).toBe(assignment.buildId);
    expect(fake.state.createCalls).toBe(1);
    expect(fake.state.lastCreateParams?.envVars).not.toHaveProperty("DAYTONA_API_KEY");
  }),
);

it.effect("re-reads ownership labels omitted from the create response", () =>
  Effect.gen(function* () {
    const fake = fakeClient({ omitLabelsFromCreateResponse: true });
    const provider = yield* make({ config: config(), client: fake.client });

    const created = yield* provider.create(assignment);

    expect(created.runtimeId).toBe("sandbox-daytona");
    expect(created.allocationId).toBe(allocationId);
    expect(created.agentId).toBe(assignment.agentId);
  }),
);

it.effect("decodes sandboxes without optional environment or build labels", () =>
  Effect.gen(function* () {
    const fake = fakeClient();
    const provider = yield* make({ config: config(), client: fake.client });

    const created = yield* provider.create({
      allocationId,
      attempt,
      agentId: assignment.agentId,
      runId: assignment.runId,
      environmentVariables: assignment.environmentVariables,
    });

    expect(created.environmentId).toBeUndefined();
    expect(created.buildId).toBeUndefined();
    expect(fake.state.lastCreateParams?.image).toBeDefined();
    expect(fake.state.lastCreateParams?.user).toBe("root");
  }),
);

it.effect("refuses to attach a different agent to an existing allocation attempt", () =>
  Effect.gen(function* () {
    const fake = fakeClient();
    const provider = yield* make({ config: config(), client: fake.client });
    yield* provider.create(assignment);

    const error = yield* provider
      .create({ ...assignment, agentId: CloudAgentId.make("agent-other") })
      .pipe(Effect.flip);

    expect(error.reason).toBe("conflict");
    expect(fake.state.createCalls).toBe(1);
  }),
);

it.effect("applies environment lifecycle policy and fences destructive calls by ownership", () =>
  Effect.gen(function* () {
    const fake = fakeClient();
    const provider = yield* make({ config: config(), client: fake.client });
    const policy = {
      idle: { action: "pause" as const, afterMinutes: 20 },
      archiveAfterMinutes: 180,
      deleteAfterMinutes: 1_440,
      maxTtlMinutes: 2_880,
    };
    const created = yield* provider.create({ ...assignment, policy });

    expect(fake.state.lastCreateParams).toMatchObject({
      autoStopInterval: 0,
      autoPauseInterval: 20,
      autoArchiveInterval: 180,
      autoDeleteInterval: 1_440,
      ttlMinutes: 2_880,
    });
    expect(created.policy).toEqual(policy);

    yield* provider.start({ runtimeId: created.runtimeId, assignment: { ...assignment, policy } });
    expect(fake.state.latestSandboxState?.policyCalls).toEqual([
      ["stop", 0],
      ["pause", 20],
      ["archive", 180],
      ["delete", 1_440],
      ["ttl", 2_880],
    ]);

    const error = yield* provider
      .stop({
        runtimeId: created.runtimeId,
        allocationId: RunAllocationId.make("allocation-other"),
        attempt,
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("conflict");
    expect(fake.state.latestSandboxState?.lifecycleCalls.stop).toBe(0);
  }),
);

it.effect("reports provider outages without exposing the API key", () =>
  Effect.gen(function* () {
    const fake = fakeClient({
      listError: new DaytonaServiceUnavailableError(
        "controller-secret-key upstream unavailable",
        503,
      ),
    });
    const provider = yield* make({ config: config(), client: fake.client });
    const readiness = yield* provider.readiness();

    expect(readiness.reachability).toBe("unreachable");
    expect(readiness.detail).not.toContain("controller-secret-key");
    expect(readiness.detail).toContain("[redacted]");
  }),
);

it.effect("implements the provider-neutral lifecycle operations", () =>
  Effect.gen(function* () {
    const fake = fakeClient();
    const provider = yield* make({ config: config(), client: fake.client });
    const created = yield* provider.create(assignment);
    const owned = { runtimeId: created.runtimeId, allocationId, attempt };

    expect(created.lifecycleState).toBe("started");
    expect(
      (yield* provider.execute({ runtimeId: created.runtimeId, command: "echo ok" })).output,
    ).toBe("command output");
    const process = yield* provider.ensureProcess({
      runtimeId: created.runtimeId,
      sessionId: "worker-1",
      command: "t3 --no-browser",
    });
    expect(process.status).toBe("running");
    if (process.status === "missing") throw new Error("Expected a Daytona process command.");
    const duplicate = yield* provider.ensureProcess({
      runtimeId: created.runtimeId,
      sessionId: "worker-1",
      command: "t3 --no-browser",
    });
    if (duplicate.status === "missing") throw new Error("Expected a Daytona process command.");
    expect(duplicate.commandId).toBe(process.commandId);
    const command = fake.state.latestSandboxState?.sessions.get("worker-1")?.commands[0];
    if (command === undefined) throw new Error("Expected a persisted process command.");
    fake.state.latestSandboxState?.statusFiles.set("/tmp/t3-process-worker-1.exit", 0);
    expect(
      (yield* provider.inspectProcess({
        runtimeId: created.runtimeId,
        sessionId: "worker-1",
      })).status,
    ).toBe("succeeded");
    yield* provider.deleteProcess({ runtimeId: created.runtimeId, sessionId: "worker-1" });
    yield* provider.deleteProcess({ runtimeId: created.runtimeId, sessionId: "worker-1" });
    expect(
      (yield* provider.desktop({ runtimeId: created.runtimeId, action: "start" })).status,
    ).toBe("started");
    const preview = yield* provider.preview({
      action: "issue",
      runtimeId: created.runtimeId,
      port: 3000,
      expiresInSeconds: 60,
    });
    expect(preview?.token).toBe("preview-token");
    yield* provider.preview({
      action: "revoke",
      runtimeId: created.runtimeId,
      port: 3000,
      token: "preview-token",
    });
    yield* provider.snapshot({ runtimeId: created.runtimeId, name: "snapshot-test" });
    expect((yield* provider.stop(owned)).lifecycleState).toBe("stopped");
    yield* provider.stop(owned);
    expect(
      (yield* provider.start({ runtimeId: created.runtimeId, assignment })).lifecycleState,
    ).toBe("started");
    yield* provider.start({ runtimeId: created.runtimeId, assignment });
    yield* provider.stop(owned);
    expect((yield* provider.archive(owned)).lifecycleState).toBe("archived");
    yield* provider.archive(owned);
    yield* provider.delete(owned);
    yield* provider.delete(owned);

    expect(fake.state.sandboxes[0]?.state).toBe("destroyed");
    expect(fake.state.latestSandboxState?.lifecycleCalls).toEqual({
      start: 1,
      stop: 2,
      archive: 1,
      delete: 1,
    });
  }),
);
