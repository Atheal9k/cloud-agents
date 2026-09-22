// @effect-diagnostics nodeBuiltinImport:off
import {
  CloudExpoMetroError,
  type CloudExpoMetroControlInput,
  type CloudExpoMetroInspectInput,
  type CloudExpoMetroSession,
  type CloudExpoMetroStatus,
  type CloudExpoPackageManager,
  type CloudExpoPlatform,
  type RunAllocation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CloudAllocationController from "./CloudAllocationController.ts";
import { CloudRuntimeProvider, type CloudRuntimeProviderError } from "./CloudRuntimeProvider.ts";
import {
  CLOUD_EXPO_METRO_PORT,
  CLOUD_EXPO_TUNNEL_TIMEOUT_MS,
  classifyCloudExpoChanges,
  cloudExpoCommand,
  cloudExpoLastClientConnectionAt,
  cloudExpoLogs,
  cloudExpoMetroSessionId,
  cloudExpoProcessFailure,
  cloudExpoStartedAt,
  detectCloudExpoPackageManager,
} from "./cloudExpoMetroPolicy.ts";

const WORKSPACE = "/work/repository";
const EXPO_NGROK_VERSION = "4.1.3";

const ExpoProjectDiscovery = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("found"),
    root: Schema.String,
    packageManager: Schema.optionalKey(Schema.String),
    files: Schema.Array(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("missing"), reason: Schema.String }),
]);
type ExpoProjectDiscovery = typeof ExpoProjectDiscovery.Type;

const ChangedPaths = Schema.Array(Schema.String);
const ExpoOpenEndpoint = Schema.Struct({
  runtime: Schema.Literal("custom"),
  url: Schema.String,
  scheme: Schema.String,
  availableRuntimes: Schema.Array(Schema.String),
  appId: Schema.NullOr(Schema.String),
});

const decodeDiscovery = Schema.decodeUnknownEffect(Schema.fromJsonString(ExpoProjectDiscovery));
const decodeChangedPaths = Schema.decodeUnknownEffect(Schema.fromJsonString(ChangedPaths));
const decodeOpenEndpoint = Schema.decodeUnknownEffect(Schema.fromJsonString(ExpoOpenEndpoint));

const DISCOVER_EXPO_PROJECT = String.raw`
const child = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const tracked = child.execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "package.json", "**/package.json"], { encoding: "utf8" });
const files = tracked.split(/\r?\n/).filter(Boolean).filter((file) => !file.includes("node_modules/"));
const candidates = [];
for (const file of files) {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const dependencies = { ...(json.dependencies || {}), ...(json.devDependencies || {}) };
    if (typeof dependencies["expo-dev-client"] === "string") candidates.push({ file, json });
  } catch {}
}
if (candidates.length === 0) {
  process.stdout.write(JSON.stringify({ status: "missing", reason: "No package.json has expo-dev-client as a direct dependency." }));
  process.exit(0);
}
candidates.sort((left, right) => left.file.split("/").length - right.file.split("/").length || left.file.localeCompare(right.file));
const selected = candidates[0];
const rootPackage = fs.existsSync("package.json") ? JSON.parse(fs.readFileSync("package.json", "utf8")) : {};
const root = path.dirname(selected.file).replaceAll("\\", "/");
const repositoryFiles = child.execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
process.stdout.write(JSON.stringify({
  status: "found",
  root: root === "." ? "." : root,
  packageManager: selected.json.packageManager || rootPackage.packageManager,
  files: repositoryFiles,
}));`;

const READ_CHANGED_PATHS = String.raw`
const child = require("node:child_process");
const base = process.argv[1];
const changed = child.execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMRT", "--end-of-options", base, "--"], { encoding: "utf8" });
const untracked = child.execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" });
const paths = [...new Set((changed + "\n" + untracked).split(/\r?\n/).filter(Boolean))].sort();
process.stdout.write(JSON.stringify(paths));`;

const PROBE_PORT = String.raw`
const net = require("node:net");
const server = net.createServer();
server.once("error", () => process.exit(2));
server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close(() => process.exit(0)));`;

interface ResolvedExpoProject {
  readonly root: string;
  readonly absoluteRoot: string;
  readonly packageManager: CloudExpoPackageManager;
}

interface LocatedAllocation {
  readonly allocation: RunAllocation;
  readonly agentId: CloudExpoMetroStatus["agentId"];
  readonly runId: CloudExpoMetroStatus["runId"];
}

