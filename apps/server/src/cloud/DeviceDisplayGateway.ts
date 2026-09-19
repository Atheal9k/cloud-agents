// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  DeviceDisplayError,
  DeviceDisplayViewerId,
  deviceDisplayId,
  type DeviceDisplayControlState,
  type DeviceDisplayGrant,
  type DeviceDisplayIssueInput,
  type DeviceDisplayViewerInput,
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
import { DeviceDisplayHost, type DeviceDisplayHostDescriptor } from "./DeviceDisplayHost.ts";

export const DEVICE_DISPLAY_ROUTE_PREFIX = "/api/device-display/";
const VIEWER_LIFETIME_MILLIS = 75_000;

interface DeviceDisplayViewer {
  readonly viewerId: DeviceDisplayViewerId;
  readonly token: string;
  readonly threadId: ThreadId;
  readonly host: DeviceDisplayHostDescriptor;
  readonly expiresAtMillis: number;
}

interface DeviceDisplayState {
  readonly viewers: ReadonlyMap<DeviceDisplayViewerId, DeviceDisplayViewer>;
  readonly connections: ReadonlyMap<string, DeviceDisplayConnection>;
  readonly control: DeviceDisplayControlState;
}

interface DeviceDisplayConnection {
  readonly viewerId: DeviceDisplayViewerId;
  readonly disconnect: Deferred.Deferred<void>;
  readonly closed: Deferred.Deferred<void>;
}

export interface DeviceDisplayGatewayTarget {
  readonly viewerId: DeviceDisplayViewerId;
  readonly threadId: ThreadId;
  readonly upstreamUrl: string;
  readonly deviceId: string;
  readonly platform: DeviceDisplayHostDescriptor["session"]["platform"];
  readonly inputEnabled: boolean;
  readonly expiresAtMillis: number;
}

export interface DeviceDisplayGatewayConnection {
  readonly connectionId: string;
  readonly target: DeviceDisplayGatewayTarget;
  readonly waitUntilRevoked: Effect.Effect<void>;
}

export class DeviceDisplayGateway extends Context.Service<
  DeviceDisplayGateway,
  {
    readonly issue: (
      input: DeviceDisplayIssueInput,
    ) => Effect.Effect<DeviceDisplayGrant, DeviceDisplayError>;
    readonly keepAlive: (
      input: DeviceDisplayViewerInput,
    ) => Effect.Effect<DeviceDisplayGrant, DeviceDisplayError>;
    readonly takeControl: (
      input: DeviceDisplayViewerInput,
    ) => Effect.Effect<DeviceDisplayGrant, DeviceDisplayError>;
    readonly returnControl: (
      input: DeviceDisplayViewerInput,
    ) => Effect.Effect<DeviceDisplayGrant, DeviceDisplayError>;
    readonly release: (
      input: DeviceDisplayViewerInput,
    ) => Effect.Effect<{ readonly released: boolean }, DeviceDisplayError>;
    readonly hibernate: () => Effect.Effect<void, DeviceDisplayError>;
    readonly restore: (
      threadId: ThreadId,
    ) => Effect.Effect<DeviceDisplayHostDescriptor, DeviceDisplayError>;
    readonly resolve: (token: string) => Effect.Effect<DeviceDisplayGatewayTarget | null>;
    readonly attachWebSocket: (
      token: string,
    ) => Effect.Effect<DeviceDisplayGatewayConnection | null>;
    readonly detachWebSocket: (connectionId: string) => Effect.Effect<void>;
  }
>()("t3/cloud/DeviceDisplayGateway") {}

function gatewayError(reason: DeviceDisplayError["reason"], message: string): DeviceDisplayError {
  return new DeviceDisplayError({ reason, message });
}

function grant(
  viewer: DeviceDisplayViewer,
  control: DeviceDisplayControlState,
): DeviceDisplayGrant {
  return {
    viewerId: viewer.viewerId,
    streamBasePath: `${DEVICE_DISPLAY_ROUTE_PREFIX}${viewer.token}`,
    attemptKey: viewer.host.attemptKey,
    session: viewer.host.session,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(viewer.expiresAtMillis)),
    control,
  };
}

function activeViewer(
  state: DeviceDisplayState,
  input: DeviceDisplayViewerInput,
  nowMillis: number,
): DeviceDisplayViewer | null {
  const viewer = state.viewers.get(input.viewerId);
  return viewer !== undefined &&
    viewer.threadId === input.threadId &&
    viewer.expiresAtMillis > nowMillis
    ? viewer
    : null;
}

