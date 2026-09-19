/**
 * The one description of the AWS stack the controller talks to.
 *
 * Both the worker provider and the readiness screen read it, so an operator
 * who changes a region or adds a hypervisor cannot end up with a settings page
 * that disagrees with the process actually launching guests.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { CloudHypervisorHost } from "./firecrackerPlacement.ts";

export const CloudRuntimeKind = Schema.Literals(["firecracker", "ec2-fallback"]);
export type CloudRuntimeKind = typeof CloudRuntimeKind.Type;

/**
 * `credentialsPath` points at the hypervisor's own credential file on the
 * controller host. It never leaves this module's consumers, and never enters a
 * client-visible report.
 */
export const HypervisorHostConfig = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  cpuMillis: Schema.Int,
  memoryMib: Schema.Int,
  diskGib: Schema.Int,
  cpuOversubscribeRatio: Schema.Finite,
  profiles: Schema.Array(Schema.String),
  credentialsPath: Schema.String,
  kvm: Schema.Boolean,
  /** Packer image tags from `hypervisor_profiles`; absent on older fleets. */
  guestImageVersion: Schema.optionalKey(Schema.String),
  hypervisorImageVersion: Schema.optionalKey(Schema.String),
});
export type HypervisorHostConfig = typeof HypervisorHostConfig.Type;

export class AwsWorkerConfigError extends Schema.TaggedError<AwsWorkerConfigError>()(
  "AwsWorkerConfigError",
  { message: Schema.String },
) {}

export interface ResolvedAwsWorkerConfig {
  readonly region: string;
  readonly project: string;
  readonly controllerUrl?: string;
  readonly workerRouteUrl?: string;
  readonly runtimeKind: CloudRuntimeKind;
  readonly hypervisors: ReadonlyArray<CloudHypervisorHost>;
  readonly controllerAccountId?: string;
  readonly executionAccountId?: string;
  /** Optional SSM document name; absent keeps the diagnostics check skipped. */
  readonly ssmDiagnosticsDocument?: string;
}

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
  controllerAccountId: Config.string("T3CODE_CLOUD_CONTROLLER_ACCOUNT_ID").pipe(Config.option),
  executionAccountId: Config.string("T3CODE_CLOUD_EXECUTION_ACCOUNT_ID").pipe(Config.option),
  ssmDiagnosticsDocument: Config.string("T3CODE_CLOUD_SSM_DIAGNOSTICS_DOCUMENT").pipe(
    Config.option,
  ),
});

/**
 * A fleet with hosts means Firecracker unless the operator says otherwise,
 * which keeps `T3CODE_CLOUD_RUNTIME` an override rather than a second switch
 * that has to be kept in sync with the fleet variable.
 */
export const resolveAwsWorkerConfig = Effect.fn("cloud.resolveAwsWorkerConfig")(function* () {
  const config = yield* AwsWorkerConfig.pipe(
    Effect.mapError(
      (error: Config.ConfigError) =>
        new AwsWorkerConfigError({
          message: `The cloud worker configuration could not be read: ${error.message}`,
        }),
    ),
  );
  const hypervisors = Option.isSome(config.hypervisorFleet)
    ? yield* decodeHypervisorFleet(config.hypervisorFleet.value).pipe(
        Effect.mapError(
          () =>
            new AwsWorkerConfigError({
              message: "T3CODE_CLOUD_HYPERVISOR_FLEET must be a JSON array of hypervisor hosts.",
            }),
        ),
      )
    : [];
  const runtimeKind = Option.isSome(config.runtimeKind)
    ? yield* decodeRuntimeKind(config.runtimeKind.value).pipe(
        Effect.mapError(
          () =>
            new AwsWorkerConfigError({
              message: "T3CODE_CLOUD_RUNTIME must be firecracker or ec2-fallback.",
            }),
        ),
      )
    : hypervisors.length > 0
      ? ("firecracker" as const)
      : ("ec2-fallback" as const);
  return {
    region: config.region,
    project: config.project,
    ...(Option.isSome(config.controllerUrl) ? { controllerUrl: config.controllerUrl.value } : {}),
    ...(Option.isSome(config.workerRouteUrl)
      ? { workerRouteUrl: config.workerRouteUrl.value }
      : {}),
    runtimeKind,
    hypervisors,
    ...(Option.isSome(config.controllerAccountId)
      ? { controllerAccountId: config.controllerAccountId.value }
      : {}),
    ...(Option.isSome(config.executionAccountId)
      ? { executionAccountId: config.executionAccountId.value }
      : {}),
    ...(Option.isSome(config.ssmDiagnosticsDocument)
      ? { ssmDiagnosticsDocument: config.ssmDiagnosticsDocument.value }
      : {}),
  } satisfies ResolvedAwsWorkerConfig;
});
