import {
  cloudEnvironmentBase,
  type CloudControllerDefaults,
  type CloudEnvironment,
  type CloudEnvironmentSource,
  type CloudGuidedSetupInput,
  type CloudReadinessCheck,
  type CloudReadinessCheckOutcome,
  type CloudReadinessReport,
} from "@t3tools/contracts";

export type CloudReadinessTone = "ok" | "problem" | "muted";

export interface CloudReadinessCheckRow {
  readonly id: CloudReadinessCheck["id"];
  readonly title: string;
  readonly description: string;
  readonly optional: boolean;
  readonly statusLabel: string;
  readonly tone: CloudReadinessTone;
  readonly detail: string | null;
  readonly remedy: string | null;
  readonly checkedAt: string | null;
}

function checkTone(outcome: CloudReadinessCheckOutcome, optional: boolean): CloudReadinessTone {
  if (outcome.status === "passed") return "ok";
  if (outcome.status === "failed") return optional ? "muted" : "problem";
  return "muted";
}

const CHECK_STATUS_LABELS = {
  unchecked: "Not run",
  passed: "Passing",
  failed: "Failing",
  skipped: "Not applicable",
} as const;

export function cloudReadinessCheckRows(
  report: CloudReadinessReport,
): ReadonlyArray<CloudReadinessCheckRow> {
  return report.checks.map((check) => ({
    id: check.id,
    title: check.title,
    description: check.description,
    optional: check.optional,
    statusLabel: CHECK_STATUS_LABELS[check.outcome.status],
    tone: checkTone(check.outcome, check.optional),
    detail: check.outcome.status === "unchecked" ? null : check.outcome.detail,
    remedy: check.outcome.status === "failed" ? check.outcome.remedy : null,
    checkedAt: check.outcome.status === "unchecked" ? null : check.outcome.checkedAt,
  }));
}

/**
 * One line an operator can read before deciding whether to launch anything.
 * Admission and the cutover fence outrank a failing probe, because both stop
 * new work outright.
 */
export function cloudReadinessHeadline(report: CloudReadinessReport): {
  readonly tone: CloudReadinessTone;
  readonly label: string;
} {
  const { controller } = report.health;
  if (controller.writability?.status === "fenced") {
    return { tone: "problem", label: "Fenced for a cutover. Adopt this host to write again." };
  }
  if (controller.admission.status === "stopped") {
    return {
      tone: "muted",
      label: "Admission stopped. Active runs, snapshots, cleanup, and review continue.",
    };
  }
  if (!report.health.requiredChecksPassing) {
    return {
      tone: "problem",
      label: `${report.health.failedCheckIds.length} required check${
        report.health.failedCheckIds.length === 1 ? "" : "s"
      } failing.`,
    };
  }
  const unchecked = report.checks.filter(
    (check) => !check.optional && check.outcome.status === "unchecked",
  ).length;
  return unchecked > 0
    ? { tone: "muted", label: `${unchecked} required checks have not been run yet.` }
    : { tone: "ok", label: "Accepting runs." };
}

export function cloudEnvironmentSourceLabel(source: CloudEnvironmentSource): string {
  return source.type === "repository"
    ? `${source.repository} · ${source.path}`
    : source.scope === "default"
      ? "Default environment"
      : `${source.scope === "personal" ? "Personal" : "Team"} · ${source.owner}`;
}

export interface CloudGuidedSetupDraft {
  readonly environmentId: string;
  readonly name: string;
  readonly scope: "personal" | "team" | "default";
  readonly owner: string;
  readonly repository: string;
  readonly defaultRef: string;
  readonly baseKind: "image" | "dockerfile";
  readonly image: string;
  readonly dockerfile: string;
  readonly install: string;
  readonly start: string;
}

