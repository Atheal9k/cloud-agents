import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CloudAuditEvent,
  CloudSpendLimitInput,
  CloudUsageExport,
  DEFAULT_CLOUD_SPEND_PRINCIPAL,
} from "./cloudAccounting.ts";

const decodeAudit = Schema.decodeUnknownSync(CloudAuditEvent);
const decodeLimit = Schema.decodeUnknownSync(CloudSpendLimitInput);
const decodeExport = Schema.decodeUnknownSync(CloudUsageExport);

describe("cloud accounting contracts", () => {
  it("keeps the local operator as the default spend principal", () => {
    expect(DEFAULT_CLOUD_SPEND_PRINCIPAL).toEqual({ kind: "user", id: "local-operator" });
  });

  it("accepts a spend cap removal and an export that never carries prompts", () => {
    expect(
      decodeLimit({
        principal: { kind: "service-account", id: "ci-bot" },
        period: "monthly",
        capUsd: null,
        occurredAt: "2026-09-19T00:00:00.000Z",
      }).capUsd,
    ).toBeNull();

    const report = decodeExport({
      generatedAt: "2026-09-19T12:00:00.000Z",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      redactions: { prompts: true, secrets: true },
      lines: [
        {
          dimension: "model-tokens",
          quantity: 0,
          unit: "tokens",
          unknownReason: "The selected provider does not report attributable usage.",
        },
      ],
      spendLimits: [],
      invoices: [],
    });
    expect(report.redactions.prompts).toBe(true);
    expect(report.redactions.secrets).toBe(true);
  });

  it("stores audit summaries without secret-bearing fields", () => {
    const event = decodeAudit({
      id: "audit-1",
      occurredAt: "2026-09-19T12:00:00.000Z",
      actor: { kind: "user", id: "local-operator" },
      action: "secret-policy",
      resourceType: "environment",
      resourceId: "environment:primary",
      summary: "Updated egress policy for environment:primary.",
    });
    expect(event.action).toBe("secret-policy");
    expect("prompt" in event).toBe(false);
  });
});
