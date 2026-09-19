import { describe, expect, it } from "vite-plus/test";

import {
  nextCloudAgentScheduleAt,
  parseCloudAgentCron,
  validateCloudAgentScheduleTiming,
} from "./cloudAgentSchedulePolicy.ts";

function parsed(expression: string) {
  const result = parseCloudAgentCron(expression);
  if (!result.ok) throw new Error(result.message);
  return result.cron;
}

describe("cloud agent schedule policy", () => {
  it("evaluates numeric cron ranges and steps in the requested timezone", () => {
    expect(
      nextCloudAgentScheduleAt({
        cron: parsed("*/15 9-10 * * 1-5"),
        timezone: "Australia/Sydney",
        afterMs: Date.parse("2026-09-20T23:59:00.000Z"),
      }),
    ).toBe("2026-09-21T00:00:00.000Z");
  });

  it("treats a stepped wildcard as unrestricted for day matching", () => {
    expect(
      nextCloudAgentScheduleAt({
        cron: parsed("0 0 */1 * 1"),
        timezone: "UTC",
        afterMs: Date.parse("2026-09-22T00:00:00.000Z"),
      }),
    ).toBe("2026-09-28T00:00:00.000Z");
  });

  it("reports a valid cron expression that cannot produce a date", () => {
    expect(
      nextCloudAgentScheduleAt({
        cron: parsed("0 0 31 2 *"),
        timezone: "UTC",
        afterMs: Date.parse("2026-01-01T00:00:00.000Z"),
      }),
    ).toBeUndefined();
  });

  it("skips a nonexistent daylight-saving wall time", () => {
    expect(
      nextCloudAgentScheduleAt({
        cron: parsed("30 2 * * *"),
        timezone: "America/New_York",
        afterMs: Date.parse("2026-03-08T05:00:00.000Z"),
      }),
    ).toBe("2026-03-09T06:30:00.000Z");
  });

  it("runs a repeated daylight-saving wall time once at its earlier occurrence", () => {
    expect(
      nextCloudAgentScheduleAt({
        cron: parsed("30 1 * * *"),
        timezone: "America/New_York",
        afterMs: Date.parse("2026-11-01T04:00:00.000Z"),
      }),
    ).toBe("2026-11-01T05:30:00.000Z");
    expect(
      nextCloudAgentScheduleAt({
        cron: parsed("30 1 * * *"),
        timezone: "America/New_York",
        afterMs: Date.parse("2026-11-01T05:30:00.000Z"),
      }),
    ).toBe("2026-11-02T06:30:00.000Z");
  });

  it("rejects malformed cron and unknown timezones", () => {
    expect(validateCloudAgentScheduleTiming({ cron: "0 9 * *", timezone: "UTC" })).toEqual({
      message: "Cron must have five fields: minute hour day month weekday.",
    });
    expect(
      validateCloudAgentScheduleTiming({ cron: "0 9 * * *", timezone: "Mars/Olympus" }),
    ).toEqual({ message: "Timezone 'Mars/Olympus' is not a valid IANA timezone." });
  });
});
