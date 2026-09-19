/**
 * Spend limits, attributions, invoices, and the administrative audit log.
 *
 * Usage meters are derived from allocation events. This catalog only stores
 * operator decisions and invoice facts the events cannot reconstruct.
 */
import {
  CloudAuditEvent,
  CloudInvoiceLine,
  CloudSpendLimitInput,
  CloudSpendPeriod,
  CloudSpendPrincipal,
  CloudSpendPrincipalKind,
  RunAllocationId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const EmptyRequest = Schema.Struct({});
const encodeInvoice = Schema.encodeSync(Schema.fromJsonString(CloudInvoiceLine));
const encodeAudit = Schema.encodeSync(Schema.fromJsonString(CloudAuditEvent));

const LimitRow = Schema.Struct({
  principalKind: CloudSpendPrincipalKind,
  principalId: TrimmedNonEmptyString,
  period: CloudSpendPeriod,
  capUsd: Schema.Finite,
  updatedAt: Schema.String,
});

const AttributionRow = Schema.Struct({
  allocationId: RunAllocationId,
  principalKind: CloudSpendPrincipalKind,
  principalId: TrimmedNonEmptyString,
  attributedAt: Schema.String,
});

const InvoiceRow = Schema.Struct({
  invoice: Schema.fromJsonString(CloudInvoiceLine),
});

const AuditRow = Schema.Struct({
  event: Schema.fromJsonString(CloudAuditEvent),
});

export const make = Effect.fn("cloud.CloudAccountingCatalog.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readLimits = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: LimitRow,
    execute: () => sql`
      SELECT
        principal_kind AS "principalKind",
        principal_id AS "principalId",
        period,
        cap_usd AS "capUsd",
        updated_at AS "updatedAt"
      FROM cloud_spend_limits
      ORDER BY principal_kind ASC, principal_id ASC, period ASC
    `,
  });

  const writeLimit = SqlSchema.void({
    Request: CloudSpendLimitInput,
    execute: (input) => sql`
      INSERT INTO cloud_spend_limits (
        principal_kind, principal_id, period, cap_usd, updated_at
      ) VALUES (
        ${input.principal.kind},
        ${input.principal.id},
        ${input.period},
        ${input.capUsd ?? 0},
        ${input.occurredAt}
      )
      ON CONFLICT(principal_kind, principal_id, period) DO UPDATE SET
        cap_usd = excluded.cap_usd,
        updated_at = excluded.updated_at
    `,
  });

  const deleteLimit = SqlSchema.void({
    Request: CloudSpendLimitInput,
    execute: (input) => sql`
      DELETE FROM cloud_spend_limits
      WHERE principal_kind = ${input.principal.kind}
        AND principal_id = ${input.principal.id}
        AND period = ${input.period}
    `,
  });

  const readAttributions = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: AttributionRow,
    execute: () => sql`
      SELECT
        allocation_id AS "allocationId",
        principal_kind AS "principalKind",
        principal_id AS "principalId",
        attributed_at AS "attributedAt"
      FROM cloud_spend_attributions
    `,
  });

  const writeAttribution = SqlSchema.void({
    Request: Schema.Struct({
      allocationId: RunAllocationId,
      principal: CloudSpendPrincipal,
      attributedAt: Schema.String,
    }),
    execute: (input) => sql`
      INSERT INTO cloud_spend_attributions (
        allocation_id, principal_kind, principal_id, attributed_at
      ) VALUES (
        ${input.allocationId},
        ${input.principal.kind},
        ${input.principal.id},
        ${input.attributedAt}
      )
      ON CONFLICT(allocation_id) DO NOTHING
    `,
  });

  const readInvoices = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: InvoiceRow,
    execute: () => sql`
      SELECT invoice_json AS invoice
      FROM cloud_invoices
      ORDER BY recorded_at DESC, invoice_id ASC
    `,
  });

  const writeInvoice = SqlSchema.void({
    Request: CloudInvoiceLine,
    execute: (invoice) => sql`
      INSERT INTO cloud_invoices (invoice_id, invoice_json, recorded_at)
      VALUES (${invoice.id}, ${encodeInvoice(invoice)}, ${invoice.recordedAt})
    `,
  });

  const readAudit = SqlSchema.findAll({
    Request: Schema.Struct({ limit: Schema.Int }),
    Result: AuditRow,
    execute: ({ limit }) => sql`
      SELECT event_json AS event
      FROM cloud_audit_events
      ORDER BY occurred_at DESC, event_id DESC
      LIMIT ${limit}
    `,
  });

  const writeAudit = SqlSchema.void({
    Request: CloudAuditEvent,
    execute: (event) => sql`
      INSERT INTO cloud_audit_events (event_id, occurred_at, event_json)
      VALUES (${event.id}, ${event.occurredAt}, ${encodeAudit(event)})
    `,
  });

  return {
    listLimitRows: () => readLimits({}),
    upsertLimit: (input: CloudSpendLimitInput) =>
      input.capUsd === null ? deleteLimit(input) : writeLimit(input),
    listAttributions: () => readAttributions({}),
    attribute: writeAttribution,
    listInvoices: () => readInvoices({}).pipe(Effect.map((rows) => rows.map((row) => row.invoice))),
    recordInvoice: writeInvoice,
    listAudit: (limit = 100) =>
      readAudit({ limit }).pipe(Effect.map((rows) => rows.map((row) => row.event))),
    appendAudit: writeAudit,
  } as const;
});
