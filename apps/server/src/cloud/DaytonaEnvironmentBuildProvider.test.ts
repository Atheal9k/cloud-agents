import { DaytonaNotFoundError, Image, type Snapshot } from "@daytona/sdk";
import { expect, it } from "@effect/vitest";
import { CloudEnvironmentBuildId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  DAYTONA_BUILD_ARTIFACTS,
  type DaytonaEnvironmentBuildClient,
  make,
} from "./DaytonaEnvironmentBuildProvider.ts";
import type { ResolvedDaytonaConfig } from "./daytonaConfig.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";

function config(): ResolvedDaytonaConfig {
  return {
    admission: "daytona",
    apiKey: "controller-daytona-key",
    apiUrl: "https://app.daytona.io/api",
    target: "us",
    resourceClass: "small",
    project: "t3-cloud-agents",
  };
}

function snapshot(id: string, name: string): Snapshot {
  const createdAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-21T01:00:00.000Z"));
  return {
    __brand: "Snapshot",
    id,
    organizationId: "organization-test",
    general: false,
    name,
    imageName: "t3-worker",
    sourceSandboxId: "sandbox-prepare",
    state: "active",
    size: 4096,
    entrypoint: [],
    cpu: 2,
    gpu: 0,
    mem: 4,
    disk: 8,
    errorReason: "",
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: createdAt,
  };
}

function fakeClient(input: { readonly failVerification?: boolean } = {}) {
  const snapshots = new Map<string, Snapshot>();
  const createParams: Array<Parameters<DaytonaEnvironmentBuildClient["create"]>[0]> = [];
  const commands: Array<{
    readonly purpose: string;
    readonly command: string;
    readonly cwd?: string;
    readonly environment?: Record<string, string>;
  }> = [];
  const deletedSandboxes: string[] = [];
  const archivedSandboxes: string[] = [];
  const deletedSnapshots: string[] = [];
  const sandboxes = new Map<string, ReturnType<typeof makeSandbox>>();

  function makeSandbox(id: string, purpose: string) {
    return {
      id,
      process: {
        executeCommand: async (
          command: string,
          cwd?: string,
          environment?: Record<string, string>,
        ) => {
          commands.push({
            purpose,
            command,
            ...(cwd === undefined ? {} : { cwd }),
            ...(environment === undefined ? {} : { environment }),
          });
          if (input.failVerification === true && purpose === "environment-build-verify") {
            return { exitCode: 7, result: "corrupt snapshot" };
          }
          return {
            exitCode: 0,
            result: command.includes("/tmp/t3-install.sh") ? "build-secret" : "",
          };
        },
      },
      createSnapshot: async (name: string) => {
        const value = snapshot("snapshot-build-1", name);
        snapshots.set(name, value);
        snapshots.set(value.id, value);
      },
      archive: async () => {
        archivedSandboxes.push(id);
      },
      delete: async () => {
        deletedSandboxes.push(id);
      },
    };
  }

  const client: DaytonaEnvironmentBuildClient = {
    create: async (params) => {
      createParams.push(params);
      const purpose = params.labels["t3-purpose"] ?? "unknown";
      const sandbox = makeSandbox(`sandbox-${createParams.length}`, purpose);
      sandboxes.set(sandbox.id, sandbox);
      return sandbox;
    },
    get: async (sandboxId) => {
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox === undefined) throw new DaytonaNotFoundError("missing sandbox");
      return sandbox;
    },
    snapshots: {
      get: async (snapshotId) => {
        const value = snapshots.get(snapshotId);
        if (value === undefined) throw new DaytonaNotFoundError("missing snapshot");
        return value;
      },
      delete: async (snapshotId) => {
        const value = snapshots.get(snapshotId);
        if (value === undefined) throw new DaytonaNotFoundError("missing snapshot");
        deletedSnapshots.push(value.id);
        snapshots.delete(value.id);
        snapshots.delete(value.name);
      },
    },
  };

  return {
    client,
    state: {
      snapshots,
      createParams,
      commands,
      deletedSandboxes,
      archivedSandboxes,
      deletedSnapshots,
      sandboxes,
    },
  };
}

