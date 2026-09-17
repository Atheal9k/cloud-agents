import { type RunAllocationCommand, WS_METHODS } from "@t3tools/contracts";
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

  return { snapshot, dispatch };
}
