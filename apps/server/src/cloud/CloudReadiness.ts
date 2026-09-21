/**
 * The readiness surface behind the cloud settings screen.
 *
 * Every probe is separate, so an operator can retry authentication or API
 * reachability without rerunning unrelated checks. Outcomes stay in memory
 * for the controller process because they describe external provider state.
 */
import {
  CLOUD_READINESS_CHECK_IDS,
  type CloudAllocationSnapshot,
  type CloudReadinessCheckId,
  type CloudReadinessCheckInput,
  type CloudReadinessCheckOutcome,
  type CloudReadinessReport,
  CloudReadinessError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveAwsWorkerConfig, type ResolvedAwsWorkerConfig } from "./awsWorkerConfig.ts";
import * as CloudAllocationController from "./CloudAllocationController.ts";
import * as CloudRuntimeProvider from "./CloudRuntimeProvider.ts";
import { buildCloudReadinessReport } from "./cloudReadinessModel.ts";
import * as CloudWorkerProvider from "./CloudWorkerProvider.ts";

const CallerIdentity = Schema.Struct({
  Account: Schema.String,
  Arn: Schema.String,
});
const decodeCallerIdentity = Schema.decodeEffect(Schema.fromJsonString(CallerIdentity));

const SnapshotsResponse = Schema.Struct({
  Snapshots: Schema.Array(Schema.Struct({ SnapshotId: Schema.String })),
});
const decodeSnapshotsResponse = Schema.decodeEffect(Schema.fromJsonString(SnapshotsResponse));

interface CheckResult {
  readonly outcome: CloudReadinessCheckOutcome;
  /** Only the IAM check learns an account id; the others leave this alone. */
  readonly observedAccountId?: string;
}

export class CloudReadiness extends Context.Service<
  CloudReadiness,
  {
    readonly report: Effect.Effect<CloudReadinessReport, CloudReadinessError>;
    readonly check: (
      input: CloudReadinessCheckInput,
    ) => Effect.Effect<CloudReadinessReport, CloudReadinessError>;
  }
>()("t3/cloud/CloudReadiness") {}

function readinessError(
  reason: CloudReadinessError["reason"],
  message: string,
): CloudReadinessError {
  return new CloudReadinessError({ reason, message });
}

/** Worker profiles the fleet advertises, falling back to the required base profile. */
function workerProfiles(config: ResolvedAwsWorkerConfig): ReadonlyArray<string> {
  const advertised = [...new Set(config.hypervisors.flatMap((host) => host.profiles))];
  return advertised.length > 0 ? advertised : ["linux-web"];
}

