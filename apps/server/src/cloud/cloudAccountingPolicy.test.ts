import { describe, expect, it } from "@effect/vitest";

import {
  admitSpendLimit,
  auditEvent,
  cloudUsageMeters,
  estimatedUsageUsd,
  exportUsageReport,
  principalFromApiKey,
  reconcileInvoices,
  spendLimitStatus,
  spendPeriodWindow,
} from "./cloudAccountingPolicy.ts";

const NOW = "2026-09-19T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

describe("cloud accounting policy", () => {
  it("maps API keys onto user and service-account principals", () => {
    expect(principalFromApiKey({ kind: "user", principalId: "alice" })).toEqual({
      kind: "user",
      id: "alice",
    });
    expect(principalFromApiKey({ kind: "service_account", principalId: "ci" })).toEqual({
      kind: "service-account",
      id: "ci",
    });
  });

  it("uses UTC day and month windows", () => {
    expect(spendPeriodWindow("daily", NOW)).toEqual({
      start: "2026-09-19T00:00:00.000Z",
      end: "2026-09-20T00:00:00.000Z",
    });
    expect(spendPeriodWindow("monthly", NOW)).toEqual({
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
    });
  });

  it("separates guest time, idle hypervisor occupancy, previews, and unknowns", () => {
    const meters = cloudUsageMeters({
      events: [
        {
          type: "allocation.requested",
          sequence: 1,
          commandId: "c1",
          allocationId: "alloc-1",
          attempt: 1,
          occurredAt: "2026-09-19T10:00:00.000Z",
          target: { repository: "acme/app", baseCommit: "main", branch: "cloud/1" },
          profile: { id: "linux-web", os: "linux", arch: "x64", instanceType: "t3.medium" },
          deadlines: {
            launchBy: "2026-09-19T10:05:00.000Z",
            bootBy: "2026-09-19T10:10:00.000Z",
            registerBy: "2026-09-19T10:15:00.000Z",
            expiresAt: "2026-09-19T12:00:00.000Z",
            cleanupBy: "2026-09-19T12:05:00.000Z",
          },
        },
        {
          type: "allocation.instance-launched",
          sequence: 2,
          commandId: "c2",
          allocationId: "alloc-1",
          attempt: 1,
          occurredAt: "2026-09-19T10:00:00.000Z",
          instanceId: "i-1",
        },
        {
          type: "allocation.preview-published",
          sequence: 3,
          commandId: "c3",
          allocationId: "alloc-1",
          attempt: 1,
          occurredAt: "2026-09-19T10:10:00.000Z",
          url: "https://preview.example",
        },
        {
          type: "allocation.went-idle",
          sequence: 4,
          commandId: "c4",
          allocationId: "alloc-1",
          attempt: 1,
          occurredAt: "2026-09-19T11:00:00.000Z",
          releaseAt: "2026-09-19T12:00:00.000Z",
          flush: {
            userdata: { status: "flushed", detail: "ok" },
            workspace: { status: "flushed", detail: "ok" },
            providerHome: { status: "unavailable", reason: "tmpfs" },
            flushedAt: "2026-09-19T11:00:00.000Z",
          },
        },
        {
          type: "allocation.hibernated",
          sequence: 5,
          commandId: "c5",
          allocationId: "alloc-1",
          attempt: 1,
          occurredAt: "2026-09-19T11:30:00.000Z",
          snapshot: {
            instanceId: "i-1",
            attempt: 1,
            capturedAt: "2026-09-19T11:30:00.000Z",
            flush: {
              userdata: { status: "flushed", detail: "ok" },
              workspace: { status: "flushed", detail: "ok" },
              providerHome: { status: "unavailable", reason: "tmpfs" },
              flushedAt: "2026-09-19T11:00:00.000Z",
            },
          },
        },
      ],
      nowMs: NOW_MS,
      hourlyUsd: 0.0496,
      rateAssumption: "us-west-1 t3.medium at $0.0496/hour; excludes taxes and discounts.",
      hasSnapshot: true,
    });
    const byDimension = Object.fromEntries(meters.map((meter) => [meter.dimension, meter]));
    expect(byDimension["active-guest-time"]?.quantity).toBe(3_600);
    expect(byDimension["hypervisor-allocation"]?.quantity).toBe(5_400);
    expect(byDimension["active-guest-time"]?.cost).toMatchObject({
      status: "estimated",
      usd: 0.0496,
    });
    expect(byDimension["hypervisor-allocation"]?.cost).toMatchObject({ status: "estimated" });
    expect(byDimension["previews"]?.quantity).toBe(4_800);
    expect(byDimension["snapshots"]?.quantity).toBe(1);
    expect(byDimension["model-tokens"]?.cost.status).toBe("unknown");
    expect(byDimension["daytona-quota"]).toMatchObject({
      quantity: 0,
      unit: "quota-units",
      cost: { status: "unknown" },
    });
    expect(byDimension["external-provider"]?.cost.status).toBe("unknown");
  });

  it("gates follow-up when a matching principal or team cap is exhausted", () => {
    const team = spendLimitStatus({
      principal: { kind: "team", id: "acme" },
      period: "monthly",
      capUsd: 10,
      usedUsd: 10,
      nowIso: NOW,
    });
    expect(
      admitSpendLimit({
        principal: { kind: "user", id: "alice" },
        limits: [team],
      }).status,
    ).toBe("rejected");
    expect(
      admitSpendLimit({
        principal: { kind: "user", id: "alice" },
        limits: [
          spendLimitStatus({
            principal: { kind: "user", id: "bob" },
            period: "daily",
            capUsd: 1,
            usedUsd: 1,
            nowIso: NOW,
          }),
        ],
      }).status,
    ).toBe("ok");
  });

  it("reconciles invoices against estimates and exports without prompts", () => {
    const usage = {
      allocationId: "alloc-1",
      attempt: 1,
      calculatedAt: NOW,
      elapsedWorkerSeconds: 3_600,
      deadlines: {
        launchBy: NOW,
        bootBy: NOW,
        registerBy: NOW,
        expiresAt: NOW,
        cleanupBy: NOW,
      },
      costs: {
        controllerHost: { status: "not-attributed" as const, reason: "local" },
        workerCompute: {
          status: "estimated" as const,
          usd: 0.0496,
          assumption: "t3.medium",
        },
        storage: { status: "unknown" as const, reason: "storage" },
        provider: { status: "unknown" as const, reason: "provider" },
        streamingTransfer: { status: "unknown" as const, reason: "transfer" },
      },
      meters: cloudUsageMeters({
        events: [
          {
            type: "allocation.instance-launched",
            sequence: 1,
            commandId: "c1",
            allocationId: "alloc-1",
            attempt: 1,
            occurredAt: "2026-09-19T11:00:00.000Z",
            instanceId: "i-1",
          },
        ],
        nowMs: NOW_MS,
        hourlyUsd: 0.0496,
        hasSnapshot: false,
      }),
    };
    expect(estimatedUsageUsd(usage)).toBe(0.0496);
    const invoices = reconcileInvoices({
      invoices: [
        {
          id: "inv-1",
          source: "aws",
          dimension: "active-guest-time",
          periodStart: "2026-09-01T00:00:00.000Z",
          periodEnd: "2026-10-01T00:00:00.000Z",
          invoicedUsd: 0.1,
          recordedAt: NOW,
        },
      ],
      usages: [usage],
    });
    expect(invoices[0]?.varianceUsd).toBe(roundish(0.1 - 0.0496));
    const report = exportUsageReport({
      generatedAt: NOW,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      usages: [usage],
      spendLimits: [],
      invoices,
    });
    expect(report.redactions).toEqual({ prompts: true, secrets: true });
    expect(JSON.stringify(report)).not.toMatch(/Fix the cloud|sk-|password/i);
    expect(report.lines.find((line) => line.dimension === "active-guest-time")?.invoicedUsd).toBe(
      0.1,
    );
  });

  it("strips prompt-like audit summaries", () => {
    expect(
      auditEvent({
        id: "a1",
        occurredAt: NOW,
        action: "run-lifecycle",
        resourceType: "run",
        resourceId: "run-1",
        summary: "User prompt: delete secrets and rotate the token",
      }).summary,
    ).toBe("run-lifecycle on run 'run-1'.");
  });
});

function roundish(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e6) / 1e6;
}
