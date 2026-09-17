// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  SharedBrowserError,
  SharedBrowserViewerId,
  type SharedBrowserGrant,
  type SharedBrowserIssueInput,
  type SharedBrowserViewerInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import { SharedBrowserHost, type SharedBrowserHostDescriptor } from "./SharedBrowserHost.ts";

export const SHARED_BROWSER_BOOTSTRAP_PREFIX = "/api/shared-browser/";
export const SHARED_BROWSER_COOKIE_NAME = "t3_shared_browser";
const VIEWER_LIFETIME_MILLIS = 75_000;
export const SHARED_BROWSER_COOKIE_MAX_AGE_SECONDS = 10 * 60;

interface SharedBrowserViewer {
  readonly viewerId: SharedBrowserViewerId;
  readonly token: string;
  readonly threadId: ThreadId;
  readonly host: SharedBrowserHostDescriptor;
  readonly expiresAtMillis: number;
}

export interface SharedBrowserGatewayTarget {
  readonly threadId: ThreadId;
  readonly upstreamUrl: string;
  readonly sessionId: string;
  readonly expiresAtMillis: number;
}

export class SharedBrowserGateway extends Context.Service<
  SharedBrowserGateway,
  {
    readonly issue: (
      input: SharedBrowserIssueInput,
    ) => Effect.Effect<SharedBrowserGrant, SharedBrowserError>;
    readonly keepAlive: (
      input: SharedBrowserViewerInput,
    ) => Effect.Effect<SharedBrowserGrant, SharedBrowserError>;
    readonly release: (
      input: SharedBrowserViewerInput,
    ) => Effect.Effect<{ readonly released: boolean }>;
    readonly resolve: (token: string) => Effect.Effect<SharedBrowserGatewayTarget | null>;
  }
>()("t3/cloud/SharedBrowserGateway") {}

function gatewayError(reason: SharedBrowserError["reason"], message: string): SharedBrowserError {
  return new SharedBrowserError({ reason, message });
}

function grant(viewer: SharedBrowserViewer): SharedBrowserGrant {
  return {
    viewerId: viewer.viewerId,
    bootstrapPath: `${SHARED_BROWSER_BOOTSTRAP_PREFIX}${viewer.token}`,
    attemptKey: viewer.host.attemptKey,
    transport: "dcv",
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(viewer.expiresAtMillis)),
  };
}

export const make = Effect.fn("SharedBrowserGateway.make")(function* () {
  const host = yield* SharedBrowserHost;
  const viewers = yield* Ref.make<ReadonlyMap<SharedBrowserViewerId, SharedBrowserViewer>>(
    new Map(),
  );

  const purgeExpired = Effect.fn("SharedBrowserGateway.purgeExpired")(function* () {
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Ref.update(viewers, (current) => {
      const next = new Map([...current].filter(([, viewer]) => viewer.expiresAtMillis > nowMillis));
      return next.size === current.size ? current : next;
    });
  });
  yield* Effect.forkScoped(purgeExpired().pipe(Effect.repeat(Schedule.spaced("30 seconds"))));

  const issue: SharedBrowserGateway["Service"]["issue"] = Effect.fn("SharedBrowserGateway.issue")(
    function* (input) {
      const descriptor = yield* host.prepare(input.threadId);
      const now = yield* DateTime.now;
      const viewer: SharedBrowserViewer = {
        viewerId: SharedBrowserViewerId.make(NodeCrypto.randomBytes(18).toString("base64url")),
        token: NodeCrypto.randomBytes(32).toString("base64url"),
        threadId: input.threadId,
        host: descriptor,
        expiresAtMillis: DateTime.toEpochMillis(now) + VIEWER_LIFETIME_MILLIS,
      };
      yield* Ref.update(viewers, (current) => {
        const next = new Map(
          [...current].filter(
            ([, candidate]) => candidate.expiresAtMillis > DateTime.toEpochMillis(now),
          ),
        );
        next.set(viewer.viewerId, viewer);
        return next;
      });
      return grant(viewer);
    },
  );

  const keepAlive: SharedBrowserGateway["Service"]["keepAlive"] = Effect.fn(
    "SharedBrowserGateway.keepAlive",
  )(function* (input) {
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const updated = yield* Ref.modify(viewers, (current) => {
      const viewer = current.get(input.viewerId);
      if (
        viewer === undefined ||
        viewer.threadId !== input.threadId ||
        viewer.expiresAtMillis <= nowMillis
      ) {
        const next = new Map(current);
        next.delete(input.viewerId);
        return [null, next];
      }
      const refreshed = { ...viewer, expiresAtMillis: nowMillis + VIEWER_LIFETIME_MILLIS };
      const next = new Map(current);
      next.set(input.viewerId, refreshed);
      return [refreshed, next];
    });
    if (updated === null) {
      return yield* gatewayError("viewer-expired", "The shared browser viewer has expired.");
    }
    return grant(updated);
  });

  const release: SharedBrowserGateway["Service"]["release"] = (input) =>
    Ref.modify(viewers, (current) => {
      const viewer = current.get(input.viewerId);
      if (viewer === undefined || viewer.threadId !== input.threadId) {
        const result: { readonly released: boolean } = { released: false };
        return [result, current];
      }
      const next = new Map(current);
      next.delete(input.viewerId);
      const result: { readonly released: boolean } = { released: true };
      return [result, next];
    });

  const resolve: SharedBrowserGateway["Service"]["resolve"] = (token) =>
    Effect.gen(function* () {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
      const viewer = [...(yield* Ref.get(viewers)).values()].find(
        (candidate) => candidate.token === token && candidate.expiresAtMillis > nowMillis,
      );
      return viewer === undefined
        ? null
        : {
            threadId: viewer.threadId,
            upstreamUrl: viewer.host.upstreamUrl,
            sessionId: viewer.host.sessionId,
            expiresAtMillis: viewer.expiresAtMillis,
          };
    });

  return SharedBrowserGateway.of({ issue, keepAlive, release, resolve });
});

export const layer = Layer.effect(SharedBrowserGateway)(make());
