// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalFetch:off globalTimers:off - This maintainer proof drives the real CLI, controller socket, and external Daytona deadlines.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CloudAgentId,
  CloudEnvironmentId,
  CloudProviderUnansweredRequestSeconds,
  CloudRunId,
  CommandId,
  MessageId,
  ProviderInstanceId,
  RunAllocationAttempt,
  RunAllocationId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  workerProfileForInstanceType,
  type RunAllocation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const baseDir = NodePath.resolve(process.env.T3CODE_PROOF_BASE_DIR ?? NodePath.join(root, ".t3"));
const serverUrl = new URL(process.env.T3CODE_PROOF_SERVER_URL ?? "http://127.0.0.1:13773");
const statePath = NodePath.join(baseDir, "daytona-agent-proof.json");

const makeClient = RpcClient.make(WsRpcGroup);
type Client =
  typeof makeClient extends Effect.Effect<infer Value, infer _Error, infer _Requirements>
    ? Value
    : never;
const decodeAccessToken = Schema.decodeUnknownSync(AuthAccessTokenResult);
const decodeWebSocketTicket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }));
const decodeProofState = Schema.decodeUnknownSync(
  Schema.Struct({ allocationId: Schema.String, attempt: RunAllocationAttempt }),
);

const protocolLayer = (ticket: string) => {
  const wsUrl = new URL("/ws", serverUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("wsTicket", ticket);
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(wsUrl.toString()).pipe(
        Layer.provide(NodeSocket.layerWebSocketConstructor),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
};

function pairingCredential(): string {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(root, "apps/server/src/bin.ts"),
      "pair",
      "--base-dir",
      baseDir,
      "--ttl",
      "30m",
      "--label",
      "CA-63 Daytona agent proof",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter((value) => value !== undefined && value.trim().length > 0)
      .join("\n")
      .replace(/^Token:\s*\S+$/gmu, "Token: [redacted]");
    throw new Error(detail || "Could not mint a proof pairing credential.");
  }
  const credential = /^Token:\s*(\S+)$/mu.exec(result.stdout)?.[1];
  if (credential === undefined) throw new Error("The pair command returned no credential.");
  return credential;
}

async function accessToken(): Promise<string> {
  const response = await fetch(new URL("/oauth/token", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: pairingCredential(),
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      client_label: "CA-63 Daytona agent proof",
      client_device_type: "bot",
    }),
  });
  if (!response.ok) throw new Error(`Token exchange failed with HTTP ${String(response.status)}.`);
  return decodeAccessToken(await response.json()).access_token;
}

async function webSocketTicket(token: string): Promise<string> {
  const response = await fetch(new URL("/api/auth/websocket-ticket", serverUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`WebSocket ticket issuance failed with HTTP ${String(response.status)}.`);
  }
  return decodeWebSocketTicket(await response.json()).ticket;
}

async function connectionTicket(): Promise<string> {
  return webSocketTicket(await accessToken());
}

const withClient = <Value, Error, Requirements>(
  token: string,
  use: (client: Client) => Effect.Effect<Value, Error, Requirements>,
) => makeClient.pipe(Effect.flatMap(use), Effect.provide(protocolLayer(token)), Effect.scoped);

function deadline(now: number, seconds: number): string {
  return new Date(now + seconds * 1_000).toISOString();
}

function printAllocation(allocation: RunAllocation): void {
  process.stdout.write(
    `${JSON.stringify(
      {
        allocationId: allocation.id,
        attempt: allocation.attempt,
        allocation: allocation.allocationState.status,
        allocationReason:
          allocation.allocationState.status === "failed"
            ? allocation.allocationState.reason
            : undefined,
        agent: allocation.agentOutcome.status,
        agentReason:
          allocation.agentOutcome.status === "failed" ? allocation.agentOutcome.reason : undefined,
        preview: allocation.previewState.status,
        cleanup: allocation.cleanupState.status,
        progress: allocation.progress,
        runtime:
          "managedRuntime" in allocation.allocationState
            ? allocation.allocationState.managedRuntime
            : undefined,
      },
      undefined,
      2,
    )}\n`,
  );
}

function readProofState(): { readonly allocationId: string; readonly attempt: number } {
  return decodeProofState(JSON.parse(NodeFS.readFileSync(statePath, "utf8")));
}

const findAllocation = Effect.fn("daytonaAgentProof.findAllocation")(function* (
  client: Client,
  allocationId: string,
) {
  const snapshot = yield* client[WS_METHODS.cloudAllocationList]({});
  const allocation = snapshot.allocations.find((candidate) => candidate.id === allocationId);
  if (allocation === undefined) throw new Error(`Allocation '${allocationId}' was not found.`);
  return allocation;
});

