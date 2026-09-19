import {
  type CloudArtifactAccessInput,
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

  return { snapshot, dispatch, grantArtifactAccess };
}
