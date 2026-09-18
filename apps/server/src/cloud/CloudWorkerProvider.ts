import { RunAllocationAttempt, RunAllocationId, RunLaunchTemplate } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const AwsInstanceState = Schema.Literals([
  "pending",
  "running",
  "shutting-down",
  "terminated",
  "stopping",
  "stopped",
]);
export type AwsInstanceState = typeof AwsInstanceState.Type;

export const CloudWorkerInstance = Schema.Struct({
  instanceId: Schema.String,
  state: AwsInstanceState,
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
      readonly expiresAt: string;
      readonly instanceType: string;
      readonly maxInputWaitSeconds: number;
      readonly launchTemplate: RunLaunchTemplate;
      readonly registrationCredential: string;
    }) => Effect.Effect<CloudWorkerInstance, CloudWorkerProviderError>;
    readonly revokeRegistrationCredential: (
      instanceId: string,
    ) => Effect.Effect<void, CloudWorkerProviderError>;
    readonly terminate: (instanceId: string) => Effect.Effect<void, CloudWorkerProviderError>;
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
const decodeLaunchTemplatesResponse = Schema.decodeEffect(
  Schema.fromJsonString(LaunchTemplatesResponse),
);
const decodeInstancesResponse = Schema.decodeEffect(Schema.fromJsonString(InstancesResponse));
const decodeRunInstancesResponse = Schema.decodeEffect(Schema.fromJsonString(RunInstancesResponse));
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
    /InsufficientInstanceCapacity|InstanceLimitExceeded|RequestLimitExceeded|Throttl|ServiceUnavailable|InternalError|RequestTimeout|timed out/i.test(
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
}) {
  const runner = yield* ProcessRunner.ProcessRunner;

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

  const findAttemptResources: CloudWorkerProvider["Service"]["findAttemptResources"] = (attempt) =>
    Effect.gen(function* () {
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
      return response.Reservations.flatMap((reservation) => reservation.Instances).map(
        resourceFromInstance,
      );
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
      const tags = [
        { Key: "CloudAgentProject", Value: input.project },
        { Key: "CloudAgentRole", Value: "worker" },
        { Key: "CloudAgentAllocationId", Value: launchInput.allocationId },
        { Key: "CloudAgentAttempt", Value: String(launchInput.attempt) },
        { Key: "CloudAgentExpiresAtEpoch", Value: String(Math.floor(expiresAtMillis / 1000)) },
        { Key: "CloudAgentMaxInputWaitSeconds", Value: String(launchInput.maxInputWaitSeconds) },
        { Key: "CloudAgentControllerUrl", Value: controllerUrl },
        { Key: "CloudAgentWorkerRouteUrl", Value: workerRouteUrl },
        { Key: "CloudAgentRegistrationCredential", Value: launchInput.registrationCredential },
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
      return { instanceId: instance.InstanceId, state: instance.State.Name };
    });

  const terminate: CloudWorkerProvider["Service"]["terminate"] = (instanceId) =>
    runAws(["terminate-instances", "--instance-ids", instanceId]).pipe(
      Effect.catchIf(
        (error) => /InvalidInstanceID\.NotFound/.test(error.message),
        () => Effect.void,
      ),
      Effect.asVoid,
    );

  const revokeRegistrationCredential: CloudWorkerProvider["Service"]["revokeRegistrationCredential"] =
    (instanceId) =>
      runAws([
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

  return CloudWorkerProvider.of({
    resolveLaunchTemplate,
    findAttemptResources,
    listWorkers,
    launch,
    revokeRegistrationCredential,
    terminate,
  });
});

const AwsWorkerConfig = Config.all({
  region: Config.string("T3CODE_CLOUD_AWS_REGION").pipe(Config.withDefault("us-west-1")),
  project: Config.string("T3CODE_CLOUD_PROJECT").pipe(Config.withDefault("t3-cloud-agents")),
  controllerUrl: Config.string("T3CODE_CLOUD_CONTROLLER_URL").pipe(Config.option),
  workerRouteUrl: Config.string("T3CODE_CLOUD_WORKER_ROUTE_URL").pipe(Config.option),
});

export const layer = Layer.effect(
  CloudWorkerProvider,
  Effect.flatMap(AwsWorkerConfig, (config) =>
    make({
      region: config.region,
      project: config.project,
      ...(Option.isSome(config.controllerUrl) ? { controllerUrl: config.controllerUrl.value } : {}),
      ...(Option.isSome(config.workerRouteUrl)
        ? { workerRouteUrl: config.workerRouteUrl.value }
        : {}),
    }),
  ),
);
