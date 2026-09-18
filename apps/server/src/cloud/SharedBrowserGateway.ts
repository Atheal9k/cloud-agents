// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  SharedBrowserError,
  SharedBrowserViewerId,
  type SharedBrowserControlState,
  type SharedBrowserGrant,
  type SharedBrowserIssueInput,
  type SharedBrowserViewerInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { SharedBrowserAgentHandoff } from "./SharedBrowserAgentHandoff.ts";
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

interface SharedBrowserState {
  readonly viewers: ReadonlyMap<SharedBrowserViewerId, SharedBrowserViewer>;
  readonly connections: ReadonlyMap<string, SharedBrowserConnection>;
  readonly control: SharedBrowserControlState;
}

interface SharedBrowserConnection {
  readonly viewerId: SharedBrowserViewerId;
  readonly disconnect: Deferred.Deferred<void>;
  readonly closed: Deferred.Deferred<void>;
}

export interface SharedBrowserGatewayTarget {
  readonly viewerId: SharedBrowserViewerId;
  readonly threadId: ThreadId;
  readonly upstreamUrl: string;
  readonly sessionId: string;
  readonly expiresAtMillis: number;
}

export interface SharedBrowserGatewayConnection {
  readonly connectionId: string;
  readonly target: SharedBrowserGatewayTarget;
  readonly waitUntilRevoked: Effect.Effect<void>;
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
    readonly takeControl: (
      input: SharedBrowserViewerInput,
    ) => Effect.Effect<SharedBrowserGrant, SharedBrowserError>;
    readonly returnControl: (
      input: SharedBrowserViewerInput,
    ) => Effect.Effect<SharedBrowserGrant, SharedBrowserError>;
    readonly release: (
      input: SharedBrowserViewerInput,
    ) => Effect.Effect<{ readonly released: boolean }, SharedBrowserError>;
    readonly resolve: (token: string) => Effect.Effect<SharedBrowserGatewayTarget | null>;
    readonly attachWebSocket: (
      token: string,
    ) => Effect.Effect<SharedBrowserGatewayConnection | null>;
    readonly detachWebSocket: (connectionId: string) => Effect.Effect<void>;
  }
>()("t3/cloud/SharedBrowserGateway") {}

function gatewayError(reason: SharedBrowserError["reason"], message: string): SharedBrowserError {
  return new SharedBrowserError({ reason, message });
}

function grant(
  viewer: SharedBrowserViewer,
  control: SharedBrowserControlState,
): SharedBrowserGrant {
  return {
    viewerId: viewer.viewerId,
    bootstrapPath: `${SHARED_BROWSER_BOOTSTRAP_PREFIX}${viewer.token}`,
    attemptKey: viewer.host.attemptKey,
    transport: "dcv",
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(viewer.expiresAtMillis)),
    control,
  };
}

function activeViewer(
  state: SharedBrowserState,
  input: SharedBrowserViewerInput,
  nowMillis: number,
): SharedBrowserViewer | null {
  const viewer = state.viewers.get(input.viewerId);
  return viewer !== undefined &&
    viewer.threadId === input.threadId &&
    viewer.expiresAtMillis > nowMillis
    ? viewer
    : null;
}

function canConnect(state: SharedBrowserState, viewer: SharedBrowserViewer): boolean {
  return state.control.owner !== "human" || state.control.viewerId === viewer.viewerId;
}

function target(viewer: SharedBrowserViewer): SharedBrowserGatewayTarget {
  return {
    viewerId: viewer.viewerId,
    threadId: viewer.threadId,
    upstreamUrl: viewer.host.upstreamUrl,
    sessionId: viewer.host.sessionId,
    expiresAtMillis: viewer.expiresAtMillis,
  };
}

