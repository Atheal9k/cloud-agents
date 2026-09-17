// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  PreviewGatewayError,
  type DiscoveredLocalServer,
  type PreviewGatewayGrant,
  type PreviewGatewayIssueInput,
  type PreviewGatewayProtocol,
  type ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import * as PortScanner from "./PortScanner.ts";

export const PREVIEW_GATEWAY_BOOTSTRAP_PREFIX = "/api/preview-gateway/";
export const PREVIEW_GATEWAY_COOKIE_NAME = "t3_preview_gateway";
const PREVIEW_GATEWAY_LIFETIME_MILLIS = 3 * 60 * 60 * 1_000;

export interface PreviewGatewayTarget {
  readonly threadId: ThreadId;
  readonly port: number;
  readonly protocol: PreviewGatewayProtocol;
  readonly initialPath: string;
  readonly expiresAtMillis: number;
  readonly pid: number;
  readonly terminalId: string;
}

export class PreviewGateway extends Context.Service<
  PreviewGateway,
  {
    readonly issue: (
      input: PreviewGatewayIssueInput,
    ) => Effect.Effect<PreviewGatewayGrant, PreviewGatewayError>;
    readonly resolve: (token: string) => Effect.Effect<PreviewGatewayTarget | null>;
  }
>()("t3/preview/Gateway/PreviewGateway") {}

const gatewayError = (
  reason: PreviewGatewayError["reason"],
  message: string,
): PreviewGatewayError => new PreviewGatewayError({ reason, message });

function normalizeTargetPath(path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n\0]/.test(path)) return null;
  try {
    const parsed = new URL(path, "http://preview.invalid");
    if (parsed.origin !== "http://preview.invalid") return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export const make = Effect.fn("PreviewGateway.make")(function* () {
  const ports = yield* PortScanner.PortDiscovery;
  const grants = yield* Ref.make<ReadonlyMap<string, PreviewGatewayTarget>>(new Map());

  const targetMatchesServer = (
    target: PreviewGatewayTarget,
    server: DiscoveredLocalServer,
  ): boolean => {
    if (
      server.port !== target.port ||
      server.pid !== target.pid ||
      server.terminal?.threadId !== target.threadId ||
      server.terminal.terminalId !== target.terminalId ||
      !isLoopbackHost(server.host)
    ) {
      return false;
    }
    return new URL(server.url).protocol === `${target.protocol}:`;
  };

  const reconcile = Effect.fn("PreviewGateway.reconcile")(function* (
    servers: ReadonlyArray<DiscoveredLocalServer>,
  ) {
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Ref.update(grants, (current) => {
      const next = new Map(
        [...current].filter(
          ([, target]) =>
            target.expiresAtMillis > nowMillis &&
            servers.some((server) => targetMatchesServer(target, server)),
        ),
      );
      return next.size === current.size ? current : next;
    });
  });

  const pollActiveGrants = Effect.fn("PreviewGateway.pollActiveGrants")(
    function* () {
      if ((yield* Ref.get(grants)).size === 0) return;
      yield* reconcile(yield* ports.scan());
    },
    Effect.catchCause((cause) => Effect.logWarning("preview gateway validation failed", cause)),
  );
  yield* Effect.forkScoped(pollActiveGrants().pipe(Effect.repeat(Schedule.spaced("3 seconds"))));

  const issue: PreviewGateway["Service"]["issue"] = Effect.fn("PreviewGateway.issue")(
    function* (input) {
      const initialPath = normalizeTargetPath(input.path);
      if (initialPath === null) {
        return yield* gatewayError(
          "invalid-path",
          "The preview path must stay on the selected app.",
        );
      }
      const discovered = yield* ports.scan();
      yield* reconcile(discovered);
      const approved = discovered.find(
        (server) => server.port === input.port && isLoopbackHost(server.host),
      );
      if (
        approved === undefined ||
        approved.pid === null ||
        approved.terminal === null ||
        approved.terminal.threadId !== input.threadId
      ) {
        return yield* gatewayError(
          "port-not-approved",
          `Port ${input.port} is not a detected local web server.`,
        );
      }
      const approvedProtocol = new URL(approved.url).protocol.slice(0, -1);
      if (approvedProtocol !== input.protocol) {
        return yield* gatewayError(
          "protocol-mismatch",
          `Port ${input.port} is not serving ${input.protocol.toUpperCase()}.`,
        );
      }

      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { milliseconds: PREVIEW_GATEWAY_LIFETIME_MILLIS });
      const expiresAtMillis = DateTime.toEpochMillis(expiresAt);
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      const target: PreviewGatewayTarget = {
        threadId: input.threadId,
        port: input.port,
        protocol: input.protocol,
        initialPath,
        expiresAtMillis,
        pid: approved.pid,
        terminalId: approved.terminal.terminalId,
      };
      yield* Ref.update(grants, (current) => {
        const next = new Map(
          [...current].filter(([, grant]) => grant.expiresAtMillis > DateTime.toEpochMillis(now)),
        );
        next.set(token, target);
        return next;
      });
      return {
        bootstrapPath: `${PREVIEW_GATEWAY_BOOTSTRAP_PREFIX}${token}`,
        expiresAt: DateTime.formatIso(expiresAt),
      };
    },
  );

  const resolve: PreviewGateway["Service"]["resolve"] = Effect.fn("PreviewGateway.resolve")(
    function* (token) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
      return yield* Ref.modify(grants, (current) => {
        const target = current.get(token);
        if (target !== undefined && target.expiresAtMillis > nowMillis) return [target, current];
        if (target === undefined) return [null, current];
        const next = new Map(current);
        next.delete(token);
        return [null, next];
      });
    },
  );

  return PreviewGateway.of({ issue, resolve });
});

export const layer = Layer.effect(PreviewGateway)(make());
