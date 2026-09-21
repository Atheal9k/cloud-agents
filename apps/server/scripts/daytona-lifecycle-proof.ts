// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off - This maintainer proof drives an external SDK, host SSH process, and real network deadlines.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import { Daytona, type Resources, type Sandbox } from "@daytona/sdk";

const DEFAULT_API_URL = "https://app.daytona.io/api";
const PROOF_PORT = 31_061;
const OPERATION_TIMEOUT_SECONDS = 120;

type ProofConfig = {
  apiKey: string;
  apiUrl: string;
  image: string;
  resources: Resources | undefined;
  target: string | undefined;
};

type Transition = {
  operation: "archive" | "restart-after-archive" | "start" | "stop";
  before: string;
  after: string;
  durationMs: number;
};

type CleanupResult = {
  sandboxId: string;
  deleted: boolean;
  error?: string;
};

type RegionQuotaResult =
  | { kind: "denied"; status: number }
  | {
      kind: "available";
      sandboxClass: string;
      totalCpu: number;
      totalMemoryGiB: number;
      totalDiskGiB: number;
      maxCpuPerSandbox: number | null;
      maxMemoryGiBPerSandbox: number | null;
      maxDiskGiBPerSandbox: number | null;
    };

type ProofReport = {
  proofId: string;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  failure?: string;
  boundedFailures: Array<{ stage: string; message: string }>;
  sandbox?: {
    id: string;
    target: string;
    sandboxClass: string | null;
    public: boolean;
    createDurationMs: number;
    allocatedResources: {
      cpu: number;
      memoryGiB: number;
      diskGiB: number;
    };
    latestMetrics: Awaited<ReturnType<Sandbox["getMetricsLatest"]>>;
    providerQuota:
      | {
          kind: "region";
          sandboxClass: string;
          totalCpu: number;
          totalMemoryGiB: number;
          totalDiskGiB: number;
          maxCpuPerSandbox: number | null;
          maxMemoryGiBPerSandbox: number | null;
          maxDiskGiBPerSandbox: number | null;
        }
      | {
          kind: "sandbox-allocation";
          cpu: number;
          memoryGiB: number;
          diskGiB: number;
          regionQuotaStatus: number;
        };
  };
  command?: { exitCode: number; stdoutMatched: boolean };
  processSession?: { streamedChunks: number; stdoutMatched: boolean };
  ssh?: {
    connected: boolean;
    revoked: boolean;
    reuseFailed: boolean;
  };
  preview?: {
    httpPassed: boolean;
    websocketPassed: boolean;
    expiryRemovedAccess: boolean;
    revocationRemovedAccess: boolean;
  };
  persistence?: {
    fileSurvivedStopStart: boolean;
    processDidNotSurviveStopStart: boolean;
    fileSurvivedArchiveRestore: boolean;
  };
  isolation?: {
    controllerCredentialAbsent: boolean;
    controllerStateAbsent: boolean;
    managementApiDenied: boolean;
    otherSandboxDenied: boolean;
  };
  transitions: Transition[];
  cleanup: CleanupResult[];
};

const parsePositiveNumber = (name: string, raw: string | undefined) => {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
};

export const loadProofConfig = (env: NodeJS.ProcessEnv = process.env): ProofConfig => {
  const apiKey = env.DAYTONA_DEV_API_KEY ?? env.DAYTONA_API_KEY ?? env.DAYTONA_SANDBOX_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Set DAYTONA_DEV_API_KEY, DAYTONA_API_KEY, or DAYTONA_SANDBOX_API_KEY before running the proof",
    );
  }

  const cpu = parsePositiveNumber("DAYTONA_PROOF_CPU", env.DAYTONA_PROOF_CPU);
  const memory = parsePositiveNumber("DAYTONA_PROOF_MEMORY_GIB", env.DAYTONA_PROOF_MEMORY_GIB);
  const disk = parsePositiveNumber("DAYTONA_PROOF_DISK_GIB", env.DAYTONA_PROOF_DISK_GIB);
  const selectedResources: Resources = {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory }),
    ...(disk === undefined ? {} : { disk }),
  };
  const resources = Object.keys(selectedResources).length === 0 ? undefined : selectedResources;

  return {
    apiKey,
    apiUrl: env.DAYTONA_API_URL ?? DEFAULT_API_URL,
    image: env.DAYTONA_PROOF_IMAGE ?? "node:24-bookworm-slim",
    resources,
    target: env.DAYTONA_TARGET,
  };
};

