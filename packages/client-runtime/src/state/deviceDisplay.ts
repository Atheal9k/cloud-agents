import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";
import type { Atom } from "effect/unstable/reactivity";

export function createDeviceDisplayAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    issue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device-display:issue",
      tag: WS_METHODS.deviceDisplayIssue,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
      execute: (input) => request(WS_METHODS.deviceDisplayIssue, input),
    }),
    keepAlive: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device-display:keep-alive",
      tag: WS_METHODS.deviceDisplayKeepAlive,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.viewerId}`,
      },
      execute: (input) => request(WS_METHODS.deviceDisplayKeepAlive, input),
    }),
    takeControl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device-display:take-control",
      tag: WS_METHODS.deviceDisplayTakeControl,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.viewerId}`,
      },
      execute: (input) => request(WS_METHODS.deviceDisplayTakeControl, input),
    }),
    returnControl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device-display:return-control",
      tag: WS_METHODS.deviceDisplayReturnControl,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.viewerId}`,
      },
      execute: (input) => request(WS_METHODS.deviceDisplayReturnControl, input),
    }),
    release: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device-display:release",
      tag: WS_METHODS.deviceDisplayRelease,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.viewerId}`,
      },
      execute: (input) => request(WS_METHODS.deviceDisplayRelease, input),
    }),
  };
}
