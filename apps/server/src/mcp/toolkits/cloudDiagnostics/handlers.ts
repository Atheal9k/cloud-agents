import type { CloudEnvironmentConfig, CloudEnvironmentSetupAction } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as CloudDiagnosticsCatalog from "../../../cloud/CloudDiagnosticsCatalog.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CloudDiagnosticsToolkit } from "./tools.ts";

const requireDiagnostics = McpInvocationContext.requireMcpCapability("cloud-diagnostics");
const requireFleet = McpInvocationContext.requireMcpCapability("cloud-fleet");

const make = Effect.gen(function* () {
  const catalog = yield* CloudDiagnosticsCatalog.CloudDiagnosticsCatalog;

  const environmentInfo = (input: {
    readonly environmentId?: string | undefined;
    readonly repository?: string | undefined;
  }) => requireDiagnostics.pipe(Effect.andThen(() => catalog.environmentInfo(input)));

  const takeSnapshot = (input: {
    readonly environmentId?: string | undefined;
    readonly repository?: string | undefined;
  }) => requireDiagnostics.pipe(Effect.andThen(() => catalog.takeSnapshot(input)));

  const checkSnapshot = (input: { readonly snapshotId: string }) =>
    requireDiagnostics.pipe(Effect.andThen(() => catalog.checkSnapshot(input.snapshotId)));

  const triggerBuild = (input: {
    readonly environmentId?: string | undefined;
    readonly environmentJson?: CloudEnvironmentConfig | undefined;
    readonly refs?: unknown;
  }) =>
    requireDiagnostics.pipe(
      Effect.andThen(() =>
        Effect.gen(function* () {
          const occurredAt = DateTime.formatIso(yield* DateTime.now);
          return yield* catalog.triggerBuild({
            occurredAt,
            ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
            ...(input.environmentJson === undefined
              ? {}
              : { environmentJson: input.environmentJson }),
          });
        }),
      ),
    );

  const listBuilds = (input: {
    readonly environmentId?: string | undefined;
    readonly repository?: string | undefined;
  }) =>
    requireDiagnostics.pipe(
      Effect.andThen(() => catalog.listBuilds(input).pipe(Effect.map((builds) => ({ builds })))),
    );

  const buildLogs = (input: { readonly buildId: string }) =>
    requireDiagnostics.pipe(Effect.andThen(() => catalog.buildLogs(input)));

  const propose = (input: {
    readonly environmentJson: CloudEnvironmentConfig;
    readonly buildId?: string | undefined;
  }) =>
    requireDiagnostics.pipe(
      Effect.andThen(() =>
        catalog.proposeEnvironmentJson({
          environmentJson: input.environmentJson,
          ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
        }),
      ),
    );

  const requestActions = (input: {
    readonly actions: ReadonlyArray<CloudEnvironmentSetupAction>;
  }) => requireDiagnostics.pipe(Effect.andThen(() => catalog.requestSetupActions(input)));

  const runInfo = (input: {
    readonly runId?: string | undefined;
    readonly agentId?: string | undefined;
  }) => requireDiagnostics.pipe(Effect.andThen(() => catalog.runInfo(input)));

  const runTranscript = (input: { readonly runId: string }) =>
    requireDiagnostics.pipe(Effect.andThen(() => catalog.runTranscript(input)));

  const runEvents = (input: { readonly runId: string }) =>
    requireDiagnostics.pipe(
      Effect.andThen(() =>
        Effect.gen(function* () {
          const events = yield* catalog.runEvents(input);
          const usage = yield* catalog.usageForRun(input.runId);
          return { events: [...events.events, ...usage] };
        }),
      ),
    );

  const fleet = () =>
    requireFleet.pipe(Effect.andThen(() => catalog.fleetDiagnostics({ authorized: true })));

  return CloudDiagnosticsToolkit.of({
    "environment-info": environmentInfo,
    "take-environment-snapshot": takeSnapshot,
    "check-environment-snapshot": checkSnapshot,
    "trigger-environment-build": triggerBuild,
    "list-environment-builds": listBuilds,
    "environment-build-logs": buildLogs,
    "propose-environment-json": propose,
    "request-environment-setup-actions": requestActions,
    "run-info": runInfo,
    "run-transcript": runTranscript,
    "run-events": runEvents,
    "fleet-diagnostics": fleet,
    "cursor-cloud-environment-info": environmentInfo,
    "cursor-cloud-take-environment-snapshot": takeSnapshot,
    "cursor-cloud-check-environment-snapshot": checkSnapshot,
    "cursor-cloud-trigger-environment-build": triggerBuild,
    "cursor-cloud-list-environment-builds": listBuilds,
    "cursor-cloud-environment-build-logs": buildLogs,
    "cursor-cloud-propose-environment-json": propose,
    "cursor-cloud-request-environment-setup-actions": requestActions,
  });
});

export const CloudDiagnosticsToolkitHandlersLive = CloudDiagnosticsToolkit.toLayer(make);
