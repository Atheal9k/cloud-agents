/**
 * The one description of the AWS stack the controller talks to.
 *
 * Both the worker provider and the readiness screen read it, so an operator
 * who changes a region or adds a hypervisor cannot end up with a settings page
 * that disagrees with the process actually launching guests.
 */
import {
  CLOUD_SCM_CREDENTIAL_MAX_TTL_SECONDS,
  type CloudEgressPolicyInput,
  type CloudEncryptionPosture,
  type CloudScmAccessPolicy,
  type CloudScmScope,
  type CloudTlsVersion,
} from "@t3tools/contracts";
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

/**
 * The controller-wide security ceiling. An environment states its own egress
 * and repositories; this is what an administrator may impose on top, which is
 * why the egress half can be locked and the SCM half cannot be widened from a
 * repository file.
 */
export interface CloudControllerSecurityConfig {
  readonly egress: CloudEgressPolicyInput;
  readonly scm: CloudScmAccessPolicy;
  readonly encryption: CloudEncryptionPosture;
  readonly scmHosts: ReadonlyArray<string>;
  readonly artifactHosts: ReadonlyArray<string>;
}

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
  readonly security: CloudControllerSecurityConfig;
}

const EgressMode = Schema.Literals(["allow_all", "default_with_allowlist", "allowlist_only"]);
const ScmScope = Schema.Literals(["read", "write", "admin"]);
const TlsVersion = Schema.Literals(["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"]);

const decodeRuntimeKind = Schema.decodeUnknownEffect(CloudRuntimeKind);
const decodeEgressMode = Schema.decodeUnknownEffect(EgressMode);
const decodeScmScope = Schema.decodeUnknownEffect(ScmScope);
const decodeTlsVersion = Schema.decodeUnknownEffect(TlsVersion);
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
  egressMode: Config.string("T3CODE_CLOUD_EGRESS_MODE").pipe(Config.option),
  egressAllowlist: Config.string("T3CODE_CLOUD_EGRESS_ALLOWLIST").pipe(Config.option),
  egressAdminLock: Config.boolean("T3CODE_CLOUD_EGRESS_ADMIN_LOCK").pipe(Config.withDefault(false)),
  privacyMode: Config.boolean("T3CODE_CLOUD_PRIVACY_MODE").pipe(Config.withDefault(false)),
  kmsKeyArn: Config.string("T3CODE_CLOUD_KMS_KEY_ARN").pipe(Config.option),
  tlsMinimumVersion: Config.string("T3CODE_CLOUD_TLS_MIN_VERSION").pipe(Config.option),
  scmProtectedRepositories: Config.string("T3CODE_CLOUD_SCM_PROTECTED_REPOSITORIES").pipe(
    Config.option,
  ),
  scmBlockedRepositories: Config.string("T3CODE_CLOUD_SCM_BLOCKED_REPOSITORIES").pipe(
    Config.option,
  ),
  scmMaxScope: Config.string("T3CODE_CLOUD_SCM_MAX_SCOPE").pipe(Config.option),
  scmCredentialTtlSeconds: Config.int("T3CODE_CLOUD_SCM_CREDENTIAL_TTL_SECONDS").pipe(
    Config.withDefault(CLOUD_SCM_CREDENTIAL_MAX_TTL_SECONDS),
  ),
  scmAssumeRoleArn: Config.string("T3CODE_CLOUD_SCM_ASSUME_ROLE_ARN").pipe(Config.option),
  scmAssumeRoleExternalId: Config.string("T3CODE_CLOUD_SCM_ASSUME_ROLE_EXTERNAL_ID").pipe(
    Config.option,
  ),
});

/**
 * The posture a stack gets with nothing configured: the Terraform stack already
 * encrypts snapshots and artifacts, and CA-44 gives every Firecracker guest its
 * own disk key. Callers override the parts an operator has set.
 */
