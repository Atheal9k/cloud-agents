import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";
import type { Atom } from "effect/unstable/reactivity";

export function createSharedBrowserAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    issue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared-browser:issue",
      tag: WS_METHODS.sharedBrowserIssue,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
      execute: (input) => request(WS_METHODS.sharedBrowserIssue, input),
    }),
    keepAlive: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared-browser:keep-alive",
      tag: WS_METHODS.sharedBrowserKeepAlive,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.viewerId}`,
      },
      execute: (input) => request(WS_METHODS.sharedBrowserKeepAlive, input),
    }),
    release: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared-browser:release",
      tag: WS_METHODS.sharedBrowserRelease,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.viewerId}`,
      },
      execute: (input) => request(WS_METHODS.sharedBrowserRelease, input),
    }),
  };
}
