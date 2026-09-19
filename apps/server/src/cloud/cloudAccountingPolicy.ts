import {
  DEFAULT_CLOUD_SPEND_PRINCIPAL,
  type CloudAuditAction,
  type CloudInvoiceLine,
  type CloudSpendLimit,
  type CloudSpendPeriod,
  type CloudSpendPrincipal,
  type CloudUsageDimension,
  type CloudUsageExport,
  type CloudUsageExportLine,
  type CloudUsageMeter,
  type CloudRunCostCategory,
  type CloudRunUsage,
  type RunAllocationEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e6) / 1e6;
}

export function principalFromApiKey(input: {
  readonly kind: "user" | "service_account";
  readonly principalId: string;
}): CloudSpendPrincipal {
  return {
    kind: input.kind === "service_account" ? "service-account" : "user",
    id: input.principalId,
  };
}

export function principalOf(
  principal: CloudSpendPrincipal | undefined,
): CloudSpendPrincipal {
  return principal ?? DEFAULT_CLOUD_SPEND_PRINCIPAL;
}

function parseMillis(value: string): number | undefined {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
}

function isoUtc(millis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(millis));
}

/** UTC day or month that contains `now`. */
export function spendPeriodWindow(
  period: CloudSpendPeriod,
  nowIso: string,
): { readonly start: string; readonly end: string } {
  const now = parseMillis(nowIso) ?? 0;
  const date = new Date(now);
  if (period === "daily") {
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return { start: isoUtc(start), end: isoUtc(start + 86_400_000) };
  }
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { start: isoUtc(start), end: isoUtc(end) };
}

function intervalSeconds(
  events: ReadonlyArray<RunAllocationEvent>,
  startTypes: ReadonlySet<RunAllocationEvent["type"]>,
  stopTypes: ReadonlySet<RunAllocationEvent["type"]>,
  nowMs: number,
): number {
  let openSince: number | undefined;
  let total = 0;
  for (const event of events) {
    const at = parseMillis(event.occurredAt);
    if (at === undefined) continue;
    if (startTypes.has(event.type) && openSince === undefined) {
      openSince = at;
      continue;
    }
    if (stopTypes.has(event.type) && openSince !== undefined) {
      total += Math.max(0, at - openSince);
      openSince = undefined;
    }
  }
  if (openSince !== undefined) total += Math.max(0, nowMs - openSince);
  return Math.ceil(total / 1_000);
}

const GUEST_START = new Set<RunAllocationEvent["type"]>([
  "allocation.instance-launched",
  "allocation.runtime-restored",
]);
const GUEST_STOP = new Set<RunAllocationEvent["type"]>([
  "allocation.went-idle",
  "allocation.hibernated",
  "allocation.cleanup-succeeded",
]);
const SLOT_START = new Set<RunAllocationEvent["type"]>([
  "allocation.instance-launched",
  "allocation.runtime-restored",
]);
const SLOT_STOP = new Set<RunAllocationEvent["type"]>([
  "allocation.hibernated",
  "allocation.cleanup-succeeded",
]);
const PREVIEW_START = new Set<RunAllocationEvent["type"]>(["allocation.preview-published"]);
const PREVIEW_STOP = new Set<RunAllocationEvent["type"]>([
  "allocation.preview-withdrawn",
  "allocation.hibernated",
  "allocation.cleanup-succeeded",
]);

function unknown(reason: string): CloudRunCostCategory {
  return { status: "unknown", reason };
}

function estimated(usd: number, assumption: string): CloudRunCostCategory {
  return { status: "estimated", usd: roundUsd(usd), assumption };
}

function notAttributed(reason: string): CloudRunCostCategory {
  return { status: "not-attributed", reason };
}

function hourlyCost(
  seconds: number,
  hourlyUsd: number | undefined,
  assumption: string,
  missing: string,
): CloudRunCostCategory {
  if (hourlyUsd === undefined) return unknown(missing);
  return estimated((seconds / 3_600) * hourlyUsd, assumption);
}

const DIMENSIONS: ReadonlyArray<CloudUsageDimension> = [
  "model-tokens",
  "context-window",
  "active-guest-time",
  "hypervisor-allocation",
  "snapshots",
  "artifacts-transfer",
  "previews",
  "external-provider",
];