const buildInput = {
  buildId: CloudEnvironmentBuildId.make("build-1"),
  base: { kind: "image", image: "node:24.13.1-bookworm-slim" },
  inputsFingerprint: "a".repeat(64),
  gitSetup: [{ repository: "acme/web", defaultRef: "main", commit }],
  install: "printf installed > install.ok",
  secretEnv: { NPM_TOKEN: "build-secret" },
  redact: ["build-secret"],
} as const;

it.effect("prepares and verifies a cold Daytona Build without retaining credentials", () =>
  Effect.gen(function* () {
    const fake = fakeClient();
    const provider = yield* make({ config: config(), client: fake.client });
    const result = yield* provider.prepare(buildInput);

    expect(result.snapshot.id).toBe("snapshot-build-1");
    expect(result.snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshot.sizeBytes).toBe(4096);
    expect(result.logs[0]?.stdout).toBe("[redacted]");
    expect(result.timings.base).toBeDefined();
    expect(result.timings.clone).toBeDefined();
    expect(result.timings.install).toBeDefined();
    expect(result.timings.snapshot).toBeDefined();

    expect(fake.state.createParams).toHaveLength(2);
    expect(fake.state.createParams[0]?.image).toBeInstanceOf(Image);
    expect(fake.state.createParams[0]?.envVars).toEqual({});
    expect(fake.state.createParams[0]?.public).toBe(false);
    expect(fake.state.createParams[1]?.snapshot).toBe("snapshot-build-1");
    expect(fake.state.deletedSandboxes).toEqual(["sandbox-2", "sandbox-1"]);

    const install = fake.state.commands.find((entry) => entry.command.includes("t3-install.sh"));
    expect(install?.environment).toEqual({
      CI: "1",
      GIT_TERMINAL_PROMPT: "0",
      NPM_TOKEN: "build-secret",
    });
    expect(install?.environment).not.toHaveProperty("DAYTONA_API_KEY");
    expect(
      fake.state.commands.some((entry) =>
        entry.command.includes("/home/cloudagent/.git-credentials"),
      ),
    ).toBe(true);
    expect(fake.state.commands.some((entry) => entry.command.includes("-name .npmrc"))).toBe(true);
    expect(fake.state.commands.every((entry) => !entry.command.includes("pnpm dev"))).toBe(true);
    expect(DAYTONA_BUILD_ARTIFACTS.coldSnapshot).toContain("filesystem state only");
  }),
);

it.effect("deletes a snapshot that fails verification in a fresh sandbox", () =>
  Effect.gen(function* () {
    const fake = fakeClient({ failVerification: true });
    const provider = yield* make({ config: config(), client: fake.client });
    const error = yield* provider.prepare(buildInput).pipe(Effect.flip);

    expect(error.stage).toBe("snapshot");
    expect(error.message).toContain("fresh Daytona verification sandbox");
    expect(fake.state.deletedSnapshots).toEqual(["snapshot-build-1"]);
    expect(fake.state.deletedSandboxes).toEqual(["sandbox-2", "sandbox-1"]);
  }),
);

it.effect("handles snapshot retention, archive, missing snapshots, and idempotent delete", () =>
  Effect.gen(function* () {
    const fake = fakeClient();
    const provider = yield* make({ config: config(), client: fake.client });
    const prepared = yield* provider.prepare(buildInput);

    expect((yield* provider.inspectSnapshot(prepared.snapshot.id))?.id).toBe("snapshot-build-1");
    yield* provider.archiveSandbox("sandbox-1");
    expect(fake.state.archivedSandboxes).toEqual(["sandbox-1"]);

    yield* provider.deleteSnapshot(prepared.snapshot.id);
    yield* provider.deleteSnapshot(prepared.snapshot.id);
    expect(yield* provider.inspectSnapshot(prepared.snapshot.id)).toBeUndefined();
    expect(fake.state.deletedSnapshots).toEqual(["snapshot-build-1"]);
  }),
);