export const splitCommand = (command: string): string[] => {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === character) quote = undefined;
      else if (quote === undefined) quote = character;
      else current += character;
      continue;
    }
    if (/\s/.test(character) && quote === undefined) {
      if (current !== "") parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }

  if (escaped || quote !== undefined) {
    throw new Error("Daytona returned an invalid SSH command");
  }
  if (current !== "") parts.push(current);
  return parts;
};

const safeError = (error: unknown, secrets: readonly string[] = []) => {
  const message = error instanceof Error ? error.message : String(error);
  return secrets
    .filter((secret) => secret !== "")
    .reduce((result, secret) => result.replaceAll(secret, "[redacted]"), message)
    .replaceAll(/([?&](?:token|auth|key)=)[^&\s]+/gi, "$1[redacted]")
    .replaceAll(/Bearer\s+\S+/gi, "Bearer [redacted]");
};

export const redactEvidence = (value: unknown, secrets: readonly string[]): string => {
  const serialized = JSON.stringify(value, null, 2);
  return secrets
    .filter((secret) => secret !== "")
    .reduce((result, secret) => result.replaceAll(secret, "[redacted]"), serialized)
    .replaceAll(/([?&](?:token|auth|key)=)[^&\s"\\]+/gi, "$1[redacted]");
};

const timed = async <T>(operation: () => Promise<T>) => {
  const startedAt = performance.now();
  const result = await operation();
  return { result, durationMs: Math.round(performance.now() - startedAt) };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const requiredNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  requireResult(typeof value === "number" && Number.isFinite(value), `Quota omitted ${key}`);
  return value;
};

const nullableNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  requireResult(
    value === null || (typeof value === "number" && Number.isFinite(value)),
    `Quota returned invalid ${key}`,
  );
  return value;
};

function requireResult(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const waitForHttp = async (url: string, expectedOk: boolean, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      lastStatus = response.status;
      if (response.ok === expectedOk) return response;
    } catch {
      if (!expectedOk) return undefined;
    }
    await NodeTimersPromises.setTimeout(400);
  }
  throw new Error(
    `Preview access did not become ${expectedOk ? "available" : "unavailable"}; last status ${lastStatus ?? "network error"}`,
  );
};

const waitForSandboxState = async (
  sandbox: Sandbox,
  expectedState: string,
  timeoutMs = OPERATION_TIMEOUT_SECONDS * 1_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sandbox.refreshData();
    if (sandbox.state === expectedState) return;
    await NodeTimersPromises.setTimeout(400);
  }
  throw new Error(`Sandbox did not reach ${expectedState} within ${timeoutMs}ms`);
};

const getRegionQuota = async (
  config: ProofConfig,
  sandboxId: string,
): Promise<RegionQuotaResult> => {
  const response = await fetch(
    `${config.apiUrl}/sandbox/${encodeURIComponent(sandboxId)}/region-quota`,
    { headers: { Authorization: `Bearer ${config.apiKey}` } },
  );
  if (response.status === 403) {
    return { kind: "denied", status: response.status };
  }
  requireResult(response.ok, `Region quota request returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  requireResult(isRecord(body), "Region quota response was not an object");
  const sandboxClass = body.sandboxClass;
  requireResult(typeof sandboxClass === "string", "Quota omitted sandboxClass");
  return {
    kind: "available",
    sandboxClass,
    totalCpu: requiredNumber(body, "totalCpuQuota"),
    totalMemoryGiB: requiredNumber(body, "totalMemoryQuota"),
    totalDiskGiB: requiredNumber(body, "totalDiskQuota"),
    maxCpuPerSandbox: nullableNumber(body, "maxCpuPerSandbox"),
    maxMemoryGiBPerSandbox: nullableNumber(body, "maxMemoryPerSandbox"),
    maxDiskGiBPerSandbox: nullableNumber(body, "maxDiskPerSandbox"),
  };
};

const verifyWebSocket = (httpUrl: string) =>
  new Promise<void>((resolve, reject) => {
    const url = new URL(httpUrl);
    requireResult(url.protocol === "https:", "Expected an HTTPS signed preview URL");
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error("WebSocket preview timed out"));
    }, 10_000);
    const request = NodeHttps.request(url, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": NodeCrypto.randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        "X-Daytona-Skip-Preview-Warning": "true",
      },
    });
    request.once("upgrade", (_response, socket, head) => {
      let frame = head;
      const inspectFrame = (chunk: Buffer) => {
        frame = Buffer.concat([frame, chunk]);
        if (frame.length < 2) return;
        const length = frame[1] & 0x7f;
        if (frame.length < length + 2) return;
        const message = frame.subarray(2, length + 2).toString("utf8");
        if (message !== "ca61-ws-ready") {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error("WebSocket preview returned unexpected content"));
          return;
        }
        clearTimeout(timeout);
        socket.destroy();
        resolve();
      };
      socket.on("data", inspectFrame);
      inspectFrame(Buffer.alloc(0));
    });
    request.once("response", (response) => {
      clearTimeout(timeout);
      response.resume();
      reject(new Error(`WebSocket preview returned HTTP ${response.statusCode ?? "unknown"}`));
    });
    request.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket preview connection failed: ${error.message}`));
    });
    request.end();
  });

