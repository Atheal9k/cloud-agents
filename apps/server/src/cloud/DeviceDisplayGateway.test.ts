import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { SharedBrowserAgentHandoff } from "./SharedBrowserAgentHandoff.ts";
import { make, DEVICE_DISPLAY_ROUTE_PREFIX } from "./DeviceDisplayGateway.ts";
import { DeviceDisplayHost } from "./DeviceDisplayHost.ts";

const threadId = ThreadId.make("thread-allocation-1-2");

const androidSession = {
  platform: "android" as const,
  transport: "serve-emu" as const,
  deviceName: "t3-android-allocation1-2",
  runtime: "Android 36",
  serial: "emulator-5554",
  buildRevision: "debug-1",
  connectionState: "booted" as const,
};

const iosSession = {
  platform: "ios" as const,
  transport: "serve-sim" as const,
  deviceName: "t3-ios-allocation1-2",
  runtime: "iOS 18.5",
  udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  buildRevision: "debug-1",
  connectionState: "app-running" as const,
};

function dependencies(session: typeof androidSession | typeof iosSession) {
  const inputModes: boolean[] = [];
  let pauseCount = 0;
  let resumeCount = 0;
  let prepareCount = 0;
  const layer = Layer.mergeAll(
    Layer.succeed(DeviceDisplayHost, {
      available: true,
      prepare: (requestedThreadId) =>
        Effect.sync(() => {
          prepareCount += 1;
          return {
            upstreamUrl: "http://127.0.0.1:3401",
            attemptKey: "allocation-1:2",
            threadId: requestedThreadId,
            session,
          };
        }),
      setInputEnabled: (_threadId, enabled) =>
        Effect.sync(() => {
          inputModes.push(enabled);
        }),
      reset: () => Effect.void,
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
    prepareCount: () => prepareCount,
  };
}

it.effect("issues an Android serve-emu observer bound to the job serial", () => {
  const fixture = dependencies(androidSession);
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      expect(issued.streamBasePath).toMatch(
        new RegExp(`^${DEVICE_DISPLAY_ROUTE_PREFIX}[A-Za-z0-9_-]{43}$`),
      );
      expect(issued.session.platform).toBe("android");
      expect(issued.session.transport).toBe("serve-emu");
      expect(issued.session.serial).toBe("emulator-5554");
      expect(issued.control).toEqual({ owner: "agent" });
      const token = issued.streamBasePath.slice(DEVICE_DISPLAY_ROUTE_PREFIX.length);
      expect(yield* gateway.resolve(token)).toMatchObject({
        threadId,
        deviceId: "emulator-5554",
        inputEnabled: false,
      });
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("issues an iOS serve-sim observer bound to the job UDID", () => {
  const fixture = dependencies(iosSession);
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      expect(issued.session.platform).toBe("ios");
      expect(issued.session.transport).toBe("serve-sim");
      expect(issued.session.udid).toBe("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
      const token = issued.streamBasePath.slice(DEVICE_DISPLAY_ROUTE_PREFIX.length);
      expect(yield* gateway.resolve(token)).toMatchObject({
        deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        platform: "ios",
      });
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("does not treat Android passing as iOS support", () => {
  const fixture = dependencies(androidSession);
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      expect(issued.session.platform).toBe("android");
      expect(issued.session.platform).not.toBe("ios");
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("reuses the human/agent input lease so only one viewer can type", () => {
  const fixture = dependencies(androidSession);
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
      expect(fixture.pauseCount()).toBe(1);
      expect(fixture.inputModes).toEqual([true]);
      const token = first.streamBasePath.slice(DEVICE_DISPLAY_ROUTE_PREFIX.length);
      const secondToken = second.streamBasePath.slice(DEVICE_DISPLAY_ROUTE_PREFIX.length);
      const firstTarget = yield* gateway.resolve(token);
      const secondTarget = yield* gateway.resolve(secondToken);
      expect(firstTarget?.inputEnabled !== secondTarget?.inputEnabled).toBe(true);
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("returns control to the agent after an explicit handoff", () => {
  const fixture = dependencies(iosSession);
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      yield* gateway.takeControl({ threadId, viewerId: issued.viewerId });
      const returned = yield* gateway.returnControl({ threadId, viewerId: issued.viewerId });
      expect(returned.control).toEqual({ owner: "agent" });
      expect(fixture.inputModes).toEqual([true, false]);
      expect(fixture.resumeCount()).toBe(1);
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("revokes the display route and input lease on hibernate", () => {
  const fixture = dependencies(androidSession);
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      yield* gateway.takeControl({ threadId, viewerId: issued.viewerId });
      const token = issued.streamBasePath.slice(DEVICE_DISPLAY_ROUTE_PREFIX.length);
      yield* gateway.hibernate();
      expect(yield* gateway.resolve(token)).toBeNull();
      expect(fixture.inputModes).toContain(false);
      const error = yield* Effect.flip(
        gateway.keepAlive({ threadId, viewerId: issued.viewerId }),
      );
      expect(error.reason).toBe("viewer-expired");
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("restores the declared device profile on reopen without starting a provider run", () => {
  const fixture = dependencies(iosSession);
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      yield* gateway.hibernate();
      const restored = yield* gateway.restore(threadId);
      expect(restored.session.udid).toBe("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
      expect(restored.session.deviceName).toBe("t3-ios-allocation1-2");
      const reissued = yield* gateway.issue({ threadId });
      expect(reissued.session.udid).toBe(issued.session.udid);
      expect(reissued.control).toEqual({ owner: "agent" });
      expect(fixture.prepareCount()).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("expires a viewer and its input lease when heartbeats stop", () => {
  const fixture = dependencies(androidSession);
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      const token = issued.streamBasePath.slice(DEVICE_DISPLAY_ROUTE_PREFIX.length);
      yield* gateway.takeControl({ threadId, viewerId: issued.viewerId });
      yield* TestClock.adjust("76 seconds");
      expect(yield* gateway.resolve(token)).toBeNull();
      const error = yield* Effect.flip(
        gateway.keepAlive({ threadId, viewerId: issued.viewerId }),
      );
      expect(error.reason).toBe("viewer-expired");
      expect(fixture.inputModes).toContain(false);
      expect(fixture.resumeCount()).toBe(0);
    }).pipe(Effect.provide(fixture.layer)),
  );
});

it.effect("disconnects other viewer transports before enabling human input", () => {
  const fixture = dependencies(androidSession);
  return Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const observer = yield* gateway.issue({ threadId });
      const controller = yield* gateway.issue({ threadId });
      const observerToken = observer.streamBasePath.slice(DEVICE_DISPLAY_ROUTE_PREFIX.length);
      const observerConnection = yield* gateway.attachWebSocket(observerToken);
      expect(observerConnection).not.toBeNull();
      if (observerConnection === null) return;

      const takeover = yield* Effect.forkChild(
        gateway.takeControl({ threadId, viewerId: controller.viewerId }),
        { startImmediately: true },
      );
      yield* observerConnection.waitUntilRevoked;
      expect(fixture.inputModes).toEqual([]);
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
