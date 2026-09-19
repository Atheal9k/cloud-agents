import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CLOUD_READINESS_CHECK_IDS,
  selfHostedLaunchPreview,
  type CloudReadinessCheckId,
  type CloudReadinessReport,
  type CloudScmConnection,
  type CloudScmHostKind,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { randomUUID } from "../../lib/utils";
import { cloudAllocations } from "../../state/cloudAllocations";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useServerConfigs } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { openCloudLaunchDialog } from "../../cloud/cloudLaunchDialogBus";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  cloudControllerDefaultsFromDraft,
  cloudEnvironmentSourceLabel,
  cloudReadinessCheckRows,
  cloudReadinessHeadline,
  createCloudGuidedSetupDraft,
  validateCloudGuidedSetupDraft,
  type CloudGuidedSetupDraft,
  type CloudReadinessTone,
} from "./CloudAgentsSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const TONE_CLASS: Record<CloudReadinessTone, string> = {
  ok: "text-success",
  problem: "text-destructive",
  muted: "text-muted-foreground",
};

const fieldClassName = "flex flex-col gap-1.5";
const labelClassName = "text-xs font-medium text-foreground";
const selectClassName =
  "h-8.5 rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-xs/5 outline-none focus:border-ring focus:ring-3 focus:ring-ring/24 sm:h-7.5";

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

function seconds(value: number): string {
  if (value === 0) return "every run";
  if (value % 86_400 === 0) return `${value / 86_400} d`;
  if (value % 3_600 === 0) return `${value / 3_600} h`;
  if (value % 60 === 0) return `${value / 60} min`;
  return `${value} s`;
}