export function createCloudGuidedSetupDraft(
  environment: CloudEnvironment | undefined,
  environmentId: string,
): CloudGuidedSetupDraft {
  const current = environment?.current;
  const base = current === undefined ? undefined : cloudEnvironmentBase(current.config);
  const source = current?.source;
  return {
    environmentId: environment?.id ?? environmentId,
    name: current?.name ?? "",
    scope: source !== undefined && source.type === "saved" ? source.scope : "personal",
    owner:
      source !== undefined && source.type === "saved" && source.scope !== "default"
        ? source.owner
        : "",
    repository: current?.repositories[0]?.repository ?? "",
    defaultRef: current?.repositories[0]?.defaultRef ?? "main",
    baseKind: base?.kind === "image" ? "image" : "dockerfile",
    image: base?.kind === "image" ? base.image : "",
    dockerfile: current?.config.build?.dockerfile ?? "Dockerfile",
    install: current?.config.install ?? "",
    start: current?.config.start ?? "",
  };
}

export type CloudGuidedSetupValidation =
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "valid"; readonly input: CloudGuidedSetupInput };

/**
 * A repository-owned environment is created by the agent-led setup flow, so
 * this form only ever writes a saved environment. Everything else it rejects
 * here rather than letting the controller reject it later.
 */
export function validateCloudGuidedSetupDraft(input: {
  readonly draft: CloudGuidedSetupDraft;
  readonly buildId: string;
  readonly expectedVersion: number | undefined;
  readonly occurredAt: string;
}): CloudGuidedSetupValidation {
  const draft = input.draft;
  const name = draft.name.trim();
  const repository = draft.repository.trim();
  const defaultRef = draft.defaultRef.trim();
  const owner = draft.owner.trim();
  if (name.length === 0) return { status: "invalid", message: "Name the environment." };
  if (repository.length === 0) {
    return { status: "invalid", message: "Choose the repository this environment builds." };
  }
  if (defaultRef.length === 0) {
    return { status: "invalid", message: "Choose the ref its Builds clone by default." };
  }
  if (draft.scope !== "default" && owner.length === 0) {
    return { status: "invalid", message: `A ${draft.scope} environment needs an owner.` };
  }
  const base =
    draft.baseKind === "image"
      ? { kind: "image" as const, image: draft.image.trim() }
      : { kind: "dockerfile" as const, dockerfile: draft.dockerfile.trim() };
  if (base.kind === "image" && base.image.length === 0) {
    return { status: "invalid", message: "Give the base image to start from." };
  }
  if (base.kind === "dockerfile" && base.dockerfile.length === 0) {
    return { status: "invalid", message: "Give the Dockerfile path to build from." };
  }
  const install = draft.install.trim();
  const start = draft.start.trim();
  return {
    status: "valid",
    input: {
      environmentId: draft.environmentId as CloudGuidedSetupInput["environmentId"],
      buildId: input.buildId as CloudGuidedSetupInput["buildId"],
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      name,
      scope: draft.scope,
      ...(draft.scope === "default" ? {} : { owner }),
      repository,
      defaultRef,
      base,
      ...(install.length === 0 ? {} : { install }),
      ...(start.length === 0 ? {} : { start }),
      secretReferences: [],
      occurredAt: input.occurredAt,
    },
  };
}

/** Empty fields clear a default rather than storing a blank one. */
export function cloudControllerDefaultsFromDraft(draft: {
  readonly model: string;
  readonly context: string;
  readonly repository: string;
  readonly ref: string;
  readonly longRunning: boolean;
  readonly computerUse: boolean;
  readonly summaries: boolean;
  readonly artifactsToGit: boolean;
  readonly collaboration: "disabled" | "service-accounts" | "all";
}): CloudControllerDefaults {
  const model = draft.model.trim();
  const context = draft.context.trim();
  const repository = draft.repository.trim();
  const ref = draft.ref.trim();
  return {
    ...(model.length === 0 ? {} : { model }),
    ...(context.length === 0 ? {} : { context }),
    ...(repository.length === 0 ? {} : { repository }),
    ...(ref.length === 0 ? {} : { ref }),
    longRunning: draft.longRunning,
    computerUse: draft.computerUse,
    summaries: draft.summaries,
    artifactsToGit: draft.artifactsToGit,
    collaboration: draft.collaboration,
  };
}
