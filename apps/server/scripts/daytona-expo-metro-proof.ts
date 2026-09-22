// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - This maintainer proof drives the external Daytona SDK and bounded real-network waits.
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";

import { Daytona, type Sandbox } from "@daytona/sdk";

const API_URL = "https://app.daytona.io/api";
const COMMAND_TIMEOUT_SECONDS = 300;
const SESSION_ID = "ca66-expo-metro";
const PROJECT_ROOT = "/home/daytona/ca66-expo";

const packageJson = JSON.stringify({
  name: "ca66-expo-proof",
  private: true,
  version: "1.0.0",
  main: "index.js",
  scripts: { start: "expo start" },
  dependencies: {
    expo: "latest",
    "expo-dev-client": "latest",
    react: "latest",
    "react-native": "latest",
  },
});

const appJson = JSON.stringify({
  expo: {
    name: "CA 66 Expo proof",
    slug: "ca66-expo-proof",
    scheme: "ca66demo",
  },
});

const requireResult: (condition: boolean, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const readApiKey = () => {
  const value =
    process.env.DAYTONA_DEV_API_KEY ??
    process.env.DAYTONA_API_KEY ??
    process.env.DAYTONA_SANDBOX_API_KEY;
  if (!value) throw new Error("A Daytona API key is required");
  return value;
};

const endpointCommand =
  "curl --silent --show-error --max-time 5 'http://127.0.0.1:8081/_expo/open?platform=android&runtime=custom'";

const waitForEndpoint = async (sandbox: Sandbox) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await sandbox.process.executeCommand(
      endpointCommand,
      PROJECT_ROOT,
      undefined,
      8,
    );
    if (response.exitCode === 0) {
      const value: unknown = JSON.parse(response.result);
      if (
        typeof value === "object" &&
        value !== null &&
        "runtime" in value &&
        value.runtime === "custom" &&
        "url" in value &&
        typeof value.url === "string" &&
        "scheme" in value &&
        typeof value.scheme === "string"
      ) {
        return { url: value.url, scheme: value.scheme };
      }
    }
    await NodeTimersPromises.setTimeout(2_000);
  }
  throw new Error("Expo did not publish the custom-runtime endpoint within 60 seconds");
};

const startMetro = async (sandbox: Sandbox) => {
  await sandbox.process.createSession(SESSION_ID);
  const command = await sandbox.process.executeSessionCommand(SESSION_ID, {
    command: `cd '${PROJECT_ROOT}' && rm -f -- .expo/settings.json && EXPO_NO_TELEMETRY=1 npx expo start --dev-client --tunnel --port 8081 2>&1`,
    runAsync: true,
  });
  try {
    return await waitForEndpoint(sandbox);
  } catch (error) {
    const logs = await sandbox.process.getSessionCommandLogs(SESSION_ID, command.cmdId);
    const detail = (logs.output ?? logs.stdout ?? logs.stderr ?? "no Expo output").slice(-2_000);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`, {
      cause: error,
    });
  }
};

const main = async () => {
  const apiKey = readApiKey();
  const proofId = NodeCrypto.randomUUID().slice(0, 8);
  const daytona = new Daytona({
    apiKey,
    apiUrl: process.env.DAYTONA_API_URL ?? API_URL,
    ...(process.env.DAYTONA_TARGET === undefined ? {} : { target: process.env.DAYTONA_TARGET }),
    requestTimeoutMs: COMMAND_TIMEOUT_SECONDS * 1_000,
  });
  let sandbox: Sandbox | undefined;

  try {
    process.stderr.write("[ca-66] creating disposable Daytona sandbox\n");
    sandbox = await daytona.create(
      {
        image: process.env.DAYTONA_PROOF_IMAGE ?? "node:24-bookworm-slim",
        name: `ca66-expo-${proofId}`,
        public: false,
        labels: { purpose: "ca-66-expo-metro-proof" },
        ttlMinutes: 30,
        autoDeleteInterval: 30,
      },
      { timeout: COMMAND_TIMEOUT_SECONDS },
    );
    await sandbox.process.executeCommand(`mkdir -p '${PROJECT_ROOT}'`);
    await sandbox.fs.uploadFile(Buffer.from(packageJson), `${PROJECT_ROOT}/package.json`);
    await sandbox.fs.uploadFile(Buffer.from(appJson), `${PROJECT_ROOT}/app.json`);
    await sandbox.fs.uploadFile(
      Buffer.from("export default function App() { return null; }\n"),
      `${PROJECT_ROOT}/index.js`,
    );

    process.stderr.write("[ca-66] installing the minimal Expo development-client project\n");
    const install = await sandbox.process.executeCommand(
      "npm install --no-audit --no-fund",
      PROJECT_ROOT,
      undefined,
      COMMAND_TIMEOUT_SECONDS,
    );
    requireResult(install.exitCode === 0, `npm install failed: ${install.result.slice(-1_000)}`);
    const ngrok = await sandbox.process.executeCommand(
      "npm install --global --no-audit --no-fund @expo/ngrok@4.1.3",
      undefined,
      undefined,
      COMMAND_TIMEOUT_SECONDS,
    );
    requireResult(ngrok.exitCode === 0, `ngrok install failed: ${ngrok.result.slice(-1_000)}`);

    process.stderr.write("[ca-66] starting named Metro + ngrok session\n");
    const first = await startMetro(sandbox);
    requireResult(first.url.startsWith("ca66demo://"), "Expo returned a non-development-build URL");
    await sandbox.process.deleteSession(SESSION_ID);

    process.stderr.write("[ca-66] restarting the named session and reading a fresh endpoint\n");
    const second = await startMetro(sandbox);
    requireResult(
      second.url.startsWith("ca66demo://"),
      "Restart returned a non-development-build URL",
    );
    await sandbox.process.deleteSession(SESSION_ID);

    process.stdout.write(
      `${JSON.stringify({
        success: true,
        sandboxId: sandbox.id,
        command: "npx expo start --dev-client --tunnel --port 8081",
        runtime: "custom",
        scheme: second.scheme,
        restartIssuedFreshLink: first.url !== second.url,
      })}\n`,
    );
  } finally {
    if (sandbox !== undefined) {
      process.stderr.write("[ca-66] deleting disposable Daytona sandbox\n");
      await sandbox.delete(COMMAND_TIMEOUT_SECONDS, true);
    }
  }
};

await main();
