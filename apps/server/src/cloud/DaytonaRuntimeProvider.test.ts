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
      executeCommand: async () => ({ exitCode: 0, result: "command output" }),
    },
    start: async () => {
      state.lifecycle = "started";
    },
    stop: async () => {
      state.lifecycle = "stopped";
    },
    archive: async () => {
      state.lifecycle = "archived";
    },
    delete: async () => {
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
  } = {},
) {
  const sandboxes: Array<ReturnType<typeof fakeSandbox>["sandbox"]> = [];
  let createCalls = 0;
  let lastCreateParams:
    | {
        readonly envVars: Record<string, string>;
        readonly labels: Record<string, string>;
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
    },
    client: {
      create: async (params: {
        readonly envVars: Record<string, string>;
        readonly labels: Record<string, string>;
      }) => {
        createCalls += 1;
        lastCreateParams = params;
        const created = fakeSandbox();
        created.state.labels = { ...params.labels };
        created.state.environment = { ...params.envVars };
        if (input.rememberBeforeCreateError === true) sandboxes.push(created.sandbox);
        if (input.createError !== undefined) throw input.createError;
        if (input.rememberBeforeCreateError !== true) sandboxes.push(created.sandbox);
        return created.sandbox;
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

    expect(created.lifecycleState).toBe("started");
    expect(
      (yield* provider.execute({ runtimeId: created.runtimeId, command: "echo ok" })).output,
    ).toBe("command output");
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
    expect((yield* provider.stop(created.runtimeId)).lifecycleState).toBe("stopped");
    expect(
      (yield* provider.start({ runtimeId: created.runtimeId, assignment })).lifecycleState,
    ).toBe("started");
    yield* provider.stop(created.runtimeId);
    expect((yield* provider.archive(created.runtimeId)).lifecycleState).toBe("archived");
    yield* provider.delete(created.runtimeId);

    expect(fake.state.sandboxes[0]?.state).toBe("destroyed");
  }),
);