export const make = Effect.fn("CloudReadiness.make")(function* (input: {
  readonly enabled: boolean;
}) {
  const controller = yield* CloudAllocationController.CloudAllocationController;
  const runtimes = yield* CloudRuntimeProvider.CloudRuntimeProvider;
  const provider = yield* CloudWorkerProvider.CloudWorkerProvider;
  const runner = yield* ProcessRunner.ProcessRunner;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outcomes = yield* Ref.make(new Map<CloudReadinessCheckId, CloudReadinessCheckOutcome>());
  const observedAccounts = yield* Ref.make<{
    controller?: string;
    execution?: string;
  }>({});

  const requireEnabled = input.enabled
    ? Effect.void
    : Effect.fail(
        readinessError(
          "controller-disabled",
          "This environment does not host the managed cloud controller.",
        ),
      );

  /** Resolved once, like the worker provider's own layer: the stack an
      operator is looking at is the stack this process was started against. */
  const config = yield* resolveAwsWorkerConfig().pipe(
    Effect.mapError((error) => readinessError("controller-unavailable", error.message)),
  );

  const readSnapshot = controller.snapshot.pipe(
    Effect.mapError((error) =>
      readinessError(
        "controller-unavailable",
        `The cloud controller is unavailable: ${error.message}`,
      ),
    ),
  );

  /**
   * `aws` is invoked the same way the worker provider invokes it, so a check
   * that passes here proves the credentials the launcher will actually use.
   */
  const runAws = Effect.fn("CloudReadiness.runAws")(function* (
    region: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* runner
      .run({
        command: "aws",
        args: [...args, "--region", region, "--output", "json", "--no-cli-pager"],
        timeout: "30 seconds",
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(
        Effect.mapError(() => "The AWS CLI could not be started by the cloud controller." as const),
      );
    if (result.code !== 0) {
      return yield* Effect.fail(
        (result.stderr.trim() || "The AWS CLI command failed without an error message.") as string,
      );
    }
    return result.stdout;
  });

  const failed = (detail: string, remedy: string, now: string): CheckResult => ({
    outcome: { status: "failed", detail, remedy, checkedAt: now },
  });
  const passed = (detail: string, now: string): CheckResult => ({
    outcome: { status: "passed", detail, checkedAt: now },
  });
  const skipped = (detail: string, now: string): CheckResult => ({
    outcome: { status: "skipped", detail, checkedAt: now },
  });

  const checkDaytonaAuthentication = (
    readiness: CloudRuntimeProvider.CloudRuntimeProviderReadiness,
    now: string,
  ): CheckResult =>
    readiness.authentication === "configured"
      ? passed("The controller has a Daytona API key and the API accepted it.", now)
      : failed(
          readiness.detail,
          "Set a valid DAYTONA_API_KEY on the controller host. The key is never sent to clients or sandboxes.",
          now,
        );

  const checkDaytonaApi = (
    readiness: CloudRuntimeProvider.CloudRuntimeProviderReadiness,
    now: string,
  ): CheckResult =>
    readiness.reachability === "reachable"
      ? passed(`The Daytona API is reachable in target '${readiness.region}'.`, now)
      : failed(
          readiness.detail,
          "Check the controller's network path, DAYTONA_API_URL, and Daytona service status.",
          now,
        );

  const checkDaytonaCapacity = (
    readiness: CloudRuntimeProvider.CloudRuntimeProviderReadiness,
    snapshot: CloudAllocationSnapshot,
    now: string,
  ): CheckResult =>
    readiness.admission === "enabled" && snapshot.limits.maxConcurrentWorkers > 0
      ? passed(
          `Daytona admission uses resource class '${readiness.resourceClass}' with a controller limit of ${snapshot.limits.maxConcurrentWorkers} concurrent worker${snapshot.limits.maxConcurrentWorkers === 1 ? "" : "s"}.`,
          now,
        )
      : failed(
          "Managed runtime admission is disabled or its concurrency limit is zero.",
          "Set T3CODE_CLOUD_MANAGED_PROVIDER=daytona and configure a positive T3CODE_CLOUD_MAX_CONCURRENT_WORKERS value.",
          now,
        );

  const checkDaytonaSandboxReadiness = (
    readiness: CloudRuntimeProvider.CloudRuntimeProviderReadiness,
    now: string,
  ): CheckResult =>
    readiness.reachability !== "reachable"
      ? failed(
          readiness.detail,
          "Restore Daytona API access before relying on observed sandbox state.",
          now,
        )
      : passed(
          `${readiness.readySandboxes} of ${readiness.observedSandboxes} observed T3 sandbox${readiness.observedSandboxes === 1 ? "" : "es"} are started.`,
          now,
        );

  const checkExecutionIam = Effect.fn("CloudReadiness.checkExecutionIam")(function* (
    config: ResolvedAwsWorkerConfig,
    now: string,
  ): Effect.fn.Return<CheckResult, never> {
    const output = yield* runAws(config.region, ["sts", "get-caller-identity"]).pipe(Effect.result);
    if (Result.isFailure(output)) {
      return failed(
        output.failure,
        "Give the controller credentials for the execution account, then run this check again.",
        now,
      );
    }
    const identity = yield* decodeCallerIdentity(output.success).pipe(Effect.option);
    if (Option.isNone(identity)) {
      return failed(
        "`aws sts get-caller-identity` returned a response the controller could not read.",
        "Confirm the installed AWS CLI supports `--output json`.",
        now,
      );
    }
    const expected = config.executionAccountId;
    if (expected !== undefined && expected !== identity.value.Account) {
      return {
        ...failed(
          `The controller's credentials belong to account ${identity.value.Account}, not the configured execution account ${expected}.`,
          "Point T3CODE_CLOUD_EXECUTION_ACCOUNT_ID at the account that owns the fleet, or switch the controller's credentials.",
          now,
        ),
        observedAccountId: identity.value.Account,
      };
    }
    return {
      ...passed(`Authenticated as ${identity.value.Arn}.`, now),
      observedAccountId: identity.value.Account,
    };
  });

  const checkHypervisorKvm = (
    config: ResolvedAwsWorkerConfig,
    now: string,
  ): Effect.Effect<CheckResult> => {
    if (config.runtimeKind !== "firecracker") {
      return Effect.succeed(
        skipped(
          "This controller runs the EC2 migration fallback, which does not pack guests onto hypervisors.",
          now,
        ),
      );
    }
    if (config.hypervisors.length === 0) {
      return Effect.succeed(
        failed(
          "Firecracker is selected but no hypervisor is configured.",
          "Set T3CODE_CLOUD_HYPERVISOR_FLEET to the hosts terraform reports under `hypervisor.launch_templates`.",
          now,
        ),
      );
    }
    const withoutKvm = config.hypervisors.filter((host) => !host.kvm).map((host) => host.id);
    return Effect.succeed(
      withoutKvm.length > 0
        ? failed(
            `These hypervisors do not report KVM: ${withoutKvm.join(", ")}.`,
            "Use a metal or nested-virtualization instance type for those hosts; Firecracker cannot boot without KVM.",
            now,
          )
        : passed(
            `${config.hypervisors.length} hypervisor${config.hypervisors.length === 1 ? "" : "s"} report KVM.`,
            now,
          ),
    );
  };

  const checkImageAccess = Effect.fn("CloudReadiness.checkImageAccess")(function* (
    config: ResolvedAwsWorkerConfig,
    now: string,
  ): Effect.fn.Return<CheckResult, never> {
    const profiles = workerProfiles(config);
    const failures: Array<string> = [];
    for (const profile of profiles) {
      const resolved = yield* provider.resolveLaunchTemplate(profile).pipe(Effect.result);
      if (Result.isFailure(resolved)) failures.push(`${profile}: ${resolved.failure.message}`);
    }
    return failures.length > 0
      ? failed(
          failures.join(" "),
          "Re-apply the terraform stack so every worker profile has exactly one tagged launch template the controller can read.",
          now,
        )
      : passed(`Resolved launch templates for ${profiles.join(", ")}.`, now);
  });

  const checkSnapshotAccess = Effect.fn("CloudReadiness.checkSnapshotAccess")(function* (
    config: ResolvedAwsWorkerConfig,
    snapshot: CloudAllocationSnapshot,
    now: string,
  ): Effect.fn.Return<CheckResult, never> {
    const builds = snapshot.builds ?? [];
    const dangling = (snapshot.environments ?? []).flatMap((environment) => {
      if (environment.activeBuildId === undefined) return [];
      const build = builds.find((candidate) => candidate.id === environment.activeBuildId);
      if (build === undefined) return [`${environment.id}: active Build record is missing`];
      if (build.outcome.status !== "succeeded") {
        return [`${environment.id}: active Build is ${build.outcome.status}`];
      }
      return [];
    });
    if (dangling.length > 0) {
      return failed(
        `Active Builds without a bootable snapshot — ${dangling.join("; ")}.`,
        "Run a new Build for those environments; the previous snapshot is no longer usable.",
        now,
      );
    }
    // A read of the account's own snapshots is the permission half of this
    // check: reference integrity above cannot detect a missing IAM grant.
    const listed = yield* runAws(config.region, [
      "ec2",
      "describe-snapshots",
      "--owner-ids",
      "self",
      "--max-items",
      "1",
    ]).pipe(Effect.result);
    if (Result.isFailure(listed)) {
      return failed(
        listed.failure,
        "Grant ec2:DescribeSnapshots to the controller's role so it can verify the disks it boots from.",
        now,
      );
    }
    const decoded = yield* decodeSnapshotsResponse(listed.success).pipe(Effect.option);
    if (Option.isNone(decoded)) {
      return failed(
        "`aws ec2 describe-snapshots` returned a response the controller could not read.",
        "Confirm the installed AWS CLI supports `--output json`.",
        now,
      );
    }
    const activeBuilds = (snapshot.environments ?? []).filter(
      (environment) => environment.activeBuildId !== undefined,
    ).length;
    return passed(
      `Snapshots are readable and ${activeBuilds} active Build${activeBuilds === 1 ? "" : "s"} point at a bootable snapshot.`,
      now,
    );
  });

  const artifactsRoot = path.join(serverConfig.stateDir, "cloud-results");

  const checkArtifactStorage = Effect.fn("CloudReadiness.checkArtifactStorage")(function* (
    now: string,
  ): Effect.fn.Return<CheckResult, never> {
    const probe = path.join(artifactsRoot, ".readiness-probe");
    const written = yield* fs
      .makeDirectory(artifactsRoot, { recursive: true })
      .pipe(
        Effect.andThen(fs.writeFileString(probe, now)),
        Effect.andThen(fs.remove(probe, { force: true })),
        Effect.result,
      );
    return Result.isFailure(written)
      ? failed(
          `The retained-results directory at ${artifactsRoot} did not accept a write: ${written.failure.message}`,
          "Give the controller process write access to its state directory, or free disk space on that volume.",
          now,
        )
      : passed(`Retained results are writable at ${artifactsRoot}.`, now);
  });

  const checkGuestRegistration = Effect.fn("CloudReadiness.checkGuestRegistration")(function* (
    now: string,
  ): Effect.fn.Return<CheckResult, never> {
    const workers = yield* provider.listWorkers().pipe(Effect.result);
    if (Result.isFailure(workers)) {
      return failed(
        workers.failure.message,
        "Grant the controller ec2:DescribeInstances for the project's tags so it can see the guests it owns.",
        now,
      );
    }
    const running = workers.success.filter((worker) => worker.state === "running");
    const unregistered = running.filter((worker) => !worker.registrationCredentialPresent);
    return unregistered.length > 0
      ? failed(
          `${unregistered.length} running guest${unregistered.length === 1 ? "" : "s"} carry no registration credential: ${unregistered
            .map((worker) => worker.instanceId)
            .join(", ")}.`,
          "Those guests cannot register with the controller. Terminate them, or re-apply the launch template that seeds the credential tag.",
          now,
        )
      : passed(
          `${workers.success.length} worker${workers.success.length === 1 ? "" : "s"} enumerated; every running guest carries a registration credential.`,
          now,
        );
  });

  const checkSsmDiagnostics = Effect.fn("CloudReadiness.checkSsmDiagnostics")(function* (
    config: ResolvedAwsWorkerConfig,
    now: string,
  ): Effect.fn.Return<CheckResult, never> {
    const document = config.ssmDiagnosticsDocument;
    if (document === undefined) {
      return skipped(
        "No diagnostics document is configured. Set T3CODE_CLOUD_SSM_DIAGNOSTICS_DOCUMENT to enable this check.",
        now,
      );
    }
    const described = yield* runAws(config.region, [
      "ssm",
      "describe-document",
      "--name",
      document,
    ]).pipe(Effect.result);
    return Result.isFailure(described)
      ? failed(
          described.failure,
          `Create or grant ssm:DescribeDocument on '${document}'. Cloud runs work without it; only recovery debugging is affected.`,
          now,
        )
      : passed(`Diagnostics document '${document}' is available.`, now);
  });

  const runCheck = (
    id: CloudReadinessCheckId,
    config: ResolvedAwsWorkerConfig,
    snapshot: CloudAllocationSnapshot,
    managedProvider: CloudRuntimeProvider.CloudRuntimeProviderReadiness,
    now: string,
  ): Effect.Effect<CheckResult> => {
    switch (id) {
      case "daytona-authentication":
        return Effect.succeed(checkDaytonaAuthentication(managedProvider, now));
      case "daytona-api":
        return Effect.succeed(checkDaytonaApi(managedProvider, now));
      case "daytona-capacity":
        return Effect.succeed(checkDaytonaCapacity(managedProvider, snapshot, now));
      case "daytona-sandbox-readiness":
        return Effect.succeed(checkDaytonaSandboxReadiness(managedProvider, now));
      case "execution-iam":
        return checkExecutionIam(config, now);
      case "hypervisor-kvm":
        return checkHypervisorKvm(config, now);
      case "image-access":
        return checkImageAccess(config, now);
      case "snapshot-access":
        return checkSnapshotAccess(config, snapshot, now);
      case "artifact-storage":
        return checkArtifactStorage(now);
      case "guest-registration":
        return checkGuestRegistration(now);
      case "ssm-diagnostics":
        return checkSsmDiagnostics(config, now);
    }
  };

  const assemble = Effect.fn("CloudReadiness.assemble")(function* (
    config: ResolvedAwsWorkerConfig,
    snapshot: CloudAllocationSnapshot,
    managedProvider: CloudRuntimeProvider.CloudRuntimeProviderReadiness,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const recorded = yield* Ref.get(outcomes);
    const accounts = yield* Ref.get(observedAccounts);
    return buildCloudReadinessReport({
      config,
      snapshot,
      outcomes: recorded,
      observedAccountIds: accounts,
      managedProvider,
      now,
    });
  });

  const report = Effect.gen(function* () {
    yield* requireEnabled;
    const snapshot = yield* readSnapshot;
    return yield* assemble(config, snapshot, yield* runtimes.readiness());
  });

  const check: CloudReadiness["Service"]["check"] = (checkInput) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const requested = [...new Set(checkInput.checks)];
      const unknown = requested.filter(
        (id) => !(CLOUD_READINESS_CHECK_IDS as ReadonlyArray<string>).includes(id),
      );
      if (unknown.length > 0) {
        return yield* readinessError(
          "invalid-request",
          `Unknown readiness checks: ${unknown.join(", ")}.`,
        );
      }
      const snapshot = yield* readSnapshot;
      const managedProvider = yield* runtimes.readiness();
      const now = DateTime.formatIso(yield* DateTime.now);
      // Sequential: several probes shell out to the same CLI, and an operator
      // reading a settings page gains nothing from racing them.
      for (const id of requested) {
        const result = yield* runCheck(id, config, snapshot, managedProvider, now);
        yield* Ref.update(outcomes, (current) => new Map(current).set(id, result.outcome));
        const observed = result.observedAccountId;
        if (observed !== undefined) {
          yield* Ref.update(observedAccounts, (current) => ({ ...current, execution: observed }));
        }
      }
      return yield* assemble(config, snapshot, managedProvider);
    });

  return CloudReadiness.of({ report, check });
});

export const layer = Layer.effect(
  CloudReadiness,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    return yield* make({ enabled: serverConfig.cloudControllerEnabled === true });
  }),
);
