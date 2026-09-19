import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  CloudEnvironmentBuildId,
  type CloudAllocationSnapshot,
  type CloudEnvironmentBuild,
  type CloudReadinessEnvironment,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { randomUUID } from "../../lib/utils";
import { cloudAllocations } from "../../state/cloudAllocations";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  cloudBuildActions,
  cloudFleetSummary,
  validateCloudBuildPolicyDraft,
} from "./CloudAgentsSettings.logic";
import { SettingsSection } from "./settingsLayout";

const fieldClassName = "flex flex-col gap-1.5";
const labelClassName = "text-xs font-medium text-foreground";

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function buildOutcome(build: CloudEnvironmentBuild): string {
  switch (build.outcome.status) {
    case "running":
      return "running";
    case "succeeded":
      return `succeeded · snapshot ${build.outcome.snapshot.id}`;
    case "failed":
      return `failed at ${build.outcome.stage}: ${build.outcome.message}`;
    case "cancelled":
      return "cancelled";
    case "skipped":
      return `skipped · reused ${build.outcome.reusedBuildId}`;
    default: {
      const _exhaustive: never = build.outcome;
      return _exhaustive;
    }
  }
}

function buildBase(build: CloudEnvironmentBuild): string {
  switch (build.base.kind) {
    case "image":
      return build.base.image;
    case "dockerfile":
      return "Dockerfile";
    case "snapshot":
      return `snapshot ${build.base.snapshot}`;
    default: {
      const _exhaustive: never = build.base;
      return _exhaustive;
    }
  }
}

function buildStageTimings(build: CloudEnvironmentBuild): string {
  const stages = [
    ["base", build.timings.base],
    ["clone", build.timings.clone],
    ["install", build.timings.install],
    ["snapshot", build.timings.snapshot],
  ] as const;
  const recorded = stages.flatMap(([stage, timing]) =>
    timing === undefined ? [] : [`${stage} ${timing.durationMs} ms`],
  );
  return recorded.length === 0 ? "not recorded" : recorded.join(" · ");
}

function useAdministrationAction(onMutated: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const execute = useCallback(
    async <A, E>(
      key: string,
      command: () => Promise<AtomCommandResult<A, E>>,
      failureMessage: string,
    ): Promise<A | null> => {
      setBusy(key);
      const result = await command();
      setBusy(null);
      onMutated();
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : failureMessage);
        return null;
      }
      setError(null);
      return result.value;
    },
    [onMutated],
  );
  return { busy, error, setError, execute };
}