export class CloudExpoMetro extends Context.Service<
  CloudExpoMetro,
  {
    readonly inspect: (
      input: CloudExpoMetroInspectInput,
    ) => Effect.Effect<CloudExpoMetroStatus, CloudExpoMetroError>;
    readonly control: (
      input: CloudExpoMetroControlInput,
    ) => Effect.Effect<CloudExpoMetroStatus, CloudExpoMetroError>;
  }
>()("t3/cloud/CloudExpoMetro") {}

function expoError(reason: CloudExpoMetroError["reason"], message: string): CloudExpoMetroError {
  return new CloudExpoMetroError({ reason, message });
}

function providerError(error: CloudRuntimeProviderError): CloudExpoMetroError {
  return expoError("provider-failed", error.message);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runtimeId(allocation: RunAllocation): string | undefined {
  if (
    allocation.allocationState.status !== "ready" ||
    allocation.idleState.status === "hibernated" ||
    allocation.cleanupState.status !== "not-requested"
  ) {
    return undefined;
  }
  const runtime = allocation.allocationState.managedRuntime;
  return runtime?.provider === "daytona" && runtime.lifecycleState === "started"
    ? runtime.runtimeId
    : undefined;
}

function processCommand(input: {
  readonly project: ResolvedExpoProject;
  readonly startedAt: string;
}): string {
  const expo = `${cloudExpoCommand(input.project.packageManager)} start --dev-client --tunnel --port ${CLOUD_EXPO_METRO_PORT}`;
  const command = [
    "set -o pipefail",
    "if ! git ls-files --error-unmatch -- .expo/settings.json >/dev/null 2>&1; then rm -f -- .expo/settings.json; fi",
    `{ printf '%s\\n' ${shellQuote(`T3 Expo Metro requested at ${input.startedAt}`)}; exec env EXPO_NO_TELEMETRY=1 ${expo}; } 2>&1 | while IFS= read -r line; do printf '[%s] %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$line"; done`,
  ].join("; ");
  return [
    `npm list --global --depth=0 @expo/ngrok@${EXPO_NGROK_VERSION} >/dev/null 2>&1 || npm install --global --no-audit --no-fund @expo/ngrok@${EXPO_NGROK_VERSION}`,
    `cd ${shellQuote(input.project.absoluteRoot)}`,
    `exec runuser -u cloudagent --preserve-environment -- /bin/bash -c ${shellQuote(command)}`,
  ].join(" && ");
}

function unavailable(
  located: LocatedAllocation,
  reasonCode: "runtime-unavailable" | "not-expo-development-client",
  reason: string,
): CloudExpoMetroStatus {
  return {
    status: "unavailable",
    agentId: located.agentId,
    allocationId: located.allocation.id,
    runId: located.runId,
    attempt: located.allocation.attempt,
    reasonCode,
    reason,
  };
}

export const make = Effect.fn("CloudExpoMetro.make")(function* (options?: {
  readonly watchAllocations?: boolean;
}) {
  const allocations = yield* CloudAllocationController.CloudAllocationController;
  const runtimes = yield* CloudRuntimeProvider;
  const projectCache = yield* Ref.make<ReadonlyMap<string, ExpoProjectDiscovery>>(new Map());
  const reconciled = yield* Ref.make<ReadonlySet<string>>(new Set());

  const locate = Effect.fn("CloudExpoMetro.locate")(function* (
    agentId: CloudExpoMetroStatus["agentId"],
  ) {
    const snapshot = yield* allocations.snapshot.pipe(
      Effect.mapError(() =>
        expoError("controller-failed", "The cloud allocation catalog is unavailable."),
      ),
    );
    const agent = snapshot.agents?.find((candidate) => candidate.id === agentId);
    if (agent === undefined) {
      return yield* expoError("agent-not-found", `Cloud agent '${agentId}' was not found.`);
    }
    const allocation = snapshot.allocations.find(
      (candidate) => candidate.id === agent.allocationId,
    );
    if (allocation === undefined) {
      return yield* expoError(
        "allocation-not-found",
        `Cloud agent '${agentId}' has no allocation record.`,
      );
    }
    const runId = allocation.control?.runId ?? agent.conversation.runIds.at(-1);
    if (runId === undefined) {
      return yield* expoError("allocation-not-found", `Cloud agent '${agentId}' has no run.`);
    }
    return { allocation, agentId, runId } satisfies LocatedAllocation;
  });

  const discover = Effect.fn("CloudExpoMetro.discover")(function* (
    id: string,
  ): Effect.fn.Return<ExpoProjectDiscovery, CloudExpoMetroError> {
    const cached = (yield* Ref.get(projectCache)).get(id);
    if (cached !== undefined) return cached;
    const result = yield* runtimes
      .execute({
        runtimeId: id,
        command: `node -e ${shellQuote(DISCOVER_EXPO_PROJECT)}`,
        cwd: WORKSPACE,
        timeoutSeconds: 15,
      })
      .pipe(Effect.mapError(providerError));
    if (result.exitCode !== 0) {
      return yield* expoError("invalid-project", "The Expo project could not be inspected.");
    }
    const decoded = yield* decodeDiscovery(result.output).pipe(
      Effect.mapError(() =>
        expoError("invalid-project", "Expo project discovery returned invalid data."),
      ),
    );
    yield* Ref.update(projectCache, (current) => new Map(current).set(id, decoded));
    return decoded;
  });

  const resolveProject = Effect.fn("CloudExpoMetro.resolveProject")(function* (
    id: string,
  ): Effect.fn.Return<ResolvedExpoProject | undefined, CloudExpoMetroError> {
    const discovery = yield* discover(id);
    if (discovery.status === "missing") return undefined;
    const root = discovery.root === "." ? "." : discovery.root.replace(/^\.\//, "");
    return {
      root,
      absoluteRoot: root === "." ? WORKSPACE : `${WORKSPACE}/${root}`,
      packageManager: detectCloudExpoPackageManager({
        packageManager: discovery.packageManager,
        files: discovery.files,
      }),
    };
  });

  const changedPaths = Effect.fn("CloudExpoMetro.changedPaths")(function* (
    id: string,
    allocation: RunAllocation,
    project: ResolvedExpoProject,
  ) {
    const result = yield* runtimes
      .execute({
        runtimeId: id,
        command: `node -e ${shellQuote(READ_CHANGED_PATHS)} ${shellQuote(allocation.target.baseCommit)}`,
        cwd: project.absoluteRoot,
        timeoutSeconds: 15,
      })
      .pipe(Effect.mapError(providerError));
    if (result.exitCode !== 0) {
      return yield* expoError("invalid-project", "The repository changes could not be inspected.");
    }
    return yield* decodeChangedPaths(result.output).pipe(
      Effect.mapError(() =>
        expoError("invalid-project", "The repository returned invalid changed paths."),
      ),
    );
  });

  const portAvailable = Effect.fn("CloudExpoMetro.portAvailable")(function* (id: string) {
    const result = yield* runtimes
      .execute({
        runtimeId: id,
        command: `node -e ${shellQuote(PROBE_PORT)} ${CLOUD_EXPO_METRO_PORT}`,
        timeoutSeconds: 5,
      })
      .pipe(Effect.mapError(providerError));
    return result.exitCode === 0;
  });

  const resetReadyMarker = Effect.fn("CloudExpoMetro.resetReadyMarker")(function* (
    id: string,
    sessionId: string,
  ) {
    yield* runtimes
      .execute({
        runtimeId: id,
        command: `rm -f ${shellQuote(`/tmp/${sessionId}.ready-at`)}`,
        timeoutSeconds: 5,
      })
      .pipe(Effect.mapError(providerError), Effect.asVoid);
  });

  const ensureStarted = Effect.fn("CloudExpoMetro.ensureStarted")(function* (
    allocation: RunAllocation,
  ) {
    const id = runtimeId(allocation);
    const startedAt = cloudExpoStartedAt(allocation);
    if (id === undefined || startedAt === undefined || allocation.expoMetro?.status !== "enabled") {
      return;
    }
    const project = yield* resolveProject(id);
    if (project === undefined) return;
    const sessionId = cloudExpoMetroSessionId(allocation);
    const observed = yield* runtimes
      .inspectProcess({ runtimeId: id, sessionId })
      .pipe(Effect.mapError(providerError));
    if (observed.status !== "missing") return;
    if (!(yield* portAvailable(id))) return;
    yield* runtimes
      .ensureProcess({
        runtimeId: id,
        sessionId,
        command: processCommand({ project, startedAt }),
      })
      .pipe(Effect.mapError(providerError), Effect.asVoid);
  });

  const readEndpoint = Effect.fn("CloudExpoMetro.readEndpoint")(function* (
    id: string,
    platform: CloudExpoPlatform,
  ) {
    const result = yield* runtimes
      .execute({
        runtimeId: id,
        command: `curl --silent --show-error --max-time 5 ${shellQuote(`http://127.0.0.1:${CLOUD_EXPO_METRO_PORT}/_expo/open?platform=${platform}&runtime=custom`)}`,
        timeoutSeconds: 8,
      })
      .pipe(Effect.mapError(providerError));
    if (result.exitCode !== 0) return undefined;
    return yield* decodeOpenEndpoint(result.output).pipe(Effect.orElseSucceed(() => undefined));
  });

  const readyAt = Effect.fn("CloudExpoMetro.readyAt")(function* (id: string, sessionId: string) {
    const path = `/tmp/${sessionId}.ready-at`;
    const result = yield* runtimes
      .execute({
        runtimeId: id,
        command: `if test -s ${shellQuote(path)}; then cat ${shellQuote(path)}; else date -u +%Y-%m-%dT%H:%M:%S.000Z | tee ${shellQuote(path)}; fi`,
        timeoutSeconds: 5,
      })
      .pipe(Effect.mapError(providerError));
    const value = result.output.trim();
    return Number.isFinite(Date.parse(value)) ? value : DateTime.formatIso(yield* DateTime.now);
  });

  const inspectLocated = Effect.fn("CloudExpoMetro.inspectLocated")(function* (
    located: LocatedAllocation,
  ): Effect.fn.Return<CloudExpoMetroStatus, CloudExpoMetroError> {
    const id = runtimeId(located.allocation);
    if (id === undefined) {
      return unavailable(
        located,
        "runtime-unavailable",
        located.allocation.idleState.status === "hibernated"
          ? "Wake the Daytona sandbox before starting Metro."
          : "Metro is available after the Daytona sandbox reaches ready.",
      );
    }
    const project = yield* resolveProject(id);
    if (project === undefined) {
      return unavailable(
        located,
        "not-expo-development-client",
        "No package.json in the repository declares expo-dev-client. Expo Go is not supported.",
      );
    }
    const compatibility = classifyCloudExpoChanges(
      yield* changedPaths(id, located.allocation, project),
    );
    const base = {
      status: "available" as const,
      agentId: located.agentId,
      allocationId: located.allocation.id,
      runId: located.runId,
      attempt: located.allocation.attempt,
      project: { root: project.root, packageManager: project.packageManager },
      compatibility,
    };
    const intent = located.allocation.expoMetro;
    const platform = intent?.status === "enabled" ? intent.platform : undefined;
    if (intent?.status !== "enabled" || intent.runId !== located.runId) {
      return {
        ...base,
        ...(platform === undefined ? {} : { platform }),
        session: {
          status: "stopped",
          metro: { status: "stopped" },
          tunnel: { status: "unavailable" },
          logs: "",
        },
      };
    }
    const startedAt = cloudExpoStartedAt(located.allocation) ?? intent.requestedAt;
    const sessionId = cloudExpoMetroSessionId(located.allocation);
    const process = yield* runtimes
      .inspectProcess({ runtimeId: id, sessionId })
      .pipe(Effect.mapError(providerError));
    if (process.status === "missing") {
      const session: CloudExpoMetroSession = (yield* portAvailable(id))
        ? {
            status: "starting",
            metro: { status: "starting", startedAt },
            tunnel: { status: "connecting" },
            logs: "",
          }
        : {
            status: "metro-error",
            metro: {
              status: "error",
              reason: "Port 8081 is already in use inside the Daytona sandbox.",
              retryable: true,
            },
            tunnel: { status: "unavailable" },
            logs: "",
          };
      return { ...base, platform: intent.platform, session };
    }
    const logs = cloudExpoLogs(process.output);
    if (process.status === "failed" || process.status === "succeeded") {
      const failure = cloudExpoProcessFailure(logs);
      const session: CloudExpoMetroSession =
        failure.kind === "tunnel"
          ? {
              status: "startup-error",
              metro: { status: "error", reason: failure.reason, retryable: failure.retryable },
              tunnel: { status: "error", reason: failure.reason, retryable: failure.retryable },
              logs,
            }
          : {
              status: "metro-error",
              metro: { status: "error", reason: failure.reason, retryable: failure.retryable },
              tunnel: { status: "unavailable" },
              logs,
            };
      return { ...base, platform: intent.platform, session };
    }
    const endpoint = yield* readEndpoint(id, intent.platform);
    if (endpoint === undefined) {
      const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - Date.parse(startedAt);
      const lastClientConnectionAt = cloudExpoLastClientConnectionAt(logs);
      const session: CloudExpoMetroSession =
        elapsed >= CLOUD_EXPO_TUNNEL_TIMEOUT_MS
          ? {
              status: "tunnel-error",
              metro: {
                status: "running",
                startedAt,
                startupMs: CLOUD_EXPO_TUNNEL_TIMEOUT_MS,
                ...(lastClientConnectionAt === undefined ? {} : { lastClientConnectionAt }),
              },
              tunnel: {
                status: "error",
                reason: "Expo did not establish the tunnel within 60 seconds.",
                retryable: true,
              },
              logs,
            }
          : {
              status: "starting",
              metro: { status: "starting", startedAt },
              tunnel: { status: "connecting" },
              logs,
            };
      return { ...base, platform: intent.platform, session };
    }
    const becameReadyAt = yield* readyAt(id, sessionId);
    const lastClientConnectionAt = cloudExpoLastClientConnectionAt(logs);
    return {
      ...base,
      platform: intent.platform,
      session: {
        status: "ready",
        metro: {
          status: "running",
          startedAt,
          startupMs: Math.max(0, Date.parse(becameReadyAt) - Date.parse(startedAt)),
          ...(lastClientConnectionAt === undefined ? {} : { lastClientConnectionAt }),
        },
        tunnel: {
          status: "ready",
          deepLink: endpoint.url,
          scheme: endpoint.scheme,
          ...(endpoint.appId === null ? {} : { appId: endpoint.appId }),
          issuedAt: becameReadyAt,
        },
        logs,
      },
    };
  });

  const inspect: CloudExpoMetro["Service"]["inspect"] = (input) =>
    locate(input.agentId).pipe(Effect.flatMap(inspectLocated));

  const control: CloudExpoMetro["Service"]["control"] = Effect.fn("CloudExpoMetro.control")(
    function* (input) {
      const located = yield* locate(input.agentId);
      const id = runtimeId(located.allocation);
      const sessionId = cloudExpoMetroSessionId(located.allocation);
      if (input.action === "stop") {
        yield* allocations
          .dispatch({
            type: "allocation.expo-metro-stop",
            commandId: input.commandId,
            allocationId: located.allocation.id,
            attempt: located.allocation.attempt,
            occurredAt: input.occurredAt,
          })
          .pipe(
            Effect.mapError(() =>
              expoError("controller-failed", "The controller refused to stop Metro."),
            ),
          );
        if (id !== undefined) {
          yield* runtimes
            .deleteProcess({ runtimeId: id, sessionId })
            .pipe(Effect.mapError(providerError));
          yield* resetReadyMarker(id, sessionId);
        }
        return yield* inspect(input);
      }
      const current = yield* inspectLocated(located);
      if (current.status === "unavailable") return current;
      const updated = yield* allocations
        .dispatch({
          type: "allocation.expo-metro-request",
          commandId: input.commandId,
          allocationId: located.allocation.id,
          attempt: located.allocation.attempt,
          occurredAt: input.occurredAt,
          runId: located.runId,
          platform: input.platform,
        })
        .pipe(
          Effect.mapError(() =>
            expoError("controller-failed", "The controller refused to start Metro."),
          ),
        );
      if (input.action === "restart" && id !== undefined) {
        yield* runtimes
          .deleteProcess({ runtimeId: id, sessionId })
          .pipe(Effect.mapError(providerError));
        yield* resetReadyMarker(id, sessionId);
      }
      yield* ensureStarted(updated);
      return yield* inspect(input);
    },
  );

  if (options?.watchAllocations !== false) {
    yield* Effect.forkScoped(
      Stream.concat(Stream.fromEffect(allocations.snapshot), allocations.stream).pipe(
        Stream.runForEach((snapshot) =>
          Effect.forEach(
            snapshot.allocations.filter(
              (allocation) =>
                allocation.expoMetro?.status === "enabled" && runtimeId(allocation) !== undefined,
            ),
            (allocation) =>
              Effect.gen(function* () {
                const key = `${allocation.id}:${allocation.attempt}:${allocation.expoMetro?.status === "enabled" ? allocation.expoMetro.requestedAt : "disabled"}`;
                const shouldRun = yield* Ref.modify(reconciled, (current) =>
                  current.has(key)
                    ? [false, current]
                    : ([true, new Set(current).add(key)] as const),
                );
                if (shouldRun) {
                  yield* ensureStarted(allocation).pipe(
                    Effect.tapError(() =>
                      Ref.update(reconciled, (current) => {
                        const next = new Set(current);
                        next.delete(key);
                        return next;
                      }),
                    ),
                  );
                }
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not reconcile the Expo Metro session.", {
                    allocationId: allocation.id,
                    cause: error.message,
                  }),
                ),
              ),
            { concurrency: 1 },
          ),
        ),
        Effect.catch((error) =>
          Effect.logWarning("The Expo Metro allocation watcher stopped.", { cause: error.message }),
        ),
      ),
    );
  }

  return CloudExpoMetro.of({ inspect, control });
});

export const layer = Layer.effect(CloudExpoMetro, make());
