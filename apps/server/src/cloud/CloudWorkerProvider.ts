import { RunAllocationAttempt, RunAllocationId, RunLaunchTemplate } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { createFirecrackerFleetStore } from "./firecrackerFleet.ts";
import { type CloudHypervisorHost, runtimeParity } from "./firecrackerPlacement.ts";

const AwsInstanceState = Schema.Literals([
  "pending",
  "running",
  "shutting-down",
  "terminated",
  "stopping",
  "stopped",
]);
export type AwsInstanceState = typeof AwsInstanceState.Type;

export const CloudRuntimeKind = Schema.Literals(["firecracker", "ec2-fallback"]);
export type CloudRuntimeKind = typeof CloudRuntimeKind.Type;

export const CloudWorkerInstance = Schema.Struct({
  instanceId: Schema.String,
  state: AwsInstanceState,
  runtimeKind: Schema.optionalKey(CloudRuntimeKind),
});
export type CloudWorkerInstance = typeof CloudWorkerInstance.Type;

export const CloudWorkerIdentity = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("matched"),
    allocationId: RunAllocationId,
    attempt: RunAllocationAttempt,
  }),
  Schema.Struct({ status: Schema.Literal("unmatched") }),
]);
export type CloudWorkerIdentity = typeof CloudWorkerIdentity.Type;

export const CloudWorkerResource = Schema.Struct({
  instanceId: Schema.String,
  state: AwsInstanceState,
  identity: CloudWorkerIdentity,
  registrationCredentialPresent: Schema.Boolean,
});
export type CloudWorkerResource = typeof CloudWorkerResource.Type;

export class CloudWorkerProviderError extends Schema.TaggedError<CloudWorkerProviderError>()(
  "CloudWorkerProviderError",
  {
    reason: Schema.Literals(["retryable", "invalid-config", "fatal"]),
    message: Schema.String,
  },
) {}

export class CloudWorkerProvider extends Context.Service<
  CloudWorkerProvider,
  {
    readonly resolveLaunchTemplate: (
      profileId: string,
    ) => Effect.Effect<RunLaunchTemplate, CloudWorkerProviderError>;
    readonly findAttemptResources: (input: {
      readonly allocationId: RunAllocationId;
      readonly attempt: RunAllocationAttempt;
    }) => Effect.Effect<ReadonlyArray<CloudWorkerResource>, CloudWorkerProviderError>;
    readonly listWorkers: () => Effect.Effect<
      ReadonlyArray<CloudWorkerResource>,
      CloudWorkerProviderError
    >;
    readonly launch: (input: {
      readonly allocationId: RunAllocationId;
      readonly attempt: RunAllocationAttempt;
      readonly repository: string;
      readonly selectedRef: string;
      readonly outputBranch: string;
      readonly expiresAt: string;
      readonly instanceType: string;
      readonly maxInputWaitSeconds: number;
      readonly launchTemplate: RunLaunchTemplate;
      readonly registrationCredential: string;
      readonly placementHostId?: string | undefined;
    }) => Effect.Effect<CloudWorkerInstance, CloudWorkerProviderError>;
    readonly inspectMacCapacity: (input: { readonly instanceType: string }) => Effect.Effect<
      {
        readonly region: string;
        readonly instanceType: string;
        readonly appleSilicon: boolean;
        readonly dedicatedHostQuota: { readonly used: number; readonly limit: number };
        readonly availableHostIds: ReadonlyArray<string>;
        readonly availabilityZones: ReadonlyArray<string>;
      },
      CloudWorkerProviderError
    >;
    readonly allocateDedicatedHost: (input: {
      readonly instanceType: string;
      readonly availabilityZone: string;
    }) => Effect.Effect<{ readonly hostId: string }, CloudWorkerProviderError>;
    readonly releaseDedicatedHost: (
      hostId: string,
    ) => Effect.Effect<void, CloudWorkerProviderError>;
    readonly revokeRegistrationCredential: (
      instanceId: string,
    ) => Effect.Effect<void, CloudWorkerProviderError>;
    /**
     * Stops the guest with its disk intact and marks it so neither the
     * controller's own sweep nor the AWS backstop reads a stopped snapshot as
     * an expired worker.
     */
    readonly hibernate: (instanceId: string) => Effect.Effect<void, CloudWorkerProviderError>;
    /**
     * Starts a hibernated guest back up for a new attempt. The tags carry the
     * attempt, route, and registration credential the guest reads at boot, so
     * re-tagging before the start is what makes it register as the new runtime.
     */
    readonly restore: (input: {
      readonly instanceId: string;
      readonly allocationId: RunAllocationId;
      readonly attempt: RunAllocationAttempt;
      readonly selectedRef: string;
      readonly outputBranch: string;
      readonly expiresAt: string;
      readonly maxInputWaitSeconds: number;
      readonly registrationCredential: string;
    }) => Effect.Effect<CloudWorkerInstance, CloudWorkerProviderError>;
    readonly terminate: (instanceId: string) => Effect.Effect<void, CloudWorkerProviderError>;
    readonly runtimeKind: CloudRuntimeKind;
  }