function target(
  viewer: DeviceDisplayViewer,
  control: DeviceDisplayControlState,
): DeviceDisplayGatewayTarget {
  return {
    viewerId: viewer.viewerId,
    threadId: viewer.threadId,
    upstreamUrl: viewer.host.upstreamUrl,
    deviceId: deviceDisplayId(viewer.host.session),
    platform: viewer.host.session.platform,
    inputEnabled: control.owner === "human" && control.viewerId === viewer.viewerId,
    expiresAtMillis: viewer.expiresAtMillis,
  };
}

export const make = Effect.fn("DeviceDisplayGateway.make")(function* () {
  const handoff = yield* SharedBrowserAgentHandoff;
  const host = yield* DeviceDisplayHost;
  const state = yield* Ref.make<DeviceDisplayState>({
    viewers: new Map(),
    connections: new Map(),
    control: { owner: "agent" },
  });
  const semaphore = yield* Semaphore.make(1);

  const revokeExpiredControl = Effect.fn("DeviceDisplayGateway.revokeExpiredControl")(function* (
    current: DeviceDisplayState,
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
    } satisfies DeviceDisplayState;
  });

  const closeConnections = (current: DeviceDisplayState, keepViewerId?: string) =>
    Effect.gen(function* () {
      const closing = [...current.connections.values()].filter(
        (connection) => keepViewerId === undefined || connection.viewerId !== keepViewerId,
      );
      yield* Effect.forEach(closing, (connection) => Deferred.succeed(connection.disconnect, undefined));
      yield* Effect.forEach(closing, (connection) => Deferred.await(connection.closed));
    });

  /** A handoff that did not complete leaves nobody driving, which the viewer shows. */
  const releaseControlAfterFailedHandoff = Ref.update(
    state,
    (latest): DeviceDisplayState => ({
      ...latest,
      control: { owner: "none", reason: "handoff-failed" },
    }),
  );

  const purgeExpired = Effect.fn("DeviceDisplayGateway.purgeExpired")(function* () {
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
          Effect.logWarning("Failed to purge expired device display viewers.", {
            error: String(error),
          }),
        ),
      );
  });
  yield* Effect.forkScoped(purgeExpired().pipe(Effect.repeat(Schedule.spaced("5 seconds"))));

  const issue: DeviceDisplayGateway["Service"]["issue"] = (input) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const descriptor = yield* host.prepare(input.threadId);
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        let current = yield* revokeExpiredControl(yield* Ref.get(state), nowMillis);
        if (current.control.owner === "none" && current.control.reason === "hibernated") {
          current = {
            viewers: new Map(),
            connections: new Map(),
            control: { owner: "agent" },
          };
        }
        const viewer: DeviceDisplayViewer = {
          viewerId: DeviceDisplayViewerId.make(NodeCrypto.randomBytes(18).toString("base64url")),
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

  const keepAlive: DeviceDisplayGateway["Service"]["keepAlive"] = (input) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const current = yield* revokeExpiredControl(yield* Ref.get(state), nowMillis);
        const viewer = activeViewer(current, input, nowMillis);
        if (viewer === null) {
          const viewers = new Map(current.viewers);
          viewers.delete(input.viewerId);
          yield* Ref.set(state, { ...current, viewers });
          return yield* gatewayError("viewer-expired", "The device display viewer has expired.");
        }
        const refreshed = {
          ...viewer,
          expiresAtMillis: nowMillis + VIEWER_LIFETIME_MILLIS,
        };
        const viewers = new Map(current.viewers);
        viewers.set(input.viewerId, refreshed);
        const control: DeviceDisplayControlState =
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

  const takeControl: DeviceDisplayGateway["Service"]["takeControl"] = (input) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const current = yield* revokeExpiredControl(yield* Ref.get(state), nowMillis);
        const viewer = activeViewer(current, input, nowMillis);
        if (viewer === null) {
          return yield* gatewayError("viewer-expired", "The device display viewer has expired.");
        }
        if (current.control.owner === "human") {
          if (current.control.viewerId !== input.viewerId) {
            return yield* gatewayError(
              "control-busy",
              "Another viewer currently controls the device display.",
            );
          }
          return grant(viewer, current.control);
        }

        const refreshed: DeviceDisplayViewer = {
          ...viewer,
          expiresAtMillis: nowMillis + VIEWER_LIFETIME_MILLIS,
        };
        const control: DeviceDisplayControlState = {
          owner: "human",
          viewerId: input.viewerId,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(refreshed.expiresAtMillis)),
        };
        const reservedViewers = new Map(current.viewers);
        reservedViewers.set(input.viewerId, refreshed);
        yield* Ref.set(state, { ...current, viewers: reservedViewers, control });
        yield* closeConnections(current, input.viewerId);
        yield* handoff.pause(input.threadId).pipe(
          Effect.tapError(() => releaseControlAfterFailedHandoff),
          Effect.mapError(() =>
            gatewayError("handoff-failed", "The agent would not release the device for a human."),
          ),
        );
        yield* host
          .setInputEnabled(input.threadId, true)
          .pipe(Effect.tapError(() => releaseControlAfterFailedHandoff));
        return grant(refreshed, control);
      }),
    );

  const returnControl: DeviceDisplayGateway["Service"]["returnControl"] = (input) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const current = yield* revokeExpiredControl(yield* Ref.get(state), nowMillis);
        const viewer = activeViewer(current, input, nowMillis);
        if (viewer === null) {
          return yield* gatewayError("viewer-expired", "The device display viewer has expired.");
        }
        if (current.control.owner !== "human" || current.control.viewerId !== input.viewerId) {
          return yield* gatewayError(
            "control-not-owned",
            "This viewer does not control the device display.",
          );
        }

        yield* host.setInputEnabled(input.threadId, false);
        yield* Ref.set(state, {
          ...current,
          control: { owner: "none", reason: "handoff-failed" },
        });
        yield* handoff
          .resume(input.threadId)
          .pipe(
            Effect.mapError(() =>
              gatewayError("handoff-failed", "The agent could not take the device back."),
            ),
          );
        const next = yield* Ref.get(state);
        yield* Ref.set(state, { ...next, control: { owner: "agent" } });
        return grant(viewer, { owner: "agent" });
      }),
    );

  const release: DeviceDisplayGateway["Service"]["release"] = (input) =>
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

  const hibernate: DeviceDisplayGateway["Service"]["hibernate"] = () =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.control.owner === "human") {
          const owner = current.viewers.get(current.control.viewerId);
          if (owner !== undefined) {
            yield* host.setInputEnabled(owner.threadId, false);
          }
        }
        yield* closeConnections(current);
        yield* host.reset();
        yield* Ref.set(state, {
          viewers: new Map(),
          connections: new Map(),
          control: { owner: "none", reason: "hibernated" },
        });
      }),
    );

  const restore: DeviceDisplayGateway["Service"]["restore"] = (threadId) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* host.reset();
        const descriptor = yield* host.prepare(threadId);
        yield* Ref.set(state, {
          viewers: new Map(),
          connections: new Map(),
          control: { owner: "agent" },
        });
        return descriptor;
      }),
    );

  const resolve: DeviceDisplayGateway["Service"]["resolve"] = (token) =>
    Effect.gen(function* () {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
      const current = yield* Ref.get(state);
      const viewer = [...current.viewers.values()].find(
        (candidate) => candidate.token === token && candidate.expiresAtMillis > nowMillis,
      );
      return viewer === undefined ? null : target(viewer, current.control);
    });

  const attachWebSocket: DeviceDisplayGateway["Service"]["attachWebSocket"] = (token) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const current = yield* Ref.get(state);
        const viewer = [...current.viewers.values()].find(
          (candidate) => candidate.token === token && candidate.expiresAtMillis > nowMillis,
        );
        if (viewer === undefined) return null;
        const connectionId = NodeCrypto.randomBytes(18).toString("base64url");
        const disconnect = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const connections = new Map(current.connections);
        connections.set(connectionId, { viewerId: viewer.viewerId, disconnect, closed });
        yield* Ref.set(state, { ...current, connections });
        return {
          connectionId,
          target: target(viewer, current.control),
          waitUntilRevoked: Deferred.await(disconnect),
        };
      }),
    );

  const detachWebSocket: DeviceDisplayGateway["Service"]["detachWebSocket"] = (connectionId) =>
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

  yield* Effect.addFinalizer(() => hibernate().pipe(Effect.ignore));

  return DeviceDisplayGateway.of({
    issue,
    keepAlive,
    takeControl,
    returnControl,
    release,
    hibernate,
    restore,
    resolve,
    attachWebSocket,
    detachWebSocket,
  });
});

export const layer = Layer.effect(DeviceDisplayGateway, make());