export const make = Effect.fn("SharedBrowserGateway.make")(function* () {
  const handoff = yield* SharedBrowserAgentHandoff;
  const host = yield* SharedBrowserHost;
  const state = yield* Ref.make<SharedBrowserState>({
    viewers: new Map(),
    connections: new Map(),
    control: { owner: "agent" },
  });
  const semaphore = yield* Semaphore.make(1);

  const revokeExpiredControl = Effect.fn("SharedBrowserGateway.revokeExpiredControl")(function* (
    current: SharedBrowserState,
    nowMillis: number,
  ) {
    if (current.control.owner !== "human") return current;
    if (Date.parse(current.control.expiresAt) > nowMillis) return current;
    const owner = current.viewers.get(current.control.viewerId);
    if (owner !== undefined) {
      yield* host.setInputEnabled(owner.threadId, false);
    }
    return {
      ...current,
      control: { owner: "none", reason: "viewer-expired" },
    } satisfies SharedBrowserState;
  });

  const purgeExpired = Effect.fn("SharedBrowserGateway.purgeExpired")(function* () {
    yield* semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
          const before = yield* Ref.get(state);
          const current = yield* revokeExpiredControl(before, nowMillis);
          const viewers = new Map(
            [...current.viewers].filter(([, viewer]) => viewer.expiresAtMillis > nowMillis),
          );
          if (viewers.size !== current.viewers.size || current !== before) {
            yield* Ref.set(state, { ...current, viewers });
          }
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to purge expired shared browser viewers.", {
            error: String(error),
          }),
        ),
      );
  });
  yield* Effect.forkScoped(purgeExpired().pipe(Effect.repeat(Schedule.spaced("5 seconds"))));

  const issue: SharedBrowserGateway["Service"]["issue"] = (input) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const descriptor = yield* host.prepare(input.threadId);
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const current = yield* revokeExpiredControl(yield* Ref.get(state), nowMillis);
        const viewer: SharedBrowserViewer = {
          viewerId: SharedBrowserViewerId.make(NodeCrypto.randomBytes(18).toString("base64url")),
          token: NodeCrypto.randomBytes(32).toString("base64url"),
          threadId: input.threadId,
          host: descriptor,
          expiresAtMillis: nowMillis + VIEWER_LIFETIME_MILLIS,
        };
        const viewers = new Map(
          [...current.viewers].filter(([, candidate]) => candidate.expiresAtMillis > nowMillis),
        );
        viewers.set(viewer.viewerId, viewer);
        yield* Ref.set(state, { ...current, viewers });
        return grant(viewer, current.control);
      }),
    );

  const keepAlive: SharedBrowserGateway["Service"]["keepAlive"] = (input) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const current = yield* revokeExpiredControl(yield* Ref.get(state), nowMillis);
        const viewer = activeViewer(current, input, nowMillis);
        if (viewer === null) {
          const viewers = new Map(current.viewers);
          viewers.delete(input.viewerId);
          yield* Ref.set(state, { ...current, viewers });
          return yield* gatewayError("viewer-expired", "The shared browser viewer has expired.");
        }
        const refreshed = {
          ...viewer,
          expiresAtMillis: nowMillis + VIEWER_LIFETIME_MILLIS,
        };
        const viewers = new Map(current.viewers);
        viewers.set(input.viewerId, refreshed);
        const control: SharedBrowserControlState =
          current.control.owner === "human" && current.control.viewerId === input.viewerId
            ? {
                owner: "human",
                viewerId: input.viewerId,
                expiresAt: DateTime.formatIso(DateTime.makeUnsafe(refreshed.expiresAtMillis)),
              }
            : current.control;
        yield* Ref.set(state, { ...current, viewers, control });
        return grant(refreshed, control);
      }),
    );

  const takeControl: SharedBrowserGateway["Service"]["takeControl"] = (input) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const current = yield* revokeExpiredControl(yield* Ref.get(state), nowMillis);
        const viewer = activeViewer(current, input, nowMillis);
        if (viewer === null) {
          return yield* gatewayError("viewer-expired", "The shared browser viewer has expired.");
        }
        if (current.control.owner === "human") {
          if (current.control.viewerId !== input.viewerId) {
            return yield* gatewayError(
              "control-busy",
              "Another viewer currently controls the shared browser.",
            );
          }
          return grant(viewer, current.control);
        }

        const refreshed: SharedBrowserViewer = {
          ...viewer,
          expiresAtMillis: nowMillis + VIEWER_LIFETIME_MILLIS,
        };
        const control: SharedBrowserControlState = {
          owner: "human",
          viewerId: input.viewerId,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(refreshed.expiresAtMillis)),
        };
        const reservedViewers = new Map(current.viewers);
        reservedViewers.set(input.viewerId, refreshed);
        yield* Ref.set(state, { ...current, viewers: reservedViewers, control });

        const connectionsToClose = [...current.connections.values()].filter(
          (connection) => connection.viewerId !== input.viewerId,
        );
        yield* Effect.forEach(connectionsToClose, (connection) =>
          Deferred.succeed(connection.disconnect, undefined),
        );
        yield* Effect.forEach(connectionsToClose, (connection) =>
          Deferred.await(connection.closed),
        );

        yield* handoff.pause(input.threadId).pipe(
          Effect.tapError(() =>
            Ref.update(state, (latest) => {
              const updated: SharedBrowserState = {
                ...latest,
                control: { owner: "none", reason: "handoff-failed" },
              };
              return updated;
            }),
          ),
        );
        yield* host.setInputEnabled(input.threadId, true).pipe(
          Effect.tapError(() =>
            Ref.update(state, (latest) => {
              const updated: SharedBrowserState = {
                ...latest,
                control: { owner: "none", reason: "handoff-failed" },
              };
              return updated;
            }),
          ),
        );
        return grant(refreshed, control);
      }),
    );

  const returnControl: SharedBrowserGateway["Service"]["returnControl"] = (input) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const current = yield* revokeExpiredControl(yield* Ref.get(state), nowMillis);
        const viewer = activeViewer(current, input, nowMillis);
        if (viewer === null) {
          return yield* gatewayError("viewer-expired", "The shared browser viewer has expired.");
        }
        if (current.control.owner !== "human" || current.control.viewerId !== input.viewerId) {
          return yield* gatewayError(
            "control-not-owned",
            "This viewer does not control the shared browser.",
          );
        }

        yield* host.setInputEnabled(input.threadId, false);
        yield* Ref.set(state, {
          ...current,
          control: { owner: "none", reason: "handoff-failed" },
        });
        yield* handoff.resume(input.threadId);
        const next = yield* Ref.get(state);
        yield* Ref.set(state, { ...next, control: { owner: "agent" } });
        return grant(viewer, { owner: "agent" });
      }),
    );

  const release: SharedBrowserGateway["Service"]["release"] = (input) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const viewer = current.viewers.get(input.viewerId);
        if (viewer === undefined || viewer.threadId !== input.threadId) {
          return { released: false } as const;
        }
        let control = current.control;
        if (control.owner === "human" && control.viewerId === input.viewerId) {
          yield* host.setInputEnabled(input.threadId, false);
          control = { owner: "none", reason: "viewer-disconnected" };
        }
        const viewers = new Map(current.viewers);
        viewers.delete(input.viewerId);
        yield* Ref.set(state, { ...current, viewers, control });
        return { released: true } as const;
      }),
    );

  const resolve: SharedBrowserGateway["Service"]["resolve"] = (token) =>
    Effect.gen(function* () {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
      const current = yield* Ref.get(state);
      const viewer = [...current.viewers.values()].find(
        (candidate) => candidate.token === token && candidate.expiresAtMillis > nowMillis,
      );
      return viewer === undefined || !canConnect(current, viewer) ? null : target(viewer);
    });

  const attachWebSocket: SharedBrowserGateway["Service"]["attachWebSocket"] = (token) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const current = yield* Ref.get(state);
        const viewer = [...current.viewers.values()].find(
          (candidate) => candidate.token === token && candidate.expiresAtMillis > nowMillis,
        );
        if (viewer === undefined || !canConnect(current, viewer)) return null;
        const connectionId = NodeCrypto.randomBytes(18).toString("base64url");
        const disconnect = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const connections = new Map(current.connections);
        connections.set(connectionId, { viewerId: viewer.viewerId, disconnect, closed });
        yield* Ref.set(state, { ...current, connections });
        return {
          connectionId,
          target: target(viewer),
          waitUntilRevoked: Deferred.await(disconnect),
        };
      }),
    );

  const detachWebSocket: SharedBrowserGateway["Service"]["detachWebSocket"] = (connectionId) =>
    Effect.gen(function* () {
      const connection = yield* Ref.modify(state, (current) => {
        const found = current.connections.get(connectionId);
        if (found === undefined) return [null, current];
        const connections = new Map(current.connections);
        connections.delete(connectionId);
        return [found, { ...current, connections }];
      });
      if (connection !== null) yield* Deferred.succeed(connection.closed, undefined);
    });

  return SharedBrowserGateway.of({
    issue,
    keepAlive,
    takeControl,
    returnControl,
    release,
    resolve,
    attachWebSocket,
    detachWebSocket,
  });
});

export const layer = Layer.effect(SharedBrowserGateway, make());