export function defaultCloudControllerSecurityConfig(input: {
  readonly region: string;
  readonly runtimeKind: CloudRuntimeKind;
}): CloudControllerSecurityConfig {
  const storeKeyId = `aws/ebs:${input.region}`;
  return {
    egress: { mode: "default_with_allowlist", allowlist: [], adminLocked: false },
    scm: {
      protectedRepositories: [],
      blockedRepositories: [],
      grantedRepositories: [],
      maxScope: "write",
      credentialTtlSeconds: CLOUD_SCM_CREDENTIAL_MAX_TTL_SECONDS,
    },
    encryption: {
      tlsMinimumVersion: "TLSv1.2",
      ...(input.runtimeKind === "firecracker" ? { perAgentDiskKeyId: "per-guest-disk-key" } : {}),
      snapshots: { encrypted: true, keyId: storeKeyId },
      artifacts: { encrypted: true, keyId: storeKeyId },
      privacyMode: false,
      secretRedaction: true,
    },
    scmHosts: ["github.com", "api.github.com", "codeload.github.com"],
    artifactHosts: [`s3.${input.region}.amazonaws.com`],
  };
}

/** Blank entries are dropped, so a trailing comma is not an empty allowlist rule. */
function hostList(raw: Option.Option<string>): ReadonlyArray<string> {
  return Option.isNone(raw)
    ? []
    : raw.value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

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

  const egressMode: CloudEgressPolicyInput["mode"] = Option.isSome(config.egressMode)
    ? yield* decodeEgressMode(config.egressMode.value).pipe(
        Effect.mapError(
          () =>
            new AwsWorkerConfigError({
              message:
                "T3CODE_CLOUD_EGRESS_MODE must be allow_all, default_with_allowlist, or allowlist_only.",
            }),
        ),
      )
    : "default_with_allowlist";
  const scmMaxScope: CloudScmScope = Option.isSome(config.scmMaxScope)
    ? yield* decodeScmScope(config.scmMaxScope.value).pipe(
        Effect.mapError(
          () =>
            new AwsWorkerConfigError({
              message: "T3CODE_CLOUD_SCM_MAX_SCOPE must be read, write, or admin.",
            }),
        ),
      )
    : "write";
  const tlsMinimumVersion: CloudTlsVersion = Option.isSome(config.tlsMinimumVersion)
    ? yield* decodeTlsVersion(config.tlsMinimumVersion.value).pipe(
        Effect.mapError(
          () =>
            new AwsWorkerConfigError({
              message: "T3CODE_CLOUD_TLS_MIN_VERSION must be TLSv1, TLSv1.1, TLSv1.2, or TLSv1.3.",
            }),
        ),
      )
    : "TLSv1.2";
  const kmsKeyArn = Option.isSome(config.kmsKeyArn) ? config.kmsKeyArn.value : undefined;
  const storeKeyId = kmsKeyArn ?? `aws/ebs:${config.region}`;
  const assumeRoleArn = Option.isSome(config.scmAssumeRoleArn)
    ? config.scmAssumeRoleArn.value
    : undefined;
  const assumeRoleExternalId = Option.isSome(config.scmAssumeRoleExternalId)
    ? config.scmAssumeRoleExternalId.value
    : undefined;

  const defaults = defaultCloudControllerSecurityConfig({ region: config.region, runtimeKind });
  const security: CloudControllerSecurityConfig = {
    ...defaults,
    egress: {
      mode: egressMode,
      allowlist: hostList(config.egressAllowlist),
      adminLocked: config.egressAdminLock,
    },
    scm: {
      ...defaults.scm,
      protectedRepositories: hostList(config.scmProtectedRepositories),
      blockedRepositories: hostList(config.scmBlockedRepositories),
      maxScope: scmMaxScope,
      credentialTtlSeconds: Math.max(
        1,
        Math.min(config.scmCredentialTtlSeconds, CLOUD_SCM_CREDENTIAL_MAX_TTL_SECONDS),
      ),
      ...(assumeRoleArn === undefined
        ? {}
        : {
            assumeRole: {
              roleArn: assumeRoleArn,
              sessionDurationSeconds: CLOUD_SCM_CREDENTIAL_MAX_TTL_SECONDS,
              ...(assumeRoleExternalId === undefined ? {} : { externalId: assumeRoleExternalId }),
            },
          }),
    },
    encryption: {
      ...defaults.encryption,
      tlsMinimumVersion,
      snapshots: { encrypted: true, keyId: storeKeyId },
      artifacts: { encrypted: true, keyId: storeKeyId },
      ...(kmsKeyArn === undefined ? {} : { customerManagedKeyArn: kmsKeyArn }),
      privacyMode: config.privacyMode,
    },
  };

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
    security,
  } satisfies ResolvedAwsWorkerConfig;
});