function CloudAgentsSettingsForEnvironment({
  environmentId,
}: {
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
}) {
  const snapshotResult = useAtomValue(cloudAllocations.snapshot({ environmentId, input: {} }));
  const snapshot = Option.getOrNull(AsyncResult.value(snapshotResult));
  const readReadiness = useAtomCommand(cloudAllocations.readiness, { reportFailure: false });
  const runChecks = useAtomCommand(cloudAllocations.runReadinessChecks, { reportFailure: false });
  const setAdmission = useAtomCommand(cloudAllocations.setAdmission, { reportFailure: false });
  const setDefaults = useAtomCommand(cloudAllocations.setDefaults, { reportFailure: false });
  const setSpendLimit = useAtomCommand(cloudAllocations.setSpendLimit, { reportFailure: false });
  const exportUsage = useAtomCommand(cloudAllocations.exportUsage, { reportFailure: false });
  const runGuidedSetup = useAtomCommand(cloudAllocations.runGuidedSetup, { reportFailure: false });
  const listScm = useAtomCommand(cloudAllocations.listScmConnections, { reportFailure: false });
  const connectScm = useAtomCommand(cloudAllocations.connectScm, { reportFailure: false });
  const disconnectScm = useAtomCommand(cloudAllocations.disconnectScm, { reportFailure: false });

  const [report, setReport] = useState<CloudReadinessReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [defaultsDraft, setDefaultsDraft] = useState({
    model: "",
    context: "",
    repository: "",
    ref: "",
    longRunning: false,
    computerUse: false,
    summaries: false,
    artifactsToGit: false,
    collaboration: "disabled" as "disabled" | "service-accounts" | "all",
    selfHostedMode: "off" as "off" | "allow" | "require",
  });
  const [spendDraft, setSpendDraft] = useState({
    kind: "user" as "user" | "team" | "service-account",
    id: "local-operator",
    period: "monthly" as "daily" | "monthly",
    capUsd: "",
  });
  const [exportText, setExportText] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupDraft, setSetupDraft] = useState<CloudGuidedSetupDraft | null>(null);
  const [setupNotice, setSetupNotice] = useState<string | null>(null);
  const [scmConnections, setScmConnections] = useState<ReadonlyArray<CloudScmConnection>>([]);
  const [scmDraft, setScmDraft] = useState({
    kind: "github" as CloudScmHostKind,
    displayName: "GitHub",
    baseUrl: "https://github.com",
    installedRepositories: "",
  });

  /** Every mutation reports through one busy key and one error line. */
  const run = useCallback(
    async (
      key: string,
      command: () => Promise<{ readonly _tag: string }>,
      failureMessage: string,
    ) => {
      setBusy(key);
      const result = await command();
      setBusy(null);
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result as never);
        setError(cause instanceof Error ? cause.message : failureMessage);
        return null;
      }
      setError(null);
      return result as { readonly _tag: "Success"; readonly value: unknown };
    },
    [],
  );

  const refresh = useCallback(async () => {
    const result = await readReadiness({ environmentId, input: {} });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result as never);
      setError(
        cause instanceof Error ? cause.message : "The controller could not report its readiness.",
      );
      return;
    }
    setError(null);
    setReport(result.value);
  }, [environmentId, readReadiness]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void listScm({ environmentId, input: {} }).then((result) => {
      if (AsyncResult.isSuccess(result)) setScmConnections(result.value);
    });
  }, [environmentId, listScm]);

  useEffect(() => {
    const defaults = report?.settings.defaults;
    if (defaults === undefined) return;
    setDefaultsDraft({
      model: defaults.model ?? "",
      context: defaults.context ?? "",
      repository: defaults.repository ?? "",
      ref: defaults.ref ?? "",
      longRunning: defaults.longRunning === true,
      computerUse: defaults.computerUse === true,
      summaries: defaults.summaries === true,
      artifactsToGit: defaults.artifactsToGit === true,
      collaboration: defaults.collaboration ?? "disabled",
      selfHostedMode: defaults.selfHostedMode ?? "off",
    });
  }, [report?.settings.defaults]);

  const checkRows = useMemo(
    () => (report === null ? [] : cloudReadinessCheckRows(report)),
    [report],
  );
  const headline = useMemo(
    () => (report === null ? null : cloudReadinessHeadline(report)),
    [report],
  );
  const admissionStopped = report?.health.controller.admission.status === "stopped";
  const fence =
    report?.health.controller.writability?.status === "fenced"
      ? report.health.controller.writability
      : null;

  const check = (checks: ReadonlyArray<CloudReadinessCheckId>, key: string) =>
    void run(
      key,
      async () => {
        const result = await runChecks({ environmentId, input: { checks } });
        if (result._tag === "Success") setReport(result.value);
        return result;
      },
      "The controller could not run that check.",
    );

  const toggleAdmission = () =>
    void run(
      "admission",
      () =>
        setAdmission({
          environmentId,
          input: { admissionOpen: admissionStopped, occurredAt: new Date().toISOString() },
        }),
      "The controller could not change admission.",
    ).then((result) => {
      if (result !== null) void refresh();
    });

  const saveDefaults = () =>
    void run(
      "defaults",
      () =>
        setDefaults({
          environmentId,
          input: {
            defaults: cloudControllerDefaultsFromDraft(defaultsDraft),
            occurredAt: new Date().toISOString(),
          },
        }),
      "The controller could not save those defaults.",
    ).then((result) => {
      if (result !== null) void refresh();
    });

  const saveSpendLimit = () => {
    const cap = spendDraft.capUsd.trim();
    const capUsd = cap.length === 0 ? null : Number(cap);
    if (capUsd !== null && !Number.isFinite(capUsd)) {
      setError("Spend cap must be a number, or empty to remove it.");
      return;
    }
    void run(
      "spend",
      () =>
        setSpendLimit({
          environmentId,
          input: {
            principal: { kind: spendDraft.kind, id: spendDraft.id.trim() || "local-operator" },
            period: spendDraft.period,
            capUsd,
            occurredAt: new Date().toISOString(),
          },
        }),
      "The controller could not save that spend limit.",
    ).then((result) => {
      if (result !== null) void refresh();
    });
  };

  const downloadUsage = () => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    void run(
      "export",
      () =>
        exportUsage({
          environmentId,
          input: { periodStart: start, periodEnd: end },
        }),
      "The controller could not export usage.",
    ).then((result) => {
      if (result === null) return;
      setExportText(JSON.stringify(result.value, null, 2));
    });
  };

  const openSetup = (targetEnvironmentId: string | null) => {
    const environment = snapshot?.environments?.find(
      (candidate) => candidate.id === targetEnvironmentId,
    );
    setSetupDraft(
      createCloudGuidedSetupDraft(
        environment,
        targetEnvironmentId ?? `environment:${randomUUID()}`,
      ),
    );
    setSetupNotice(null);
    setSetupOpen(true);
  };

  const submitSetup = () => {
    if (setupDraft === null) return;
    const environment = snapshot?.environments?.find(
      (candidate) => candidate.id === setupDraft.environmentId,
    );
    const validation = validateCloudGuidedSetupDraft({
      draft: setupDraft,
      buildId: `build:${randomUUID()}`,
      expectedVersion: environment?.current.version,
      occurredAt: new Date().toISOString(),
    });
    if (validation.status === "invalid") {
      setSetupNotice(null);
      setError(validation.message);
      return;
    }
    void run(
      "guided-setup",
      async () => {
        const result = await runGuidedSetup({ environmentId, input: validation.input });
        if (result._tag === "Success") {
          setSetupNotice(
            result.value.retainedBuildId === undefined
              ? `Testing version ${result.value.version}. It activates only if this Build succeeds.`
              : `Testing version ${result.value.version}. Runs keep booting Build ${result.value.retainedBuildId} unless it succeeds.`,
          );
          setSetupOpen(false);
        }
        return result;
      },
      "The controller could not start that environment test.",
    ).then((result) => {
      if (result !== null) void refresh();
    });
  };

  if (report === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Cloud agents">
          <p className="text-sm text-muted-foreground">
            {error ?? "Reading the cloud controller's readiness…"}
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="cloud-readiness"
        title="Readiness"
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
            <Button
              size="xs"
              variant={admissionStopped ? "default" : "outline"}
              disabled={busy !== null || fence !== null}
              onClick={toggleAdmission}
            >
              {admissionStopped ? "Resume admission" : "Stop admission"}
            </Button>
          </div>
        }
      >
        {headline ? (
          <p className={cn("text-sm font-medium", TONE_CLASS[headline.tone])}>{headline.label}</p>
        ) : null}
        {fence ? (
          <p className="text-xs text-muted-foreground">
            Fenced at {fence.fencedAt}: {fence.reason}
          </p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Facts
          rows={[
            [
              "Controller",
              `${report.health.controller.mode} · requires this host online: ${String(report.health.controller.requiresHostOnline)}`,
            ],
            [
              "Runs",
              `${report.health.activeRuns} active, ${report.health.queuedRuns} queued, limit ${report.health.maxConcurrentWorkers}`,
            ],
            ["Report taken", report.generatedAt],
          ]}
        />
      </SettingsSection>

      <SettingsSection id="cloud-accounts" title="Accounts and runtime">
        <Facts
          rows={report.accounts.map((account) => [
            account.role === "controller" ? "Controller account" : "Execution account",
            <>
              {account.accountId ?? "not configured"} · {account.region} · {account.project}
              {account.observedAccountId !== undefined &&
              account.observedAccountId !== account.accountId ? (
                <span className="text-destructive"> (observed {account.observedAccountId})</span>
              ) : null}
            </>,
          ])}
        />
        <Facts
          rows={[
            ["Runtime", `${report.runtime.kind} · ${report.runtime.parity}`],
            [
              "Slot capacity",
              `${report.runtime.slots.hosts} host(s) · ${report.runtime.slots.cpuMillis} mCPU · ${report.runtime.slots.memoryMib} MiB · ${report.runtime.slots.diskGib} GiB`,
            ],
            [
              "Fleet",
              `${report.runtime.desiredHosts} host(s) wanted · ${report.runtime.warmGuestsReady} warm guest(s) ready`,
            ],
          ]}
        />
        {report.runtime.hypervisors.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {report.runtime.hypervisors.map((host) => (
              <li key={host.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium text-foreground">{host.id}</span>
                <span className="text-muted-foreground">account {host.accountId}</span>
                <span className={host.kvm ? "text-success" : "text-destructive"}>
                  {host.kvm ? "KVM" : "no KVM"}
                </span>
                <span className="text-muted-foreground">
                  guest {host.guestImageVersion ?? "unknown"} · host{" "}
                  {host.hypervisorImageVersion ?? "unknown"}
                </span>
                <span className="text-muted-foreground">{host.profiles.join(", ")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No hypervisor is configured, so runs use the EC2 migration fallback.
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        id="cloud-checks"
        title="Checks"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => check(CLOUD_READINESS_CHECK_IDS, "check:all")}
          >
            Run all
          </Button>
        }
      >
        <ul className="flex flex-col gap-3">
          {checkRows.map((row) => (
            <li key={row.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{row.title}</span>
                <span className={cn("text-xs", TONE_CLASS[row.tone])}>{row.statusLabel}</span>
                {row.optional ? (
                  <span className="text-xs text-muted-foreground">optional</span>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  className="ms-auto"
                  disabled={busy !== null}
                  onClick={() => check([row.id], `check:${row.id}`)}
                >
                  {busy === `check:${row.id}` ? "Running…" : "Run"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{row.detail ?? row.description}</p>
              {row.remedy ? <p className="text-xs text-foreground">{row.remedy}</p> : null}
            </li>
          ))}
        </ul>
      </SettingsSection>

      <SettingsSection
        id="cloud-environments"
        title="Environments and Builds"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => openCloudLaunchDialog({ kind: "env-setup" })}
          >
            Set up with agent
          </Button>
        }
      >
        <p className="text-xs text-muted-foreground">
          A repository-owned environment is created by the same env-setup skill
          from Settings, the command palette, and the cloud setup keybinding. This
          form only edits an already-saved personal, team, or default environment.
        </p>
        {report.environments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cloud environment is saved yet.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {report.environments.map((environment) => (
              <li key={environment.environmentId} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{environment.name}</span>
                  <span className="text-xs text-muted-foreground">
                    v{environment.version} · {cloudEnvironmentSourceLabel(environment.source)}
                  </span>
                  {environment.source.type === "saved" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="ms-auto"
                      disabled={busy !== null}
                      onClick={() => openSetup(environment.environmentId)}
                    >
                      Edit and test
                    </Button>
                  ) : null}
                </div>
                <Facts
                  rows={[
                    [
                      "Active Build",
                      environment.activeBuildId === undefined
                        ? "none"
                        : `v${environment.activeBuildVersion ?? "?"} · snapshot ${environment.activeBuildSnapshotId ?? "unknown"}`,
                    ],
                    [
                      "Freshness",
                      `${environment.buildStale ? "stale" : "fresh"} · refreshes after ${seconds(environment.staleBuildThresholdSeconds)}`,
                    ],
                    [
                      "Egress",
                      `${environment.egressMode}${environment.egressAllowlist.length > 0 ? ` · ${environment.egressAllowlist.join(", ")}` : ""}`,
                    ],
                    [
                      "Network",
                      environment.networkProfile === undefined
                        ? "public"
                        : environment.networkProfile.enabled
                          ? `${environment.networkProfile.kind} · ${environment.networkProfile.costClass}`
                          : `disabled · was ${environment.networkProfile.disabledFrom ?? environment.networkProfile.kind}`,
                    ],
                    [
                      "Private dependencies",
                      environment.privateDependencies === undefined ||
                      environment.privateDependencies.length === 0
                        ? "none"
                        : environment.privateDependencies
                            .map((dependency) => `${dependency.kind} ${dependency.destination}`)
                            .join(", "),
                    ],
                    [
                      "Secrets",
                      environment.secrets.length === 0
                        ? "none"
                        : environment.secrets
                            .map((secret) => `${secret.name} (${secret.availability})`)
                            .join(", "),
                    ],
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
        {setupNotice ? <p className="text-sm text-muted-foreground">{setupNotice}</p> : null}
        {setupOpen && setupDraft !== null ? (
          <form
            className="flex flex-col gap-3 rounded-lg border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitSetup();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={fieldClassName}>
                <span className={labelClassName}>Name</span>
                <Input
                  value={setupDraft.name}
                  onChange={(event) =>
                    setSetupDraft({ ...setupDraft, name: event.currentTarget.value })
                  }
                />
              </label>
              <label className={fieldClassName}>
                <span className={labelClassName}>Scope</span>
                <select
                  className={selectClassName}
                  value={setupDraft.scope}
                  onChange={(event) =>
                    setSetupDraft({
                      ...setupDraft,
                      scope: event.currentTarget.value as CloudGuidedSetupDraft["scope"],
                    })
                  }
                >
                  <option value="personal">Personal</option>
                  <option value="team">Team</option>
                  <option value="default">Default</option>
                </select>
              </label>
              {setupDraft.scope === "default" ? null : (
                <label className={fieldClassName}>
                  <span className={labelClassName}>Owner</span>
                  <Input
                    value={setupDraft.owner}
                    onChange={(event) =>
                      setSetupDraft({ ...setupDraft, owner: event.currentTarget.value })
                    }
                  />
                </label>
              )}
              <label className={fieldClassName}>
                <span className={labelClassName}>Repository</span>
                <Input
                  value={setupDraft.repository}
                  onChange={(event) =>
                    setSetupDraft({ ...setupDraft, repository: event.currentTarget.value })
                  }
                />
              </label>
              <label className={fieldClassName}>
                <span className={labelClassName}>Default ref</span>
                <Input
                  value={setupDraft.defaultRef}
                  onChange={(event) =>
                    setSetupDraft({ ...setupDraft, defaultRef: event.currentTarget.value })
                  }
                />
              </label>
              <label className={fieldClassName}>
                <span className={labelClassName}>Base</span>
                <select
                  className={selectClassName}
                  value={setupDraft.baseKind}
                  onChange={(event) =>
                    setSetupDraft({
                      ...setupDraft,
                      baseKind: event.currentTarget.value as CloudGuidedSetupDraft["baseKind"],
                    })
                  }
                >
                  <option value="image">Image</option>
                  <option value="dockerfile">Dockerfile</option>
                </select>
              </label>
              <label className={fieldClassName}>
                <span className={labelClassName}>
                  {setupDraft.baseKind === "image" ? "Image" : "Dockerfile path"}
                </span>
                <Input
                  value={setupDraft.baseKind === "image" ? setupDraft.image : setupDraft.dockerfile}
                  onChange={(event) =>
                    setSetupDraft(
                      setupDraft.baseKind === "image"
                        ? { ...setupDraft, image: event.currentTarget.value }
                        : { ...setupDraft, dockerfile: event.currentTarget.value },
                    )
                  }
                />
              </label>
              <label className={fieldClassName}>
                <span className={labelClassName}>Install command</span>
                <Input
                  value={setupDraft.install}
                  onChange={(event) =>
                    setSetupDraft({ ...setupDraft, install: event.currentTarget.value })
                  }
                />
              </label>
              <label className={fieldClassName}>
                <span className={labelClassName}>Start command</span>
                <Input
                  value={setupDraft.start}
                  onChange={(event) =>
                    setSetupDraft({ ...setupDraft, start: event.currentTarget.value })
                  }
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              Saving starts a Build that tests this version. The last successful Build keeps serving
              runs unless the new one succeeds.
            </p>
            <div className="flex items-center gap-2">
              <Button size="xs" type="submit" disabled={busy !== null}>
                {busy === "guided-setup" ? "Testing…" : "Save and test"}
              </Button>
              <Button
                size="xs"
                type="button"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setSetupOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </SettingsSection>

      <SettingsSection id="cloud-scm" title="Source-control connections">
        <p className="text-xs text-muted-foreground">
          Connect GitHub, GitHub Enterprise, GitLab, Bitbucket, or Azure DevOps. Each agent only
          reaches repositories in the intersection of the app install, the triggering principal, and
          the agent's configured scope.
        </p>
        {scmConnections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No source-control apps connected yet.</p>
        ) : (
          <ul className="text-sm">
            {scmConnections.map((connection) => (
              <li key={connection.id} className="flex items-center justify-between gap-2 py-1">
                <span>
                  {connection.displayName} · {connection.kind} ·{" "}
                  {connection.installedRepositories.join(", ")}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      "scm",
                      async () => {
                        const result = await disconnectScm({
                          environmentId,
                          input: { connectionId: connection.id },
                        });
                        if (result._tag === "Success") {
                          setScmConnections((current) =>
                            current.filter((row) => row.id !== connection.id),
                          );
                        }
                        return result;
                      },
                      "Could not disconnect that source-control app.",
                    )
                  }
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <label className={fieldClassName}>
            <span className={labelClassName}>Host</span>
            <select
              className={selectClassName}
              value={scmDraft.kind}
              onChange={(event) =>
                setScmDraft({ ...scmDraft, kind: event.currentTarget.value as CloudScmHostKind })
              }
            >
              <option value="github">GitHub</option>
              <option value="github-enterprise">GitHub Enterprise</option>
              <option value="gitlab">GitLab</option>
              <option value="gitlab-self-hosted">GitLab self-hosted</option>
              <option value="bitbucket">Bitbucket</option>
              <option value="azure-devops">Azure DevOps</option>
            </select>
          </label>
          <label className={fieldClassName}>
            <span className={labelClassName}>Name</span>
            <Input
              value={scmDraft.displayName}
              onChange={(event) =>
                setScmDraft({ ...scmDraft, displayName: event.currentTarget.value })
              }
            />
          </label>
          <label className={fieldClassName}>
            <span className={labelClassName}>Base URL</span>
            <Input
              value={scmDraft.baseUrl}
              onChange={(event) => setScmDraft({ ...scmDraft, baseUrl: event.currentTarget.value })}
            />
          </label>
          <label className={fieldClassName}>
            <span className={labelClassName}>Installed repositories</span>
            <Input
              value={scmDraft.installedRepositories}
              placeholder="owner/app, owner/*"
              onChange={(event) =>
                setScmDraft({ ...scmDraft, installedRepositories: event.currentTarget.value })
              }
            />
          </label>
        </div>
        <Button
          size="xs"
          disabled={busy !== null}
          onClick={() =>
            void run(
              "scm",
              async () => {
                const installedRepositories = scmDraft.installedRepositories
                  .split(",")
                  .map((value) => value.trim())
                  .filter((value) => value.length > 0);
                const result = await connectScm({
                  environmentId,
                  input: {
                    kind: scmDraft.kind,
                    displayName: scmDraft.displayName.trim() || scmDraft.kind,
                    baseUrl: scmDraft.baseUrl.trim(),
                    installedRepositories,
                  },
                });
                if (result._tag === "Success") {
                  setScmConnections((current) => [...current, result.value]);
                }
                return result;
              },
              "Could not connect that source-control app.",
            )
          }
        >
          Connect
        </Button>
      </SettingsSection>

      <SettingsSection id="cloud-defaults" title="Defaults and policy">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={fieldClassName}>
            <span className={labelClassName}>Default model</span>
            <Input
              value={defaultsDraft.model}
              onChange={(event) =>
                setDefaultsDraft({ ...defaultsDraft, model: event.currentTarget.value })
              }
            />
          </label>
          <label className={fieldClassName}>
            <span className={labelClassName}>Context</span>
            <Input
              value={defaultsDraft.context}
              onChange={(event) =>
                setDefaultsDraft({ ...defaultsDraft, context: event.currentTarget.value })
              }
            />
          </label>
          <label className={fieldClassName}>
            <span className={labelClassName}>Default repository</span>
            <Input
              value={defaultsDraft.repository}
              onChange={(event) =>
                setDefaultsDraft({ ...defaultsDraft, repository: event.currentTarget.value })
              }
            />
          </label>
          <label className={fieldClassName}>
            <span className={labelClassName}>Default ref</span>
            <Input
              value={defaultsDraft.ref}
              onChange={(event) =>
                setDefaultsDraft({ ...defaultsDraft, ref: event.currentTarget.value })
              }
            />
          </label>
          <label className={fieldClassName}>
            <span className={labelClassName}>Team follow-ups</span>
            <select
              className={selectClassName}
              value={defaultsDraft.collaboration}
              onChange={(event) =>
                setDefaultsDraft({
                  ...defaultsDraft,
                  collaboration: event.currentTarget.value as
                    | "disabled"
                    | "service-accounts"
                    | "all",
                })
              }
            >
              <option value="disabled">Disabled</option>
              <option value="service-accounts">Service accounts only</option>
              <option value="all">All teammates</option>
            </select>
          </label>
          <label className={fieldClassName}>
            <span className={labelClassName}>Self-hosted machines</span>
            <select
              className={selectClassName}
              value={defaultsDraft.selfHostedMode}
              onChange={(event) =>
                setDefaultsDraft({
                  ...defaultsDraft,
                  selfHostedMode: event.currentTarget.value as "off" | "allow" | "require",
                })
              }
            >
              <option value="off">Off</option>
              <option value="allow">Allow</option>
              <option value="require">Require</option>
            </select>
          </label>
        </div>
        {defaultsDraft.collaboration === "disabled" ? null : (
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            <li>
              Teammate follow-ups can reach repositories and threads the follower did not create.
              Treat that as lateral access.
            </li>
            <li>
              A follow-up can observe runtime-redacted secrets already bound to the agent. Disable
              team follow-ups if that is too wide.
            </li>
          </ul>
        )}
        <div className="flex flex-wrap gap-4 text-sm">
          {(
            [
              ["longRunning", "Long-running"],
              ["computerUse", "Computer use"],
              ["summaries", "Summaries"],
              ["artifactsToGit", "Artifacts to Git"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={defaultsDraft[key]}
                onChange={(event) =>
                  setDefaultsDraft({ ...defaultsDraft, [key]: event.currentTarget.checked })
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div>
          <Button size="xs" disabled={busy !== null} onClick={saveDefaults}>
            {busy === "defaults" ? "Saving…" : "Save defaults"}
          </Button>
        </div>
        <Facts
          rows={selfHostedLaunchPreview({
            policy: defaultsDraft.selfHostedMode,
            target: defaultsDraft.selfHostedMode === "off" ? "cloud" : "pool",
          }).differences.map(
            (row) => [row.area, `Managed: ${row.managed} Self-hosted: ${row.selfHosted}`] as const,
          )}
        />
        <div className="grid gap-3 sm:grid-cols-4">
          <label className={fieldClassName}>
            <span className={labelClassName}>Spend principal</span>
            <select
              className={selectClassName}
              value={spendDraft.kind}
              onChange={(event) =>
                setSpendDraft({
                  ...spendDraft,
                  kind: event.currentTarget.value as "user" | "team" | "service-account",
                })
              }
            >
              <option value="user">User</option>
              <option value="team">Team</option>
              <option value="service-account">Service account</option>
            </select>
          </label>
          <label className={fieldClassName}>
            <span className={labelClassName}>Principal id</span>
            <Input
              value={spendDraft.id}
              onChange={(event) => setSpendDraft({ ...spendDraft, id: event.currentTarget.value })}
            />
          </label>
          <label className={fieldClassName}>
            <span className={labelClassName}>Period</span>
            <select
              className={selectClassName}
              value={spendDraft.period}
              onChange={(event) =>
                setSpendDraft({
                  ...spendDraft,
                  period: event.currentTarget.value as "daily" | "monthly",
                })
              }
            >
              <option value="daily">Daily</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label className={fieldClassName}>
            <span className={labelClassName}>Cap USD</span>
            <Input
              value={spendDraft.capUsd}
              placeholder="empty removes"
              onChange={(event) =>
                setSpendDraft({ ...spendDraft, capUsd: event.currentTarget.value })
              }
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" disabled={busy !== null} onClick={saveSpendLimit}>
            {busy === "spend" ? "Saving…" : "Save spend limit"}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy !== null} onClick={downloadUsage}>
            {busy === "export" ? "Exporting…" : "Export usage"}
          </Button>
        </div>
        {snapshot?.spendLimits !== undefined && snapshot.spendLimits.length > 0 ? (
          <Facts
            rows={snapshot.spendLimits.map((limit) => [
              `${limit.principal.kind} ${limit.principal.id} ${limit.period}`,
              `$${limit.usedUsd} of $${limit.capUsd} · ${snapshot.spendingControl}`,
            ])}
          />
        ) : null}
        {exportText !== null ? (
          <pre className="max-h-48 overflow-auto rounded-lg border border-border p-2 text-xs">
            {exportText}
          </pre>
        ) : null}
        <Facts
          rows={[
            [
              "Snapshot retention",
              `${report.snapshotPolicy.snapshotRetentionDays} d idle · ${report.snapshotPolicy.hibernatedRuntimes} hibernated · ${report.snapshotPolicy.recordedDeletions} deleted`,
            ],
            [
              "Conversations",
              report.snapshotPolicy.conversationRetentionDays === 0
                ? "kept indefinitely"
                : `${report.snapshotPolicy.conversationRetentionDays} d`,
            ],
            ["Idle release", seconds(report.snapshotPolicy.idleReleaseSeconds)],
            ["Instance types", report.settings.allowedInstanceTypes.join(", ")],
          ]}
        />
      </SettingsSection>

      <SettingsSection id="cloud-config-precedence" title="Config source and precedence">
        <ol className="flex flex-col gap-1.5 text-sm">
          {report.settings.configPrecedence.map((entry) => (
            <li key={entry.rank} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-muted-foreground">{entry.rank}.</span>
              <span className="font-medium text-foreground">{entry.label}</span>
              <span
                className={entry.present ? "text-success text-xs" : "text-muted-foreground text-xs"}
              >
                {entry.present ? "in use" : "none saved"}
              </span>
              <span className="w-full text-xs text-muted-foreground">{entry.description}</span>
            </li>
          ))}
        </ol>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function CloudAgentsSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const supportsCloud =
    environmentId !== null &&
    serverConfigs.get(environmentId)?.environment.capabilities.cloudAllocations === true;

  if (environmentId === null || !supportsCloud) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Cloud agents">
          <p className="text-sm text-muted-foreground">
            This environment does not host the cloud controller, so it has no AWS stack to
            administer.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return <CloudAgentsSettingsForEnvironment environmentId={environmentId} />;
}