const runSsh = async (sshCommand: string) => {
  const [executable, ...providedArgs] = splitCommand(sshCommand);
  requireResult(executable !== undefined, "Daytona returned an empty SSH command");
  const executableName = executable.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  requireResult(
    executableName === "ssh" || executableName === "ssh.exe",
    "Daytona returned a non-SSH access command",
  );
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=12",
    ...providedArgs,
    "printf ca61-ssh-ok",
  ];

  return await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(executable, args, {
      shell: false,
      windowsHide: true,
    });
    child.stdin.end();
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill(), 20_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? -1, stdout });
    });
  });
};

const serverSource = `
const http = require("node:http");
const crypto = require("node:crypto");
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ca61-http-ready");
});
server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
  const message = Buffer.from("ca61-ws-ready");
  socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
});
server.listen(${PROOF_PORT}, "0.0.0.0", () => console.log("ca61-preview-ready"));
`;

const createProofSandbox = async (daytona: Daytona, config: ProofConfig, name: string) =>
  await daytona.create(
    {
      image: config.image,
      name,
      public: false,
      labels: { purpose: "ca-61-lifecycle-proof" },
      ...(config.resources === undefined ? {} : { resources: config.resources }),
      ttlMinutes: 30,
      autoDeleteInterval: 30,
    },
    { timeout: OPERATION_TIMEOUT_SECONDS },
  );

const transition = async (
  sandbox: Sandbox,
  operation: Transition["operation"],
  action: () => Promise<void>,
): Promise<Transition> => {
  await sandbox.refreshData();
  const before = sandbox.state;
  const { durationMs } = await timed(action);
  await sandbox.refreshData();
  return {
    operation,
    before: before ?? "unknown",
    after: sandbox.state ?? "unknown",
    durationMs,
  };
};

const deleteSandbox = async (
  sandbox: Sandbox,
  secrets: readonly string[],
): Promise<CleanupResult> => {
  try {
    await sandbox.delete(OPERATION_TIMEOUT_SECONDS, true);
    return { sandboxId: sandbox.id, deleted: true };
  } catch (error) {
    return { sandboxId: sandbox.id, deleted: false, error: safeError(error, secrets) };
  }
};

