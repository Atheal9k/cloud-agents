import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  CloudEnvironmentId,
  CloudEnvironmentVersionId,
  type CloudEnvironmentVersion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { make } from "./CloudEnvironmentRuntimeBoot.ts";

const TestLayer = NodeServices.layer;

const version = (
  start: string,
  extras?: Partial<CloudEnvironmentVersion["config"]>,
): CloudEnvironmentVersion => ({
  id: CloudEnvironmentVersionId.make("environment-runtime:1"),
  environmentId: CloudEnvironmentId.make("environment-runtime"),
  version: 1,
  name: "Runtime",
  source: { type: "saved", scope: "personal", owner: "victor" },
  repositories: [{ repository: "acme/web", defaultRef: "main" }],
  config: {
    image: "node:24-bookworm",
    install: "node -e \"require('node:fs').writeFileSync('install.ok','should-not-run')\"",
    start,
    terminals: [{ name: "worker", command: 'node -e "setInterval(() => {}, 1000)"' }],
    ...extras,
  },
  secretReferences: [
    { name: "SESSION_KEY", reference: "secret/session", availability: "runtime-redacted" },
    { name: "PUBLIC_FLAG", reference: "secret/flag", availability: "runtime" },
  ],
  effectivePolicy: {
    runtimeUser: "root",
    egressMode: "default_with_network_settings",
    egressAllowlist: [],
    testingEnabled: true,
    disableAllMcpServers: false,
    mcpServerAllowlist: [],
    ports: extras?.ports ?? [],
    secrets: [
      { name: "SESSION_KEY", reference: "secret/session", availability: "runtime-redacted" },
      { name: "PUBLIC_FLAG", reference: "secret/flag", availability: "runtime" },
    ],
  },
  createdAt: "2026-09-19T12:00:00.000Z",
});

const secretValues = {
  "secret/session": "session-secret-value",
  "secret/flag": "public-flag-value",
};

const listenFreePort = Effect.callback<number>((resume) => {
  const server = NodeNet.createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

it.effect("runs start and named terminals on boot without re-running install", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-boot-" });
    const port = yield* listenFreePort;
    const boot = yield* make({ healthCheckMs: 800 });
    const start = [
      "node -e",
      `"const http=require('node:http');console.log(process.env.SESSION_KEY);console.log(process.env.PUBLIC_FLAG);http.createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')"`,
    ].join(" ");
    const record = yield* boot.boot({
      version: version(start, { ports: [{ name: "start", port }] }),
      cwd,
      occurredAt: "2026-09-19T12:00:01.000Z",
      secretValues,
    });

    const startHealth = record.services.find((service) => service.name === "start");
    const worker = record.services.find((service) => service.name === "worker");
    assert(startHealth !== undefined && worker !== undefined);
    expect(startHealth.status).toBe("healthy");
    expect(startHealth.port).toBe(port);
    expect(worker.status).toBe("healthy");
    expect(startHealth.log.stdout).toContain("[redacted]");
    expect(startHealth.log.stdout).not.toContain("session-secret-value");
    expect(startHealth.log.stdout).toContain("public-flag-value");
    expect(yield* fs.exists(path.join(cwd, "install.ok"))).toBe(false);
  }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(TestLayer)),
);

it.effect("records an unhealthy start that exits immediately", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-boot-fail-" });
    const boot = yield* make({ healthCheckMs: 400 });
    const record = yield* boot.boot({
      version: version('node -e "process.exit(2)"'),
      cwd,
      occurredAt: "2026-09-19T12:00:01.000Z",
      secretValues,
    });

    expect(record.services[0]?.status).toBe("unhealthy");
    expect(record.services[0]?.log.exitCode).toBe(2);
  }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(TestLayer)),
);

it.effect("refuses to boot when a runtime secret is missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-boot-secret-" });
    const boot = yield* make({ healthCheckMs: 200 });
    const error = yield* boot
      .boot({
        version: version('node -e "setInterval(() => {}, 1000)"'),
        cwd,
        occurredAt: "2026-09-19T12:00:01.000Z",
      })
      .pipe(Effect.flip);

    expect(error.reason).toBe("secret-unavailable");
  }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(TestLayer)),
);
