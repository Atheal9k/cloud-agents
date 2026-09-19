import {
  type CloudArtifactAccessInput,
  type CloudEnvironmentResolutionInput,
  type CloudEnvironmentRestoreInput,
  type CloudEnvironmentSaveInput,
  type RunAllocationCommand,
  WS_METHODS,
} from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { Atom } from "effect/unstable/reactivity";

export function createCloudAllocationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const snapshot = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:cloud-allocations:snapshot",
    tag: WS_METHODS.subscribeCloudAllocations,
  });
  const dispatch = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-allocations:dispatch",
    tag: WS_METHODS.cloudAllocationDispatch,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.commandId}`,
    },
    execute: (input: RunAllocationCommand) => request(WS_METHODS.cloudAllocationDispatch, input),
  });
  const saveEnvironment = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-environments:save",
    tag: WS_METHODS.cloudEnvironmentSave,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.environmentId}`,
    },
    execute: (input: CloudEnvironmentSaveInput) => request(WS_METHODS.cloudEnvironmentSave, input),
  });
  const restoreEnvironment = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-environments:restore",
    tag: WS_METHODS.cloudEnvironmentRestore,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.environmentId}`,
    },
    execute: (input: CloudEnvironmentRestoreInput) =>
      request(WS_METHODS.cloudEnvironmentRestore, input),
  });
  const resolveEnvironment = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-environments:resolve",
    tag: WS_METHODS.cloudEnvironmentResolve,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.repository}`,
    },
    execute: (input: CloudEnvironmentResolutionInput) =>
      request(WS_METHODS.cloudEnvironmentResolve, input),
  });
  const grantArtifactAccess = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-allocations:grant-artifact-access",
    tag: WS_METHODS.cloudArtifactsGrant,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.resultId}`,
    },
    execute: (input: CloudArtifactAccessInput) => request(WS_METHODS.cloudArtifactsGrant, input),
  });

  return {
    snapshot,
    dispatch,
    saveEnvironment,
    restoreEnvironment,
    resolveEnvironment,
    grantArtifactAccess,
  };
}
