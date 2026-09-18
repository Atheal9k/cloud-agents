import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { SharedBrowserAgentHandoff } from "./SharedBrowserAgentHandoff.ts";
import { make, SHARED_BROWSER_BOOTSTRAP_PREFIX } from "./SharedBrowserGateway.ts";
import { SharedBrowserHost } from "./SharedBrowserHost.ts";

const threadId = ThreadId.make("thread-allocation-1-2");

function dependencies() {
  const inputModes: boolean[] = [];
  let pauseCount = 0;
  let resumeCount = 0;
  const layer = Layer.mergeAll(
    Layer.succeed(SharedBrowserHost, {
      available: true,
      prepare: (requestedThreadId) =>
        Effect.succeed({
          upstreamUrl: "http://127.0.0.1:8090",
          sessionId: "t3-allocation-1-2",
          display: ":1",
          attemptKey: "allocation-1:2",
          threadId: requestedThreadId,
        }),
      setInputEnabled: (_threadId, enabled) =>
        Effect.sync(() => {
          inputModes.push(enabled);
        }),
    }),
    Layer.succeed(SharedBrowserAgentHandoff, {
      pause: () =>
        Effect.sync(() => {
          pauseCount += 1;
        }),
      resume: () =>
        Effect.sync(() => {
          resumeCount += 1;
        }),
    }),
  );
  return {
    layer,
    inputModes,
    pauseCount: () => pauseCount,
    resumeCount: () => resumeCount,
  };
}

it.effect("issues, refreshes, and releases one short-lived observer", () => {
  const fixture = dependencies();
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      expect(issued.bootstrapPath).toMatch(
        new RegExp(`^${SHARED_BROWSER_BOOTSTRAP_PREFIX}[A-Za-z0-9_-]{43}$`),
      );
      expect(issued.attemptKey).toBe("allocation-1:2");
      expect(issued.control).toEqual({ owner: "agent" });
      const token = issued.bootstrapPath.slice(SHARED_BROWSER_BOOTSTRAP_PREFIX.length);
      expect(yield* gateway.resolve(token)).toMatchObject({ threadId });

      yield* TestClock.adjust("60 seconds");
      const refreshed = yield* gateway.keepAlive({ threadId, viewerId: issued.viewerId });
      expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(Date.parse(issued.expiresAt));
      expect(yield* gateway.release({ threadId, viewerId: issued.viewerId })).toEqual({
        released: true,
      });
      expect(yield* gateway.resolve(token)).toBeNull();
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("interrupts before granting input and resumes only after an explicit return", () => {
  const fixture = dependencies();
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      const controlled = yield* gateway.takeControl({ threadId, viewerId: issued.viewerId });
      expect(controlled.control).toMatchObject({
        owner: "human",
        viewerId: issued.viewerId,
      });
      expect(fixture.pauseCount()).toBe(1);
      expect(fixture.inputModes).toEqual([true]);

      const returned = yield* gateway.returnControl({ threadId, viewerId: issued.viewerId });
      expect(returned.control).toEqual({ owner: "agent" });
      expect(fixture.inputModes).toEqual([true, false]);
      expect(fixture.resumeCount()).toBe(1);
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("serializes simultaneous takeover requests so only one viewer controls input", () => {
  const fixture = dependencies();
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const first = yield* gateway.issue({ threadId });
      const second = yield* gateway.issue({ threadId });
      const results = yield* Effect.all(
        [
          gateway.takeControl({ threadId, viewerId: first.viewerId }).pipe(Effect.exit),
          gateway.takeControl({ threadId, viewerId: second.viewerId }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter(Exit.isSuccess)).toHaveLength(1);
      const failure = results.find(Exit.isFailure);
      expect(failure).toBeDefined();
      if (failure !== undefined && Exit.isFailure(failure)) {
        expect(String(failure.cause)).toContain(
          "Another viewer currently controls the shared browser.",
        );
      }
      expect(fixture.pauseCount()).toBe(1);
      expect(fixture.inputModes).toEqual([true]);
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("disconnects other viewer transports before enabling human input", () => {
  const fixture = dependencies();
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const observer = yield* gateway.issue({ threadId });
      const controller = yield* gateway.issue({ threadId });
      const observerToken = observer.bootstrapPath.slice(SHARED_BROWSER_BOOTSTRAP_PREFIX.length);
      const observerConnection = yield* gateway.attachWebSocket(observerToken);
      expect(observerConnection).not.toBeNull();
      if (observerConnection === null) return;

      const takeover = yield* Effect.forkChild(
        gateway.takeControl({ threadId, viewerId: controller.viewerId }),
        { startImmediately: true },
      );
      yield* observerConnection.waitUntilRevoked;
      expect(fixture.inputModes).toEqual([]);
      expect(yield* gateway.resolve(observerToken)).toBeNull();

      yield* gateway.detachWebSocket(observerConnection.connectionId);
      const controlled = yield* Fiber.join(takeover);
      expect(controlled.control).toMatchObject({
        owner: "human",
        viewerId: controller.viewerId,
      });
      expect(fixture.inputModes).toEqual([true]);
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("revokes a lost controller without silently resuming the agent", () => {
  const fixture = dependencies();
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      yield* gateway.takeControl({ threadId, viewerId: issued.viewerId });
      expect(yield* gateway.release({ threadId, viewerId: issued.viewerId })).toEqual({
        released: true,
      });
      expect(fixture.inputModes).toEqual([true, false]);
      expect(fixture.resumeCount()).toBe(0);
      const observer = yield* gateway.issue({ threadId });
      expect(observer.control).toEqual({ owner: "none", reason: "viewer-disconnected" });
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("expires a viewer and its input lease when heartbeats stop", () => {
  const fixture = dependencies();
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      const token = issued.bootstrapPath.slice(SHARED_BROWSER_BOOTSTRAP_PREFIX.length);
      yield* gateway.takeControl({ threadId, viewerId: issued.viewerId });
      yield* TestClock.adjust("76 seconds");
      expect(yield* gateway.resolve(token)).toBeNull();
      const error = yield* Effect.flip(
        gateway.keepAlive({
          threadId,
          viewerId: issued.viewerId,
        }),
      );
      expect(error.reason).toBe("viewer-expired");
      expect(fixture.inputModes).toContain(false);
      expect(fixture.resumeCount()).toBe(0);
    }).pipe(Effect.provide(fixture.layer)),
  );
});