export const runProof = async (config: ProofConfig): Promise<ProofReport> => {
  const proofId = NodeCrypto.randomUUID();
  const report: ProofReport = {
    proofId,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    success: false,
    boundedFailures: [],
    transitions: [],
    cleanup: [],
  };
  const daytona = new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    ...(config.target === undefined ? {} : { target: config.target }),
    requestTimeoutMs: OPERATION_TIMEOUT_SECONDS * 1_000,
  });
  const sandboxes: Sandbox[] = [];
  const secrets = [config.apiKey];
  let primary: Sandbox | undefined;
  let sshToken: string | undefined;
  const signedPreviews: Array<{ port: number; token: string }> = [];

  try {
    process.stderr.write("[ca-61] creating private proof sandbox\n");
    const created = await timed(() =>
      createProofSandbox(daytona, config, `ca61-primary-${proofId.slice(0, 8)}`),
    );
    const primarySandbox = created.result;
    primary = primarySandbox;
    sandboxes.push(primarySandbox);
    requireResult(primarySandbox.public === false, "Daytona created a public sandbox");
    const metrics = await primarySandbox.getMetricsLatest();
    const regionQuota = await getRegionQuota(config, primarySandbox.id);
    report.sandbox = {
      id: primarySandbox.id,
      target: primarySandbox.target,
      sandboxClass: primarySandbox.sandboxClass ?? null,
      public: primarySandbox.public,
      createDurationMs: created.durationMs,
      allocatedResources: {
        cpu: primarySandbox.cpu,
        memoryGiB: primarySandbox.memory,
        diskGiB: primarySandbox.disk,
      },
      latestMetrics: metrics,
      providerQuota:
        regionQuota.kind === "available"
          ? {
              kind: "region",
              sandboxClass: regionQuota.sandboxClass,
              totalCpu: regionQuota.totalCpu,
              totalMemoryGiB: regionQuota.totalMemoryGiB,
              totalDiskGiB: regionQuota.totalDiskGiB,
              maxCpuPerSandbox: regionQuota.maxCpuPerSandbox,
              maxMemoryGiBPerSandbox: regionQuota.maxMemoryGiBPerSandbox,
              maxDiskGiBPerSandbox: regionQuota.maxDiskGiBPerSandbox,
            }
          : {
              kind: "sandbox-allocation",
              cpu: primarySandbox.cpu,
              memoryGiB: primarySandbox.memory,
              diskGiB: primarySandbox.disk,
              regionQuotaStatus: regionQuota.status,
            },
    };

    const command = await primarySandbox.process.executeCommand("printf ca61-command-ok");
    requireResult(command.exitCode === 0, "Sandbox command failed");
    requireResult(command.result === "ca61-command-ok", "Sandbox command output differed");
    report.command = { exitCode: command.exitCode, stdoutMatched: true };

    const sessionId = `ca61-log-${proofId.slice(0, 8)}`;
    await primarySandbox.process.createSession(sessionId);
    const sessionCommand = await primarySandbox.process.executeSessionCommand(sessionId, {
      command: "for n in 1 2 3; do echo ca61-stream-$n; sleep 1; done",
      runAsync: true,
    });
    let streamed = "";
    let streamedChunks = 0;
    await primarySandbox.process.getSessionCommandLogs(
      sessionId,
      sessionCommand.cmdId,
      (chunk) => {
        streamed += chunk;
        streamedChunks += 1;
      },
      () => {
        streamedChunks += 1;
      },
    );
    requireResult(streamed.includes("ca61-stream-3"), "Session log stream was incomplete");
    report.processSession = { streamedChunks, stdoutMatched: true };
    await primarySandbox.process.deleteSession(sessionId);

    process.stderr.write("[ca-61] proving signed HTTP and WebSocket preview access\n");
    await primarySandbox.fs.uploadFile(Buffer.from(serverSource), "/home/daytona/ca61-server.cjs");
    const previewSession = `ca61-preview-${proofId.slice(0, 8)}`;
    await primarySandbox.process.createSession(previewSession);
    await primarySandbox.process.executeSessionCommand(previewSession, {
      command: "node /home/daytona/ca61-server.cjs",
      runAsync: true,
    });

    const expiringPreview = await primarySandbox.getSignedPreviewUrl(PROOF_PORT, 2);
    secrets.push(expiringPreview.token, expiringPreview.url);
    signedPreviews.push({ port: PROOF_PORT, token: expiringPreview.token });
    const httpResponse = await waitForHttp(expiringPreview.url, true);
    requireResult(
      (await httpResponse?.text()) === "ca61-http-ready",
      "HTTP preview returned unexpected content",
    );
    await verifyWebSocket(expiringPreview.url);
    await NodeTimersPromises.setTimeout(2_500);
    await waitForHttp(expiringPreview.url, false);

    const revokedPreview = await primarySandbox.getSignedPreviewUrl(PROOF_PORT, 60);
    secrets.push(revokedPreview.token, revokedPreview.url);
    signedPreviews.push({ port: PROOF_PORT, token: revokedPreview.token });
    await waitForHttp(revokedPreview.url, true);
    await primarySandbox.expireSignedPreviewUrl(PROOF_PORT, revokedPreview.token);
    await waitForHttp(revokedPreview.url, false);
    report.preview = {
      httpPassed: true,
      websocketPassed: true,
      expiryRemovedAccess: true,
      revocationRemovedAccess: true,
    };

    process.stderr.write("[ca-61] proving short-lived SSH access and revocation\n");
    try {
      const sshAccess = await primarySandbox.createSshAccess(1);
      sshToken = sshAccess.token;
      secrets.push(sshAccess.token, sshAccess.sshCommand);
      const sshResult = await runSsh(sshAccess.sshCommand);
      requireResult(
        sshResult.code === 0 && sshResult.stdout === "ca61-ssh-ok",
        "SSH connection failed",
      );
      await primarySandbox.revokeSshAccess(sshAccess.token);
      sshToken = undefined;
      const revokedSshResult = await runSsh(sshAccess.sshCommand);
      requireResult(revokedSshResult.code !== 0, "Revoked SSH access was reusable");
      report.ssh = {
        connected: true,
        revoked: true,
        reuseFailed: true,
      };
    } catch (error) {
      report.boundedFailures.push({ stage: "ssh", message: safeError(error, secrets) });
    }

    process.stderr.write("[ca-61] proving stop, start, archive, and restore behavior\n");
    const marker = `ca61-file-${proofId}`;
    await primarySandbox.process.executeCommand(
      `printf ${marker} > /home/daytona/ca61-persistence.txt && (while true; do date +%s%N > /home/daytona/ca61-heartbeat.txt; sleep 1; done >/dev/null 2>&1 &)`,
    );
    await NodeTimersPromises.setTimeout(1_200);
    report.transitions.push(
      await transition(primarySandbox, "stop", () =>
        primarySandbox.stop(OPERATION_TIMEOUT_SECONDS),
      ),
    );
    report.transitions.push(
      await transition(primarySandbox, "start", () =>
        primarySandbox.start(OPERATION_TIMEOUT_SECONDS),
      ),
    );
    const heartbeatAfterStart = await primarySandbox.process.executeCommand(
      "cat /home/daytona/ca61-heartbeat.txt",
    );
    await NodeTimersPromises.setTimeout(1_500);
    const persistenceAfterRestart = await primarySandbox.process.executeCommand(
      "cat /home/daytona/ca61-persistence.txt; printf '\\n'; cat /home/daytona/ca61-heartbeat.txt",
    );
    const [markerAfterRestart, heartbeatAfter] = persistenceAfterRestart.result.split("\n");
    requireResult(markerAfterRestart === marker, "File did not survive stop and start");
    requireResult(
      heartbeatAfter === heartbeatAfterStart.result.trim(),
      "Process survived stop and start",
    );
    report.transitions.push(
      await transition(primarySandbox, "stop", () =>
        primarySandbox.stop(OPERATION_TIMEOUT_SECONDS),
      ),
    );
    report.transitions.push(
      await transition(primarySandbox, "archive", async () => {
        await primarySandbox.archive();
        await waitForSandboxState(primarySandbox, "archived");
      }),
    );
    report.transitions.push(
      await transition(primarySandbox, "restart-after-archive", () =>
        primarySandbox.start(OPERATION_TIMEOUT_SECONDS),
      ),
    );
    const markerAfterArchive = await primarySandbox.process.executeCommand(
      "cat /home/daytona/ca61-persistence.txt",
    );
    requireResult(markerAfterArchive.result === marker, "File did not survive archive and restore");
    report.persistence = {
      fileSurvivedStopStart: true,
      processDidNotSurviveStopStart: true,
      fileSurvivedArchiveRestore: true,
    };

    process.stderr.write("[ca-61] probing controller and cross-sandbox isolation\n");
    const sentinel = await createProofSandbox(
      daytona,
      config,
      `ca61-sentinel-${proofId.slice(0, 8)}`,
    );
    sandboxes.push(sentinel);
    requireResult(sentinel.public === false, "Daytona created a public sentinel sandbox");
    await sentinel.fs.uploadFile(Buffer.from(serverSource), "/home/daytona/ca61-server.cjs");
    const sentinelSession = `ca61-sentinel-${proofId.slice(0, 8)}`;
    await sentinel.process.createSession(sentinelSession);
    await sentinel.process.executeSessionCommand(sentinelSession, {
      command: "node /home/daytona/ca61-server.cjs",
      runAsync: true,
    });
    const sentinelPreview = await sentinel.getPreviewLink(PROOF_PORT);
    secrets.push(sentinelPreview.token);
    const isolationSource = `
const fs = require("node:fs");
const names = Object.keys(process.env).filter((name) => name.startsWith("DAYTONA_") && /KEY|TOKEN|SECRET/.test(name));
const controllerPaths = ["/controller/.env", "/controller/.t3/userdata/state.sqlite", "/workspace/.env"];
const request = async (url) => { try { const response = await fetch(url, { redirect: "manual" }); return response.status; } catch { return 0; } };
Promise.all([request(${JSON.stringify(config.apiUrl + "/sandbox")}), request(${JSON.stringify(sentinelPreview.url)})]).then(([managementStatus, otherStatus]) => {
  process.stdout.write(JSON.stringify({ credentials: names, controllerStateVisible: controllerPaths.some((path) => fs.existsSync(path)), managementStatus, otherStatus }));
});
`;
    await primarySandbox.fs.uploadFile(
      Buffer.from(isolationSource),
      "/home/daytona/ca61-isolation.cjs",
    );
    const isolation = await primarySandbox.process.executeCommand(
      "node /home/daytona/ca61-isolation.cjs",
    );
    const parsed: unknown = JSON.parse(isolation.result);
    requireResult(
      typeof parsed === "object" && parsed !== null,
      "Isolation probe returned invalid output",
    );
    const credentials = "credentials" in parsed ? parsed.credentials : undefined;
    const controllerStateVisible =
      "controllerStateVisible" in parsed ? parsed.controllerStateVisible : undefined;
    const managementStatus = "managementStatus" in parsed ? parsed.managementStatus : undefined;
    const otherStatus = "otherStatus" in parsed ? parsed.otherStatus : undefined;
    requireResult(
      Array.isArray(credentials) && credentials.length === 0,
      "Sandbox received controller credentials",
    );
    requireResult(controllerStateVisible === false, "Sandbox could read controller-local state");
    requireResult(
      typeof managementStatus === "number" && (managementStatus === 0 || managementStatus >= 400),
      "Unauthenticated Daytona management request succeeded",
    );
    requireResult(
      typeof otherStatus === "number" && (otherStatus === 0 || otherStatus >= 400),
      "Primary sandbox read the private sentinel preview",
    );
    report.isolation = {
      controllerCredentialAbsent: true,
      controllerStateAbsent: true,
      managementApiDenied: true,
      otherSandboxDenied: true,
    };
    report.success = report.boundedFailures.length === 0;
  } catch (error) {
    const message = safeError(error, secrets);
    report.failure = message;
    report.boundedFailures.push({ stage: "proof", message });
  } finally {
    if (primary && sshToken) {
      try {
        await primary.revokeSshAccess(sshToken);
      } catch {
        // Sandbox deletion below is the final revocation boundary.
      }
    }
    if (primary) {
      for (const preview of signedPreviews) {
        try {
          await primary.expireSignedPreviewUrl(preview.port, preview.token);
        } catch {
          // Sandbox deletion below invalidates any remaining preview token.
        }
      }
    }
    for (const sandbox of sandboxes.toReversed()) {
      report.cleanup.push(await deleteSandbox(sandbox, secrets));
    }
    report.finishedAt = new Date().toISOString();
    if (report.cleanup.some((result) => !result.deleted)) {
      report.success = false;
      report.failure ??= "One or more proof sandboxes could not be deleted";
    }
  }
  return report;
};

const main = async () => {
  const rootEnvPath = NodeURL.fileURLToPath(new URL("../../../.env", import.meta.url));
  if (NodeFS.existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);
  const config = loadProofConfig();
  const report = await runProof(config);
  process.stdout.write(`${redactEvidence(report, [config.apiKey])}\n`);
  if (!report.success) process.exitCode = 1;
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  await main();
}
