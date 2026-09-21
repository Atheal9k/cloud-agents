import * as Schema from "effect/Schema";

import { CloudCommitProvenance } from "./cloudCommitProvenance.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  RunAllocationId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Who a spend cap or audit row is about. Team caps apply to every admission. */
export const CloudSpendPrincipalKind = Schema.Literals(["user", "team", "service-account"]);
export type CloudSpendPrincipalKind = typeof CloudSpendPrincipalKind.Type;

export const CloudSpendPrincipal = Schema.Struct({
  kind: CloudSpendPrincipalKind,
  id: TrimmedNonEmptyString,
});
export type CloudSpendPrincipal = typeof CloudSpendPrincipal.Type;

export const DEFAULT_CLOUD_SPEND_PRINCIPAL: CloudSpendPrincipal = {
  kind: "user",
  id: "local-operator",
};

export const CloudSpendPeriod = Schema.Literals(["daily", "monthly"]);
export type CloudSpendPeriod = typeof CloudSpendPeriod.Type;

/**
 * Per-run meters that replace a single worker-instance estimate. Unknown is a
 * real answer: the controller must not invent model or invoice numbers.
 */
export const CloudUsageDimension = Schema.Literals([
  "model-tokens",
  "context-window",
  "active-guest-time",
  "hypervisor-allocation",
  "snapshots",
  "artifacts-transfer",
  "previews",
  "daytona-quota",
  "external-provider",
]);
export type CloudUsageDimension = typeof CloudUsageDimension.Type;

export const CloudSpendLimit = Schema.Struct({
  principal: CloudSpendPrincipal,
  period: CloudSpendPeriod,
  capUsd: NonNegativeFinite,
  usedUsd: NonNegativeFinite,
  remainingUsd: NonNegativeFinite,
  periodStart: IsoDateTime,
  periodEnd: IsoDateTime,
});
export type CloudSpendLimit = typeof CloudSpendLimit.Type;

export const CloudSpendLimitInput = Schema.Struct({
  principal: CloudSpendPrincipal,
  period: CloudSpendPeriod,
  /** `null` removes the cap so admission is estimate-only again for that principal. */
  capUsd: Schema.NullOr(NonNegativeFinite),
  occurredAt: IsoDateTime,
});
export type CloudSpendLimitInput = typeof CloudSpendLimitInput.Type;

export const CloudInvoiceSource = Schema.Literals(["aws", "daytona", "model-provider"]);
export type CloudInvoiceSource = typeof CloudInvoiceSource.Type;

export const CloudInvoiceLine = Schema.Struct({
  id: TrimmedNonEmptyString,
  source: CloudInvoiceSource,
  dimension: CloudUsageDimension,
  periodStart: IsoDateTime,
  periodEnd: IsoDateTime,
  invoicedUsd: NonNegativeFinite,
  estimatedUsd: NonNegativeFinite,
  varianceUsd: Schema.Finite,
  recordedAt: IsoDateTime,
});
export type CloudInvoiceLine = typeof CloudInvoiceLine.Type;

export const CloudInvoiceInput = Schema.Struct({
  source: CloudInvoiceSource,
  dimension: CloudUsageDimension,
  periodStart: IsoDateTime,
  periodEnd: IsoDateTime,
  invoicedUsd: NonNegativeFinite,
  occurredAt: IsoDateTime,
});
export type CloudInvoiceInput = typeof CloudInvoiceInput.Type;

export const CloudAuditAction = Schema.Literals([
  "auth",
  "config",
  "build-activation",
  "agent-lifecycle",
  "run-lifecycle",
  "snapshot",
  "artifact",
  "scm-publication",
  "secret-policy",
  "admin",
]);
export type CloudAuditAction = typeof CloudAuditAction.Type;

export const CloudAuditEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
  actor: CloudSpendPrincipal,
  action: CloudAuditAction,
  resourceType: TrimmedNonEmptyString,
  resourceId: TrimmedNonEmptyString,
  /** Operator-facing sentence. Never a prompt, secret, or credential. */
  summary: TrimmedNonEmptyString,
});
export type CloudAuditEvent = typeof CloudAuditEvent.Type;

export const CloudAuditListInput = Schema.Struct({
  limit: Schema.optionalKey(NonNegativeInt),
});
export type CloudAuditListInput = typeof CloudAuditListInput.Type;

export const CloudUsageExportLine = Schema.Struct({
  dimension: CloudUsageDimension,
  quantity: NonNegativeFinite,
  unit: TrimmedNonEmptyString,
  estimatedUsd: Schema.optionalKey(NonNegativeFinite),
  invoicedUsd: Schema.optionalKey(NonNegativeFinite),
  varianceUsd: Schema.optionalKey(Schema.Finite),
  unknownReason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudUsageExportLine = typeof CloudUsageExportLine.Type;

export const CloudUsageExport = Schema.Struct({
  generatedAt: IsoDateTime,
  periodStart: IsoDateTime,
  periodEnd: IsoDateTime,
  redactions: Schema.Struct({
    prompts: Schema.Literal(true),
    secrets: Schema.Literal(true),
  }),
  lines: Schema.Array(CloudUsageExportLine),
  spendLimits: Schema.Array(CloudSpendLimit),
  invoices: Schema.Array(CloudInvoiceLine),
  provenance: Schema.optionalKey(Schema.Array(CloudCommitProvenance)),
});
export type CloudUsageExport = typeof CloudUsageExport.Type;

export const CloudUsageExportInput = Schema.Struct({
  periodStart: IsoDateTime,
  periodEnd: IsoDateTime,
});
export type CloudUsageExportInput = typeof CloudUsageExportInput.Type;

export const CloudCollaborationDefault = Schema.Literals(["disabled", "service-accounts", "all"]);
export type CloudCollaborationDefault = typeof CloudCollaborationDefault.Type;

export const CloudSpendAttribution = Schema.Struct({
  allocationId: RunAllocationId,
  principal: CloudSpendPrincipal,
  attributedAt: IsoDateTime,
});
export type CloudSpendAttribution = typeof CloudSpendAttribution.Type;