export function cloudUsageMeters(input: {
  readonly events: ReadonlyArray<RunAllocationEvent>;
  readonly nowMs: number;
  readonly hourlyUsd?: number | undefined;
  readonly rateAssumption?: string | undefined;
  readonly hasSnapshot: boolean;
  readonly tokenQuantity?: number | undefined;
}): ReadonlyArray<CloudUsageMeter> {
  const guestSeconds = intervalSeconds(input.events, GUEST_START, GUEST_STOP, input.nowMs);
  const slotSeconds = intervalSeconds(input.events, SLOT_START, SLOT_STOP, input.nowMs);
  const previewSeconds = intervalSeconds(input.events, PREVIEW_START, PREVIEW_STOP, input.nowMs);
  const idleSlotSeconds = Math.max(0, slotSeconds - guestSeconds);
  const guestCost = hourlyCost(
    guestSeconds,
    input.hourlyUsd,
    input.rateAssumption ?? "Guest runtime at the configured hourly rate.",
    "No worker hourly-rate assumption is configured for this instance type.",
  );
  const hypervisorCost =
    idleSlotSeconds === 0
      ? notAttributed("Hypervisor slot time while a guest is busy is counted as active guest time.")
      : hourlyCost(
          idleSlotSeconds,
          input.hourlyUsd,
          "Idle hypervisor slot occupancy after the guest settled, before snapshot.",
          "No worker hourly-rate assumption is configured for this instance type.",
        );
  const snapshotQuantity = input.hasSnapshot ? 1 : 0;
  const tokenQuantity = input.tokenQuantity ?? 0;
  return [
    {
      dimension: "model-tokens",
      quantity: tokenQuantity,
      unit: "tokens",
      cost:
        input.tokenQuantity === undefined
          ? unknown("The selected provider does not report attributable token usage.")
          : estimated(0, "Token quantity is recorded; model invoices supply the dollar amount."),
    },
    {
      dimension: "context-window",
      quantity: 0,
      unit: "tokens",
      cost: unknown("Context-window occupancy is not metered by the controller."),
    },
    {
      dimension: "active-guest-time",
      quantity: guestSeconds,
      unit: "seconds",
      cost: guestCost,
    },
    {
      dimension: "hypervisor-allocation",
      quantity: slotSeconds,
      unit: "seconds",
      cost: hypervisorCost,
    },
    {
      dimension: "snapshots",
      quantity: snapshotQuantity,
      unit: "snapshots",
      cost:
        snapshotQuantity === 0
          ? notAttributed("This allocation has no retained runtime snapshot.")
          : unknown("Snapshot storage is billed by AWS; invoice reconciliation supplies the charge."),
    },
    {
      dimension: "artifacts-transfer",
      quantity: 0,
      unit: "bytes",
      cost: unknown("Artifact storage and transfer are billed separately from compute."),
    },
    {
      dimension: "previews",
      quantity: previewSeconds,
      unit: "seconds",
      cost: unknown("Preview and display transfer are not metered by the controller."),
    },
    {
      dimension: "external-provider",
      quantity: 0,
      unit: "units",
      cost: unknown("External provider usage remains unknown until the vendor reports it."),
    },
  ];
}

export function estimatedUsageUsd(usage: CloudRunUsage): number {
  const fromMeters = (usage.meters ?? []).reduce((total, meter) => {
    return meter.cost.status === "estimated" ? total + meter.cost.usd : total;
  }, 0);
  if ((usage.meters ?? []).length > 0) return roundUsd(fromMeters);
  const worker = usage.costs.workerCompute;
  const host = usage.costs.dedicatedHost;
  return roundUsd(
    (worker.status === "estimated" ? worker.usd : 0) +
      (host?.status === "estimated" ? host.usd : 0),
  );
}

export function applicableSpendLimits(
  principal: CloudSpendPrincipal,
  limits: ReadonlyArray<CloudSpendLimit>,
): ReadonlyArray<CloudSpendLimit> {
  return limits.filter(
    (limit) =>
      limit.principal.kind === "team" ||
      (limit.principal.kind === principal.kind && limit.principal.id === principal.id),
  );
}

export function admitSpendLimit(input: {
  readonly principal: CloudSpendPrincipal;
  readonly limits: ReadonlyArray<CloudSpendLimit>;
}): { readonly status: "ok" } | { readonly status: "rejected"; readonly message: string } {
  if (input.limits.length === 0) return { status: "ok" };
  for (const limit of applicableSpendLimits(input.principal, input.limits)) {
    if (limit.usedUsd >= limit.capUsd) {
      return {
        status: "rejected",
        message: `Spend limit reached for ${limit.principal.kind} '${limit.principal.id}' (${limit.period} cap $${limit.capUsd}). Cleanup and retained results remain available.`,
      };
    }
  }
  return { status: "ok" };
}

export function spendLimitStatus(input: {
  readonly principal: CloudSpendPrincipal;
  readonly period: CloudSpendPeriod;
  readonly capUsd: number;
  readonly usedUsd: number;
  readonly nowIso: string;
}): CloudSpendLimit {
  const window = spendPeriodWindow(input.period, input.nowIso);
  const usedUsd = roundUsd(Math.max(0, input.usedUsd));
  return {
    principal: input.principal,
    period: input.period,
    capUsd: input.capUsd,
    usedUsd,
    remainingUsd: roundUsd(Math.max(0, input.capUsd - usedUsd)),
    periodStart: window.start,
    periodEnd: window.end,
  };
}