export function CloudEnvironmentAdministration({
  controllerEnvironmentId,
  environment,
  snapshot,
  onMutated,
}: {
  readonly controllerEnvironmentId: EnvironmentId;
  readonly environment: CloudReadinessEnvironment;
  readonly snapshot: CloudAllocationSnapshot | null;
  readonly onMutated: () => void;
}) {
  const startBuild = useAtomCommand(cloudAllocations.startBuild, { reportFailure: false });
  const cancelBuild = useAtomCommand(cloudAllocations.cancelBuild, { reportFailure: false });
  const saveBuild = useAtomCommand(cloudAllocations.saveBuild, { reportFailure: false });
  const restoreEnvironment = useAtomCommand(cloudAllocations.restoreEnvironment, {
    reportFailure: false,
  });
  const setBuildStaleThreshold = useAtomCommand(cloudAllocations.setBuildStaleThreshold, {
    reportFailure: false,
  });
  const { busy, error, setError, execute } = useAdministrationAction(onMutated);
  const [policyDraft, setPolicyDraft] = useState<{
    readonly environmentId: string;
    readonly value: string;
  } | null>(null);
  const [inspectedBuildId, setInspectedBuildId] = useState<string | null>(null);
  const policySeconds =
    policyDraft?.environmentId === environment.environmentId
      ? policyDraft.value
      : String(environment.staleBuildThresholdSeconds);

  const savedEnvironment = snapshot?.environments?.find(
    (candidate) => candidate.id === environment.environmentId,
  );
  const builds = useMemo(
    () =>
      (snapshot?.builds ?? [])
        .filter((build) => build.environmentId === environment.environmentId)
        .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt)),
    [environment.environmentId, snapshot?.builds],
  );

  const manualBuild = () =>
    void execute(
      `build:start:${environment.environmentId}`,
      () =>
        startBuild({
          environmentId: controllerEnvironmentId,
          input: {
            buildId: CloudEnvironmentBuildId.make(`build:${randomUUID()}`),
            environmentId: environment.environmentId,
            trigger: "manual",
            occurredAt: new Date().toISOString(),
          },
        }),
      "The controller could not start that Build.",
    );

  const savePolicy = () => {
    const validation = validateCloudBuildPolicyDraft(policySeconds);
    if (validation.status === "invalid") {
      setError(validation.message);
      return;
    }
    void execute(
      `build:policy:${environment.environmentId}`,
      () =>
        setBuildStaleThreshold({
          environmentId: controllerEnvironmentId,
          input: {
            environmentId: environment.environmentId,
            staleThresholdSeconds: validation.staleThresholdSeconds,
            occurredAt: new Date().toISOString(),
          },
        }),
      "The controller could not save that Build refresh policy.",
    );
  };

  const restoreVersion = (version: number) =>
    void (async () => {
      const restored = await execute(
        `environment:restore:${environment.environmentId}`,
        () =>
          restoreEnvironment({
            environmentId: controllerEnvironmentId,
            input: {
              environmentId: environment.environmentId,
              expectedVersion: savedEnvironment?.current.version ?? environment.version,
              restoreVersion: version,
              occurredAt: new Date().toISOString(),
            },
          }),
        "The controller could not restore that environment version.",
      );
      if (restored === null) return;
      await execute(
        `build:start:${environment.environmentId}`,
        () =>
          startBuild({
            environmentId: controllerEnvironmentId,
            input: {
              buildId: CloudEnvironmentBuildId.make(`build:${randomUUID()}`),
              environmentId: restored.id,
              trigger: "configuration-change",
              occurredAt: new Date().toISOString(),
            },
          }),
        "The controller restored the version but could not start its Build.",
      );
    })();

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className={fieldClassName}>
          <span className={labelClassName}>Recurring refresh seconds</span>
          <Input
            className="w-44"
            inputMode="numeric"
            value={policySeconds}
            onChange={(event) =>
              setPolicyDraft({
                environmentId: environment.environmentId,
                value: event.currentTarget.value,
              })
            }
          />
        </label>
        <Button size="xs" variant="outline" disabled={busy !== null} onClick={savePolicy}>
          {busy === `build:policy:${environment.environmentId}` ? "Saving…" : "Save policy"}
        </Button>
        <Button size="xs" disabled={busy !== null} onClick={manualBuild}>
          {busy === `build:start:${environment.environmentId}` ? "Starting…" : "Run Build now"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Set 0 to refresh before every run. Manual Builds always run; recurring Builds reuse the
        active snapshot when refs, Build config, and Build-only secret references still match.
      </p>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-foreground">Version history</p>
        {savedEnvironment === undefined ? (
          <p className="text-xs text-muted-foreground">Version history is unavailable.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {savedEnvironment.history.map((version) => (
              <li key={version.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="font-medium text-foreground">v{version.version}</span>
                <span className="text-muted-foreground">{version.createdAt}</span>
                <span className="text-muted-foreground">
                  {version.base.kind === "image" ? version.base.image : version.base.kind}
                </span>
                {version.restoredFromVersion === undefined ? null : (
                  <span className="text-muted-foreground">
                    restored from v{version.restoredFromVersion}
                  </span>
                )}
                {version.version === savedEnvironment.current.version ? (
                  <span className="text-success">current</span>
                ) : (
                  <Button
                    className="ms-auto"
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => restoreVersion(version.version)}
                  >
                    Restore and test
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-foreground">Build history</p>
        {builds.length === 0 ? (
          <p className="text-xs text-muted-foreground">No Builds recorded.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {builds.map((build) => {
              const actions = cloudBuildActions(build);
              const inspected = inspectedBuildId === build.id;
              return (
                <li key={build.id} className="rounded-md bg-muted/40 p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-foreground">v{build.version}</span>
                    <span className="text-muted-foreground">{build.trigger}</span>
                    <span className="text-muted-foreground">{buildOutcome(build)}</span>
                    {build.id === environment.activeBuildId ? (
                      <span className="text-success">active</span>
                    ) : null}
                    {build.draft ? <span className="text-muted-foreground">draft</span> : null}
                    <Button
                      className="ms-auto"
                      size="xs"
                      variant="ghost"
                      onClick={() => setInspectedBuildId(inspected ? null : build.id)}
                    >
                      {inspected ? "Close" : "Inspect"}
                    </Button>
                    {actions.includes("cancel") ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() =>
                          void execute(
                            `build:cancel:${build.id}`,
                            () =>
                              cancelBuild({
                                environmentId: controllerEnvironmentId,
                                input: {
                                  buildId: build.id,
                                  occurredAt: new Date().toISOString(),
                                },
                              }),
                            "The controller could not cancel that Build.",
                          )
                        }
                      >
                        Cancel
                      </Button>
                    ) : null}
                    {actions.includes("activate") ? (
                      <Button
                        size="xs"
                        disabled={busy !== null}
                        onClick={() =>
                          void execute(
                            `build:activate:${build.id}`,
                            () =>
                              saveBuild({
                                environmentId: controllerEnvironmentId,
                                input: {
                                  buildId: build.id,
                                  occurredAt: new Date().toISOString(),
                                },
                              }),
                            "The controller could not activate that draft Build.",
                          )
                        }
                      >
                        Activate
                      </Button>
                    ) : null}
                  </div>
                  {inspected ? (
                    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
                      <Facts
                        rows={[
                          ["Build id", build.id],
                          ["Started", build.startedAt],
                          ["Base", buildBase(build)],
                          ["Stages", buildStageTimings(build)],
                          [
                            "Commits",
                            build.gitSetup.length === 0
                              ? "none resolved"
                              : build.gitSetup
                                  .map((git) => `${git.repository}@${git.commit.slice(0, 12)}`)
                                  .join(", "),
                          ],
                        ]}
                      />
                      {build.logs.length === 0 ? (
                        <p className="text-muted-foreground">No command output recorded.</p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {build.logs.map((log) => (
                            <li
                              key={`${log.name}:${log.startedAt}`}
                              className="flex flex-col gap-1"
                            >
                              <span className="font-medium text-foreground">
                                {log.name} ·{" "}
                                {log.exitCode === null ? "no exit" : `exit ${log.exitCode}`}
                                {log.timedOut ? " · timed out" : ""}
                              </span>
                              {log.stdout.length === 0 ? null : (
                                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-background p-2">
                                  {log.stdout}
                                  {log.stdoutTruncated ? "\n[truncated]" : ""}
                                </pre>
                              )}
                              {log.stderr.length === 0 ? null : (
                                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-destructive">
                                  {log.stderr}
                                  {log.stderrTruncated ? "\n[truncated]" : ""}
                                </pre>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function CloudFleetAdministration({
  snapshot,
}: {
  readonly snapshot: CloudAllocationSnapshot | null;
}) {
  if (snapshot === null) {
    return (
      <SettingsSection id="cloud-operations" title="Runtime operations">
        <p className="text-sm text-muted-foreground">Waiting for the controller snapshot.</p>
      </SettingsSection>
    );
  }

  const summary = cloudFleetSummary(snapshot);
  const visibleAllocations = snapshot.allocations.filter(
    (allocation) =>
      allocation.allocationState.status === "queued" ||
      allocation.placement !== undefined ||
      allocation.idleState.status === "hibernated" ||
      allocation.cleanupState.status !== "not-requested",
  );

  return (
    <>
      <SettingsSection id="cloud-operations" title="Runtime operations">
        <Facts
          rows={[
            ["Queue", `${summary.queuedAllocations} queued of ${snapshot.limits.maxQueueDepth}`],
            [
              "Runtime attempts",
              `${summary.activeRuntimeAttempts} active or creating · ${summary.hibernatedRuntimeAttempts} hibernated`,
            ],
            ["Placement", `${summary.warmPlacements} warm · ${summary.coldPlacements} cold`],
            [
              "Warm inventory",
              `${summary.warmGuests.ready} ready · ${summary.warmGuests.warming} warming · ${summary.warmGuests.claimed} claimed · ${summary.warmGuests.draining} draining`,
            ],
            [
              "Cleanup",
              `${summary.cleanupPending} pending · ${summary.cleanupFailed} failed · ${snapshot.deletions?.length ?? 0} deletion record(s)`,
            ],
          ]}
        />

        {snapshot.capacity === undefined ? null : (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-foreground">
              Capacity plan · {snapshot.capacity.desiredHosts} desired host(s)
            </p>
            {snapshot.capacity.pools.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active warm pools.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                {snapshot.capacity.pools.map((pool) => (
                  <li key={`${pool.key.environmentId}:${pool.key.profileId}:${pool.key.buildId}`}>
                    {pool.key.environmentId} · {pool.key.profileId} · {pool.action} to {pool.target}
                    : {pool.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {snapshot.warmGuests === undefined || snapshot.warmGuests.length === 0 ? null : (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-foreground">Warm guests</p>
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {snapshot.warmGuests.map((guest) => (
                <li key={guest.id}>
                  {guest.id} · {guest.status} · {guest.profileId} · boot {guest.bootTimeMs} ms
                  {guest.claimedByAllocationId === undefined
                    ? ""
                    : ` · claimed by ${guest.claimedByAllocationId}`}
                </li>
              ))}
            </ul>
          </div>
        )}

        {visibleAllocations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No queued or retained runtime work.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleAllocations.map((allocation) => (
              <li key={allocation.id} className="rounded-lg border border-border p-2 text-xs">
                <p className="font-medium text-foreground">
                  {allocation.id} · {allocation.allocationState.status}
                </p>
                <p className="text-muted-foreground">
                  {allocation.placement === undefined
                    ? "not placed"
                    : `${allocation.placement.warmFork} placement · claim ${allocation.placement.claimLatencyMs} ms · boot ${allocation.placement.bootTimeMs} ms${
                        allocation.placement.fallbackReason === undefined
                          ? ""
                          : ` · ${allocation.placement.fallbackReason}`
                      }`}
                </p>
                <p className="text-muted-foreground">
                  {allocation.idleState.status === "hibernated"
                    ? `snapshot ${allocation.idleState.snapshot.instanceId} captured ${allocation.idleState.snapshot.capturedAt}`
                    : `runtime ${allocation.idleState.status}`}
                  {` · cleanup ${allocation.cleanupState.status}`}
                  {allocation.cleanupState.status === "failed"
                    ? `: ${allocation.cleanupState.reason}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          This page exposes controller operations and bounded diagnostics only. It does not provide
          a shell on a hypervisor or guest.
        </p>
      </SettingsSection>

      <SettingsSection id="cloud-audit" title="Administrative audit">
        {snapshot.audit === undefined || snapshot.audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">No administrative changes recorded.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {snapshot.audit.slice(0, 50).map((event) => (
              <li key={event.id} className="text-xs">
                <span className="font-medium text-foreground">{event.summary}</span>
                <span className="text-muted-foreground">
                  {` ${event.occurredAt} · ${event.actor.kind} ${event.actor.id} · ${event.resourceType} ${event.resourceId}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </>
  );
}
