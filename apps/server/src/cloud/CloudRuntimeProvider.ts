import type {
  CloudAgentId,
  CloudEnvironmentBuildId,
  CloudEnvironmentId,
  CloudManagedRuntime,
  CloudRunId,
  RunAllocationAttempt,
  RunAllocationId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class CloudRuntimeProviderError extends Schema.TaggedError<CloudRuntimeProviderError>()(
  "CloudRuntimeProviderError",
  {
    reason: Schema.Literals([
      "disabled",
      "unauthenticated",
      "quota",
      "capacity",
      "not-found",
      "conflict",
      "invalid-config",
      "provider-outage",
      "fatal",
    ]),
    message: Schema.String,
  },
) {}

export type CloudRuntimeLocator =
  | { readonly kind: "id"; readonly runtimeId: string }
  | {
      readonly kind: "allocation-attempt";
      readonly allocationId: RunAllocationId;
      readonly attempt: RunAllocationAttempt;
    };

export interface CloudRuntimeCreateInput {
  readonly allocationId: RunAllocationId;
  readonly attempt: RunAllocationAttempt;
  readonly agentId: CloudAgentId;
  readonly runId: CloudRunId;
  readonly environmentId?: CloudEnvironmentId;
  readonly buildId?: CloudEnvironmentBuildId;
  readonly snapshotId?: string;
  readonly environmentVariables: Readonly<Record<string, string>>;
}

export interface CloudRuntimeProviderReadiness {
  readonly provider: "daytona";
  readonly admission: "enabled" | "disabled";
  readonly authentication: "configured" | "missing" | "invalid";
  readonly reachability: "unchecked" | "reachable" | "unreachable";
  readonly region: string;
  readonly resourceClass: string;
  readonly observedSandboxes: number;
  readonly readySandboxes: number;
  readonly detail: string;
}

export class CloudRuntimeProvider extends Context.Service<
  CloudRuntimeProvider,
  {
    readonly readiness: () => Effect.Effect<CloudRuntimeProviderReadiness>;
    readonly create: (
      input: CloudRuntimeCreateInput,
    ) => Effect.Effect<CloudManagedRuntime, CloudRuntimeProviderError>;
    readonly inspect: (
      locator: CloudRuntimeLocator,
    ) => Effect.Effect<CloudManagedRuntime | undefined, CloudRuntimeProviderError>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<CloudManagedRuntime>,
      CloudRuntimeProviderError
    >;
    readonly start: (input: {
      readonly runtimeId: string;
      readonly assignment?: CloudRuntimeCreateInput;
    }) => Effect.Effect<CloudManagedRuntime, CloudRuntimeProviderError>;
    readonly stop: (
      runtimeId: string,
    ) => Effect.Effect<CloudManagedRuntime, CloudRuntimeProviderError>;
    readonly archive: (
      runtimeId: string,
    ) => Effect.Effect<CloudManagedRuntime, CloudRuntimeProviderError>;
    readonly delete: (runtimeId: string) => Effect.Effect<void, CloudRuntimeProviderError>;
    readonly execute: (input: {
      readonly runtimeId: string;
      readonly command: string;
      readonly cwd?: string;
      readonly environment?: Readonly<Record<string, string>>;
      readonly timeoutSeconds?: number;
    }) => Effect.Effect<
      { readonly exitCode: number; readonly output: string },
      CloudRuntimeProviderError
    >;
    readonly preview: (
      input:
        | {
            readonly action: "issue";
            readonly runtimeId: string;
            readonly port: number;
            readonly expiresInSeconds: number;
          }
        | {
            readonly action: "revoke";
            readonly runtimeId: string;
            readonly port: number;
            readonly token: string;
          },
    ) => Effect.Effect<
      { readonly url: string; readonly token: string } | undefined,
      CloudRuntimeProviderError
    >;
    readonly snapshot: (input: {
      readonly runtimeId: string;
      readonly name: string;
    }) => Effect.Effect<{ readonly name: string }, CloudRuntimeProviderError>;
    readonly resourceClass: string;
  }
>()("t3/cloud/CloudRuntimeProvider") {}
