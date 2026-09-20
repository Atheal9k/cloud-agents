import {
  CloudEnvironmentId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Tool } from "effect/unstable/ai";

import * as CloudDiagnosticsCatalog from "../../../cloud/CloudDiagnosticsCatalog.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CloudDiagnosticsToolkitHandlersLive } from "./handlers.ts";
import { CloudDiagnosticsToolkit } from "./tools.ts";

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const CatalogLive = Layer.mock(CloudDiagnosticsCatalog.CloudDiagnosticsCatalog)({
  environmentInfo: () =>
    Effect.succeed({
      environmentId: CloudEnvironmentId.make("environment-web"),
      environmentJsonPath: ".cursor/environment.json",
      name: "Web",
    }),
  proposeEnvironmentJson: () => Effect.succeed({ proposed: true as const, buildId: "bld-1" }),
  requestSetupActions: (input) => Effect.succeed({ accepted: input.actions.length }),
  outstandingSetupActions: Effect.succeed([]),
  resolveSetupActions: Effect.void,
  readProposal: () => Effect.succeed(undefined),
  fleetDiagnostics: () => Effect.succeed({ allocations: [] }),
  usageForRun: () => Effect.succeed([]),
  runEvents: () => Effect.succeed({ events: [] }),
});

const dependencies = CatalogLive;

describe("cloud diagnostics MCP toolkit", () => {
  it("publishes fleet diagnostics with an object input schema", () => {
    expect(Tool.getJsonSchema(CloudDiagnosticsToolkit.tools["fleet-diagnostics"])).toEqual({
      type: "object",
      additionalProperties: false,
    });
  });

  it.effect("serves environment-info and the Cursor-prefixed alias", () =>
    Effect.gen(function* () {
      const tools = yield* CloudDiagnosticsToolkit;
      const call = <Name extends keyof typeof CloudDiagnosticsToolkit.tools>(
        name: Name,
        params: Parameters<typeof tools.handle<Name>>[1],
        capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
      ) =>
        tools.handle(name, params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map(
            (chunk) =>
              chunk.at(-1)!.result as Tool.Success<(typeof CloudDiagnosticsToolkit.tools)[Name]>,
          ),
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(capabilities),
          ),
          Effect.provide(dependencies),
        );
      const info = yield* call("environment-info", {}, ["cloud-diagnostics"]);
      const aliased = yield* call("cursor-cloud-environment-info", {}, ["cloud-diagnostics"]);
      expect(info).toMatchObject({ environmentJsonPath: ".cursor/environment.json" });
      expect(aliased).toMatchObject({ environmentId: "environment-web" });
      const proposed = yield* call(
        "cursor-cloud-propose-environment-json",
        { environmentJson: { image: "node:24" }, buildId: "bld-1" },
        ["cloud-diagnostics"],
      );
      expect(proposed).toMatchObject({ proposed: true, buildId: "bld-1" });
    }).pipe(Effect.provide(CloudDiagnosticsToolkitHandlersLive.pipe(Layer.provide(dependencies)))),
  );

  it.effect("withholds fleet diagnostics without the fleet capability", () =>
    Effect.gen(function* () {
      const tools = yield* CloudDiagnosticsToolkit;
      const error = yield* tools
        .handle("fleet-diagnostics", {})
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(["cloud-diagnostics"]),
          ),
          Effect.provide(dependencies),
          Effect.flip,
        );
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "cloud-fleet",
      });
    }).pipe(Effect.provide(CloudDiagnosticsToolkitHandlersLive.pipe(Layer.provide(dependencies)))),
  );
});