function meterQuantity(
  usages: ReadonlyArray<CloudRunUsage>,
  dimension: CloudUsageDimension,
): { quantity: number; unit: string; estimatedUsd?: number; unknownReason?: string } {
  let quantity = 0;
  let unit = "units";
  let estimatedUsd = 0;
  let sawEstimate = false;
  let unknownReason: string | undefined;
  for (const usage of usages) {
    for (const meter of usage.meters ?? []) {
      if (meter.dimension !== dimension) continue;
      quantity += meter.quantity;
      unit = meter.unit;
      if (meter.cost.status === "estimated") {
        estimatedUsd += meter.cost.usd;
        sawEstimate = true;
      } else if (meter.cost.status === "unknown") {
        unknownReason = meter.cost.reason;
      }
    }
  }
  return {
    quantity,
    unit,
    ...(sawEstimate ? { estimatedUsd: roundUsd(estimatedUsd) } : {}),
    ...(unknownReason === undefined ? {} : { unknownReason }),
  };
}

export function reconcileInvoices(input: {
  readonly invoices: ReadonlyArray<Omit<CloudInvoiceLine, "estimatedUsd" | "varianceUsd">>;
  readonly usages: ReadonlyArray<CloudRunUsage>;
}): ReadonlyArray<CloudInvoiceLine> {
  return input.invoices.map((invoice) => {
    const inPeriod = input.usages.filter((usage) => {
      const at = parseMillis(usage.calculatedAt) ?? 0;
      const start = parseMillis(invoice.periodStart) ?? 0;
      const end = parseMillis(invoice.periodEnd) ?? 0;
      return at >= start && at < end;
    });
    const estimatedUsd = meterQuantity(inPeriod, invoice.dimension).estimatedUsd ?? 0;
    return {
      ...invoice,
      estimatedUsd: roundUsd(estimatedUsd),
      varianceUsd: roundUsd(invoice.invoicedUsd - estimatedUsd),
    };
  });
}

export function exportUsageReport(input: {
  readonly generatedAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly usages: ReadonlyArray<CloudRunUsage>;
  readonly spendLimits: ReadonlyArray<CloudSpendLimit>;
  readonly invoices: ReadonlyArray<CloudInvoiceLine>;
}): CloudUsageExport {
  const start = parseMillis(input.periodStart) ?? 0;
  const end = parseMillis(input.periodEnd) ?? 0;
  const usages = input.usages.filter((usage) => {
    const at = parseMillis(usage.calculatedAt) ?? 0;
    return at >= start && at < end;
  });
  const invoices = input.invoices.filter((invoice) => invoice.periodStart === input.periodStart);
  const lines: CloudUsageExportLine[] = DIMENSIONS.map((dimension) => {
    const totals = meterQuantity(usages, dimension);
    const invoice = invoices.find((line) => line.dimension === dimension);
    return {
      dimension,
      quantity: totals.quantity,
      unit: totals.unit,
      ...(totals.estimatedUsd === undefined ? {} : { estimatedUsd: totals.estimatedUsd }),
      ...(invoice === undefined ? {} : { invoicedUsd: invoice.invoicedUsd }),
      ...(invoice === undefined ? {} : { varianceUsd: invoice.varianceUsd }),
      ...(totals.unknownReason === undefined ? {} : { unknownReason: totals.unknownReason }),
    };
  });
  return {
    generatedAt: input.generatedAt,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    redactions: { prompts: true, secrets: true },
    lines,
    spendLimits: input.spendLimits,
    invoices,
  };
}

const PROMPT_OR_SECRET = /\b(prompt|password|secret|token|authorization|sk-[a-z0-9]+)\b/i;

export function auditEvent(input: {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor?: CloudSpendPrincipal | undefined;
  readonly action: CloudAuditAction;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly summary: string;
}): {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor: CloudSpendPrincipal;
  readonly action: CloudAuditAction;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly summary: string;
} {
  const summary = PROMPT_OR_SECRET.test(input.summary)
    ? `${input.action} on ${input.resourceType} '${input.resourceId}'.`
    : input.summary;
  return {
    id: input.id,
    occurredAt: input.occurredAt,
    actor: principalOf(input.actor),
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    summary,
  };
}

export function auditActionForCommand(
  type: RunAllocationEvent["type"] | string,
): CloudAuditAction | undefined {
  switch (type) {
    case "allocation.launch":
    case "allocation.follow-up":
    case "allocation.retry":
    case "allocation.cancel":
    case "allocation.expire":
    case "allocation.agent-started":
    case "allocation.agent-succeeded":
    case "allocation.agent-failed":
      return "run-lifecycle";
    case "allocation.agent-archive":
    case "allocation.agent-unarchive":
    case "allocation.agent-delete":
      return "agent-lifecycle";
    case "allocation.hibernate":
    case "allocation.runtime-restored":
    case "allocation.snapshot-expire":
      return "snapshot";
    case "allocation.preview-published":
    case "allocation.preview-withdrawn":
      return "artifact";
    default:
      return undefined;
  }
}