>()("t3/cloud/CloudWorkerProvider") {}

const LaunchTemplatesResponse = Schema.Struct({
  LaunchTemplates: Schema.Array(
    Schema.Struct({
      LaunchTemplateId: Schema.String,
      DefaultVersionNumber: Schema.Finite,
    }),
  ),
});

const AwsInstanceBase = {
  InstanceId: Schema.String,
  State: Schema.Struct({ Name: AwsInstanceState }),
};
const AwsInstance = Schema.Struct(AwsInstanceBase);
const AwsListedInstance = Schema.Struct({
  ...AwsInstanceBase,
  Tags: Schema.optionalKey(
    Schema.Array(Schema.Struct({ Key: Schema.String, Value: Schema.String })),
  ),
});
const InstancesResponse = Schema.Struct({
  Reservations: Schema.Array(Schema.Struct({ Instances: Schema.Array(AwsListedInstance) })),
});
const RunInstancesResponse = Schema.Struct({ Instances: Schema.Array(AwsInstance) });
const StartInstancesResponse = Schema.Struct({
  StartingInstances: Schema.Array(
    Schema.Struct({
      InstanceId: Schema.String,
      CurrentState: Schema.Struct({ Name: AwsInstanceState }),
    }),
  ),
});
const decodeLaunchTemplatesResponse = Schema.decodeEffect(
  Schema.fromJsonString(LaunchTemplatesResponse),
);
const decodeInstancesResponse = Schema.decodeEffect(Schema.fromJsonString(InstancesResponse));
const decodeRunInstancesResponse = Schema.decodeEffect(Schema.fromJsonString(RunInstancesResponse));
const decodeStartInstancesResponse = Schema.decodeEffect(
  Schema.fromJsonString(StartInstancesResponse),
);
const AllocateHostsResponse = Schema.Struct({
  HostIds: Schema.Array(Schema.String),
});
const DescribeHostsResponse = Schema.Struct({
  Hosts: Schema.Array(
    Schema.Struct({
      HostId: Schema.String,
      State: Schema.optionalKey(Schema.String),
      AvailabilityZone: Schema.optionalKey(Schema.String),
      HostProperties: Schema.optionalKey(
        Schema.Struct({
          InstanceType: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});
const InstanceTypeOfferingsResponse = Schema.Struct({
  InstanceTypeOfferings: Schema.Array(
    Schema.Struct({
      InstanceType: Schema.String,
      Location: Schema.String,
    }),
  ),
});
const decodeAllocateHostsResponse = Schema.decodeEffect(
  Schema.fromJsonString(AllocateHostsResponse),
);
const decodeDescribeHostsResponse = Schema.decodeEffect(
  Schema.fromJsonString(DescribeHostsResponse),
);
const decodeInstanceTypeOfferingsResponse = Schema.decodeEffect(
  Schema.fromJsonString(InstanceTypeOfferingsResponse),
);
const decodeLaunchTemplate = Schema.decodeEffect(RunLaunchTemplate);
const decodeAllocationId = Schema.decodeUnknownOption(RunAllocationId);
const decodeAttempt = Schema.decodeUnknownOption(RunAllocationAttempt);
const encodeTagSpecifications = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        ResourceType: Schema.Literals(["instance", "volume"]),
        Tags: Schema.Array(Schema.Struct({ Key: Schema.String, Value: Schema.String })),
      }),
    ),
  ),
);

function providerError(
  reason: CloudWorkerProviderError["reason"],
  message: string,
): CloudWorkerProviderError {
  return new CloudWorkerProviderError({ reason, message });
}

function normalizeHttpsOrigin(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname === "::" ||
      hostname.startsWith("127.")
    ) {
      return null;
    }
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function classifyAwsFailure(stderr: string): CloudWorkerProviderError {
  const message = stderr.trim() || "The AWS CLI command failed without an error message.";
  const retryable =
    /InsufficientInstanceCapacity|InstanceLimitExceeded|HostLimitExceeded|DedicatedHostLimitExceeded|RequestLimitExceeded|Throttl|ServiceUnavailable|InternalError|RequestTimeout|timed out/i.test(
      message,
    );
  return providerError(retryable ? "retryable" : "fatal", message);
}

function clientToken(input: {
  readonly allocationId: RunAllocationId;
  readonly attempt: RunAllocationAttempt;
}): string {
  return `t3-${NodeCrypto.createHash("sha256")
    .update(`${input.allocationId}:${input.attempt}`)
    .digest("hex")
    .slice(0, 61)}`;
}

function workerHostname(input: {
  readonly allocationId: RunAllocationId;
  readonly attempt: RunAllocationAttempt;
}): string {
  const suffix = NodeCrypto.createHash("sha256")
    .update(`${input.allocationId}:${input.attempt}`)
    .digest("hex")
    .slice(0, 16);
  return `t3-worker-${suffix}`;
}

function resourceFromInstance(instance: typeof AwsListedInstance.Type): CloudWorkerResource {
  const tags = new Map((instance.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
  const allocationId = decodeAllocationId(tags.get("CloudAgentAllocationId"));
  const attempt = decodeAttempt(Number(tags.get("CloudAgentAttempt")));
  const identity =
    Option.isSome(allocationId) && Option.isSome(attempt)
      ? {
          status: "matched" as const,
          allocationId: allocationId.value,
          attempt: attempt.value,
        }
      : { status: "unmatched" as const };
  return {
    instanceId: instance.InstanceId,
    state: instance.State.Name,
    identity,
    registrationCredentialPresent: tags.has("CloudAgentRegistrationCredential"),
  };
}

export const make = Effect.fn("CloudWorkerProvider.make")(function* (input: {
  readonly region: string;
  readonly project: string;
  readonly controllerUrl?: string;
  readonly workerRouteUrl?: string;
  readonly runtimeKind?: CloudRuntimeKind;
  readonly hypervisors?: ReadonlyArray<CloudHypervisorHost>;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const runtimeKind: CloudRuntimeKind =
    input.runtimeKind ??
    (input.hypervisors !== undefined && input.hypervisors.length > 0
      ? "firecracker"
      : "ec2-fallback");
  const fleet =
    runtimeKind === "firecracker"
      ? createFirecrackerFleetStore(input.hypervisors ?? [])
      : undefined;
  const isFleetGuest = (instanceId: string) =>
    fleet?.guests().some((bound) => bound.guest.guestId === instanceId) ?? false;

  const runAws = Effect.fn("CloudWorkerProvider.runAws")(function* (args: ReadonlyArray<string>) {
    const result = yield* runner
      .run({
        command: "aws",
        args: ["ec2", ...args, "--region", input.region, "--output", "json", "--no-cli-pager"],
        timeout: "30 seconds",
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(
        Effect.mapError(() =>
          providerError("fatal", "The AWS CLI could not be started by the cloud controller."),
        ),
      );
    if (result.code !== 0) return yield* classifyAwsFailure(result.stderr);
    return result.stdout;
  });

  const resolveLaunchTemplate: CloudWorkerProvider["Service"]["resolveLaunchTemplate"] = (
    profileId,
  ) =>
    Effect.gen(function* () {
      if (fleet !== undefined) {
        const host = fleet.hosts().find((candidate) => candidate.profiles.includes(profileId));
        if (host !== undefined) {
          return yield* decodeLaunchTemplate({ id: `fc-${profileId}`, version: 1 }).pipe(
            Effect.mapError(() =>
              providerError(
                "invalid-config",
                `Worker profile '${profileId}' has an invalid Firecracker launch template.`,
              ),
            ),
          );
        }
      }
      const output = yield* runAws([
        "describe-launch-templates",
        "--filters",
        `Name=tag:CloudAgentProject,Values=${input.project}`,
        `Name=tag:CloudAgentProfile,Values=${profileId}`,
      ]);
      const response = yield* decodeLaunchTemplatesResponse(output).pipe(
        Effect.mapError(() =>
          providerError("fatal", "The AWS CLI returned an unexpected response."),
        ),
      );
      if (response.LaunchTemplates.length !== 1) {
        return yield* providerError(
          "invalid-config",
          `Expected one launch template for worker profile '${profileId}', found ${response.LaunchTemplates.length}.`,
        );
      }
      const template = response.LaunchTemplates[0];
      if (template === undefined || !Number.isInteger(template.DefaultVersionNumber)) {
        return yield* providerError(
          "invalid-config",
          `Worker profile '${profileId}' has no usable default launch-template version.`,
        );
      }
      return yield* decodeLaunchTemplate({
        id: template.LaunchTemplateId,
        version: template.DefaultVersionNumber,
      }).pipe(
        Effect.mapError(() =>
          providerError(
            "invalid-config",
            `Worker profile '${profileId}' has an invalid launch template.`,
          ),
        ),
      );
    });

  const findAttemptResources: CloudWorkerProvider["Service"]["findAttemptResources"] = (
    attempt,
  ) => {
    const guests = fleet?.find(attempt) ?? [];
    if (guests.length > 0) return Effect.succeed(guests);
    return Effect.gen(function* () {
      const output = yield* runAws([
        "describe-instances",
        "--filters",
        `Name=tag:CloudAgentProject,Values=${input.project}`,
        "Name=tag:CloudAgentRole,Values=worker",
        `Name=tag:CloudAgentAllocationId,Values=${attempt.allocationId}`,
        `Name=tag:CloudAgentAttempt,Values=${attempt.attempt}`,
      ]);
      const response = yield* decodeInstancesResponse(output).pipe(
        Effect.mapError(() =>
          providerError("fatal", "The AWS CLI returned an unexpected response."),
        ),
      );
      return response.Reservations.flatMap((reservation) => reservation.Instances).map(
        resourceFromInstance,
      );
    });
  };

  const listWorkers: CloudWorkerProvider["Service"]["listWorkers"] = () =>
    Effect.gen(function* () {
      const output = yield* runAws([
        "describe-instances",
        "--filters",
        `Name=tag:CloudAgentProject,Values=${input.project}`,
        "Name=tag:CloudAgentRole,Values=worker",
        "Name=tag:Ephemeral,Values=true",
        "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped",
      ]);
      const response = yield* decodeInstancesResponse(output).pipe(
        Effect.mapError(() =>
          providerError("fatal", "The AWS CLI returned an unexpected response."),
        ),
      );
      const instances = response.Reservations.flatMap((reservation) => reservation.Instances).map(
        resourceFromInstance,
      );
      return [...(fleet?.list() ?? []), ...instances];
    });

  const launch: CloudWorkerProvider["Service"]["launch"] = (launchInput) =>
    Effect.gen(function* () {
      const controllerUrl = normalizeHttpsOrigin(input.controllerUrl);
      const workerRouteUrl = normalizeHttpsOrigin(
        input.workerRouteUrl?.replaceAll("{workerHostname}", workerHostname(launchInput)),
      );
      if (controllerUrl === null || workerRouteUrl === null) {
        return yield* providerError(
          "invalid-config",
          "Cloud worker routing requires valid HTTPS T3CODE_CLOUD_CONTROLLER_URL and T3CODE_CLOUD_WORKER_ROUTE_URL values.",
        );
      }
      const expiresAtMillis = Date.parse(launchInput.expiresAt);
      if (!Number.isFinite(expiresAtMillis)) {
        return yield* providerError(
          "invalid-config",
          "The worker expiry is not a valid timestamp.",
        );
      }
      if (
        launchInput.repository.length > 256 ||
        launchInput.selectedRef.length > 256 ||
        launchInput.outputBranch.length > 256
      ) {
        return yield* providerError(
          "invalid-config",
          "Cloud repository, ref, and output branch values must fit in EC2 instance tags.",
        );
      }
      if (
        fleet !== undefined &&
        launchInput.placementHostId === undefined &&
        launchInput.launchTemplate.id.startsWith("fc-")
      ) {
        const placed = fleet.place({
          allocationId: launchInput.allocationId,
          attempt: launchInput.attempt,
          profileId: launchInput.launchTemplate.id.replace(/^fc-/, ""),
          agentId: `agent:${launchInput.allocationId}`,
        });
        if ("status" in placed) {
          return yield* providerError("retryable", placed.reason);
        }
        return {
          instanceId: placed.guest.guestId,
          state: placed.state,
          runtimeKind: "firecracker" as const,
        };
      }
      const tags = [
        { Key: "CloudAgentProject", Value: input.project },
        { Key: "CloudAgentRole", Value: "worker" },
        { Key: "CloudAgentAllocationId", Value: launchInput.allocationId },
        { Key: "CloudAgentAttempt", Value: String(launchInput.attempt) },
        { Key: "CloudAgentExpiresAtEpoch", Value: String(Math.floor(expiresAtMillis / 1000)) },
        { Key: "CloudAgentMaxInputWaitSeconds", Value: String(launchInput.maxInputWaitSeconds) },
        { Key: "CloudAgentRepository", Value: launchInput.repository },
        { Key: "CloudAgentSelectedRef", Value: launchInput.selectedRef },
        { Key: "CloudAgentOutputBranch", Value: launchInput.outputBranch },
        { Key: "CloudAgentControllerUrl", Value: controllerUrl },
        { Key: "CloudAgentWorkerRouteUrl", Value: workerRouteUrl },
        { Key: "CloudAgentRegistrationCredential", Value: launchInput.registrationCredential },
        ...(launchInput.placementHostId === undefined
          ? []
          : [
              { Key: "CloudAgentLifecycle", Value: "dedicated-host" },
              { Key: "CloudAgentDedicatedHost", Value: launchInput.placementHostId },
            ]),
        { Key: "CloudAgentRuntimeKind", Value: "ec2-fallback" },
        ...(launchInput.placementHostId === undefined
          ? [{ Key: "CloudAgentRuntimeParity", Value: runtimeParity("ec2-fallback") }]
          : []),
      ];
      const output = yield* runAws([
        "run-instances",
        "--launch-template",
        `LaunchTemplateId=${launchInput.launchTemplate.id},Version=${launchInput.launchTemplate.version}`,
        "--instance-type",
        launchInput.instanceType,
        "--count",
        "1",
        "--client-token",
        clientToken(launchInput),
        ...(launchInput.placementHostId === undefined
          ? []
          : ["--placement", `Tenancy=host,HostId=${launchInput.placementHostId}`]),
        "--tag-specifications",
        encodeTagSpecifications([
          { ResourceType: "instance", Tags: tags },
          { ResourceType: "volume", Tags: tags },
        ]),
      ]);
      const response = yield* decodeRunInstancesResponse(output).pipe(
        Effect.mapError(() =>
          providerError("fatal", "The AWS CLI returned an unexpected response."),
        ),
      );
      const instance = response.Instances[0];
      if (instance === undefined) {
        return yield* providerError("fatal", "AWS accepted the launch but returned no instance.");
      }
      return {
        instanceId: instance.InstanceId,
        state: instance.State.Name,
        runtimeKind: "ec2-fallback" as const,
      };
    });

  const hibernate: CloudWorkerProvider["Service"]["hibernate"] = (instanceId) =>
    fleet !== undefined && isFleetGuest(instanceId)
      ? Effect.gen(function* () {
          if (!fleet.hibernate(instanceId)) {
            return yield* providerError(
              "fatal",
              "The guest to hibernate no longer exists, so its disk cannot be kept.",
            );
          }
        })
      : Effect.gen(function* () {
          // Tag first. A stopped instance without this tag looks abandoned to the
          // cleanup backstop, so the tag has to exist before the stop does.
          yield* runAws([
            "create-tags",
            "--resources",
            instanceId,
            "--tags",
            "Key=CloudAgentHibernated,Value=true",
          ]);
          yield* runAws(["stop-instances", "--instance-ids", instanceId]);
        }).pipe(
          Effect.catchIf(
            (error) => /InvalidInstanceID\.NotFound/.test(error.message),
            () =>
              providerError(
                "fatal",
                "The guest to hibernate no longer exists, so its disk cannot be kept.",
              ),
          ),
          Effect.asVoid,
        );

  const restore: CloudWorkerProvider["Service"]["restore"] = (restoreInput) =>
    Effect.gen(function* () {
      const workerRouteUrl = normalizeHttpsOrigin(
        input.workerRouteUrl?.replaceAll("{workerHostname}", workerHostname(restoreInput)),
      );
      if (workerRouteUrl === null) {
        return yield* providerError(
          "invalid-config",
          "Cloud worker routing requires a valid HTTPS T3CODE_CLOUD_WORKER_ROUTE_URL value.",
        );
      }
      const expiresAtMillis = Date.parse(restoreInput.expiresAt);
      if (!Number.isFinite(expiresAtMillis)) {
        return yield* providerError(
          "invalid-config",
          "The worker expiry is not a valid timestamp.",
        );
      }
      if (fleet !== undefined && isFleetGuest(restoreInput.instanceId)) {
        const restored = fleet.restore({
          guestId: restoreInput.instanceId,
          allocationId: restoreInput.allocationId,
          attempt: restoreInput.attempt,
        });
        if (restored === undefined) {
          return yield* providerError(
            "fatal",
            "The hibernated Firecracker snapshot is no longer on the fleet.",
          );
        }
        return { ...restored, runtimeKind: "firecracker" as const };
      }
      yield* runAws([
        "create-tags",
        "--resources",
        restoreInput.instanceId,
        "--tags",
        `Key=CloudAgentAttempt,Value=${restoreInput.attempt}`,
        `Key=CloudAgentExpiresAtEpoch,Value=${Math.floor(expiresAtMillis / 1000)}`,
        `Key=CloudAgentMaxInputWaitSeconds,Value=${restoreInput.maxInputWaitSeconds}`,
        `Key=CloudAgentSelectedRef,Value=${restoreInput.selectedRef}`,
        `Key=CloudAgentOutputBranch,Value=${restoreInput.outputBranch}`,
        `Key=CloudAgentWorkerRouteUrl,Value=${workerRouteUrl}`,
        `Key=CloudAgentRegistrationCredential,Value=${restoreInput.registrationCredential}`,
      ]);
      yield* runAws([
        "delete-tags",
        "--resources",
        restoreInput.instanceId,
        "--tags",
        "Key=CloudAgentHibernated",
      ]);
      const output = yield* runAws(["start-instances", "--instance-ids", restoreInput.instanceId]);
      const response = yield* decodeStartInstancesResponse(output).pipe(
        Effect.mapError(() =>
          providerError("fatal", "The AWS CLI returned an unexpected response."),
        ),
      );
      const instance = response.StartingInstances[0];
      if (instance === undefined) {
        return yield* providerError("fatal", "AWS accepted the start but returned no instance.");
      }
      return {
        instanceId: instance.InstanceId,
        state: instance.CurrentState.Name,
        runtimeKind: "ec2-fallback" as const,
      };
    });

  const terminate: CloudWorkerProvider["Service"]["terminate"] = (instanceId) =>
    fleet !== undefined && isFleetGuest(instanceId)
      ? Effect.sync(() => {
          fleet.terminate(instanceId);
        })
      : runAws(["terminate-instances", "--instance-ids", instanceId]).pipe(
          Effect.catchIf(
            (error) => /InvalidInstanceID\.NotFound/.test(error.message),
            () => Effect.void,
          ),
          Effect.asVoid,
        );

  const revokeRegistrationCredential: CloudWorkerProvider["Service"]["revokeRegistrationCredential"] =
    (instanceId) =>
      fleet !== undefined && isFleetGuest(instanceId)
        ? Effect.sync(() => {
            fleet.revoke(instanceId);
          })
        : runAws([
            "delete-tags",
            "--resources",
            instanceId,
            "--tags",
            "Key=CloudAgentRegistrationCredential",
          ]).pipe(
            Effect.catchIf(
              (error) => /InvalidInstanceID\.NotFound/.test(error.message),
              () => Effect.void,
            ),
            Effect.asVoid,
          );

  const inspectMacCapacity: CloudWorkerProvider["Service"]["inspectMacCapacity"] = (
    capacityInput,
  ) =>
    Effect.gen(function* () {
      const offeringsOutput = yield* runAws([
        "describe-instance-type-offerings",
        "--location-type",
        "availability-zone",
        "--filters",
        `Name=instance-type,Values=${capacityInput.instanceType}`,
      ]);
      const offerings = yield* decodeInstanceTypeOfferingsResponse(offeringsOutput).pipe(
        Effect.mapError(() =>
          providerError("fatal", "The AWS CLI returned an unexpected Mac offering response."),
        ),
      );
      const hostsOutput = yield* runAws([
        "describe-hosts",
        "--filter",
        `Name=instance-type,Values=${capacityInput.instanceType}`,
      ]);
      const hosts = yield* decodeDescribeHostsResponse(hostsOutput).pipe(
        Effect.mapError(() =>
          providerError("fatal", "The AWS CLI returned an unexpected Dedicated Host response."),
        ),
      );
      const availableHostIds = hosts.Hosts.filter(
        (host) => (host.State ?? "").toLowerCase() === "available",
      ).map((host) => host.HostId);
      const availabilityZones = [
        ...new Set(offerings.InstanceTypeOfferings.map((offering) => offering.Location)),
      ];
      return {
        region: input.region,
        instanceType: capacityInput.instanceType,
        appleSilicon: capacityInput.instanceType.startsWith("mac2"),
        dedicatedHostQuota: {
          used: hosts.Hosts.length,
          limit: Math.max(hosts.Hosts.length + (availableHostIds.length > 0 ? 0 : 1), 1),
        },
        availableHostIds,
        availabilityZones,
      };
    });

  const allocateDedicatedHost: CloudWorkerProvider["Service"]["allocateDedicatedHost"] = (
    allocateInput,
  ) =>
    Effect.gen(function* () {
      const output = yield* runAws([
        "allocate-hosts",
        "--instance-type",
        allocateInput.instanceType,
        "--availability-zone",
        allocateInput.availabilityZone,
        "--quantity",
        "1",
        "--auto-placement",
        "on",
      ]);
      const response = yield* decodeAllocateHostsResponse(output).pipe(
        Effect.mapError(() =>
          providerError("fatal", "The AWS CLI returned an unexpected AllocateHosts response."),
        ),
      );
      const hostId = response.HostIds[0];
      if (hostId === undefined) {
        return yield* providerError("fatal", "AWS accepted the Dedicated Host but returned no id.");
      }
      return { hostId };
    });

  const releaseDedicatedHost: CloudWorkerProvider["Service"]["releaseDedicatedHost"] = (hostId) =>
    runAws(["release-hosts", "--host-ids", hostId]).pipe(
      Effect.catchIf(
        (error) => /InvalidHostID\.NotFound/.test(error.message),
        () => Effect.void,
      ),
      Effect.asVoid,
    );

  return CloudWorkerProvider.of({
    resolveLaunchTemplate,
    findAttemptResources,
    listWorkers,
    launch,
    inspectMacCapacity,
    allocateDedicatedHost,
    releaseDedicatedHost,
    revokeRegistrationCredential,
    hibernate,
    restore,
    terminate,
    runtimeKind,
  });
});

const HypervisorHostConfig = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  cpuMillis: Schema.Int,
  memoryMib: Schema.Int,
  diskGib: Schema.Int,
  cpuOversubscribeRatio: Schema.Finite,
  profiles: Schema.Array(Schema.String),
  credentialsPath: Schema.String,
  kvm: Schema.Boolean,
});
const decodeRuntimeKind = Schema.decodeUnknownEffect(CloudRuntimeKind);
const decodeHypervisorFleet = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(HypervisorHostConfig)),
);

const AwsWorkerConfig = Config.all({
  region: Config.string("T3CODE_CLOUD_AWS_REGION").pipe(Config.withDefault("us-west-1")),
  project: Config.string("T3CODE_CLOUD_PROJECT").pipe(Config.withDefault("t3-cloud-agents")),
  controllerUrl: Config.string("T3CODE_CLOUD_CONTROLLER_URL").pipe(Config.option),
  workerRouteUrl: Config.string("T3CODE_CLOUD_WORKER_ROUTE_URL").pipe(Config.option),
  runtimeKind: Config.string("T3CODE_CLOUD_RUNTIME").pipe(Config.option),
  hypervisorFleet: Config.string("T3CODE_CLOUD_HYPERVISOR_FLEET").pipe(Config.option),
});

export const layer = Layer.effect(
  CloudWorkerProvider,
  Effect.gen(function* () {
    const config = yield* AwsWorkerConfig;
    const runtimeKind = Option.isSome(config.runtimeKind)
      ? yield* decodeRuntimeKind(config.runtimeKind.value).pipe(
          Effect.mapError(() =>
            providerError(
              "invalid-config",
              "T3CODE_CLOUD_RUNTIME must be firecracker or ec2-fallback.",
            ),
          ),
        )
      : undefined;
    const hypervisors = Option.isSome(config.hypervisorFleet)
      ? yield* decodeHypervisorFleet(config.hypervisorFleet.value).pipe(
          Effect.mapError(() =>
            providerError(
              "invalid-config",
              "T3CODE_CLOUD_HYPERVISOR_FLEET must be a JSON array of hypervisor hosts.",
            ),
          ),
        )
      : undefined;
    return yield* make({
      region: config.region,
      project: config.project,
      ...(Option.isSome(config.controllerUrl) ? { controllerUrl: config.controllerUrl.value } : {}),
      ...(Option.isSome(config.workerRouteUrl)
        ? { workerRouteUrl: config.workerRouteUrl.value }
        : {}),
      ...(runtimeKind === undefined ? {} : { runtimeKind }),
      ...(hypervisors === undefined ? {} : { hypervisors }),
    });
  }),
);
