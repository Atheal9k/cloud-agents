import { ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { make, PREVIEW_GATEWAY_BOOTSTRAP_PREFIX } from "./Gateway.ts";
import { PortDiscovery } from "./PortScanner.ts";

const portDiscovery = (url: string) =>
  Layer.succeed(PortDiscovery, {
    scan: () =>
      Effect.succeed([
        {
          host: "localhost",
          port: 5173,
          url,
          processName: "vite",
          pid: 42,
          terminal: { threadId: ThreadId.make("thread-1"), terminalId: "terminal-1" },
        },
      ]),
    subscribe: () => Effect.void,
    retain: Effect.void,
    registerTerminalProcesses: () => Effect.void,
    unregisterTerminal: () => Effect.void,
  });

it.effect("issues an opaque grant for one detected loopback app", () =>
  Effect.gen(function* () {
    const gateway = yield* make().pipe(
      Effect.provide(portDiscovery("http://localhost:5173/")),
      Effect.scoped,
    );
    const grant = yield* gateway.issue({
      threadId: ThreadId.make("thread-1"),
      port: 5173,
      protocol: "http",
      path: "/dashboard?mode=test#ignored",
    });
    expect(grant.bootstrapPath).toMatch(
      new RegExp(`^${PREVIEW_GATEWAY_BOOTSTRAP_PREFIX}[A-Za-z0-9_-]{43}$`),
    );
    const token = grant.bootstrapPath.slice(PREVIEW_GATEWAY_BOOTSTRAP_PREFIX.length);
    expect(yield* gateway.resolve(token)).toMatchObject({
      threadId: "thread-1",
      port: 5173,
      protocol: "http",
      initialPath: "/dashboard?mode=test",
    });
  }),
);

it.effect("rejects ports and protocols that the web probe did not approve", () =>
  Effect.gen(function* () {
    const gateway = yield* make().pipe(
      Effect.provide(portDiscovery("http://localhost:5173/")),
      Effect.scoped,
    );
    const missing = yield* Effect.flip(
      gateway.issue({
        threadId: ThreadId.make("thread-1"),
        port: 3000,
        protocol: "http",
        path: "/",
      }),
    );
    expect(missing.reason).toBe("port-not-approved");
    const wrongThread = yield* Effect.flip(
      gateway.issue({
        threadId: ThreadId.make("thread-2"),
        port: 5173,
        protocol: "http",
        path: "/",
      }),
    );
    expect(wrongThread.reason).toBe("port-not-approved");
    const wrongProtocol = yield* Effect.flip(
      gateway.issue({
        threadId: ThreadId.make("thread-1"),
        port: 5173,
        protocol: "https",
        path: "/",
      }),
    );
    expect(wrongProtocol.reason).toBe("protocol-mismatch");
  }),
);

it.effect("revokes a grant when its owned process disappears", () => {
  const server: DiscoveredLocalServer = {
    host: "localhost",
    port: 5173,
    url: "http://localhost:5173/",
    processName: "vite",
    pid: 42,
    terminal: { threadId: ThreadId.make("thread-1"), terminalId: "terminal-1" },
  };
  let servers: ReadonlyArray<DiscoveredLocalServer> = [server];
  const discovery = Layer.succeed(PortDiscovery, {
    scan: () => Effect.succeed(servers),
    subscribe: () => Effect.void,
    retain: Effect.void,
    registerTerminalProcesses: () => Effect.void,
    unregisterTerminal: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const grant = yield* gateway.issue({
        threadId: ThreadId.make("thread-1"),
        port: 5173,
        protocol: "http",
        path: "/",
      });
      const token = grant.bootstrapPath.slice(PREVIEW_GATEWAY_BOOTSTRAP_PREFIX.length);
      expect(yield* gateway.resolve(token)).not.toBeNull();
      servers = [];
      yield* TestClock.adjust("3 seconds");
      yield* Effect.yieldNow;
      expect(yield* gateway.resolve(token)).toBeNull();
    }).pipe(Effect.provide(discovery)),
  );
});

it.effect("rejects paths that could escape the selected app", () =>
  Effect.gen(function* () {
    const gateway = yield* make().pipe(
      Effect.provide(portDiscovery("http://localhost:5173/")),
      Effect.scoped,
    );
    const error = yield* Effect.flip(
      gateway.issue({
        threadId: ThreadId.make("thread-1"),
        port: 5173,
        protocol: "http",
        path: "//metadata.internal/latest",
      }),
    );
    expect(error.reason).toBe("invalid-path");
  }),
);
