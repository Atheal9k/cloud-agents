import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { make, SHARED_BROWSER_BOOTSTRAP_PREFIX } from "./SharedBrowserGateway.ts";
import { SharedBrowserHost } from "./SharedBrowserHost.ts";

const threadId = ThreadId.make("thread-allocation-1-2");

const hostLayer = Layer.succeed(SharedBrowserHost, {
  available: true,
  prepare: (requestedThreadId) =>
    Effect.succeed({
      upstreamUrl: "http://127.0.0.1:8090",
      sessionId: "t3-allocation-1-2",
      display: ":1",
      attemptKey: "allocation-1:2",
      threadId: requestedThreadId,
    }),
});

it.effect("issues, refreshes, and releases one short-lived viewer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      expect(issued.bootstrapPath).toMatch(
        new RegExp(`^${SHARED_BROWSER_BOOTSTRAP_PREFIX}[A-Za-z0-9_-]{43}$`),
      );
      expect(issued.attemptKey).toBe("allocation-1:2");
      const token = issued.bootstrapPath.slice(SHARED_BROWSER_BOOTSTRAP_PREFIX.length);
      expect(yield* gateway.resolve(token)).toMatchObject({ threadId });

      yield* TestClock.adjust("60 seconds");
      const refreshed = yield* gateway.keepAlive({ threadId, viewerId: issued.viewerId });
      expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(Date.parse(issued.expiresAt));
      expect(yield* gateway.release({ threadId, viewerId: issued.viewerId })).toEqual({
        released: true,
      });
      expect(yield* gateway.resolve(token)).toBeNull();
    }).pipe(Effect.provide(hostLayer)),
  ),
);

it.effect("expires a viewer that is not kept alive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make();
      const issued = yield* gateway.issue({ threadId });
      const token = issued.bootstrapPath.slice(SHARED_BROWSER_BOOTSTRAP_PREFIX.length);
      yield* TestClock.adjust("76 seconds");
      expect(yield* gateway.resolve(token)).toBeNull();
      const error = yield* Effect.flip(gateway.keepAlive({ threadId, viewerId: issued.viewerId }));
      expect(error.reason).toBe("viewer-expired");
    }).pipe(Effect.provide(hostLayer)),
  ),
);