async function launch(): Promise<void> {
  const token = await connectionTicket();
  const proofId = NodeCrypto.randomUUID();
  const environmentId = CloudEnvironmentId.make(`ca63-proof-${proofId}`);
  const allocationId = RunAllocationId.make(`ca63-proof-${proofId}`);
  const now = Date.now();
  const occurredAt = new Date(now).toISOString();
  const snapshot = await Effect.runPromise(
    withClient(token, (client) => client[WS_METHODS.cloudAllocationList]({})),
  );
  const instanceType = snapshot.limits.allowedInstanceTypes[0];
  if (instanceType === undefined) throw new Error("The controller allows no worker instance type.");

  await Effect.runPromise(
    withClient(token, (client) =>
      Effect.gen(function* () {
        yield* client[WS_METHODS.cloudEnvironmentSave]({
          environmentId,
          name: `CA-63 proof ${proofId.slice(0, 8)}`,
          source: { type: "saved", scope: "personal", owner: "ca63-proof" },
          repositories: [{ repository: "Atheal9k/cloud-agents", defaultRef: "main" }],
          config: {
            image: "node:24-bookworm",
            start:
              "node -e \"require('node:http').createServer((_, response) => response.end('CA63_PREVIEW_OK')).listen(3000, '0.0.0.0')\"",
            terminals: [
              {
                name: "proof-terminal",
                command:
                  "node -e \"console.log('CA63_TERMINAL_READY'); setInterval(() => {}, 1000)\"",
              },
            ],
            ports: [{ name: "web", port: 3000 }],
          },
          secretReferences: [],
          occurredAt,
        });
        return yield* client[WS_METHODS.cloudAllocationDispatch]({
          type: "allocation.launch",
          commandId: CommandId.make(`cloud-launch:${allocationId}`),
          allocationId,
          attempt: RunAllocationAttempt.make(1),
          occurredAt,
          target: {
            repository: "Atheal9k/cloud-agents",
            baseCommit: "main",
            branch: `proof/ca63-${proofId.slice(0, 8)}`,
          },
          publication: { mode: "review-only" },
          control: {
            agentId: CloudAgentId.make(`agent:${allocationId}`),
            runId: CloudRunId.make(`run:${allocationId}:1`),
          },
          execution: {
            threadId: ThreadId.make(`thread-${allocationId}-1`),
            title: "CA-63 Daytona agent proof",
            selectedRef: "main",
            unansweredRequestSeconds: CloudProviderUnansweredRequestSeconds.make(300),
            turn: {
              commandId: CommandId.make(`turn:${allocationId}`),
              messageId: MessageId.make(`message:${allocationId}`),
              prompt: "Reply with exactly CA63_DAYTONA_PROOF and do not modify files.",
              attachments: [],
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-sol",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: occurredAt,
            },
          },
          profile: workerProfileForInstanceType(instanceType),
          deadlines: {
            launchBy: deadline(now, 5 * 60),
            bootBy: deadline(now, 10 * 60),
            registerBy: deadline(now, 15 * 60),
            expiresAt: deadline(now, 30 * 60),
            cleanupBy: deadline(now, 40 * 60),
          },
        });
      }),
    ),
  );
  NodeFS.mkdirSync(baseDir, { recursive: true });
  NodeFS.writeFileSync(
    statePath,
    `${JSON.stringify({ allocationId, attempt: 1, environmentId }, undefined, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({ proofId, allocationId, statePath }, undefined, 2)}\n`);
}

async function status(): Promise<void> {
  const state = readProofState();
  const token = await connectionTicket();
  const allocation = await Effect.runPromise(
    withClient(token, (client) => findAllocation(client, state.allocationId)),
  );
  printAllocation(allocation);
}

async function probe(): Promise<void> {
  const state = readProofState();
  const token = await connectionTicket();
  const allocation = await Effect.runPromise(
    withClient(token, (client) => findAllocation(client, state.allocationId)),
  );
  if (allocation.previewState.status !== "available") {
    throw new Error("The proof allocation has no published preview.");
  }
  const response = await fetch(allocation.previewState.url);
  const body = await response.text();
  const bodyMatched = body === "CA63_PREVIEW_OK";
  process.stdout.write(
    `${JSON.stringify({ status: response.status, bodyMatched, signedUrlRedacted: true }, undefined, 2)}\n`,
  );
  if (!response.ok || !bodyMatched) throw new Error("The signed Daytona preview probe failed.");
}

async function observe(): Promise<void> {
  const state = readProofState();
  const token = await accessToken();
  let last = "";
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20 * 60_000) {
    const ticket = await webSocketTicket(token);
    const allocation = await Effect.runPromise(
      withClient(ticket, (client) => findAllocation(client, state.allocationId)),
    );
    const current = JSON.stringify({
      allocation: allocation.allocationState.status,
      agent: allocation.agentOutcome.status,
      preview: allocation.previewState.status,
      cleanup: allocation.cleanupState.status,
      progress: allocation.progress,
    });
    if (current !== last) {
      printAllocation(allocation);
      last = current;
    }
    if (
      allocation.cleanupState.status === "succeeded" ||
      allocation.cleanupState.status === "failed" ||
      (allocation.previewState.status === "available" &&
        (allocation.agentOutcome.status === "running" ||
          allocation.agentOutcome.status === "succeeded" ||
          allocation.agentOutcome.status === "failed"))
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Timed out observing the Daytona agent proof.");
}

async function cancel(): Promise<void> {
  const state = readProofState();
  const token = await connectionTicket();
  const allocation = await Effect.runPromise(
    withClient(token, (client) =>
      Effect.gen(function* () {
        const current = yield* findAllocation(client, state.allocationId);
        return yield* client[WS_METHODS.cloudAllocationDispatch]({
          type: "allocation.cancel",
          commandId: CommandId.make(`ca63-proof-cancel:${state.allocationId}:${current.sequence}`),
          allocationId: RunAllocationId.make(state.allocationId),
          attempt: RunAllocationAttempt.make(state.attempt),
          occurredAt: new Date().toISOString(),
        });
      }),
    ),
  );
  printAllocation(allocation);
}

const command = process.argv[2];
switch (command) {
  case "launch":
    await launch();
    break;
  case "status":
    await status();
    break;
  case "observe":
    await observe();
    break;
  case "probe":
    await probe();
    break;
  case "cancel":
    await cancel();
    break;
  default:
    throw new Error("Use launch, status, observe, probe, or cancel.");
}
